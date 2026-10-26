// Game state: ties the network simulation to the city, tracks needs, traffic, time and progress.

import { Emitter } from "../core/events";
import { Network, TraceResult } from "../net/sim";
import { DeviceKind, Device, NetworkSnapshot } from "../net/model";
import { BUILDINGS, building, roadPath } from "../world/map";
import { People } from "../world/people";
import { BuildingVisual, CableVisual, PacketAnim, pathLength } from "../render/renderer";
import { LESSONS, NEEDS, Need, Step, seedWorld } from "./campaign";

export type Mode = "campaign" | "sandbox";

export interface Progress {
  lesson: number; // index into LESSONS
  step: number;
  completed: string[]; // lesson ids
  quizRight: number;
  quizWrong: number;
  finished: boolean;
}

export interface SaveFile {
  version: number;
  mode: Mode;
  net: NetworkSnapshot;
  progress: Progress;
  dayFrac: number;
  day: number;
  unlockedDevices: DeviceKind[];
  unlockedBuildings: string[];
  overlays: { network: boolean; traffic: boolean; labels: boolean };
  camera?: { ox: number; oy: number; zoom: number };
  notes: string[];
}

export interface NeedStatus {
  ok: boolean;
  detail: string;
  active: boolean;
}

export interface LogEntry {
  t: number;
  text: string;
  kind: "info" | "good" | "bad";
}

type GameEvents = {
  change: undefined;
  toast: { text: string; kind: "info" | "good" | "bad" };
  step: undefined;
  workspace: string | null;
  select: string | undefined;
};

const SAVE_VERSION = 3;

export class Game {
  net = new Network();
  people: People;
  time = 0;
  dayFrac = 0.32;
  day = 1;
  dayLength = 600; // seconds of real time per in-game day
  paused = false;
  timeScale = 1;
  packets: PacketAnim[] = [];
  cables: CableVisual[] = [];
  needStatus = new Map<string, NeedStatus>();
  progress: Progress = { lesson: 0, step: 0, completed: [], quizRight: 0, quizWrong: 0, finished: false };
  unlockedDevices = new Set<DeviceKind>();
  unlockedBuildings = new Set<string>();
  overlays = { network: true, traffic: true, labels: false };
  selected?: string;
  focus?: string;
  workspace: string | null = null;
  pendingCable?: { ifaceId: string; fromBuilding: string };
  events = new Emitter<GameEvents>();
  log: LogEntry[] = [];
  notes: string[] = []; // field notes unlocked (lesson ids)
  flags = new Set<string>(); // terminal activity flags used by lesson checks
  private statusTimer = 0;
  private trafficTimer = 0;
  private stepEnteredAt = 0;
  private stepRan = new Set<string>();
  cameraState?: { ox: number; oy: number; zoom: number };

  constructor(public mode: Mode) {
    this.people = new People(() => this.onlineBuildings());
    if (!this.load()) this.newWorld();
  }

  // ------------------------------------------------------------- world setup
  newWorld() {
    this.net = new Network();
    seedWorld(this.net);
    this.progress = { lesson: 0, step: 0, completed: [], quizRight: 0, quizWrong: 0, finished: false };
    this.unlockedDevices = new Set(this.mode === "sandbox" ? ["pc", "laptop", "switch", "router", "server"] : ["switch"]);
    this.unlockedBuildings = new Set(BUILDINGS.filter((b) => !b.locked || this.mode === "sandbox").map((b) => b.id));
    this.dayFrac = 0.32;
    this.day = 1;
    this.notes = [];
    this.log = [];
    this.stepRan.clear();
    this.packets = [];
    this.recompute();
    this.enterStep();
    this.save();
    this.events.emit("change", undefined);
  }

  // ------------------------------------------------------------- persistence
  private key() {
    return `dev-world:${this.mode}`;
  }

  save() {
    const data: SaveFile = {
      version: SAVE_VERSION,
      mode: this.mode,
      net: this.net.snapshot(),
      progress: this.progress,
      dayFrac: this.dayFrac,
      day: this.day,
      unlockedDevices: [...this.unlockedDevices],
      unlockedBuildings: [...this.unlockedBuildings],
      overlays: this.overlays,
      camera: this.cameraState,
      notes: this.notes,
    };
    try {
      localStorage.setItem(this.key(), JSON.stringify(data));
    } catch {
      /* storage unavailable */
    }
  }

