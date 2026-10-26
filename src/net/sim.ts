// The network simulation. Small but faithful: L2 segments through switches with MAC learning,
// ARP, IP routing, DHCP, NAT, firewall rules, DNS and HTTP, link media with length limits and
// latency, device boot time and per-device event logs. Every operation returns a hop-by-hop
// trace with plain-language explanations so failures teach instead of just failing.

import { ConfigBackup, Device, DeviceConfig, DeviceKind, FIRMWARE, Iface, Lease, Link, LogEntry, MEDIA, Medium, NetworkSnapshot, Proto, createDevice, isRouterKind } from "./model";
import { inCidr, ipToStr, isValidHostAddress, parseIp, sameSubnet, isPrivate } from "./ip";

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
  arp?: { ip: string; mac: string; device: string }; // the L2 resolution done for this hop
  atMs: number; // cumulative one-way latency when this hop happened
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
  rttMs: number; // one-way latency of this trace
}

export interface PingResult {
  ok: boolean;
  target: string;
  resolved?: string;
  request: TraceResult | null;
  reply: TraceResult | null;
  summary: string;
  hint?: string;
  rttMs?: number;
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
  headers?: string[];
  reason?: string;
  hint?: string;
  serverId?: string;
  totalMs?: number;
}

export interface DhcpStep {
  label: string; // DISCOVER / OFFER / REQUEST / ACK
  text: string;
  ok: boolean;
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
  ups: "a UPS",
};

/** Seconds a device takes to come up after power-on. */
export const BOOT_SECONDS: Record<DeviceKind, number> = {
  pc: 6,
  laptop: 5,
  switch: 8,
  router: 12,
  server: 14,
  modem: 18,
  cloud: 0,
  ups: 2,
};

/** Per-packet processing delay in milliseconds. */
const PROCESSING_MS: Record<DeviceKind, number> = {
  pc: 0.08,
  laptop: 0.08,
  switch: 0.02,
  router: 0.35,
  server: 0.1,
  modem: 0.6,
  cloud: 0.2,
  ups: 0,
};

type Segment = { ifaces: Iface[]; paths: Map<string, { via: string[]; links: string[] }>; issues: string[] };

export class Network {
  devices = new Map<string, Device>();
  links = new Map<string, Link>();
  private segCache = new Map<string, Segment>();
  private topoVersion = 0;
  private segVersion = -1;
  conflicts = new Map<string, string>(); // ifaceId -> ip (duplicate address)
  dhcpFailures = new Map<string, string>(); // ifaceId -> reason
  now: () => number = () => 0; // game seconds
  clock: () => string = () => "--:--"; // in-game time label for logs

  setClock(now: () => number, clock: () => string) {
    this.now = now;
    this.clock = clock;
  }

