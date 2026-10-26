// Isometric projection and camera (pan + zoom).

export const TW = 64; // tile width on screen at zoom 1
export const TH = 32; // tile height on screen at zoom 1

export class Camera {
  ox = 0; // screen offset
  oy = 0;
  zoom = 1;
  minZoom = 0.5;
  maxZoom = 2.6;

  constructor(public width: number, public height: number) {}

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
  }

  toScreen(wx: number, wy: number, wz = 0): { x: number; y: number } {
    return {
      x: (wx - wy) * (TW / 2) * this.zoom + this.ox,
      y: ((wx + wy) * (TH / 2) - wz) * this.zoom + this.oy,
    };
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    const a = (sx - this.ox) / ((TW / 2) * this.zoom); // x - y
    const b = (sy - this.oy) / ((TH / 2) * this.zoom); // x + y
    return { x: (a + b) / 2, y: (b - a) / 2 };
  }

  centerOn(wx: number, wy: number) {
    const s = { x: (wx - wy) * (TW / 2) * this.zoom, y: (wx + wy) * (TH / 2) * this.zoom };
    this.ox = this.width / 2 - s.x;
    this.oy = this.height / 2 - s.y;
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    const after = this.toScreen(before.x, before.y);
    this.ox += sx - after.x;
    this.oy += sy - after.y;
  }

  pan(dx: number, dy: number) {
    this.ox += dx;
    this.oy += dy;
  }
}
