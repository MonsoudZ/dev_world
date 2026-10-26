// The network simulation. Small but faithful: L2 segments through switches, IP routing,
// DHCP, NAT, firewall rules, DNS and HTTP. Every operation returns a hop-by-hop trace with
// plain-language explanations so failures teach instead of just failing.

import {
  Device,
  DeviceKind,
  Iface,
  Link,
  NetworkSnapshot,
  Proto,
  createDevice,
  isRouterKind,
} from "./model";
import {
  inCidr,
  ipToStr,
  isValidHostAddress,
  parseIp,
  sameSubnet,
  isPrivate,
} from "./ip";

export interface EffectiveAddr {
  ip: number;
  prefix: number;
  gateway?: number;
  dns?: number;
  source: "static" | "dhcp";
}

export interface Hop {
  deviceId: string;
  ifaceIn?: string;
  ifaceOut?: string;
  action: string;
  detail?: string;
  ok: boolean;
  via: string[]; // switch device ids traversed on the way to the next hop
  linkIds: string[]; // links traversed to reach next device (for animation)
}

export interface TraceResult {
  ok: boolean;
  hops: Hop[];
  reason?: string;
  hint?: string;
  srcIp?: string;
  dstIp?: string;
  proto: Proto;
  deliveredTo?: string;
}

export interface PingResult {
  ok: boolean;
  target: string;
  resolved?: string;
  request: TraceResult | null;
  reply: TraceResult | null;
  summary: string;
  hint?: string;
}

export interface ResolveResult {
  ok: boolean;
  ip?: string;
  reason?: string;
  hint?: string;
  trace?: TraceResult;
  serverId?: string;
  viaForwarder?: boolean;
}

export interface FetchResult {
  ok: boolean;
  url: string;
  resolve?: ResolveResult;
  request?: TraceResult;
  reply?: TraceResult;
  title?: string;
  reason?: string;
  hint?: string;
  serverId?: string;
}

interface Packet {
  src: number;
  dst: number;
  proto: Proto;
}

interface NatMapping {
  inner: number;
  outer: number;
}

const DEV_INFO: Record<DeviceKind, string> = {
  pc: "a PC",
  laptop: "a laptop",
  switch: "a switch",
  router: "a router",
  server: "a server",
  modem: "the ISP modem",
  cloud: "the internet",
};

export class Network {
  devices = new Map<string, Device>();
  links = new Map<string, Link>();
  private segCache = new Map<string, { ifaces: Iface[]; paths: Map<string, { via: string[]; links: string[] }>; issues: string[] }>();
  private topoVersion = 0;
  private segVersion = -1;
  conflicts = new Map<string, string>(); // ifaceId -> ip (duplicate address)
  dhcpFailures = new Map<string, string>(); // ifaceId -> reason

  // ----------------------------------------------------------- lifecycle
  load(snap: NetworkSnapshot) {
    this.devices.clear();
    this.links.clear();
    for (const d of snap.devices) this.devices.set(d.id, d);
    for (const l of snap.links) this.links.set(l.id, l);
    this.touch();
  }

  snapshot(): NetworkSnapshot {
    return {
      devices: [...this.devices.values()].map((d) => JSON.parse(JSON.stringify(d))),
      links: [...this.links.values()].map((l) => ({ ...l })),
    };
  }

  touch() {
    this.topoVersion++;
    this.refresh();
  }

  // ----------------------------------------------------------- lookups
  device(id: string): Device | undefined {
    return this.devices.get(id);
  }

  iface(id: string): Iface | undefined {
    const devId = id.split(":")[0];
    return this.devices.get(devId)?.ifaces.find((i) => i.id === id);
  }

  ifaceDevice(ifaceId: string): Device | undefined {
    return this.devices.get(ifaceId.split(":")[0]);
  }

  devicesIn(buildingId: string): Device[] {
    return [...this.devices.values()].filter((d) => d.buildingId === buildingId && !d.hidden);
  }

