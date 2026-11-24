import type { Creature, World } from './world';

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private grassCanvas: HTMLCanvasElement;
  private grassCtx: CanvasRenderingContext2D;
  private grassImage: ImageData;

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

  draw(selected: Creature | null): void {
    const { ctx, world } = this;
    const s = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawGrass();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.grassCanvas, 0, 0, this.canvas.width, this.canvas.height);

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

    for (const c of world.creatures) this.drawCreature(c);

    if (selected?.alive) {
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, selected.genes.size + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 / s;
      ctx.stroke();
    }
  }

  private drawGrass(): void {
    const { world } = this;
    const data = this.grassImage.data;
    for (let i = 0; i < world.grass.length; i++) {
      const g = world.grass[i];
      const f = world.fertility[i];
      // земля: от песка (пустошь) к тёмной почве; трава поверх — зелёная
      const soilR = 58 - f * 30;
      const soilG = 48 - f * 20;
      const soilB = 36 - f * 16;
      data[i * 4] = soilR * (1 - g) + 52 * g;
      data[i * 4 + 1] = soilG * (1 - g) + 150 * g;
      data[i * 4 + 2] = soilB * (1 - g) + 58 * g;
      data[i * 4 + 3] = 255;
    }
    this.grassCtx.putImageData(this.grassImage, 0, 0);
  }

  private drawCreature(c: Creature): void {
    const { ctx } = this;
    const { hue } = c.genes;
    const size = c.genes.size * 1.2 + 1.5; // чуть крупнее, чтобы мелких было видно
    const energy = Math.max(0.25, Math.min(1, c.energy / (40 * size * size)));
    const light = c.species === 'herb' ? 55 + energy * 20 : 45 + energy * 15;
    ctx.fillStyle = `hsl(${hue}, ${c.species === 'herb' ? 55 : 80}%, ${light}%)`;

    if (c.species === 'herb') {
      ctx.beginPath();
      ctx.arc(c.x, c.y, size, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // хищник — треугольник носом по направлению движения
      const cos = Math.cos(c.heading);
      const sin = Math.sin(c.heading);
      const r = size * 1.3;
      ctx.beginPath();
      ctx.moveTo(c.x + cos * r * 1.4, c.y + sin * r * 1.4);
      ctx.lineTo(c.x - cos * r + -sin * r * 0.9, c.y - sin * r + cos * r * 0.9);
      ctx.lineTo(c.x - cos * r - -sin * r * 0.9, c.y - sin * r - cos * r * 0.9);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }
}

/** График численности популяций. */
export function drawChart(canvas: HTMLCanvasElement, world: World): void {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const hist = world.history;
  if (hist.length < 2) return;
  const maxHerb = Math.max(20, ...hist.map((s) => s.herb));
  const maxCarn = Math.max(5, ...hist.map((s) => s.carn));
  const step = w / 599;
  const x0 = w - (hist.length - 1) * step;

  const line = (get: (i: number) => number, color: string, fill = false) => {
    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = x0 + i * step;
      const y = h - 4 - get(i) * (h - 12);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    if (fill) {
      ctx.lineTo(w, h);
      ctx.lineTo(x0, h);
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  };

  line((i) => hist[i].grass, 'rgba(70,140,70,0.25)', true);
  line((i) => hist[i].herb / maxHerb, '#9be37a');
  line((i) => hist[i].carn / maxCarn, '#ff6b5b');
}
