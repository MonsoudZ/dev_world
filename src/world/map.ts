// Maple Hollow: the first neighbourhood. Tile grid, roads, lots, buildings and the people in them.

export type Tile = "grass" | "road" | "water" | "path" | "plaza" | "dirt";

export interface Lot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type BuildingKind = "workshop" | "library" | "house" | "shop" | "clinic" | "hall" | "school" | "datacenter";

export interface Npc {
  name: string;
  role: string;
  color: string;
  greeting: string;
}

export interface Building {
  id: string;
  name: string;
  kind: BuildingKind;
  lot: Lot;
  door: { x: number; y: number }; // road tile in front of the entrance
  height: number;
  color: string;
  roof: string;
  trim: string;
  npc?: Npc;
  locked?: boolean;
  lockedHint?: string;
  description: string;
  rackSlots: number;
}

export interface Decoration {
  kind: "tree" | "pine" | "lamp" | "bench" | "pole" | "bush" | "flowers";
  x: number;
  y: number;
}

export const MAP_W = 26;
export const MAP_H = 20;

function makeTiles(): Tile[][] {
  const t: Tile[][] = [];
  for (let y = 0; y < MAP_H; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < MAP_W; x++) row.push("grass");
    t.push(row);
  }
  const road = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) t[y][x] = "road";
  };
  for (let x = 3; x <= 22; x++) {
    road(x, 3);
    road(x, 9);
    road(x, 15);
  }
  for (let y = 3; y <= 15; y++) {
    road(3, y);
    road(12, y);
    road(22, y);
  }
  // road to the edge: fiber comes in from the west
  road(0, 3);
  road(1, 3);
  road(2, 3);
  // pond
  for (const [x, y] of [
    [6, 13],
    [7, 13],
    [6, 14],
    [7, 14],
  ])
    t[y][x] = "water";
  // plaza in front of library/park
  for (let x = 13; x <= 17; x++) for (let y = 4; y <= 5; y++) t[y][x] = "plaza";
  // path in park
  for (let x = 5; x <= 10; x++) t[4][x] = "path";
  return t;
}

export const TILES: Tile[][] = makeTiles();

export const BUILDINGS: Building[] = [
  {
    id: "workshop",
    name: "Rosa's Workshop",
    kind: "workshop",
    lot: { x: 5, y: 6, w: 3, h: 3 },
    door: { x: 6, y: 9 },
    height: 44,
    color: "#b86f45",
    roof: "#7a4428",
    trim: "#f1d2a6",
    rackSlots: 8,
    npc: { name: "Rosa", role: "Repair shop owner, your mentor", color: "#e8744f", greeting: "You must be the new network builder. Good. This town has been offline long enough." },
    description: "The repair shop where the ISP fiber terminates. Your base of operations.",
  },
  {
    id: "library",
    name: "Hollow Public Library",
    kind: "library",
    lot: { x: 14, y: 6, w: 4, h: 3 },
    door: { x: 15, y: 9 },
    height: 52,
    color: "#c9b59a",
    roof: "#5c6b7a",
    trim: "#ece2d0",
    rackSlots: 6,
    npc: { name: "Marcus", role: "Head librarian", color: "#5b8def", greeting: "We have forty laptops and a reading room, and not a single one of them can reach the internet." },
    description: "Wants to run online classes for the town. Needs a working connection.",
  },
  {
    id: "house_jun",
    name: "Jun's House",
    kind: "house",
    lot: { x: 5, y: 10, w: 2, h: 2 },
    door: { x: 5, y: 9 },
    height: 30,
    color: "#e4d6c3",
    roof: "#9b4a3a",
    trim: "#ffffff",
    rackSlots: 3,
    npc: { name: "Jun", role: "Student", color: "#8bc34a", greeting: "If the library gets classes online, I want to join from home." },
    description: "A small house. Jun studies here.",
  },
  {
    id: "house_priya",
    name: "Priya's House",
    kind: "house",
    lot: { x: 8, y: 10, w: 2, h: 2 },
    door: { x: 8, y: 9 },
    height: 30,
    color: "#dfe7ef",
    roof: "#3f6b8a",
    trim: "#ffffff",
    rackSlots: 3,
    npc: { name: "Priya", role: "Works from home (accountant)", color: "#ba68c8", greeting: "I keep typing numbers into my laptop that nobody but me can see. Help." },
    description: "Priya needs a reliable connection for remote work.",
  },
  {
    id: "house_theo",
    name: "Theo's House",
    kind: "house",
    lot: { x: 14, y: 10, w: 2, h: 2 },
    door: { x: 14, y: 9 },
    height: 30,
    color: "#f0e0b8",
    roof: "#6b8e4e",
    trim: "#ffffff",
    rackSlots: 3,
    npc: { name: "Theo", role: "Retired electrician", color: "#ffb74d", greeting: "I wired half this town. Never touched a computer network though. Show me." },
    description: "Theo likes to see how things work.",
  },
  {
    id: "shop",
    name: "Corner Market",
    kind: "shop",
    lot: { x: 18, y: 6, w: 3, h: 3 },
    door: { x: 19, y: 9 },
    height: 40,
    color: "#7ea885",
    roof: "#3a5a40",
    trim: "#f6f1d1",
    rackSlots: 5,
    npc: { name: "Dev", role: "Shop owner", color: "#26a69a", greeting: "People keep asking if they can order online. I'd love a little website." },
    description: "A grocery that wants to take online orders.",
  },
  {
    id: "clinic",
    name: "Hollow Clinic",
    kind: "clinic",
    lot: { x: 18, y: 12, w: 3, h: 3 },
    door: { x: 19, y: 15 },
    height: 46,
    color: "#eef2f5",
    roof: "#c94c4c",
    trim: "#c94c4c",
    rackSlots: 6,
    npc: { name: "Dr. Okafor", role: "Clinic physician", color: "#ef5350", greeting: "Patient records must stay private. Whatever you build here, security comes first." },
    description: "Needs a private, reliable network that stays separated from the public one.",
    locked: true,
    lockedHint: "Opens after the beginner campaign.",
  },
  {
    id: "hall",
    name: "Town Hall",
    kind: "hall",
    lot: { x: 8, y: 13, w: 3, h: 2 },
    door: { x: 9, y: 15 },
    height: 48,
    color: "#d9c7a8",
    roof: "#8d6e63",
    trim: "#fff8e1",
    rackSlots: 8,
    npc: { name: "Mayor Lindqvist", role: "Mayor", color: "#7986cb", greeting: "The region wants to connect our towns. We will need a proper operations room." },
    description: "Future home of the regional network operations centre.",
    locked: true,
    lockedHint: "Opens in a later chapter.",
  },
];