  linkOf(ifaceId: string): Link | undefined {
    const i = this.iface(ifaceId);
    return i?.linkId ? this.links.get(i.linkId) : undefined;
  }

  peerIface(ifaceId: string): Iface | undefined {
    const l = this.linkOf(ifaceId);
    if (!l) return undefined;
    return this.iface(l.a === ifaceId ? l.b : l.a);
  }

  findByIp(ip: number): Iface[] {
    const out: Iface[] = [];
    for (const d of this.devices.values())
      for (const i of d.ifaces) {
        const e = this.effective(i);
        if (e && e.ip === ip) out.push(i);
      }
    return out;
  }

  findDeviceByName(name: string): Device | undefined {
    const n = name.toLowerCase();
    return [...this.devices.values()].find((d) => d.name.toLowerCase() === n);
  }

  // ----------------------------------------------------------- mutations
  addDevice(kind: DeviceKind, buildingId: string, name: string, id?: string): Device {
    const did = id ?? `${kind}_${Math.random().toString(36).slice(2, 7)}`;
    const d = createDevice(kind, did, name, buildingId);
    this.devices.set(did, d);
    this.touch();
    return d;
  }

  removeDevice(id: string) {
    const d = this.devices.get(id);
    if (!d || d.fixed) return;
    for (const i of d.ifaces) if (i.linkId) this.disconnect(i.linkId);
    this.devices.delete(id);
    this.touch();
  }

  connect(aId: string, bId: string): Link | string {
    const a = this.iface(aId);
    const b = this.iface(bId);
    if (!a || !b) return "Port not found.";
    if (a.linkId || b.linkId) return "One of those ports already has a cable in it.";
    if (a.deviceId === b.deviceId) return "You cannot connect a device to itself.";
    const link: Link = { id: `link_${Math.random().toString(36).slice(2, 7)}`, a: aId, b: bId, damaged: false };
    this.links.set(link.id, link);
    a.linkId = link.id;
    b.linkId = link.id;
    this.touch();
    return link;
  }

  disconnect(linkId: string) {
    const l = this.links.get(linkId);
    if (!l) return;
    const a = this.iface(l.a);
    const b = this.iface(l.b);
    if (a) a.linkId = undefined;
    if (b) b.linkId = undefined;
    this.links.delete(linkId);
    this.touch();
  }

  // ----------------------------------------------------------- addressing
  effective(i: Iface): EffectiveAddr | null {
    const dev = this.devices.get(i.deviceId);
    if (!dev || !dev.power) return null;
    if (i.mode === "static") {
      const ip = parseIp(i.ip);
      if (ip === null || !i.prefix) return null;
      const gw = parseIp(i.gateway);
      const dns = parseIp(i.dns);
      return { ip, prefix: i.prefix, gateway: gw ?? undefined, dns: dns ?? undefined, source: "static" };
    }
    if (i.mode === "dhcp" && i.lease) {
      const ip = parseIp(i.lease.ip);
      if (ip === null) return null;
      return {
        ip,
        prefix: i.lease.prefix,
        gateway: parseIp(i.lease.gateway) ?? undefined,
        dns: parseIp(i.lease.dns) ?? undefined,
        source: "dhcp",
      };
    }
    return null;
  }

  primaryAddr(dev: Device): EffectiveAddr | null {
    for (const i of dev.ifaces) {
      const e = this.effective(i);
      if (e) return e;
    }
    return null;
  }

  validateStatic(i: Iface): string | null {
    if (i.mode !== "static") return null;
    if (!i.ip && !i.prefix) return null; // unconfigured, not invalid
    const ip = parseIp(i.ip);
    if (ip === null) return "IP address is not valid (expected four numbers 0-255 separated by dots).";
    if (!i.prefix) return "Subnet mask is missing.";
    const bad = isValidHostAddress(ip, i.prefix);
    if (bad) return bad;
    if (i.gateway) {
      const gw = parseIp(i.gateway);
      if (gw === null) return "Default gateway is not a valid address.";
      if (!sameSubnet(gw, ip, i.prefix)) return `Gateway ${i.gateway} is not inside this interface's network, so it can never be reached.`;
    }
    return null;
  }

