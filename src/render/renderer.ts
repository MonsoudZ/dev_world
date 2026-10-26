// Canvas isometric renderer for Maple Hollow.
// The static ground (countryside, tiles, roads, pavements) is cached in an offscreen canvas and
// only redrawn when the camera or the light level changes. Everything that moves is drawn per frame.

import { Camera } from "./camera";
import { BUILDINGS, Building, DECORATIONS, MAP_H, MAP_W, TILES, Tile, roadPath, building } from "../world/map";
import { hash, clamp } from "../core/events";
import { Medium } from "../net/model";

export interface BuildingVisual {
  unlocked: boolean;
  online: boolean; // all needs satisfied
  alert: boolean; // an unmet need the player can act on
  powered: boolean; // has any live device
  summary: string; // one line for the hover tooltip
}

export interface CableVisual {
  id: string;
  points: { x: number; y: number }[]; // tile coords (centres added at draw)
  state: "up" | "down" | "idle";
  offset: number;
  label: string;
  medium: Medium;
}

export interface VehicleVisual {
  x: number;
  y: number;
  dx: number;
  dy: number;
  color: string;
  kind: "car" | "van";
}

export interface PacketAnim {
  id: string;
  points: { x: number; y: number }[]; // world coords
  progress: number; // distance travelled
  length: number;
  speed: number; // world units per second
  color: string;
  ok: boolean;
  failAt?: number; // distance at which it dies
  done: boolean;
  trail: { x: number; y: number }[];
  burst?: number; // time since death, for the failure burst
}

export interface PersonVisual {
  x: number;
  y: number;
  color: string;
  skin: string;
  phase: number;
}

export interface RenderState {
  time: number;
  light: number; // 0 night .. 1 day
  dayFrac: number;
  buildings: Map<string, BuildingVisual>;
  cables: CableVisual[];
  packets: PacketAnim[];
  people: PersonVisual[];
  vehicles: VehicleVisual[];
  rain: number;
  selected?: string;
  hoverBuilding?: string;
  mouse?: { x: number; y: number };
  focus?: string;
  showNetwork: boolean;
  showLabels: boolean;
  showTraffic: boolean;
  cableTargetMode: boolean;
}

const TILE_COLORS: Record<Tile, string> = {
  grass: "#6fa85a",
  road: "#4a4d55",
  water: "#3a8fd6",
  path: "#c9b58a",
  plaza: "#b9b3a6",
  dirt: "#9c7d5a",
};

const SIGNS: Partial<Record<Building["kind"], string>> = {
  workshop: "ROSA'S REPAIR",
  library: "LIBRARY",
  shop: "MARKET",
  clinic: "CLINIC",
  hall: "TOWN HALL",
};

type Pt = { x: number; y: number };

export class Renderer {
  ctx: CanvasRenderingContext2D;
  dpr = 1;
  private fiberPath: Pt[];
  private ground: HTMLCanvasElement;
  private gctx: CanvasRenderingContext2D;
  private groundKey = "";

  private pat!: Record<"noise" | "brick" | "stone" | "planks" | "siding" | "shingles" | "gravel" | "asphalt" | "slabs" | "grass", CanvasPattern>;

  constructor(public canvas: HTMLCanvasElement, public cam: Camera) {
    this.ctx = canvas.getContext("2d")!;
    const ws = building("workshop");
    this.fiberPath = roadPath({ x: 0, y: 3 }, ws.door);
    this.ground = document.createElement("canvas");
    this.gctx = this.ground.getContext("2d")!;
    this.makePatterns();
  }

