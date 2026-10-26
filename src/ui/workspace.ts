// Building workspace: rack, ports and cabling, interface configuration, services, terminal.

import { el } from "../core/events";
import { Game } from "../game/game";
import { CATALOG, Device, DeviceKind, Iface } from "../net/model";
import { ipToStr, parseIp } from "../net/ip";
import { TraceResult } from "../net/sim";
import { building } from "../world/map";
import { Terminal } from "./terminal";

export class Workspace {
  root: HTMLElement;
  private selectedDevice: string | null = null;
  private terminals = new Map<string, Terminal>();
  private picker: { ifaceId: string } | null = null;

  constructor(private game: Game, private host: HTMLElement) {
    this.root = el("div", { class: "ws-overlay hidden" });
    host.append(this.root);
    game.events.on("workspace", () => this.render());
    game.events.on("change", () => {
      if (!this.root.classList.contains("hidden") && !this.root.contains(document.activeElement)) this.render();
    });
  }

  private get buildingId() {
    return this.game.workspace;
  }

  refresh() {
    if (!this.root.classList.contains("hidden")) this.render();
  }

  render() {
    const g = this.game;
    const bid = this.buildingId;
    this.root.innerHTML = "";
    if (!bid) {
      this.root.classList.add("hidden");
      return;
    }
    this.root.classList.remove("hidden");
    const b = building(bid);
    const devices = g.net.devicesIn(bid);
    if (!this.selectedDevice || !devices.some((d) => d.id === this.selectedDevice)) this.selectedDevice = devices[0]?.id ?? null;
    const sel = devices.find((d) => d.id === this.selectedDevice) ?? null;

    const pendingBanner = g.pendingCable
      ? el(
          "div",
          { class: "ws-banner" },
          `Cable in hand from ${g.net.device(g.net.iface(g.pendingCable.ifaceId)!.deviceId)!.name} ${g.net.iface(g.pendingCable.ifaceId)!.name}. Pick a free port below, or `,
          el("button", { class: "btn small", onclick: () => this.cancelPending() }, "cancel")
        )
      : null;

    const panel = el(
      "div",
      { class: "ws" },
      el(
        "header",
        { class: "ws-head" },
        el("div", { class: "ws-title" }, el("span", { class: "ws-kind" }, b.kind), el("h2", {}, b.name)),
        b.npc
          ? el(
              "div",
              { class: "ws-npc" },
              el("span", { class: "avatar", style: `background:${b.npc.color}` }, b.npc.name[0]),
              el("div", {}, el("strong", {}, b.npc.name), el("div", { class: "muted small" }, b.npc.role))
            )
          : null,
        el("button", { class: "btn ghost", onclick: () => this.close() }, "Back to map  ⎋")
      ),
      pendingBanner,
      el(
        "div",
        { class: "ws-body" },
        this.renderRack(devices, sel, b.rackSlots),
        sel ? this.renderDetail(sel) : el("section", { class: "ws-detail empty" }, el("p", { class: "muted" }, "No equipment here yet. Add something from the rack.")),
        sel ? this.renderTerminal(sel) : el("section", { class: "ws-term" })
      )
    );
    this.root.append(panel);
    if (this.picker) this.root.append(this.renderPicker(this.picker.ifaceId));
    else if (g.pendingCable && g.pendingCable.fromBuilding !== bid) this.root.append(this.renderPicker(g.pendingCable.ifaceId, true));
  }

  close() {
    this.picker = null;
    this.game.openWorkspace(null);
  }

  private cancelPending() {
    this.game.pendingCable = undefined;
    this.picker = null;
    this.render();
  }