  // ----------------------------------------------------------- L2 segments
  /** Every non-switch interface reachable from `ifaceId` through cables and powered switches. */
  segment(ifaceId: string, physicalOnly = false): { ifaces: Iface[]; paths: Map<string, { via: string[]; links: string[] }>; issues: string[] } {
    if (this.segVersion !== this.topoVersion) {
      this.segCache.clear();
      this.segVersion = this.topoVersion;
    }
    const cacheKey = physicalOnly ? `${ifaceId}#phys` : ifaceId;
    const cached = this.segCache.get(cacheKey);
    if (cached) return cached;

    const result = { ifaces: [] as Iface[], paths: new Map<string, { via: string[]; links: string[] }>(), issues: [] as string[] };
    const start = this.iface(ifaceId);
    if (!start) return result;
    const startDev = this.devices.get(start.deviceId)!;
    // BFS over (iface) nodes. From an iface we cross its link; if the far device is a switch we
    // fan out to all its other ports.
    const visitedDevices = new Set<string>([startDev.id]);
    const queue: { iface: Iface; via: string[]; links: string[] }[] = [{ iface: start, via: [], links: [] }];
    while (queue.length) {
      const cur = queue.shift()!;
      const link = cur.iface.linkId ? this.links.get(cur.iface.linkId) : undefined;
      if (!link) continue;
      const farId = link.a === cur.iface.id ? link.b : link.a;
      const far = this.iface(farId);
      if (!far) continue;
      const farDev = this.devices.get(far.deviceId);
      if (!farDev) continue;
      if (link.damaged) {
        if (!physicalOnly) continue;
        result.issues.push(`the cable between ${this.devices.get(cur.iface.deviceId)?.name} ${cur.iface.name} and ${farDev.name} ${far.name} is damaged`);
      }
      if (!farDev.power) {
        if (!physicalOnly) continue;
        result.issues.push(`${farDev.name} is powered off`);
      }
      if (visitedDevices.has(farDev.id)) continue;
      visitedDevices.add(farDev.id);
      const links = [...cur.links, link.id];
      if (farDev.kind === "switch") {
        const via = [...cur.via, farDev.id];
        for (const p of farDev.ifaces) if (p.id !== far.id && p.linkId) queue.push({ iface: p, via, links });
      } else {
        result.ifaces.push(far);
        result.paths.set(far.id, { via: cur.via, links });
      }
    }
    this.segCache.set(cacheKey, result);
    return result;
  }

  /** Is this interface physically connected to anything live? */
  linkState(i: Iface): "none" | "down" | "up" {
    if (!i.linkId) return "none";
    const l = this.links.get(i.linkId);
    if (!l || l.damaged) return "down";
    const peer = this.peerIface(i.id);
    const dev = this.devices.get(i.deviceId);
    const pdev = peer ? this.devices.get(peer.deviceId) : undefined;
    if (!dev?.power || !pdev?.power) return "down";
    return "up";
  }

