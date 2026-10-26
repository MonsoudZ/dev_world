import "./styles.css";
import { Game } from "./game/game";
import { Camera } from "./render/camera";
import { Renderer, RenderState } from "./render/renderer";
import { Workspace } from "./ui/workspace";
import { Panels } from "./ui/panels";
import { building, lotCenter } from "./world/map";

const app = document.getElementById("app")!;
const canvas = document.createElement("canvas");
canvas.className = "world";
app.append(canvas);
const uiLayer = document.createElement("div");
uiLayer.className = "ui";
app.append(uiLayer);

const game = new Game("campaign");
const cam = new Camera(window.innerWidth, window.innerHeight);
const renderer = new Renderer(canvas, cam);
renderer.resize();
if (game.cameraState) {
  cam.ox = game.cameraState.ox;
  cam.oy = game.cameraState.oy;
  cam.zoom = game.cameraState.zoom;
} else {
  frameTown();
}

function frameTown() {
  // Fit the town, leaving room for the lesson panel on the right.
  const avail = Math.max(320, cam.width - 400);
  cam.zoom = Math.max(0.7, Math.min(1.6, avail / 1150, cam.height / 700));
  cam.centerOn(13, 9);
  cam.ox -= 170;
}

const centerOn = (id: string) => {
  const b = building(id);
  const c = lotCenter(b);
  animateCamera(c.x, c.y, Math.max(cam.zoom, 1.4));
};

// Each new step with a building focus gently brings that building into view.
let lastFocus: string | undefined;
game.events.on("step", () => {
  const f = game.step?.focus;
  if (f && f !== lastFocus && !game.workspace) {
    const c = lotCenter(building(f));
    animateCamera(c.x, c.y, Math.max(cam.zoom, 1.0));
  }
  lastFocus = f;
});

const workspace = new Workspace(game, uiLayer);
const panels = new Panels(game, uiLayer, { centerOn });

// ------------------------------------------------------------------ camera animation
let camTarget: { x: number; y: number; zoom: number } | null = null;
function animateCamera(wx: number, wy: number, zoom: number) {
  camTarget = { x: wx, y: wy, zoom };
}

game.events.on("change", () => {
  if (!game.cameraState) frameTown();
});

// ------------------------------------------------------------------ input
let dragging = false;
let dragMoved = false;
let last = { x: 0, y: 0 };
let hover: string | undefined;
let mouse: { x: number; y: number } | undefined;

canvas.addEventListener("mousedown", (e) => {
  dragging = true;
  dragMoved = false;
  last = { x: e.clientX, y: e.clientY };
  camTarget = null;
});
window.addEventListener("mousemove", (e) => {
  if (dragging) {
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
    cam.pan(dx, dy);
    last = { x: e.clientX, y: e.clientY };
  } else {
    mouse = { x: e.clientX, y: e.clientY };
    hover = e.target === canvas ? renderer.pick(e.clientX, e.clientY)?.id : undefined;
    canvas.style.cursor = hover ? "pointer" : "grab";
  }
});
window.addEventListener("mouseup", (e) => {
  if (!dragging) return;
  dragging = false;
  if (dragMoved) {
    saveCamera();
    return;
  }
  const b = renderer.pick(e.clientX, e.clientY);
  if (game.pendingCable) {
    if (b && game.unlockedBuildings.has(b.id)) {
      game.select(b.id);
      game.openWorkspace(b.id);
    } else game.toast("Pick an unlocked building for the far end of the cable.", "info");
    return;
  }
  game.select(b?.id);
});
canvas.addEventListener("dblclick", (e) => {
  const b = renderer.pick(e.clientX, e.clientY);
  if (b && game.unlockedBuildings.has(b.id)) {
    game.select(b.id);
    game.openWorkspace(b.id);
  }
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    camTarget = null;
    cam.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    saveCamera();
  },
  { passive: false }
);
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
    if (e.key === "Escape") (e.target as HTMLElement).blur();
    return;
  }
  if (e.key === "Escape") {
    if (panels.isModalOpen()) panels.closeModal();
    else if (game.workspace) workspace.close();
    else if (game.pendingCable) {
      game.pendingCable = undefined;
      game.toast("Cable put away.");
    } else game.select(undefined);
  }
  if (e.key === "Enter" && game.selected && !game.workspace && game.unlockedBuildings.has(game.selected)) game.openWorkspace(game.selected);
  const step = 40;
  if (e.key === "ArrowLeft" || e.key === "a") cam.pan(step, 0);
  if (e.key === "ArrowRight" || e.key === "d") cam.pan(-step, 0);
  if (e.key === "ArrowUp" || e.key === "w") cam.pan(0, step);
  if (e.key === "ArrowDown" || e.key === "s") cam.pan(0, -step);
  if (e.key === " ") {
    game.paused = !game.paused;
    game.toast(game.paused ? "Paused" : "Resumed");
  }
});
window.addEventListener("resize", () => {
  const centre = cam.toWorld(cam.width / 2, cam.height / 2);
  renderer.resize();
  if (game.cameraState) cam.centerOn(centre.x, centre.y);
  else frameTown();
});