  // ------------------------------------------------------------------ rack
  private renderRack(devices: Device[], sel: Device | null, slots: number) {
    const g = this.game;
    const bid = this.buildingId!;
    const kinds: DeviceKind[] = (["pc", "laptop", "switch", "router", "server"] as DeviceKind[]).filter((k) => g.unlockedDevices.has(k));
    const addSel = el("select", { class: "sel" }, el("option", { value: "" }, "+ Add equipment…"), ...kinds.map((k) => el("option", { value: k }, `${CATALOG[k].icon} ${CATALOG[k].label}`)));
    addSel.onchange = () => {
      const k = addSel.value as DeviceKind;
      if (!k) return;
      if (devices.length >= slots) {
        g.toast("The rack here is full.", "bad");
        addSel.value = "";
        return;
      }
      const count = devices.filter((d) => d.kind === k).length + 1;
      const name = `${building(bid).name.split(" ")[0].replace("'s", "")}-${CATALOG[k].short}${count > 1 ? count : ""}`;
      const d = g.net.addDevice(k, bid, name);
      if (k === "router") {
        const lan1 = d.ifaces.find((i) => i.name === "lan1")!;
        lan1.dhcp = { enabled: false, start: "", end: "", prefix: 24, gateway: "", dns: "" };
      }
      this.selectedDevice = d.id;
      g.toast(`Added ${name} to the rack.`, "good");
      g.recompute();
      g.save();
      this.render();
    };
    return el(
      "aside",
      { class: "ws-rack" },
      el("div", { class: "rack-head" }, el("h3", {}, "Rack"), el("span", { class: "muted small" }, `${devices.length}/${slots}`)),
      ...devices.map((d) => {
        const up = d.ifaces.some((i) => g.net.linkState(i) === "up");
        const conflict = d.ifaces.some((i) => g.net.conflicts.has(i.id));
        const addr = CATALOG[d.kind].l3 ? g.net.primaryAddr(d) : null;
        return el(
          "button",
          {
            class: `rack-item ${sel?.id === d.id ? "active" : ""} ${d.power ? "" : "off"}`,
            onclick: () => {
              this.selectedDevice = d.id;
              this.render();
            },
          },
          el("span", { class: "rack-icon" }, CATALOG[d.kind].icon),
          el(
            "span",
            { class: "rack-text" },
            el("strong", {}, d.name),
            el("span", { class: "muted small" }, CATALOG[d.kind].label + (addr ? ` · ${ipToStr(addr.ip)}` : CATALOG[d.kind].l3 && d.power ? " · no address" : ""))
          ),
          el("span", { class: `led ${!d.power ? "off" : conflict ? "red" : up ? "green" : "grey"}`, title: !d.power ? "powered off" : conflict ? "address conflict" : up ? "link up" : "no link" })
        );
      }),
      addSel,
      el("p", { class: "muted small rack-help" }, "Select a device to see its ports, settings and terminal.")
    );
  }

  // ------------------------------------------------------------------ detail
  private renderDetail(d: Device) {
    const g = this.game;
    const cat = CATALOG[d.kind];
    const nameInput = el("input", { class: "inp name", value: d.name }) as HTMLInputElement;
    nameInput.onchange = () => {
      const v = nameInput.value.trim();
      if (v) {
        d.name = v;
        g.save();
        this.render();
      }
    };
    const head = el(
      "div",
      { class: "detail-head" },
      el("span", { class: "detail-icon" }, cat.icon),
      el("div", { class: "grow" }, nameInput, el("div", { class: "muted small" }, cat.description)),
      el(
        "label",
        { class: "toggle" },
        (() => {
          const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
          cb.checked = d.power;
          cb.disabled = !!d.fixed;
          cb.onchange = () => {
            d.power = cb.checked;
            g.net.touch();
            g.toast(`${d.name} powered ${d.power ? "on" : "off"}.`);
            g.recompute();
            g.save();
            this.render();
          };
          return cb;
        })(),
        el("span", {}, "Power")
      ),
      d.fixed
        ? null
        : el(
            "button",
            {
              class: "btn ghost danger",
              onclick: () => {
                if (!confirm(`Remove ${d.name} from the rack?`)) return;
                g.net.removeDevice(d.id);
                g.recompute();
                g.save();
                this.selectedDevice = null;
                this.render();
              },
            },
            "Remove"
          )
    );
    const note = d.note ? el("p", { class: "note" }, d.note) : null;
    const sections: (HTMLElement | null)[] = [head, note, this.renderPorts(d)];
    if (cat.l3) for (const i of d.ifaces) sections.push(this.renderIfaceConfig(d, i));
    if (d.kind === "router") sections.push(this.renderRoutes(d), this.renderAcl(d));
    if (d.kind === "server") sections.push(this.renderServices(d));
    return el("section", { class: "ws-detail" }, ...sections);
  }

