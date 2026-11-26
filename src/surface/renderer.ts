import { clamp, mulberry32, Noise } from '../lib/random';
import { B, BIOMES } from '../sim/terrain';
import type { Creature, Fx, World } from '../sim/world';
import type { Genome } from '../sim/genome';
import { P } from '../sim/modules';
import type { Camera } from './camera';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  kind: 'heart' | 'spark' | 'ring' | 'blast' | 'star' | 'leaf' | 'spore' | 'bubble' | 'glow' | 'steam' | 'burst' | 'zap';
  hue: number;
}

/** Линзы «микромира»: что раскрашивает слой клеток. */
export type Lens = 'off' | 'fert' | 'microbes' | 'plankton' | 'disease';

/** Что игрок уже успел увидеть на экране (для карточек фактов; читает view). */
export interface Seen {
  fairy: boolean;
  glow: boolean;
  bubble: boolean;
  mushroom: boolean;
  flies: boolean;
  mould: boolean;
  steam: boolean;
  wake: boolean;
  spore: boolean;
  microscope: boolean;
  stromatolite: boolean;
  mat: boolean;
  sick: boolean;
  /** ♾️ Кольца чувств выбранного зверя показаны хотя бы раз (карточка «Чем зверь чувствует мир»). */
  rings: boolean;
}

/** Бюджеты мелочей микромира на кадр (на узком экране — вдвое меньше). */
const BUDGET = { mush: 400, spark: 1500, fungi: 300, micro: 700, wake: 200 };

const BAKE_SCALE = 0.5; // пикселей текстуры на единицу мира
const TILE_PX = 512;
/** Во сколько раз слой травы детальнее сетки клеток (сглаживание). */
const OV = 3;

interface TilePair {
  ground: HTMLCanvasElement;
  /** Реки тайла (только если в нём есть русла): рисуются непрозрачно и под линзой. */
  rivers: HTMLCanvasElement | null;
  deco: HTMLCanvasElement;
}

/** Шляпки грибов по видам (4 — мухомор). */
const MUSH_CAPS = ['#d8b88c', '#a8703f', '#7f5230', '#c08a50', '#cf3527'];
/** Крапинки мухомора: dx, dy в долях размера. */
const AMANITA_SPOTS = [-0.28, -0.12, 0.1, -0.28, 0.32, -0.08];
/** Лапы туши: u — вдоль тела, d — наклон. */
const CORPSE_LEGS = [0.5, 0.1, 0.3, -0.05, -0.4, 0.12, -0.6, -0.08];

