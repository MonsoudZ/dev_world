// A per-device terminal with ping / trace / curl / nslookup / ip / route.

import { el } from "../core/events";
import { Game } from "../game/game";
import { ipToStr, parseIp } from "../net/ip";
import { TraceResult } from "../net/sim";
import { CATALOG } from "../net/model";

const HELP = `Commands:
  ip                 show this device's interfaces, MAC and IP addresses
  ping <host>        send a request and wait for the reply (host = name or address)
  trace <host>       show every hop a packet takes, with latency, and where it stops
  nslookup <name>    ask the DNS server for a name
  curl <url>         fetch a web page, e.g. curl http://learn.example
  route              show the routing table
  arp                show the ARP cache (IP → MAC of neighbours on the local network)
  dhcp               replay the DHCP conversation for this host (DISCOVER/OFFER/REQUEST/ACK)
  log                show this device's event log
  clear              clear the screen
Tab completes commands, device names, hostnames and addresses.`;

const SWITCH_HELP = `Switch console:
  show mac-address-table   which MAC addresses were learned on which port
  show interfaces          port status, speed and what is plugged in
  log                      event log
  clear`;

export class Terminal {
  root: HTMLElement;
  private out: HTMLElement;
  private input: HTMLInputElement;
  private history: string[] = [];
  private hIdx = -1;