  private renderPorts(d: Device) {
    const g = this.game;
    return el(
      "div",
      { class: "card" },
      el("h4", {}, "Ports"),
      el(
        "div",
        { class: "ports" },
        ...d.ifaces.map((i) => {
          const st = g.net.linkState(i);
          const peer = g.net.peerIface(i.id);
          const peerDev = peer ? g.net.device(peer.deviceId) : undefined;
          const link = g.net.linkOf(i.id);
          const remote = peerDev && peerDev.buildingId !== d.buildingId && !peerDev.hidden ? ` (${building(peerDev.buildingId).name})` : "";
          return el(
            "div",
            { class: `port ${st}` },
            el("span", { class: `led ${st === "up" ? "green" : st === "down" ? "red" : "grey"}` }),
            el("div", { class: "grow" }, el("strong", {}, i.name), el("div", { class: "muted small" }, peerDev ? `→ ${peerDev.name} ${peer!.name}${remote}${link?.damaged ? " · DAMAGED" : st === "down" ? " · far end is off" : ""}` : "empty")),
            !i.linkId
              ? el("button", { class: "btn small", onclick: () => this.startConnect(i) }, "Connect")
              : el(
                  "span",
                  { class: "row" },
                  link?.damaged
                    ? el(
                        "button",
                        {
                          class: "btn small good",
                          onclick: () => {
                            link.damaged = false;
                            g.net.touch();
                            g.toast("Cable replaced.", "good");
                            g.recompute();
                            g.save();
                            this.render();
                          },
                        },
                        "Replace cable"
                      )
                    : g.mode === "sandbox"
                      ? el(
                          "button",
                          {
                            class: "btn small ghost",
                            onclick: () => {
                              link!.damaged = true;
                              g.net.touch();
                              g.recompute();
                              g.save();
                              this.render();
                            },
                          },
                          "Damage"
                        )
                      : null,
                  peerDev?.hidden || i.locked
                    ? null
                    : el(
                        "button",
                        {
                          class: "btn small ghost",
                          onclick: () => {
                            g.net.disconnect(i.linkId!);
                            g.recompute();
                            g.save();
                            this.render();
                          },
                        },
                        "Unplug"
                      )
                )
          );
        })
      )
    );
  }

  private startConnect(i: Iface) {
    this.picker = { ifaceId: i.id };
    this.render();
  }

