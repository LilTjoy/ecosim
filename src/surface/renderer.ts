import { clamp, mulberry32, Noise } from '../lib/random';
import { B, BIOMES } from '../sim/terrain';
import type { Creature, Fx, World } from '../sim/world';
import type { Camera } from './camera';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  kind: 'heart' | 'spark' | 'ring' | 'blast' | 'star' | 'leaf';
  hue: number;
}

const BAKE_SCALE = 0.5; // пикселей текстуры на единицу мира
const TILE_PX = 512;
/** Во сколько раз слой травы детальнее сетки клеток (сглаживание). */
const OV = 3;

interface TilePair {
  ground: HTMLCanvasElement;
  deco: HTMLCanvasElement;
}

/** Быстрый детерминированный шум 0..1 по координатам. */
function hash2(x: number, y: number): number {
  let h = (Math.floor(x * 4) * 374761393 + Math.floor(y * 4) * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Deco {
  kind: 'tree' | 'acacia' | 'bush' | 'reed' | 'cactus' | 'rock' | 'snowrock' | 'flower' | 'pebble';
  x: number;
  y: number;
  s: number;
  v: number;
}

/** Рисует поверхность: запечённый рельеф, траву и снег, существ, эффекты, ночь. */
export class SurfaceRenderer {
  private ctx: CanvasRenderingContext2D;
  private bake!: HTMLCanvasElement;
  private overlay!: HTMLCanvasElement;
  /** Реки общего плана (тот же масштаб, что и bake). */
  private riverLayer!: HTMLCanvasElement;
  /** Узлы русел: смещённые центры клеток (меандры) и главный приток каждой клетки. */
  private rivX = new Float32Array(0);
  private rivY = new Float32Array(0);
  private rivUp = new Int32Array(0);
  private overlayCtx!: CanvasRenderingContext2D;
  private overlayImg!: ImageData;
  miniBase!: HTMLCanvasElement;
  private particles: Particle[] = [];
  private frame = 0;
  /** id вида, который подсвечен (остальные приглушены). */
  focusSpecies: number | null = null;
  private tiles = new Map<string, TilePair>();
  private cellCol = new Float32Array(0);
  private micro = new Noise(1234);
  private tileBudget = 0;
  private grain = this.makeGrain();

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    private cam: Camera,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.rebuild();
  }

  /** Перерисовать рельеф (новый мир). */
  rebuild(): void {
    const t = this.world.terrain;
    const W = Math.round(this.world.width * BAKE_SCALE);
    const H = Math.round(this.world.height * BAKE_SCALE);
    this.bake = document.createElement('canvas');
    this.bake.width = W;
    this.bake.height = H;
    const g = this.bake.getContext('2d')!;
    const img = g.createImageData(W, H);
    const d = img.data;
    const f = { e: 0, m: 0, t: 0 };
    const rnd = mulberry32(this.world.seed + 5);
    const elev = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        t.fieldsAt(x / BAKE_SCALE, y / BAKE_SCALE, f);
        elev[y * W + x] = f.e;
      }
    }
    const sea = t.seaLevel;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        t.fieldsAt(x / BAKE_SCALE, y / BAKE_SCALE, f);
        const b = t.classify(f.e, f.m, f.t);
        const info = BIOMES[b];
        let [r, gg, bb] = info.ground;
        const n = (rnd() - 0.5) * 10;
        if (info.water) {
          // глубина — темнее, у берега — светлее
          const depth = clamp((sea - f.e) * 8, 0, 1);
          r = 52 - depth * 32;
          gg = 112 - depth * 62;
          bb = 150 - depth * 52;
          // пена у берега
          if (sea - f.e < 0.004) {
            r += 50;
            gg += 50;
            bb += 40;
          }
        } else {
          // рельеф: освещение с северо-запада
          const ex = elev[i + (x < W - 1 ? 1 : 0)] - elev[i - (x > 0 ? 1 : 0)];
          const ey = elev[i + (y < H - 1 ? W : 0)] - elev[i - (y > 0 ? W : 0)];
          const shade = clamp(1 - (ex + ey) * 60, 0.7, 1.35);
          r *= shade;
          gg *= shade;
          bb *= shade;
        }
        d[i * 4] = clamp(r + n, 0, 255);
        d[i * 4 + 1] = clamp(gg + n, 0, 255);
        d[i * 4 + 2] = clamp(bb + n, 0, 255);
        d[i * 4 + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.buildRivers();
    this.decorate(g);
    this.tiles.clear();

    // реки — отдельным слоем поверх травы
    this.riverLayer = document.createElement('canvas');
    this.riverLayer.width = W;
    this.riverLayer.height = H;
    const rg = this.riverLayer.getContext('2d')!;
    rg.scale(BAKE_SCALE, BAKE_SCALE);
    this.strokeRivers(rg, 0, t.cols - 1, 0, t.rows - 1, false, 1.8);

    // слой травы/снега — по клеткам, растягивается со сглаживанием
    this.overlay = document.createElement('canvas');
    this.overlay.width = t.cols * OV;
    this.overlay.height = t.rows * OV;
    this.overlayCtx = this.overlay.getContext('2d')!;
    this.overlayImg = this.overlayCtx.createImageData(t.cols * OV, t.rows * OV);
    this.cellCol = new Float32Array(t.cols * t.rows * 4);
    this.updateOverlay();

    // основа миникарты
    this.miniBase = document.createElement('canvas');
    this.miniBase.width = 240;
    this.miniBase.height = Math.round((240 * this.world.height) / this.world.width);
    const mg = this.miniBase.getContext('2d')!;
    mg.drawImage(this.bake, 0, 0, this.miniBase.width, this.miniBase.height);
    // на миникарте реки тоньше пикселя — рисуем заново, не тоньше 1 px
    const ms = this.miniBase.width / this.world.width;
    mg.scale(ms, ms);
    mg.lineCap = mg.lineJoin = 'round';
    mg.strokeStyle = 'rgba(79,143,192,0.9)';
    for (let i = 0; i < t.river.length; i++) {
      if (t.river[i] < 2 || t.flow[i] < 160 || t.drain[i] < 0) continue;
      mg.lineWidth = Math.max(0.8, Math.min(1.6, 0.5 + Math.sqrt(t.flow[i] / 2000))) / ms;
      this.riverSegment(mg, i);
      mg.stroke();
    }
  }

  /** Узлы русел: центр клетки, сдвинутый поперёк течения плавным шумом, — реки петляют. */
  private buildRivers(): void {
    const t = this.world.terrain;
    const n = t.cols * t.rows;
    const cell = this.world.cell;
    this.rivX = new Float32Array(n);
    this.rivY = new Float32Array(n);
    this.rivUp = new Int32Array(n).fill(-1);
    const nz = new Noise(this.world.seed + 77);
    for (let i = 0; i < n; i++) {
      const cx = i % t.cols;
      const cy = (i / t.cols) | 0;
      let x = (cx + 0.5) * cell;
      let y = (cy + 0.5) * cell;
      const d = t.drain[i];
      if (t.river[i] >= 1 && d >= 0) {
        const dx = (d % t.cols) - cx;
        const dy = ((d / t.cols) | 0) - cy;
        const l = Math.hypot(dx, dy);
        const off = clamp((nz.fbm(cx * 0.21, cy * 0.21, 2) - 0.5) * 1.5 + (hash2(cx, cy) - 0.5) * 0.12, -0.42, 0.42) * cell;
        x += (-dy / l) * off;
        y += (dx / l) * off;
        // главный приток — самый полноводный
        const u = this.rivUp[d];
        if (u < 0 || t.flow[i] > t.flow[u]) this.rivUp[d] = i;
      }
      this.rivX[i] = x;
      this.rivY[i] = y;
    }
  }

  /** Путь одного отрезка русла: от середины с главным притоком — через узел — к середине с низовьем. */
  private riverSegment(g: CanvasRenderingContext2D, i: number): void {
    const t = this.world.terrain;
    const X = this.rivX;
    const Y = this.rivY;
    const d = t.drain[i];
    const u = this.rivUp[i];
    const px = X[i];
    const py = Y[i];
    const ex = (px + X[d]) / 2;
    const ey = (py + Y[d]) / 2;
    g.beginPath();
    if (u >= 0) g.moveTo((X[u] + px) / 2, (Y[u] + py) / 2);
    else g.moveTo(px, py);
    g.quadraticCurveTo(px, py, ex, ey);
    // приток или устье: дотягиваем до узла низовья
    if (this.rivUp[d] !== i) g.lineTo(X[d], Y[d]);
  }

  /**
   * Реки и ручьи в мировых координатах для клеток прямоугольника.
   * Ширина растёт со стоком, ручьи сужаются к истокам.
   */
  private strokeRivers(g: CanvasRenderingContext2D, c0: number, c1: number, r0: number, r1: number, streams: boolean, wk = 1): void {
    const t = this.world.terrain;
    const width = (f: number) => clamp(0.8 + 0.35 * Math.sqrt(f / 80), 1, 4.5) * wk;
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const each = (min: number, max: number, fn: (i: number) => void) => {
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const i = cy * t.cols + cx;
          if (t.river[i] >= min && t.river[i] <= max && t.drain[i] >= 0) fn(i);
        }
      }
    };
    if (streams) {
      // ручьи: тонкие, от истока к устью шире
      g.strokeStyle = 'rgba(79,143,192,0.7)';
      each(1, 1, (i) => {
        g.lineWidth = 0.35 + 0.6 * clamp((t.flow[i] - 18) / 62, 0, 1);
        this.riverSegment(g, i);
        g.stroke();
      });
    }
    // берега: влажная тёмная кромка
    g.strokeStyle = 'rgba(38,58,34,0.32)';
    each(2, 2, (i) => {
      g.lineWidth = width(t.flow[i]) + 1.8 * wk;
      this.riverSegment(g, i);
      g.stroke();
    });
    g.strokeStyle = '#2f5f86';
    each(2, 2, (i) => {
      g.lineWidth = width(t.flow[i]);
      this.riverSegment(g, i);
      g.stroke();
    });
    g.strokeStyle = '#4f8fc0';
    each(2, 2, (i) => {
      g.lineWidth = width(t.flow[i]) * 0.6;
      this.riverSegment(g, i);
      g.stroke();
    });
    g.restore();
  }

  /**
   * Украшения клетки (деревья, камни, кактусы…) — детерминированно по её координатам,
   * чтобы на общем плане и при приближении всё стояло на тех же местах.
   */
  private decoItems(cx: number, cy: number): Deco[] {
    const t = this.world.terrain;
    const i = cy * t.cols + cx;
    const b = t.biome[i] as B;
    const r = mulberry32((this.world.seed * 7919) ^ (cx * 73856093) ^ (cy * 19349663));
    const cell = this.world.cell;
    const out: Deco[] = [];
    const add = (kind: Deco['kind'], n: number, size: [number, number]) => {
      const k = Math.floor(n) + (r() < n % 1 ? 1 : 0);
      for (let q = 0; q < k; q++) {
        out.push({ kind, x: (cx + r()) * cell, y: (cy + r()) * cell, s: size[0] + r() * (size[1] - size[0]), v: r() });
      }
    };
    if (b === B.Forest) add('tree', 2.4, [5, 10]);
    else if (b === B.Swamp) {
      add('reed', 1.2, [3, 6]);
      add('tree', 0.35, [4, 7]);
    } else if (b === B.Desert) add('cactus', 0.12, [3, 5]);
    else if (b === B.Mountain) add('rock', 0.7, [3, 8]);
    else if (b === B.Snow) add('snowrock', 0.6, [3, 8]);
    else if (b === B.Grass) {
      add('flower', 0.6, [0.6, 1.2]);
      add('bush', 0.08, [3, 5]);
    } else if (b === B.Savanna) {
      add('acacia', 0.06, [5, 8]);
      add('bush', 0.1, [2, 4]);
    } else if (b === B.Tundra) {
      add('pebble', 0.4, [1, 2.5]);
      add('bush', 0.15, [2, 3]);
    } else if (b === B.Beach) add('pebble', 0.3, [0.8, 1.6]);
    // в русле деревья не растут, а кроны соседних клеток не закрывают реку
    if (t.river[i] >= 2) return out.filter((d) => d.kind !== 'tree' && d.kind !== 'acacia' && d.kind !== 'reed');
    return out.filter((d) => (d.kind !== 'tree' && d.kind !== 'acacia') || !this.nearRiver(d.x, d.y, d.s * 0.75 + 2.5));
  }

  /** Есть ли русло реки ближе r к точке (по узлам и серединам отрезков соседних клеток). */
  private nearRiver(x: number, y: number, r: number): boolean {
    const t = this.world.terrain;
    const cell = this.world.cell;
    const X = this.rivX;
    const Y = this.rivY;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const r2 = r * r;
    for (let yy = Math.max(0, cy - 1); yy <= Math.min(t.rows - 1, cy + 1); yy++) {
      for (let xx = Math.max(0, cx - 1); xx <= Math.min(t.cols - 1, cx + 1); xx++) {
        const j = yy * t.cols + xx;
        if (t.river[j] < 2) continue;
        const d = t.drain[j];
        for (let k = 0; k <= 2; k++) {
          const px = X[j] + ((X[d] - X[j]) * k) / 4 - x;
          const py = Y[j] + ((Y[d] - Y[j]) * k) / 4 - y;
          if (px * px + py * py < r2) return true;
        }
      }
    }
    return false;
  }

  /** Нарисовать украшения в мировых координатах (контекст уже отмасштабирован). */
  private drawDeco(g: CanvasRenderingContext2D, d: Deco, detail: number): void {
    const { x, y, s, v } = d;
    switch (d.kind) {
      case 'tree': {
        g.fillStyle = 'rgba(0,0,0,0.28)';
        g.beginPath();
        g.ellipse(x + s * 0.35, y + s * 0.45, s, s * 0.8, 0, 0, Math.PI * 2);
        g.fill();
        const sh = 26 + v * 26;
        g.fillStyle = `rgb(${sh * 0.55},${sh + 46},${sh * 0.55})`;
        g.beginPath();
        g.arc(x, y, s, 0, Math.PI * 2);
        g.fill();
        if (detail > 1.5) {
          // крона из нескольких «шапок» листвы
          g.fillStyle = `rgba(${70 + v * 30},${140 + v * 30},${60},0.55)`;
          for (let k = 0; k < 4; k++) {
            const a = v * 6 + k * 1.7;
            g.beginPath();
            g.arc(x + Math.cos(a) * s * 0.45, y + Math.sin(a) * s * 0.45, s * 0.42, 0, Math.PI * 2);
            g.fill();
          }
        }
        g.fillStyle = 'rgba(190,240,150,0.2)';
        g.beginPath();
        g.arc(x - s * 0.3, y - s * 0.3, s * 0.45, 0, Math.PI * 2);
        g.fill();
        break;
      }
      case 'acacia':
        g.fillStyle = 'rgba(0,0,0,0.22)';
        g.beginPath();
        g.ellipse(x + 2, y + 2, s * 1.3, s * 0.6, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = `rgb(${86 + v * 20},${116 + v * 20},48)`;
        g.beginPath();
        g.ellipse(x, y, s * 1.3, s * 0.6, 0, 0, Math.PI * 2);
        g.fill();
        break;
      case 'bush':
        g.fillStyle = `rgba(${50 + v * 30},${100 + v * 30},${45},0.9)`;
        g.beginPath();
        g.arc(x, y, s * 0.6, 0, Math.PI * 2);
        g.arc(x + s * 0.5, y + s * 0.2, s * 0.45, 0, Math.PI * 2);
        g.fill();
        break;
      case 'reed':
        g.strokeStyle = `rgba(${90 + v * 40},${120 + v * 30},60,0.8)`;
        g.lineWidth = 0.5;
        for (let k = 0; k < 3; k++) {
          g.beginPath();
          g.moveTo(x + k * 0.9, y);
          g.lineTo(x + k * 0.9 + (v - 0.5) * 2, y - s);
          g.stroke();
        }
        break;
      case 'cactus':
        g.fillStyle = 'rgba(0,0,0,0.2)';
        g.fillRect(x + 0.6, y - 0.2, s * 0.35, s * 0.25);
        g.fillStyle = 'rgb(70,118,62)';
        g.fillRect(x - s * 0.12, y - s, s * 0.24, s);
        g.fillRect(x - s * 0.45, y - s * 0.65, s * 0.18, s * 0.4);
        g.fillRect(x + s * 0.27, y - s * 0.75, s * 0.18, s * 0.45);
        break;
      case 'rock':
      case 'snowrock': {
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.beginPath();
        g.moveTo(x, y - s);
        g.lineTo(x + s, y + s * 0.6);
        g.lineTo(x - s * 0.2, y + s * 0.6);
        g.fill();
        g.fillStyle = d.kind === 'snowrock' ? 'rgb(245,248,252)' : `rgb(${130 + v * 40},${124 + v * 36},${118 + v * 30})`;
        g.beginPath();
        g.moveTo(x, y - s);
        g.lineTo(x - s * 0.2, y + s * 0.6);
        g.lineTo(x - s, y + s * 0.6);
        g.fill();
        break;
      }
      case 'flower':
        g.fillStyle = `hsla(${[50, 0, 280, 200, 330][Math.floor(v * 5)]},65%,${72 + v * 12}%,0.75)`;
        g.beginPath();
        g.arc(x, y, s * 0.5, 0, Math.PI * 2);
        g.fill();
        break;
      case 'pebble':
        g.fillStyle = `rgba(${150 + v * 50},${145 + v * 45},${140 + v * 40},0.8)`;
        g.beginPath();
        g.ellipse(x, y, s, s * 0.7, v * 3, 0, Math.PI * 2);
        g.fill();
        break;
    }
  }

  /** Деревья, камни, кактусы — в текстуру общего плана. */
  private decorate(g: CanvasRenderingContext2D): void {
    const t = this.world.terrain;
    g.save();
    g.scale(BAKE_SCALE, BAKE_SCALE);
    for (let cy = 0; cy < t.rows; cy++) for (let cx = 0; cx < t.cols; cx++) for (const d of this.decoItems(cx, cy)) this.drawDeco(g, d, 1);
    g.restore();
  }

  /** Детальный тайл (512 px) при приближении: чёткие деревья, камни и зерно почвы. */
  private tile(level: number, tx: number, ty: number): TilePair | null {
    const key = `${level}:${tx}:${ty}`;
    const cached = this.tiles.get(key);
    if (cached) {
      this.tiles.delete(key);
      this.tiles.set(key, cached); // LRU: свежий — в конец
      return cached;
    }
    if (this.tileBudget <= 0) return null;
    this.tileBudget--;
    const size = TILE_PX / level; // в единицах мира
    const ground = this.groundTile(tx * size, ty * size, size);
    const c = document.createElement('canvas');
    c.width = c.height = TILE_PX;
    const g = c.getContext('2d')!;
    // зерно почвы
    g.globalAlpha = 0.07;
    g.fillStyle = g.createPattern(this.grain, 'repeat')!;
    g.fillRect(0, 0, TILE_PX, TILE_PX);
    g.globalAlpha = 1;
    g.setTransform(level, 0, 0, level, -tx * size * level, -ty * size * level);
    const t = this.world.terrain;
    const cell = this.world.cell;
    const c0 = Math.max(0, Math.floor((tx * size - 12) / cell));
    const c1 = Math.min(t.cols - 1, Math.floor(((tx + 1) * size + 12) / cell));
    const r0 = Math.max(0, Math.floor((ty * size - 12) / cell));
    const r1 = Math.min(t.rows - 1, Math.floor(((ty + 1) * size + 12) / cell));
    // реки чётко, до деревьев (кроны нависают над водой)
    this.strokeRivers(g, Math.max(0, c0 - 1), Math.min(t.cols - 1, c1 + 1), Math.max(0, r0 - 1), Math.min(t.rows - 1, r1 + 1), true, 1.2);
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) for (const d of this.decoItems(cx, cy)) this.drawDeco(g, d, level);
    const pair = { ground, deco: c };
    this.tiles.set(key, pair);
    if (this.tiles.size > 48) this.tiles.delete(this.tiles.keys().next().value!);
    return pair;
  }

  /**
   * Рельеф тайла в высоком разрешении: та же функция, что и у общего плана,
   * плюс микрорельеф — он даёт чёткую изрезанную кромку берега и фактуру склонов.
   */
  private groundTile(x0: number, y0: number, size: number): HTMLCanvasElement {
    const N = 256;
    const t = this.world.terrain;
    const step = size / N;
    const E = new Float32Array((N + 2) * (N + 2));
    const f = { e: 0, m: 0, t: 0 };
    const micro = this.micro;
    for (let j = 0; j < N + 2; j++) {
      for (let i = 0; i < N + 2; i++) {
        const x = x0 + (i - 0.5) * step;
        const y = y0 + (j - 0.5) * step;
        t.fieldsAt(x, y, f);
        E[j * (N + 2) + i] = f.e + (micro.fbm(x / 22, y / 22, 3) - 0.5) * 0.012;
      }
    }
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d')!;
    const img = g.createImageData(N, N);
    const d = img.data;
    const sea = t.seaLevel;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = x0 + (i + 0.5) * step;
        const y = y0 + (j + 0.5) * step;
        t.fieldsAt(x, y, f);
        const e = E[(j + 1) * (N + 2) + i + 1];
        const b = t.classify(e, f.m, f.t);
        const info = BIOMES[b];
        let [r, gg, bb] = info.ground;
        const n = (hash2(x, y) - 0.5) * 12;
        if (info.water) {
          const depth = clamp((sea - e) * 8, 0, 1);
          r = 52 - depth * 32;
          gg = 112 - depth * 62;
          bb = 150 - depth * 52;
          if (sea - e < 0.0025) {
            r += 70;
            gg += 70;
            bb += 55;
          }
        } else {
          const ex = E[(j + 1) * (N + 2) + i + 2] - E[(j + 1) * (N + 2) + i];
          const ey = E[(j + 2) * (N + 2) + i + 1] - E[j * (N + 2) + i + 1];
          const shade = clamp(1 - ((ex + ey) * 60) / step, 0.65, 1.4);
          r *= shade;
          gg *= shade;
          bb *= shade;
        }
        const o = (j * N + i) * 4;
        d[o] = clamp(r + n, 0, 255);
        d[o + 1] = clamp(gg + n, 0, 255);
        d[o + 2] = clamp(bb + n, 0, 255);
        d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  private makeGrain(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const img = g.createImageData(128, 128);
    const r = mulberry32(99);
    for (let i = 0; i < 128 * 128; i++) {
      const v = r() < 0.5 ? 0 : 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = r() * 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /** Трава, снег и лёд по клеткам — меняются с сезонами. */
  /** Цвет травы/снега/льда клетки (RGBA 0..255). */
  private cellColor(i: number, out: Float32Array, o: number): void {
    const w = this.world;
    const t = w.terrain;
    const b = BIOMES[t.biome[i]];
    const temp = t.baseTemp[i] + w.season.shift;
    const snow = clamp((0.1 - temp) / 0.08, 0, 1);
    if (b.water) {
      // лёд на воде зимой
      const ice = clamp((0.04 - temp) / 0.05, 0, 1);
      out[o] = 225;
      out[o + 1] = 238;
      out[o + 2] = 248;
      out[o + 3] = ice * 220;
      return;
    }
    const gr = clamp(w.grass[i] / Math.max(0.05, b.fert), 0, 1) * Math.min(1, b.fert * 1.6);
    const [pr, pg, pb] = b.plant;
    // осенью трава желтеет
    const autumn = clamp((0.25 - temp) * 3, 0, 0.5);
    let r = pr + (200 - pr) * autumn;
    let g = pg + (170 - pg) * autumn;
    let bb = pb * (1 - autumn);
    let a = gr * 0.85;
    if (snow > 0) {
      r = r + (240 - r) * snow;
      g = g + (245 - g) * snow;
      bb = bb + (250 - bb) * snow;
      a = Math.max(a, snow * 0.9);
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = bb;
    out[o + 3] = a * 255;
  }

  /** Трава, снег и лёд — меняются с сезонами. Сглаживаем между клетками, чтобы не было «шашечек». */
  updateOverlay(): void {
    const t = this.world.terrain;
    const C = this.cellCol;
    for (let i = 0; i < t.cols * t.rows; i++) this.cellColor(i, C, i * 4);
    const W = t.cols * OV;
    const H = t.rows * OV;
    const d = this.overlayImg.data;
    for (let y = 0; y < H; y++) {
      const fy = clamp((y + 0.5) / OV - 0.5, 0, t.rows - 1.001);
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = clamp((x + 0.5) / OV - 0.5, 0, t.cols - 1.001);
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const a = (y0 * t.cols + x0) * 4;
        const b = a + 4;
        const c = a + t.cols * 4;
        const e = c + 4;
        const o = (y * W + x) * 4;
        for (let k = 0; k < 4; k++) {
          d[o + k] = (C[a + k] * (1 - tx) + C[b + k] * tx) * (1 - ty) + (C[c + k] * (1 - tx) + C[e + k] * tx) * ty;
        }
      }
    }
    this.overlayCtx.putImageData(this.overlayImg, 0, 0);
  }

  /** Травинки при сильном приближении: густота = сколько травы осталось в клетке. */
  private drawGrassBlades(x0: number, y0: number, x1: number, y1: number): void {
    const ctx = this.ctx;
    const w = this.world;
    const t = w.terrain;
    const cell = w.cell;
    const shift = w.season.shift;
    ctx.lineWidth = 0.35;
    ctx.lineCap = 'round';
    const wind = Math.sin(w.tick / 30) * 0.6;
    for (let cy = Math.max(0, Math.floor(y0 / cell)); cy <= Math.min(t.rows - 1, Math.floor(y1 / cell)); cy++) {
      for (let cx = Math.max(0, Math.floor(x0 / cell)); cx <= Math.min(t.cols - 1, Math.floor(x1 / cell)); cx++) {
        const i = cy * t.cols + cx;
        const b = BIOMES[t.biome[i]];
        if (b.water || b.fert < 0.2) continue;
        const temp = t.baseTemp[i] + shift;
        if (temp < 0.06) continue; // под снегом
        const frac = clamp(w.grass[i] / b.fert, 0, 1);
        const n = Math.round(frac * 9);
        if (!n) continue;
        const autumn = clamp((0.25 - temp) * 3, 0, 0.5);
        const [pr, pg, pb] = b.plant;
        ctx.strokeStyle = `rgb(${(pr + (210 - pr) * autumn) * 0.8},${(pg + (180 - pg) * autumn) * 0.85},${pb * 0.7})`;
        const r = mulberry32(i * 2654435761);
        ctx.beginPath();
        for (let k = 0; k < n; k++) {
          const x = (cx + r()) * cell;
          const y = (cy + r()) * cell;
          const len = 1.2 + r() * 2 * frac;
          ctx.moveTo(x, y);
          ctx.lineTo(x + wind * len * 0.4 + (r() - 0.5), y - len);
        }
        ctx.stroke();
      }
    }
  }

  /** Подхватить мгновенные события мира и превратить их в частицы. */
  private consumeFx(): void {
    for (const e of this.world.fx) this.spawnFx(e);
    this.world.fx.length = 0;
  }

  private spawnFx(e: Fx): void {
    const P = this.particles;
    if (P.length > 600) return;
    if (e.kind === 'mate') {
      for (let i = 0; i < 2; i++) P.push({ x: e.x, y: e.y, vx: (Math.random() - 0.5) * 0.4, vy: -0.4 - Math.random() * 0.3, life: 0, max: 60, kind: 'heart', hue: 340 });
    } else if (e.kind === 'birth') {
      P.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: 0, max: 30, kind: 'ring', hue: e.hue });
    } else if (e.kind === 'kill') {
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2;
        P.push({ x: e.x, y: e.y, vx: Math.cos(a) * 0.8, vy: Math.sin(a) * 0.8, life: 0, max: 25, kind: 'spark', hue: 0 });
      }
    } else if (e.kind === 'meteor') {
      P.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: 0, max: 90, kind: 'blast', hue: 30 });
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 1 + Math.random() * 4;
        P.push({ x: e.x, y: e.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 60, kind: 'spark', hue: 30 });
      }
    } else if (e.kind === 'newSpecies') {
      for (let i = 0; i < 3; i++) P.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: -i * 15, max: 70, kind: 'star', hue: e.hue });
    }
  }

  draw(selected: Creature | null, family: Set<number>, cursorWorld: [number, number] | null): void {
    const { ctx, canvas, cam, world } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    this.frame++;
    if (this.frame % 12 === 0) this.updateOverlay();
    this.consumeFx();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, W, H);
    // мир → экран
    const z = cam.zoom;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cam.x * z), dpr * (H / 2 - cam.y * z));
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.bake, 0, 0, world.width, world.height);
    // при приближении — чёткие детальные тайлы поверх размытой подложки
    const px = z * dpr;
    const shown: [TilePair, number, number, number][] = [];
    if (px > 1.1) {
      const level = px > 5 ? 8 : px > 2.5 ? 4 : 2;
      const size = TILE_PX / level;
      const vx0 = cam.x - W / 2 / z;
      const vy0 = cam.y - H / 2 / z;
      this.tileBudget = 2; // не больше 2 новых тайлов за кадр — без рывков
      for (let ty = Math.max(0, Math.floor(vy0 / size)); ty <= Math.min(Math.ceil(world.height / size) - 1, Math.floor((vy0 + H / z) / size)); ty++) {
        for (let tx = Math.max(0, Math.floor(vx0 / size)); tx <= Math.min(Math.ceil(world.width / size) - 1, Math.floor((vx0 + W / z) / size)); tx++) {
          const t = this.tile(level, tx, ty);
          if (t) {
            ctx.drawImage(t.ground, tx * size, ty * size, size, size);
            shown.push([t, tx * size, ty * size, size]);
          }
        }
      }
    }
    ctx.drawImage(this.overlay, 0, 0, world.width, world.height);
    // реки поверх травы и линз; там, где уже есть чёткий тайл, — реки рисует тайл
    if (shown.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, world.width, world.height);
      for (const [, x, y, size] of shown) ctx.rect(x, y, size, size);
      ctx.clip('evenodd');
      ctx.drawImage(this.riverLayer, 0, 0, world.width, world.height);
      ctx.restore();
    } else ctx.drawImage(this.riverLayer, 0, 0, world.width, world.height);
    if (px > 2.5) this.drawGrassBlades(cam.x - W / 2 / z, cam.y - H / 2 / z, cam.x + W / 2 / z, cam.y + H / 2 / z);
    for (const [t, x, y, size] of shown) ctx.drawImage(t.deco, x, y, size, size);

    // видимая область (с запасом)
    const x0 = cam.x - W / 2 / z - 30;
    const x1 = cam.x + W / 2 / z + 30;
    const y0 = cam.y - H / 2 / z - 30;
    const y1 = cam.y + H / 2 / z + 30;
    const vis = (x: number, y: number) => x > x0 && x < x1 && y > y0 && y < y1;

    // падаль — косточки
    if (z > 0.6) {
      ctx.strokeStyle = 'rgba(235,228,210,0.85)';
      ctx.lineWidth = 1;
      for (const k of world.corpses) {
        if (!vis(k.x, k.y)) continue;
        const r = Math.max(2, k.size * 0.8);
        ctx.beginPath();
        ctx.moveTo(k.x - r, k.y - r * 0.5);
        ctx.lineTo(k.x + r, k.y + r * 0.5);
        ctx.moveTo(k.x - r, k.y + r * 0.5);
        ctx.lineTo(k.x + r, k.y - r * 0.5);
        ctx.stroke();
      }
    }

    if (selected?.alive) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1 / z;
      ctx.setLineDash([5 / z, 5 / z]);
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, selected.g.sense, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const detail = z >= 0.9;
    const night = 1 - world.daylight;
    for (const c of world.creatures) {
      if (!vis(c.x, c.y)) continue;
      const dim = this.focusSpecies !== null && c.sp !== this.focusSpecies;
      if (family.has(c.id)) {
        ctx.strokeStyle = 'rgba(255,214,90,0.9)';
        ctx.lineWidth = 1.5 / z;
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.g.size * 1.6 + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = dim ? 0.25 : 1;
      if (detail && c.g.size * z > 2.5) this.drawAnimal(c);
      else this.drawDot(c, z);
    }
    ctx.globalAlpha = 1;

    this.drawParticles();

    // ночь: тёмно-синяя вуаль
    if (night > 0.02) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = `rgba(8,14,40,${night * 0.55})`;
      ctx.fillRect(0, 0, W, H);
      // глаза светятся в темноте
      if (detail && night > 0.3) {
        ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cam.x * z), dpr * (H / 2 - cam.y * z));
        ctx.fillStyle = `rgba(255,240,170,${(night - 0.3) * 1.2})`;
        for (const c of world.creatures) {
          if (!vis(c.x, c.y) || c.g.diet < 0.5) continue;
          const hx = c.x + Math.cos(c.heading) * c.g.size * 1.5;
          const hy = c.y + Math.sin(c.heading) * c.g.size * 1.5;
          ctx.fillRect(hx - 0.8, hy - 0.8, 1.6, 1.6);
        }
      }
    }
    // атмосфера звезды
    const [tr, tg, tb] = world.env.starTint;
    if (tr !== 1 || tg !== 1 || tb !== 1) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgb(${tr * 255},${tg * 255},${tb * 255})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cam.x * z), dpr * (H / 2 - cam.y * z));
    if (selected?.alive) {
      ctx.strokeStyle = selected.player ? '#ffd54f' : '#fff';
      ctx.lineWidth = 2 / z;
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, selected.g.size * 1.6 + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    const p = world.player;
    if (p?.alive) {
      // корона над вашим существом
      ctx.font = `${Math.max(12, 14 / z)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText('👑', p.x, p.y - p.g.size * 2 - 8 / z);
    }
    if (cursorWorld) {
      /* курсор кистей рисует view */
    }
  }

  private color(c: Creature, l = 55): string {
    const e = clamp(c.energy / this.world.maxEnergy(c.g), 0.2, 1);
    return `hsl(${c.g.hue}, ${35 + e * 35}%, ${l - (1 - e) * 15}%)`;
  }

  private drawDot(c: Creature, z: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = this.color(c);
    const r = Math.max(c.g.size * 1.2, 2.2 / z);
    if (c.g.diet > 0.65) {
      // хищники — ромбики, чтобы отличать издалека
      ctx.beginPath();
      ctx.moveTo(c.x, c.y - r * 1.2);
      ctx.lineTo(c.x + r, c.y);
      ctx.lineTo(c.x, c.y + r * 1.2);
      ctx.lineTo(c.x - r, c.y);
      ctx.fill();
    } else {
      ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
    }
  }

  /** Существо «по генам»: размер, уши травоядного или клыки хищника, полоски, плавники. */
  private drawAnimal(c: Creature): void {
    const ctx = this.ctx;
    const s = c.g.size * 1.25;
    const cos = Math.cos(c.heading);
    const sin = Math.sin(c.heading);
    const walk = Math.sin(c.age * 0.5 * Math.max(0.3, c.v)) * (c.v > 0.05 ? 1 : 0);
    const inWater = BIOMES[this.world.terrain.biome[this.world.terrain.index(c.x, c.y)]].water;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.heading);

    // тень
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(s * 0.15, s * 0.35, s * 1.2, s * 0.65, 0, 0, Math.PI * 2);
    ctx.fill();

    const body = this.color(c);
    const dark = `hsl(${c.g.hue}, 40%, 25%)`;
    const pred = c.g.diet > 0.65;
    const swim = c.g.swim > 0.6;

    if (inWater) {
      // круги на воде
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.ellipse(-s * 0.3, 0, s * 1.6 + walk, s * 1.1, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // лапы
      ctx.strokeStyle = dark;
      ctx.lineWidth = Math.max(0.6, s * 0.18);
      ctx.lineCap = 'round';
      for (const [lx, side, ph] of [[0.5, 1, 1], [0.5, -1, -1], [-0.55, 1, -1], [-0.55, -1, 1]] as const) {
        ctx.beginPath();
        ctx.moveTo(lx * s, side * s * 0.35);
        ctx.lineTo(lx * s + walk * ph * s * 0.35, side * s * 0.85);
        ctx.stroke();
      }
    }

    // хвост
    ctx.strokeStyle = body;
    ctx.lineWidth = Math.max(0.5, s * (swim ? 0.35 : 0.15));
    ctx.beginPath();
    ctx.moveTo(-s * 0.9, 0);
    ctx.quadraticCurveTo(-s * 1.4, walk * s * 0.4, -s * (swim ? 1.5 : 1.7), walk * s * 0.6 + (swim ? 0 : s * 0.1));
    ctx.stroke();
    if (swim) {
      // хвостовой плавник
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.moveTo(-s * 1.4, 0);
      ctx.lineTo(-s * 1.9, -s * 0.5);
      ctx.lineTo(-s * 1.9, s * 0.5);
      ctx.fill();
    }

    // тело
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, s, s * (pred ? 0.55 : 0.65), 0, 0, Math.PI * 2);
    ctx.fill();
    // узор: полоски или пятна
    ctx.save();
    ctx.clip();
    ctx.fillStyle = dark;
    ctx.globalAlpha *= 0.45;
    if (c.g.pattern > 0.66) {
      for (let i = -2; i <= 2; i++) ctx.fillRect(i * s * 0.32 - s * 0.06, -s, s * 0.12, s * 2);
    } else if (c.g.pattern < 0.33) {
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(((i % 2) - 0.5) * s * 0.8 + (i > 1 ? s * 0.3 : -s * 0.2), (i % 3 - 1) * s * 0.25, s * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    // спинной плавник у пловцов
    if (swim) {
      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.moveTo(s * 0.2, 0);
      ctx.lineTo(-s * 0.5, -s * 0.15);
      ctx.lineTo(-s * 0.5, s * 0.15);
      ctx.fill();
    }

    // голова
    const hx = s * 1.05;
    const hr = s * (pred ? 0.5 : 0.45);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(hx, 0, hr * (pred ? 1.3 : 1.1), hr, 0, 0, Math.PI * 2);
    ctx.fill();
    // уши
    ctx.fillStyle = dark;
    if (c.g.diet < 0.35 && !swim) {
      // длинные уши травоядного
      for (const side of [1, -1]) {
        ctx.beginPath();
        ctx.ellipse(hx - hr * 0.6, side * hr * 0.7, hr * 0.9, hr * 0.28, side * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (!swim) {
      // треугольные уши хищника
      for (const side of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(hx - hr * 0.2, side * hr * 0.5);
        ctx.lineTo(hx - hr * 0.9, side * hr * 1.2);
        ctx.lineTo(hx - hr * 0.7, side * hr * 0.2);
        ctx.fill();
      }
    }
    // глаза
    ctx.fillStyle = '#fff';
    const eyeR = Math.max(0.4, hr * 0.28);
    for (const side of [1, -1]) {
      ctx.beginPath();
      ctx.arc(hx + hr * 0.35, side * hr * 0.45, eyeR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#111';
    for (const side of [1, -1]) {
      ctx.beginPath();
      ctx.arc(hx + hr * 0.45, side * hr * 0.45, eyeR * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    // клыки хищника
    if (pred) {
      ctx.fillStyle = '#fff';
      for (const side of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(hx + hr * 1.1, side * hr * 0.25);
        ctx.lineTo(hx + hr * 1.45, side * hr * 0.12);
        ctx.lineTo(hx + hr * 1.1, side * hr * 0.05);
        ctx.fill();
      }
    }
    ctx.restore();
    // состояние
    if (c.state === 'flee' && c.alarm > 0) {
      ctx.fillStyle = '#ff6b5b';
      ctx.font = `bold ${Math.max(6, s)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText('!', c.x - sin * 0, c.y - s * 1.6);
    }
    void cos;
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    for (const p of this.particles) {
      p.life++;
      if (p.life < 0) continue;
      p.x += p.vx;
      p.y += p.vy;
      const k = p.life / p.max;
      ctx.globalAlpha = Math.max(0, 1 - k);
      if (p.kind === 'heart') {
        ctx.fillStyle = '#ff6b9a';
        ctx.font = '7px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('♥', p.x, p.y);
      } else if (p.kind === 'ring') {
        ctx.strokeStyle = `hsl(${p.hue},70%,75%)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 + k * 12, 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'spark') {
        ctx.fillStyle = p.hue === 0 ? '#ff5252' : '#ffb74d';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.hue === 0 ? 0.7 : 1.6, 0, Math.PI * 2);
        ctx.fill();
        p.vx *= 0.92;
        p.vy *= 0.92;
      } else if (p.kind === 'blast') {
        ctx.fillStyle = `rgba(255,150,50,${0.5 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 20 + k * 200, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,240,180,0.9)';
        ctx.lineWidth = 4;
        ctx.stroke();
      } else if (p.kind === 'star') {
        ctx.strokeStyle = `hsl(${p.hue},90%,70%)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6 + k * 70, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter((p) => p.life < p.max);
  }

  /** Миникарта: рельеф, точки существ (цвет вида), рамка обзора. */
  drawMinimap(mini: HTMLCanvasElement, w: number, h: number): void {
    const ctx = mini.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const mw = mini.clientWidth;
    const mh = mini.clientHeight;
    if (mini.width !== Math.round(mw * dpr)) {
      mini.width = Math.round(mw * dpr);
      mini.height = Math.round(mh * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(this.miniBase, 0, 0, mw, mh);
    const sx = mw / this.world.width;
    const sy = mh / this.world.height;
    for (const c of this.world.creatures) {
      ctx.fillStyle = `hsl(${c.g.hue},70%,${c.g.diet > 0.65 ? 60 : 75}%)`;
      ctx.fillRect(c.x * sx - 0.75, c.y * sy - 0.75, 1.5, 1.5);
    }
    const z = this.cam.zoom;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect((this.cam.x - w / 2 / z) * sx, (this.cam.y - h / 2 / z) * sy, (w / z) * sx, (h / z) * sy);
    const p = this.world.player;
    if (p?.alive) {
      ctx.fillStyle = '#ffd54f';
      ctx.beginPath();
      ctx.arc(p.x * sx, p.y * sy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Портрет существа для инспектора. */
  portrait(canvas: HTMLCanvasElement, c: Creature): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const saved = this.ctx;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1a1e16';
    ctx.fillRect(0, 0, w, h);
    const k = (Math.min(w, h) * 0.32) / (c.g.size * 1.25);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (w / 2 - c.x * k + c.g.size * k * 0.3), dpr * (h / 2 - c.y * k));
    const heading = c.heading;
    c.heading = 0;
    this.ctx = ctx;
    this.drawAnimal(c);
    this.ctx = saved;
    c.heading = heading;
  }
}