export const DECORATIONS: Decoration[] = [
  { kind: "tree", x: 5, y: 5 },
  { kind: "tree", x: 7, y: 4 },
  { kind: "pine", x: 9, y: 5 },
  { kind: "tree", x: 10, y: 4 },
  { kind: "bush", x: 6, y: 4 },
  { kind: "flowers", x: 8, y: 5 },
  { kind: "bench", x: 14, y: 4 },
  { kind: "bench", x: 16, y: 4 },
  { kind: "tree", x: 13, y: 5 },
  { kind: "tree", x: 18, y: 4 },
  { kind: "pine", x: 20, y: 5 },
  { kind: "tree", x: 19, y: 4 },
  { kind: "tree", x: 5, y: 13 },
  { kind: "pine", x: 10, y: 11 },
  { kind: "bush", x: 11, y: 13 },
  { kind: "tree", x: 14, y: 13 },
  { kind: "tree", x: 16, y: 12 },
  { kind: "flowers", x: 15, y: 13 },
  { kind: "lamp", x: 4, y: 8 },
  { kind: "lamp", x: 11, y: 8 },
  { kind: "lamp", x: 13, y: 8 },
  { kind: "lamp", x: 21, y: 8 },
  { kind: "lamp", x: 4, y: 14 },
  { kind: "lamp", x: 21, y: 14 },
  { kind: "lamp", x: 13, y: 10 },
  { kind: "lamp", x: 11, y: 10 },
  { kind: "pole", x: 1, y: 2 },
  { kind: "pole", x: 4, y: 2 },
  { kind: "tree", x: 1, y: 6 },
  { kind: "pine", x: 1, y: 11 },
  { kind: "tree", x: 24, y: 5 },
  { kind: "pine", x: 24, y: 12 },
  { kind: "tree", x: 2, y: 17 },
  { kind: "tree", x: 12, y: 17 },
  { kind: "pine", x: 20, y: 17 },
];

export function tileAt(x: number, y: number): Tile | null {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return null;
  return TILES[y][x];
}

export function buildingAt(x: number, y: number): Building | undefined {
  return BUILDINGS.find((b) => x >= b.lot.x && x < b.lot.x + b.lot.w && y >= b.lot.y && y < b.lot.y + b.lot.h);
}

export function building(id: string): Building {
  const b = BUILDINGS.find((b) => b.id === id);
  if (!b) throw new Error(`Unknown building ${id}`);
  return b;
}

/** Shortest road path between two road tiles (BFS). */
export function roadPath(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] {
  const key = (x: number, y: number) => `${x},${y}`;
  const prev = new Map<string, string | null>();
  const q: { x: number; y: number }[] = [from];
  prev.set(key(from.x, from.y), null);
  while (q.length) {
    const c = q.shift()!;
    if (c.x === to.x && c.y === to.y) break;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = c.x + dx;
      const ny = c.y + dy;
      if (tileAt(nx, ny) !== "road") continue;
      const k = key(nx, ny);
      if (prev.has(k)) continue;
      prev.set(k, key(c.x, c.y));
      q.push({ x: nx, y: ny });
    }
  }
  const out: { x: number; y: number }[] = [];
  let k: string | null | undefined = key(to.x, to.y);
  if (!prev.has(k)) return [from, to];
  while (k) {
    const [x, y] = k.split(",").map(Number);
    out.unshift({ x, y });
    k = prev.get(k) ?? null;
  }
  return out;
}

export function lotCenter(b: Building): { x: number; y: number } {
  return { x: b.lot.x + b.lot.w / 2, y: b.lot.y + b.lot.h / 2 };
}