  private renderPicker(ifaceId: string, remote = false) {
    const g = this.game;
    const bid = this.buildingId!;
    const src = g.net.iface(ifaceId)!;
    const srcDev = g.net.device(src.deviceId)!;
    const candidates = g.net.devicesIn(bid).filter((d) => d.id !== srcDev.id);
    const groups = candidates
      .map((d) => ({ d, free: d.ifaces.filter((p) => !p.linkId && !(p.locked && d.kind === "modem" && p.name === "wan")) }))
      .filter((x) => x.free.length);
    const closePicker = () => {
      this.picker = null;
      if (remote) g.pendingCable = undefined;
      this.render();
    };
    return el(
      "div",
      { class: "picker-overlay", onclick: (e: Event) => e.target === e.currentTarget && closePicker() },
      el(
        "div",
        { class: "picker" },
        el("h3", {}, `Connect ${srcDev.name} ${src.name} to…`),
        groups.length === 0 ? el("p", { class: "muted" }, "No free ports in this building.") : null,
        ...groups.map((grp) =>
          el(
            "div",
            { class: "picker-group" },
            el("div", { class: "picker-dev" }, CATALOG[grp.d.kind].icon, " ", grp.d.name),
            el(
              "div",
              { class: "picker-ports" },
              ...grp.free.map((p) =>
                el(
                  "button",
                  {
                    class: "btn small",
                    onclick: () => {
                      const r = g.net.connect(ifaceId, p.id);
                      if (typeof r === "string") g.toast(r, "bad");
                      else {
                        g.toast(`Connected ${srcDev.name} ${src.name} ↔ ${grp.d.name} ${p.name}.`, "good");
                        g.flags.add(`connect:${srcDev.id}:${grp.d.id}`);
                      }
                      this.picker = null;
                      g.pendingCable = undefined;
                      g.recompute();
                      g.save();
                      this.render();
                    },
                  },
                  p.name
                )
              )
            )
          )
        ),
        remote
          ? null
          : el(
              "button",
              {
                class: "btn wide",
                onclick: () => {
                  g.pendingCable = { ifaceId, fromBuilding: bid };
                  this.picker = null;
                  g.openWorkspace(null);
                  g.toast("Click another building on the map to run the cable there.", "info");
                },
              },
              "Another building…  (run a cable along the road)"
            ),
        el("button", { class: "btn ghost", onclick: closePicker }, "Cancel")
      )
    );
  }

  private renderIfaceConfig(d: Device, i: Iface) {
    const g = this.game;
    const eff = g.net.effective(i);
    const conflict = g.net.conflicts.get(i.id);
    const err = g.net.validateStatic(i);
    const status = el(
      "div",
      { class: `iface-status ${conflict ? "bad" : eff ? "good" : ""}` },
      conflict ? `⚠ Address ${conflict} is also used by another device on this network` : eff ? `Active: ${g.net.describeIface(i)}` : i.mode === "dhcp" ? g.net.describeIface(i) : err ? `⚠ ${err}` : "No address configured"
    );
    if (i.locked) {
      return el("div", { class: "card" }, el("h4", {}, `Interface ${i.name}`, el("span", { class: "tag" }, "provider managed")), status, i.dhcp?.enabled ? el("p", { class: "muted small" }, `Hands out ${i.dhcp.start}–${i.dhcp.end} with gateway ${i.dhcp.gateway} and DNS ${i.dhcp.dns}.`) : null);
    }
    const modeSel = el("select", { class: "sel" }, el("option", { value: "static" }, "Static"), el("option", { value: "dhcp" }, "DHCP (automatic)")) as HTMLSelectElement;
    modeSel.value = i.mode === "dhcp" ? "dhcp" : "static";
    const ip = el("input", { class: "inp mono", placeholder: "192.168.1.10", value: i.ip ?? "" }) as HTMLInputElement;
    const prefix = el("select", { class: "sel mono" }, ...[8, 16, 24, 25, 26, 27, 28, 29, 30].map((p) => el("option", { value: String(p) }, `/${p} · ${ipToStr((p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0))}`))) as HTMLSelectElement;
    prefix.value = String(i.prefix ?? 24);
    const gw = el("input", { class: "inp mono", placeholder: "192.168.1.1", value: i.gateway ?? "" }) as HTMLInputElement;
    const dns = el("input", { class: "inp mono", placeholder: "198.51.100.10", value: i.dns ?? "" }) as HTMLInputElement;
    const staticFields = el(
      "div",
      { class: "grid2" },
      el("label", {}, "IP address", ip),
      el("label", {}, "Subnet mask", prefix),
      d.kind === "router" ? el("div", {}) : el("label", {}, "Default gateway", gw),
      d.kind === "router" ? el("div", {}) : el("label", {}, "DNS server", dns)
    );
    const upd = () => staticFields.classList.toggle("hidden", modeSel.value === "dhcp");
    modeSel.onchange = upd;
    upd();
    const nat = el("input", { type: "checkbox" }) as HTMLInputElement;
    nat.checked = !!i.nat;
    const natRow = d.kind === "router" && i.name === "wan" ? el("label", { class: "toggle" }, nat, el("span", {}, "Enable NAT (translate private addresses leaving this interface)")) : null;

    const apply = el(
      "button",
      {
        class: "btn primary",
        onclick: () => {
          i.mode = modeSel.value as "static" | "dhcp";
          if (i.mode === "static") {
            i.ip = ip.value.trim();
            i.prefix = Number(prefix.value);
            i.gateway = gw.value.trim() || undefined;
            i.dns = dns.value.trim() || undefined;
            i.lease = undefined;
            const e = g.net.validateStatic(i);
            if (e) g.toast(e, "bad");
          }
          if (natRow) i.nat = nat.checked;
          g.net.touch();
          g.recompute();
          g.save();
          g.toast(`${d.name} ${i.name}: ${g.net.describeIface(i)}`, g.net.effective(i) ? "good" : "info");
          this.render();
        },
      },
      "Apply"
    );
    const dhcpServer = d.kind === "router" && i.name !== "wan" ? this.renderDhcpServer(d, i) : null;
    return el("div", { class: "card" }, el("h4", {}, `Interface ${i.name}`), status, el("label", {}, "Address mode", modeSel), staticFields, natRow, apply, dhcpServer);
  }