  load(): boolean {
    try {
      const raw = localStorage.getItem(this.key());
      if (!raw) return false;
      const data = JSON.parse(raw) as SaveFile;
      if (data.version !== SAVE_VERSION) return false;
      this.net = new Network();
      this.net.load(data.net);
      this.progress = data.progress;
      this.dayFrac = data.dayFrac;
      this.day = data.day;
      this.unlockedDevices = new Set(data.unlockedDevices);
      this.unlockedBuildings = new Set(data.unlockedBuildings);
      this.overlays = data.overlays;
      this.cameraState = data.camera;
      this.notes = data.notes ?? [];
      this.recompute();
      this.enterStep();
      return true;
    } catch {
      return false;
    }
  }

  reset() {
    localStorage.removeItem(this.key());
    this.newWorld();
  }

  // ------------------------------------------------------------- time
  get light(): number {
    // 0 at midnight, 1 at midday. Smooth curve with long dusk/dawn.
    const f = this.dayFrac;
    const sun = Math.cos((f - 0.5) * Math.PI * 2); // 1 at noon (0.5), -1 at midnight
    return Math.max(0, Math.min(1, (sun + 0.78) / 1.35));
  }

  clockLabel(): string {
    const mins = Math.floor(this.dayFrac * 24 * 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  // ------------------------------------------------------------- main loop
  tick(dt: number) {
    if (this.paused) dt = 0;
    dt *= this.timeScale;
    this.time += dt;
    this.dayFrac += dt / this.dayLength;
    if (this.dayFrac >= 1) {
      this.dayFrac -= 1;
      this.day++;
    }
    this.people.update(dt);
    for (const p of this.packets) {
      if (p.done) continue;
      p.progress += p.speed * dt;
      const pos = pointAlongSafe(p.points, p.progress);
      if (pos) {
        p.trail.push(pos);
        if (p.trail.length > 10) p.trail.shift();
      }
      if (p.progress >= (p.failAt ?? p.length)) {
        if (p.failAt !== undefined && !p.ok) {
          p.burst = (p.burst ?? 0) + dt * 1.6;
          if (p.burst >= 1) p.done = true;
        } else p.done = true;
      }
    }
    this.packets = this.packets.filter((p) => !p.done);

    this.statusTimer -= dt;
    if (this.statusTimer <= 0) {
      this.statusTimer = 0.6;
      this.recompute();
      this.checkStep();
    }
    this.trafficTimer -= dt;
    if (this.trafficTimer <= 0) {
      this.trafficTimer = 1.4 + Math.random() * 1.6;
      this.backgroundTraffic();
    }
  }

  // ------------------------------------------------------------- status
  recompute() {
    this.net.refresh();
    for (const need of NEEDS) {
      const active = this.needActive(need);
      const prev = this.needStatus.get(need.id);
      if (!active) {
        this.needStatus.set(need.id, { ok: false, detail: "", active: false });
        continue;
      }
      const r = need.check(this);
      this.needStatus.set(need.id, { ...r, active: true });
      if (prev && prev.active && prev.ok !== r.ok && this.time > 2) {
        const b = building(need.buildingId);
        const quote = r.ok ? need.onSatisfied : need.onLost;
        if (quote && b.npc) this.toast(`${b.npc.name}: “${quote}”`, r.ok ? "good" : "bad");
      }
    }
    this.rebuildCables();
    const online = this.onlineBuildings().length;
    this.people.target = 4 + online * 3;
  }

  needActive(need: Need): boolean {
    if (!this.unlockedBuildings.has(need.buildingId)) return false;
    if (this.mode === "sandbox") return true;
    const idx = LESSONS.findIndex((l) => l.id === need.fromLesson);
    return idx <= this.progress.lesson || this.progress.finished;
  }

  needsFor(buildingId: string): { need: Need; status: NeedStatus }[] {
    return NEEDS.filter((n) => n.buildingId === buildingId)
      .map((need) => ({ need, status: this.needStatus.get(need.id) ?? { ok: false, detail: "", active: false } }))
      .filter((x) => x.status.active);
  }

  onlineBuildings(): string[] {
    return BUILDINGS.filter((b) => {
      const needs = this.needsFor(b.id);
      return needs.length > 0 && needs.every((n) => n.status.ok);
    }).map((b) => b.id);
  }

  buildingVisuals(): Map<string, BuildingVisual> {
    const m = new Map<string, BuildingVisual>();
    for (const b of BUILDINGS) {
      const needs = this.needsFor(b.id);
      const devices = this.net.devicesIn(b.id);
      const unlocked = this.unlockedBuildings.has(b.id);
      const unmet = needs.filter((n) => !n.status.ok);
      const summary = !unlocked
        ? b.lockedHint ?? "Locked"
        : needs.length === 0
          ? b.npc
            ? `${b.npc.name}, ${b.npc.role.toLowerCase()}`
            : b.description
          : unmet.length === 0
            ? `Online · ${needs.length} need${needs.length === 1 ? "" : "s"} met`
            : `Needs: ${unmet.map((n) => n.need.label).join(", ")}`;
      m.set(b.id, {
        unlocked,
        online: needs.length > 0 && needs.every((n) => n.status.ok),
        alert: unmet.length > 0,
        powered: devices.some((d) => d.power && d.ifaces.some((i) => this.net.linkState(i) === "up")),
        summary,
      });
    }
    return m;
  }

  private rebuildCables() {
    const out: CableVisual[] = [];
    const seen = new Map<string, number>();
    for (const link of this.net.links.values()) {
      const a = this.net.iface(link.a);
      const b = this.net.iface(link.b);
      if (!a || !b) continue;
      const da = this.net.device(a.deviceId)!;
      const db = this.net.device(b.deviceId)!;
      if (da.hidden || db.hidden || da.buildingId === db.buildingId) continue;
      const ba = building(da.buildingId);
      const bb = building(db.buildingId);
      const pairKey = [ba.id, bb.id].sort().join("|");
      const n = seen.get(pairKey) ?? 0;
      seen.set(pairKey, n + 1);
      const points = roadPath(ba.door, bb.door);
      const state: CableVisual["state"] = link.damaged ? "down" : da.power && db.power ? "up" : "idle";
      out.push({ id: link.id, points, state, offset: (n % 2 === 0 ? 1 : -1) * Math.ceil(n / 2) * 0.5, label: `${da.name} ${a.name} ↔ ${db.name} ${b.name}` });
    }
    this.cables = out;
  }

  // ------------------------------------------------------------- traffic & animation
  /** Convert a trace into a packet animation along roads between buildings. */
  animateTrace(trace: TraceResult, color: string) {
    const pts: { x: number; y: number }[] = [];
    let failAt: number | undefined;
    const pushPath = (path: { x: number; y: number }[]) => {
      for (const p of path) {
        const wp = { x: p.x + 0.5, y: p.y + 0.5 };
        const last = pts[pts.length - 1];
        if (!last || last.x !== wp.x || last.y !== wp.y) pts.push(wp);
      }
    };
    const startDev = this.net.device(trace.hops[0]?.deviceId ?? "");
    if (!startDev) return;
    let curBuilding = startDev.buildingId;
    if (!startDev.hidden) pushPath([building(curBuilding).door]);
    for (const hop of trace.hops) {
      for (const lid of hop.linkIds) {
        const link = this.net.links.get(lid);
        if (!link) continue;
        const da = this.net.ifaceDevice(link.a)!;
        const db = this.net.ifaceDevice(link.b)!;
        if (da.buildingId === db.buildingId) continue;
        const other = da.buildingId === curBuilding ? db : da;
        if (other.hidden || da.hidden || db.hidden) {
          // to/from the internet: animate to the west edge
          const from = building(curBuilding).door;
          pushPath(roadPath(from, { x: 0, y: 3 }));
          curBuilding = other.hidden ? "__internet" : other.buildingId;
          if (!other.hidden) pushPath(roadPath({ x: 0, y: 3 }, building(curBuilding).door));
          continue;
        }
        if (curBuilding === "__internet") {
          pushPath(roadPath({ x: 0, y: 3 }, building(other.buildingId).door));
        } else {
          pushPath(roadPath(building(curBuilding).door, building(other.buildingId).door));
        }
        curBuilding = other.buildingId;
      }
      if (!hop.ok) failAt = pathLength(pts);
    }
    if (pts.length < 2) {
      // Local hop: tiny pulse at the building
      const d = building(startDev.buildingId).door;
      pts.push({ x: d.x + 0.5, y: d.y + 0.5 }, { x: d.x + 0.5, y: d.y + 0.2 });
    }
    const length = pathLength(pts);
    this.packets.push({
      id: Math.random().toString(36).slice(2),
      points: pts,
      progress: 0,
      length,
      speed: 7,
      color,
      ok: trace.ok,
      failAt: failAt !== undefined ? Math.min(failAt, length) : undefined,
      done: false,
      trail: [],
    });
  }

  private backgroundTraffic() {
    if (!this.overlays.traffic) return;
    const candidates = NEEDS.filter((n) => this.needStatus.get(n.id)?.ok && n.traffic);
    if (!candidates.length) return;
    const need = candidates[Math.floor(Math.random() * candidates.length)];
    const t = need.traffic!(this);
    if (t) this.animateTrace(t, "rgb(90,200,255)");
  }

  // ------------------------------------------------------------- selection / workspace
  select(id: string | undefined) {
    this.selected = id;
    this.events.emit("select", id);
  }

  openWorkspace(buildingId: string | null) {
    this.workspace = buildingId;
    this.events.emit("workspace", buildingId);
  }

  toast(text: string, kind: "info" | "good" | "bad" = "info") {
    this.events.emit("toast", { text, kind });
    this.log.push({ t: this.time, text, kind });
    if (this.log.length > 200) this.log.shift();
  }

  // ------------------------------------------------------------- campaign
  get lesson() {
    return LESSONS[Math.min(this.progress.lesson, LESSONS.length - 1)];
  }

  get step(): Step | undefined {
    if (this.progress.finished) return undefined;
    return this.lesson?.steps[this.progress.step];
  }

  private enterStep() {
    this.stepEnteredAt = this.time;
    this.flags.clear();
    const s = this.step;
    if (!s) return;
    this.focus = s.focus;
    const key = `${this.lesson.id}:${this.progress.step}`;
    if (s.kind === "event" && !this.stepRan.has(key)) {
      this.stepRan.add(key);
      s.run(this);
      this.recompute();
      this.advance();
      return;
    }
    if (s.kind === "unlock") {
      for (const d of s.devices ?? []) this.unlockedDevices.add(d);
      for (const b of s.buildings ?? []) this.unlockedBuildings.add(b);
      this.advance();
      return;
    }
    this.events.emit("step", undefined);
  }

  advance() {
    if (this.mode !== "campaign" || this.progress.finished) return;
    const lesson = this.lesson;
    if (this.progress.step + 1 < lesson.steps.length) {
      this.progress.step++;
    } else {
      if (!this.progress.completed.includes(lesson.id)) this.progress.completed.push(lesson.id);
      if (!this.notes.includes(lesson.id)) this.notes.push(lesson.id);
      this.toast(`Lesson complete: ${lesson.title}`, "good");
      if (this.progress.lesson + 1 < LESSONS.length) {
        this.progress.lesson++;
        this.progress.step = 0;
      } else {
        this.progress.finished = true;
        this.focus = undefined;
        this.unlockedBuildings.add("clinic");
        this.unlockedBuildings.add("hall");
        this.toast("Beginner campaign complete. The clinic and town hall are now open.", "good");
      }
    }
    this.save();
    this.enterStep();
    this.events.emit("change", undefined);
  }

  answerQuiz(choice: number): boolean {
    const s = this.step;
    if (!s || s.kind !== "quiz") return false;
    const right = choice === s.answer;
    if (right) this.progress.quizRight++;
    else this.progress.quizWrong++;
    return right;
  }

  private checkStep() {
    if (this.mode !== "campaign") return;
    const s = this.step;
    if (!s || s.kind !== "task") return;
    if (this.time - this.stepEnteredAt < 0.5) return;
    try {
      if (s.check(this)) {
        this.toast(`Done: ${s.title}`, "good");
        this.advance();
      }
    } catch {
      /* a check must never crash the loop */
    }
  }

  /** Jump directly to a lesson (used by the field-notes replay buttons). */
  gotoLesson(index: number) {
    this.progress.lesson = Math.max(0, Math.min(index, LESSONS.length - 1));
    this.progress.step = 0;
    this.progress.finished = false;
    this.enterStep();
    this.save();
    this.events.emit("change", undefined);
  }

  // ------------------------------------------------------------- helpers for lessons & UI
  deviceByKindIn(buildingId: string, kind: DeviceKind): Device | undefined {
    return this.net.devicesIn(buildingId).find((d) => d.kind === kind);
  }

  switchMode(mode: Mode) {
    this.save();
    this.mode = mode;
    this.workspace = null;
    this.pendingCable = undefined;
    this.selected = undefined;
    this.focus = undefined;
    this.packets = [];
    if (!this.load()) this.newWorld();
    this.events.emit("change", undefined);
    this.events.emit("workspace", null);
  }

  copyCampaignToSandbox() {
    const raw = localStorage.getItem("dev-world:campaign");
    if (!raw) return false;
    const data = JSON.parse(raw) as SaveFile;
    data.mode = "sandbox";
    data.unlockedDevices = ["pc", "laptop", "switch", "router", "server"];
    data.unlockedBuildings = BUILDINGS.map((b) => b.id);
    localStorage.setItem("dev-world:sandbox", JSON.stringify(data));
    return true;
  }
}

function pointAlongSafe(pts: { x: number; y: number }[], d: number) {
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
