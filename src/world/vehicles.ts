// Cars that drive the road network, keeping to the right-hand lane.

import { BUILDINGS, roadPath } from "./map";
import { hash } from "../core/events";

export interface Vehicle {
  id: number;
  path: { x: number; y: number }[];
  seg: number;
  t: number;
  speed: number;
  color: string;
  kind: "car" | "van";
}

const COLORS = ["#e53935", "#1e88e5", "#fdd835", "#ffffff", "#546e7a", "#8e24aa", "#43a047", "#fb8c00"];

export class Vehicles {
  list: Vehicle[] = [];
  private nextId = 1;
  private spawnTimer = 2;
  target = 3;

  constructor(private deliveriesActive: () => boolean) {}

  update(dt: number) {
    this.spawnTimer -= dt;
    if (this.list.length < this.target && this.spawnTimer <= 0) {
      this.spawn();
      this.spawnTimer = 3 + Math.random() * 4;
    }
    for (const v of this.list) {
      v.t += dt * v.speed;
      while (v.t >= 1 && v.seg < v.path.length - 2) {
        v.t -= 1;
        v.seg++;
      }
    }
    this.list = this.list.filter((v) => !(v.seg >= v.path.length - 2 && v.t >= 1));
  }

  private spawn() {
    const edges = [
      { x: 0, y: 3 },
      { x: 3, y: 15 },
      { x: 22, y: 15 },
      { x: 22, y: 3 },
    ];
    const unlocked = BUILDINGS.filter((b) => !b.locked);
    let from: { x: number; y: number };
    let to: { x: number; y: number };
    let kind: Vehicle["kind"] = "car";
    if (this.deliveriesActive() && Math.random() < 0.35) {
      // delivery van from the market to a house
      from = BUILDINGS.find((b) => b.id === "shop")!.door;
      const houses = unlocked.filter((b) => b.kind === "house");
      to = houses[Math.floor(Math.random() * houses.length)].door;
      kind = "van";
    } else {
      from = edges[Math.floor(Math.random() * edges.length)];
      const dest = Math.random() < 0.5 ? edges.filter((e) => e !== from)[Math.floor(Math.random() * 3)] : unlocked[Math.floor(Math.random() * unlocked.length)].door;
      to = dest;
    }
    const path = roadPath(from, to);
    if (path.length < 3) return;
    const id = this.nextId++;
    this.list.push({ id, path, seg: 0, t: 0, speed: 2.2 + Math.random() * 1.2, color: kind === "van" ? "#f6f1d1" : COLORS[Math.floor(hash(id, 9) * COLORS.length)], kind });
  }

  /** World position plus heading (dx, dy) for a vehicle, offset to its right-hand lane. */
  position(v: Vehicle): { x: number; y: number; dx: number; dy: number } {
    const a = v.path[v.seg];
    const b = v.path[Math.min(v.seg + 1, v.path.length - 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const x = a.x + dx * v.t + 0.5 - dy * 0.24;
    const y = a.y + dy * v.t + 0.5 + dx * 0.24;
    return { x, y, dx, dy };
  }
}