  // ----------------------------------------------------------- DHCP
  refresh() {
    this.dhcpFailures.clear();
    // Clear existing leases then re-allocate deterministically.
    const clients: Iface[] = [];
    for (const d of this.devices.values())
      for (const i of d.ifaces) {
        if (i.mode === "dhcp") {
          i.lease = undefined;
          clients.push(i);
        }
      }
    clients.sort((a, b) => a.id.localeCompare(b.id));
    // Two passes so segments see static addresses before allocating.
    for (const c of clients) {
      const dev = this.devices.get(c.deviceId)!;
      if (!dev.power) continue;
      if (this.linkState(c) !== "up") {
        this.dhcpFailures.set(c.id, "No link. Plug the cable in first.");
        continue;
      }
      const seg = this.segment(c.id);
      const servers = seg.ifaces.filter((s) => s.dhcp?.enabled && this.devices.get(s.deviceId)?.power);
      if (servers.length === 0) {
        this.dhcpFailures.set(c.id, "No DHCP server answered on this network.");
        continue;
      }
      const srv = servers[0];
      const cfg = srv.dhcp!;
      const start = parseIp(cfg.start);
      const end = parseIp(cfg.end);
      if (start === null || end === null || end < start) {
        this.dhcpFailures.set(c.id, `DHCP server on ${this.devices.get(srv.deviceId)?.name} has an invalid address pool.`);
        continue;
      }
      const used = new Set<number>();
      for (const other of seg.ifaces) {
        const e = this.effective(other);
        if (e) used.add(e.ip);
      }
      const selfEff = this.effective(srv);
      if (selfEff) used.add(selfEff.ip);
      let chosen: number | null = null;
      for (let ip = start; ip <= end; ip++) {
        if (!used.has(ip)) {
          chosen = ip;
          break;
        }
      }
      if (chosen === null) {
        this.dhcpFailures.set(c.id, "The DHCP pool is full. No addresses left to hand out.");
        continue;
      }
      c.lease = {
        ip: ipToStr(chosen),
        prefix: cfg.prefix,
        gateway: cfg.gateway || undefined,
        dns: cfg.dns || undefined,
        serverId: srv.deviceId,
      };
    }
    this.detectConflicts();
  }

  private detectConflicts() {
    this.conflicts.clear();
    const seen = new Set<string>();
    for (const d of this.devices.values()) {
      for (const i of d.ifaces) {
        const e = this.effective(i);
        if (!e || seen.has(i.id)) continue;
        const seg = this.segment(i.id);
        const same = seg.ifaces.filter((o) => this.effective(o)?.ip === e.ip);
        if (same.length) {
          this.conflicts.set(i.id, ipToStr(e.ip));
          for (const s of same) this.conflicts.set(s.id, ipToStr(e.ip));
        }
        seen.add(i.id);
      }
    }
  }

  // ----------------------------------------------------------- routing
  private lookupRoute(dev: Device, dst: number): { iface: Iface; nextHop?: number } | null {
    // 1. connected networks (longest prefix)
    let best: { iface: Iface; nextHop?: number; prefix: number } | null = null;
    for (const i of dev.ifaces) {
      const e = this.effective(i);
      if (!e) continue;
      if (sameSubnet(dst, e.ip, e.prefix) && (!best || e.prefix > best.prefix)) best = { iface: i, prefix: e.prefix };
    }
    if (best) return best;
    // 2. static routes (routers)
    for (const r of dev.routes) {
      const net = parseIp(r.dest);
      const via = parseIp(r.via);
      if (net === null || via === null) continue;
      if (!sameSubnet(dst, net, r.prefix)) continue;
      const out = dev.ifaces.find((i) => {
        const e = this.effective(i);
        return e && sameSubnet(via, e.ip, e.prefix);
      });
      if (out && (!best || r.prefix > best.prefix)) best = { iface: out, nextHop: via, prefix: r.prefix };
    }
    if (best) return best;
    // 3. default gateway from any interface (static or learned via DHCP)
    for (const i of dev.ifaces) {
      const e = this.effective(i);
      if (e?.gateway !== undefined) {
        if (sameSubnet(e.gateway, e.ip, e.prefix)) return { iface: i, nextHop: e.gateway };
      }
    }
    return null;
  }

  private aclCheck(dev: Device, pkt: Packet): string | null {
    for (const rule of dev.acl) {
      if (rule.proto !== "any" && rule.proto !== pkt.proto) continue;
      if (rule.src && !inCidr(pkt.src, rule.src)) continue;
      if (rule.dst && !inCidr(pkt.dst, rule.dst)) continue;
      if (rule.action === "deny") return rule.note || `rule: deny ${rule.proto} from ${rule.src || "any"} to ${rule.dst || "any"}`;
      return null; // explicit allow
    }
    return null;
  }