  private renderDhcpServer(d: Device, i: Iface) {
    const g = this.game;
    const cfg = (i.dhcp ??= { enabled: false, start: "", end: "", prefix: 24, gateway: "", dns: "" });
    const en = el("input", { type: "checkbox" }) as HTMLInputElement;
    en.checked = cfg.enabled;
    const start = el("input", { class: "inp mono", placeholder: "192.168.1.100", value: cfg.start }) as HTMLInputElement;
    const end = el("input", { class: "inp mono", placeholder: "192.168.1.200", value: cfg.end }) as HTMLInputElement;
    const gw = el("input", { class: "inp mono", placeholder: "192.168.1.1", value: cfg.gateway }) as HTMLInputElement;
    const dns = el("input", { class: "inp mono", placeholder: "198.51.100.10", value: cfg.dns }) as HTMLInputElement;
    const leases = [...g.net.devices.values()].flatMap((dev) => dev.ifaces.filter((x) => x.lease?.serverId === d.id).map((x) => `${dev.name}: ${x.lease!.ip}`));
    return el(
      "div",
      { class: "sub" },
      el("h5", {}, el("label", { class: "toggle" }, en, el("span", {}, `DHCP server on ${i.name}`))),
      el("div", { class: "grid2" }, el("label", {}, "Pool start", start), el("label", {}, "Pool end", end), el("label", {}, "Gateway to hand out", gw), el("label", {}, "DNS to hand out", dns)),
      el(
        "button",
        {
          class: "btn",
          onclick: () => {
            cfg.enabled = en.checked;
            cfg.start = start.value.trim();
            cfg.end = end.value.trim();
            cfg.gateway = gw.value.trim();
            cfg.dns = dns.value.trim();
            const e = g.net.effective(i);
            cfg.prefix = e ? e.prefix : i.prefix ?? 24;
            if (cfg.enabled && (parseIp(cfg.start) === null || parseIp(cfg.end) === null)) g.toast("DHCP pool start and end must be valid addresses.", "bad");
            g.net.touch();
            g.recompute();
            g.save();
            g.toast(cfg.enabled ? `DHCP enabled on ${d.name} ${i.name}.` : `DHCP disabled on ${d.name} ${i.name}.`, "good");
            this.render();
          },
        },
        "Save DHCP settings"
      ),
      leases.length ? el("div", { class: "muted small" }, "Leases: " + leases.join(", ")) : null
    );
  }

