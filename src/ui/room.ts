// The inside of a building: a drawn room with a 19" rack, desks, equipment and patch cables.
// Rendered as SVG so ports and devices are clickable and crisp at any size.

import { Game } from "../game/game";
import { Device, Iface, Link } from "../net/model";
import { Building, building } from "../world/map";

const NS = "http://www.w3.org/2000/svg";

type Attrs = Record<string, string | number | undefined>;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (SVGElement | string | null | undefined | false)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) {
    if (!c) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

interface PortPos {
  x: number;
  y: number;
  side: "rack" | "host";
}

export interface RoomHooks {
  onSelectDevice: (id: string) => void;
  onPortClick: (iface: Iface) => void;
}

const W = 1000;
const H = 330;
const WALL_H = 232;
const RACK = { x: 36, y: 22, w: 214, h: 292 };
const U = 27; // one rack unit in px
const TRAY_Y = 318; // floor cable tray
const CONDUIT_Y = 14; // ceiling conduit for outbound cables

export class RoomView {
  constructor(private game: Game, private hooks: RoomHooks) {}

  render(buildingId: string, selectedDevice: string | null, hoverPort?: string): SVGSVGElement {
    const g = this.game;
    const b = building(buildingId);
    const devices = g.net.devicesIn(buildingId);
    const light = g.light;
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "room", preserveAspectRatio: "xMidYMid meet" });
    root.append(this.defs(b));
    root.append(this.backdrop(b, light));

    const rackDevices = devices.filter((d) => ["switch", "router", "modem", "server", "ups"].includes(d.kind)).sort((a, c) => rackOrder(a) - rackOrder(c));
    const hosts = devices.filter((d) => !rackDevices.includes(d));
    const ports = new Map<string, PortPos>();

    // Rack
    root.append(this.rack(rackDevices, selectedDevice, ports, hoverPort));
    // Desks with hosts
    const n = hosts.length;
    const spacing = n <= 3 ? 190 : Math.min(190, (W - 300 - 110) / n);
    hosts.forEach((d, i) => root.append(this.desk(d, 300 + i * spacing, selectedDevice, ports, hoverPort, light)));

    // Wall plates for cables leaving the building, and the cables themselves
    root.append(this.cables(devices, ports, buildingId));

    // NPC standing by the door
    if (b.npc) root.append(this.person(b.npc.color, b.npc.name, 930, 262));
    return root;
  }

  // ------------------------------------------------------------------ pieces
  private defs(b: Building) {
    const d = svg("defs");
    d.innerHTML = `
      <linearGradient id="wallGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${shade(b.color, 1.05)}"/>
        <stop offset="1" stop-color="${shade(b.color, 0.85)}"/>
      </linearGradient>
      <linearGradient id="floorGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#5a4a3c"/>
        <stop offset="1" stop-color="#3b3027"/>
      </linearGradient>
      <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3a414d"/>
        <stop offset="0.5" stop-color="#262b34"/>
        <stop offset="1" stop-color="#1b1f26"/>
      </linearGradient>
      <linearGradient id="metalLight" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#d9dde3"/>
        <stop offset="1" stop-color="#9aa3ad"/>
      </linearGradient>
      <linearGradient id="screenOn" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#1f3b5c"/>
        <stop offset="1" stop-color="#17263b"/>
      </linearGradient>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="softShadow" x="-20%" y="-20%" width="140%" height="160%">
        <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#000" flood-opacity="0.45"/>
      </filter>
      <pattern id="floorTiles" width="40" height="40" patternUnits="userSpaceOnUse">
        <rect width="40" height="40" fill="none"/>
        <path d="M0 0H40M0 0V40" stroke="rgba(0,0,0,0.18)" stroke-width="1"/>
      </pattern>`;
    return d;
  }

  private backdrop(b: Building, light: number) {
    const gEl = svg("g", { class: "backdrop" });
    gEl.append(svg("rect", { x: 0, y: 0, width: W, height: WALL_H, fill: "url(#wallGrad)" }));
    // skirting and floor
    gEl.append(svg("rect", { x: 0, y: WALL_H, width: W, height: H - WALL_H, fill: "url(#floorGrad)" }));
    gEl.append(svg("rect", { x: 0, y: WALL_H, width: W, height: H - WALL_H, fill: "url(#floorTiles)" }));
    gEl.append(svg("rect", { x: 0, y: WALL_H - 6, width: W, height: 8, fill: shade(b.color, 0.6) }));
    // ceiling conduit for cables that leave the building
    gEl.append(svg("rect", { x: 0, y: CONDUIT_Y - 5, width: W, height: 10, fill: "#4b5563", opacity: 0.9 }));
    gEl.append(svg("rect", { x: 0, y: CONDUIT_Y - 5, width: W, height: 3, fill: "#6b7280" }));
    // window with sky
    const sky = light > 0.5 ? "#8fc6ee" : light > 0.2 ? "#e39b6a" : "#101a3a";
    const win = svg("g", { transform: "translate(560 48)" });
    win.append(svg("rect", { x: -6, y: -6, width: 172, height: 112, rx: 4, fill: "#f3efe6" }));
    win.append(svg("rect", { x: 0, y: 0, width: 160, height: 100, fill: sky }));
    if (light <= 0.2) for (let i = 0; i < 8; i++) win.append(svg("circle", { cx: 10 + ((i * 37) % 150), cy: 8 + ((i * 23) % 60), r: 1.2, fill: "#fff" }));
    if (light > 0.2 && light <= 0.5) win.append(svg("circle", { cx: 120, cy: 70, r: 14, fill: "#ffd27a", opacity: 0.9 }));
    win.append(svg("rect", { x: 0, y: 70, width: 160, height: 30, fill: light > 0.5 ? "#6fa85a" : "#1f3a2a" }));
    win.append(svg("path", { d: "M80 0V100M0 50H160", stroke: "#f3efe6", "stroke-width": 5 }));
    gEl.append(win);
    // light fixture glow at night
    if (light < 0.5) gEl.append(svg("ellipse", { cx: 500, cy: 60, rx: 420, ry: 150, fill: "rgba(255,230,170,0.10)" }));
    // decoration by building kind
    gEl.append(this.decor(b));
    // door on the right
    gEl.append(svg("rect", { x: 896, y: 96, width: 72, height: 136, rx: 3, fill: shade(b.trim, 0.9), stroke: "rgba(0,0,0,0.35)" }));
    gEl.append(svg("circle", { cx: 956, cy: 168, r: 3, fill: "#333" }));
    // room label
    gEl.append(svg("text", { x: W - 14, y: H - 10, "text-anchor": "end", class: "room-label" }, `${b.name} · ${b.kind}`));
    return gEl;
  }

  private decor(b: Building) {
    const gEl = svg("g");
    const x = 760;
    switch (b.kind) {
      case "library": {
        gEl.append(svg("rect", { x, y: 60, width: 120, height: 170, fill: "#6d4c41" }));
        for (let r = 0; r < 4; r++) {
          gEl.append(svg("rect", { x: x + 4, y: 70 + r * 40, width: 112, height: 4, fill: "#4e342e" }));
          for (let i = 0; i < 9; i++) gEl.append(svg("rect", { x: x + 8 + i * 12, y: 40 + r * 40 + 10 + (i % 3) * 2, width: 9, height: 24 - (i % 3) * 2, fill: ["#c62828", "#1565c0", "#2e7d32", "#f9a825", "#6a1b9a"][(i + r) % 5] }));
        }
        break;
      }
      case "shop": {
        gEl.append(svg("rect", { x, y: 70, width: 130, height: 160, fill: "#8d6e63" }));
        for (let r = 0; r < 3; r++) {
          gEl.append(svg("rect", { x: x + 4, y: 100 + r * 44, width: 122, height: 4, fill: "#5d4037" }));
          for (let i = 0; i < 6; i++) gEl.append(svg("rect", { x: x + 10 + i * 19, y: 84 + r * 44, width: 14, height: 16, rx: 2, fill: ["#ff7043", "#ffca28", "#66bb6a", "#42a5f5"][(i + r) % 4] }));
        }
        break;
      }
      case "workshop": {
        gEl.append(svg("rect", { x, y: 56, width: 130, height: 110, fill: "#c8b596", stroke: "#8d7b5c" }));
        for (let i = 0; i < 5; i++) for (let j = 0; j < 7; j++) gEl.append(svg("circle", { cx: x + 12 + j * 18, cy: 68 + i * 20, r: 1.5, fill: "#8d7b5c" }));
        gEl.append(svg("rect", { x: x + 20, y: 72, width: 6, height: 40, fill: "#546e7a" }));
        gEl.append(svg("rect", { x: x + 50, y: 72, width: 30, height: 8, fill: "#ef6c00" }));
        gEl.append(svg("rect", { x: x + 62, y: 80, width: 6, height: 30, fill: "#ef6c00" }));
        gEl.append(svg("circle", { cx: x + 105, cy: 90, r: 12, fill: "none", stroke: "#37474f", "stroke-width": 4 }));
        break;
      }
      case "clinic": {
        gEl.append(svg("rect", { x, y: 70, width: 110, height: 160, fill: "#eceff1", stroke: "#b0bec5" }));
        gEl.append(svg("rect", { x: x + 45, y: 90, width: 20, height: 60, fill: "#e53935" }));
        gEl.append(svg("rect", { x: x + 25, y: 110, width: 60, height: 20, fill: "#e53935" }));
        break;
      }
      case "hall": {
        gEl.append(svg("rect", { x, y: 60, width: 120, height: 90, fill: "#f5f0e6", stroke: "#8d6e63" }));
        gEl.append(svg("path", { d: `M${x + 10} 130 L${x + 40} 90 L${x + 65} 115 L${x + 85} 95 L${x + 110} 130Z`, fill: "#7cb342" }));
        break;
      }
      default: {
        gEl.append(svg("rect", { x: x + 20, y: 70, width: 70, height: 56, fill: "#f3e5d8", stroke: "#8d6e63", "stroke-width": 4 }));
        gEl.append(svg("circle", { cx: x + 55, cy: 92, r: 12, fill: "#ffd54f" }));
        gEl.append(svg("path", { d: `M${x + 24} 126 L${x + 50} 100 L${x + 70} 118 L${x + 86} 106 L${x + 86} 126Z`, fill: "#6fa85a" }));
        gEl.append(svg("rect", { x: x + 100, y: 150, width: 40, height: 80, fill: "#7cb342", rx: 20 }));
        gEl.append(svg("rect", { x: x + 110, y: 220, width: 20, height: 12, fill: "#8d6e63" }));
      }
    }
    return gEl;
  }

  private rack(devs: Device[], selected: string | null, ports: Map<string, PortPos>, hoverPort?: string) {
    const g = this.game;
    const gEl = svg("g", { class: "rack", filter: "url(#softShadow)" });
    gEl.append(svg("rect", { x: RACK.x, y: RACK.y, width: RACK.w, height: RACK.h, rx: 6, fill: "#1c2027", stroke: "#0d0f13" }));
    gEl.append(svg("rect", { x: RACK.x + 6, y: RACK.y + 6, width: RACK.w - 12, height: RACK.h - 12, rx: 3, fill: "#12151a" }));
    // rails with holes
    for (const rx of [RACK.x + 10, RACK.x + RACK.w - 16]) {
      gEl.append(svg("rect", { x: rx, y: RACK.y + 10, width: 6, height: RACK.h - 20, fill: "#2b313b" }));
      for (let y = RACK.y + 16; y < RACK.y + RACK.h - 16; y += 9) gEl.append(svg("rect", { x: rx + 1.5, y, width: 3, height: 3, fill: "#0b0d10" }));
    }
    gEl.append(svg("text", { x: RACK.x + RACK.w / 2, y: RACK.y + RACK.h - 8, "text-anchor": "middle", class: "rack-brand" }, "19″ CABINET"));
    let y = RACK.y + 18;
    const x = RACK.x + 20;
    const w = RACK.w - 40;
    for (const d of devs) {
      const units = d.kind === "server" ? 2 : 1;
      const h = units * U - 4;
      const unit = svg("g", { class: `unit ${selected === d.id ? "selected" : ""} ${d.power ? "" : "off"}`, "data-device": d.id, transform: `translate(${x} ${y})` });
      unit.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hooks.onSelectDevice(d.id);
      });
      unit.append(svg("rect", { x: 0, y: 0, width: w, height: h, rx: 2, fill: d.kind === "modem" ? "#eceff1" : "url(#metal)", stroke: selected === d.id ? "#5ac8ff" : "rgba(0,0,0,0.6)", "stroke-width": selected === d.id ? 2 : 1 }));
      // mounting ears
      for (const ex of [-8, w + 2]) unit.append(svg("rect", { x: ex, y: 2, width: 6, height: h - 4, fill: "#2b313b" }));
      unit.append(svg("text", { x: 8, y: 10, class: `faceplate-label ${d.kind === "modem" ? "dark" : ""}` }, d.name.length > 16 ? d.name.slice(0, 15) + "…" : d.name));
      if (d.kind === "server" || d.kind === "switch") unit.append(svg("text", { x: w - 22, y: 10, "text-anchor": "end", class: "faceplate-model" }, model(d)));
      // power LED
      unit.append(this.led(w - 10, h - 7, d.power ? (g.net.isBooting(d) ? "amber" : "green") : "off", g.net.isBooting(d)));
      if (d.power && g.net.isDirty(d)) {
        unit.append(svg("circle", { cx: w - 22, cy: 7, r: 3, fill: "#ffcc33", filter: "url(#glow)" }));
        unit.append(svg("title", {}, "Unsaved configuration: a reboot or power cut will discard it."));
      }
      if (d.kind === "switch") {
        d.ifaces.forEach((p, i) => {
          const px = 8 + i * 18;
          const py = h - 14;
          unit.append(this.rj45(px, py, p, hoverPort === p.id));
          ports.set(p.id, { x: x + px + 6, y: y + py + 8, side: "rack" });
        });
      } else if (d.kind === "router") {
        d.ifaces.forEach((p, i) => {
          const px = 8 + i * 30;
          const py = h - 14;
          unit.append(svg("text", { x: px + 6, y: py - 2, "text-anchor": "middle", class: "port-label" }, p.name.toUpperCase()));
          unit.append(this.rj45(px, py, p, hoverPort === p.id, p.name === "wan" ? "#1e88e5" : undefined));
          ports.set(p.id, { x: x + px + 6, y: y + py + 8, side: "rack" });
        });
        ["NAT", "DHCP"].forEach((l, i) => {
          const on = l === "NAT" ? d.ifaces.some((p) => p.nat) : d.ifaces.some((p) => p.dhcp?.enabled);
          unit.append(this.led(w - 46 + i * 18, h - 10, on && d.power ? "green" : "off"));
          unit.append(svg("text", { x: w - 46 + i * 18, y: h - 2, "text-anchor": "middle", class: "port-label" }, l));
        });
      } else if (d.kind === "modem") {
        ["PWR", "DS", "US", "ONLINE"].forEach((l, i) => {
          unit.append(this.led(56 + i * 22, h - 11, d.power ? "green" : "off", d.power && i > 0));
          unit.append(svg("text", { x: 56 + i * 22, y: h - 2, "text-anchor": "middle", class: "port-label dark" }, l));
        });
        const lan = d.ifaces.find((p) => p.name === "lan")!;
        unit.append(svg("text", { x: 14, y: h - 15, "text-anchor": "middle", class: "port-label dark" }, "LAN"));
        unit.append(this.rj45(8, h - 14, lan, hoverPort === lan.id));
        ports.set(lan.id, { x: x + 14, y: y + h - 6, side: "rack" });
        // fiber input (provider side)
        unit.append(svg("rect", { x: w - 30, y: h - 13, width: 14, height: 10, rx: 2, fill: "#ff9800", stroke: "#8a4b00" }));
        unit.append(svg("text", { x: w - 23, y: h - 15, "text-anchor": "middle", class: "port-label dark" }, "FIBER"));
      } else if (d.kind === "ups") {
        const bat = d.battery ?? 1;
        for (let i = 0; i < 5; i++) unit.append(svg("rect", { x: 70 + i * 14, y: 6, width: 10, height: h - 12, rx: 1, fill: bat > (i + 0.5) / 5 ? (bat < 0.3 ? "#ff5252" : "#3ce6aa") : "#2a2f38", filter: bat > (i + 0.5) / 5 ? "url(#glow)" : undefined }));
        unit.append(svg("text", { x: 150, y: h - 6, class: "port-label" }, `${Math.round(bat * 100)}%  ${g.mainsIsOut(d.buildingId) ? "ON BATTERY" : "ONLINE"}`));
      } else if (d.kind === "server") {
        for (let i = 0; i < 4; i++) {
          unit.append(svg("rect", { x: 8 + i * 30, y: 18, width: 26, height: 12, rx: 1, fill: "#0e1116", stroke: "#3a414d" }));
          unit.append(this.led(12 + i * 30, 24, d.power ? (i < 2 ? "green" : "amber") : "off", d.power && i === 0));
        }
        const active = d.services.http?.enabled || d.services.dns?.enabled;
        unit.append(svg("text", { x: 8, y: h - 6, class: "port-label" }, active ? [d.services.http?.enabled ? "HTTP:80" : "", d.services.dns?.enabled ? "DNS:53" : ""].filter(Boolean).join("  ") : "no services"));
        const eth = d.ifaces[0];
        unit.append(this.rj45(w - 40, h - 14, eth, hoverPort === eth.id));
        ports.set(eth.id, { x: x + w - 34, y: y + h - 6, side: "rack" });
      }
      gEl.append(unit);
      y += units * U;
    }
    if (devs.length === 0) gEl.append(svg("text", { x: RACK.x + RACK.w / 2, y: RACK.y + RACK.h / 2, "text-anchor": "middle", class: "empty-rack" }, "empty rack"));
    return gEl;
  }

  private desk(d: Device, x: number, selected: string | null, ports: Map<string, PortPos>, hoverPort: string | undefined, light: number) {
    const g = this.game;
    const gEl = svg("g", { class: `host ${selected === d.id ? "selected" : ""}`, "data-device": d.id, transform: `translate(${x} 0)` });
    gEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hooks.onSelectDevice(d.id);
    });
    const deskY = 196;
    // desk
    gEl.append(svg("rect", { x: 0, y: deskY, width: 150, height: 10, rx: 2, fill: "#8d6e63" }));
    gEl.append(svg("rect", { x: 6, y: deskY + 10, width: 8, height: 100, fill: "#5d4037" }));
    gEl.append(svg("rect", { x: 136, y: deskY + 10, width: 8, height: 100, fill: "#5d4037" }));
    // chair
    gEl.append(svg("rect", { x: 50, y: 250, width: 44, height: 8, rx: 3, fill: "#37474f" }));
    gEl.append(svg("rect", { x: 70, y: 258, width: 4, height: 36, fill: "#263238" }));
    gEl.append(svg("rect", { x: 52, y: 292, width: 40, height: 4, rx: 2, fill: "#263238" }));
    gEl.append(svg("rect", { x: 54, y: 214, width: 36, height: 40, rx: 4, fill: "#455a64" }));
    const state = this.hostState(d);
    if (d.kind === "pc") {
      // monitor
      gEl.append(svg("rect", { x: 30, y: 120, width: 90, height: 60, rx: 3, fill: "#111318", stroke: "#2b313b", filter: "url(#softShadow)" }));
      gEl.append(this.screen(34, 124, 82, 52, state, d, light));
      gEl.append(svg("rect", { x: 70, y: 180, width: 10, height: 10, fill: "#2b313b" }));
      gEl.append(svg("rect", { x: 55, y: 190, width: 40, height: 4, rx: 2, fill: "#2b313b" }));
      // keyboard + mouse
      gEl.append(svg("rect", { x: 40, y: 198, width: 60, height: 5, rx: 1, fill: "#37474f" }));
      gEl.append(svg("ellipse", { cx: 112, cy: 200, rx: 5, ry: 3, fill: "#37474f" }));
      // tower under the desk
      gEl.append(svg("rect", { x: 104, y: 214, width: 28, height: 70, rx: 2, fill: "url(#metal)", stroke: "#0d0f13" }));
      gEl.append(this.led(110, 222, d.power ? (g.net.isBooting(d) ? "amber" : "green") : "off", g.net.isBooting(d)));
      gEl.append(svg("rect", { x: 109, y: 232, width: 18, height: 3, fill: "#0b0d10" }));
      const eth = d.ifaces[0];
      gEl.append(this.rj45(112, 266, eth, hoverPort === eth.id));
      ports.set(eth.id, { x: x + 118, y: 272, side: "host" });
    } else {
      // laptop
      gEl.append(svg("path", { d: "M40 196 L48 150 L118 150 L126 196 Z", fill: "#263238", stroke: "#0d0f13" }));
      gEl.append(this.screen(52, 154, 62, 38, state, d, light));
      gEl.append(svg("rect", { x: 36, y: 192, width: 94, height: 6, rx: 2, fill: "#37474f" }));
      gEl.append(svg("rect", { x: 56, y: 193, width: 54, height: 3, rx: 1, fill: "#546e7a" }));
      gEl.append(this.led(42, 195, d.power ? (g.net.isBooting(d) ? "amber" : "green") : "off", g.net.isBooting(d)));
      const eth = d.ifaces[0];
      gEl.append(this.rj45(126, 188, eth, hoverPort === eth.id));
      ports.set(eth.id, { x: x + 132, y: 194, side: "host" });
    }
    gEl.append(svg("text", { x: 75, y: 112, "text-anchor": "middle", class: `host-label ${selected === d.id ? "sel" : ""}` }, d.name));
    if (selected === d.id) gEl.append(svg("rect", { x: 2, y: 104, width: 146, height: 196, rx: 8, fill: "none", stroke: "#5ac8ff", "stroke-width": 2, "stroke-dasharray": "6 4", opacity: 0.8 }));
    return gEl;
  }

  private hostState(d: Device): "off" | "boot" | "noaddr" | "nolink" | "ok" | "offline" {
    const g = this.game;
    if (!d.power) return "off";
    if (g.net.isBooting(d)) return "boot";
    const i = d.ifaces[0];
    if (g.net.linkState(i) !== "up") return "nolink";
    if (!g.net.effective(i)) return "noaddr";
    const e = g.net.effective(i)!;
    if (e.gateway !== undefined && g.net.ping(d.id, "198.51.100.10").ok) return "ok";
    return "offline";
  }

  private screen(x: number, y: number, w: number, h: number, state: ReturnType<RoomView["hostState"]>, d: Device, light: number) {
    const gEl = svg("g", { transform: `translate(${x} ${y})` });
    const on = state !== "off";
    gEl.append(svg("rect", { x: 0, y: 0, width: w, height: h, rx: 1.5, fill: on ? "url(#screenOn)" : "#05070a" }));
    if (!on) {
      gEl.append(svg("rect", { x: 0, y: 0, width: w, height: h, fill: "rgba(255,255,255,0.03)" }));
      return gEl;
    }
    if (state === "boot") {
      gEl.append(svg("rect", { x: w * 0.2, y: h * 0.55, width: w * 0.6, height: 4, fill: "#263238" }));
      gEl.append(svg("rect", { x: w * 0.2, y: h * 0.55, width: w * 0.6 * 0.5, height: 4, fill: "#5ac8ff", class: "boot-bar" }));
      gEl.append(svg("text", { x: w / 2, y: h * 0.4, "text-anchor": "middle", class: "screen-text" }, "booting…"));
      return gEl;
    }
    // desktop: a little window
    gEl.append(svg("rect", { x: 4, y: 6, width: w - 8, height: h - 10, rx: 1.5, fill: "#f4f6fb" }));
    gEl.append(svg("rect", { x: 4, y: 6, width: w - 8, height: 5, rx: 1.5, fill: state === "ok" ? "#3ce6aa" : state === "noaddr" || state === "nolink" ? "#ffcc33" : "#ff6b6b" }));
    for (let i = 0; i < 3; i++) gEl.append(svg("rect", { x: 8, y: 15 + i * 6, width: (w - 16) * (0.9 - i * 0.25), height: 2.5, fill: "#c5cbd6" }));
    // status glyph bottom-right
    const glyph = state === "ok" ? "●" : state === "nolink" ? "✕" : state === "noaddr" ? "?" : "!";
    gEl.append(svg("text", { x: w - 7, y: h - 6, "text-anchor": "middle", class: `screen-glyph ${state}` }, glyph));
    // screen glow at night
    if (light < 0.5) gEl.append(svg("rect", { x: -6, y: -6, width: w + 12, height: h + 12, fill: "rgba(120,180,255,0.12)", filter: "url(#glow)" }));
    void d;
    return gEl;
  }

  private rj45(x: number, y: number, p: Iface, hover: boolean, color?: string) {
    const g = this.game;
    const st = g.net.linkState(p);
    const link = g.net.linkOf(p.id);
    const gEl = svg("g", { class: `port ${st} ${hover ? "hover" : ""} ${p.enabled === false ? "admin-down" : ""}`, "data-port": p.id, transform: `translate(${x} ${y})` });
    gEl.append(svg("title", {}, `${p.name}${link ? ` → ${g.net.device(g.net.peerIface(p.id)!.deviceId)?.name} ${g.net.peerIface(p.id)!.name}` : " (empty: click to connect)"}`));
    gEl.append(svg("rect", { x: 0, y: 0, width: 12, height: 10, rx: 1.5, fill: color ?? (st === "none" ? "#0b0d10" : "#1a1f27"), stroke: hover ? "#5ac8ff" : "#4a5260", "stroke-width": hover ? 1.5 : 0.8 }));
    gEl.append(svg("rect", { x: 3, y: 0, width: 6, height: 3, fill: "#2b313b" }));
    // link LED above
    const led = p.enabled === false ? "amber" : st === "up" ? "green" : st === "down" ? "red" : "off";
    gEl.append(this.led(6, -4, led, st === "up"));
    gEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hooks.onPortClick(p);
    });
    return gEl;
  }

  private led(cx: number, cy: number, state: "green" | "amber" | "red" | "off", blink = false) {
    const fill = state === "green" ? "#3ce6aa" : state === "amber" ? "#ffb74d" : state === "red" ? "#ff5252" : "#2a2f38";
    return svg("circle", { cx, cy, r: 2.2, fill, class: `led-${state} ${blink && state !== "off" ? "blink" : ""}`, style: blink ? `animation-delay:${(cx * 7 + cy * 13) % 1500}ms` : undefined, filter: state !== "off" ? "url(#glow)" : undefined });
  }

  private person(color: string, name: string, x: number, y: number) {
    const gEl = svg("g", { transform: `translate(${x} ${y})` });
    gEl.append(svg("ellipse", { cx: 0, cy: 52, rx: 12, ry: 4, fill: "rgba(0,0,0,0.3)" }));
    gEl.append(svg("rect", { x: -9, y: 0, width: 18, height: 34, rx: 6, fill: color }));
    gEl.append(svg("rect", { x: -8, y: 32, width: 6, height: 18, fill: "#2b2f3a" }));
    gEl.append(svg("rect", { x: 2, y: 32, width: 6, height: 18, fill: "#2b2f3a" }));
    gEl.append(svg("circle", { cx: 0, cy: -8, r: 8, fill: "#e0ac69" }));
    gEl.append(svg("text", { x: 0, y: -20, "text-anchor": "middle", class: "person-label" }, name));
    return gEl;
  }

  // ------------------------------------------------------------------ cables
  private cables(devices: Device[], ports: Map<string, PortPos>, buildingId: string) {
    const g = this.game;
    const gEl = svg("g", { class: "cables" });
    const seen = new Set<string>();
    let trayLane = 0;
    let plateIdx = 0;
    const plateFor = new Map<string, { x: number; y: number }>();
    for (const d of devices) {
      for (const i of d.ifaces) {
        const link = g.net.linkOf(i.id);
        if (!link || seen.has(link.id)) continue;
        seen.add(link.id);
        const peer = g.net.peerIface(i.id)!;
        const peerDev = g.net.device(peer.deviceId)!;
        const a = ports.get(i.id);
        if (!a) continue;
        const color = cableColor(link, g.net.linkIssue(link) !== null);
        if (peerDev.buildingId === buildingId && !peerDev.hidden) {
          const bpos = ports.get(peer.id);
          if (!bpos) continue;
          gEl.append(this.cablePath(a, bpos, color, trayLane++, link));
        } else {
          // leaves the building: route to a wall plate on the right, via the ceiling conduit
          const label = peerDev.hidden ? "ISP fiber" : `${building(peerDev.buildingId).name}`;
          let plate = plateFor.get(label);
          if (!plate) {
            plate = { x: W - 40, y: 70 + plateIdx * 34 };
            plateIdx++;
            plateFor.set(label, plate);
            gEl.append(svg("rect", { x: plate.x - 14, y: plate.y - 10, width: 28, height: 22, rx: 2, fill: "#eceff1", stroke: "#90a4ae" }));
            gEl.append(svg("rect", { x: plate.x - 6, y: plate.y - 4, width: 12, height: 10, rx: 1, fill: "#263238" }));
            gEl.append(svg("text", { x: plate.x - 20, y: plate.y + 4, "text-anchor": "end", class: "plate-label" }, `to ${label} · ${link.lengthM} m ${link.medium}`));
          }
          const d1 = `M${a.x} ${a.y} C ${a.x} ${a.y - 40}, ${a.x + 20} ${CONDUIT_Y}, ${a.x + 60} ${CONDUIT_Y} L ${plate.x - 30} ${CONDUIT_Y} C ${plate.x} ${CONDUIT_Y}, ${plate.x} ${plate.y - 20}, ${plate.x} ${plate.y}`;
          gEl.append(svg("path", { d: d1, class: "cable shadow" }));
          gEl.append(svg("path", { d: d1, class: `cable ${g.net.linkIssue(link) ? "broken" : ""}`, stroke: color }));
        }
      }
    }
    return gEl;
  }

  private cablePath(a: PortPos, b: PortPos, color: string, lane: number, link: Link) {
    const g = this.game;
    let d: string;
    if (a.side === "rack" && b.side === "rack") {
      // Short patch lead inside the cabinet: bulge out past the right rail and back.
      const [p, q] = a.y < b.y ? [a, b] : [b, a];
      const bulge = RACK.x + RACK.w + 10 + (lane % 4) * 5;
      d = `M${p.x} ${p.y} C ${p.x} ${p.y + 10}, ${bulge} ${p.y + 6}, ${bulge} ${(p.y + q.y) / 2} S ${q.x} ${q.y - 10}, ${q.x} ${q.y}`;
    } else {
      // Drop from the host to the floor tray, run along the tray, climb to the rack port.
      const ty = TRAY_Y - 6 - (lane % 6) * 2.2;
      const [p, q] = a.side === "rack" ? [b, a] : [a, b];
      d = `M${p.x} ${p.y} C ${p.x} ${p.y + 30}, ${p.x} ${ty}, ${p.x - 20} ${ty} L ${q.x + 30} ${ty} C ${q.x} ${ty}, ${q.x} ${q.y + 40}, ${q.x} ${q.y}`;
    }
    const gEl = svg("g");
    gEl.append(svg("path", { d, class: "cable shadow" }));
    gEl.append(svg("path", { d, class: `cable ${g.net.linkIssue(link) ? "broken" : ""}`, stroke: color }));
    gEl.append(svg("title", {}, `${link.medium} ${link.lengthM} m`));
    return gEl;
  }
}

function rackOrder(d: Device): number {
  return { modem: 0, router: 1, switch: 2, server: 3, ups: 4 }[d.kind as "modem" | "router" | "switch" | "server" | "ups"] ?? 9;
}

function model(d: Device): string {
  switch (d.kind) {
    case "switch":
      return "HOLLOW SW-8G";
    case "router":
      return "HOLLOW RT-2";
    case "modem":
      return "PROVIDER ONT";
    case "server":
      return "HOLLOW SRV-2U";
    case "ups":
      return "HOLLOW UPS-600";
    default:
      return "";
  }
}

function cableColor(link: Link, broken: boolean): string {
  if (broken) return "#ff5252";
  return link.medium === "fiber" ? "#ffb347" : "#4fa3ff";
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * amt));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * amt));
  const b = Math.min(255, Math.round((n & 255) * amt));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
