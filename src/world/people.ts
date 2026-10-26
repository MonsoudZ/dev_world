// Pedestrians who walk between building doors along the roads. Their number reflects how
// alive the town is: connected buildings attract more visitors.

import { BUILDINGS, roadPath } from "./map";
import { hash } from "../core/events";

export interface Person {
  id: number;
  path: { x: number; y: number }[];
  seg: number;
  t: number; // 0..1 within segment
  speed: number;
  color: string;
  skin: string;
  dest: string;
  lane: number; // -1 or 1 offset across the road
}

const SHIRTS = ["#e57373", "#64b5f6", "#81c784", "#ffd54f", "#ba68c8", "#4db6ac", "#ff8a65", "#90a4ae", "#f06292", "#aed581"];
const SKINS = ["#f1c27d", "#e0ac69", "#c68642", "#8d5524", "#ffdbac", "#5c3b1e"];

export class People {
  list: Person[] = [];
  private nextId = 1;
  private spawnTimer = 0;
  target = 6;

  constructor(private openBuildings: () => string[]) {}

  update(dt: number) {
    this.spawnTimer -= dt;
    if (this.list.length < this.target && this.spawnTimer <= 0) {
      this.spawn();
      this.spawnTimer = 0.8 + Math.random() * 1.5;
    }
    for (const p of this.list) {
      p.t += (dt * p.speed) / 1;
      while (p.t >= 1 && p.seg < p.path.length - 2) {
        p.t -= 1;
        p.seg++;
      }
    }
    this.list = this.list.filter((p) => !(p.seg >= p.path.length - 2 && p.t >= 1));
  }

  private spawn() {
    const open = this.openBuildings();
    const unlocked = BUILDINGS.filter((b) => !b.locked);
    const from = unlocked[Math.floor(Math.random() * unlocked.length)];
    // Prefer open (connected) destinations.
    const pool = open.length && Math.random() < 0.7 ? unlocked.filter((b) => open.includes(b.id) && b.id !== from.id) : unlocked.filter((b) => b.id !== from.id);
    const to = (pool.length ? pool : unlocked.filter((b) => b.id !== from.id))[Math.floor(Math.random() * (pool.length || unlocked.length - 1))];
    if (!to) return;
    const path = roadPath(from.door, to.door);
    if (path.length < 2) return;
    const id = this.nextId++;
    this.list.push({
      id,
      path,
      seg: 0,
      t: 0,
      speed: 0.9 + Math.random() * 0.6,
      color: SHIRTS[Math.floor(hash(id, 1) * SHIRTS.length)],
      skin: SKINS[Math.floor(hash(id, 2) * SKINS.length)],
      dest: to.id,
      lane: hash(id, 3) < 0.5 ? -1 : 1,
    });
  }

  position(p: Person): { x: number; y: number } {
    const a = p.path[p.seg];
    const b = p.path[Math.min(p.seg + 1, p.path.length - 1)];
    const x = a.x + (b.x - a.x) * p.t;
    const y = a.y + (b.y - a.y) * p.t;
    // offset across the direction of travel
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return { x: x + 0.5 - dy * 0.22 * p.lane, y: y + 0.5 + dx * 0.22 * p.lane };
  }
}
