import { HID, IN, INPUTS, OUT, OUTPUTS } from './brain';
import { LIMITS, SPECIES, SPECIES_INFO, type GeneKey } from './genes';
import type { Creature, World } from './world';

interface Effect {
  x: number;
  y: number;
  t: number; // 0..1, сколько прошло
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private grassCanvas: HTMLCanvasElement;
  private grassCtx: CanvasRenderingContext2D;
  private grassImage: ImageData;
  private effects: Effect[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.grassCanvas = document.createElement('canvas');
    this.grassCanvas.width = world.cols;
    this.grassCanvas.height = world.rows;
    this.grassCtx = this.grassCanvas.getContext('2d')!;
    this.grassImage = this.grassCtx.createImageData(world.cols, world.rows);
  }

  /** Масштаб «мир → экран». */
  get scale(): number {
    return this.canvas.width / this.world.width;
  }

  explosion(x: number, y: number): void {
    this.effects.push({ x, y, t: 0 });
  }

  draw(selected: Creature | null, family: Set<Creature>): void {
    const { ctx, world } = this;
    const s = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawGround();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.grassCanvas, 0, 0, this.canvas.width, this.canvas.height);

    // зимний иней
    const winter = world.season.winter;
    if (winter > 0) {
      ctx.fillStyle = `rgba(200, 220, 255, ${winter * 0.18})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (world.drought > 0) {
      ctx.fillStyle = 'rgba(255, 150, 40, 0.08)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    ctx.setTransform(s, 0, 0, s, 0, 0);

    if (selected?.alive) {
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, selected.genes.sense, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1 / s;
      ctx.setLineDash([4 / s, 4 / s]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // потомки выбранной особи — золотые кольца
    if (family.size) {
      ctx.strokeStyle = 'rgba(255, 214, 90, 0.9)';
      ctx.lineWidth = 1.5 / s;
      for (const c of family) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, this.radius(c) + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    for (const c of world.creatures) this.drawCreature(c);

    if (selected?.alive) {
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, this.radius(selected) + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 / s;
      ctx.stroke();
    }

    this.drawEffects();
  }

  private drawEffects(): void {
    const { ctx } = this;
    for (const e of this.effects) {
      e.t += 1 / 50;
      const r = 20 + e.t * 160;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 140, 40, ${(1 - e.t) * 0.35})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(255, 230, 150, ${1 - e.t})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    this.effects = this.effects.filter((e) => e.t < 1);
  }

  private drawGround(): void {
    const { world } = this;
    const data = this.grassImage.data;
    const wave = Math.sin(world.tick / 40);
    for (let i = 0; i < world.grass.length; i++) {
      const p = i * 4;
      if (world.water[i]) {
        data[p] = 30;
        data[p + 1] = 70 + wave * 4;
        data[p + 2] = 110 + wave * 6;
        data[p + 3] = 255;
        continue;
      }
      const g = world.grass[i];
      const f = world.fertility[i];
      // земля: от песка (пустошь) к тёмной почве; трава поверх — зелёная
      const soilR = 58 - f * 30;
      const soilG = 48 - f * 20;
      const soilB = 36 - f * 16;
      data[p] = soilR * (1 - g) + 52 * g;
      data[p + 1] = soilG * (1 - g) + 150 * g;
      data[p + 2] = soilB * (1 - g) + 58 * g;
      data[p + 3] = 255;
    }
    this.grassCtx.putImageData(this.grassImage, 0, 0);
  }

  private radius(c: Creature): number {
    return c.genes.size * 1.2 + 1.5; // чуть крупнее реального, чтобы мелких было видно
  }

  private drawCreature(c: Creature): void {
    const { ctx } = this;
    const { hue } = c.genes;
    const size = this.radius(c);
    const energy = Math.max(0.25, Math.min(1, c.energy / this.world.maxEnergy(c.genes)));
    const cos = Math.cos(c.heading);
    const sin = Math.sin(c.heading);

    if (c.species === 'herb') {
      ctx.fillStyle = `hsl(${hue}, 55%, ${55 + energy * 20}%)`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, size, 0, Math.PI * 2);
      ctx.fill();
    } else if (c.species === 'omni') {
      // кабан — ромб, вытянутый по направлению движения
      const r = size * 1.1;
      ctx.fillStyle = `hsl(${hue}, 60%, ${50 + energy * 18}%)`;
      ctx.beginPath();
      ctx.moveTo(c.x + cos * r * 1.3, c.y + sin * r * 1.3);
      ctx.lineTo(c.x - sin * r * 0.8, c.y + cos * r * 0.8);
      ctx.lineTo(c.x - cos * r * 1.1, c.y - sin * r * 1.1);
      ctx.lineTo(c.x + sin * r * 0.8, c.y - cos * r * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    } else {
      // хищник — треугольник носом по направлению движения
      const r = size * 1.3;
      ctx.fillStyle = `hsl(${hue}, 80%, ${45 + energy * 15}%)`;
      ctx.beginPath();
      ctx.moveTo(c.x + cos * r * 1.4, c.y + sin * r * 1.4);
      ctx.lineTo(c.x - cos * r - sin * r * 0.9, c.y - sin * r + cos * r * 0.9);
      ctx.lineTo(c.x - cos * r + sin * r * 0.9, c.y - sin * r - cos * r * 0.9);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }
}

function prepare(canvas: HTMLCanvasElement): [CanvasRenderingContext2D, number, number] {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return [ctx, w, h];
}

function plot(ctx: CanvasRenderingContext2D, w: number, h: number, n: number, get: (i: number) => number | null, color: string, fill = false): void {
  const step = w / 799;
  const x0 = w - (n - 1) * step;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    const v = get(i);
    if (v === null) {
      started = false;
      continue;
    }
    const x = x0 + i * step;
    const y = h - 4 - v * (h - 10);
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    started = true;
  }
  if (fill) {
    ctx.lineTo(w, h);
    ctx.lineTo(x0, h);
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
}

/** График численности популяций. Каждый вид — в своём масштабе. */
export function drawPopulation(canvas: HTMLCanvasElement, world: World): void {
  const [ctx, w, h] = prepare(canvas);
  const hist = world.history;
  if (hist.length < 2) return;
  plot(ctx, w, h, hist.length, (i) => hist[i].grass, 'rgba(70,140,70,0.25)', true);
  for (const sp of SPECIES) {
    const max = Math.max(sp === 'herb' ? 20 : 5, ...hist.map((s) => s.count[sp]));
    plot(ctx, w, h, hist.length, (i) => hist[i].count[sp] / max, SPECIES_INFO[sp].color);
  }
}

/** Как меняется средний ген у каждого вида. */
export function drawGeneHistory(canvas: HTMLCanvasElement, world: World, gene: GeneKey): void {
  const [ctx, w, h] = prepare(canvas);
  const hist = world.history;
  const [lo, hi] = LIMITS[gene];
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '10px system-ui';
  ctx.fillText(String(hi), 4, 11);
  ctx.fillText(String(lo), 4, h - 4);
  if (hist.length < 2) return;
  for (const sp of SPECIES) {
    plot(ctx, w, h, hist.length, (i) => {
      const g = hist[i].genes[sp];
      return g ? (g[gene] - lo) / (hi - lo) : null;
    }, SPECIES_INFO[sp].color);
  }
}

/** Схема нейросети: линии — веса (зелёные +, красные −), кружки — текущие активации. */
export function drawBrain(canvas: HTMLCanvasElement, w8: Float32Array, act: Float32Array): void {
  const [ctx, w, h] = prepare(canvas);
  const layers = [IN, HID, OUT];
  const xs = [108, w / 2 + 16, w - 56];
  const pos = (l: number, i: number) => {
    const n = layers[l];
    return [xs[l], 10 + ((h - 20) * (i + 0.5)) / n] as const;
  };
  const edge = (a: readonly [number, number], b: readonly [number, number], weight: number) => {
    ctx.strokeStyle = weight > 0 ? `rgba(120,220,120,${Math.min(0.9, Math.abs(weight) / 3)})` : `rgba(255,100,90,${Math.min(0.9, Math.abs(weight) / 3)})`;
    ctx.lineWidth = Math.min(3, Math.abs(weight));
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  };
  for (let hI = 0; hI < HID; hI++) for (let i = 0; i < IN; i++) edge(pos(0, i), pos(1, hI), w8[hI * IN + i]);
  const o = IN * HID;
  for (let k = 0; k < OUT; k++) for (let hI = 0; hI < HID; hI++) edge(pos(1, hI), pos(2, k), w8[o + k * (HID + 1) + hI]);

  ctx.font = '10px system-ui';
  let idx = 0;
  for (let l = 0; l < 3; l++) {
    for (let i = 0; i < layers[l]; i++) {
      const [x, y] = pos(l, i);
      const a = act[idx++];
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      const v = Math.max(-1, Math.min(1, a));
      ctx.fillStyle = v >= 0 ? `rgba(255,255,255,${0.15 + v * 0.85})` : `rgba(255,120,100,${0.15 - v * 0.85})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(230,232,223,0.75)';
      if (l === 0) {
        ctx.textAlign = 'right';
        ctx.fillText(INPUTS[i], x - 9, y + 3);
      } else if (l === 2) {
        ctx.textAlign = 'left';
        ctx.fillText(OUTPUTS[i], x + 9, y + 3);
      }
    }
  }
  ctx.textAlign = 'left';
}