  /** Forward a packet from a device until delivered or dropped. */
  forward(fromDeviceId: string, dst: number, proto: Proto, ctx: { nat: Map<string, NatMapping>; reply: boolean }, srcIp?: number): TraceResult {
    const hops: Hop[] = [];
    const pkt: Packet = { src: srcIp ?? 0, dst, proto };
    let cur = this.devices.get(fromDeviceId);
    const res: TraceResult = { ok: false, hops, proto, dstIp: ipToStr(dst) };
    if (!cur) return { ...res, reason: "Source device not found." };
    let ttl = 16;
    let lastIn: string | undefined;
    const fail = (reason: string, hint?: string, dev?: Device) => {
      hops.push({ deviceId: (dev ?? cur)!.id, ifaceIn: lastIn, action: "Dropped", detail: reason, ok: false, via: [], linkIds: [] });
      res.reason = reason;
      res.hint = hint;
      res.srcIp = pkt.src ? ipToStr(pkt.src) : undefined;
      return res;
    };

    while (ttl-- > 0) {
      if (!cur.power) return fail(`${cur.name} is powered off.`, "Turn the device on.");

      // Is the packet for us?
      const local = cur.ifaces.find((i) => this.effective(i)?.ip === pkt.dst);
      if (local) {
        const nat = ctx.nat.get(cur.id);
        if (ctx.reply && nat && nat.outer === pkt.dst) {
          hops.push({
            deviceId: cur.id,
            ifaceIn: lastIn,
            action: "NAT: translated back",
            detail: `Reply arrived for ${ipToStr(nat.outer)}; the router remembers this belongs to ${ipToStr(nat.inner)} and rewrites the destination.`,
            ok: true,
            via: [],
            linkIds: [],
          });
          pkt.dst = nat.inner;
          // continue forwarding inward
        } else {
          const dupHere = this.conflicts.has(local.id);
          hops.push({ deviceId: cur.id, ifaceIn: lastIn, action: "Delivered", detail: `${cur.name} accepted the ${proto === "any" ? "" : proto + " "}packet.${dupHere ? ` ⚠ But ${ipToStr(pkt.dst)} is a duplicate address; is ${cur.name} really who you meant?` : ""}`, ok: true, via: [], linkIds: [] });
          res.ok = true;
          res.srcIp = ipToStr(pkt.src);
          res.deliveredTo = cur.id;
          return res;
        }
      }

      // Hosts do not forward other people's packets.
      if (hops.length > 0 && !isRouterKind(cur.kind) && !(ctx.reply && ctx.nat.has(cur.id))) {
        return fail(
          `${cur.name} received a packet addressed to ${ipToStr(pkt.dst)}, but ${cur.name} is ${DEV_INFO[cur.kind]} and not a router, so it dropped it.`,
          "Only routers pass packets between networks. Check the gateway address points at a router."
        );
      }

      // Firewall on transit through routers
      if (hops.length > 0 && isRouterKind(cur.kind)) {
        const blocked = this.aclCheck(cur, pkt);
        if (blocked) return fail(`${cur.name} blocked this packet (${blocked}).`, "Look at the firewall rules on the router.");
      }

      const route = this.lookupRoute(cur, pkt.dst);
      if (!route) {
        const hasAddr = cur.ifaces.some((i) => this.effective(i));
        if (!hasAddr) return fail(`${cur.name} has no IP address at all, so it cannot send anything.`, "Give the device an address: static, or DHCP if a server is available.");
        if (isRouterKind(cur.kind))
          return fail(`${cur.name} has no route to ${ipToStr(pkt.dst)}.`, isPrivate(pkt.dst) ? "Private addresses (192.168.x.x, 10.x.x.x) are never routable on the internet. The router at the edge must translate them with NAT." : "Add a default route or a static route toward that network.");
        return fail(`${ipToStr(pkt.dst)} is not on ${cur.name}'s own network and ${cur.name} has no default gateway.`, "Set a default gateway: the router's address on this network.");
      }
      const out = route.iface;
      const outEff = this.effective(out)!;
      if (hops.length === 0 && !pkt.src) pkt.src = outEff.ip;

      // NAT on egress
      let natNote: string | undefined;
      if (out.nat && isRouterKind(cur.kind) && !ctx.reply && isPrivate(pkt.src)) {
        ctx.nat.set(cur.id, { inner: pkt.src, outer: outEff.ip });
        natNote = `NAT: source ${ipToStr(pkt.src)} rewritten to ${ipToStr(outEff.ip)}`;
        pkt.src = outEff.ip;
      }

      const ls = this.linkState(out);
      if (ls === "none") return fail(`Nothing is plugged into ${out.name} on ${cur.name}.`, "Run a cable from that port to a switch or the next device.");
      if (ls === "down") {
        const l = this.links.get(out.linkId!);
        return fail(l?.damaged ? `The cable on ${cur.name} ${out.name} is damaged. No link.` : `The link on ${cur.name} ${out.name} is down (the other side is off).`, l?.damaged ? "Replace the damaged cable." : "Power on the device at the other end.");
      }

      const nextIp = route.nextHop ?? pkt.dst;
      const seg = this.segment(out.id);
      const claimants = seg.ifaces.filter((i) => this.effective(i)?.ip === nextIp);
      // With a duplicate address the wrong device tends to answer first: the imposter wins.
      let dupNote: string | undefined;
      let target = claimants[0];
      if (claimants.length > 1) {
        const imposter = claimants.find((c) => !isRouterKind(this.devices.get(c.deviceId)!.kind)) ?? claimants[claimants.length - 1];
        target = imposter;
        dupNote = `⚠ ${claimants.length} devices claim ${ipToStr(nextIp)} (${claimants.map((c) => this.devices.get(c.deviceId)?.name).join(", ")}). ${this.devices.get(imposter.deviceId)?.name} answered first, so the frame went there.`;
      }
      if (!target) {
        const elsewhere = this.findByIp(nextIp);
        const dup = seg.ifaces.filter((i) => this.conflicts.has(i.id));
        const phys = this.segment(out.id, true);
        const physicallyThere = phys.ifaces.find((i) => this.effective(i)?.ip === nextIp);
        let detail: string;
        let hint: string;
        if (physicallyThere && phys.issues.length) {
          detail = `No reply from ${ipToStr(nextIp)}: the path is physically broken. ${phys.issues.map((x) => x[0].toUpperCase() + x.slice(1)).join("; ")}.`;
          hint = phys.issues.some((x) => x.includes("damaged")) ? "Find the red port and replace the cable." : "Power the device back on.";
          return fail(detail, hint);
        }
        if (route.nextHop !== undefined) {
          detail = `${cur.name} tried to hand the packet to gateway ${ipToStr(nextIp)}, but no device with that address is on the network attached to ${out.name}.`;
          hint = elsewhere.length
            ? `${this.devices.get(elsewhere[0].deviceId)?.name} does have ${ipToStr(nextIp)}, but it is not reachable through this cable. Check the cabling or the gateway address.`
            : "Does the router really have that address on this side? Compare the gateway with the router's LAN interface.";
        } else {
          detail = `${ipToStr(nextIp)} should be on the same local network as ${cur.name}, but no live device with that address answered (ARP got no reply).`;
          hint = elsewhere.length
            ? `${this.devices.get(elsewhere[0].deviceId)?.name} has that address but sits on a different network segment. A router is needed between them, or move it onto this switch.`
            : "Is the destination powered on, cabled in and configured with that address?";
        }
        if (dup.length) hint += " Also: there is a duplicate IP address on this network.";
        return fail(detail, hint);
      }
      const path = seg.paths.get(target.id)!;
      hops.push({
        deviceId: cur.id,
        ifaceIn: lastIn,
        ifaceOut: out.id,
        action: route.nextHop !== undefined ? `Forwarded to gateway ${ipToStr(nextIp)}` : hops.length === 0 ? "Sent directly (same network)" : "Delivered on local network",
        detail: natNote ?? (route.nextHop !== undefined ? `${ipToStr(pkt.dst)} is outside ${cur.name}'s network, so it goes to the ${isRouterKind(cur.kind) ? "next hop" : "default gateway"}.` : `${ipToStr(pkt.dst)} is in the same network as ${out.name} (${ipToStr(outEff.ip)}/${outEff.prefix}).`),
        ok: true,
        via: path.via,
        linkIds: path.links,
      });
      if (dupNote) hops[hops.length - 1].detail = dupNote;
      lastIn = target.id;
      cur = this.devices.get(target.deviceId)!;
    }
    return fail("The packet looped between routers until its time-to-live ran out.", "Two routers probably point at each other as the next hop.");
  }