  private renderRoutes(d: Device) {
    const g = this.game;
    const dest = el("input", { class: "inp mono", placeholder: "10.20.0.0" }) as HTMLInputElement;
    const pre = el("input", { class: "inp mono short", placeholder: "/24", value: "24" }) as HTMLInputElement;
    const via = el("input", { class: "inp mono", placeholder: "next hop 192.168.1.2" }) as HTMLInputElement;
    const connected = d.ifaces
      .map((i) => ({ i, e: g.net.effective(i) }))
      .filter((x) => x.e)
      .map((x) => `${ipToStr((x.e!.ip & ((0xffffffff << (32 - x.e!.prefix)) >>> 0)) >>> 0)}/${x.e!.prefix} connected via ${x.i.name}` + (x.e!.gateway !== undefined ? `; default via ${ipToStr(x.e!.gateway)}` : ""));
    return el(
      "div",
      { class: "card" },
      el("h4", {}, "Routing table"),
      el("ul", { class: "mono small list" }, ...connected.map((c) => el("li", {}, c)), ...d.routes.map((r) => el("li", {}, `${r.dest}/${r.prefix} via ${r.via} `, el("button", { class: "btn tiny ghost", onclick: () => { d.routes = d.routes.filter((x) => x.id !== r.id); g.net.touch(); g.recompute(); g.save(); this.render(); } }, "remove")))),
      el(
        "div",
        { class: "row" },
        dest,
        pre,
        via,
        el(
          "button",
          {
            class: "btn small",
            onclick: () => {
              if (parseIp(dest.value) === null || parseIp(via.value) === null) return g.toast("Route needs a network and a next-hop address.", "bad");
              d.routes.push({ id: Math.random().toString(36).slice(2, 7), dest: dest.value.trim(), prefix: Number(pre.value.replace("/", "")) || 24, via: via.value.trim() });
              g.net.touch();
              g.recompute();
              g.save();
              this.render();
            },
          },
          "Add static route"
        )
      )
    );
  }

  private renderAcl(d: Device) {
    const g = this.game;
    const action = el("select", { class: "sel" }, el("option", { value: "deny" }, "Deny"), el("option", { value: "allow" }, "Allow")) as HTMLSelectElement;
    const src = el("input", { class: "inp mono", placeholder: "from 192.168.1.0/24 (blank=any)" }) as HTMLInputElement;
    const dst = el("input", { class: "inp mono", placeholder: "to 10.0.0.0/24 (blank=any)" }) as HTMLInputElement;
    const proto = el("select", { class: "sel" }, ...["any", "icmp", "dns", "http"].map((p) => el("option", { value: p }, p))) as HTMLSelectElement;
    return el(
      "div",
      { class: "card" },
      el("h4", {}, "Firewall rules", el("span", { class: "muted small" }, " (first match wins; default allow)")),
      d.acl.length ? el("ul", { class: "mono small list" }, ...d.acl.map((r) => el("li", {}, `${r.action} ${r.proto} from ${r.src || "any"} to ${r.dst || "any"} `, el("button", { class: "btn tiny ghost", onclick: () => { d.acl = d.acl.filter((x) => x.id !== r.id); g.net.touch(); g.recompute(); g.save(); this.render(); } }, "remove")))) : el("p", { class: "muted small" }, "No rules. Everything is forwarded."),
      el(
        "div",
        { class: "row wrap" },
        action,
        proto,
        src,
        dst,
        el(
          "button",
          {
            class: "btn small",
            onclick: () => {
              d.acl.push({ id: Math.random().toString(36).slice(2, 7), action: action.value as "allow" | "deny", src: src.value.trim() || undefined, dst: dst.value.trim() || undefined, proto: proto.value as "any" });
              g.net.touch();
              g.recompute();
              g.save();
              this.render();
            },
          },
          "Add rule"
        )
      )
    );
  }

