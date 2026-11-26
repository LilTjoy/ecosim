import { clamp, mulberry32, Noise, pick } from '../lib/random';

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
  water: boolean;
  /** Листва деревьев и кустов (достают только крупные). */
  browse: number;
  /** Ягоды, семена, насекомые (едят всеядные). */
  forage: number;
}

export const BIOMES: BiomeInfo[] = [
  { name: 'Глубокое море', fert: 0.9, move: 1, sense: 1, ground: [22, 52, 92], plant: [40, 110, 120], water: true, browse: 0, forage: 0 },
  { name: 'Мелководье', fert: 1.3, move: 1, sense: 1, ground: [42, 98, 138], plant: [60, 140, 120], water: true, browse: 0, forage: 0 },
  { name: 'Пляж', fert: 0.15, move: 0.95, sense: 1.1, ground: [196, 180, 132], plant: [150, 170, 90], water: false, browse: 0, forage: 0.3 },
  { name: 'Луга', fert: 1, move: 1, sense: 1, ground: [104, 98, 62], plant: [92, 168, 70], water: false, browse: 0.3, forage: 0.45 },
  { name: 'Саванна', fert: 0.7, move: 1, sense: 1.15, ground: [150, 128, 76], plant: [170, 172, 72], water: false, browse: 1.4, forage: 0.35 },
  { name: 'Лес', fert: 0.8, move: 0.85, sense: 0.6, ground: [58, 70, 40], plant: [50, 120, 56], water: false, browse: 3, forage: 0.9 },
  { name: 'Болото', fert: 0.65, move: 0.6, sense: 0.8, ground: [62, 70, 52], plant: [86, 120, 70], water: false, browse: 1.5, forage: 0.8 },
  { name: 'Пустыня', fert: 0.08, move: 0.95, sense: 1.2, ground: [212, 176, 116], plant: [170, 160, 80], water: false, browse: 0.15, forage: 0.12 },
  { name: 'Тундра', fert: 0.45, move: 0.85, sense: 1.1, ground: [130, 136, 128], plant: [120, 146, 108], water: false, browse: 0.6, forage: 0.35 },
  { name: 'Горы', fert: 0.1, move: 0.6, sense: 1.25, ground: [112, 104, 98], plant: [104, 130, 90], water: false, browse: 0.25, forage: 0.1 },
  { name: 'Ледники', fert: 0.03, move: 0.7, sense: 1.2, ground: [222, 230, 238], plant: [170, 190, 170], water: false, browse: 0, forage: 0 },
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

/** Пороги стока: ручей и река (в «клетках дождя»). */
export const RIVER_MIN = 80,
  STREAM_MIN = 30;

export interface Region {
  id: number;
  name: string;
  biome: B;
  cells: number;
  cx: number;
  cy: number;
}

/** 🌋 Входы производного рельефа (живая планета): всё, от чего зависит рельеф сверх seed и env. */
export interface PlateView {
  ox: number;
  oy: number;
}
export interface DeriveInput {
  /** Сдвиг уровня моря от исходного (единицы высоты). */
  seaQ: number;
  /** Правки высоты по клеткам, 1e-4 единицы (null — нет). */
  elevD: Int16Array | null;
  plate: PlateView | null;
  lakes: boolean;
  shadow: boolean;
  /** 🌋 Затравки озёр (клетки котловин от тающего льда): озеро — только впадина, где есть затравка. */
  lakeSeeds?: ArrayLike<number> | null;
}
export interface DeriveOut {
  /** Клетки, у которых сменился биом, класс реки или влажность (буфер переиспользуется — читать сразу). */
  changed: Int32Array;
  /** Биомы до этого пересчёта (буфер переиспользуется). */
  prev: Uint8Array;
  landChanged: boolean;
  /** [c0, r0, c1, r1] изменённых клеток (пустой — c0 > c1). */
  bbox: [number, number, number, number];
}
/** 🌋 Озёра от тающего льда: впадина глубже MIN (9 м) и не меньше CELLS клеток; край — глубже EDGE (3 м). */
export const LAKE = { MIN: 0.003, CELLS: 4, EDGE: 0.001 };
export const BASE_INPUT: DeriveInput = { seaQ: 0, elevD: null, plate: null, lakes: false, shadow: false };

/** Входы на исходном уровне: рельеф — ровно тот, что дал generate(). */
export function isBaseInput(inp: DeriveInput): boolean {
  if (inp.seaQ !== 0 || inp.plate || inp.lakes || inp.shadow) return false;
  const d = inp.elevD;
  if (d) for (let i = 0; i < d.length; i++) if (d[i] !== 0) return false;
  return true;
}

/** FNV-1a входов пересчёта (0 — исходный рельеф): одинаковые входы — одинаковый рельеф, поэтому снимку хватает сверить число. */
export function deriveHash(inp: DeriveInput): number {
  if (isBaseInput(inp)) return 0;
  let h = 0x811c9dc5 | 0;
  const f = new Float64Array([inp.seaQ, inp.plate ? inp.plate.ox : NaN, inp.plate ? inp.plate.oy : NaN, inp.lakes ? 1 : 0, inp.shadow ? 1 : 0]);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
  const ls = inp.lakes ? inp.lakeSeeds : null;
  if (ls) {
    h = Math.imul(h ^ ls.length, 16777619);
    for (let i = 0; i < ls.length; i++) h = Math.imul(h ^ ls[i], 16777619);
  }
  const d = inp.elevD;
  if (d) {
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ (d[i] & 0xffff), 16777619);
  }
  h >>>= 0;
  return h === 0 ? 1 : h;
}