  // ----------------------------------------------------------- high level ops
  ping(fromDeviceId: string, target: string): PingResult {
    const from = this.devices.get(fromDeviceId);
    if (!from) return { ok: false, target, request: null, reply: null, summary: "Device not found." };
    let dst = parseIp(target);
    let resolved: string | undefined;
    if (dst === null) {
      const r = this.resolve(fromDeviceId, target);
      if (!r.ok) return { ok: false, target, request: r.trace ?? null, reply: null, summary: `ping: cannot resolve ${target}: ${r.reason}`, hint: r.hint };
      dst = parseIp(r.ip!)!;
      resolved = r.ip;
    }
    const nat = new Map<string, NatMapping>();
    const req = this.forward(fromDeviceId, dst, "icmp", { nat, reply: false });
    if (!req.ok) return { ok: false, target, resolved, request: req, reply: null, summary: `Request failed: ${req.reason}`, hint: req.hint };
    const dstDev = req.deliveredTo!;
    const replyTo = parseIp(req.srcIp!)!;
    const rep = this.forward(dstDev, replyTo, "icmp", { nat, reply: true });
    if (!rep.ok)
      return { ok: false, target, resolved, request: req, reply: rep, summary: `Request arrived, but the reply failed: ${rep.reason}`, hint: rep.hint ?? "Routing must work in both directions." };
    const hopsOut = req.hops.filter((h) => h.ok).length - 1;
    return { ok: true, target, resolved, request: req, reply: rep, summary: `Reply from ${ipToStr(dst)}: time=${2 + hopsOut * 3}ms, ${hopsOut} hop${hopsOut === 1 ? "" : "s"}` };
  }