/** Быстрый детерминированный шум 0..1 по координатам. */
function hash2(x: number, y: number): number {
  let h = (Math.floor(x * 4) * 374761393 + Math.floor(y * 4) * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Целочисленный хеш → 0..1 (для мерцания и позиций искр). */
function hashI(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Цвет по ступеням градиента (k = 0..1). */
function ramp(stops: number[][], k: number, out: Float32Array, o: number): void {
  const n = stops.length - 1;
  const f = (k <= 0 ? 0 : k >= 1 ? 1 : k) * n;
  const j = Math.min(n - 1, Math.floor(f));
  const u = f - j;
  const a = stops[j];
  const b = stops[j + 1];
  out[o] = a[0] + (b[0] - a[0]) * u;
  out[o + 1] = a[1] + (b[1] - a[1]) * u;
  out[o + 2] = a[2] + (b[2] - a[2]) * u;
}

/** ♾️ Крабовидная форма у самой особи (как рецепт «карцинизация»). */
const crabLike = (g: Genome): boolean => g.ph[P.SHELL] >= 0.5 && g.ph[P.CLAW] >= 0.3 && g.ph[P.LEGS] >= 3 && g.body.shape <= 0.3;
/** ♾️ Где на боку i-й из n светящихся органов (в координатах тела). */
function photoAt(i: number, n: number, rx: number, ry: number): [number, number] {
  const t = n > 1 ? i / (n - 1) : 0.5;
  return [rx * (0.6 - 1.2 * t), (i % 2 ? 1 : -1) * ry * 0.58];
}

/** Растительные украшения — на планете без жизни на суше их нет. */
const PLANT_DECO = new Set<string>(['tree', 'acacia', 'bush', 'reed', 'cactus', 'flower']);
const SPRING_RINGS = ['#8a4a2a', '#e88a2a', '#e8d24a', '#3fb07a', '#2a7fbf'];

const MIC_RAMP = [[20, 26, 51], [107, 63, 160], [255, 122, 217]];
const PLANKTON_RAMP = [[11, 31, 77], [27, 143, 191], [127, 224, 122]];

interface Deco {
  kind: 'tree' | 'acacia' | 'bush' | 'reed' | 'cactus' | 'rock' | 'snowrock' | 'flower' | 'pebble' | 'spring' | 'stromatolite' | 'mat';
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
  /** Текущая линза; менять через setLens — слой клеток перерисуется сразу. */
  lens: Lens = 'off';
  /** Флаги «уже видели» — view превращает их в карточки фактов. */
  seen: Seen = { fairy: false, glow: false, bubble: false, mushroom: false, flies: false, mould: false, steam: false, wake: false, spore: false, microscope: false, stromatolite: false, mat: false, sick: false, rings: false };
  /** Светящиеся следы пловцов ночью (рисуются поверх ночной вуали). */
  private wakes: Particle[] = [];
  /** Клетки горячих источников. */
  private springSet = new Set<number>();
  /** Свой генератор для косметики — не трогает Math.random симуляции. */
  private rnd = mulberry32(4242);
  /** Масштаб бюджетов: 0.5 на узком экране. */
  private bk = 1;
  private zoom = 1;
  /** ♾️ Подробно нарисованных зверей в прошлом кадре (мех — только если их не больше 250). */
  private nDetail = 0;
  private many = false;
  /** Портрет: 0 — карта, 1 — живой зверь, 2 — заглушка по геному (бестиарий). */
  private pmode: 0 | 1 | 2 = 0;
  private glowCyan = this.makeGlow(90, 210, 255);
  private glowGreen = this.makeGlow(150, 255, 170);
  private mushBuf = new Float32Array(BUDGET.mush * 4);
  /** Центры «ведьминых колец» кадра (переиспользуется). */
  private ringBuf: number[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    private cam: Camera,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.rebuild();
  }

  /** Включить линзу и сразу перекрасить слой клеток. */
  setLens(l: Lens): void {
    if (this.lens === l) return;
    this.lens = l;
    this.updateOverlay();
  }

  /** Мир восстановлен из снимка (тот же рельеф): частицы и следы прошлого момента — прочь, слой травы/почвы — заново. */
  onRestore(): void {
    this.particles = [];
    this.wakes = [];
    this.updateOverlay();
  }

  /** Перерисовать рельеф (новый мир). */
  rebuild(): void {
    const t = this.world.terrain;
    this.springSet = new Set(t.springs);
    this.wakes = [];
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
  private riverSegment(g: CanvasRenderingContext2D, i: number, begin = true): void {
    const t = this.world.terrain;
    const X = this.rivX;
    const Y = this.rivY;
    const d = t.drain[i];
    const u = this.rivUp[i];
    const px = X[i];
    const py = Y[i];
    const ex = (px + X[d]) / 2;
    const ey = (py + Y[d]) / 2;
    if (begin) g.beginPath();
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
    // полупрозрачные слои — одним путём на каждую ширину: иначе на стыках отрезков альфа ложится дважды («бусины»)
    const buckets = new Map<number, number[]>();
    const strokeBuckets = () => {
      for (const [lw, list] of buckets) {
        g.lineWidth = lw;
        g.beginPath();
        for (const i of list) this.riverSegment(g, i, false);
        g.stroke();
      }
      buckets.clear();
    };
    const put = (lw: number, i: number) => {
      const q = Math.round(lw * 4) / 4;
      const list = buckets.get(q);
      if (list) list.push(i);
      else buckets.set(q, [i]);
    };
    if (streams) {
      // ручьи: тонкие, от истока к устью шире
      g.strokeStyle = 'rgba(79,143,192,0.7)';
      each(1, 1, (i) => put(0.35 + 0.6 * clamp((t.flow[i] - 18) / 62, 0, 1), i));
      strokeBuckets();
    }
    // берега: влажная тёмная кромка
    g.strokeStyle = 'rgba(38,58,34,0.32)';
    each(2, 2, (i) => put(width(t.flow[i]) + 1.8 * wk, i));
    strokeBuckets();
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
    // новое — после старого, чтобы деревья и камни остались на своих местах
    if (this.springSet.has(i)) out.push({ kind: 'spring', x: (cx + 0.5) * cell, y: (cy + 0.5) * cell, s: 6 + r() * 4, v: r() });
    const life = this.world.env.landLife;
    if (!life) {
      // суша без растений: строматолиты на мелководье, микробные маты на равнинах
      if (b === B.Shallow) add('stromatolite', 0.4, [2, 4]);
      else if (b === B.Beach || b === B.Grass || b === B.Savanna || b === B.Swamp) add('mat', 0.5, [3, 6]);
    }
    // в русле деревья не растут, а кроны соседних клеток не закрывают реку
    const river = t.river[i] >= 2;
    return out.filter((d) => {
      if (!life && PLANT_DECO.has(d.kind)) return false;
      if (d.kind === 'tree' || d.kind === 'acacia') return !river && !this.nearRiver(d.x, d.y, d.s * 0.75 + 2.5);
      return !(river && d.kind === 'reed');
    });
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
      case 'spring':
        // горячий источник: кольца бактерий-термофилов — от синей середины к бурой кайме
        for (let k = 0; k < 5; k++) {
          g.fillStyle = SPRING_RINGS[k];
          g.globalAlpha = k ? 0.95 : 0.8;
          g.beginPath();
          g.ellipse(x, y, s * (1 - k * 0.17), s * (1 - k * 0.17) * (0.85 + v * 0.1), v * 3, 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
        g.fillStyle = 'rgba(220,245,255,0.5)';
        g.beginPath();
        g.arc(x - s * 0.08, y - s * 0.08, s * 0.12, 0, Math.PI * 2);
        g.fill();
        break;
      case 'stromatolite':
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.beginPath();
        g.arc(x + s * 0.25, y + s * 0.3, s, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = `rgb(${118 + v * 25},${106 + v * 20},${88 + v * 12})`;
        g.beginPath();
        g.arc(x, y, s, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = 'rgba(205,190,160,0.55)';
        g.lineWidth = Math.max(0.2, s * 0.1);
        g.beginPath();
        g.arc(x, y, s * 0.65, 0, Math.PI * 2);
        g.moveTo(x + s * 0.32, y);
        g.arc(x, y, s * 0.32, 0, Math.PI * 2);
        g.stroke();
        break;
      case 'mat':
        // микробный мат: пурпурные бактерии на ранней Земле, позже — бурые цианобактерии
        g.fillStyle = (this.world.env.lifeStage ?? 7) < 2 ? 'rgba(122,70,140,0.5)' : 'rgba(118,84,48,0.5)';
        g.beginPath();
        g.ellipse(x, y, s, s * 0.65, v * 3, 0, Math.PI * 2);
        g.ellipse(x + s * 0.5, y + s * 0.25, s * 0.55, s * 0.4, v * 5, 0, Math.PI * 2);
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
    // реки чётко — своим слоем: он рисуется до деревьев (кроны нависают над водой) и не тускнеет под линзой
    const rc0 = Math.max(0, c0 - 1), rc1 = Math.min(t.cols - 1, c1 + 1), rr0 = Math.max(0, r0 - 1), rr1 = Math.min(t.rows - 1, r1 + 1);
    let rivers: HTMLCanvasElement | null = null;
    find: for (let cy = rr0; cy <= rr1; cy++) {
      for (let cx = rc0; cx <= rc1; cx++) {
        const i = cy * t.cols + cx;
        if (t.river[i] >= 1 && t.drain[i] >= 0) {
          rivers = document.createElement('canvas');
          rivers.width = rivers.height = TILE_PX;
          const rg = rivers.getContext('2d')!;
          rg.setTransform(level, 0, 0, level, -tx * size * level, -ty * size * level);
          this.strokeRivers(rg, rc0, rc1, rr0, rr1, true, 1.2);
          break find;
        }
      }
    }
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) for (const d of this.decoItems(cx, cy)) this.drawDeco(g, d, level);
    const pair = { ground, rivers, deco: c };
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

  /** Мягкое пятно света (для искр планктона и грибов). */
  private makeGlow(r: number, g: number, b: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d')!;
    const gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.18, `rgba(${r},${g},${b},0.9)`);
    gr.addColorStop(0.5, `rgba(${r},${g},${b},0.25)`);
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = gr;
    x.fillRect(0, 0, 32, 32);
    return c;
  }

  /** Цвет травы/снега/льда клетки (RGBA 0..255); видимые без линз следы почвы и цветение воды. */
  private cellColor(i: number, out: Float32Array, o: number): void {
    if (this.lens !== 'off') {
      this.lensColor(i, out, o);
      return;
    }
    const w = this.world;
    const t = w.terrain;
    const b = BIOMES[t.biome[i]];
    const temp = t.baseTemp[i] + w.tempShift;
    const snow = clamp((0.1 - temp) / 0.08, 0, 1);
    const soilOn = w.settings.soil;
    if (b.water) {
      // лёд зимой; летом у устьев и берегов — зелёное цветение планктона (вода богаче среднего)
      const ice = clamp((0.04 - temp) / 0.05, 0, 1);
      let bloom = 0;
      if (soilOn) {
        bloom = (w.nut[i] - 1.01) * 2.6 * clamp((temp - 0.03) * 4, 0, 1);
        bloom = bloom < 0 ? 0 : bloom > 0.4 ? 0.4 : bloom;
      }
      const wi = ice * 0.86;
      const k = wi + bloom > 1e-3 ? bloom / (wi + bloom) : temp > 0.04 ? 1 : 0;
      out[o] = 225 + (60 - 225) * k;
      out[o + 1] = 238 + (165 - 238) * k;
      out[o + 2] = 248 + (105 - 248) * k;
      out[o + 3] = Math.max(wi, bloom) * 255;
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
    if (soilOn) {
      // богатая почва — трава гуще и темнее, бедная — бледнее
      let lush = (w.nut[i] - 1) * 0.9;
      lush = lush < -0.25 ? -0.25 : lush > 0.3 ? 0.3 : lush;
      g += 45 * lush;
      r -= 25 * lush;
      bb -= 10 * lush;
      // свежий гумус: бурое пятно там, где разлагалась туша или много навоза
      const L = w.litter[i];
      if (L > 1.5 && w.act[i] > 0.3) {
        const st = Math.min(0.4, (L - 1.5) * 0.35);
        r += (58 - r) * st;
        g += (42 - g) * st;
        bb += (28 - bb) * st;
        a = Math.max(a, st);
      }
    }
    if (!w.env.landLife) {
      // на суше нет растений — только бурые микробные плёнки
      r = 115;
      g = 95;
      bb = 62;
      a *= 0.6;
    }
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

  /** Раскраска клетки линзой: плодородие, микробы, планктон, болезни. */
  private lensColor(i: number, out: Float32Array, o: number): void {
    const w = this.world;
    const t = w.terrain;
    const b = BIOMES[t.biome[i]];
    switch (this.lens) {
      case 'fert': {
        if (b.water) {
          const k = clamp((w.soil[i] - 0.6) / 1.2, 0, 1);
          out[o] = 20 + 40 * k;
          out[o + 1] = 40 + 130 * k;
          out[o + 2] = 90 + 30 * k;
          out[o + 3] = 0.7 * 255;
          return;
        }
        // бедно — к кирпичному, богато — к зелёному; середина — нейтральная
        const tt = clamp((w.nut[i] - 1) / 0.3, -1, 1);
        const u = Math.min(1, Math.abs(tt) * 1.4);
        const [tr, tg, tb] = tt < 0 ? [200, 85, 60] : [60, 190, 90];
        out[o] = 175 + (tr - 175) * u;
        out[o + 1] = 165 + (tg - 165) * u;
        out[o + 2] = 120 + (tb - 120) * u;
        out[o + 3] = clamp(0.15 + 0.65 * Math.abs(tt), 0, 0.8) * 255;
        return;
      }
      case 'microbes': {
        if (b.water) {
          out[o + 3] = 0;
          return;
        }
        if (w.act[i] < 0.05) {
          // мороз: микробы «спят»
          out[o] = 90;
          out[o + 1] = 120;
          out[o + 2] = 170;
        } else ramp(MIC_RAMP, (w.mic[i] - 0.03) / 0.8, out, o);
        out[o + 3] = 0.78 * 255;
        return;
      }
      case 'plankton': {
        if (!b.water) {
          out[o] = out[o + 1] = out[o + 2] = 90;
          out[o + 3] = 0.5 * 255;
          return;
        }
        const v = clamp(w.grass[i] / b.fert, 0, 1) * w.nut[i];
        ramp(PLANKTON_RAMP, v * v * 0.95, out, o);
        out[o + 3] = 0.85 * 255;
        return;
      }
      default:
        out[o] = 10;
        out[o + 1] = 12;
        out[o + 2] = 20;
        out[o + 3] = 0.5 * 255;
    }
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
    const shift = w.tempShift;
    if (!w.env.landLife) return; // на безжизненной суше травинок нет
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

  /** Видимые клетки прямоугольника мира: [c0, c1, r0, r1]. */
  private cellRange(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    const t = this.world.terrain;
    const cell = this.world.cell;
    return [Math.max(0, Math.floor(x0 / cell)), Math.min(t.cols - 1, Math.floor(x1 / cell)), Math.max(0, Math.floor(y0 / cell)), Math.min(t.rows - 1, Math.floor(y1 / cell))];
  }

  /** Свечение планктона в клетке воды ночью (0..1). */
  private glowAt(i: number, night: number): number {
    const w = this.world;
    const t = w.terrain;
    const T = t.baseTemp[i] + w.tempShift;
    if (T <= 0.35) return 0;
    const nu = (w.nut[i] - 0.9) / 0.4 + 0.3;
    return night * Math.min(1, w.grass[i] / BIOMES[t.biome[i]].fert) * Math.min(1, (T - 0.35) * 3) * (nu < 0 ? 0 : nu > 1 ? 1 : nu);
  }

  /** Грибы на лесной подстилке и «ведьмины кольца» на лугах (при сильном приближении). */
  private drawMicroLife(x0: number, y0: number, x1: number, y1: number): void {
    const w = this.world;
    if (!w.mic || !w.env.landLife) return;
    const t = w.terrain;
    const cell = w.cell;
    const sh = w.tempShift;
    const ctx = this.ctx;
    const M = this.mushBuf;
    const max = Math.floor(BUDGET.mush * this.bk);
    let n = 0;
    const rings = this.ringBuf;
    rings.length = 0;
    // детерминированный поток чисел клетки — без нового генератора на каждую
    let hq = 0;
    const r = () => hashI(hq++);
    const [c0, c1, r0, r1] = this.cellRange(x0 - 4, y0 - 4, x1 + 4, y1 + 4);
    for (let cy = r0; cy <= r1 && n < max; cy++) {
      for (let cx = c0; cx <= c1 && n < max; cx++) {
        const i = cy * t.cols + cx;
        const bi = t.biome[i];
        if ((bi !== B.Forest && bi !== B.Swamp && bi !== B.Grass) || t.river[i] >= 2) continue;
        const m = w.mic[i];
        if (m <= 0.55 || w.litter[i] <= 0.25) continue;
        const T = t.baseTemp[i] + sh;
        if (T <= 0.2 || T >= 0.65) continue;
        hq = Math.imul(w.seed ^ Math.imul(i, 2654435761), 16);
        for (let k = Math.floor((m - 0.5) * 6); k > 0 && n < max; k--, n++) {
          M[n * 4] = (cx + r()) * cell;
          M[n * 4 + 1] = (cy + r()) * cell;
          M[n * 4 + 2] = 1.3 + r() * 1;
          M[n * 4 + 3] = r() < 0.12 ? 4 : 1 + Math.floor(r() * 3);
        }
        if (bi === B.Grass && m > 0.7 && hash2(cx + 0.1, cy + 0.1) < 0.06) {
          // грибница растёт кругом, а грибы встают по его краю
          const x = (cx + 0.3 + r() * 0.4) * cell;
          const y = (cy + 0.3 + r() * 0.4) * cell;
          rings.push(x, y);
          for (let q = 0; q < 7 && n < max; q++, n++) {
            const a = (q / 7) * Math.PI * 2 + r() * 0.4;
            M[n * 4] = x + Math.cos(a) * 5;
            M[n * 4 + 1] = y + Math.sin(a) * 5;
            M[n * 4 + 2] = 0.9 + r() * 0.4;
            M[n * 4 + 3] = 0;
          }
        }
      }
    }
    if (!n) return;
    if (rings.length) {
      // трава над краем грибницы гуще и темнее
      ctx.strokeStyle = 'rgba(24,74,26,0.4)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let k = 0; k < rings.length; k += 2) {
        ctx.moveTo(rings[k] + 5, rings[k + 1]);
        ctx.arc(rings[k], rings[k + 1], 5, 0, Math.PI * 2);
      }
      ctx.stroke();
      this.seen.fairy = true;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const x = M[k * 4], y = M[k * 4 + 1], s = M[k * 4 + 2];
      ctx.moveTo(x + s * 0.75, y + 0.1);
      ctx.ellipse(x + s * 0.2, y + 0.1, s * 0.55, s * 0.22, 0, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = 'rgb(236,226,204)';
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const x = M[k * 4], y = M[k * 4 + 1], s = M[k * 4 + 2];
      ctx.rect(x - s * 0.15, y - s * 0.75, s * 0.3, s * 0.75);
    }
    ctx.fill();
    for (let kind = 0; kind < 5; kind++) {
      ctx.fillStyle = MUSH_CAPS[kind];
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        if (M[k * 4 + 3] !== kind) continue;
        const x = M[k * 4], y = M[k * 4 + 1] - M[k * 4 + 2] * 0.7, s = M[k * 4 + 2];
        ctx.moveTo(x - s * 0.6, y);
        ctx.ellipse(x, y, s * 0.6, s * 0.42, 0, Math.PI, Math.PI * 2);
        ctx.closePath();
      }
      ctx.fill();
    }
    // мухомор — белые крапинки
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      if (M[k * 4 + 3] !== 4) continue;
      const x = M[k * 4], y = M[k * 4 + 1] - M[k * 4 + 2] * 0.7, s = M[k * 4 + 2];
      for (let q = 0; q < 6; q += 2) {
        const dx = AMANITA_SPOTS[q], dy = AMANITA_SPOTS[q + 1];
        ctx.moveTo(x + dx * s + s * 0.08, y + dy * s);
        ctx.arc(x + dx * s, y + dy * s, s * 0.08, 0, Math.PI * 2);
      }
    }
    ctx.fill();
    this.seen.mushroom = true;
  }

  /** Линза «микробы» при большом увеличении: палочки, кокки, спириллы, гифы; в воде — диатомеи и водоросли. */
  private drawMicroscope(x0: number, y0: number, x1: number, y1: number): void {
    const w = this.world;
    if (!w.mic) return;
    const t = w.terrain;
    const cell = w.cell;
    const ctx = this.ctx;
    const f = this.frame * 0.1;
    let budget = Math.floor(BUDGET.micro * this.bk);
    const rods = new Path2D();
    const cocci = new Path2D();
    const spir = new Path2D();
    const hyph = new Path2D();
    const diat = new Path2D();
    const algae = new Path2D();
    const [c0, c1, r0, r1] = this.cellRange(x0, y0, x1, y1);
    for (let cy = r0; cy <= r1 && budget > 0; cy++) {
      for (let cx = c0; cx <= c1 && budget > 0; cx++) {
        const i = cy * t.cols + cx;
        const b = BIOMES[t.biome[i]];
        if (b.water) {
          const n = Math.round(clamp(w.grass[i] / b.fert, 0, 1) * w.nut[i] * 3);
          for (let k = 0; k < n && budget > 0; k++, budget--) {
            const h = hashI(i * 8 + k);
            const x = (cx + 0.1 + 0.8 * h) * cell + Math.sin(f * 0.6 + k + h * 6) * 0.8;
            const y = (cy + 0.1 + 0.8 * hashI(i * 8 + k + 99991)) * cell + Math.cos(f * 0.5 + k) * 0.8;
            if (k & 1) {
              algae.moveTo(x + 0.8, y);
              algae.arc(x, y, 0.8, 0, Math.PI * 2);
            } else {
              const a = h * 6 + f * 0.2;
              diat.moveTo(x + Math.cos(a) * 1.3, y + Math.sin(a) * 1.3);
              diat.lineTo(x + Math.cos(a + 2.09) * 1.3, y + Math.sin(a + 2.09) * 1.3);
              diat.lineTo(x + Math.cos(a + 4.19) * 1.3, y + Math.sin(a + 4.19) * 1.3);
              diat.closePath();
            }
          }
          continue;
        }
        if (w.myc[i] > 0.3) {
          // гифы грибницы — тонкие ветвящиеся нити, сшивающие соседние клетки
          for (let q = 0; q < (w.myc[i] > 0.7 ? 2 : 1); q++, budget--) {
            const h1 = hashI(i * 8 + q * 2 + 5);
            const h2 = hashI(i * 8 + q * 2 + 6);
            const sx = (cx + h1) * cell;
            const sy = cy * cell;
            const ex = (cx + h2) * cell;
            const ey = (cy + 1) * cell;
            const mx = (sx + ex) / 2 + (h2 - 0.5) * 12;
            const my = (sy + ey) / 2;
            hyph.moveTo(sx, sy);
            hyph.quadraticCurveTo(sx + (h1 - 0.5) * 10, sy + cell * 0.3, mx, my);
            hyph.quadraticCurveTo(ex - (h1 - 0.5) * 10, ey - cell * 0.3, ex, ey);
            // боковая веточка
            hyph.moveTo(mx, my);
            hyph.quadraticCurveTo(mx + (h1 > 0.5 ? 4 : -4), my + 2, mx + (h1 > 0.5 ? 7 : -7), my - 3 + h2 * 6);
          }
        }
        const n = Math.round(w.mic[i] * 5);
        for (let k = 0; k < n && budget > 0; k++, budget--) {
          const h = hashI(i * 8 + k);
          const h2 = hashI(i * 8 + k + 99991);
          const x = (cx + 0.1 + 0.8 * h) * cell + Math.sin(f + k + h * 6) * 0.6;
          const y = (cy + 0.1 + 0.8 * h2) * cell + Math.cos(f * 0.8 + k * 1.7) * 0.6;
          const a = h2 * 6 + Math.sin(f * 0.5 + k) * 0.4;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const kind = (h * 97) % 3 | 0;
          if (kind === 0) {
            rods.moveTo(x - ca * 1.1, y - sa * 1.1);
            rods.lineTo(x + ca * 1.1, y + sa * 1.1);
          } else if (kind === 1) {
            // диплококки — парами
            cocci.moveTo(x + 0.5, y);
            cocci.arc(x, y, 0.5, 0, Math.PI * 2);
            cocci.moveTo(x + ca * 1.05 + 0.5, y + sa * 1.05);
            cocci.arc(x + ca * 1.05, y + sa * 1.05, 0.5, 0, Math.PI * 2);
          } else {
            const wob = Math.sin(f * 2 + k);
            spir.moveTo(x - ca * 1.4, y - sa * 1.4);
            for (let q = 1; q <= 6; q++) {
              const u = -1.4 + (q * 2.8) / 6;
              const o = (q & 1 ? 0.45 : -0.45) * (0.8 + 0.2 * wob);
              spir.lineTo(x + ca * u - sa * o, y + sa * u + ca * o);
            }
          }
        }
      }
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(250,240,210,0.5)';
    ctx.lineWidth = 0.3;
    ctx.stroke(hyph);
    // тёмная кайма — как контраст под микроскопом
    ctx.strokeStyle = 'rgba(30,8,40,0.6)';
    ctx.lineWidth = 1.15;
    ctx.stroke(rods);
    ctx.lineWidth = 0.7;
    ctx.stroke(spir);
    ctx.lineWidth = 0.45;
    ctx.stroke(cocci);
    ctx.strokeStyle = '#ffe6f7';
    ctx.lineWidth = 0.7;
    ctx.stroke(rods);
    ctx.fillStyle = '#e2c8ff';
    ctx.fill(cocci);
    ctx.strokeStyle = '#9af0ff';
    ctx.lineWidth = 0.3;
    ctx.stroke(spir);
    ctx.fillStyle = 'rgba(238,208,104,0.85)';
    ctx.fill(diat);
    ctx.strokeStyle = 'rgba(140,240,150,0.9)';
    ctx.lineWidth = 0.35;
    ctx.stroke(algae);
    ctx.restore();
    this.seen.microscope = true;
  }

  /** Пузыри болотного газа и пар над горячими источниками. */
  private emitAmbient(x0: number, y0: number, x1: number, y1: number, z: number): void {
    const P = this.particles;
    const w = this.world;
    if (P.length > 500 || z <= 1 || !w.litter) return;
    const t = w.terrain;
    const cell = w.cell;
    const rnd = this.rnd;
    if (z > 1.5) {
      const [c0, c1, r0, r1] = this.cellRange(x0, y0, x1, y1);
      for (let k = 0, made = 0; k < 12 && made < 3 * this.bk; k++) {
        const cx = c0 + Math.floor(rnd() * (c1 - c0 + 1));
        const cy = r0 + Math.floor(rnd() * (r1 - r0 + 1));
        const i = cy * t.cols + cx;
        if (t.biome[i] !== B.Swamp || t.baseTemp[i] + w.tempShift < 0.06) continue;
        if (rnd() < w.litter[i] * w.act[i] * 0.06) {
          P.push({ x: (cx + rnd()) * cell, y: (cy + rnd()) * cell, vx: 0, vy: -0.02, life: 0, max: 40, kind: 'bubble', hue: 0.4 + rnd() * 0.5 });
          made++;
          this.seen.bubble = true;
        }
      }
    }
    for (const sI of t.springs) {
      const x = ((sI % t.cols) + 0.5) * cell;
      const y = (((sI / t.cols) | 0) + 0.5) * cell;
      if (x < x0 - 20 || x > x1 + 20 || y < y0 - 20 || y > y1 + 20 || rnd() > 0.3) continue;
      P.push({ x: x + (rnd() - 0.5) * 6, y: y + (rnd() - 0.5) * 6, vx: 0.04 + rnd() * 0.06, vy: -0.12 - rnd() * 0.08, life: 0, max: 70, kind: 'steam', hue: 0 });
      this.seen.steam = true;
    }
  }

  /** Ночью: светящийся планктон, гнилушки в лесу и светящиеся следы пловцов (режим 'lighter'). */
  private drawNightGlow(x0: number, y0: number, x1: number, y1: number, z: number, night: number): void {
    const w = this.world;
    if (!w.nut) return;
    const ctx = this.ctx;
    const t = w.terrain;
    const cell = w.cell;
    const fr = this.frame;
    ctx.globalCompositeOperation = 'lighter';
    // искры планктона: на общем плане — каждая третья клетка
    let budget = Math.floor(BUDGET.spark * this.bk);
    const thin = z < 0.6;
    const R = Math.max(1.8, 5 / z) * (thin ? 1.4 : 1);
    const spr = this.glowCyan;
    const [c0, c1, r0, r1] = this.cellRange(x0, y0, x1, y1);
    let drew = false;
    for (let cy = r0; cy <= r1 && budget > 0; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const i = cy * t.cols + cx;
        if (t.biome[i] > B.Shallow) continue;
        if (thin && hashI(i) > 0.34) continue;
        const gl = this.glowAt(i, night);
        if (gl <= 0.15) continue;
        const n = gl > 0.55 ? 3 : gl > 0.3 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const h = hashI(i * 4 + k + 7);
          const fl = 0.5 + 0.5 * Math.sin(fr * 0.07 + h * 40);
          ctx.globalAlpha = Math.min(1, gl * 0.9 * fl);
          ctx.drawImage(spr, (cx + h) * cell - R, (cy + hashI(i * 4 + k + 0x5bd1)) * cell - R, R * 2, R * 2);
        }
        drew = true;
        if ((budget -= n) <= 0) break;
      }
    }
    if (drew) this.seen.glow = true;
    // гнилушки и светящиеся грибы на лесной подстилке
    if (z > 1.5 && w.mic) {
      let fb = Math.floor(BUDGET.fungi * this.bk);
      const R2 = Math.max(0.7, 1.4 / z);
      ctx.globalAlpha = 0.35 * night;
      for (let cy = r0; cy <= r1 && fb > 0; cy++) {
        for (let cx = c0; cx <= c1 && fb > 0; cx++) {
          const i = cy * t.cols + cx;
          if (t.biome[i] !== B.Forest || w.mic[i] <= 0.6) continue;
          for (let k = 0; k < 2; k++, fb--) {
            ctx.drawImage(this.glowGreen, (cx + hashI(i * 2 + k + 31)) * cell - R2, (cy + hashI(i * 2 + k + 977)) * cell - R2, R2 * 2, R2 * 2);
          }
        }
      }
    }
    // светящийся след: планктон вспыхивает там, где воду тревожат
    const Wk = this.wakes;
    if (fr % 4 === 0 && Wk.length < BUDGET.wake * this.bk) {
      for (const c of w.creatures) {
        if (c.v <= 0.3 || c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
        const i = t.index(c.x, c.y);
        if (t.biome[i] > B.Shallow || this.glowAt(i, night) <= 0.2) continue;
        Wk.push({ x: c.x, y: c.y, vx: 0, vy: 0, life: 0, max: 50, kind: 'glow', hue: Math.max(1.5, c.g.size * 0.9) });
        this.seen.wake = true;
        if (Wk.length >= BUDGET.wake * this.bk) break;
      }
    }
    for (const p of Wk) {
      p.life++;
      const k = p.life / p.max;
      const r = p.hue * (1 + k);
      ctx.globalAlpha = 0.55 * (1 - k) * night;
      ctx.drawImage(spr, p.x - r, p.y - r, r * 2, r * 2);
    }
    if (Wk.length && Wk[0].life >= Wk[0].max) {
      // сжать на месте — без нового массива
      let j = 0;
      for (let k = 0; k < Wk.length; k++) if (Wk[k].life < Wk[k].max) Wk[j++] = Wk[k];
      Wk.length = j;
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Падаль по стадиям: пятно, туша с мухами → кости; плесень; следы костей. */
  private drawCorpses(vis: (x: number, y: number) => boolean, z: number): void {
    const ctx = this.ctx;
    const w = this.world;
    const t = w.terrain;
    const sh = w.tempShift;
    const act = w.act;
    const tick = w.tick;
    // следы костей тают за 900 тактов
    ctx.strokeStyle = 'rgb(225,220,200)';
    ctx.lineWidth = 0.7;
    for (const m of w.boneMarks) {
      const age = tick - m.t;
      if (age >= 900 || age < 0 || !vis(m.x, m.y)) continue;
      const r = Math.max(1.2, m.size * 0.5);
      ctx.globalAlpha = 0.7 * (1 - age / 900);
      ctx.beginPath();
      ctx.moveTo(m.x - r, m.y - r * 0.4);
      ctx.lineTo(m.x + r, m.y + r * 0.4);
      ctx.moveTo(m.x - r * 0.4, m.y + r * 0.6);
      ctx.lineTo(m.x + r * 0.4, m.y - r * 0.6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const k of w.corpses) {
      if (!vis(k.x, k.y)) continue;
      const st = clamp(1 - k.energy / Math.max(1e-6, k.e0), 0, 1);
      const s = Math.max(1.6, k.size);
      const rot = hash2(k.x, k.y) * Math.PI * 2;
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      // бурое пятно: соки уходят в почву (в воде — нет)
      if (t.biome[k.idx] > B.Shallow) {
        ctx.fillStyle = `rgba(55,40,28,${0.12 + 0.3 * st})`;
        ctx.beginPath();
        ctx.ellipse(k.x, k.y, s * (1.2 + st), s * (1.2 + st) * 0.8, rot, 0, Math.PI * 2);
        ctx.fill();
      }
      if (st < 0.5) {
        ctx.fillStyle = k.sick ? 'hsl(90,20%,35%)' : `hsl(${k.hue},15%,35%)`;
        ctx.beginPath();
        ctx.ellipse(k.x, k.y, s, s * 0.55, rot, 0, Math.PI * 2);
        ctx.moveTo(k.x + cr * s * 1.5, k.y + sr * s * 1.5);
        ctx.ellipse(k.x + cr * s * 1.15, k.y + sr * s * 1.15, s * 0.38, s * 0.3, rot, 0, Math.PI * 2);
        ctx.fill();
        // торчащие лапы
        ctx.strokeStyle = k.sick ? 'hsl(90,15%,25%)' : `hsl(${k.hue},12%,25%)`;
        ctx.lineWidth = Math.max(0.4, s * 0.14);
        ctx.beginPath();
        for (let q = 0; q < 8; q += 2) {
          const u = CORPSE_LEGS[q], d = CORPSE_LEGS[q + 1];
          const bx = k.x + cr * s * u - sr * s * 0.45;
          const by = k.y + sr * s * u + cr * s * 0.45;
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - sr * s * 0.6 + cr * s * d * 3, by + cr * s * 0.6 + sr * s * d * 3);
        }
        ctx.stroke();
        if (st > 0.25 && z > 2) {
          // сквозь шкуру уже проступают рёбра
          ctx.strokeStyle = `rgba(225,215,190,${(st - 0.25) * 2.4})`;
          ctx.lineWidth = Math.max(0.25, s * 0.08);
          ctx.beginPath();
          for (let q = -2; q <= 2; q++) {
            const bx = k.x + cr * s * q * 0.22;
            const by = k.y + sr * s * q * 0.22;
            ctx.moveTo(bx + sr * s * 0.42, by - cr * s * 0.42);
            ctx.lineTo(bx - sr * s * 0.3, by + cr * s * 0.3);
          }
          ctx.stroke();
        }
        if (z > 1.5 && t.baseTemp[k.idx] + sh > 0.3) {
          // мухи кружат над тушей
          const fr = this.frame * 0.25 + (k.idx & 7);
          const fs = Math.max(0.4, 1 / z);
          ctx.fillStyle = 'rgba(10,10,10,0.9)';
          ctx.beginPath();
          for (let q = 0; q < 3; q++) {
            const a = fr * (1 + q * 0.13) + q * 2.1;
            const R = s * 1.5 + 2;
            const fx = k.x + Math.cos(a) * R;
            const fy = k.y + Math.sin(a * 1.3) * R * 0.7;
            ctx.moveTo(fx + fs, fy);
            ctx.arc(fx, fy, fs, 0, Math.PI * 2);
          }
          ctx.fill();
          this.seen.flies = true;
        }
      } else {
        // кости
        ctx.strokeStyle = 'rgba(235,228,210,0.85)';
        ctx.lineWidth = 1;
        const r = Math.max(2, k.size * 0.8);
        ctx.beginPath();
        ctx.moveTo(k.x - r, k.y - r * 0.5);
        ctx.lineTo(k.x + r, k.y + r * 0.5);
        ctx.moveTo(k.x - r, k.y + r * 0.5);
        ctx.lineTo(k.x + r, k.y - r * 0.5);
        ctx.stroke();
      }
      if (z > 2 && st > 0.1 && act && act[k.idx] > 0.8) {
        // плесень — серо-зелёные пушистые точки
        const h = hash2(k.y, k.x);
        ctx.fillStyle = 'rgba(178,198,150,0.85)';
        ctx.beginPath();
        for (let q = 0; q < (h > 0.5 ? 4 : 3); q++) {
          const a = h * 20 + q * 1.9;
          const rr = s * (0.25 + 0.45 * ((h * (q + 3) * 7) % 1));
          const mx = k.x + Math.cos(a) * rr;
          const my = k.y + Math.sin(a) * rr * 0.6;
          const ms = 0.25 + s * (0.04 + 0.025 * q);
          ctx.moveTo(mx + ms, my);
          ctx.arc(mx, my, ms, 0, Math.PI * 2);
        }
        ctx.fill();
        this.seen.mould = true;
      }
    }
  }

  /** Линза болезней: больные — пульсирующие красные кольца, переболевшие — синие точки, очаги — подписи. */
  private drawDiseaseMarks(vis: (x: number, y: number) => boolean, z: number): void {
    const ctx = this.ctx;
    const w = this.world;
    const pulse = 3 * Math.sin(this.frame * 0.2);
    ctx.beginPath();
    for (const c of w.creatures) {
      if (c.sick <= 0 || !vis(c.x, c.y)) continue;
      const r = Math.max(6 / z, c.g.size * 2 + 3 + pulse);
      ctx.moveTo(c.x + r, c.y);
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    }
    ctx.strokeStyle = 'rgba(255,72,60,0.95)';
    ctx.lineWidth = 1.8 / z;
    ctx.stroke();
    ctx.beginPath();
    for (const c of w.creatures) {
      if (c.immune <= 0 || c.sick > 0 || !vis(c.x, c.y)) continue;
      const r = Math.max(1.6 / z, c.g.size * 0.35);
      ctx.rect(c.x - r, c.y - c.g.size * 1.3 - r * 2, r * 2, r * 2);
    }
    ctx.fillStyle = '#5aa9ff';
    ctx.fill();
    ctx.font = `${Math.max(4, 13 / z)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,200,190,0.95)';
    for (const P of w.pathogens.values()) {
      if (!P.announced || P.ended !== null || !vis(P.x, P.y)) continue;
      ctx.fillText(`🦠 ${P.name}`, P.x, P.y);
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
    } else if (e.kind === 'mutagen') {
      // ☢️ всплеск мутаций: зеленоватая волна радиусом ~150
      P.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: 0, max: 90, kind: 'blast', hue: 90 });
    } else if (e.kind === 'discovery') {
      // 🌟 открытие: золотая звёздная вспышка над носителями
      P.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: 0, max: 80, kind: 'burst', hue: 48 });
      for (let i = 0; i < 2; i++) P.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: -i * 18, max: 70, kind: 'star', hue: 48 });
    } else if (e.kind === 'zap') {
      // ⚡ разряд электрического органа: голубой зигзаг и искры
      P.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: 0, max: 14, kind: 'zap', hue: 190 });
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2;
        P.push({ x: e.x, y: e.y, vx: Math.cos(a) * 1.1, vy: Math.sin(a) * 1.1, life: 0, max: 18, kind: 'spark', hue: 190 });
      }
    } else if (e.kind === 'yuck') {
      // 🤢 хищник отравился: зелёное кольцо
      P.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: 0, max: 40, kind: 'ring', hue: 100 });
    } else if (e.kind === 'newSpecies') {
      for (let i = 0; i < 3; i++) P.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: -i * 15, max: 70, kind: 'star', hue: e.hue });
    } else if (e.kind === 'outbreak') {
      // споры вспышки: зелёное облачко, всплывающее над очагом
      const r = this.rnd;
      for (let i = 0; i < 8; i++) P.push({ x: e.x + (r() - 0.5) * 10, y: e.y + (r() - 0.5) * 10, vx: (r() - 0.5) * 0.3, vy: -0.15 - r() * 0.25, life: -i * 4, max: 120, kind: 'spore', hue: 0 });
      this.seen.spore = true;
    }
  }

  draw(selected: Creature | null, family: Set<number>, cursorWorld: [number, number] | null): void {
    const { ctx, canvas, cam, world } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    this.frame++;
    this.bk = window.innerWidth < 700 ? 0.5 : 1;
    this.zoom = cam.zoom;
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
      for (const [t, x, y, size] of shown) if (t.rivers) ctx.drawImage(t.rivers, x, y, size, size);
    } else ctx.drawImage(this.riverLayer, 0, 0, world.width, world.height);
    const vx0 = cam.x - W / 2 / z;
    const vy0 = cam.y - H / 2 / z;
    const vx1 = cam.x + W / 2 / z;
    const vy1 = cam.y + H / 2 / z;
    if (px > 2.5 && this.lens === 'off') this.drawGrassBlades(vx0, vy0, vx1, vy1);
    // под линзой деревья полупрозрачны — иначе в лесу раскраску не видно
    if (this.lens !== 'off') ctx.globalAlpha = 0.3;
    for (const [t, x, y, size] of shown) ctx.drawImage(t.deco, x, y, size, size);
    ctx.globalAlpha = 1;
    // грибы и микроскоп — поверх крон, иначе в лесу их не разглядеть
    if (this.lens === 'microbes' && px > 5) this.drawMicroscope(vx0, vy0, vx1, vy1);
    else if (px > 2.5 && this.lens === 'off') this.drawMicroLife(vx0, vy0, vx1, vy1);
    this.emitAmbient(vx0, vy0, vx1, vy1, z);

    // видимая область (с запасом)
    const x0 = vx0 - 30;
    const x1 = vx1 + 30;
    const y0 = vy0 - 30;
    const y1 = vy1 + 30;
    const vis = (x: number, y: number) => x > x0 && x < x1 && y > y0 && y < y1;

    // падаль: пятно, туша с мухами → кости, плесень; потом — следы костей
    if (z > 0.6) this.drawCorpses(vis, z);

    if (selected?.alive && world.oe) {
      // ♾️ кольца чувств: где выбранный зверь сейчас видит, слышит, слышит эхо, чует, чувствует тепло и ток
      const r = world.senses(selected);
      ctx.lineWidth = 1.2 / z;
      ctx.setLineDash([5 / z, 4 / z]);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, Math.max(r.vision, 1), 0, Math.PI * 2);
      ctx.fill();
      let shown = 0;
      for (const [v, col] of [[r.vision, '255,224,90'], [r.hearing, '110,160,255'], [r.echo, '190,120,255'], [r.smell, '110,230,120'], [r.heat, '255,110,90'], [r.electric, '90,235,255']] as const) {
        if (v < 2) continue;
        shown++;
        ctx.strokeStyle = `rgba(${col},0.75)`;
        ctx.beginPath();
        ctx.arc(selected.x, selected.y, v, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (shown) this.seen.rings = true;
    } else if (selected?.alive) {
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
    const oe = world.oe;
    this.many = this.nDetail > 250;
    this.nDetail = 0;
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
      // в линзе болезней здоровые приглушены, чтобы были видны больные
      ctx.globalAlpha = dim ? 0.25 : this.lens === 'disease' && c.sick <= 0 ? 0.45 : 1;
      if (detail && c.g.size * z > 2.5) {
        if (oe) {
          this.nDetail++;
          this.drawAnimalOE(c);
        } else this.drawAnimal(c);
      } else if (oe) this.drawDotOE(c, z);
      else this.drawDot(c, z);
    }
    ctx.globalAlpha = 1;
    if (this.lens === 'disease') this.drawDiseaseMarks(vis, z);
    if (oe) this.drawEcho(vis, z, night);

    this.drawParticles();

    // ночь: тёмно-синяя вуаль
    if (night > 0.02) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = `rgba(8,14,40,${night * 0.55})`;
      ctx.fillRect(0, 0, W, H);
      if (night > 0.3) {
        ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cam.x * z), dpr * (H / 2 - cam.y * z));
        this.drawNightGlow(vx0, vy0, vx1, vy1, z, night);
      } else this.wakes.length = 0;
      // ♾️ светящиеся органы зверей
      if (oe) {
        ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cam.x * z), dpr * (H / 2 - cam.y * z));
        this.drawPhotophores(vis, z, night, detail);
      }
      // глаза светятся в темноте
      if (detail && night > 0.3) {
        ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cam.x * z), dpr * (H / 2 - cam.y * z));
        ctx.fillStyle = `rgba(255,240,170,${(night - 0.3) * 1.2})`;
        for (const c of world.creatures) {
          if (!vis(c.x, c.y) || c.g.diet < 0.5 || (oe && c.g.ph[P.EYEQ] === 0)) continue;
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
    // больные зеленеют и блекнут — тем сильнее, чем злее штамм
    if (c.sick > 0) return `hsl(${c.g.hue + (75 - c.g.hue) * 0.5 * c.vir}, ${(35 + e * 35) * 0.55}%, ${l - (1 - e) * 15}%)`;
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
    if (c.sick > 0) {
      ctx.strokeStyle = 'rgba(200,245,160,0.85)';
      ctx.lineWidth = 0.8 / z;
      ctx.strokeRect(c.x - r - 0.6 / z, c.y - r - 0.6 / z, r * 2 + 1.2 / z, r * 2 + 1.2 / z);
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
    // больной: бледно-зелёные «микробы» кружат у головы
    if (c.sick > 0) {
      const a = this.frame * 0.15 + c.id;
      ctx.fillStyle = 'rgba(200,245,160,0.9)';
      ctx.beginPath();
      for (let q = 0; q < 2; q++) {
        const sx = hx + Math.cos(a + q * Math.PI) * hr * 1.5;
        const sy = Math.sin(a + q * Math.PI) * hr * 1.5;
        ctx.moveTo(sx + Math.max(0.3, s * 0.09), sy);
        ctx.arc(sx, sy, Math.max(0.3, s * 0.09), 0, Math.PI * 2);
      }
      ctx.fill();
      this.seen.sick = true;
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

  // ---------------- ♾️ открытая эволюция: зверь по своему телу ----------------

  /** Полуоси тела (как в drawAnimalOE): форма, хищник, жир, краб. */
  private bodyR(c: Creature): [number, number] {
    const g = c.g, ph = g.ph, shape = g.body.shape, s = g.size * 1.25;
    if (crabLike(g)) return [s * 0.72, s * 0.98];
    return [s * (0.8 + 0.5 * shape), s * (0.85 - 0.35 * shape) * (g.diet > 0.65 ? 0.85 : 1) * (1 + 0.25 * ph[P.FAT])];
  }

  /** Летит ли зверь сейчас: умеет летать и движется (или под ним вода). */
  private flying(c: Creature, water: boolean): boolean {
    return c.g.ph[P.FLY] >= 1 && c.g.swim < 0.5 && c.state !== 'torpor' && (water || c.v > 0.25 * c.g.speed);
  }

  /** Точка издалека: летуны — галочка, панцирные — шестиугольник, остальные — как раньше. */
  private drawDotOE(c: Creature, z: number): void {
    const ph = c.g.ph;
    const flier = ph[P.FLY] >= 1 && c.g.swim < 0.5;
    if (!flier && ph[P.SHELL] < 0.5) return this.drawDot(c, z);
    const ctx = this.ctx;
    const r = Math.max(c.g.size * 1.2, 2.2 / z);
    const co = Math.cos(c.heading), si = Math.sin(c.heading);
    const pt = (x: number, y: number, first = false) => (first ? ctx.moveTo(c.x + co * x - si * y, c.y + si * x + co * y) : ctx.lineTo(c.x + co * x - si * y, c.y + si * x + co * y));
    ctx.fillStyle = this.color(c);
    ctx.beginPath();
    if (flier) {
      pt(r * 1.3, 0, true);
      pt(-r, r * 1.15);
      pt(-r * 0.35, 0);
      pt(-r, -r * 1.15);
    } else for (let i = 0; i < 6; i++) pt(Math.cos((i * Math.PI) / 3) * r * 1.15, Math.sin((i * Math.PI) / 3) * r * 1.15, i === 0);
    ctx.closePath();
    ctx.fill();
    if (c.sick > 0) {
      ctx.strokeStyle = 'rgba(200,245,160,0.85)';
      ctx.lineWidth = 0.8 / z;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /**
   * Существо по телу (§9.1): форма, ноги (или их нет), панцирь, мех, перепонки, клешни, рога, глаза (или слепота),
   * уши, нос, тепловые ямки, электрорецепторы, ядовитые пятна, водоросли-симбионты, горловой мешок, спячка, нора.
   */
  private drawAnimalOE(c: Creature): void {
    const ctx = this.ctx;
    const w = this.world;
    const g = c.g, ph = g.ph, shape = g.body.shape;
    const s = g.size * 1.25;
    const pm = this.pmode;
    const walk = pm === 2 ? 0 : Math.sin(c.age * 0.5 * Math.max(0.3, c.v)) * (c.v > 0.05 ? 1 : 0);
    const inWater = pm === 2 ? g.swim > 0.6 : BIOMES[w.terrain.biome[w.terrain.index(c.x, c.y)]].water;
    const torpid = c.state === 'torpor';
    const hidden = pm === 0 && w.hidden(c);
    const fly = pm === 0 && this.flying(c, inWater);
    const pred = g.diet > 0.65;
    const swim = g.swim > 0.6;
    const crab = crabLike(g);
    let [rx, ry] = this.bodyR(c);
    if (torpid) rx = ry = Math.sqrt(rx * ry) * 0.9; // свернулся клубком
    const legs = ph[P.LEGS] | 0;
    const shell = ph[P.SHELL], fur = ph[P.FUR], memb = ph[P.MEMB], claw = ph[P.CLAW], horn = ph[P.HORN], dig = ph[P.DIG];
    const a0 = ctx.globalAlpha;
    if (hidden) ctx.globalAlpha = a0 * 0.45;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.heading);

    // тень (у летящего — дальше, над водой — вдвое)
    const so = fly ? (inWater ? 2 : 1.5) : 1;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(s * 0.15 * so, s * 0.35 * so, rx * 1.2, Math.max(ry, s * 0.5) * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    const body = this.color(c);
    const dark = `hsl(${g.hue}, 40%, 25%)`;

    // перепонки: два полупрозрачных паруса; в полёте машут
    if (memb >= 0.25 && !torpid) {
      const flap = fly ? 0.55 + 0.45 * Math.abs(Math.sin(this.frame * 0.4 + c.id)) : 0.7;
      const span = Math.max(ry, s * 0.6) * (1 + 2 * memb) * flap;
      ctx.fillStyle = `hsla(${g.hue}, 40%, 68%, 0.5)`;
      ctx.strokeStyle = dark;
      ctx.lineWidth = Math.max(0.3, s * 0.05);
      for (const side of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(rx * 0.5, side * ry * 0.4);
        ctx.quadraticCurveTo(rx * 0.35, side * span * 1.1, -rx * 0.1, side * span);
        ctx.quadraticCurveTo(-rx * 0.35, side * span * 0.7, -rx * 0.6, side * ry * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(rx * 0.2, side * ry * 0.4);
        ctx.lineTo(-rx * 0.1, side * span);
        ctx.stroke();
      }
    }

    if (inWater && !fly) {
      // круги на воде
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.ellipse(-s * 0.3, 0, rx * 1.6 + walk, Math.max(ry, s * 0.6) * 1.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (!torpid && !fly) {
      ctx.strokeStyle = dark;
      ctx.lineCap = 'round';
      const lw = Math.max(0.6, s * 0.16);
      const L = s * (0.5 + 0.7 * ph[P.LEGLEN]);
      if (crab) {
        // краб: по три ноги с каждой стороны, веером, с коленом
        ctx.lineWidth = lw;
        for (const side of [1, -1]) for (const [j, a] of [0.3, 0.9, 1.4].entries()) {
          const th = side * (Math.PI / 2 + (a - 0.85));
          const bx = Math.cos(th) * rx * 0.8, by = Math.sin(th) * ry * 0.8;
          const kx = bx + Math.cos(th) * L * 0.6, ky = by + Math.sin(th) * L * 0.6 - side * L * 0.1;
          const st = walk * (j % 2 ? 1 : -1) * s * 0.2;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(kx + st, ky);
          ctx.lineTo(kx + st - L * 0.25, ky + side * L * 0.45);
          ctx.stroke();
        }
      } else if (legs > 0) {
        for (let k = 0; k < legs; k++) {
          const lx = legs === 1 ? 0 : rx * (0.55 - (1.1 * k) / (legs - 1));
          const phs = k % 2 ? -1 : 1;
          const front = k === 0 && dig >= 0.15;
          ctx.lineWidth = lw * (front ? 1 + 1.5 * dig : 1);
          for (const side of [1, -1]) {
            const fx = lx + walk * phs * side * s * 0.35, fy = side * (ry * 0.5 + L * 0.7);
            ctx.beginPath();
            ctx.moveTo(lx, side * ry * 0.5);
            ctx.lineTo(fx, fy);
            ctx.stroke();
            if (front) {
              // роющие когти
              ctx.lineWidth = Math.max(0.3, lw * 0.45);
              ctx.beginPath();
              for (let q = -1; q <= 1; q++) {
                ctx.moveTo(fx, fy);
                ctx.lineTo(fx + s * 0.28, fy + side * q * s * 0.1);
              }
              ctx.stroke();
              ctx.lineWidth = lw * (1 + 1.5 * dig);
            }
          }
        }
      }
    }

    // хвост: у безногих на суше — длинный, змеистый
    if (!crab) {
      ctx.strokeStyle = body;
      if (legs === 0 && !swim && !inWater) {
        ctx.lineWidth = Math.max(0.6, ry * 0.7);
        ctx.lineCap = 'round';
        const ph0 = c.age * 0.25 * Math.max(0.3, c.v);
        ctx.beginPath();
        ctx.moveTo(-rx * 0.8, 0);
        for (let i = 1; i <= 6; i++) ctx.lineTo(-rx * 0.8 - i * s * 0.32, Math.sin(ph0 + i * 1.1) * s * 0.3 * (i / 6 + 0.4));
        ctx.stroke();
      } else {
        ctx.lineWidth = Math.max(0.5, s * (swim ? 0.35 : 0.15));
        ctx.beginPath();
        ctx.moveTo(-rx * 0.9, 0);
        ctx.quadraticCurveTo(-rx * 0.9 - s * 0.5, walk * s * 0.4, -rx * 0.9 - s * (swim ? 0.6 : 0.8), walk * s * 0.6 + (swim ? 0 : s * 0.1));
        ctx.stroke();
        if (swim) {
          ctx.fillStyle = body;
          ctx.beginPath();
          ctx.moveTo(-rx * 0.9 - s * 0.5, 0);
          ctx.lineTo(-rx * 0.9 - s, -s * 0.5);
          ctx.lineTo(-rx * 0.9 - s, s * 0.5);
          ctx.fill();
        }
      }
    }

    // тело
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = dark;
    ctx.globalAlpha *= 0.45;
    if (g.pattern > 0.66) {
      for (let i = -2; i <= 2; i++) ctx.fillRect(i * rx * 0.32 - rx * 0.06, -ry, rx * 0.12, ry * 2);
    } else if (g.pattern < 0.33) {
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(((i % 2) - 0.5) * rx * 0.8 + (i > 1 ? rx * 0.3 : -rx * 0.2), ((i % 3) - 1) * ry * 0.38, s * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = hidden ? a0 * 0.45 : a0;
    if (ph[P.PSYM] > 0.05) {
      // водоросли-симбионты под кожей
      ctx.fillStyle = `rgba(70,200,80,${0.5 * ph[P.PSYM]})`;
      ctx.fillRect(-rx, -ry, rx * 2, ry * 2);
    }
    if (ph[P.TOXIN] >= 0.2) {
      // ядовитые пятна — контрастного цвета
      ctx.fillStyle = `hsla(${(g.hue + 180) % 360}, 90%, 60%, ${Math.min(1, 0.3 + ph[P.TOXIN])})`;
      for (const [px, py] of [[0.35, 0.4], [-0.3, 0.4], [0.35, -0.4], [-0.3, -0.4]]) {
        ctx.beginPath();
        ctx.arc(px * rx, py * ry, Math.max(0.4, s * 0.14), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // панцирь: тёмный купол с дугами; толстый — с шестиугольниками
    if (shell >= 0.25) {
      ctx.fillStyle = `hsla(${g.hue}, 30%, 22%, ${Math.min(0.95, 0.4 + 0.6 * shell)})`;
      ctx.beginPath();
      ctx.ellipse(-rx * 0.05, 0, rx * 0.85, ry * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = Math.max(0.3, s * 0.05);
      ctx.beginPath();
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(i * rx * 0.35 - rx * 0.05, -ry * 0.72);
        ctx.quadraticCurveTo(i * rx * 0.35 + rx * 0.1, 0, i * rx * 0.35 - rx * 0.05, ry * 0.72);
      }
      ctx.stroke();
      if (shell > 0.75 && (pm > 0 || s * this.zoom >= 5)) {
        const hr0 = Math.min(rx, ry) * 0.32;
        ctx.beginPath();
        for (let i = 0; i <= 6; i++) {
          const a = (i * Math.PI) / 3;
          const x = -rx * 0.05 + Math.cos(a) * hr0, y = Math.sin(a) * hr0;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3;
          ctx.moveTo(-rx * 0.05 + Math.cos(a) * hr0, Math.sin(a) * hr0);
          ctx.lineTo(-rx * 0.05 + Math.cos(a) * rx * 0.78, Math.sin(a) * ry * 0.78);
        }
        ctx.stroke();
      }
    }
    // мех: короткие штрихи по краю
    if (fur >= 0.3 && (pm > 0 || !this.many)) {
      ctx.strokeStyle = `hsl(${g.hue}, 30%, 70%)`;
      ctx.lineWidth = Math.max(0.3, s * 0.06);
      const fl = s * (0.12 + 0.25 * fur);
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI * 2) / 10 + 0.3;
        const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
        ctx.moveTo(x * 0.92, y * 0.92);
        ctx.lineTo(x + Math.cos(a) * fl, y + Math.sin(a) * fl);
      }
      ctx.stroke();
    }

    // голова (у краба — нет: глаза на стебельках прямо на панцире)
    const hr = s * (pred ? 0.5 : 0.45);
    const hx = crab ? rx * 0.8 : torpid ? rx * 0.55 : rx + s * 0.05;
    const blind = ph[P.EYEQ] === 0;
    const eyeR = Math.max(0.4, hr * 0.28) * (0.6 + 0.6 * ph[P.EYE]);
    const closed = blind || torpid;
    // клешни: у краба — большие, с вырезом
    if (crab || claw >= 0.3) {
      const pr = s * (0.25 + 0.35 * Math.max(claw, 0.3));
      ctx.lineWidth = Math.max(0.5, s * 0.14);
      ctx.strokeStyle = dark;
      for (const side of [1, -1]) {
        const bx = crab ? rx * 0.6 : hx - hr * 0.2, by = side * (crab ? ry * 0.55 : hr * 0.7);
        const px = crab ? rx * 1.3 : hx + hr * 1.35, py = side * (crab ? ry * 0.6 : hr * 1.15);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo((bx + px) / 2, py + side * pr * 0.9, px - pr * 0.5, py);
        ctx.stroke();
        ctx.fillStyle = shell >= 0.25 ? `hsl(${g.hue}, 30%, 30%)` : dark;
        ctx.beginPath();
        ctx.ellipse(px, py, pr, pr * 0.62, 0, 0, Math.PI * 2);
        ctx.fill();
        // вырез между «пальцами»
        ctx.fillStyle = 'rgba(10,12,8,0.75)';
        ctx.beginPath();
        ctx.moveTo(px + pr * 1.05, py - pr * 0.18);
        ctx.lineTo(px + pr * 0.05, py);
        ctx.lineTo(px + pr * 1.05, py + pr * 0.18);
        ctx.fill();
      }
    }
    if (crab) {
      ctx.strokeStyle = dark;
      ctx.lineWidth = Math.max(0.3, s * 0.07);
      for (const side of [1, -1]) {
        const ex = hx + s * 0.32, ey = side * ry * 0.3;
        ctx.beginPath();
        ctx.moveTo(hx - s * 0.05, side * ry * 0.2);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        this.eye(ex, ey, eyeR, closed);
      }
    } else {
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.ellipse(hx, 0, hr * (pred ? 1.3 : 1.1), hr, 0, 0, Math.PI * 2);
      ctx.fill();
      // нос: морда с усами
      if (ph[P.NOSE] >= 0.5) {
        ctx.beginPath();
        ctx.ellipse(hx + hr * 1.05, 0, hr * 0.55, hr * 0.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(240,235,220,0.7)';
        ctx.lineWidth = Math.max(0.2, s * 0.03);
        ctx.beginPath();
        for (const side of [1, -1]) for (let q = -1; q <= 1; q++) {
          ctx.moveTo(hx + hr * 1.3, side * hr * 0.2);
          ctx.lineTo(hx + hr * 1.9, side * hr * (0.55 + q * 0.25));
        }
        ctx.stroke();
      }
      // уши (у пловцов — нет)
      if (!swim) {
        const ek = clamp(ph[P.EAR] / 0.3, 0.7, 2);
        ctx.fillStyle = dark;
        if (g.diet < 0.35) {
          for (const side of [1, -1]) {
            ctx.beginPath();
            ctx.ellipse(hx - hr * 0.6, side * hr * 0.7 * Math.sqrt(ek), hr * 0.9 * ek, hr * 0.28 * Math.sqrt(ek), side * 0.5, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          for (const side of [1, -1]) {
            ctx.beginPath();
            ctx.moveTo(hx - hr * 0.2, side * hr * 0.5);
            ctx.lineTo(hx - hr * (0.2 + 0.7 * ek), side * hr * (0.5 + 0.7 * ek));
            ctx.lineTo(hx - hr * 0.7, side * hr * 0.2);
            ctx.fill();
          }
        }
      }
      // рога: у круглых — парные изогнутые, у вытянутых — на носу
      if (horn >= 0.15) {
        const hl = hr * (0.6 + 1.6 * horn);
        ctx.strokeStyle = ctx.fillStyle = '#e8dcc0';
        if (shape < 0.5) {
          ctx.lineWidth = Math.max(0.5, hr * 0.26);
          ctx.lineCap = 'round';
          for (const side of [1, -1]) {
            ctx.beginPath();
            ctx.moveTo(hx, side * hr * 0.5);
            ctx.quadraticCurveTo(hx + hl * 0.2, side * (hr * 0.5 + hl * 0.9), hx + hl * 0.85, side * (hr * 0.45 + hl * 0.45));
            ctx.stroke();
          }
        } else {
          const nx = hx + hr * (ph[P.NOSE] >= 0.5 ? 1.25 : 0.8);
          ctx.beginPath();
          ctx.moveTo(nx, -hr * 0.28);
          ctx.lineTo(nx + hl, 0);
          ctx.lineTo(nx, hr * 0.28);
          ctx.fill();
        }
      }
      // глаза: размер — от «зрения»; без глаз — бледная сомкнутая щель
      for (const side of [1, -1]) this.eye(hx + hr * 0.4, side * hr * 0.45, eyeR, closed);
      // тепловые ямки и электрорецепторы
      if (ph[P.PIT] >= 0.2) {
        ctx.fillStyle = 'rgba(30,10,10,0.85)';
        for (const side of [1, -1]) {
          ctx.beginPath();
          ctx.arc(hx + hr * 0.95, side * hr * 0.22, Math.max(0.3, hr * 0.1), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (ph[P.AMPUL] >= 0.2) {
        ctx.fillStyle = 'rgba(210,240,255,0.8)';
        for (let q = -1; q <= 1; q++) {
          ctx.beginPath();
          ctx.arc(hx + hr * 0.15, q * hr * 0.3, Math.max(0.25, hr * 0.07), 0, Math.PI * 2);
          ctx.fill();
        }
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
    }
    // горловой мешок: кричит тревогу
    const sac = c.alarm > 0 && ph[P.VOICE] > 0.2 && pm === 0;
    if (sac) {
      ctx.fillStyle = 'rgba(255,160,190,0.75)';
      ctx.beginPath();
      ctx.arc(hx - hr * 0.5, 0, hr * (0.3 + 0.5 * ph[P.VOICE]), 0, Math.PI * 2);
      ctx.fill();
    }
    // светящиеся органы видны и днём — на портрете
    if (pm > 0 && ph[P.PHOTO] >= 0.2) {
      ctx.fillStyle = `hsla(185,100%,72%,${0.5 + 0.5 * ph[P.PHOTO]})`;
      const n = 2 + Math.round(6 * ph[P.PHOTO]);
      for (let i = 0; i < n; i++) {
        const [px, py] = photoAt(i, n, rx, ry);
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.4, s * 0.09), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // больной: бледно-зелёные «микробы» кружат у головы
    if (c.sick > 0) {
      const a = this.frame * 0.15 + c.id;
      ctx.fillStyle = 'rgba(200,245,160,0.9)';
      ctx.beginPath();
      for (let q = 0; q < 2; q++) {
        const sx = hx + Math.cos(a + q * Math.PI) * hr * 1.5;
        const sy = Math.sin(a + q * Math.PI) * hr * 1.5;
        ctx.moveTo(sx + Math.max(0.3, s * 0.09), sy);
        ctx.arc(sx, sy, Math.max(0.3, s * 0.09), 0, Math.PI * 2);
      }
      ctx.fill();
      this.seen.sick = true;
    }
    ctx.restore();
    ctx.globalAlpha = a0;
    if (hidden) {
      // холмик над норой
      ctx.strokeStyle = 'rgba(110,80,50,0.6)';
      ctx.lineWidth = Math.max(0.6, s * 0.22);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 1.1 * s, 0, Math.PI * 2);
      ctx.stroke();
    }
    const fs = Math.max(6, s);
    if (sac) {
      ctx.fillStyle = 'rgba(255,200,220,0.9)';
      ctx.font = `${fs * 0.8}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText(')))', c.x + Math.cos(c.heading) * (rx + s * 1.4), c.y + Math.sin(c.heading) * (rx + s * 1.4));
    }
    if (torpid && pm === 0) {
      const t = (this.frame + c.id * 37) % 120;
      if (t < 60) {
        ctx.globalAlpha = a0 * (1 - t / 60);
        ctx.fillStyle = '#cfe3ff';
        ctx.font = `bold ${fs * 0.9}px system-ui`;
        ctx.textAlign = 'center';
        ctx.fillText('z', c.x + s * 0.6, c.y - s * 1.3 - t * 0.04 * s);
        ctx.globalAlpha = a0;
      }
    } else if (c.state === 'flee' && c.alarm > 0 && pm === 0) {
      ctx.fillStyle = '#ff6b5b';
      ctx.font = `bold ${fs}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText('!', c.x, c.y - s * 1.6);
    }
  }

  /** Глаз: белок и зрачок — или бледная сомкнутая щель (слепой или спит). */
  private eye(x: number, y: number, r: number, closed: boolean): void {
    const ctx = this.ctx;
    if (closed) {
      ctx.strokeStyle = 'rgba(225,220,205,0.85)';
      ctx.lineWidth = Math.max(0.25, r * 0.45);
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.lineTo(x + r, y);
      ctx.stroke();
      return;
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(x + r * 0.35, y, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  /** ♾️ Ночью: светящиеся органы (бюджет 300 × bk), издалека — одна точка. */
  private drawPhotophores(vis: (x: number, y: number) => boolean, z: number, night: number, detail: boolean): void {
    const ctx = this.ctx;
    let budget = Math.floor(300 * this.bk);
    ctx.globalCompositeOperation = 'lighter';
    for (const c of this.world.creatures) {
      const pv = c.g.ph[P.PHOTO];
      if (pv < 0.2 || !vis(c.x, c.y)) continue;
      if (budget-- <= 0) break;
      // в полную силу уже там, где HUD показывает 🌙 (night ≈ 0.53): в сумерках свет только набирается
      const a = Math.min(1, (0.45 + 0.55 * pv) * clamp((night - 0.12) / 0.38, 0, 1));
      if (!detail || c.g.size * z <= 2.5) {
        ctx.fillStyle = `hsla(185,100%,70%,${a * 0.35})`;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 4 / z, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `hsla(185,100%,75%,${a})`;
        ctx.fillRect(c.x - 0.75 / z, c.y - 0.75 / z, 1.5 / z, 1.5 / z);
        continue;
      }
      const [rx, ry] = this.bodyR(c);
      const co = Math.cos(c.heading), si = Math.sin(c.heading);
      const n = 2 + Math.round(6 * pv);
      const r = Math.max(0.5, c.g.size * 1.25 * 0.1);
      const tw = 0.75 + 0.25 * Math.sin(this.frame * 0.08 + c.id);
      for (let i = 0; i < n; i++) {
        const [px, py] = photoAt(i, n, rx, ry);
        const x = c.x + co * px - si * py, y = c.y + si * px + co * py;
        ctx.fillStyle = `hsla(185,100%,70%,${a * 0.3 * tw})`;
        ctx.beginPath();
        ctx.arc(x, y, r * 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `hsla(185,100%,78%,${a * tw})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** ♾️ Дуги эха: эхолокаторы на охоте или в бегстве — ночью или в воде (бюджет 60 × bk). */
  private drawEcho(vis: (x: number, y: number) => boolean, z: number, night: number): void {
    const ctx = this.ctx, w = this.world;
    let budget = Math.floor(60 * this.bk);
    ctx.lineWidth = 1 / z;
    for (const c of w.creatures) {
      if (c.state !== 'hunt' && c.state !== 'flee') continue;
      const ph = c.g.ph;
      if (ph[P.EAR] < 0.4 || ph[P.VOICE] < 0.4 || !vis(c.x, c.y)) continue;
      if (night < 0.3 && !BIOMES[w.terrain.biome[c.cell]].water) continue;
      if (budget-- <= 0) break;
      const s = c.g.size * 1.25;
      for (let q = 0; q < 2; q++) {
        const k = (((this.frame + c.id * 7) % 30) / 30 + q * 0.5) % 1;
        ctx.strokeStyle = `rgba(200,160,255,${0.7 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(c.x, c.y, s * 1.8 + k * s * 7, c.heading - 0.6, c.heading + 0.6);
        ctx.stroke();
      }
    }
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
        ctx.fillStyle = p.hue === 0 ? '#ff5252' : p.hue === 190 ? '#7ff6ff' : '#ffb74d';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.hue === 0 ? 0.7 : 1.6, 0, Math.PI * 2);
        ctx.fill();
        p.vx *= 0.92;
        p.vy *= 0.92;
      } else if (p.kind === 'blast') {
        const mu = p.hue === 90; // ☢️ всплеск мутаций — зелёная волна радиусом 150, без огня
        ctx.fillStyle = mu ? `rgba(140,255,90,${0.25 * (1 - k)})` : `rgba(255,150,50,${0.5 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, mu ? 10 + k * 140 : 20 + k * 200, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = mu ? 'rgba(200,255,160,0.8)' : 'rgba(255,240,180,0.9)';
        ctx.lineWidth = 4;
        ctx.stroke();
      } else if (p.kind === 'star') {
        ctx.strokeStyle = `hsl(${p.hue},90%,70%)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6 + k * 70, 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'burst') {
        // восемь золотых лучей, разлетаются и гаснут
        const r0 = 4 + k * 26, r1 = 10 + k * 60;
        ctx.strokeStyle = `hsl(${p.hue},100%,68%)`;
        ctx.lineWidth = 2.2 * (1 - k) + 0.4;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4 + k * 0.6;
          const rr = i % 2 ? r1 * 0.6 : r1;
          ctx.moveTo(p.x + Math.cos(a) * r0, p.y + Math.sin(a) * r0);
          ctx.lineTo(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr);
        }
        ctx.stroke();
      } else if (p.kind === 'zap') {
        ctx.strokeStyle = '#9ff8ff';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let q = 0; q < 2; q++) {
          const a = p.life * 1.7 + q * Math.PI;
          let x = p.x, y = p.y;
          ctx.moveTo(x, y);
          for (let j = 1; j <= 4; j++) {
            x = p.x + Math.cos(a) * j * 3.5 + (j % 2 ? 2.5 : -2.5) * Math.sin(a);
            y = p.y + Math.sin(a) * j * 3.5 - (j % 2 ? 2.5 : -2.5) * Math.cos(a);
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      } else if (p.kind === 'spore') {
        ctx.globalAlpha = Math.sin(Math.PI * k) * 0.85;
        ctx.fillStyle = '#a6e06a';
        ctx.beginPath();
        ctx.arc(p.x + Math.sin(p.life * 0.1 + p.vx * 50) * 1.5, p.y, Math.max(0.9, 2.6 / this.zoom), 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'bubble') {
        // пузырь метана: всплывает, растёт и лопается
        ctx.globalAlpha = 0.65 * (1 - k * k);
        ctx.strokeStyle = 'rgba(215,240,220,1)';
        ctx.lineWidth = 0.25;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.hue * (0.4 + k), 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'steam') {
        ctx.globalAlpha = 0.2 * Math.sin(Math.PI * k);
        ctx.fillStyle = '#eef3f8';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5 + k * 6, 0, Math.PI * 2);
        ctx.fill();
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
    if (this.lens !== 'off') ctx.drawImage(this.overlay, 0, 0, mw, mh);
    const sx = mw / this.world.width;
    const sy = mh / this.world.height;
    const dis = this.lens === 'disease';
    for (const c of this.world.creatures) {
      if (dis && c.sick > 0) continue;
      ctx.fillStyle = `hsl(${c.g.hue},70%,${c.g.diet > 0.65 ? 60 : 75}%)`;
      ctx.fillRect(c.x * sx - 0.75, c.y * sy - 0.75, 1.5, 1.5);
    }
    if (dis) {
      // больные — красным поверх остальных
      ctx.fillStyle = '#ff4a3c';
      for (const c of this.world.creatures) if (c.sick > 0) ctx.fillRect(c.x * sx - 1.25, c.y * sy - 1.25, 2.5, 2.5);
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
    this.portraitOf(canvas, c, 1);
  }

  /** ♾️ Портрет по геному — для вымерших записей бестиария (зверь-заглушка). */
  portraitGenome(canvas: HTMLCanvasElement, g: Genome): void {
    const stub = {
      id: 0, sp: 0, g, x: 0, y: 0, heading: 0, v: 0, age: 0, energy: this.world.maxEnergy(g), sick: 0, vir: 0, alarm: 0,
      state: 'wander', torpor: 0, cell: 0, alive: true,
    } as unknown as Creature;
    this.portraitOf(canvas, stub, 2);
  }

  private portraitOf(canvas: HTMLCanvasElement, c: Creature, mode: 1 | 2): void {
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
    const oe = this.world.oe || mode === 2;
    const ph = c.g.ph;
    // ♾️ размах перепонок и рогов — чтобы зверь влез в рамку
    const k = (Math.min(w, h) * 0.32) / (c.g.size * 1.25 * (oe ? 1 + 0.4 * ph[P.MEMB] + 0.2 * ph[P.HORN] : 1));
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (w / 2 - c.x * k + c.g.size * k * 0.3), dpr * (h / 2 - c.y * k));
    const heading = c.heading;
    c.heading = 0;
    this.ctx = ctx;
    if (oe) {
      this.pmode = mode;
      this.drawAnimalOE(c);
      this.pmode = 0;
    } else this.drawAnimal(c);
    this.ctx = saved;
    c.heading = heading;
  }
}