interface TerrainBase {
  elev: Float32Array;
  moist: Float32Array;
  temp: Float32Array;
  /** Температура до поправки на высоту и без обрезки 0..1 (для клеток с правкой высоты). */
  tpre: Float32Array;
  biome: Uint8Array;
  region: Int16Array;
  drain: Int32Array;
  order: Int32Array;
  flow: Float32Array;
  river: Uint8Array;
  rivId: Int16Array;
  rivers: Terrain['rivers'];
  sea: number;
  springs: number[];
}

/** Рабочие буферы гидрологии и пересчёта (переиспользуются: без мусора на каждом шаге моря). */
interface HydroBuf {
  hk: Float32Array;
  hi: Int32Array;
  filled: Float32Array;
  visited: Uint8Array;
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
  /** Гидрология: куда стекает клетка (-1 у воды), порядок заливки (снизу вверх), накопленный сток. */
  readonly drain: Int32Array;
  readonly order: Int32Array;
  readonly flow: Float32Array;
  /** 0 — нет, 1 — ручей, 2 — река. */
  readonly river: Uint8Array;
  /** ≥0 — русло реки id; ≤-2 — приток реки -(v+2); -1 — нет. */
  readonly rivId: Int16Array;
  rivers: { name: string; mouth: number; flow: number }[] = [];
  /** Клетки горячих источников (украшение). */
  springs: number[] = [];
  seaLevel = 0;
  mountainLevel = 0;
  /** 🌋 Отпечаток входов пересчёта (deriveHash); 0 — исходный рельеф. */
  rev = 0;
  /** 🌋 Озёра от тающего льда: номер озера + 1 в lakes (null — озёр нет). */
  lake: Uint8Array | null = null;
  /** 🌋 Озёра по именам: наименьшая клетка, число клеток. */
  lakes: { name: string; cell: number; n: number }[] = [];
  /** 🌋 Исходный рельеф — копируется лениво, при первом пересчёте (миры без живой планеты ничего не выделяют). */
  private base: TerrainBase | null = null;
  private hbuf: HydroBuf | null = null;
  private dbuf: { biome: Uint8Array; river: Uint8Array; moist: Float32Array; changed: Int32Array; label: Int16Array; queue: Int32Array; stem: Int32Array } | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell: number,
    readonly seed: number,
    /** Доля карты под водой (0..1) и сдвиг температуры — задаются планетой. */
    readonly sea = 0.3,
    readonly tempOffset = 0,
    /** Вулканизм планеты: сколько горячих источников. */
    readonly volcanism = 1,
  ) {
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(height / cell);
    const n = this.cols * this.rows;
    this.elev = new Float32Array(n);
    this.moist = new Float32Array(n);
    this.baseTemp = new Float32Array(n);
    this.biome = new Uint8Array(n);
    this.region = new Int16Array(n).fill(-1);
    this.drain = new Int32Array(n).fill(-1);
    this.order = new Int32Array(n);
    this.flow = new Float32Array(n);
    this.river = new Uint8Array(n);
    this.rivId = new Int16Array(n).fill(-1);
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
    this.seaLevel = sorted[Math.floor(sorted.length * clamp(this.sea, 0.02, 0.97))];
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
        this.baseTemp[i] = clamp(0.02 + lat * 0.95 + (nT.fbm(x / 700, y / 700, 3) - 0.5) * 0.35 - high + this.tempOffset, 0, 1);
        // у воды влажнее
        if (e < this.seaLevel + 0.05) this.moist[i] = Math.min(1, this.moist[i] + 0.08);
        this.biome[i] = this.classify(e, this.moist[i], this.baseTemp[i]);
      }
    }

    this.hydrology();
    this.buildRegions(rand);
  }

  /**
   * Реки: priority-flood (Barnes 2014) → сток → русла, имена, притоки; горячие источники.
   * derive — пересчёт живой планеты: буферы переиспользуются, имена — по совпадению с исходными руслами, источники не ищутся.
   */
  private hydrology(derive = false): void {
    const { cols, rows, elev, biome, drain, order, flow, river, rivId } = this;
    const n = cols * rows;
    // свой поток случайностей — имена регионов и карта не меняются
    const rand2 = mulberry32(this.seed ^ 0x9e3779b9);
    const wet = (i: number) => biome[i] <= B.Shallow;
    const buf: HydroBuf = derive
      ? (this.hbuf ??= { hk: new Float32Array(n), hi: new Int32Array(n), filled: new Float32Array(n), visited: new Uint8Array(n) })
      : { hk: new Float32Array(n), hi: new Int32Array(n), filled: new Float32Array(n), visited: new Uint8Array(n) };
    // двоичная куча на типизированных массивах
    const { hk, hi, filled, visited } = buf;
    let hn = 0;
    const push = (i: number, k: number) => {
      let c = hn++;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (hk[p] <= k) break;
        hk[c] = hk[p];
        hi[c] = hi[p];
        c = p;
      }
      hk[c] = k;
      hi[c] = i;
    };
    const pop = (): number => {
      const top = hi[0];
      const k = hk[--hn];
      const i = hi[hn];
      let c = 0;
      for (;;) {
        let m = 2 * c + 1;
        if (m >= hn) break;
        if (m + 1 < hn && hk[m + 1] < hk[m]) m++;
        if (hk[m] >= k) break;
        hk[c] = hk[m];
        hi[c] = hi[m];
        c = m;
      }
      hk[c] = k;
      hi[c] = i;
      return top;
    };
    filled.set(elev);
    if (derive) {
      visited.fill(0);
      drain.fill(-1);
      rivId.fill(-1);
      this.rivers = [];
    }
    for (let i = 0; i < n; i++) {
      const x = i % cols;
      const y = (i / cols) | 0;
      if (wet(i) || x === 0 || y === 0 || x === cols - 1 || y === rows - 1) {
        visited[i] = 1;
        push(i, elev[i]);
      }
    }
    let k = 0;
    while (hn > 0) {
      const i = pop();
      order[k++] = i;
      const x = i % cols;
      const y = (i / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((dx === 0 && dy === 0) || xx < 0 || xx >= cols) continue;
          const j = yy * cols + xx;
          if (visited[j]) continue;
          visited[j] = 1;
          filled[j] = Math.max(elev[j], filled[i] + 1e-5);
          if (!wet(j)) drain[j] = i;
          push(j, filled[j]);
        }
      }
    }
    // сток: дождь на суше, сверху вниз
    for (let i = 0; i < n; i++) flow[i] = wet(i) ? 0 : 0.3 + this.moist[i];
    for (let q = n - 1; q >= 0; q--) {
      const i = order[q];
      if (drain[i] >= 0) flow[drain[i]] += flow[i];
    }
    for (let i = 0; i < n; i++) river[i] = wet(i) ? 0 : flow[i] >= RIVER_MIN ? 2 : flow[i] >= STREAM_MIN ? 1 : 0;

    // имена: устья крупных рек
    const mouths: number[] = [];
    for (let i = 0; i < n; i++) if (river[i] >= 2 && drain[i] >= 0 && wet(drain[i]) && flow[i] >= 150) mouths.push(i);
    mouths.sort((a, b) => flow[b] - flow[a]);
    const used = new Set<string>();
    const base = derive ? this.base! : null;
    const stem = derive ? this.dbuf!.stem : null;
    const votes = derive ? new Int32Array(base!.rivers.length) : null;
    for (const m of mouths.slice(0, 12)) {
      const id = this.rivers.length;
      // главное русло: вверх по самому полноводному притоку
      let i = m;
      rivId[i] = id;
      let len = 0;
      if (stem) stem[len++] = i;
      for (;;) {
        let best = -1;
        const x = i % cols;
        const y = (i / cols) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
            const j = yy * cols + xx;
            if (drain[j] === i && flow[j] >= RIVER_MIN && (best < 0 || flow[j] > flow[best])) best = j;
          }
        }
        if (best < 0 || rivId[best] !== -1) break;
        rivId[best] = id;
        i = best;
        if (stem) stem[len++] = i;
      }
      let name = '';
      if (!base) {
        do name = 'р. ' + properName(rand2);
        while (used.has(name));
      } else {
        // то же имя, что у исходной реки, с чьим главным руслом совпадает больше всего клеток; иначе — новое по клетке
        votes!.fill(0);
        let minCell = m;
        for (let q = 0; q < len; q++) {
          const c = stem![q];
          if (c < minCell) minCell = c;
          const v = base.rivId[c];
          if (v >= 0) votes![v]++;
        }
        let bestV = -1;
        for (let v = 0; v < votes!.length; v++) if (votes![v] > 0 && !used.has(base.rivers[v].name) && (bestV < 0 || votes![v] > votes![bestV])) bestV = v;
        if (bestV >= 0) name = base.rivers[bestV].name;
        else {
          const r = mulberry32(this.seed ^ minCell);
          do name = 'р. ' + properName(r);
          while (used.has(name));
        }
      }
      used.add(name);
      this.rivers.push({ name, mouth: m, flow: flow[m] });
    }
    // притоки: снизу вверх по течению наследуют имя
    for (let q = 0; q < n; q++) {
      const i = order[q];
      if (rivId[i] !== -1 || river[i] < 1 || drain[i] < 0) continue;
      const v = rivId[drain[i]];
      if (v !== -1) rivId[i] = v >= 0 ? -(v + 2) : v;
    }
    if (derive) {
      // источники — исходные, только на суше
      this.springs = base!.springs.filter((c) => !wet(c));
      return;
    }

    // горячие источники: 2–6 клеток от гор (заснеженные вершины тоже горы)
    const dist = new Uint8Array(n).fill(255);
    const qu = new Int32Array(n);
    let qh = 0;
    let qt = 0;
    for (let i = 0; i < n; i++) if (biome[i] === B.Mountain || biome[i] === B.Snow) { dist[i] = 0; qu[qt++] = i; }
    while (qh < qt) {
      const i = qu[qh++];
      if (dist[i] >= 6) continue;
      const x = i % cols;
      const y = (i / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
          const j = yy * cols + xx;
          if (dist[j] === 255) { dist[j] = dist[i] + 1; qu[qt++] = j; }
        }
      }
    }
    const cand: number[] = [];
    for (let i = 0; i < n; i++) {
      const b = biome[i];
      if (!wet(i) && b !== B.Snow && b !== B.Mountain && dist[i] >= 2 && dist[i] <= 6) cand.push(i);
    }
    const nS = Math.round(1 + 4 * this.volcanism);
    for (let tries = 0; tries < 300 && cand.length && this.springs.length < nS; tries++) {
      const c = cand[Math.floor(rand2() * cand.length)];
      const cx = c % cols;
      const cy = (c / cols) | 0;
      if (this.springs.every((s) => Math.hypot((s % cols) - cx, ((s / cols) | 0) - cy) >= 12)) this.springs.push(c);
    }
  }

  /** Река или приток рядом с точкой (окно 5×5 клеток). */
  waterAt(x: number, y: number): string | null {
    const c = this.index(x, y);
    const cx = c % this.cols;
    const cy = (c / this.cols) | 0;
    const lk = this.lake ? this.lake[c] : 0;
    if (lk > 0 && this.lakes[lk - 1]) return this.lakes[lk - 1].name;
    let trib = -1;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx < 0 || yy < 0 || xx >= this.cols || yy >= this.rows) continue;
        const v = this.rivId[yy * this.cols + xx];
        if (v >= 0) return this.rivers[v].name;
        if (v <= -2 && trib < 0) trib = -(v + 2);
      }
    }
    return trib >= 0 ? 'приток ' + this.rivers[trib].name : null;
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

  // ---------------- 🌋 живая планета: рельеф как чистая функция входов ----------------

  /** Копия исходного рельефа (один раз, до первой правки). */
  private ensureBase(): TerrainBase {
    if (this.base) return this.base;
    const { cols, rows, cell, height } = this;
    const n = cols * rows;
    // температура до поправки на высоту — тем же шумом, что в generate()
    const nT = new Noise(this.seed + 202);
    const tpre = new Float32Array(n);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x = (cx + 0.5) * cell;
        const y = (cy + 0.5) * cell;
        tpre[cy * cols + cx] = 0.02 + (y / height) * 0.95 + (nT.fbm(x / 700, y / 700, 3) - 0.5) * 0.35 + this.tempOffset;
      }
    }
    this.base = {
      elev: this.elev.slice(), moist: this.moist.slice(), temp: this.baseTemp.slice(), tpre,
      biome: this.biome.slice(), region: this.region.slice(), drain: this.drain.slice(), order: this.order.slice(), flow: this.flow.slice(),
      river: this.river.slice(), rivId: this.rivId.slice(), rivers: this.rivers.map((r) => ({ ...r })), sea: this.seaLevel, springs: this.springs.slice(),
    };
    this.dbuf = {
      biome: new Uint8Array(n), river: new Uint8Array(n), moist: new Float32Array(n), changed: new Int32Array(n),
      label: new Int16Array(n), queue: new Int32Array(n), stem: new Int32Array(n),
    };
    return this.base;
  }

  /**
   * Единственный изменяющий рельеф метод: рельеф — чистая функция входов (без случайностей), на месте —
   * объект Terrain тот же (уроки и опыты сверяют его по ссылке). Регионы — исходные: новая суша берёт метку
   * ближайшей исходной суши, затонувшая — −1; список regions не меняется.
   */
  derive(inp: DeriveInput): DeriveOut {
    if (inp.plate) throw new Error('Terrain.derive: дрейф плит — этап 3');
    if (inp.shadow) throw new Error('Terrain.derive: дождевая тень — этап 3');
    const base = this.ensureBase();
    const D = this.dbuf!;
    const n = this.cols * this.rows;
    const { elev, moist, baseTemp, biome, river } = this;
    D.biome.set(biome);
    D.river.set(river);
    D.moist.set(moist);
    if (isBaseInput(inp)) {
      elev.set(base.elev);
      moist.set(base.moist);
      baseTemp.set(base.temp);
      biome.set(base.biome);
      this.region.set(base.region);
      this.drain.set(base.drain);
      this.order.set(base.order);
      this.flow.set(base.flow);
      river.set(base.river);
      this.rivId.set(base.rivId);
      this.rivers = base.rivers.map((r) => ({ ...r }));
      this.springs = base.springs.slice();
      this.seaLevel = base.sea;
      this.lake = null;
      this.lakes = [];
      this.rev = 0;
    } else {
      this.seaLevel = base.sea + inp.seaQ;
      const d = inp.elevD;
      const span = this.mountainLevel - base.sea;
      for (let i = 0; i < n; i++) {
        const dz = d ? d[i] : 0;
        if (dz === 0) {
          elev[i] = base.elev[i];
          baseTemp[i] = base.temp[i];
        } else {
          const e = (elev[i] = base.elev[i] + dz * 1e-4);
          // высота охлаждает (как в generate, от исходного моря): и подъём, и опускание
          const h = Math.max(0, (e - base.sea) / span);
          baseTemp[i] = clamp(base.tpre[i] - h * h * 0.3, 0, 1);
        }
      }
      moist.set(base.moist);
      for (let i = 0; i < n; i++) biome[i] = this.classify(elev[i], moist[i], baseTemp[i]);
      this.hydrology(true);
      this.lakes = [];
      this.lake = null;
      // 🌋 озёра: впадины заливки с затравкой — мелководье; реки после этого — заново (впадают в озёра)
      if (inp.lakes && inp.lakeSeeds && inp.lakeSeeds.length && this.fillLakes(inp.lakeSeeds)) this.hydrology(true);
      this.rev = deriveHash(inp);
    }
    // что изменилось: биом, класс реки или влажность (от них зависят статичные поля почвы)
    let m = 0, landChanged = false;
    let c0 = this.cols, r0 = this.rows, c1 = -1, r1 = -1;
    for (let i = 0; i < n; i++) {
      if (biome[i] === D.biome[i] && river[i] === D.river[i] && moist[i] === D.moist[i]) continue;
      D.changed[m++] = i;
      if ((biome[i] <= B.Shallow) !== (D.biome[i] <= B.Shallow)) landChanged = true;
      const x = i % this.cols, y = (i / this.cols) | 0;
      if (x < c0) c0 = x;
      if (x > c1) c1 = x;
      if (y < r0) r0 = y;
      if (y > r1) r1 = y;
    }
    if (landChanged && this.rev !== 0) this.relabel();
    return { changed: D.changed.subarray(0, m), prev: D.biome, landChanged, bbox: [c0, r0, c1, r1] };
  }

  /**
   * Озёра (после hydrology: filled — уровень заливки). От каждой затравки — 4-связная впадина суши глубже LAKE.EDGE;
   * озеро, если глубже LAKE.MIN и не меньше LAKE.CELLS клеток. Без случайностей; имя — по наименьшей клетке.
   */
  private fillLakes(seeds: ArrayLike<number>): boolean {
    const { cols, elev, biome } = this;
    const n = cols * this.rows;
    const filled = this.hbuf!.filled;
    const D = this.dbuf!;
    const lab = D.label, q = D.queue;
    lab.fill(0);
    const lake = new Uint8Array(n);
    let any = false;
    const wet = (i: number) => biome[i] <= B.Shallow;
    for (let k = 0; k < seeds.length; k++) {
      const s = seeds[k];
      if (s < 0 || s >= n || lab[s] || wet(s) || filled[s] - elev[s] < LAKE.EDGE) continue;
      let qt = 0, deep = 0, minCell = s;
      q[qt++] = s;
      lab[s] = 1;
      for (let qh = 0; qh < qt; qh++) {
        const i = q[qh];
        const dd = filled[i] - elev[i];
        if (dd > deep) deep = dd;
        if (i < minCell) minCell = i;
        const x = i % cols;
        const nb0 = x > 0 ? i - 1 : -1, nb1 = x < cols - 1 ? i + 1 : -1, nb2 = i - cols, nb3 = i + cols;
        for (const j of [nb0, nb1, nb2, nb3]) {
          if (j < 0 || j >= n || lab[j] || wet(j) || filled[j] - elev[j] < LAKE.EDGE) continue;
          lab[j] = 1;
          q[qt++] = j;
        }
      }
      if (deep < LAKE.MIN || qt < LAKE.CELLS) continue;
      const id = Math.min(255, this.lakes.length + 1);
      for (let k2 = 0; k2 < qt; k2++) {
        lake[q[k2]] = id;
        biome[q[k2]] = B.Shallow;
      }
      any = true;
      const r = mulberry32(this.seed ^ minCell ^ 0x1a4e);
      this.lakes.push({ name: 'оз. ' + properName(r), cell: minCell, n: qt });
    }
    if (any) this.lake = lake;
    return any;
  }

  /** Регионы после смены суши: исходная суша — своя метка, новая — ближайшей исходной суши (BFS без предела), вода — −1. */
  private relabel(): void {
    const base = this.base!;
    const D = this.dbuf!;
    const { cols, rows } = this;
    const n = cols * rows;
    const lab = D.label, q = D.queue;
    let qt = 0;
    for (let i = 0; i < n; i++) {
      lab[i] = base.region[i];
      if (lab[i] >= 0) q[qt++] = i;
    }
    for (let qh = 0; qh < qt; qh++) {
      const i = q[qh];
      const x = i % cols;
      const v = lab[i];
      if (x > 0 && lab[i - 1] < 0) { lab[i - 1] = v; q[qt++] = i - 1; }
      if (x < cols - 1 && lab[i + 1] < 0) { lab[i + 1] = v; q[qt++] = i + 1; }
      if (i >= cols && lab[i - cols] < 0) { lab[i - cols] = v; q[qt++] = i - cols; }
      if (i + cols < n && lab[i + cols] < 0) { lab[i + cols] = v; q[qt++] = i + cols; }
    }
    for (let i = 0; i < n; i++) this.region[i] = REGION_CLASS[this.biome[i] as B] < 0 ? -1 : lab[i];
    void rows;
  }
}

/** Тип почвы клетки (только для показа). */
export function soilName(t: Terrain, i: number): string {
  const T = t.baseTemp[i];
  const m = t.moist[i];
  switch (t.biome[i] as B) {
    case B.Deep: return 'донный ил';
    case B.Shallow: return 'ил';
    case B.Grass: return T >= 0.3 && T <= 0.55 && m >= 0.35 && m <= 0.65 ? 'чернозём' : 'луговая';
    case B.Savanna: return 'красная саванная';
    case B.Forest: return T < 0.4 ? 'подзол' : T <= 0.62 ? 'бурая лесная' : 'красная тропическая (латерит)';
    case B.Swamp: return 'торф';
    case B.Tundra: return 'мерзлотная';
    case B.Desert: return 'пустынная (пески)';
    case B.Beach: return 'песок';
    case B.Mountain: return 'каменистая';
    default: return 'лёд и камень';
  }
}