  // ----------------------------------------------------------- lifecycle
  load(snap: NetworkSnapshot) {
    this.devices.clear();
    this.links.clear();
    for (const d of snap.devices) {
      for (const i of d.ifaces) if (!i.mac) i.mac = `02:4d:48:${d.id.length.toString(16).padStart(2, "0")}:00:${i.name.length.toString(16).padStart(2, "0")}`;
      d.bootingUntil = undefined;
      if (!d.firmware) d.firmware = FIRMWARE[d.kind].initial;
      if (d.powerSource === undefined && ["switch", "router", "server", "modem", "ups"].includes(d.kind)) d.powerSource = "pdu";
      this.devices.set(d.id, d);
      // Older saves predate saved configs: treat what they have as saved.
      if (!d.startup) d.startup = this.extractConfig(d);
    }
    for (const l of snap.links) this.links.set(l.id, { ...l, medium: l.medium ?? "copper", lengthM: l.lengthM ?? 3 });
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

  // ----------------------------------------------------------- logs
  log(deviceId: string, text: string, kind: LogEntry["kind"] = "info") {
    const d = this.devices.get(deviceId);
    if (!d || d.hidden) return;
    (d.log ??= []).push({ t: this.clock(), text, kind });
    if (d.log.length > 80) d.log.shift();
  }

  // ----------------------------------------------------------- configuration (running vs startup)
  extractConfig(d: Device): DeviceConfig {
    const ifaces: DeviceConfig["ifaces"] = {};
    for (const i of d.ifaces) {
      ifaces[i.name] = { mode: i.mode, ip: i.ip, prefix: i.prefix, gateway: i.gateway, dns: i.dns, nat: i.nat, dhcp: i.dhcp ? { ...i.dhcp } : undefined, enabled: i.enabled, speed: i.speed, duplex: i.duplex, description: i.description };
    }
    return JSON.parse(JSON.stringify({ name: d.name, ifaces, routes: d.routes, acl: d.acl, services: d.services }));
  }

  applyConfig(d: Device, cfg: DeviceConfig) {
    const c: DeviceConfig = JSON.parse(JSON.stringify(cfg));
    d.name = c.name;
    for (const i of d.ifaces) {
      const ic = c.ifaces[i.name];
      if (!ic) continue;
      if (i.locked) continue;
      Object.assign(i, { mode: ic.mode, ip: ic.ip, prefix: ic.prefix, gateway: ic.gateway, dns: ic.dns, nat: ic.nat, dhcp: ic.dhcp, enabled: ic.enabled, speed: ic.speed, duplex: ic.duplex, description: ic.description });
      i.lease = undefined;
    }
    d.routes = c.routes ?? [];
    d.acl = c.acl ?? [];
    d.services = c.services ?? {};
  }

  /** Factory defaults: what a device runs with when it has never been saved. */
  factoryConfig(d: Device): DeviceConfig {
    const fresh = createDevice(d.kind, d.id, d.name, d.buildingId);
    const cfg = this.extractConfig(fresh);
    cfg.name = d.name;
    return cfg;
  }

  isDirty(d: Device): boolean {
    if (d.kind === "cloud" || d.kind === "ups") return false;
    const run = JSON.stringify(this.extractConfig(d));
    const start = JSON.stringify(d.startup ?? this.factoryConfig(d));
    return run !== start;
  }

  saveConfig(deviceId: string) {
    const d = this.devices.get(deviceId);
    if (!d) return;
    d.startup = this.extractConfig(d);
    this.log(deviceId, "Configuration saved to startup-config.");
  }

  backup(deviceId: string, label?: string): ConfigBackup | undefined {
    const d = this.devices.get(deviceId);
    if (!d) return undefined;
    const b: ConfigBackup = { t: this.clock(), label: label || `backup ${(d.backups?.length ?? 0) + 1}`, config: this.extractConfig(d) };
    (d.backups ??= []).push(b);
    if (d.backups.length > 6) d.backups.shift();
    this.log(deviceId, `Configuration backed up: "${b.label}".`);
    return b;
  }

  restore(deviceId: string, index: number): boolean {
    const d = this.devices.get(deviceId);
    const b = d?.backups?.[index];
    if (!d || !b) return false;
    this.applyConfig(d, b.config);
    this.log(deviceId, `Configuration restored from "${b.label}" (running only; save to keep it).`, "warn");
    this.touch();
    return true;
  }

  /** Reboot: the running configuration is replaced by whatever was saved. */
  reboot(deviceId: string, bootMultiplier = 1) {
    const d = this.devices.get(deviceId);
    if (!d || !d.power) return;
    const lost = this.isDirty(d);
    this.applyConfig(d, d.startup ?? this.factoryConfig(d));
    d.bootingUntil = this.now() + BOOT_SECONDS[d.kind] * bootMultiplier;
    d.bootedAt = d.bootingUntil;
    this.log(deviceId, lost ? "Rebooting. Unsaved running configuration was discarded." : "Rebooting.", lost ? "warn" : "info");
    this.touch();
  }

  updateFirmware(deviceId: string): string | null {
    const d = this.devices.get(deviceId);
    if (!d) return "Device not found.";
    const target = FIRMWARE[d.kind].latest;
    if (d.firmware === target) return "Already on the latest firmware.";
    if (!d.power) return "Power the device on first.";
    d.firmware = target;
    this.log(deviceId, `Firmware updated to ${target}. Rebooting to apply.`);
    this.reboot(deviceId, 2);
    return null;
  }

  uptime(d: Device): string {
    if (!d.power) return "down";
    if (this.isBooting(d)) return "booting";
    const secs = Math.max(0, this.now() - (d.bootedAt ?? 0));
    if (secs < 60) return `${Math.floor(secs)} s`;
    if (secs < 3600) return `${Math.floor(secs / 60)} min`;
    return `${(secs / 3600).toFixed(1)} h`;
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

  /** Powered on and finished booting. */
  isUp(dev: Device): boolean {
    if (!dev.power) return false;
    if (dev.bootingUntil !== undefined && dev.bootingUntil > this.now()) return false;
    return true;
  }

  isBooting(dev: Device): boolean {
    return dev.power && dev.bootingUntil !== undefined && dev.bootingUntil > this.now();
  }

  // ----------------------------------------------------------- mutations
  addDevice(kind: DeviceKind, buildingId: string, name: string, id?: string): Device {
    const did = id ?? `${kind}_${Math.random().toString(36).slice(2, 7)}`;
    const d = createDevice(kind, did, name, buildingId);
    this.devices.set(did, d);
    this.log(did, `${name} installed in the rack.`);
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

  setPower(deviceId: string, on: boolean) {
    const d = this.devices.get(deviceId);
    if (!d) return;
    d.power = on;
    if (on) {
      const lost = this.isDirty(d);
      this.applyConfig(d, d.startup ?? this.factoryConfig(d));
      d.bootingUntil = this.now() + BOOT_SECONDS[d.kind];
      d.bootedAt = d.bootingUntil;
      this.log(deviceId, `Power on. Booting (${BOOT_SECONDS[d.kind]} s)…${lost ? " Unsaved running configuration was lost." : ""}`, lost ? "warn" : "info");
    } else {
      d.bootingUntil = undefined;
      this.log(deviceId, "Power off.", "warn");
      for (const i of d.ifaces) {
        const peer = this.peerIface(i.id);
        if (peer) this.log(peer.deviceId, `Link down on ${peer.name}: ${d.name} went away.`, "warn");
      }
    }
    this.touch();
  }

  /** Called by the game loop; finishes boots whose timers expired. Returns true if anything changed. */
  tickBoots(): boolean {
    let changed = false;
    for (const d of this.devices.values()) {
      if (d.bootingUntil !== undefined && d.bootingUntil <= this.now()) {
        d.bootingUntil = undefined;
        changed = true;
        this.log(d.id, "Boot complete. Interfaces up.");
        for (const i of d.ifaces) {
          if (this.linkState(i) === "up") {
            const peer = this.peerIface(i.id)!;
            this.log(peer.deviceId, `Link up on ${peer.name}: ${d.name} ${i.name} (${this.linkSpeed(this.links.get(i.linkId!)!)}).`);
          }
        }
      }
    }
    if (changed) this.touch();
    return changed;
  }

  connect(aId: string, bId: string, opts: { medium?: Medium; lengthM?: number } = {}): Link | string {
    const a = this.iface(aId);
    const b = this.iface(bId);
    if (!a || !b) return "Port not found.";
    if (a.linkId || b.linkId) return "One of those ports already has a cable in it.";
    if (a.deviceId === b.deviceId) return "You cannot connect a device to itself.";
    const link: Link = {
      id: `link_${Math.random().toString(36).slice(2, 7)}`,
      a: aId,
      b: bId,
      damaged: false,
      medium: opts.medium ?? "copper",
      lengthM: opts.lengthM ?? 3,
    };
    this.links.set(link.id, link);
    a.linkId = link.id;
    b.linkId = link.id;
    const da = this.devices.get(a.deviceId)!;
    const db = this.devices.get(b.deviceId)!;
    const issue = this.linkIssue(link);
    if (issue) {
      this.log(da.id, `${a.name}: cable to ${db.name} ${b.name} plugged in, but no link: ${issue}`, "error");
      this.log(db.id, `${b.name}: cable to ${da.name} ${a.name} plugged in, but no link: ${issue}`, "error");
    } else if (this.isUp(da) && this.isUp(db)) {
      this.log(da.id, `Link up on ${a.name}: ${db.name} ${b.name} (${this.linkSpeed(link)}, ${MEDIA[link.medium].label}, ${link.lengthM} m).`);
      this.log(db.id, `Link up on ${b.name}: ${da.name} ${a.name} (${this.linkSpeed(link)}, ${MEDIA[link.medium].label}, ${link.lengthM} m).`);
    }
    this.touch();
    return link;
  }

  disconnect(linkId: string) {
    const l = this.links.get(linkId);
    if (!l) return;
    const a = this.iface(l.a);
    const b = this.iface(l.b);
    if (a) {
      a.linkId = undefined;
      this.log(a.deviceId, `Link down on ${a.name}: cable unplugged.`, "warn");
    }
    if (b) {
      b.linkId = undefined;
      this.log(b.deviceId, `Link down on ${b.name}: cable unplugged.`, "warn");
    }
    this.links.delete(linkId);
    this.touch();
  }

  setDamaged(linkId: string, damaged: boolean) {
    const l = this.links.get(linkId);
    if (!l || l.damaged === damaged) return;
    l.damaged = damaged;
    for (const id of [l.a, l.b]) {
      const i = this.iface(id);
      if (i) this.log(i.deviceId, damaged ? `Link down on ${i.name}: no carrier (cable fault).` : `Link up on ${i.name}: cable replaced (${this.linkSpeed(l)}).`, damaged ? "error" : "info");
    }
    this.touch();
  }

  // ----------------------------------------------------------- physical layer
  linkIssue(l: Link): string | null {
    if (l.damaged) return "the cable is damaged";
    const max = MEDIA[l.medium].maxM;
    if (l.latencyMs === undefined && l.lengthM > max) return `${l.lengthM} m of ${MEDIA[l.medium].label.toLowerCase()} exceeds the ${max} m limit; the signal does not survive the run`;
    return null;
  }

  /** Speed/duplex negotiation between the two ends of a link. */
  negotiate(l: Link): { mbit: number; duplex: "full" | "half"; mismatch: boolean } {
    const a = this.iface(l.a);
    const b = this.iface(l.b);
    const max = l.medium === "fiber" ? 10000 : 1000;
    const sa = a?.speed ?? "auto";
    const sb = b?.speed ?? "auto";
    const da = a?.duplex ?? "auto";
    const db = b?.duplex ?? "auto";
    let mbit = max;
    if (sa !== "auto" || sb !== "auto") mbit = Math.min(sa === "auto" ? max : Number(sa), sb === "auto" ? max : Number(sb));
    // A forced side against an auto side: the auto side cannot negotiate and falls back to half duplex.
    const forcedA = sa !== "auto" || da !== "auto";
    const forcedB = sb !== "auto" || db !== "auto";
    let duplex: "full" | "half" = "full";
    let mismatch = false;
    if (da === "half" || db === "half") duplex = "half";
    if ((forcedA && !forcedB) || (forcedB && !forcedA)) {
      mismatch = (forcedA ? da : db) !== "half" ? true : false;
      duplex = "half";
    }
    if (da !== "auto" && db !== "auto" && da !== db) mismatch = true;
    if (sa !== "auto" && sb !== "auto" && sa !== sb) mismatch = true;
    return { mbit, duplex, mismatch };
  }

  linkSpeed(l: Link): string {
    if (l.latencyMs !== undefined) return "100 Mbit/s uplink";
    const n = this.negotiate(l);
    return `${n.mbit >= 1000 ? n.mbit / 1000 + " Gbit/s" : n.mbit + " Mbit/s"} ${n.duplex}${n.mismatch ? " (errors)" : ""}`;
  }

  linkLatencyMs(l: Link): number {
    if (l.latencyMs !== undefined) return l.latencyMs;
    const base = 0.01 + (l.lengthM / 1000) * MEDIA[l.medium].latencyPerKm;
    const n = this.negotiate(l);
    // A duplex mismatch means collisions and retransmissions: it works, badly.
    return n.mismatch ? base + 38 : n.duplex === "half" ? base + 2 : base;
  }

  adminDown(i: Iface): boolean {
    return i.enabled === false;
  }

  /** Is this interface physically connected to anything live? */
  linkState(i: Iface): "none" | "down" | "up" {
    if (!i.linkId) return "none";
    const l = this.links.get(i.linkId);
    if (!l || this.linkIssue(l)) return "down";
    const peer = this.peerIface(i.id);
    if (this.adminDown(i) || (peer && this.adminDown(peer))) return "down";
    const dev = this.devices.get(i.deviceId);
    const pdev = peer ? this.devices.get(peer.deviceId) : undefined;
    if (!dev || !pdev || !this.isUp(dev) || !this.isUp(pdev)) return "down";
    return "up";
  }

  // ----------------------------------------------------------- addressing
  effective(i: Iface): EffectiveAddr | null {
    const dev = this.devices.get(i.deviceId);
    if (!dev || !this.isUp(dev)) return null;
    if (i.enabled === false) return null;
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
      return { ip, prefix: i.lease.prefix, gateway: parseIp(i.lease.gateway) ?? undefined, dns: parseIp(i.lease.dns) ?? undefined, source: "dhcp" };
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
    if (!i.ip && !i.prefix) return null;
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
  /** Every non-switch interface reachable from `ifaceId` through cables and live switches. */
  segment(ifaceId: string, physicalOnly = false): Segment {
    if (this.segVersion !== this.topoVersion) {
      this.segCache.clear();
      this.segVersion = this.topoVersion;
    }
    const cacheKey = physicalOnly ? `${ifaceId}#phys` : ifaceId;
    const cached = this.segCache.get(cacheKey);
    if (cached) return cached;

    const result: Segment = { ifaces: [], paths: new Map(), issues: [] };
    const start = this.iface(ifaceId);
    if (!start) return result;
    const startDev = this.devices.get(start.deviceId)!;
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
      const issue = this.linkIssue(link);
      if (issue) {
        if (!physicalOnly) continue;
        result.issues.push(`the cable between ${this.devices.get(cur.iface.deviceId)?.name} ${cur.iface.name} and ${farDev.name} ${far.name} has no link (${issue})`);
      }
      if (this.adminDown(cur.iface) || this.adminDown(far)) {
        if (!physicalOnly) continue;
        const shut = this.adminDown(cur.iface) ? cur.iface : far;
        result.issues.push(`port ${shut.name} on ${this.devices.get(shut.deviceId)?.name} is shut down`);
      }
      if (!this.isUp(farDev)) {
        if (!physicalOnly) continue;
        result.issues.push(this.isBooting(farDev) ? `${farDev.name} is still booting` : `${farDev.name} is powered off`);
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

  /** What a switch has learned: for each port, the MAC addresses reachable behind it. */
  macTable(switchId: string): { port: string; entries: { mac: string; device: string; iface: string; ip?: string }[] }[] {
    const sw = this.devices.get(switchId);
    if (!sw || sw.kind !== "switch") return [];
    const out: { port: string; entries: { mac: string; device: string; iface: string; ip?: string }[] }[] = [];
    for (const p of sw.ifaces) {
      if (this.linkState(p) !== "up") continue;
      const seg = this.segment(p.id);
      out.push({
        port: p.name,
        entries: seg.ifaces.map((i) => {
          const e = this.effective(i);
          return { mac: i.mac, device: this.devices.get(i.deviceId)!.name, iface: i.name, ip: e ? ipToStr(e.ip) : undefined };
        }),
      });
    }
    return out;
  }

  /** The ARP cache a host would have after talking to its neighbours. */
  arpTable(deviceId: string): { iface: string; ip: string; mac: string; device: string }[] {
    const d = this.devices.get(deviceId);
    if (!d) return [];
    const out: { iface: string; ip: string; mac: string; device: string }[] = [];
    for (const i of d.ifaces) {
      const e = this.effective(i);
      if (!e || this.linkState(i) !== "up") continue;
      for (const n of this.segment(i.id).ifaces) {
        const ne = this.effective(n);
        if (ne && sameSubnet(ne.ip, e.ip, e.prefix)) out.push({ iface: i.name, ip: ipToStr(ne.ip), mac: n.mac, device: this.devices.get(n.deviceId)!.name });
      }
    }
    return out;
  }

  // ----------------------------------------------------------- DHCP
  refresh() {
    this.dhcpFailures.clear();
    const clients: { iface: Iface; before?: string }[] = [];
    for (const d of this.devices.values())
      for (const i of d.ifaces) {
        if (i.mode === "dhcp") {
          clients.push({ iface: i, before: i.lease?.ip });
          i.lease = undefined;
        }
      }
    clients.sort((a, b) => a.iface.id.localeCompare(b.iface.id));
    for (const { iface: c, before } of clients) {
      const r = this.allocate(c);
      if (typeof r === "string") {
        this.dhcpFailures.set(c.id, r);
        if (before) this.log(c.deviceId, `${c.name}: lease for ${before} lost (${r})`, "warn");
        continue;
      }
      c.lease = r;
      if (r.ip !== before) {
        this.log(c.deviceId, `${c.name}: DHCP lease ${r.ip}/${r.prefix} from ${this.devices.get(r.serverId)?.name}${r.gateway ? `, gateway ${r.gateway}` : ""}${r.dns ? `, DNS ${r.dns}` : ""}.`);
        this.log(r.serverId, `DHCP: leased ${r.ip} to ${this.devices.get(c.deviceId)?.name} (${c.mac}).`);
      }
    }
    this.detectConflicts();
  }

  /** Pick an address for a DHCP client, or explain why none is available. */
  private allocate(c: Iface): Lease | string {
    const dev = this.devices.get(c.deviceId)!;
    if (!this.isUp(dev)) return this.isBooting(dev) ? "Still booting." : "Powered off.";
    if (this.linkState(c) !== "up") return "No link. Plug the cable in first.";
    const seg = this.segment(c.id);
    const servers = seg.ifaces.filter((s) => s.dhcp?.enabled && this.isUp(this.devices.get(s.deviceId)!));
    if (servers.length === 0) return "No DHCP server answered on this network.";
    const srv = servers[0];
    const cfg = srv.dhcp!;
    const start = parseIp(cfg.start);
    const end = parseIp(cfg.end);
    if (start === null || end === null || end < start) return `DHCP server on ${this.devices.get(srv.deviceId)?.name} has an invalid address pool.`;
    const used = new Set<number>();
    for (const other of seg.ifaces) {
      const e = this.effective(other);
      if (e) used.add(e.ip);
    }
    const selfEff = this.effective(srv);
    if (selfEff) used.add(selfEff.ip);
    for (let ip = start; ip <= end; ip++) {
      if (!used.has(ip)) return { ip: ipToStr(ip), prefix: cfg.prefix, gateway: cfg.gateway || undefined, dns: cfg.dns || undefined, serverId: srv.deviceId };
    }
    return "The DHCP pool is full. No addresses left to hand out.";
  }

  /** The four-step DHCP conversation for one client, for the terminal. */
  dhcpTransaction(deviceId: string): DhcpStep[] {
    const d = this.devices.get(deviceId);
    const c = d?.ifaces.find((i) => i.mode === "dhcp") ?? d?.ifaces[0];
    if (!d || !c) return [{ label: "ERROR", text: "No interface.", ok: false }];
    if (c.mode !== "dhcp") return [{ label: "SKIP", text: `${c.name} is configured statically; DHCP is not used. Switch the interface to DHCP to see the exchange.`, ok: false }];
    const steps: DhcpStep[] = [];
    steps.push({ label: "DISCOVER", text: `${d.name} broadcasts from ${c.mac} to ff:ff:ff:ff:ff:ff: "Is there a DHCP server out there?"`, ok: true });
    const r = this.allocate(c);
    if (typeof r === "string") {
      steps.push({ label: "TIMEOUT", text: `No offer received. ${r}`, ok: false });
      return steps;
    }
    const srv = this.devices.get(r.serverId)!;
    steps.push({ label: "OFFER", text: `${srv.name} answers: "You can have ${r.ip}/${r.prefix}${r.gateway ? `, gateway ${r.gateway}` : ""}${r.dns ? `, DNS ${r.dns}` : ""}."`, ok: true });
    steps.push({ label: "REQUEST", text: `${d.name} broadcasts: "I'll take ${r.ip} from ${srv.name}."`, ok: true });
    steps.push({ label: "ACK", text: `${srv.name} confirms the lease. ${d.name} configures ${c.name} and can start talking.`, ok: true });
    return steps;
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
    let best: { iface: Iface; nextHop?: number; prefix: number } | null = null;
    for (const i of dev.ifaces) {
      const e = this.effective(i);
      if (!e) continue;
      if (sameSubnet(dst, e.ip, e.prefix) && (!best || e.prefix > best.prefix)) best = { iface: i, prefix: e.prefix };
    }
    if (best) return best;
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
    for (const i of dev.ifaces) {
      const e = this.effective(i);
      if (e?.gateway !== undefined && sameSubnet(e.gateway, e.ip, e.prefix)) return { iface: i, nextHop: e.gateway };
    }
    return null;
  }

  private aclCheck(dev: Device, pkt: Packet): string | null {
    for (const rule of dev.acl) {
      if (rule.proto !== "any" && rule.proto !== pkt.proto) continue;
      if (rule.src && !inCidr(pkt.src, rule.src)) continue;
      if (rule.dst && !inCidr(pkt.dst, rule.dst)) continue;
      if (rule.action === "deny") return rule.note || `rule: deny ${rule.proto} from ${rule.src || "any"} to ${rule.dst || "any"}`;
      return null;
    }
    return null;
  }

  /** Forward a packet from a device until delivered or dropped. */
  forward(fromDeviceId: string, dst: number, proto: Proto, ctx: { nat: Map<string, NatMapping>; reply: boolean; quiet?: boolean }, srcIp?: number): TraceResult {
    const hops: Hop[] = [];
    const pkt: Packet = { src: srcIp ?? 0, dst, proto };
    let cur = this.devices.get(fromDeviceId);
    const res: TraceResult = { ok: false, hops, proto, dstIp: ipToStr(dst), rttMs: 0 };
    if (!cur) return { ...res, reason: "Source device not found." };
    let ttl = 16;
    let lastIn: string | undefined;
    let tMs = 0;
    const fail = (reason: string, hint?: string) => {
      hops.push({ deviceId: cur!.id, ifaceIn: lastIn, action: "Dropped", detail: reason, ok: false, via: [], linkIds: [], atMs: tMs });
      res.reason = reason;
      res.hint = hint;
      res.srcIp = pkt.src ? ipToStr(pkt.src) : undefined;
      res.rttMs = tMs;
      return res;
    };

    while (ttl-- > 0) {
      if (!this.isUp(cur)) return fail(this.isBooting(cur) ? `${cur.name} is still booting.` : `${cur.name} is powered off.`, this.isBooting(cur) ? "Give it a few seconds." : "Turn the device on.");
      tMs += PROCESSING_MS[cur.kind];

      const local = cur.ifaces.find((i) => this.effective(i)?.ip === pkt.dst);
      if (local) {
        const nat = ctx.nat.get(cur.id);
        if (ctx.reply && nat && nat.outer === pkt.dst) {
          hops.push({ deviceId: cur.id, ifaceIn: lastIn, action: "NAT: translated back", detail: `Reply arrived for ${ipToStr(nat.outer)}; the router remembers this belongs to ${ipToStr(nat.inner)} and rewrites the destination.`, ok: true, via: [], linkIds: [], atMs: tMs });
          pkt.dst = nat.inner;
        } else {
          const dupHere = this.conflicts.has(local.id);
          hops.push({ deviceId: cur.id, ifaceIn: lastIn, action: "Delivered", detail: `${cur.name} accepted the ${proto === "any" ? "" : proto + " "}packet.${dupHere ? ` ⚠ But ${ipToStr(pkt.dst)} is a duplicate address; is ${cur.name} really who you meant?` : ""}`, ok: true, via: [], linkIds: [], atMs: tMs });
          res.ok = true;
          res.srcIp = ipToStr(pkt.src);
          res.deliveredTo = cur.id;
          res.rttMs = tMs;
          return res;
        }
      }

      if (hops.length > 0 && !isRouterKind(cur.kind) && !(ctx.reply && ctx.nat.has(cur.id))) {
        return fail(`${cur.name} received a packet addressed to ${ipToStr(pkt.dst)}, but ${cur.name} is ${DEV_INFO[cur.kind]} and not a router, so it dropped it.`, "Only routers pass packets between networks. Check the gateway address points at a router.");
      }

      if (hops.length > 0 && isRouterKind(cur.kind)) {
        const blocked = this.aclCheck(cur, pkt);
        if (blocked) {
          if (!ctx.quiet) this.log(cur.id, `FIREWALL deny ${pkt.proto} ${ipToStr(pkt.src)} → ${ipToStr(pkt.dst)} (${blocked})`, "warn");
          return fail(`${cur.name} blocked this packet (${blocked}).`, "Look at the firewall rules on the router.");
        }
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

      let natNote: string | undefined;
      if (out.nat && isRouterKind(cur.kind) && !ctx.reply && isPrivate(pkt.src)) {
        ctx.nat.set(cur.id, { inner: pkt.src, outer: outEff.ip });
        natNote = `NAT: source ${ipToStr(pkt.src)} rewritten to ${ipToStr(outEff.ip)}`;
        pkt.src = outEff.ip;
      }

      const ls = this.linkState(out);
      if (ls === "none") return fail(`Nothing is plugged into ${out.name} on ${cur.name}.`, "Run a cable from that port to a switch or the next device.");
      if (ls === "down") {
        const l = this.links.get(out.linkId!)!;
        const issue = this.linkIssue(l);
        const peerIf = this.peerIface(out.id)!;
        const peerDev = this.devices.get(peerIf.deviceId)!;
        if (issue) return fail(`No link on ${cur.name} ${out.name}: ${issue}.`, l.damaged ? "Replace the damaged cable." : "Use fiber for long runs, or put a switch in between to split the distance.");
        if (this.adminDown(out)) return fail(`${cur.name} ${out.name} is administratively down.`, "Enable the port (no shutdown).");
        if (this.adminDown(peerIf)) return fail(`${peerDev.name} ${peerIf.name} at the far end is administratively down.`, "Enable that port on the other device.");
        return fail(`The link on ${cur.name} ${out.name} is down: ${peerDev.name} is ${this.isBooting(peerDev) ? "still booting" : "powered off"}.`, this.isBooting(peerDev) ? "Wait a few seconds." : "Power on the device at the other end.");
      }

      const nextIp = route.nextHop ?? pkt.dst;
      const seg = this.segment(out.id);
      const claimants = seg.ifaces.filter((i) => this.effective(i)?.ip === nextIp);
      let dupNote: string | undefined;
      let target = claimants[0];
      if (claimants.length > 1) {
        const imposter = claimants.find((c) => !isRouterKind(this.devices.get(c.deviceId)!.kind)) ?? claimants[claimants.length - 1];
        target = imposter;
        dupNote = `⚠ ${claimants.length} devices claim ${ipToStr(nextIp)} (${claimants.map((c) => this.devices.get(c.deviceId)?.name).join(", ")}). ${this.devices.get(imposter.deviceId)?.name} answered the ARP request first, so the frame went there.`;
      }
      if (!target) {
        const elsewhere = this.findByIp(nextIp);
        const dup = seg.ifaces.filter((i) => this.conflicts.has(i.id));
        const phys = this.segment(out.id, true);
        const physicallyThere = phys.ifaces.find((i) => this.effective(i)?.ip === nextIp);
        let detail: string;
        let hint: string;
        if (physicallyThere && phys.issues.length) {
          detail = `ARP for ${ipToStr(nextIp)} got no reply: the path is physically broken. ${phys.issues.map((x) => x[0].toUpperCase() + x.slice(1)).join("; ")}.`;
          hint = phys.issues.some((x) => x.includes("damaged")) ? "Find the red port and replace the cable." : phys.issues.some((x) => x.includes("exceeds")) ? "That run is too long for copper. Use fiber or add a switch halfway." : phys.issues.some((x) => x.includes("shut down")) ? "Enable the port again (no shutdown)." : "Power the device back on, or wait for it to boot.";
          return fail(detail, hint);
        }
        if (route.nextHop !== undefined) {
          detail = `${cur.name} sent an ARP request for gateway ${ipToStr(nextIp)}, but no device with that address is on the network attached to ${out.name}.`;
          hint = elsewhere.length
            ? `${this.devices.get(elsewhere[0].deviceId)?.name} does have ${ipToStr(nextIp)}, but it is not reachable through this cable. Check the cabling or the gateway address.`
            : "Does the router really have that address on this side? Compare the gateway with the router's LAN interface.";
        } else {
          detail = `${ipToStr(nextIp)} should be on the same local network as ${cur.name}, but no live device answered the ARP request.`;
          hint = elsewhere.length
            ? `${this.devices.get(elsewhere[0].deviceId)?.name} has that address but sits on a different network segment. A router is needed between them, or move it onto this switch.`
            : "Is the destination powered on, cabled in and configured with that address?";
        }
        if (dup.length) hint += " Also: there is a duplicate IP address on this network.";
        return fail(detail, hint);
      }
      const path = seg.paths.get(target.id)!;
      // latency across the links and switches on the way
      for (const lid of path.links) tMs += this.linkLatencyMs(this.links.get(lid)!);
      tMs += path.via.length * PROCESSING_MS.switch;
      hops.push({
        deviceId: cur.id,
        ifaceIn: lastIn,
        ifaceOut: out.id,
        action: route.nextHop !== undefined ? `Forwarded to gateway ${ipToStr(nextIp)}` : hops.length === 0 ? "Sent directly (same network)" : "Delivered on local network",
        detail: natNote ?? (route.nextHop !== undefined ? `${ipToStr(pkt.dst)} is outside ${cur.name}'s network, so it goes to the ${isRouterKind(cur.kind) ? "next hop" : "default gateway"}.` : `${ipToStr(pkt.dst)} is in the same network as ${out.name} (${ipToStr(outEff.ip)}/${outEff.prefix}).`),
        ok: true,
        via: path.via,
        linkIds: path.links,
        arp: { ip: ipToStr(nextIp), mac: target.mac, device: this.devices.get(target.deviceId)!.name },
        atMs: tMs,
      });
      if (dupNote) hops[hops.length - 1].detail = dupNote;
      lastIn = target.id;
      cur = this.devices.get(target.deviceId)!;
    }
    return fail("The packet looped between routers until its time-to-live ran out.", "Two routers probably point at each other as the next hop.");
  }

  // ----------------------------------------------------------- high level ops
  ping(fromDeviceId: string, target: string, quiet = true): PingResult {
    const from = this.devices.get(fromDeviceId);
    if (!from) return { ok: false, target, request: null, reply: null, summary: "Device not found." };
    let dst = parseIp(target);
    let resolved: string | undefined;
    if (dst === null) {
      const r = this.resolve(fromDeviceId, target, quiet);
      if (!r.ok) return { ok: false, target, request: r.trace ?? null, reply: null, summary: `ping: cannot resolve ${target}: ${r.reason}`, hint: r.hint };
      dst = parseIp(r.ip!)!;
      resolved = r.ip;
    }
    const nat = new Map<string, NatMapping>();
    const req = this.forward(fromDeviceId, dst, "icmp", { nat, reply: false, quiet });
    if (!req.ok) return { ok: false, target, resolved, request: req, reply: null, summary: `Request failed: ${req.reason}`, hint: req.hint };
    const dstDev = req.deliveredTo!;
    const replyTo = parseIp(req.srcIp!)!;
    const rep = this.forward(dstDev, replyTo, "icmp", { nat, reply: true, quiet });
    if (!rep.ok) return { ok: false, target, resolved, request: req, reply: rep, summary: `Request arrived, but the reply failed: ${rep.reason}`, hint: rep.hint ?? "Routing must work in both directions." };
    const hopsOut = req.hops.filter((h) => h.ok).length - 1;
    const rtt = req.rttMs + rep.rttMs;
    return { ok: true, target, resolved, request: req, reply: rep, rttMs: rtt, summary: `Reply from ${ipToStr(dst)}: time=${rtt.toFixed(2)} ms, ${hopsOut} hop${hopsOut === 1 ? "" : "s"}` };
  }

  resolve(fromDeviceId: string, name: string, quiet = true): ResolveResult {
    const lit = parseIp(name);
    if (lit !== null) return { ok: true, ip: name };
    const from = this.devices.get(fromDeviceId);
    if (!from) return { ok: false, reason: "device not found" };
    const addr = this.primaryAddr(from);
    if (!addr) return { ok: false, reason: `${from.name} has no IP address`, hint: "Configure an address before trying to use names." };
    if (addr.dns === undefined) return { ok: false, reason: `${from.name} has no DNS server configured`, hint: "Set a DNS server address (static) or let DHCP hand one out." };
    const nat = new Map<string, NatMapping>();
    const trace = this.forward(fromDeviceId, addr.dns, "dns", { nat, reply: false, quiet });
    if (!trace.ok) return { ok: false, reason: `cannot reach DNS server ${ipToStr(addr.dns)}: ${trace.reason}`, hint: trace.hint, trace };
    const server = this.devices.get(trace.deliveredTo!)!;
    const svc = server.services.dns;
    if (!svc?.enabled) return { ok: false, reason: `${server.name} (${ipToStr(addr.dns)}) is not running a DNS service (port 53 closed)`, hint: "Point the client at a real DNS server, or enable DNS on that server.", trace, serverId: server.id };
    const lookup = this.lookupName(server, name, 0, quiet);
    if (!quiet) this.log(server.id, lookup.ok ? `DNS: ${name} → ${lookup.ip} for ${from.name}${lookup.viaForwarder ? " (via forwarder)" : ""}` : `DNS: NXDOMAIN ${name} for ${from.name}`, lookup.ok ? "info" : "warn");
    if (!lookup.ok) return { ...lookup, trace, serverId: server.id };
    return { ok: true, ip: lookup.ip, trace, serverId: server.id, viaForwarder: lookup.viaForwarder };
  }

  private lookupName(server: Device, name: string, depth: number, quiet: boolean): ResolveResult {
    const svc = server.services.dns!;
    const n = name.toLowerCase().replace(/\.$/, "");
    const rec = svc.records.find((r) => r.name.toLowerCase() === n);
    if (rec) {
      if (parseIp(rec.ip) === null) return { ok: false, reason: `record for ${n} on ${server.name} has an invalid address` };
      return { ok: true, ip: rec.ip };
    }
    const fwd = parseIp(svc.forwarder);
    if (fwd !== null && depth < 3) {
      const t = this.forward(server.id, fwd, "dns", { nat: new Map(), reply: false, quiet });
      if (!t.ok) return { ok: false, reason: `${server.name} has no record for ${n} and could not reach its forwarder ${svc.forwarder}: ${t.reason}`, hint: t.hint };
      const up = this.devices.get(t.deliveredTo!)!;
      if (!up.services.dns?.enabled) return { ok: false, reason: `forwarder ${svc.forwarder} is not a DNS server` };
      const r = this.lookupName(up, name, depth + 1, quiet);
      return r.ok ? { ...r, viaForwarder: true } : r;
    }
    return { ok: false, reason: `${server.name} has no DNS record for "${n}"`, hint: fwd === null ? "Add a record for that name, or set a forwarder so unknown names are looked up upstream." : undefined };
  }

  fetch(fromDeviceId: string, url: string, quiet = true): FetchResult {
    const m = /^(?:https?:\/\/)?([^/:\s]+)(?::\d+)?(\/.*)?$/.exec(url.trim());
    if (!m) return { ok: false, url, reason: "That does not look like a URL." };
    const host = m[1];
    const pathPart = m[2] || "/";
    const from = this.devices.get(fromDeviceId);
    const resolve = this.resolve(fromDeviceId, host, quiet);
    if (!resolve.ok) return { ok: false, url, resolve, reason: `Could not resolve ${host}: ${resolve.reason}`, hint: resolve.hint };
    const dst = parseIp(resolve.ip!)!;
    const nat = new Map<string, NatMapping>();
    const request = this.forward(fromDeviceId, dst, "http", { nat, reply: false, quiet });
    if (!request.ok) return { ok: false, url, resolve, request, reason: `Could not connect to ${host} (${resolve.ip}): ${request.reason}`, hint: request.hint };
    const server = this.devices.get(request.deliveredTo!)!;
    const http = server.services.http;
    if (!http?.enabled) {
      if (!quiet) this.log(server.id, `TCP: connection to port 80 from ${request.srcIp} refused (no service listening).`, "warn");
      return { ok: false, url, resolve, request, serverId: server.id, reason: `${server.name} answered at ${resolve.ip} but nothing is listening on port 80 (connection refused).`, hint: "Enable the web service on that server." };
    }
    const hostOk = parseIp(host) !== null || http.hostnames.map((h) => h.toLowerCase()).includes(host.toLowerCase());
    if (!hostOk) {
      if (!quiet) this.log(server.id, `HTTP: ${request.srcIp} GET ${pathPart} Host: ${host} → 404 (unknown host)`, "warn");
      return { ok: false, url, resolve, request, serverId: server.id, reason: `${server.name} is a web server, but it does not serve the site "${host}" (404 unknown host).`, hint: `Add "${host}" to the hostnames the web service answers for.` };
    }
    const reply = this.forward(server.id, parseIp(request.srcIp!)!, "http", { nat, reply: true, quiet });
    if (!reply.ok) return { ok: false, url, resolve, request, reply, serverId: server.id, reason: `The server received the request but its reply never came back: ${reply.reason}`, hint: reply.hint };
    if (!quiet) this.log(server.id, `HTTP: ${request.srcIp} "GET ${pathPart}" Host: ${host} → 200 OK (${from?.name ?? "client"})`);
    const title = http.title || host;
    const body = `<title>${title}</title>`;
    // A TCP handshake costs a round trip before the request, then request + response.
    const totalMs = (request.rttMs + reply.rttMs) * 2 + (resolve.trace ? resolve.trace.rttMs * 2 : 0);
    return {
      ok: true,
      url,
      resolve,
      request,
      reply,
      serverId: server.id,
      title,
      headers: ["HTTP/1.1 200 OK", `Server: ${server.kind === "cloud" ? "nginx/1.24" : "hollow-httpd/1.2"}`, "Content-Type: text/html; charset=utf-8", `Content-Length: ${body.length}`, `Date: ${this.clock()}`],
      totalMs,
    };
  }

  /** Quick reachability used by needs/traffic: ping both ways. */
  canReach(fromDeviceId: string, target: string): boolean {
    return this.ping(fromDeviceId, target).ok;
  }

  // ----------------------------------------------------------- description helpers
  describeIface(i: Iface): string {
    const e = this.effective(i);
    if (i.enabled === false) return "administratively down";
    if (i.mode === "none") return "L2 port";
    const dev = this.devices.get(i.deviceId);
    if (dev && this.isBooting(dev)) return "booting…";
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