  constructor(private game: Game, private deviceId: string, private animate: (t: TraceResult, color: string) => void) {
    this.out = el("div", { class: "term-out" });
    this.input = el("input", { class: "term-in", placeholder: "type a command, e.g. ping 192.168.1.1", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
    this.input.onkeydown = (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        this.complete();
        return;
      }
      if (e.key === "Enter") {
        const v = this.input.value.trim();
        if (v) {
          this.history.push(v);
          this.hIdx = this.history.length;
          this.run(v);
        }
        this.input.value = "";
      } else if (e.key === "ArrowUp") {
        this.hIdx = Math.max(0, this.hIdx - 1);
        this.input.value = this.history[this.hIdx] ?? "";
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        this.hIdx = Math.min(this.history.length, this.hIdx + 1);
        this.input.value = this.history[this.hIdx] ?? "";
        e.preventDefault();
      }
    };
    const dev = game.net.device(deviceId)!;
    this.root = el(
      "div",
      { class: "term" },
      el("div", { class: "term-head" }, `${CATALOG[dev.kind].icon} ${dev.name} — terminal`, el("span", { class: "muted small" }, "  type help")),
      this.out,
      el("div", { class: "term-line" }, el("span", { class: "prompt" }, "$"), this.input)
    );
    this.print(dev.kind === "switch" ? `${dev.name} console. Type help for commands.` : `Welcome to ${dev.name}. Type help for commands.`, "muted");
  }

  private get dev() {
    return this.game.net.device(this.deviceId)!;
  }

  /** Tab completion for commands, device names, hostnames and known addresses. */
  private complete() {
    const v = this.input.value;
    const parts = v.split(/\s+/);
    const commands = this.dev.kind === "switch" ? ["help", "show mac-address-table", "show interfaces", "log", "clear"] : ["help", "ip", "ping", "trace", "nslookup", "curl", "route", "arp", "dhcp", "log", "clear"];
    let pool: string[];
    if (parts.length <= 1) pool = commands;
    else {
      const g = this.game;
      const names = [...g.net.devices.values()].filter((d) => !d.hidden).map((d) => d.name);
      const hosts = [...g.net.devices.values()].flatMap((d) => [...(d.services.dns?.records.map((r) => r.name) ?? []), ...(d.services.http?.hostnames ?? [])]);
      const ips = [...g.net.devices.values()].flatMap((d) => d.ifaces.map((i) => g.net.effective(i)).filter(Boolean).map((e) => ipToStr(e!.ip)));
      pool = [...new Set([...names, ...hosts, ...ips])];
      if (parts[0] === "curl") pool = pool.map((h) => (/^\d/.test(h) ? h : `http://${h}`));
    }
    const cur = parts[parts.length - 1];
    const matches = pool.filter((p) => p.toLowerCase().startsWith(cur.toLowerCase().replace(/^http:\/\//, "")) || p.toLowerCase().startsWith(cur.toLowerCase()));
    if (matches.length === 1) {
      parts[parts.length - 1] = matches[0];
      this.input.value = parts.join(" ") + (parts.length === 1 ? " " : "");
    } else if (matches.length > 1) {
      this.print(matches.join("   "), "muted");
    }
  }

  /** A visual chain of the hops a packet took. */
  private diagram(t: TraceResult): HTMLElement {
    const g = this.game;
    const row = el("div", { class: "trace-diagram" });
    t.hops.forEach((h, idx) => {
      const dev = g.net.device(h.deviceId);
      const kind = dev ? CATALOG[dev.kind] : undefined;
      const chip = el(
        "div",
        { class: `hop ${h.ok ? (idx === t.hops.length - 1 ? "end" : "") : "fail"}` },
        el("span", { class: "hop-icon" }, h.ok ? (kind?.icon ?? "•") : "✖"),
        el("span", { class: "hop-name" }, dev?.name ?? h.deviceId),
        h.ifaceOut ? el("span", { class: "hop-port" }, g.net.iface(h.ifaceOut)?.name ?? "") : null
      );
      row.append(chip);
      if (h.ok && idx < t.hops.length - 1) {
        const via = h.via.map((v) => g.net.device(v)?.name ?? v);
        row.append(el("div", { class: "hop-arrow" }, el("span", { class: "arrow-line" }), via.length ? el("span", { class: "hop-via" }, "via " + via.join(", ")) : null));
      }
    });
    if (!t.ok) row.append(el("div", { class: "hop-reason" }, t.reason ?? ""));
    return row;
  }

  focus() {
    this.input.focus();
  }

  private print(text: string, cls = "") {
    const line = el("pre", { class: `term-text ${cls}` }, text);
    this.out.append(line);
    this.out.scrollTop = this.out.scrollHeight;
  }

  private resolveTarget(target: string): { ip: string; note?: string } | { error: string; hint?: string; trace?: TraceResult } {
    if (parseIp(target) !== null) return { ip: target };
    const byName = this.game.net.findDeviceByName(target);
    if (byName) {
      const e = this.game.net.primaryAddr(byName);
      if (!e) return { error: `${byName.name} exists but has no IP address.`, hint: "Give it an address first." };
      return { ip: ipToStr(e.ip), note: `(${target} is a device name; using its address ${ipToStr(e.ip)})` };
    }
    const r = this.game.net.resolve(this.deviceId, target);
    if (!r.ok) return { error: `cannot resolve ${target}: ${r.reason}`, hint: r.hint, trace: r.trace };
    return { ip: r.ip!, note: `(resolved ${target} to ${r.ip}${r.viaForwarder ? " via forwarder" : ""})` };
  }

  private printTrace(t: TraceResult, label: string) {
    this.print(`${label}:`, "muted");
    this.out.append(this.diagram(t));
    t.hops.forEach((h, idx) => {
      const dev = this.game.net.device(h.deviceId);
      const name = dev?.name ?? h.deviceId;
      const via = h.via.length ? ` via ${h.via.map((v) => this.game.net.device(v)?.name ?? v).join(", ")}` : "";
      const out = h.ifaceOut ? ` ${this.game.net.iface(h.ifaceOut)?.name ?? ""}` : "";
      const arp = h.arp ? `\n       ARP: who has ${h.arp.ip}? → ${h.arp.mac} (${h.arp.device})` : "";
      this.print(`  ${idx + 1}. ${h.ok ? "●" : "✖"} ${name}${out}: ${h.action}${via}  [${h.atMs.toFixed(2)} ms]${arp}${h.detail ? `\n       ${h.detail}` : ""}`, h.ok ? "" : "bad");
    });
    if (!t.ok && t.hint) this.print(`  hint: ${t.hint}`, "hint");
  }

  run(cmdline: string) {
    const g = this.game;
    const dev = this.dev;
    this.print(`$ ${cmdline}`, "cmd");
    const [cmd, ...args] = cmdline.split(/\s+/);
    const arg = args.join(" ");
    if (dev.kind === "switch") return this.runSwitch(cmd.toLowerCase(), args);
    switch (cmd.toLowerCase()) {
      case "help":
      case "?":
        this.print(HELP, "muted");
        break;
      case "log":
      case "logs":
        this.printLog();
        break;
      case "dhcp": {
        if (!dev.power) return this.print("device is powered off", "bad");
        for (const st of g.net.dhcpTransaction(dev.id)) this.print(`${st.label.padEnd(9)} ${st.text}`, st.ok ? (st.label === "ACK" ? "good" : "") : "bad");
        g.flags.add(`dhcp:${dev.id}`);
        break;
      }
      case "arp": {
        if (!dev.power) return this.print("device is powered off", "bad");
        const t = g.net.arpTable(dev.id);
        if (!t.length) return this.print("ARP cache is empty (no address, or no neighbours on this network).", "muted");
        this.print("Address          HW address         Interface  Device");
        for (const e of t) this.print(`${e.ip.padEnd(16)} ${e.mac}  ${e.iface.padEnd(9)}  ${e.device}`);
        g.flags.add(`arp:${dev.id}`);
        break;
      }
      case "clear":
        this.out.innerHTML = "";
        break;
      case "ip":
      case "ifconfig":
      case "ipconfig":
        if (!dev.power) return this.print("device is powered off", "bad");
        for (const i of dev.ifaces) {
          const st = g.net.linkState(i);
          const e = g.net.effective(i);
          this.print(`${i.name.padEnd(6)} ${i.mac}  link ${st.padEnd(5)} ${g.net.describeIface(i)}${e?.dns !== undefined ? ` dns ${ipToStr(e.dns)}` : ""}${g.net.conflicts.has(i.id) ? "  ⚠ DUPLICATE ADDRESS" : ""}`);
        }
        break;
      case "route":
      case "routes": {
        if (!dev.power) return this.print("device is powered off", "bad");
        let any = false;
        for (const i of dev.ifaces) {
          const e = g.net.effective(i);
          if (!e) continue;
          any = true;
          const net = ipToStr((e.ip & ((0xffffffff << (32 - e.prefix)) >>> 0)) >>> 0);
          this.print(`${net}/${e.prefix}  directly connected via ${i.name}`);
          if (e.gateway !== undefined) this.print(`0.0.0.0/0        default via ${ipToStr(e.gateway)} (${i.name})`);
        }
        for (const r of dev.routes) this.print(`${r.dest}/${r.prefix}  via ${r.via}`);
        if (!any && !dev.routes.length) this.print("no routes: this device has no IP address", "muted");
        break;
      }
      case "neighbors":
      case "neighbours":
      case "arp": {
        for (const i of dev.ifaces) {
          if (g.net.linkState(i) !== "up") continue;
          const seg = g.net.segment(i.id);
          this.print(`${i.name}: ${seg.ifaces.length} device(s) on this local network`);
          for (const s of seg.ifaces) {
            const d2 = g.net.device(s.deviceId)!;
            const e = g.net.effective(s);
            this.print(`   ${d2.name.padEnd(18)} ${s.name.padEnd(5)} ${e ? ipToStr(e.ip) : "no address"}`);
          }
        }
        break;
      }
      case "ping": {
        if (!arg) return this.print("usage: ping <host or address>", "muted");
        if (!dev.power) return this.print("device is powered off", "bad");
        g.flags.add(`ping:${dev.id}`);
        g.flags.add(`ping:${dev.id}:${arg}`);
        const r = this.resolveTarget(arg);
        if ("error" in r) {
          g.flags.add(`pingfail:${dev.id}`);
          this.print(`ping: ${r.error}`, "bad");
          if (r.hint) this.print(`  hint: ${r.hint}`, "hint");
          if (r.trace) this.printTrace(r.trace, "DNS lookup path");
          return;
        }
        if (r.note) this.print(r.note, "muted");
        const p = g.net.ping(dev.id, r.ip, false);
        g.flags.add(`ping:${dev.id}:${r.ip}`);
        if (p.request) {
          this.printTrace(p.request, `Request to ${r.ip}`);
          this.animate(p.request, p.request.ok ? "rgb(255,210,80)" : "rgb(255,90,90)");
        }
        if (p.reply) {
          this.printTrace(p.reply, "Reply");
          if (p.ok) setTimeout(() => this.animate(p.reply!, "rgb(80,230,170)"), 900);
          else this.animate(p.reply, "rgb(255,90,90)");
        }
        this.print(p.ok ? p.summary : `✖ ${p.summary}`, p.ok ? "good" : "bad");
        if (!p.ok && p.hint) this.print(`  hint: ${p.hint}`, "hint");
        g.flags.add(p.ok ? `pingok:${dev.id}` : `pingfail:${dev.id}`);
        if (p.ok) g.flags.add(`pingok:${dev.id}:${r.ip}`);
        break;
      }
      case "trace":
      case "traceroute":
      case "tracert": {
        if (!arg) return this.print("usage: trace <host or address>", "muted");
        if (!dev.power) return this.print("device is powered off", "bad");
        g.flags.add(`trace:${dev.id}`);
        const r = this.resolveTarget(arg);
        if ("error" in r) {
          this.print(`trace: ${r.error}`, "bad");
          if (r.hint) this.print(`  hint: ${r.hint}`, "hint");
          if (r.trace) this.printTrace(r.trace, "DNS lookup path");
          return;
        }
        if (r.note) this.print(r.note, "muted");
        const t = g.net.forward(dev.id, parseIp(r.ip)!, "icmp", { nat: new Map(), reply: false });
        this.printTrace(t, `Path to ${r.ip}`);
        this.animate(t, t.ok ? "rgb(255,210,80)" : "rgb(255,90,90)");
        this.print(t.ok ? `reached ${g.net.device(t.deliveredTo!)?.name} in ${t.hops.length - 1} hop(s), one-way ${t.rttMs.toFixed(2)} ms` : `✖ stopped: ${t.reason}`, t.ok ? "good" : "bad");
        break;
      }
      case "nslookup":
      case "dig":
      case "host": {
        if (!arg) return this.print("usage: nslookup <name>", "muted");
        if (!dev.power) return this.print("device is powered off", "bad");
        const r = g.net.resolve(dev.id, arg, false);
        g.flags.add(`nslookup:${dev.id}`);
        if (r.trace) this.animate(r.trace, r.ok ? "rgb(180,140,255)" : "rgb(255,90,90)");
        if (r.ok) {
          this.print(`Server: ${r.serverId ? g.net.device(r.serverId)?.name : "local"}${r.viaForwarder ? " (answered via forwarder)" : ""}`, "muted");
          this.print(`${arg} → ${r.ip}`, "good");
        } else {
          this.print(`✖ ${r.reason}`, "bad");
          if (r.hint) this.print(`  hint: ${r.hint}`, "hint");
          if (r.trace && !r.trace.ok) this.printTrace(r.trace, "Path to DNS server");
        }
        break;
      }
      case "curl":
      case "wget":
      case "open": {
        if (!arg) return this.print("usage: curl http://<host>", "muted");
        if (!dev.power) return this.print("device is powered off", "bad");
        const host = arg.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
        g.flags.add(`fetch:${dev.id}:${host}`);
        const f = g.net.fetch(dev.id, arg, false);
        if (f.resolve?.trace) this.animate(f.resolve.trace, "rgb(180,140,255)");
        if (f.resolve && f.resolve.ok && parseIp(host) === null) this.print(`resolved ${host} → ${f.resolve.ip}`, "muted");
        if (f.request) {
          this.printTrace(f.request, `HTTP request to ${host}`);
          setTimeout(() => this.animate(f.request!, f.request!.ok ? "rgb(255,210,80)" : "rgb(255,90,90)"), f.resolve?.trace ? 700 : 0);
        }
        if (f.reply && !f.reply.ok) this.printTrace(f.reply, "HTTP reply");
        if (f.ok) {
          g.flags.add(`fetchok:${dev.id}:${host}`);
          setTimeout(() => this.animate(f.reply!, "rgb(80,230,170)"), 1600);
          this.print(`${(f.headers ?? ["HTTP/1.1 200 OK"]).join("\n")}\n\n<title>${f.title}</title>`, "good");
          this.print(`total time: ${f.totalMs?.toFixed(2)} ms (DNS + TCP handshake + request)`, "muted");
        } else {
          this.print(`✖ ${f.reason}`, "bad");
          if (f.hint) this.print(`  hint: ${f.hint}`, "hint");
        }
        break;
      }
      default:
        this.print(`unknown command: ${cmd}. Type help.`, "bad");
    }
  }

  private printLog() {
    const entries = this.dev.log ?? [];
    if (!entries.length) return this.print("log is empty", "muted");
    for (const e of entries.slice(-30)) this.print(`${e.t}  ${e.text}`, e.kind === "error" ? "bad" : e.kind === "warn" ? "hint" : "");
  }

  private runSwitch(cmd: string, args: string[]) {
    const g = this.game;
    const dev = this.dev;
    const sub = args.join(" ").toLowerCase();
    if (cmd === "help" || cmd === "?") return this.print(SWITCH_HELP, "muted");
    if (cmd === "clear") {
      this.out.innerHTML = "";
      return;
    }
    if (cmd === "log" || cmd === "logs") return this.printLog();
    if (!dev.power) return this.print("switch is powered off", "bad");
    if (g.net.isBooting(dev)) return this.print("switch is booting…", "bad");
    if ((cmd === "show" && sub.startsWith("mac")) || cmd === "mac") {
      const table = g.net.macTable(dev.id);
      if (!table.length) return this.print("MAC address table is empty: no live links.", "muted");
      this.print("Port   MAC address        Learned from");
      for (const row of table) {
        if (!row.entries.length) this.print(`${row.port.padEnd(6)} (nothing heard yet)`);
        for (const e of row.entries) this.print(`${row.port.padEnd(6)} ${e.mac}  ${e.device} ${e.iface}${e.ip ? ` (${e.ip})` : ""}`);
      }
      this.print("A switch learns which address sits behind each port by watching source addresses of frames. It never looks at IP.", "muted");
      g.flags.add(`mactable:${dev.id}`);
      return;
    }
    if ((cmd === "show" && sub.startsWith("int")) || cmd === "interfaces") {
      for (const p of dev.ifaces) {
        const st = g.net.linkState(p);
        const peer = g.net.peerIface(p.id);
        const link = g.net.linkOf(p.id);
        this.print(`${p.name.padEnd(4)} ${st.padEnd(5)} ${link ? g.net.linkSpeed(link).padEnd(10) : "".padEnd(10)} ${peer ? `${g.net.device(peer.deviceId)?.name} ${peer.name}` : "empty"}${link && g.net.linkIssue(link) ? `  ✖ ${g.net.linkIssue(link)}` : ""}`, st === "down" ? "bad" : "");
      }
      return;
    }
    this.print(`unknown command: ${cmd}. Type help.`, "bad");
  }
}
