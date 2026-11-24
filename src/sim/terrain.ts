import { clamp, mulberry32, Noise, pick } from './random';

export const enum B {
  Deep,
  Shallow,
  Beach,
  Grass,
  Savanna,
  Forest,
  Swamp,
  Desert,
  Tundra,
  Mountain,
  Snow,
}

export interface BiomeInfo {
  name: string;
  /** Максимум травы в клетке. */
  fert: number;
  /** Множитель скорости движения. */
  move: number;
  /** Множитель дальности зрения. */
  sense: number;
  /** Цвет голой земли. */
  ground: [number, number, number];
  /** Цвет растительности. */
  plant: [number, number, number];
  water?: boolean;
}

export const BIOMES: BiomeInfo[] = [
  { name: 'Глубокое море', fert: 0.2, move: 1, sense: 1, ground: [22, 52, 92], plant: [40, 110, 120], water: true },
  { name: 'Мелководье', fert: 0.5, move: 1, sense: 1, ground: [42, 98, 138], plant: [60, 140, 120], water: true },
  { name: 'Пляж', fert: 0.15, move: 0.95, sense: 1.1, ground: [196, 180, 132], plant: [150, 170, 90] },
  { name: 'Луга', fert: 1, move: 1, sense: 1, ground: [104, 98, 62], plant: [92, 168, 70] },
  { name: 'Саванна', fert: 0.7, move: 1, sense: 1.15, ground: [150, 128, 76], plant: [170, 172, 72] },
  { name: 'Лес', fert: 0.8, move: 0.85, sense: 0.6, ground: [58, 70, 40], plant: [50, 120, 56] },
  { name: 'Болото', fert: 0.65, move: 0.6, sense: 0.8, ground: [62, 70, 52], plant: [86, 120, 70] },
  { name: 'Пустыня', fert: 0.08, move: 0.95, sense: 1.2, ground: [212, 176, 116], plant: [170, 160, 80] },
  { name: 'Тундра', fert: 0.35, move: 0.85, sense: 1.1, ground: [130, 136, 128], plant: [120, 146, 108] },
  { name: 'Горы', fert: 0.1, move: 0.6, sense: 1.25, ground: [112, 104, 98], plant: [104, 130, 90] },
  { name: 'Ледники', fert: 0.03, move: 0.7, sense: 1.2, ground: [222, 230, 238], plant: [170, 190, 170] },
];

/** Крупные «классы» местности — по ним нарезаются именованные регионы. */
const REGION_CLASS: Record<B, number> = {
  [B.Deep]: -1,
  [B.Shallow]: -1,
  [B.Beach]: 0,
  [B.Grass]: 0,
  [B.Savanna]: 1,
  [B.Forest]: 2,
  [B.Swamp]: 3,
  [B.Desert]: 4,
  [B.Tundra]: 5,
  [B.Mountain]: 6,
  [B.Snow]: 6,
};
const REGION_NOUNS = [
  ['Долина', 'Равнина', 'Луга', 'Степь'],
  ['Саванна', 'Прерия'],
  ['Лес', 'Чаща', 'Роща', 'Пуща'],
  ['Топи', 'Болота', 'Трясина'],
  ['Пустыня', 'Пески', 'Дюны'],
  ['Тундра', 'Мерзлота'],
  ['Горы', 'Хребет', 'Пики'],
];
const SYL = ['ка', 'эль', 'мир', 'ар', 'тан', 'ос', 'ри', 'ва', 'лун', 'дор', 'эн', 'са', 'гар', 'ил', 'ор', 'ми', 'нэ', 'шар', 'тэ', 'ул', 'ве', 'зар', 'ки', 'бал'];

export function properName(rand: () => number): string {
  const n = 2 + (rand() < 0.4 ? 1 : 0);
  let s = '';
  for (let i = 0; i < n; i++) s += pick(SYL, rand);
  return s[0].toUpperCase() + s.slice(1);
}

export interface Region {
  id: number;
  name: string;
  biome: B;
  cells: number;
  cx: number;
  cy: number;
}