  // ------------------------------------------------------------------ textures
  private makePatterns() {
    const make = (w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) => {
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const c = cv.getContext("2d")!;
      draw(c);
      return this.ctx.createPattern(cv, "repeat")!;
    };
    const noise = (c: CanvasRenderingContext2D, w: number, h: number, a: number, seed: number) => {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const v = hash(x, y, seed);
          c.fillStyle = v > 0.5 ? `rgba(255,255,255,${(v - 0.5) * a})` : `rgba(0,0,0,${(0.5 - v) * a})`;
          c.fillRect(x, y, 1, 1);
        }
    };
    this.pat = {
      noise: make(48, 48, (c) => noise(c, 48, 48, 0.22, 1)),
      grass: make(64, 64, (c) => {
        noise(c, 64, 64, 0.16, 2);
        for (let i = 0; i < 40; i++) {
          const x = hash(i, 1, 3) * 64;
          const y = hash(i, 2, 3) * 64;
          c.strokeStyle = `rgba(20,70,20,${0.25 + hash(i, 3, 3) * 0.3})`;
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x + (hash(i, 4, 3) - 0.5) * 3, y - 2 - hash(i, 5, 3) * 3);
          c.stroke();
        }
      }),
      brick: make(32, 16, (c) => {
        noise(c, 32, 16, 0.18, 4);
        c.fillStyle = "rgba(0,0,0,0.32)";
        c.fillRect(0, 7, 32, 1.5);
        c.fillRect(0, 15, 32, 1.5);
        c.fillRect(15, 0, 1.5, 8);
        c.fillRect(31, 0, 1.5, 8);
        c.fillRect(7, 8, 1.5, 8);
        c.fillRect(23, 8, 1.5, 8);
        c.fillStyle = "rgba(255,255,255,0.08)";
        c.fillRect(0, 0, 32, 1);
        c.fillRect(0, 8.5, 32, 1);
      }),
      stone: make(48, 24, (c) => {
        noise(c, 48, 24, 0.14, 5);
        c.fillStyle = "rgba(0,0,0,0.28)";
        c.fillRect(0, 11, 48, 1.5);
        c.fillRect(0, 23, 48, 1.5);
        c.fillRect(23, 0, 1.5, 12);
        c.fillRect(11, 12, 1.5, 12);
        c.fillRect(35, 12, 1.5, 12);
        c.fillStyle = "rgba(255,255,255,0.1)";
        c.fillRect(0, 0, 48, 1);
        c.fillRect(0, 12.5, 48, 1);
      }),
      planks: make(24, 32, (c) => {
        noise(c, 24, 32, 0.12, 6);
        c.fillStyle = "rgba(0,0,0,0.3)";
        for (let x = 0; x < 24; x += 8) c.fillRect(x, 0, 1.2, 32);
        c.fillStyle = "rgba(0,0,0,0.12)";
        for (let x = 0; x < 24; x += 8) c.fillRect(x + 4, 0, 0.6, 32);
      }),
      siding: make(32, 12, (c) => {
        noise(c, 32, 12, 0.08, 7);
        c.fillStyle = "rgba(0,0,0,0.28)";
        c.fillRect(0, 5, 32, 1.2);
        c.fillRect(0, 11, 32, 1.2);
        c.fillStyle = "rgba(255,255,255,0.12)";
        c.fillRect(0, 0, 32, 1);
        c.fillRect(0, 6.2, 32, 1);
      }),
      shingles: make(24, 12, (c) => {
        noise(c, 24, 12, 0.14, 8);
        c.fillStyle = "rgba(0,0,0,0.35)";
        c.fillRect(0, 5, 24, 1.4);
        c.fillRect(0, 11, 24, 1.4);
        c.fillRect(11, 0, 1, 6);
        c.fillRect(5, 6, 1, 6);
        c.fillRect(17, 6, 1, 6);
        c.fillStyle = "rgba(255,255,255,0.1)";
        c.fillRect(0, 0, 24, 1);
        c.fillRect(0, 6.4, 24, 1);
      }),
      gravel: make(32, 32, (c) => noise(c, 32, 32, 0.3, 9)),
      asphalt: make(40, 40, (c) => {
        noise(c, 40, 40, 0.2, 10);
        for (let i = 0; i < 30; i++) {
          c.fillStyle = `rgba(255,255,255,${0.04 + hash(i, 7, 11) * 0.08})`;
          c.fillRect(hash(i, 1, 11) * 40, hash(i, 2, 11) * 40, 1, 1);
        }
      }),
      slabs: make(20, 20, (c) => {
        noise(c, 20, 20, 0.1, 12);
        c.fillStyle = "rgba(0,0,0,0.2)";
        c.fillRect(0, 19, 20, 1);
        c.fillRect(19, 0, 1, 20);
      }),
    };
  }

  /**
   * Fill a parallelogram face with a texture that follows its perspective.
   * p0: screen origin, u: screen vector for one world unit along the face, v: for one unit up/across,
   * uLen/vLen: face size in those units. Pattern pixels stay roughly screen-sized.
   */
  private texturedFace(c: CanvasRenderingContext2D, p0: Pt, u: Pt, v: Pt, uLen: number, vLen: number, pattern: CanvasPattern, alpha: number, texScale = 1) {
    c.save();
    c.transform(u.x, u.y, v.x, v.y, p0.x, p0.y);
    const ul = Math.hypot(u.x, u.y) || 1;
    const vl = Math.hypot(v.x, v.y) || 1;
    pattern.setTransform(new DOMMatrix([texScale / ul, 0, 0, texScale / vl, 0, 0]));
    c.globalAlpha = alpha;
    c.fillStyle = pattern;
    c.fillRect(0, 0, uLen, vLen);
    c.restore();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.ground.width = this.canvas.width;
    this.ground.height = this.canvas.height;
    this.cam.resize(w, h);
    this.groundKey = "";
  }

  // ------------------------------------------------------------------ helpers
  private poly(c: CanvasRenderingContext2D, pts: Pt[], fill?: string | CanvasGradient | CanvasPattern, stroke?: string, lw = 1) {
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    c.closePath();
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = lw;
      c.stroke();
    }
  }

  private tilePoly(x: number, y: number, z = 0) {
    const cam = this.cam;
    return [cam.toScreen(x, y, z), cam.toScreen(x + 1, y, z), cam.toScreen(x + 1, y + 1, z), cam.toScreen(x, y + 1, z)];
  }

  private rect(x0: number, y0: number, x1: number, y1: number, z = 0) {
    const cam = this.cam;
    return [cam.toScreen(x0, y0, z), cam.toScreen(x1, y0, z), cam.toScreen(x1, y1, z), cam.toScreen(x0, y1, z)];
  }

  private shade(hex: string, amt: number): string {
    const n = parseInt(hex.slice(1), 16);
    const r = clamp(Math.round(((n >> 16) & 255) * amt), 0, 255);
    const g = clamp(Math.round(((n >> 8) & 255) * amt), 0, 255);
    const b = clamp(Math.round((n & 255) * amt), 0, 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
  }

  private nightMix(color: string, light: number): string {
    const n = parseInt(color.slice(1), 16);
    const r = (n >> 16) & 255,
      g = (n >> 8) & 255,
      b = n & 255;
    const k = 0.38 + 0.62 * light;
    const blueBump = (1 - light) * 28;
    return `rgb(${Math.round(r * k)},${Math.round(g * (k + 0.03 * (1 - light)))},${Math.round(Math.min(255, b * (k + 0.12 * (1 - light)) + blueBump))})`;
  }

  // ------------------------------------------------------------------ main
  draw(s: RenderState) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawGroundCached(s);
    this.drawWater(s);
    if (s.showNetwork) this.drawCables(s);
    this.drawEntities(s);
    if (s.showTraffic) this.drawPackets(s);
    this.drawNight(s);
    this.drawRain(s);
    this.drawVignette();
    this.drawLabels(s);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawVignette() {
    const c = this.ctx;
    const cam = this.cam;
    const g = c.createRadialGradient(cam.width / 2, cam.height / 2, Math.min(cam.width, cam.height) * 0.45, cam.width / 2, cam.height / 2, Math.max(cam.width, cam.height) * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.28)");
    c.fillStyle = g;
    c.fillRect(0, 0, cam.width, cam.height);
  }

  // ------------------------------------------------------------------ ground (cached)
  private drawGroundCached(s: RenderState) {
    const cam = this.cam;
    const bucket = Math.round(s.light * 24);
    const key = `${cam.ox.toFixed(1)}|${cam.oy.toFixed(1)}|${cam.zoom.toFixed(3)}|${bucket}|${this.ground.width}x${this.ground.height}`;
    if (key !== this.groundKey) {
      this.groundKey = key;
      this.renderGround(bucket / 24);
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.ground, 0, 0);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private renderGround(light: number) {
    const c = this.gctx;
    const cam = this.cam;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const g = c.createLinearGradient(0, 0, 0, cam.height);
    g.addColorStop(0, this.nightMix("#8fc6ee", light));
    g.addColorStop(1, this.nightMix("#d8ecf7", light));
    c.fillStyle = g;
    c.fillRect(0, 0, cam.width, cam.height);

    // countryside beyond the map
    const PAD = 9;
    for (let y = -PAD; y < MAP_H + PAD; y++) {
      for (let x = -PAD; x < MAP_W + PAD; x++) {
        if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) continue;
        const d = Math.max(x < 0 ? -x : x >= MAP_W ? x - MAP_W + 1 : 0, y < 0 ? -y : y >= MAP_H ? y - MAP_H + 1 : 0);
        const v = hash(x + 100, y + 100, 5);
        const field = v > 0.82 ? "#c9b45e" : v > 0.7 ? "#7fb366" : "#6aa157";
        this.poly(c, this.tilePoly(x, y), this.nightMix(this.shade(field, 0.95 - d * 0.035 + v * 0.06), light));
        if (d < 6) {
          const o = cam.toScreen(x, y);
          const ux = { x: cam.toScreen(x + 1, y).x - o.x, y: cam.toScreen(x + 1, y).y - o.y };
          const vy = { x: cam.toScreen(x, y + 1).x - o.x, y: cam.toScreen(x, y + 1).y - o.y };
          this.texturedFace(c, o, ux, vy, 1, 1, v > 0.82 ? this.pat.noise : this.pat.grass, Math.max(0.1, 0.5 - d * 0.07));
        }
        if (v > 0.93 && d < 6) {
          const p = cam.toScreen(x + 0.5, y + 0.5);
          c.fillStyle = this.nightMix("#3f8f3a", light);
          c.beginPath();
          c.arc(p.x, p.y - 8 * cam.zoom, 7 * cam.zoom, 0, Math.PI * 2);
          c.fill();
        }
      }
    }
    // town tiles
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const t = TILES[y][x];
        const pts = this.tilePoly(x, y);
        let col = TILE_COLORS[t];
        if (t === "grass") col = this.shade(col, 0.92 + hash(x, y, 7) * 0.16);
        else if (t === "plaza") col = this.shade(col, 0.96 + hash(x, y, 3) * 0.08);
        else if (t === "water") col = this.shade(col, 0.9);
        this.poly(c, pts, this.nightMix(col, light));
        if (t === "road" || t === "grass" || t === "plaza") {
          const o = cam.toScreen(x, y);
          const ux = { x: cam.toScreen(x + 1, y).x - o.x, y: cam.toScreen(x + 1, y).y - o.y };
          const vy = { x: cam.toScreen(x, y + 1).x - o.x, y: cam.toScreen(x, y + 1).y - o.y };
          this.texturedFace(c, o, ux, vy, 1, 1, t === "road" ? this.pat.asphalt : t === "grass" ? this.pat.grass : this.pat.slabs, t === "road" ? 0.9 : t === "grass" ? 0.55 : 0.7, t === "plaza" ? 0.5 : 1);
        }
        if (t === "road") this.drawRoadMarkings(c, x, y, light);
        if (t === "plaza") this.poly(c, pts, undefined, "rgba(0,0,0,0.08)", 1);
        if (t === "grass" && hash(x, y, 11) > 0.72) {
          const p = cam.toScreen(x + 0.3 + hash(x, y, 12) * 0.4, y + 0.3 + hash(x, y, 13) * 0.4);
          c.fillStyle = "rgba(40,90,30,0.35)";
          c.beginPath();
          c.ellipse(p.x, p.y, 3 * cam.zoom, 1.5 * cam.zoom, 0, 0, Math.PI * 2);
          c.fill();
        }
      }
    }
    // pavements around lots and a path to each door
    for (const b of BUILDINGS) {
      const { x, y, w, h } = b.lot;
      const pave = this.nightMix("#c8c2b4", light);
      this.poly(c, this.rect(x - 0.3, y - 0.3, x + w + 0.3, y + h + 0.3), pave, "rgba(0,0,0,0.12)");
      {
        const o = cam.toScreen(x - 0.3, y - 0.3);
        const ux = { x: cam.toScreen(x + 0.7, y - 0.3).x - o.x, y: cam.toScreen(x + 0.7, y - 0.3).y - o.y };
        const vy = { x: cam.toScreen(x - 0.3, y + 0.7).x - o.x, y: cam.toScreen(x - 0.3, y + 0.7).y - o.y };
        this.texturedFace(c, o, ux, vy, w + 0.6, h + 0.6, this.pat.slabs, 0.6, 0.5);
      }
      const dx = b.door.x + 0.5;
      const dy = b.door.y + 0.5;
      const cx = clamp(dx, x + 0.3, x + w - 0.3);
      const cy = clamp(dy, y + 0.3, y + h - 0.3);
      this.poly(c, this.rect(Math.min(dx, cx) - 0.18, Math.min(dy, cy) - 0.18, Math.max(dx, cx) + 0.18, Math.max(dy, cy) + 0.18), this.nightMix("#d6cfbf", light));
    }
  }

  private drawRoadMarkings(c: CanvasRenderingContext2D, x: number, y: number, light: number) {
    const cam = this.cam;
    const nb = (dx: number, dy: number) => (TILES[y + dy]?.[x + dx] ?? null) === "road";
    const h = nb(1, 0) || nb(-1, 0);
    const v = nb(0, 1) || nb(0, -1);
    const junction = (nb(0, 1) || nb(0, -1)) && (nb(1, 0) || nb(-1, 0));
    c.strokeStyle = `rgba(230,220,160,${0.35 + 0.3 * light})`;
    c.lineWidth = Math.max(1, 1.2 * cam.zoom);
    c.setLineDash([6 * cam.zoom, 6 * cam.zoom]);
    if (h && !junction) {
      const a = cam.toScreen(x, y + 0.5);
      const b = cam.toScreen(x + 1, y + 0.5);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
    }
    if (v && !junction) {
      const a = cam.toScreen(x + 0.5, y);
      const b = cam.toScreen(x + 0.5, y + 1);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
    }
    c.setLineDash([]);
    // kerbs on open edges
    c.strokeStyle = `rgba(255,255,255,${0.14 + 0.1 * light})`;
    c.lineWidth = Math.max(1, 1.5 * cam.zoom);
    const pts = this.tilePoly(x, y);
    const edges: [number, number, boolean][] = [
      [0, 1, !nb(0, -1)],
      [1, 2, !nb(1, 0)],
      [2, 3, !nb(0, 1)],
      [3, 0, !nb(-1, 0)],
    ];
    for (const [a, b, open] of edges) {
      if (!open) continue;
      c.beginPath();
      c.moveTo(pts[a].x, pts[a].y);
      c.lineTo(pts[b].x, pts[b].y);
      c.stroke();
    }
    if (junction && cam.zoom > 0.9) {
      const stripe = `rgba(255,255,255,${0.12 + 0.1 * light})`;
      for (let i = 0; i < 3; i++) {
        const u = 0.2 + i * 0.25;
        this.poly(c, this.rect(x + u, y + 0.05, x + u + 0.12, y + 0.2), stripe);
        this.poly(c, this.rect(x + u, y + 0.8, x + u + 0.12, y + 0.95), stripe);
      }
    }
  }

  private drawWater(s: RenderState) {
    const c = this.ctx;
    const cam = this.cam;
    for (let y = 0; y < MAP_H; y++)
      for (let x = 0; x < MAP_W; x++) {
        if (TILES[y][x] !== "water") continue;
        const w = Math.sin(s.time * 1.6 + x * 0.9 + y * 1.3) * 0.5 + 0.5;
        this.poly(c, this.tilePoly(x, y), this.nightMix(this.shade("#3a8fd6", 0.9 + w * 0.2), s.light));
        c.lineWidth = 1;
        for (let i = 0; i < 2; i++) {
          const ph = (s.time * 0.4 + i * 0.5 + hash(x, y, i)) % 1;
          const p = cam.toScreen(x + 0.5, y + 0.5);
          c.strokeStyle = `rgba(255,255,255,${(0.15 + 0.15 * w) * (1 - ph)})`;
          c.beginPath();
          c.ellipse(p.x, p.y, (6 + ph * 18) * cam.zoom, (3 + ph * 9) * cam.zoom, 0, 0, Math.PI * 2);
          c.stroke();
        }
      }
  }

  // ------------------------------------------------------------------ cables
  private drawCables(s: RenderState) {
    const c = this.ctx;
    const cam = this.cam;
    c.lineCap = "round";
    c.lineJoin = "round";
    const fiber = this.fiberPath.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
    this.strokePath(fiber, "rgba(0,0,0,0.3)", 4 * cam.zoom, undefined, -0.3);
    this.strokePath(fiber, "rgba(255,150,40,0.9)", 2.2 * cam.zoom, [8 * cam.zoom, 5 * cam.zoom], -0.3);
    // Shared poles: every few tiles along the roads that carry cables.
    const poleAt = new Map<string, Pt>();
    for (const cab of s.cables) {
      for (let i = 0; i < cab.points.length; i += 3) {
        const p = cab.points[i];
        const key = `${p.x},${p.y}`;
        if (!poleAt.has(key)) poleAt.set(key, { x: p.x + 0.5 + 0.34, y: p.y + 0.5 + 0.34 });
      }
    }
    const POLE_H = 36;
    for (const cab of s.cables) {
      const upColor = cab.medium === "fiber" ? "rgba(255,190,70,0.95)" : "rgba(60,230,170,0.95)";
      const color = cab.state === "up" ? upColor : cab.state === "down" ? "rgba(255,80,80,0.95)" : "rgba(200,200,210,0.8)";
      const pts = cab.points.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
      // Aerial run: from the first pole to the last, sagging between poles.
      const anchors: Pt[] = [];
      for (let i = 0; i < cab.points.length; i += 3) anchors.push(poleAt.get(`${cab.points[i].x},${cab.points[i].y}`)!);
      const last = cab.points[cab.points.length - 1];
      const lastKey = `${last.x},${last.y}`;
      if (!poleAt.has(lastKey)) poleAt.set(lastKey, { x: last.x + 0.5 + 0.34, y: last.y + 0.5 + 0.34 });
      if (anchors[anchors.length - 1] !== poleAt.get(lastKey)) anchors.push(poleAt.get(lastKey)!);
      c.strokeStyle = color;
      c.lineWidth = Math.max(1, 1.6 * cam.zoom);
      c.setLineDash(cab.state === "down" ? [4 * cam.zoom, 4 * cam.zoom] : []);
      const lane = cab.offset * 1.2;
      for (let i = 1; i < anchors.length; i++) {
        const a = cam.toScreen(anchors[i - 1].x, anchors[i - 1].y, POLE_H - 4 + lane);
        const b = cam.toScreen(anchors[i].x, anchors[i].y, POLE_H - 4 + lane);
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.quadraticCurveTo((a.x + b.x) / 2, (a.y + b.y) / 2 + 7 * cam.zoom, b.x, b.y);
        c.stroke();
      }
      c.setLineDash([]);
      // drops from the end poles down to the buildings' wall boxes
      for (const end of [pts[0], pts[pts.length - 1]]) {
        const pole = poleAt.get(`${end.x - 0.5},${end.y - 0.5}`)!;
        const top = cam.toScreen(pole.x, pole.y, POLE_H - 4 + lane);
        const box = cam.toScreen(end.x + cab.offset * 0.3, end.y - 0.25 + cab.offset * 0.3, 8);
        c.strokeStyle = color;
        c.lineWidth = Math.max(1, 1.4 * cam.zoom);
        c.beginPath();
        c.moveTo(top.x, top.y);
        c.quadraticCurveTo(top.x, box.y, box.x, box.y);
        c.stroke();
        c.fillStyle = "#1b2130";
        c.fillRect(box.x - 3 * cam.zoom, box.y - 3 * cam.zoom, 6 * cam.zoom, 6 * cam.zoom);
        c.fillStyle = color;
        c.fillRect(box.x - 1.5 * cam.zoom, box.y - 1.5 * cam.zoom, 3 * cam.zoom, 3 * cam.zoom);
      }
      if (cab.state === "down") {
        const mid = pointAlong(pts, pathLength(pts) / 2)!;
        const mp = cam.toScreen(mid.x + cab.offset * 0.3, mid.y + cab.offset * 0.3);
        for (let i = 0; i < 4; i++) {
          const ph = (s.time * 3 + i * 0.37) % 1;
          const ang = hash(i, Math.floor(s.time * 3), 4) * Math.PI * 2;
          c.fillStyle = `rgba(255,${200 - ph * 120},60,${1 - ph})`;
          c.beginPath();
          c.arc(mp.x + Math.cos(ang) * ph * 10 * cam.zoom, mp.y - 4 * cam.zoom - ph * 12 * cam.zoom, (2 - ph) * cam.zoom, 0, Math.PI * 2);
          c.fill();
        }
        c.font = `bold ${10 * cam.zoom}px Inter, sans-serif`;
        c.textAlign = "center";
        c.fillStyle = "#ff6b6b";
        c.fillText("NO LINK", mp.x, mp.y - 16 * cam.zoom);
      }
    }
    for (const pole of poleAt.values()) {
      const base = cam.toScreen(pole.x, pole.y);
      const top = cam.toScreen(pole.x, pole.y, POLE_H);
      c.fillStyle = "rgba(0,0,0,0.2)";
      c.beginPath();
      c.ellipse(base.x + 2 * cam.zoom, base.y + 1, 5 * cam.zoom, 2.5 * cam.zoom, 0, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = this.nightMix("#6d4c41", s.light);
      c.lineWidth = Math.max(1.5, 2.6 * cam.zoom);
      c.beginPath();
      c.moveTo(base.x, base.y);
      c.lineTo(top.x, top.y);
      c.stroke();
      c.lineWidth = Math.max(1, 1.6 * cam.zoom);
      c.beginPath();
      c.moveTo(top.x - 7 * cam.zoom, top.y + 4 * cam.zoom);
      c.lineTo(top.x + 7 * cam.zoom, top.y + 4 * cam.zoom);
      c.stroke();
    }
  }

  private strokePath(pts: Pt[], color: string, lw: number, dash?: number[], offset = 0) {
    const c = this.ctx;
    const cam = this.cam;
    if (pts.length < 2) return;
    c.strokeStyle = color;
    c.lineWidth = lw;
    c.setLineDash(dash ?? []);
    c.beginPath();
    pts.forEach((p, i) => {
      const sp = cam.toScreen(p.x + offset * 0.3, p.y + offset * 0.3);
      if (i === 0) c.moveTo(sp.x, sp.y);
      else c.lineTo(sp.x, sp.y);
    });
    c.stroke();
    c.setLineDash([]);
  }

  // ------------------------------------------------------------------ entities
  private drawEntities(s: RenderState) {
    type Ent = { key: number; draw: () => void };
    const ents: Ent[] = [];
    for (const b of BUILDINGS) {
      const key = b.lot.x + b.lot.w + b.lot.y + b.lot.h - 1;
      ents.push({ key, draw: () => this.drawBuilding(b, s) });
    }
    for (const d of DECORATIONS) ents.push({ key: d.x + d.y + 1.2, draw: () => this.drawDecoration(d.kind, d.x, d.y, s) });
    for (const p of s.people) ents.push({ key: p.x + p.y + 0.6, draw: () => this.drawPerson(p, s) });
    for (const v of s.vehicles) ents.push({ key: v.x + v.y + 0.5, draw: () => this.drawVehicle(v, s) });
    ents.sort((a, b) => a.key - b.key);
    for (const e of ents) e.draw();
  }

  private drawBuilding(b: Building, s: RenderState) {
    const c = this.ctx;
    const cam = this.cam;
    const z = cam.zoom;
    const vis = s.buildings.get(b.id) ?? { unlocked: !b.locked, online: false, alert: false, powered: false, summary: "" };
    const { x: x0, y: y0 } = b.lot;
    const x1 = x0 + b.lot.w;
    const y1 = y0 + b.lot.h;
    const h = b.height;
    const light = s.light;
    const mix = (col: string) => this.nightMix(col, light);
    c.globalAlpha = vis.unlocked ? 1 : 0.6;

    if (s.selected === b.id || s.focus === b.id || s.hoverBuilding === b.id) {
      const pulse = 0.5 + 0.5 * Math.sin(s.time * 4);
      const ring = this.rect(x0 - 0.35, y0 - 0.35, x1 + 0.35, y1 + 0.35);
      const col = s.focus === b.id ? `rgba(255,210,80,${0.5 + 0.4 * pulse})` : s.selected === b.id ? "rgba(90,200,255,0.9)" : "rgba(255,255,255,0.55)";
      this.poly(c, ring, s.cableTargetMode && s.hoverBuilding === b.id ? "rgba(90,200,255,0.18)" : undefined, col, (s.focus === b.id ? 3 : 2) * z);
    }

    // Sun-cast shadow: short at midday, long and soft toward evening, thrown to the south-east.
    const sunLen = (0.3 + 0.9 * (1 - light)) * (h / 40);
    const sh = [cam.toScreen(x0, y0), cam.toScreen(x1, y0), cam.toScreen(x1 + sunLen, y0 + sunLen * 0.6), cam.toScreen(x1 + sunLen, y1 + sunLen), cam.toScreen(x0 + sunLen * 0.6, y1 + sunLen), cam.toScreen(x0, y1)];
    this.poly(c, sh, `rgba(10,12,30,${0.16 + 0.14 * light})`);

    const base = vis.unlocked ? b.color : "#9a9a9a";
    const right = [cam.toScreen(x1, y0), cam.toScreen(x1, y1), cam.toScreen(x1, y1, h), cam.toScreen(x1, y0, h)];
    const left = [cam.toScreen(x0, y1), cam.toScreen(x1, y1), cam.toScreen(x1, y1, h), cam.toScreen(x0, y1, h)];
    this.poly(c, left, mix(base));
    this.poly(c, right, mix(this.shade(base, 0.72)));
    // wall material following each face's perspective
    const wallPat = b.kind === "workshop" ? this.pat.brick : b.kind === "library" || b.kind === "hall" ? this.pat.stone : b.kind === "shop" ? this.pat.planks : b.kind === "house" ? this.pat.siding : this.pat.noise;
    const vz = { x: 0, y: -z };
    const s0 = cam.toScreen(x0, y1, 0);
    const su = { x: cam.toScreen(x0 + 1, y1, 0).x - s0.x, y: cam.toScreen(x0 + 1, y1, 0).y - s0.y };
    this.texturedFace(c, s0, su, vz, b.lot.w, h, wallPat, 0.9);
    const e0 = cam.toScreen(x1, y0, 0);
    const eu = { x: cam.toScreen(x1, y0 + 1, 0).x - e0.x, y: cam.toScreen(x1, y0 + 1, 0).y - e0.y };
    this.texturedFace(c, e0, eu, vz, b.lot.h, h, wallPat, 0.9);
    // ambient occlusion at the base and a lit edge on the corner
    const aoS = c.createLinearGradient(0, cam.toScreen(x0, y1, 0).y, 0, cam.toScreen(x0, y1, 12).y);
    aoS.addColorStop(0, "rgba(0,0,0,0.35)");
    aoS.addColorStop(1, "rgba(0,0,0,0)");
    this.poly(c, [cam.toScreen(x0, y1), cam.toScreen(x1, y1), cam.toScreen(x1, y1, 12), cam.toScreen(x0, y1, 12)], aoS);
    this.poly(c, [cam.toScreen(x1, y0), cam.toScreen(x1, y1), cam.toScreen(x1, y1, 12), cam.toScreen(x1, y0, 12)], aoS);
    c.strokeStyle = "rgba(0,0,0,0.25)";
    c.lineWidth = 1;
    this.poly(c, left, undefined, "rgba(0,0,0,0.25)");
    this.poly(c, right, undefined, "rgba(0,0,0,0.3)");
    {
      const k0 = cam.toScreen(x1, y1, 0);
      const k1 = cam.toScreen(x1, y1, h);
      c.strokeStyle = `rgba(255,255,255,${0.18 * light})`;
      c.lineWidth = Math.max(1, 1.2 * z);
      c.beginPath();
      c.moveTo(k0.x, k0.y);
      c.lineTo(k1.x, k1.y);
      c.stroke();
    }

    const lit = vis.powered || vis.online;
    this.drawWindows(b, "south", lit, s);
    this.drawWindows(b, "east", lit, s);
    const doorFace = b.door.y >= y1 ? "south" : b.door.y < y0 ? "north" : b.door.x >= x1 ? "east" : "west";
    this.drawDoor(b, doorFace, s);
    this.drawKindDetails(b, vis, s);

    const top = this.rect(x0, y0, x1, y1, h);
    const roofCol = vis.unlocked ? b.roof : "#7a7a7a";
    if (b.kind === "house") {
      const ridgeH = h + 16;
      const alongX = b.lot.w >= b.lot.h;
      const r0 = alongX ? cam.toScreen(x0 - 0.1, (y0 + y1) / 2, ridgeH) : cam.toScreen((x0 + x1) / 2, y0 - 0.1, ridgeH);
      const r1 = alongX ? cam.toScreen(x1 + 0.1, (y0 + y1) / 2, ridgeH) : cam.toScreen((x0 + x1) / 2, y1 + 0.1, ridgeH);
      const slopes: Pt[][] = alongX ? [[top[0], top[1], r1, r0], [top[3], top[2], r1, r0]] : [[top[0], top[3], r1, r0], [top[1], top[2], r1, r0]];
      slopes.forEach((sl, i) => {
        this.poly(c, sl, mix(this.shade(roofCol, i === 0 ? 0.85 : 1)), "rgba(0,0,0,0.25)");
        const u = { x: sl[1].x - sl[0].x, y: sl[1].y - sl[0].y };
        const v = { x: sl[3].x - sl[0].x, y: sl[3].y - sl[0].y };
        this.texturedFace(c, sl[0], u, v, 1, 1, this.pat.shingles, 0.85, 1);
      });
      this.poly(c, alongX ? [top[1], top[2], r1] : [top[3], top[2], r1], mix(this.shade(base, 0.8)), "rgba(0,0,0,0.2)");
      // ridge cap
      c.strokeStyle = mix(this.shade(roofCol, 0.6));
      c.lineWidth = Math.max(1, 2 * z);
      c.beginPath();
      c.moveTo(r0.x, r0.y);
      c.lineTo(r1.x, r1.y);
      c.stroke();
      const chx = x0 + 0.35;
      const chy = y0 + 0.35;
      this.box(chx, chy, 0.25, 0.25, h + 6, 16, mix("#8d6e63"), mix("#6d4c41"), mix("#5d4037"));
      if (lit && light < 0.6) {
        for (let i = 0; i < 3; i++) {
          const ph = (s.time * 0.25 + i * 0.33 + hash(x0, y0, i)) % 1;
          const p = cam.toScreen(chx + 0.12, chy + 0.12, h + 24 + ph * 30);
          c.fillStyle = `rgba(220,220,230,${(1 - ph) * 0.5})`;
          c.beginPath();
          c.arc(p.x + Math.sin(ph * 6) * 3 * z, p.y, (3 + ph * 6) * z, 0, Math.PI * 2);
          c.fill();
        }
      }
    } else {
      this.poly(c, top, mix(roofCol), "rgba(0,0,0,0.25)");
      this.poly(c, this.rect(x0 + 0.18, y0 + 0.18, x1 - 0.18, y1 - 0.18, h), mix(this.shade(roofCol, 1.12)));
      {
        const o = cam.toScreen(x0 + 0.18, y0 + 0.18, h);
        const u = { x: cam.toScreen(x0 + 1.18, y0 + 0.18, h).x - o.x, y: cam.toScreen(x0 + 1.18, y0 + 0.18, h).y - o.y };
        const v = { x: cam.toScreen(x0 + 0.18, y0 + 1.18, h).x - o.x, y: cam.toScreen(x0 + 0.18, y0 + 1.18, h).y - o.y };
        this.texturedFace(c, o, u, v, b.lot.w - 0.36, b.lot.h - 0.36, this.pat.gravel, 0.7);
      }
      // parapet highlight on the sunlit edges
      c.strokeStyle = `rgba(255,255,255,${0.25 * light})`;
      c.lineWidth = Math.max(1, 1.2 * z);
      c.beginPath();
      c.moveTo(top[3].x, top[3].y);
      c.lineTo(top[0].x, top[0].y);
      c.lineTo(top[1].x, top[1].y);
      c.stroke();
      if (b.kind === "workshop" || b.kind === "clinic" || b.kind === "library" || b.kind === "hall") {
        this.box(x1 - 0.8, y0 + 0.3, 0.45, 0.35, h, 10, mix("#cfd8dc"), mix("#90a4ae"), mix("#78909c"));
      }
      if (b.kind === "workshop") {
        const m0 = cam.toScreen(x0 + 0.4, y0 + 0.4, h);
        const m1 = cam.toScreen(x0 + 0.4, y0 + 0.4, h + 34);
        c.strokeStyle = mix("#b0bec5");
        c.lineWidth = 2 * z;
        c.beginPath();
        c.moveTo(m0.x, m0.y);
        c.lineTo(m1.x, m1.y);
        c.stroke();
        c.fillStyle = Math.sin(s.time * 3) > 0.6 ? "#ff5252" : "#7f1d1d";
        c.beginPath();
        c.arc(m1.x, m1.y, 2.5 * z, 0, Math.PI * 2);
        c.fill();
      }
      if (b.kind === "library") {
        for (let i = 0; i < 3; i++) this.poly(c, this.rect(x0 + 0.9 + i * 0.85, y0 + 0.9, x0 + 1.5 + i * 0.85, y1 - 0.9, h + 1), mix("#a9cde8"), "rgba(0,0,0,0.3)");
      }
      if (b.kind === "hall") {
        const f0 = cam.toScreen((x0 + x1) / 2, (y0 + y1) / 2, h);
        const f1 = cam.toScreen((x0 + x1) / 2, (y0 + y1) / 2, h + 40);
        c.strokeStyle = mix("#eceff1");
        c.lineWidth = 2 * z;
        c.beginPath();
        c.moveTo(f0.x, f0.y);
        c.lineTo(f1.x, f1.y);
        c.stroke();
        const wave = Math.sin(s.time * 4) * 2 * z;
        this.poly(c, [f1, { x: f1.x + 16 * z, y: f1.y + 4 * z + wave }, { x: f1.x, y: f1.y + 10 * z }], mix("#3f51b5"));
      }
      if (b.kind === "shop") {
        for (let i = 0; i < b.lot.w * 2; i++) {
          const u0 = x0 + i / 2;
          const u1 = x0 + (i + 1) / 2;
          const z0 = h - 14;
          const aw = [cam.toScreen(u0, y1, z0), cam.toScreen(u1, y1, z0), cam.toScreen(u1, y1 + 0.4, z0 - 7), cam.toScreen(u0, y1 + 0.4, z0 - 7)];
          this.poly(c, aw, mix(i % 2 ? "#f6f1d1" : "#d9534f"), "rgba(0,0,0,0.15)");
        }
      }
    }

    const topC = cam.toScreen((x0 + x1) / 2, (y0 + y1) / 2, h + (b.kind === "house" ? 22 : 8));
    if (!vis.unlocked) {
      c.globalAlpha = 0.9;
      c.font = `${14 * z}px sans-serif`;
      c.textAlign = "center";
      c.fillText("🔒", topC.x, topC.y - 6 * z);
    } else if (vis.alert) {
      const bob = Math.sin(s.time * 3 + b.lot.x) * 3 * z;
      const by = topC.y - 16 * z + bob;
      c.fillStyle = "#ffcc33";
      c.beginPath();
      c.arc(topC.x, by, 8 * z, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.moveTo(topC.x - 4 * z, by + 6 * z);
      c.lineTo(topC.x + 4 * z, by + 6 * z);
      c.lineTo(topC.x, by + 12 * z);
      c.fill();
      c.fillStyle = "#3b2b00";
      c.font = `bold ${11 * z}px Inter, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("!", topC.x, by + 0.5 * z);
      c.textBaseline = "alphabetic";
    } else if (vis.online) {
      const pulse = 0.6 + 0.4 * Math.sin(s.time * 2.5 + b.lot.y);
      c.fillStyle = `rgba(60,230,170,${pulse})`;
      c.beginPath();
      c.arc(topC.x, topC.y - 10 * z, 4 * z, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = `rgba(60,230,170,${pulse * 0.8})`;
      c.lineWidth = 1.5 * z;
      for (let r = 1; r <= 2; r++) {
        c.beginPath();
        c.arc(topC.x, topC.y - 10 * z, (4 + r * 4) * z, -Math.PI * 0.8, -Math.PI * 0.2);
        c.stroke();
      }
    }
    c.globalAlpha = 1;
  }

  /** A small axis-aligned box standing on z0 with height hh. */
  private box(x: number, y: number, w: number, d: number, z0: number, hh: number, topCol: string, leftCol: string, rightCol: string) {
    const cam = this.cam;
    const c = this.ctx;
    const x1 = x + w;
    const y1 = y + d;
    this.poly(c, [cam.toScreen(x, y1, z0), cam.toScreen(x1, y1, z0), cam.toScreen(x1, y1, z0 + hh), cam.toScreen(x, y1, z0 + hh)], leftCol);
    this.poly(c, [cam.toScreen(x1, y, z0), cam.toScreen(x1, y1, z0), cam.toScreen(x1, y1, z0 + hh), cam.toScreen(x1, y, z0 + hh)], rightCol);
    this.poly(c, this.rect(x, y, x1, y1, z0 + hh), topCol, "rgba(0,0,0,0.2)");
  }

  private drawKindDetails(b: Building, vis: BuildingVisual, s: RenderState) {
    const c = this.ctx;
    const cam = this.cam;
    const z = cam.zoom;
    const mix = (col: string) => this.nightMix(col, s.light);
    const { x: x0, y: y0 } = b.lot;
    const x1 = x0 + b.lot.w;
    const y1 = y0 + b.lot.h;
    const h = b.height;
    const mx = (x0 + x1) / 2;
    switch (b.kind) {
      case "workshop": {
        const gy0 = y0 + 0.5;
        const gy1 = y1 - 0.5;
        this.poly(c, [cam.toScreen(x1, gy0, 0), cam.toScreen(x1, gy1, 0), cam.toScreen(x1, gy1, 22), cam.toScreen(x1, gy0, 22)], mix("#8d8d8d"), "rgba(0,0,0,0.3)");
        c.strokeStyle = "rgba(0,0,0,0.25)";
        c.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          const a = cam.toScreen(x1, gy0, i * 5.5);
          const bb = cam.toScreen(x1, gy1, i * 5.5);
          c.beginPath();
          c.moveTo(a.x, a.y);
          c.lineTo(bb.x, bb.y);
          c.stroke();
        }
        break;
      }
      case "library":
      case "hall": {
        const n = b.kind === "library" ? 5 : 4;
        for (let i = 0; i < n; i++) {
          const u = x0 + 0.3 + (i * (b.lot.w - 0.6)) / (n - 1);
          this.box(u - 0.07, y1 + 0.02, 0.14, 0.12, 0, h - 8, mix("#f5f0e6"), mix("#e0d9cc"), mix("#cfc6b6"));
        }
        for (let k = 0; k < 2; k++) this.poly(c, this.rect(x0 + 0.3, y1 + 0.15 + k * 0.1, x1 - 0.3, y1 + 0.25 + k * 0.1, 0), mix(k ? "#d9d2c3" : "#cbc3b2"), "rgba(0,0,0,0.15)");
        break;
      }
      case "clinic": {
        const cz = h - 12;
        const cw = 0.18;
        const red = vis.unlocked ? "#e53935" : "#9a9a9a";
        this.poly(c, [cam.toScreen(mx - cw, y1, cz - 8), cam.toScreen(mx + cw, y1, cz - 8), cam.toScreen(mx + cw, y1, cz - 2), cam.toScreen(mx - cw, y1, cz - 2)], red);
        this.poly(c, [cam.toScreen(mx - 0.06, y1, cz - 14), cam.toScreen(mx + 0.06, y1, cz - 14), cam.toScreen(mx + 0.06, y1, cz + 4), cam.toScreen(mx - 0.06, y1, cz + 4)], red);
        break;
      }
      case "shop": {
        this.box(x0 + 0.15, y1 + 0.05, 0.3, 0.3, 0, 8, mix("#c8a165"), mix("#a67c45"), mix("#8d6a3a"));
        this.box(x0 + 0.5, y1 + 0.1, 0.25, 0.25, 0, 6, mix("#c8a165"), mix("#a67c45"), mix("#8d6a3a"));
        break;
      }
      case "house": {
        for (let i = 0; i < 5; i++) {
          const p = cam.toScreen(x0 + 0.15 + i * ((b.lot.w - 0.3) / 4), y1 + 0.18);
          c.fillStyle = ["#ff7ab6", "#ffd54f", "#ff8a65", "#ffffff", "#ba68c8"][i % 5];
          c.beginPath();
          c.arc(p.x, p.y - 2 * z, 2 * z, 0, Math.PI * 2);
          c.fill();
        }
        break;
      }
      default:
        break;
    }
    const sign = SIGNS[b.kind];
    if (sign && z > 0.75) {
      const sp = cam.toScreen(mx, y1, h - 4);
      const fs = Math.max(7, 8 * z);
      c.font = `700 ${fs}px Inter, sans-serif`;
      const w = c.measureText(sign).width + 10 * z;
      c.fillStyle = mix(b.trim);
      c.strokeStyle = "rgba(0,0,0,0.35)";
      c.lineWidth = 1;
      c.beginPath();
      c.roundRect(sp.x - w / 2, sp.y - 7 * z, w, 11 * z, 2 * z);
      c.fill();
      c.stroke();
      c.fillStyle = "#2b2b2b";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(sign, sp.x, sp.y - 1.5 * z);
      c.textBaseline = "alphabetic";
      if (vis.online && s.light < 0.5) {
        const g = c.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, w);
        g.addColorStop(0, "rgba(255,240,180,0.35)");
        g.addColorStop(1, "rgba(255,240,180,0)");
        c.fillStyle = g;
        c.fillRect(sp.x - w, sp.y - w, w * 2, w * 2);
      }
    }
  }

  private drawWindows(b: Building, face: "south" | "east", lit: boolean, s: RenderState) {
    const cam = this.cam;
    const c = this.ctx;
    const { x: x0, y: y0 } = b.lot;
    const x1 = x0 + b.lot.w;
    const y1 = y0 + b.lot.h;
    const h = b.height;
    const rows = Math.max(1, Math.floor((h - 12) / 16));
    const len = face === "south" ? b.lot.w : b.lot.h;
    const cols = len * 2;
    const night = 1 - s.light;
    for (let r = 0; r < rows; r++) {
      const z0 = h - 10 - r * 16 - 9;
      const z1 = z0 + 9;
      if (z0 < 6) continue;
      for (let i = 0; i < cols; i++) {
        const u0 = (i + 0.3) / cols;
        const u1 = (i + 0.75) / cols;
        const seed = hash(b.lot.x * 10 + i, r, face === "south" ? 1 : 2);
        if (face === "south" && Math.abs((i + 0.5) / cols - 0.5) < 0.12 && r === rows - 1) continue;
        if (face === "south" && b.kind === "shop" && r === rows - 1) continue;
        if (face === "east" && b.kind === "workshop" && r === rows - 1) continue;
        const pts =
          face === "south"
            ? [cam.toScreen(x0 + u0 * len, y1, z0), cam.toScreen(x0 + u1 * len, y1, z0), cam.toScreen(x0 + u1 * len, y1, z1), cam.toScreen(x0 + u0 * len, y1, z1)]
            : [cam.toScreen(x1, y0 + u0 * len, z0), cam.toScreen(x1, y0 + u1 * len, z0), cam.toScreen(x1, y0 + u1 * len, z1), cam.toScreen(x1, y0 + u0 * len, z1)];
        const isLit = lit && night > 0.25 && seed > 0.25;
        const warm = `rgba(255,${200 + Math.round(seed * 40)},120,${0.75 + 0.25 * night})`;
        const glass = `rgba(${Math.round(120 + 60 * s.light)},${Math.round(160 + 50 * s.light)},${Math.round(200 + 30 * s.light)},0.9)`;
        // recess shadow, frame, glass, sill
        const frame = this.nightMix(b.trim, s.light);
        this.poly(c, pts.map((p) => ({ x: p.x + 1, y: p.y + 1 })), "rgba(0,0,0,0.3)");
        this.poly(c, pts, frame);
        const inset = pts.map((p, k) => ({ x: p.x + (k === 0 || k === 3 ? 1.2 : -1.2) * cam.zoom, y: p.y + (k < 2 ? 1.2 : -1.2) * cam.zoom }));
        this.poly(c, inset, isLit ? warm : glass);
        if (!isLit) {
          // glass reflection and mullion
          c.strokeStyle = "rgba(255,255,255,0.35)";
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(inset[3].x, inset[3].y);
          c.lineTo(inset[0].x, inset[0].y);
          c.stroke();
        }
        if (cam.zoom > 0.9) {
          c.strokeStyle = frame;
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo((inset[0].x + inset[3].x) / 2, (inset[0].y + inset[3].y) / 2);
          c.lineTo((inset[1].x + inset[2].x) / 2, (inset[1].y + inset[2].y) / 2);
          c.stroke();
        }
        // sill
        const sillA = face === "south" ? cam.toScreen(x0 + u0 * len - 0.02, y1 + 0.03, z0 - 1) : cam.toScreen(x1 + 0.03, y0 + u0 * len - 0.02, z0 - 1);
        const sillB = face === "south" ? cam.toScreen(x0 + u1 * len + 0.02, y1 + 0.03, z0 - 1) : cam.toScreen(x1 + 0.03, y0 + u1 * len + 0.02, z0 - 1);
        c.strokeStyle = frame;
        c.lineWidth = Math.max(1, 1.6 * cam.zoom);
        c.beginPath();
        c.moveTo(sillA.x, sillA.y);
        c.lineTo(sillB.x, sillB.y);
        c.stroke();
        if (isLit && cam.zoom > 0.8) {
          const cx = pts.reduce((a, p) => a + p.x, 0) / 4;
          const cy = pts.reduce((a, p) => a + p.y, 0) / 4;
          const g = c.createRadialGradient(cx, cy, 0, cx, cy, 10 * cam.zoom);
          g.addColorStop(0, `rgba(255,220,140,${0.25 * night})`);
          g.addColorStop(1, "rgba(255,220,140,0)");
          c.fillStyle = g;
          c.fillRect(cx - 10 * cam.zoom, cy - 10 * cam.zoom, 20 * cam.zoom, 20 * cam.zoom);
        }
      }
    }
  }

  private drawDoor(b: Building, face: string, s: RenderState) {
    const cam = this.cam;
    const c = this.ctx;
    const { x: x0, y: y0 } = b.lot;
    const x1 = x0 + b.lot.w;
    const y1 = y0 + b.lot.h;
    const col = this.nightMix(b.trim, s.light);
    const frame = "rgba(0,0,0,0.35)";
    if (face === "south") {
      const mx = (x0 + x1) / 2;
      this.poly(c, [cam.toScreen(mx - 0.22, y1, 0), cam.toScreen(mx + 0.22, y1, 0), cam.toScreen(mx + 0.22, y1, 14), cam.toScreen(mx - 0.22, y1, 14)], col, frame);
      const k = cam.toScreen(mx + 0.14, y1, 7);
      c.fillStyle = "#333";
      c.beginPath();
      c.arc(k.x, k.y, 1.2 * cam.zoom, 0, Math.PI * 2);
      c.fill();
    } else if (face === "east") {
      const my = (y0 + y1) / 2;
      this.poly(c, [cam.toScreen(x1, my - 0.22, 0), cam.toScreen(x1, my + 0.22, 0), cam.toScreen(x1, my + 0.22, 14), cam.toScreen(x1, my - 0.22, 14)], col, frame);
    }
    const d = cam.toScreen(b.door.x + 0.5, b.door.y + 0.5);
    c.fillStyle = "rgba(255,255,255,0.1)";
    c.beginPath();
    c.ellipse(d.x, d.y, 10 * cam.zoom, 5 * cam.zoom, 0, 0, Math.PI * 2);
    c.fill();
  }

  private drawDecoration(kind: string, x: number, y: number, s: RenderState) {
    const c = this.ctx;
    const cam = this.cam;
    const z = cam.zoom;
    const jx = hash(x, y, 21) * 0.4 - 0.2;
    const jy = hash(x, y, 22) * 0.4 - 0.2;
    const base = cam.toScreen(x + 0.5 + jx, y + 0.5 + jy);
    const light = s.light;
    const sway = Math.sin(s.time * 1.3 + x * 2 + y) * 1.5 * z;
    switch (kind) {
      case "tree": {
        c.fillStyle = "rgba(0,0,0,0.18)";
        c.beginPath();
        c.ellipse(base.x + 4 * z, base.y + 2 * z, 12 * z, 5 * z, 0, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = this.nightMix("#6b4a2b", light);
        c.lineWidth = 3 * z;
        c.beginPath();
        c.moveTo(base.x, base.y);
        c.lineTo(base.x, base.y - 18 * z);
        c.stroke();
        const greens = ["#2f6e2c", "#3f8f3a", "#4ea84a", "#6cc95e"];
        const blobs: [number, number, number][] = [
          [0, -26, 15],
          [-9, -20, 11],
          [10, -19, 11],
          [-3, -33, 9],
          [6, -31, 8],
        ];
        blobs.forEach(([dx, dy, r], i) => {
          c.fillStyle = this.nightMix(greens[Math.min(3, i)], light);
          c.beginPath();
          c.arc(base.x + dx * z + sway * (i ? 0.5 : 1), base.y + dy * z, r * z, 0, Math.PI * 2);
          c.fill();
        });
        // highlight and shaded underside
        c.fillStyle = `rgba(255,255,220,${0.18 * light})`;
        c.beginPath();
        c.arc(base.x - 5 * z + sway, base.y - 33 * z, 6 * z, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "rgba(0,30,0,0.22)";
        c.beginPath();
        c.ellipse(base.x + 2 * z, base.y - 15 * z, 13 * z, 5 * z, 0, 0, Math.PI);
        c.fill();
        break;
      }
      case "pine": {
        c.fillStyle = "rgba(0,0,0,0.18)";
        c.beginPath();
        c.ellipse(base.x + 3 * z, base.y + 2 * z, 9 * z, 4 * z, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = this.nightMix("#5a3d22", light);
        c.fillRect(base.x - 1.5 * z, base.y - 10 * z, 3 * z, 10 * z);
        for (let i = 0; i < 3; i++) {
          const w = (14 - i * 3.5) * z;
          const yy = base.y - 10 * z - i * 10 * z;
          c.fillStyle = this.nightMix(["#2f6b3a", "#38804a", "#459457"][i], light);
          c.beginPath();
          c.moveTo(base.x + sway * 0.3 * i, yy - 14 * z);
          c.lineTo(base.x - w, yy);
          c.lineTo(base.x + w, yy);
          c.fill();
        }
        break;
      }
      case "bush": {
        c.fillStyle = this.nightMix("#4f9a44", light);
        c.beginPath();
        c.ellipse(base.x, base.y - 4 * z, 11 * z, 7 * z, 0, 0, Math.PI * 2);
        c.fill();
        break;
      }
      case "flowers": {
        for (let i = 0; i < 7; i++) {
          const fx = base.x + (hash(i, x, 5) - 0.5) * 26 * z;
          const fy = base.y + (hash(i, y, 6) - 0.5) * 12 * z;
          c.fillStyle = ["#ff7ab6", "#ffd54f", "#ff8a65", "#ffffff"][i % 4];
          c.beginPath();
          c.arc(fx, fy, 2 * z, 0, Math.PI * 2);
          c.fill();
        }
        break;
      }
      case "bench": {
        c.fillStyle = this.nightMix("#8d6e63", light);
        c.fillRect(base.x - 9 * z, base.y - 6 * z, 18 * z, 3 * z);
        c.fillRect(base.x - 8 * z, base.y - 3 * z, 2 * z, 4 * z);
        c.fillRect(base.x + 6 * z, base.y - 3 * z, 2 * z, 4 * z);
        break;
      }
      case "lamp": {
        c.strokeStyle = this.nightMix("#37474f", light);
        c.lineWidth = 2 * z;
        c.beginPath();
        c.moveTo(base.x, base.y);
        c.lineTo(base.x, base.y - 30 * z);
        c.stroke();
        const night = 1 - light;
        c.fillStyle = night > 0.3 ? "#fff3b0" : "#cfd8dc";
        c.beginPath();
        c.arc(base.x, base.y - 31 * z, 3 * z, 0, Math.PI * 2);
        c.fill();
        if (night > 0.3) {
          const g = c.createRadialGradient(base.x, base.y - 10 * z, 0, base.x, base.y - 10 * z, 40 * z);
          g.addColorStop(0, `rgba(255,230,150,${0.35 * night})`);
          g.addColorStop(1, "rgba(255,230,150,0)");
          c.fillStyle = g;
          c.fillRect(base.x - 40 * z, base.y - 50 * z, 80 * z, 80 * z);
        }
        break;
      }
      case "pole": {
        c.strokeStyle = this.nightMix("#6d4c41", light);
        c.lineWidth = 3 * z;
        c.beginPath();
        c.moveTo(base.x, base.y);
        c.lineTo(base.x, base.y - 44 * z);
        c.stroke();
        c.lineWidth = 2 * z;
        c.beginPath();
        c.moveTo(base.x - 10 * z, base.y - 38 * z);
        c.lineTo(base.x + 10 * z, base.y - 38 * z);
        c.stroke();
        c.fillStyle = "#ff9800";
        c.beginPath();
        c.arc(base.x, base.y - 42 * z, 2.5 * z, 0, Math.PI * 2);
        c.fill();
        break;
      }
    }
  }

  private drawPerson(p: PersonVisual, s: RenderState) {
    const c = this.ctx;
    const cam = this.cam;
    const z = cam.zoom;
    const sp = cam.toScreen(p.x, p.y);
    const bob = Math.abs(Math.sin(p.phase)) * 1.5 * z;
    c.fillStyle = "rgba(0,0,0,0.25)";
    c.beginPath();
    c.ellipse(sp.x, sp.y, 4 * z, 2 * z, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "#2b2f3a";
    c.lineWidth = 1.6 * z;
    const step = Math.sin(p.phase) * 2.2 * z;
    c.beginPath();
    c.moveTo(sp.x - 1.5 * z, sp.y - 3 * z);
    c.lineTo(sp.x - 1.5 * z + step, sp.y);
    c.moveTo(sp.x + 1.5 * z, sp.y - 3 * z);
    c.lineTo(sp.x + 1.5 * z - step, sp.y);
    c.stroke();
    c.fillStyle = this.nightMix(p.color, s.light);
    c.beginPath();
    c.roundRect(sp.x - 3 * z, sp.y - 12 * z - bob, 6 * z, 10 * z, 2 * z);
    c.fill();
    c.fillStyle = p.skin;
    c.beginPath();
    c.arc(sp.x, sp.y - 15 * z - bob, 3 * z, 0, Math.PI * 2);
    c.fill();
  }

  private drawVehicle(v: VehicleVisual, s: RenderState) {
    const c = this.ctx;
    const cam = this.cam;
    const z = cam.zoom;
    const alongX = v.dx !== 0;
    const w = alongX ? (v.kind === "van" ? 0.6 : 0.5) : 0.28;
    const d = alongX ? 0.28 : v.kind === "van" ? 0.6 : 0.5;
    const x0 = v.x - w / 2;
    const y0 = v.y - d / 2;
    const h = v.kind === "van" ? 12 : 8;
    const mix = (col: string) => this.nightMix(col, s.light);
    // shadow
    this.poly(c, this.rect(x0 + 0.05, y0 + 0.05, x0 + w + 0.08, y0 + d + 0.08), "rgba(0,0,0,0.25)");
    this.box(x0, y0, w, d, 0, h, mix(v.color), mix(this.shade(v.color, 0.75)), mix(this.shade(v.color, 0.6)));
    // cabin / windows
    const cab = v.kind === "van" ? 0.35 : 0.55;
    const cx0 = alongX ? x0 + w * (v.dx > 0 ? 0.45 : 0.1) : x0 + 0.03;
    const cy0 = alongX ? y0 + 0.03 : y0 + d * (v.dy > 0 ? 0.45 : 0.1);
    const cw = alongX ? w * cab * 0.8 : w - 0.06;
    const cd = alongX ? d - 0.06 : d * cab * 0.8;
    this.box(cx0, cy0, cw, cd, h, 5, mix("#90caf9"), mix("#5d8fb8"), mix("#4a7398"));
    // headlights at night
    if (s.light < 0.45) {
      const fx = alongX ? (v.dx > 0 ? x0 + w : x0) : v.x;
      const fy = alongX ? v.y : v.dy > 0 ? y0 + d : y0;
      const p = cam.toScreen(fx, fy, 3);
      const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, 22 * z);
      g.addColorStop(0, "rgba(255,245,200,0.45)");
      g.addColorStop(1, "rgba(255,245,200,0)");
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(p.x + (alongX ? v.dx : -v.dy) * 12 * z, p.y + (alongX ? v.dx : v.dy) * 6 * z, 24 * z, 12 * z, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#fff8d6";
      c.beginPath();
      c.arc(p.x, p.y, 1.6 * z, 0, Math.PI * 2);
      c.fill();
    }
  }

  private drawRain(s: RenderState) {
    if (s.rain <= 0.02) return;
    const c = this.ctx;
    const cam = this.cam;
    c.fillStyle = `rgba(40,50,80,${0.18 * s.rain})`;
    c.fillRect(0, 0, cam.width, cam.height);
    c.strokeStyle = `rgba(200,220,255,${0.35 * s.rain})`;
    c.lineWidth = 1;
    const n = Math.floor(160 * s.rain);
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const x = ((hash(i, 3, 77) * cam.width + s.time * 60 * (0.6 + hash(i, 4, 77))) % (cam.width + 40)) - 20;
      const y = (hash(i, 5, 77) * cam.height + s.time * (420 + hash(i, 6, 77) * 240)) % (cam.height + 30);
      c.moveTo(x, y);
      c.lineTo(x - 3, y + 11 + hash(i, 7, 77) * 6);
    }
    c.stroke();
  }

  private drawPackets(s: RenderState) {
    const c = this.ctx;
    const cam = this.cam;
    const z = cam.zoom;
    for (const pk of s.packets) {
      const pos = pointAlong(pk.points, Math.min(pk.progress, pk.failAt ?? pk.length));
      if (!pos) continue;
      const sp = cam.toScreen(pos.x, pos.y);
      if (pk.burst !== undefined) {
        const t = pk.burst;
        c.strokeStyle = `rgba(255,90,90,${1 - t})`;
        c.lineWidth = 2 * z;
        c.beginPath();
        c.arc(sp.x, sp.y - 6 * z, (6 + t * 18) * z, 0, Math.PI * 2);
        c.stroke();
        c.strokeStyle = `rgba(255,120,120,${1 - t})`;
        c.lineWidth = 2.5 * z;
        const r = 5 * z;
        c.beginPath();
        c.moveTo(sp.x - r, sp.y - 6 * z - r);
        c.lineTo(sp.x + r, sp.y - 6 * z + r);
        c.moveTo(sp.x + r, sp.y - 6 * z - r);
        c.lineTo(sp.x - r, sp.y - 6 * z + r);
        c.stroke();
        continue;
      }
      for (let i = 0; i < pk.trail.length; i++) {
        const t = pk.trail[i];
        const tp = cam.toScreen(t.x, t.y);
        c.fillStyle = pk.color.replace(")", `,${(i / pk.trail.length) * 0.5})`).replace("rgb(", "rgba(");
        c.beginPath();
        c.arc(tp.x, tp.y - 6 * z, (2 + (i / pk.trail.length) * 2) * z, 0, Math.PI * 2);
        c.fill();
      }
      const g = c.createRadialGradient(sp.x, sp.y - 6 * z, 0, sp.x, sp.y - 6 * z, 18 * z);
      g.addColorStop(0, pk.color.replace("rgb(", "rgba(").replace(")", ",0.6)"));
      g.addColorStop(1, pk.color.replace("rgb(", "rgba(").replace(")", ",0)"));
      c.fillStyle = g;
      c.fillRect(sp.x - 18 * z, sp.y - 24 * z, 36 * z, 36 * z);
      c.fillStyle = pk.color;
      c.beginPath();
      c.arc(sp.x, sp.y - 6 * z, 5 * z, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "white";
      c.beginPath();
      c.arc(sp.x, sp.y - 6 * z, 2 * z, 0, Math.PI * 2);
      c.fill();
    }
  }

  private drawNight(s: RenderState) {
    const c = this.ctx;
    const night = 1 - s.light;
    if (night <= 0.02) return;
    c.fillStyle = `rgba(10,16,48,${0.3 * night})`;
    c.fillRect(0, 0, this.cam.width, this.cam.height);
    if (night > 0.5) {
      c.fillStyle = `rgba(255,255,255,${(night - 0.5) * 1.4})`;
      for (let i = 0; i < 60; i++) {
        const x = hash(i, 1, 99) * this.cam.width;
        const y = hash(i, 2, 99) * this.cam.height * 0.5;
        c.globalAlpha = 0.5 + 0.5 * Math.sin(s.time * 2 + i);
        c.fillRect(x, y, 1.5, 1.5);
      }
      c.globalAlpha = 1;
    }
  }

  private drawLabels(s: RenderState) {
    const c = this.ctx;
    const cam = this.cam;
    c.textAlign = "center";
    if (s.showLabels || cam.zoom >= 1.3) {
      c.font = `600 ${Math.max(10, 12 * Math.min(cam.zoom, 1.4))}px Inter, system-ui, sans-serif`;
      for (const b of BUILDINGS) {
        if (b.id === s.hoverBuilding) continue;
        const vis = s.buildings.get(b.id);
        const p = cam.toScreen(b.lot.x + b.lot.w / 2, b.lot.y + b.lot.h / 2, b.height + (b.kind === "house" ? 36 : 30));
        const w = c.measureText(b.name).width + 14;
        c.fillStyle = "rgba(10,14,24,0.72)";
        c.beginPath();
        c.roundRect(p.x - w / 2, p.y - 18, w, 20, 6);
        c.fill();
        c.fillStyle = vis && !vis.unlocked ? "#aaa" : "#fff";
        c.fillText(b.name, p.x, p.y - 4);
      }
    }
    if (s.hoverBuilding && s.mouse) {
      const b = building(s.hoverBuilding);
      const vis = s.buildings.get(b.id);
      const lines = [b.name, vis?.summary ?? ""].filter(Boolean);
      c.font = `600 12px Inter, system-ui, sans-serif`;
      const w1 = c.measureText(lines[0]).width;
      c.font = `12px Inter, system-ui, sans-serif`;
      const w2 = lines[1] ? c.measureText(lines[1]).width : 0;
      const w = Math.max(w1, w2) + 20;
      const hgt = lines.length * 18 + 10;
      let x = s.mouse.x + 16;
      let y = s.mouse.y + 16;
      if (x + w > cam.width - 8) x = s.mouse.x - w - 8;
      if (y + hgt > cam.height - 8) y = s.mouse.y - hgt - 8;
      c.fillStyle = "rgba(10,14,24,0.9)";
      c.strokeStyle = "rgba(255,255,255,0.15)";
      c.beginPath();
      c.roundRect(x, y, w, hgt, 8);
      c.fill();
      c.stroke();
      c.textAlign = "left";
      c.fillStyle = "#fff";
      c.font = `600 12px Inter, system-ui, sans-serif`;
      c.fillText(lines[0], x + 10, y + 18);
      if (lines[1]) {
        c.fillStyle = vis?.online ? "#3ce6aa" : vis?.alert ? "#ffcc33" : "#9aa7bd";
        c.font = `12px Inter, system-ui, sans-serif`;
        c.fillText(lines[1], x + 10, y + 36);
      }
    }
  }

  /** Pick the building under a screen position, respecting draw order (nearest wins). */
  pick(sx: number, sy: number): Building | undefined {
    const cam = this.cam;
    const sorted = [...BUILDINGS].sort((a, b) => b.lot.x + b.lot.w + b.lot.y + b.lot.h - (a.lot.x + a.lot.w + a.lot.y + a.lot.h));
    for (const b of sorted) {
      const { x: x0, y: y0 } = b.lot;
      const x1 = x0 + b.lot.w;
      const y1 = y0 + b.lot.h;
      const h = b.height + (b.kind === "house" ? 16 : 0);
      const outline = [cam.toScreen(x0, y0, h), cam.toScreen(x1, y0, h), cam.toScreen(x1, y0, 0), cam.toScreen(x1, y1, 0), cam.toScreen(x0, y1, 0), cam.toScreen(x0, y1, h)];
      if (pointInPoly(sx, sy, outline)) return b;
    }
    return undefined;
  }
}

export function pointInPoly(x: number, y: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x,
      yi = pts[i].y,
      xj = pts[j].x,
      yj = pts[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pathLength(pts: Pt[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}

export function pointAlong(pts: Pt[], d: number): Pt | null {
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + seg >= d) {
      const t = seg === 0 ? 0 : (d - acc) / seg;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}