  resolve(fromDeviceId: string, name: string): ResolveResult {
    const lit = parseIp(name);
    if (lit !== null) return { ok: true, ip: name };
    const from = this.devices.get(fromDeviceId);
    if (!from) return { ok: false, reason: "device not found" };
    const addr = this.primaryAddr(from);
    if (!addr) return { ok: false, reason: `${from.name} has no IP address`, hint: "Configure an address before trying to use names." };
    if (addr.dns === undefined) return { ok: false, reason: `${from.name} has no DNS server configured`, hint: "Set a DNS server address (static) or let DHCP hand one out." };
    const nat = new Map<string, NatMapping>();
    const trace = this.forward(fromDeviceId, addr.dns, "dns", { nat, reply: false });
    if (!trace.ok) return { ok: false, reason: `cannot reach DNS server ${ipToStr(addr.dns)}: ${trace.reason}`, hint: trace.hint, trace };
    const server = this.devices.get(trace.deliveredTo!)!;
    const svc = server.services.dns;
    if (!svc?.enabled) return { ok: false, reason: `${server.name} (${ipToStr(addr.dns)}) is not running a DNS service`, hint: "Point the client at a real DNS server, or enable DNS on that server.", trace, serverId: server.id };
    const lookup = this.lookupName(server, name, 0);
    if (!lookup.ok) return { ...lookup, trace, serverId: server.id };
    return { ok: true, ip: lookup.ip, trace, serverId: server.id, viaForwarder: lookup.viaForwarder };
  }

