import { clamp } from '../lib/random';

/** Камера: центр в координатах мира + масштаб (экранных пикселей на единицу мира). */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  /** Плавное движение к цели (для «следить» и прыжков по миникарте). */
  private tx: number | null = null;
  private ty: number | null = null;

  constructor(
    public worldW: number,
    public worldH: number,
  ) {
    this.x = worldW / 2;
    this.y = worldH / 2;
  }

  /** Экран (CSS-пиксели) → мир. */
  toWorld(sx: number, sy: number, w: number, h: number): [number, number] {
    return [(sx - w / 2) / this.zoom + this.x, (sy - h / 2) / this.zoom + this.y];
  }

  minZoom(w: number, h: number): number {
    return Math.min(w / this.worldW, h / this.worldH) * 0.95;
  }

  fit(w: number, h: number): void {
    this.zoom = this.minZoom(w, h);
    this.x = this.worldW / 2;
    this.y = this.worldH / 2;
  }

  zoomAt(factor: number, sx: number, sy: number, w: number, h: number): void {
    const [wx, wy] = this.toWorld(sx, sy, w, h);
    this.zoom = clamp(this.zoom * factor, this.minZoom(w, h), 6);
    // точка под курсором остаётся на месте
    this.x = wx - (sx - w / 2) / this.zoom;
    this.y = wy - (sy - h / 2) / this.zoom;
    this.clampTo(w, h);
  }

  pan(dx: number, dy: number, w: number, h: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.tx = this.ty = null;
    this.clampTo(w, h);
  }

  flyTo(x: number, y: number, zoom?: number): void {
    this.tx = x;
    this.ty = y;
    if (zoom) this.zoom = Math.max(this.zoom, zoom);
  }

  follow(x: number, y: number): void {
    this.tx = x;
    this.ty = y;
  }

  update(w: number, h: number): void {
    if (this.tx !== null && this.ty !== null) {
      this.x += (this.tx - this.x) * 0.15;
      this.y += (this.ty - this.y) * 0.15;
      if (Math.abs(this.tx - this.x) < 0.5 && Math.abs(this.ty - this.y) < 0.5) this.tx = this.ty = null;
    }
    this.clampTo(w, h);
  }

  private clampTo(w: number, h: number): void {
    const hw = w / 2 / this.zoom;
    const hh = h / 2 / this.zoom;
    this.x = hw * 2 >= this.worldW ? this.worldW / 2 : clamp(this.x, hw, this.worldW - hw);
    this.y = hh * 2 >= this.worldH ? this.worldH / 2 : clamp(this.y, hh, this.worldH - hh);
  }
}