let saveTimer: number | undefined;
function saveCamera() {
  game.cameraState = { ox: cam.ox, oy: cam.oy, zoom: cam.zoom };
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => game.save(), 500);
}

// Touch support: one finger pans, two fingers pinch.
let touches: Touch[] = [];
let pinchDist = 0;
canvas.addEventListener("touchstart", (e) => {
  touches = [...e.touches];
  if (touches.length === 2) pinchDist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}, { passive: true });
canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  const t = [...e.touches];
  if (t.length === 1 && touches.length === 1) cam.pan(t[0].clientX - touches[0].clientX, t[0].clientY - touches[0].clientY);
  if (t.length === 2) {
    const d = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    cam.zoomAt((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2, d / (pinchDist || d));
    pinchDist = d;
  }
  touches = t;
}, { passive: false });
canvas.addEventListener("touchend", (e) => {
  if (touches.length === 1 && e.touches.length === 0) {
    const b = renderer.pick(touches[0].clientX, touches[0].clientY);
    if (b) game.select(b.id);
  }
  touches = [...e.touches];
  saveCamera();
});

// ------------------------------------------------------------------ loop
let lastT = performance.now();
let personPhase = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  game.tick(dt);
  personPhase += dt * 10;

  if (camTarget) {
    const cur = cam.toWorld(cam.width / 2, cam.height / 2);
    const nx = cur.x + (camTarget.x - cur.x) * 0.12;
    const ny = cur.y + (camTarget.y - cur.y) * 0.12;
    cam.zoom += (camTarget.zoom - cam.zoom) * 0.12;
    cam.centerOn(nx, ny);
    if (Math.abs(camTarget.x - cur.x) < 0.02 && Math.abs(camTarget.y - cur.y) < 0.02) {
      camTarget = null;
      saveCamera();
    }
  }

  const state: RenderState = {
    time: game.time,
    light: game.light,
    dayFrac: game.dayFrac,
    buildings: game.buildingVisuals(),
    cables: game.cables,
    packets: game.packets,
    people: game.people.list.map((p) => {
      const pos = game.people.position(p);
      return { x: pos.x, y: pos.y, color: p.color, skin: p.skin, phase: personPhase * p.speed + p.id };
    }),
    vehicles: game.vehicles.list.map((v) => {
      const pos = game.vehicles.position(v);
      return { ...pos, color: v.color, kind: v.kind };
    }),
    rain: game.rain,
    selected: game.selected,
    hoverBuilding: game.workspace ? undefined : hover,
    mouse,
    focus: game.workspace ? undefined : game.focus,
    showNetwork: game.overlays.network,
    showLabels: game.overlays.labels,
    showTraffic: game.overlays.traffic,
    cableTargetMode: !!game.pendingCable,
  };
  renderer.draw(state);
  panels.tick(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Expose for debugging in the console.
(window as unknown as { game: Game }).game = game;