  private lookupName(server: Device, name: string, depth: number): ResolveResult {
    const svc = server.services.dns!;
    const n = name.toLowerCase().replace(/\.$/, "");
    const rec = svc.records.find((r) => r.name.toLowerCase() === n);
    if (rec) {
      if (parseIp(rec.ip) === null) return { ok: false, reason: `record for ${n} on ${server.name} has an invalid address` };
      return { ok: true, ip: rec.ip };
    }
    const fwd = parseIp(svc.forwarder);
    if (fwd !== null && depth < 3) {
      const t = this.forward(server.id, fwd, "dns", { nat: new Map(), reply: false });
      if (!t.ok) return { ok: false, reason: `${server.name} has no record for ${n} and could not reach its forwarder ${svc.forwarder}: ${t.reason}`, hint: t.hint };
      const up = this.devices.get(t.deliveredTo!)!;
      if (!up.services.dns?.enabled) return { ok: false, reason: `forwarder ${svc.forwarder} is not a DNS server` };
      const r = this.lookupName(up, name, depth + 1);
      return r.ok ? { ...r, viaForwarder: true } : r;
    }
    return { ok: false, reason: `${server.name} has no DNS record for "${n}"`, hint: fwd === null ? "Add a record for that name, or set a forwarder so unknown names are looked up upstream." : undefined };
  }

  fetch(fromDeviceId: string, url: string): FetchResult {
    const m = /^(?:https?:\/\/)?([^/:\s]+)(?::\d+)?(\/.*)?$/.exec(url.trim());
    if (!m) return { ok: false, url, reason: "That does not look like a URL." };
    const host = m[1];
    const resolve = this.resolve(fromDeviceId, host);
    if (!resolve.ok) return { ok: false, url, resolve, reason: `Could not resolve ${host}: ${resolve.reason}`, hint: resolve.hint };
    const dst = parseIp(resolve.ip!)!;
    const nat = new Map<string, NatMapping>();
    const request = this.forward(fromDeviceId, dst, "http", { nat, reply: false });
    if (!request.ok) return { ok: false, url, resolve, request, reason: `Could not connect to ${host} (${resolve.ip}): ${request.reason}`, hint: request.hint };
    const server = this.devices.get(request.deliveredTo!)!;
    const http = server.services.http;
    if (!http?.enabled)
      return { ok: false, url, resolve, request, serverId: server.id, reason: `${server.name} answered at ${resolve.ip} but nothing is listening on port 80 (connection refused).`, hint: "Enable the web service on that server." };
    const hostOk = parseIp(host) !== null || http.hostnames.map((h) => h.toLowerCase()).includes(host.toLowerCase());
    if (!hostOk)
      return { ok: false, url, resolve, request, serverId: server.id, reason: `${server.name} is a web server, but it does not serve the site "${host}" (404 unknown host).`, hint: `Add "${host}" to the hostnames the web service answers for.` };
    const reply = this.forward(server.id, parseIp(request.srcIp!)!, "http", { nat, reply: true });
    if (!reply.ok) return { ok: false, url, resolve, request, reply, serverId: server.id, reason: `The server received the request but its reply never came back: ${reply.reason}`, hint: reply.hint };
    return { ok: true, url, resolve, request, reply, serverId: server.id, title: http.title || host };
  }

  /** Quick reachability used by needs/traffic: ping both ways. */
  canReach(fromDeviceId: string, target: string): boolean {
    return this.ping(fromDeviceId, target).ok;
  }

  // ----------------------------------------------------------- description helpers
  describeIface(i: Iface): string {
    const e = this.effective(i);
    if (i.mode === "none") return "L2 port";
    if (!e) {
      if (i.mode === "dhcp") return this.dhcpFailures.get(i.id) ? `DHCP: ${this.dhcpFailures.get(i.id)}` : "DHCP: waiting";
      const err = this.validateStatic(i);
      return err ? `Invalid: ${err}` : "no address";
    }
    return `${ipToStr(e.ip)}/${e.prefix}${e.gateway !== undefined ? ` gw ${ipToStr(e.gateway)}` : ""}${e.source === "dhcp" ? " (DHCP)" : ""}`;
  }
}

export function freshId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 7)}`;
}
