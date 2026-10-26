// A per-device terminal with ping / trace / curl / nslookup / ip / route.

import { el } from "../core/events";
import { Game } from "../game/game";
import { ipToStr, parseIp } from "../net/ip";
import { TraceResult } from "../net/sim";
import { CATALOG } from "../net/model";

const HELP = `Commands:
  ip                 show this device's interfaces and addresses
  ping <host>        send a request and wait for the reply (host = name or address)
  trace <host>       show every hop a packet takes, and where it stops
  nslookup <name>    ask the DNS server for a name
  curl <url>         fetch a web page, e.g. curl http://learn.example
  route              show the routing table
  neighbors          list devices reachable on the local network
  clear              clear the screen`;

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
    this.print(`Welcome to ${dev.name}. Type help for commands.`, "muted");
  }

  private get dev() {
    return this.game.net.device(this.deviceId)!;
  }

  /** Tab completion for commands, device names, hostnames and known addresses. */
  private complete() {
    const v = this.input.value;
    const parts = v.split(/\s+/);
    const commands = ["help", "ip", "ping", "trace", "nslookup", "curl", "route", "neighbors", "clear"];
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
      this.print(`  ${idx + 1}. ${h.ok ? "●" : "✖"} ${name}${out}: ${h.action}${via}${h.detail ? `\n       ${h.detail}` : ""}`, h.ok ? "" : "bad");
    });
    if (!t.ok && t.hint) this.print(`  hint: ${t.hint}`, "hint");
  }

  run(cmdline: string) {
    const g = this.game;
    const dev = this.dev;
    this.print(`$ ${cmdline}`, "cmd");
    const [cmd, ...args] = cmdline.split(/\s+/);
    const arg = args.join(" ");
    switch (cmd.toLowerCase()) {
      case "help":
      case "?":
        this.print(HELP, "muted");
        break;
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
          this.print(`${i.name.padEnd(6)} link ${st.padEnd(5)} ${g.net.describeIface(i)}${e?.dns !== undefined ? ` dns ${ipToStr(e.dns)}` : ""}${g.net.conflicts.has(i.id) ? "  ⚠ DUPLICATE ADDRESS" : ""}`);
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
        const p = g.net.ping(dev.id, r.ip);
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
        this.print(t.ok ? `reached ${g.net.device(t.deliveredTo!)?.name} in ${t.hops.length - 1} hop(s)` : `✖ stopped: ${t.reason}`, t.ok ? "good" : "bad");
        break;
      }
      case "nslookup":
      case "dig":
      case "host": {
        if (!arg) return this.print("usage: nslookup <name>", "muted");
        if (!dev.power) return this.print("device is powered off", "bad");
        const r = g.net.resolve(dev.id, arg);
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
        const f = g.net.fetch(dev.id, arg);
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
          this.print(`HTTP/1.1 200 OK\n<title>${f.title}</title>`, "good");
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
}
