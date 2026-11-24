import { clamp, mulberry32 } from '../lib/random';
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

/** Рисует поверхность: запечённый рельеф, траву и снег, существ, эффекты, ночь. */
export class SurfaceRenderer {
  private ctx: CanvasRenderingContext2D;
  private bake!: HTMLCanvasElement;
  private overlay!: HTMLCanvasElement;
  private overlayCtx!: CanvasRenderingContext2D;
  private overlayImg!: ImageData;
  miniBase!: HTMLCanvasElement;
  private particles: Particle[] = [];
  private frame = 0;
  /** id вида, который подсвечен (остальные приглушены). */
  focusSpecies: number | null = null;

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
    this.decorate(g, rnd);

    // слой травы/снега — по клеткам, растягивается со сглаживанием
    this.overlay = document.createElement('canvas');
    this.overlay.width = t.cols;
    this.overlay.height = t.rows;
    this.overlayCtx = this.overlay.getContext('2d')!;
    this.overlayImg = this.overlayCtx.createImageData(t.cols, t.rows);
    this.updateOverlay();

    // основа миникарты
    this.miniBase = document.createElement('canvas');
    this.miniBase.width = 240;
    this.miniBase.height = Math.round((240 * this.world.height) / this.world.width);
    this.miniBase.getContext('2d')!.drawImage(this.bake, 0, 0, this.miniBase.width, this.miniBase.height);
  }

  /** Деревья, камни, кактусы, тростник — рисуются прямо в текстуру рельефа. */
  private decorate(g: CanvasRenderingContext2D, rnd: () => number): void {
    const t = this.world.terrain;
    const s = BAKE_SCALE;
    const n = t.cols * t.rows;
    for (let k = 0; k < n * 1.6; k++) {
      const x = rnd() * this.world.width;
      const y = rnd() * this.world.height;
      const b = t.biome[t.index(x, y)] as B;
      const px = x * s;
      const py = y * s;
      if (b === B.Forest && rnd() < 0.85) {
        const r = (5 + rnd() * 5) * s;
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.beginPath();
        g.ellipse(px + r * 0.4, py + r * 0.5, r, r * 0.8, 0, 0, Math.PI * 2);
        g.fill();
        const shade = 30 + rnd() * 25;
        g.fillStyle = `rgb(${shade * 0.6},${shade + 50},${shade * 0.6})`;
        g.beginPath();
        g.arc(px, py, r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(160,220,120,0.18)';
        g.beginPath();
        g.arc(px - r * 0.3, py - r * 0.3, r * 0.5, 0, Math.PI * 2);
        g.fill();
      } else if (b === B.Swamp && rnd() < 0.5) {
        g.strokeStyle = 'rgba(90,120,60,0.7)';
        g.lineWidth = 0.6;
        for (let i = 0; i < 3; i++) {
          g.beginPath();
          g.moveTo(px + i, py);
          g.lineTo(px + i + (rnd() - 0.5) * 2, py - 3 - rnd() * 3);
          g.stroke();
        }
      } else if (b === B.Desert && rnd() < 0.08) {
        g.fillStyle = 'rgba(70,110,60,0.9)';
        g.fillRect(px - 0.6, py - 3, 1.2, 3);
        g.fillRect(px - 2, py - 2, 1, 1.5);
        g.fillRect(px + 1, py - 2.5, 1, 1.5);
      } else if ((b === B.Mountain || b === B.Snow) && rnd() < 0.35) {
        const r = (3 + rnd() * 5) * s;
        g.fillStyle = 'rgba(0,0,0,0.22)';
        g.beginPath();
        g.moveTo(px, py - r);
        g.lineTo(px + r, py + r * 0.6);
        g.lineTo(px - r * 0.2, py + r * 0.6);
        g.fill();
        g.fillStyle = b === B.Snow ? 'rgba(250,252,255,0.9)' : 'rgba(150,145,140,0.8)';
        g.beginPath();
        g.moveTo(px, py - r);
        g.lineTo(px - r * 0.2, py + r * 0.6);
        g.lineTo(px - r, py + r * 0.6);
        g.fill();
      } else if (b === B.Grass && rnd() < 0.05) {
        g.fillStyle = `rgba(${220 + rnd() * 35},${180 + rnd() * 60},${80 + rnd() * 120},0.8)`;
        g.fillRect(px, py, 0.8, 0.8); // цветы
      } else if (b === B.Savanna && rnd() < 0.03) {
        const r = (4 + rnd() * 3) * s;
        g.fillStyle = 'rgba(0,0,0,0.2)';
        g.beginPath();
        g.ellipse(px + 1, py + 1, r * 1.2, r * 0.6, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgb(90,120,50)';
        g.beginPath();
        g.ellipse(px, py, r * 1.2, r * 0.6, 0, 0, Math.PI * 2);
        g.fill(); // акация
      }
    }
  }

  /** Трава, снег и лёд по клеткам — меняются с сезонами. */
  updateOverlay(): void {
    const w = this.world;
    const t = w.terrain;
    const d = this.overlayImg.data;
    const shift = w.season.shift;
    for (let i = 0; i < w.grass.length; i++) {
      const b = BIOMES[t.biome[i]];
      const temp = t.baseTemp[i] + shift;
      const snow = clamp((0.1 - temp) / 0.08, 0, 1);
      const o = i * 4;
      if (b.water) {
        // лёд на воде зимой
        const ice = clamp((0.04 - temp) / 0.05, 0, 1);
        d[o] = 225;
        d[o + 1] = 238;
        d[o + 2] = 248;
        d[o + 3] = ice * 220;
        continue;
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
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = bb;
      d[o + 3] = a * 255;
    }
    this.overlayCtx.putImageData(this.overlayImg, 0, 0);
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
    ctx.drawImage(this.overlay, 0, 0, world.width, world.height);

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
        ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
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