export class Terrain {
  readonly cols: number;
  readonly rows: number;
  readonly elev: Float32Array;
  readonly moist: Float32Array;
  readonly baseTemp: Float32Array;
  readonly biome: Uint8Array;
  readonly region: Int16Array;
  regions: Region[] = [];
  seaLevel = 0;
  mountainLevel = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell: number,
    readonly seed: number,
  ) {
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(height / cell);
    const n = this.cols * this.rows;
    this.elev = new Float32Array(n);
    this.moist = new Float32Array(n);
    this.baseTemp = new Float32Array(n);
    this.biome = new Uint8Array(n);
    this.region = new Int16Array(n).fill(-1);
    this.generate();
  }

  index(x: number, y: number): number {
    const cx = clamp(Math.floor(x / this.cell), 0, this.cols - 1);
    const cy = clamp(Math.floor(y / this.cell), 0, this.rows - 1);
    return cy * this.cols + cx;
  }

  /** Сырые поля в произвольной точке (для отрисовки с плавными границами). */
  fieldsAt(x: number, y: number, out: { e: number; m: number; t: number }): void {
    const fx = clamp(x / this.cell - 0.5, 0, this.cols - 1.001);
    const fy = clamp(y / this.cell - 0.5, 0, this.rows - 1.001);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const i = y0 * this.cols + x0;
    const lerp2 = (a: Float32Array) =>
      (a[i] * (1 - tx) + a[i + 1] * tx) * (1 - ty) + (a[i + this.cols] * (1 - tx) + a[i + this.cols + 1] * tx) * ty;
    out.e = lerp2(this.elev);
    out.m = lerp2(this.moist);
    out.t = lerp2(this.baseTemp);
  }

  classify(e: number, m: number, t: number): B {
    const sea = this.seaLevel;
    if (e < sea - 0.06) return B.Deep;
    if (e < sea) return B.Shallow;
    if (e > this.mountainLevel) return t < 0.42 ? B.Snow : B.Mountain;
    if (e < sea + 0.012) return B.Beach;
    if (t < 0.2) return B.Tundra;
    if (t > 0.66 && m < 0.47) return B.Desert;
    if (m > 0.64 && e < sea + 0.09) return B.Swamp;
    if (m > 0.52) return B.Forest;
    if (t > 0.58) return B.Savanna;
    return B.Grass;
  }

  private generate(): void {
    const { cols, rows, cell, width, height } = this;
    const rand = mulberry32(this.seed);
    const nE = new Noise(this.seed);
    const nM = new Noise(this.seed + 101);
    const nT = new Noise(this.seed + 202);
    const scale = 1 / 900;

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x = (cx + 0.5) * cell;
        const y = (cy + 0.5) * cell;
        const i = cy * cols + cx;
        // остров: к краям карты земля уходит под воду
        const nx = (x / width) * 2 - 1;
        const ny = (y / height) * 2 - 1;
        const edge = Math.pow(Math.max(Math.abs(nx), Math.abs(ny)), 3) * 0.6 + (nx * nx + ny * ny) * 0.12;
        this.elev[i] = nE.fbm(x * scale, y * scale, 6) - edge;
        this.moist[i] = nM.fbm(x * scale * 1.3, y * scale * 1.3, 4);
      }
    }

    // уровень моря и гор подбираем по квантилям — всегда ~70% суши и немного гор
    const sorted = Float32Array.from(this.elev).sort();
    this.seaLevel = sorted[Math.floor(sorted.length * 0.3)];
    this.mountainLevel = sorted[Math.floor(sorted.length * 0.95)];

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx;
        const x = (cx + 0.5) * cell;
        const y = (cy + 0.5) * cell;
        const e = this.elev[i];
        // север холодный, юг жаркий; высота охлаждает
        const lat = y / height;
        const h = Math.max(0, (e - this.seaLevel) / (this.mountainLevel - this.seaLevel));
        const high = h * h * 0.3;
        this.baseTemp[i] = clamp(0.02 + lat * 0.95 + (nT.fbm(x / 700, y / 700, 3) - 0.5) * 0.35 - high, 0, 1);
        // у воды влажнее
        if (e < this.seaLevel + 0.05) this.moist[i] = Math.min(1, this.moist[i] + 0.08);
        this.biome[i] = this.classify(e, this.moist[i], this.baseTemp[i]);
      }
    }

    this.buildRegions(rand);
  }

  /** Связные области одного класса местности → именованные регионы. */
  private buildRegions(rand: () => number): void {
    const { cols, rows } = this;
    const cls = (i: number) => REGION_CLASS[this.biome[i] as B];
    const queue = new Int32Array(cols * rows);
    const used = new Set<string>();
    for (let start = 0; start < cols * rows; start++) {
      if (this.region[start] !== -1 || cls(start) < 0) continue;
      const k = cls(start);
      const id = this.regions.length;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      this.region[start] = id;
      let sx = 0;
      let sy = 0;
      while (head < tail) {
        const i = queue[head++];
        const x = i % cols;
        const y = (i / cols) | 0;
        sx += x;
        sy += y;
        const nb = [x > 0 ? i - 1 : -1, x < cols - 1 ? i + 1 : -1, y > 0 ? i - cols : -1, y < rows - 1 ? i + cols : -1];
        for (const j of nb) {
          if (j >= 0 && this.region[j] === -1 && cls(j) === k) {
            this.region[j] = id;
            queue[tail++] = j;
          }
        }
      }
      let name = '';
      do name = `${pick(REGION_NOUNS[k], rand)} ${properName(rand)}`;
      while (used.has(name));
      used.add(name);
      this.regions.push({ id, name, biome: this.biome[start] as B, cells: tail, cx: (sx / tail + 0.5) * this.cell, cy: (sy / tail + 0.5) * this.cell });
    }
    // мелкие клочки (< 30 клеток) не называем — приписываем соседнему крупному региону
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < cols * rows; i++) {
        const r = this.region[i];
        if (r < 0 || this.regions[r].cells >= 30) continue;
        const x = i % cols;
        const nb = [x > 0 ? i - 1 : -1, x < cols - 1 ? i + 1 : -1, i - cols, i + cols];
        for (const j of nb) {
          if (j < 0 || j >= cols * rows) continue;
          const rj = this.region[j];
          if (rj >= 0 && this.regions[rj].cells >= 30) {
            this.region[i] = rj;
            break;
          }
        }
      }
    }
  }

  regionAt(x: number, y: number): Region | null {
    const r = this.region[this.index(x, y)];
    return r >= 0 && this.regions[r].cells >= 30 ? this.regions[r] : null;
  }
}