  private renderServices(d: Device) {
    const g = this.game;
    const http = (d.services.http ??= { enabled: false, hostnames: [], title: "" });
    const dns = (d.services.dns ??= { enabled: false, records: [], forwarder: "" });
    const httpEn = el("input", { type: "checkbox" }) as HTMLInputElement;
    httpEn.checked = http.enabled;
    const hosts = el("input", { class: "inp mono", placeholder: "market.hollow, www.market.hollow", value: http.hostnames.join(", ") }) as HTMLInputElement;
    const title = el("input", { class: "inp", placeholder: "Corner Market: order online", value: http.title }) as HTMLInputElement;
    const dnsEn = el("input", { type: "checkbox" }) as HTMLInputElement;
    dnsEn.checked = dns.enabled;
    const fwd = el("input", { class: "inp mono", placeholder: "198.51.100.10", value: dns.forwarder ?? "" }) as HTMLInputElement;
    const recName = el("input", { class: "inp mono", placeholder: "market.hollow" }) as HTMLInputElement;
    const recIp = el("input", { class: "inp mono", placeholder: "192.168.1.20" }) as HTMLInputElement;
    const saveAll = () => {
      http.enabled = httpEn.checked;
      http.hostnames = hosts.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      http.title = title.value.trim();
      dns.enabled = dnsEn.checked;
      dns.forwarder = fwd.value.trim();
      g.net.touch();
      g.recompute();
      g.save();
      g.toast(`Services on ${d.name} saved.`, "good");
      this.render();
    };
    return el(
      "div",
      { class: "card" },
      el("h4", {}, "Services"),
      el("div", { class: "sub" }, el("h5", {}, el("label", { class: "toggle" }, httpEn, el("span", {}, "Web server (HTTP, port 80)"))), el("label", {}, "Hostnames served (comma separated)", hosts), el("label", {}, "Page title", title)),
      el(
        "div",
        { class: "sub" },
        el("h5", {}, el("label", { class: "toggle" }, dnsEn, el("span", {}, "DNS server"))),
        el("label", {}, "Forwarder for unknown names", fwd),
        el(
          "table",
          { class: "mono small records" },
          ...dns.records.map((r) =>
            el("tr", {}, el("td", {}, r.name), el("td", {}, "→ " + r.ip), el("td", {}, el("button", { class: "btn tiny ghost", onclick: () => { dns.records = dns.records.filter((x) => x !== r); g.net.touch(); g.recompute(); g.save(); this.render(); } }, "remove")))
          )
        ),
        el(
          "div",
          { class: "row" },
          recName,
          recIp,
          el(
            "button",
            {
              class: "btn small",
              onclick: () => {
                if (!recName.value.trim() || parseIp(recIp.value) === null) return g.toast("A record needs a name and a valid address.", "bad");
                dns.records.push({ name: recName.value.trim().toLowerCase(), ip: recIp.value.trim() });
                saveAll();
              },
            },
            "Add record"
          )
        )
      ),
      el("button", { class: "btn primary", onclick: saveAll }, "Save services")
    );
  }

  // ------------------------------------------------------------------ terminal
  private renderTerminal(d: Device) {
    if (d.kind === "switch") return el("section", { class: "ws-term" }, el("div", { class: "term-head" }, "Terminal"), el("p", { class: "muted small pad" }, "Switches have no console in this town. They forward frames and ask nothing of you."));
    let t = this.terminals.get(d.id);
    if (!t) {
      t = new Terminal(this.game, d.id, (trace, color) => this.game.animateTrace(trace, color));
      this.terminals.set(d.id, t);
    }
    return el("section", { class: "ws-term" }, t.root);
  }
}

export type AnimateFn = (trace: TraceResult, color: string) => void;
