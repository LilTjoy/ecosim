// 🌋 «Живая планета»: изменяемый рельеф, ледники, уровень моря, катастрофы (без DOM — общий для страницы, стенда и воркера).
//
// Этап 0 — только ядро: рельеф — чистая функция снимаемого состояния (seaQ, elevD, …), все правки рельефа идут
// через очередь geo.pend и применяются лишь в живом пересчёте (deriveTerrain(w, true) в начале шага). Восстановление
// снимка пересчитывает рельеф из уже применённого состояния и очередь не трогает — поэтому перемотка ≡ живой прогон.
// Все случайности — World.r() (поток мира, ctx null) или mulberry32(seed ^ c); Math.random здесь нет.
import { clamp, mulberry32 } from '../lib/random';
import { BASE_INPUT, BIOMES, B, deriveHash, properName, type DeriveInput } from './terrain';
import type { Creature, World } from './world';
import type { Genome } from './genome';

/** Такты года (= world.YEAR; свой — чтобы не было цикла импорта при вычислении таблицы). */
const YEAR = 6000;
/** °C на единицу температуры (= world.CLIMATE_C). */
const CLIMATE_C = 100 / 3;
/** Периоды орбиты относительно GEO.P: вытянутость 100, наклон 41, прецессия 23 тыс. лет. */
const PER = [1, 0.41, 0.23] as const;

export const GEO = {
  EVERY: 60, P: 8 * YEAR, SPEEDS: [1, 4] as const,
  A: 0.062, AMPS0: [1, 0.5, 0.4], ALB: 0.04, CO2_FOLLOW: 90,
  TAU_UP: 1.2 * YEAR, TAU_DN: 0.4 * YEAR, V_SHIFT: 0.19, SEA_V: 0.04,
  T_ICE: 0.01, ACC: 1.5, ABL: 1.2, FLOW: 0.12, HMAX: 1, SELF_COOL: 0.01, ICE_COOL: 0.05, ICE_MOVE: 0.3, DT: 0.05,
  M_PER_E: 3000, SEA_STEP: 0.004, REBUILD_MIN: 120,
  SILL: 0.017 /* −51 м */, SILL_W: 4, WALLACE: 0.13 /* −390 м: глубоко даже при море −150 м */, WALLACE_W: 4,
  MOR_HI: 0.5, MOR_LO: 0.2, KETTLE_P: 0.03, KETTLE_D: 120, SCOUR: 2, SCOUR_MAX: 200, LAKE_MIN: 0.003, LAKE_CELLS: 4,
  ISO_GEN: 10, ISO_D: 0.2, ISO_MIN: 12, ISO_LEAK: 0, LM_MIN: 800, INVADE_N: 15, INVADE_T: 1000,
  AER_K: 0.12,
  VEI: { 6: { kill: 60, ash: 400, aer: 0.12 }, 7: { kill: 110, ash: 800, aer: 0.3 }, 8: { kill: 160, ash: 1600, aer: 1.0 } },
  IMPACT: { 2: { kill: 400, aer: 0.5, fires: 15 }, 3: { kill: 700, aer: 1.2, fires: 40 } },
  FIRE_EVERY: 10, FIRE_P: 0.35, FIRE_MAX: 4000, LIGHTNING: 2e-4,
  EXT_SHARE: 0.5, EXT_MIN: 4, ISOLATE: 2 * YEAR, LOG_GAP: 300,
  DRIFT_T: 1500, UPLIFT: 300, UPLIFT_W: 4, OCEAN_FLOOR: -0.13,
  /** Кисть «🏔 Рельеф»: предел правки высоты кистью, 1e-4 единицы (±0,3 ≈ ±900 м). */
  TERRA_MAX: 3000,
  /** Радиус поиска суши для зверей, которых застала вода. */
  EVAC_R: 80,
  /** Резать ли пороги и пролив при reset (стенд: --sill=0). */
  SILL_ON: 1,
  /** Лёд кормит меньше: потолок травы, листвы и ягод ×max(0, 1 − ICE_FOOD·H). */
  ICE_FOOD: 1.25,
  /** «❄️ Ледниковье сейчас» / «💧 Конец ледниковья»: постоянный сдвиг вместо орбиты (единицы температуры). */
  PIN_COLD: -0.13, PIN_WARM: 0.03,
} as const;

/** Пролив, который режет остров: мелкий порог (сохнет в ледниковье), пролив Уоллеса (глубокий всегда) или игрока. */
export interface SillRec {
  kind: 'sill' | 'wallace' | 'player';
  cells: number[];
  name: string;
  /** Есть ли сейчас сухопутный мост (якоря a и b на одном материке). */
  open: boolean;
  /** Якоря — высокие клетки суши по обе стороны (север, юг). */
  a: number;
  b: number;
  /** Ряды полосы [y0, y1). */
  y0: number;
  y1: number;
}

export interface BridgeRec {
  sill: number; open: number; close: number | null; a: number; b: number; cross: [number, number]; seen: number[];
  invaders: { sp: number; from: 0 | 1; t: number; since: number }[]; lost: number[]; reported: boolean;
}
export interface IsoRec {
  sp: number; t: number; parts: number[]; gen0: number[]; ga: number; d: number; half: boolean;
  /** id особи → сторона барьера. */
  tag: Map<number, 0 | 1>;
  leak: number;
}
export interface RefRec { region: number; lm: number; species: number[]; n: number }

/** Состояние живой планеты. Все ключи есть всегда (null, а не «нет»): loadWorld заменяет его целиком. */
export interface GeoState {
  speed: 1 | 4; orbit: boolean; orbT: number; /** orbT в начале мира (часы геологии — от него) */ orb0: number; phis: [number, number, number]; amps: [number, number, number];
  Vg: number; /** = clamp(Vg, 0, 1) — для HUD и порогов */ G: number; iceLand: number; iceMaxLand: number;
  dGsign: -1 | 0 | 1; cycleN: number; lastMaxTick: number;
  /** Фаза цикла: 0 — межледниковье, 1 — лёд растёт, 2 — тает; пик Vg фазы 1, море и лёд на пике. */
  phase: 0 | 1 | 2; vPeak: number; peakSea: number; peakIce: number;
  /** «❄️ сейчас» / «💧 конец»: постоянный сдвиг вместо орбиты (null — нет). */
  fPin: number | null;
  co2: number; co2Pin: number | null; seaPin: number; seaOff: number; seaQ: number; lastDerive: number;
  /** Правки рельефа, ждущие следующего пересчёта: подряд [клетка, dz (1e-4 единицы)]. */
  pend: number[];
  kettleQ: number[]; shadow: boolean; lakes: boolean;
  aer: number; dark: number; geoShift: number; isolatedUntil: number; lastLogT: number;
  fire: number[]; sills: SillRec[];
  lands: { n: number; anchors: number[]; sizes: number[] };
  bridges: BridgeRec[]; isolates: IsoRec[]; refugia: RefRec[] | null;
  /** [вид, северная граница y] */ rangeRef: [number, number][];
  /** виды, широко распространённые при пересечении 20 % */ wide: number[];
  extRing: number[]; lastMass: number; lastCause: number;
  plate: { rift: number; ox: number; oy: number; vx: number; vy: number; next: number; collided: boolean } | null;
  stats: { glacials: number; bridges: number; splits: number; vicariance: number; impacts: number; eruptions: number; fires: number; massExt: number; derives: number };
}

export function newGeo(seed: number): GeoState {
  const r = mulberry32(seed ^ 0x6e0c1);
  const phis: [number, number, number] = [r() * 2 * Math.PI, r() * 2 * Math.PI, r() * 2 * Math.PI];
  const amps: [number, number, number] = [GEO.AMPS0[0], GEO.AMPS0[1], GEO.AMPS0[2]];
  // мир начинается в самом тёплом месте цикла (межледниковье, как сейчас на Земле): лёд и море — с нуля, без разгона
  let orb0 = 0, best = -Infinity;
  for (let t = 0; t < GEO.P; t += GEO.EVERY) {
    const F = orbitF({ amps, phis } as GeoState, t);
    if (F > best) {
      best = F;
      orb0 = t;
    }
  }
  return {
    speed: 1, orbit: true, orbT: orb0, orb0, phis, amps,
    Vg: 0, G: 0, iceLand: 0, iceMaxLand: 0,
    dGsign: 0, cycleN: 0, lastMaxTick: -1,
    phase: 0, vPeak: 0, peakSea: 0, peakIce: 0, fPin: null,
    co2: 280, co2Pin: null, seaPin: 0, seaOff: 0, seaQ: 0, lastDerive: -1e9,
    pend: [], kettleQ: [], shadow: false, lakes: false,
    aer: 0, dark: 0, geoShift: 0, isolatedUntil: 0, lastLogT: -1e9,
    fire: [], sills: [], lands: { n: 0, anchors: [], sizes: [] },
    bridges: [], isolates: [], refugia: null, rangeRef: [], wide: [],
    extRing: [], lastMass: -1e9, lastCause: -1e9, plate: null,
    stats: { glacials: 0, bridges: 0, splits: 0, vicariance: 0, impacts: 0, eruptions: 0, fires: 0, massExt: 0, derives: 0 },
  };
}

/** Внутренности World, которые нужны живой планете (в классе они private). */
type GeoWorld = { [K in keyof World]: World[K] } & {
  ctx: Creature | null;
  deriveStatics(cells: ArrayLike<number>): void;
  nearbyLand(x: number, y: number, r: number, g: Genome): [number, number];
  soil: Float32Array;
  litter: Float32Array;
  s0: Float32Array;
};

/** Входы пересчёта рельефа из состояния мира (без живой планеты — исходный рельеф). */
export function deriveInput(w: World): DeriveInput {
  const g = w.geo;
  if (!w.lp || !g) return BASE_INPUT;
  return { seaQ: g.seaQ, elevD: w.elevD, plate: g.plate ? { ox: g.plate.ox, oy: g.plate.oy } : null, lakes: g.lakes, shadow: g.shadow };
}

/** Тот же отпечаток, что Terrain.rev после пересчёта из текущих (применённых) входов. */
export function geoInputsHash(w: World): number {
  return deriveHash(deriveInput(w));
}

/** Сумма ожидающих правок по клеткам — для предела кисти (производное от pend: кэш по самому массиву). */
const pendSums = new WeakMap<number[], { n: number; m: Map<number, number> }>();
function pendSum(g: GeoState): Map<number, number> {
  let c = pendSums.get(g.pend);
  if (!c || c.n > g.pend.length) {
    c = { n: 0, m: new Map() };
    pendSums.set(g.pend, c);
  }
  for (; c.n < g.pend.length; c.n += 2) c.m.set(g.pend[c.n], (c.m.get(g.pend[c.n]) ?? 0) + g.pend[c.n + 1]);
  return c.m;
}

/**
 * 🏔 Кисть рельефа: правки клеток в радиусе r (купол dz·(1 − (d/r)²), 1e-4 единицы) — в очередь; рельеф пересчитается
 * в начале следующего шага. Предел ±TERRA_MAX считается с учётом уже ждущих правок, поэтому мазок, пришедший по точкам
 * или целиком, даёт ту же очередь.
 */
export function terraBrush(w: World, x: number, y: number, r: number, dz: number): number {
  const g = w.geo;
  if (!w.lp || !g || !w.elevD) return 0;
  const t = w.terrain, cell = w.cell, E = w.elevD;
  const sums = pendSum(g);
  let k = 0;
  for (let cy = Math.max(0, Math.floor((y - r) / cell)); cy <= Math.min(t.rows - 1, (y + r) / cell); cy++) {
    for (let cx = Math.max(0, Math.floor((x - r) / cell)); cx <= Math.min(t.cols - 1, (x + r) / cell); cx++) {
      const d = Math.hypot((cx + 0.5) * cell - x, (cy + 0.5) * cell - y);
      if (d >= r) continue;
      const i = cy * t.cols + cx;
      const cur = E[i] + (sums.get(i) ?? 0);
      const want = Math.round(dz * (1 - (d / r) ** 2));
      // предел — только в сторону мазка: клетка, уже ниже −TERRA_MAX (пороги reset), кисть вверх не дёргает к пределу
      const v = Math.max(Math.min(cur, -GEO.TERRA_MAX), Math.min(Math.max(cur, GEO.TERRA_MAX), cur + want)) - cur;
      if (v === 0) continue;
      g.pend.push(i, v);
      sums.set(i, cur - E[i] + v);
      k++;
    }
  }
  pendSums.get(g.pend)!.n = g.pend.length;
  return k;
}

/**
 * Пересчитать рельеф из состояния. live — живой шаг: сначала применить очередь правок (kettleQ → pend → elevD),
 * потом после пересчёта поправить корм и почву у сменивших биом клеток и увести зверей от воды.
 * live = false (восстановление снимка) — только рельеф и производное: elevD снимка уже применён, pend переходит дальше.
 */
export function deriveTerrain(w: World, live: boolean): void {
  if (!GEO_PERF.on) return deriveTerrain0(w, live);
  const t0 = performance.now();
  deriveTerrain0(w, live);
  GEO_PERF.ms.push(performance.now() - t0);
}

/** Стенд: время каждого пересчёта рельефа (мс), только при on (на мир не влияет). */
export const GEO_PERF = { on: false, ms: [] as number[] };

function deriveTerrain0(w: World, live: boolean): void {
  const W = w as unknown as GeoWorld;
  const g = w.lp ? w.geo : null;
  if (live && g && w.elevD) {
    const E = w.elevD;
    for (const i of g.kettleQ) g.pend.push(i, -GEO.KETTLE_D);
    g.kettleQ = [];
    const P = g.pend;
    for (let k = 0; k + 1 < P.length; k += 2) {
      const v = E[P[k]] + P[k + 1];
      E[P[k]] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
    }
    g.pend = [];
  }
  const t = w.terrain;
  const out = t.derive(deriveInput(w));
  const ch = out.changed;
  W.deriveStatics(ch);
  if (live) {
    // клетки со сменой биома: корм — не больше нового потолка; новая вода — илистое дно, трава почти вся пропала
    const prev = out.prev, bi = t.biome;
    for (let k = 0; k < ch.length; k++) {
      const i = ch[k];
      if (prev[i] === bi[i]) continue;
      const info = BIOMES[bi[i]];
      if (w.grass[i] > info.fert) w.grass[i] = info.fert;
      if (w.browse[i] > info.browse) w.browse[i] = info.browse;
      if (w.forage[i] > info.forage) w.forage[i] = info.forage;
      if (info.water && !BIOMES[prev[i]].water) {
        W.soil[i] = W.s0[i];
        W.litter[i] = 0.05;
        w.grass[i] *= 0.2;
      }
    }
    if (ch.length) evacuate(W, w);
  }
  if (g) {
    const lands = labelLands(w);
    if (live) {
      g.lands = lands;
      g.stats.derives++;
      g.lastDerive = w.tick;
      updateSills(w);
    }
  }
}

/** Звери, которых застала вода, уходят на ближайшую сушу (поток мира); не нашли — остаются (глубина топит как обычно). */
function evacuate(w: GeoWorld, pub: World): void {
  const t = w.terrain;
  const saved = w.ctx;
  w.ctx = null;
  let moved = 0, stuck = 0;
  for (const c of w.creatures) {
    if (!c.alive) continue;
    const idx = t.index(c.x, c.y);
    if (w.passable(c.g, idx)) continue;
    const [x, y] = w.nearbyLand(c.x, c.y, GEO.EVAC_R, c.g);
    if (w.passable(c.g, t.index(x, y))) {
      c.x = x;
      c.y = y;
      moved++;
    } else stuck++;
    c.cell = t.index(c.x, c.y);
  }
  w.ctx = saved;
  const g = w.geo;
  if (g && moved + stuck > 0 && w.tick - g.lastLogT >= GEO.LOG_GAP) {
    g.lastLogT = w.tick;
    pub.log(`🌊 Море наступило: ${moved} зверей ушли от воды${stuck ? `, ${stuck} не нашли суши` : ''}`, 'info');
  }
}

let lmQueue: Int32Array | null = null;

/** Материки: 4-связная суша ≥ LM_MIN клеток, номер по наименьшей клетке (lm — производное, в снимок не входит). */
export function labelLands(w: World): GeoState['lands'] {
  const t = w.terrain;
  const n = t.cols * t.rows, cols = t.cols;
  const lm = (w.lm ??= new Int16Array(n));
  lm.fill(-2);
  if (!lmQueue || lmQueue.length !== n) lmQueue = new Int32Array(n);
  const q = lmQueue, bi = t.biome;
  const anchors: number[] = [], sizes: number[] = [];
  const land = (i: number) => bi[i] > B.Shallow;
  for (let s = 0; s < n; s++) {
    if (lm[s] !== -2) continue;
    if (!land(s)) {
      lm[s] = -1;
      continue;
    }
    let qt = 0;
    q[qt++] = s;
    lm[s] = -3;
    for (let qh = 0; qh < qt; qh++) {
      const i = q[qh];
      const x = i % cols;
      if (x > 0 && lm[i - 1] === -2 && land(i - 1)) { lm[i - 1] = -3; q[qt++] = i - 1; }
      if (x < cols - 1 && lm[i + 1] === -2 && land(i + 1)) { lm[i + 1] = -3; q[qt++] = i + 1; }
      if (i >= cols && lm[i - cols] === -2 && land(i - cols)) { lm[i - cols] = -3; q[qt++] = i - cols; }
      if (i + cols < n && lm[i + cols] === -2 && land(i + cols)) { lm[i + cols] = -3; q[qt++] = i + cols; }
    }
    const id = qt >= GEO.LM_MIN ? anchors.length : -1;
    if (id >= 0) {
      anchors.push(s);
      sizes.push(qt);
    }
    for (let k = 0; k < qt; k++) lm[q[k]] = id;
  }
  // geo.lands — состояние (для трекеров мостов): его меняют только живой пересчёт и reset()
  return { n: anchors.length, anchors, sizes };
}

/** Клетки со льдом (H > 0.01) — производное от ice. */
export function rebuildIceList(w: World): void {
  const ice = w.ice;
  if (!ice) {
    w.iceList = null;
    return;
  }
  let m = 0;
  for (let i = 0; i < ice.length; i++) if (ice[i] > 0.01) m++;
  const L = new Int32Array(m);
  for (let i = 0, k = 0; i < ice.length; i++) if (ice[i] > 0.01) L[k++] = i;
  w.iceList = L;
}

/** Метры от уровня моря (единицы высоты × M_PER_E). */
export const metres = (u: number): number => Math.round(u * GEO.M_PER_E);

/** Орбитальная составляющая F (−Σa/2 … +Σa/2 в среднем около −Σa/2·…): «°C-эквивалент» в долях A. */
export function orbitF(g: GeoState, orbT = g.orbT): number {
  const a = g.amps;
  let F = -(a[0] + a[1] + a[2]) / 2;
  for (let j = 0; j < 3; j++) F += a[j] * Math.sin((2 * Math.PI * orbT) / (GEO.P * PER[j]) + g.phis[j]);
  return F;
}

/** Парниковый сдвиг CO₂ (единицы температуры): 4,33·ln(C/280) °C — около +3 °C на удвоение, как во вкладке «Планета». */
export const co2Shift = (ppm: number): number => (4.33 * Math.log(Math.max(1, ppm) / 280)) / CLIMATE_C;

/** Геологическое время (тыс. лет) по орбитальным часам: цикл GEO.P ≈ 100 тыс. лет. */
export const geoKyr = (g: GeoState): number => ((g.orbT - g.orb0) / GEO.P) * 100;

let flowBuf: Float32Array | null = null;
let iceBuf: Int32Array | null = null;

/**
 * Геологический проход (раз в GEO.EVERY тактов): орбита → глобальный лёд Vg (пила: растёт медленно, тает быстро) →
 * CO₂ (следует за льдом) → сдвиг температуры острова; ледники острова (баланс массы и растекание; при ×4 — 4 раза);
 * уровень моря из Vg — шагами SEA_STEP с пересчётом рельефа; летопись цикла. Без случайностей.
 */
export function geoPass(w: World): void {
  const g = w.geo;
  const H = w.ice;
  if (!g || !H) return;
  const sp = g.speed;
  const k = sp * GEO.EVERY;
  g.orbT += k;
  const F = g.orbit ? orbitF(g) : 0;
  // CO₂: «как у природы» — следует за льдом (ледниковье 190, межледниковье 280 ppm), меняется за год
  const cT = g.co2Pin ?? 280 - GEO.CO2_FOLLOW * clamp(g.Vg, 0, 1);
  g.co2 += (cT - g.co2) * Math.min(1, k / YEAR);
  g.geoShift = GEO.A * F + (g.fPin ?? 0) + co2Shift(g.co2) - GEO.ALB * g.iceLand;
  // годовой сдвиг (без сезона) — с кнопкой игрока «🌡» тоже: оба складываются
  const ann = g.geoShift + w.climate.shift;
  const Vt = clamp(-ann / GEO.V_SHIFT, -0.5, 1.2);
  const v0 = g.Vg;
  g.Vg += (Vt - g.Vg) * Math.min(1, k / (Vt > g.Vg ? GEO.TAU_UP : GEO.TAU_DN));
  g.G = clamp(g.Vg, 0, 1);
  const dv = g.Vg - v0;
  g.dGsign = dv > 1e-7 ? 1 : dv < -1e-7 ? -1 : g.dGsign;
  for (let s = 0; s < sp; s++) icePass(w, ann);
  iceStats(w);
  cycleLog(w);
  // море: глобальный лёд (−SEA_V·Vg) плюс закреплённое игроком; рельеф — когда отстал на шаг
  g.seaOff = -GEO.SEA_V * g.Vg + g.seaPin / GEO.M_PER_E;
  if (w.tick - g.lastDerive >= GEO.REBUILD_MIN && Math.abs(g.seaOff - g.seaQ) >= GEO.SEA_STEP) {
    g.seaQ = Math.round(g.seaOff / GEO.SEA_STEP) * GEO.SEA_STEP;
    deriveTerrain(w, true);
  }
}

/** Ледники: баланс массы по годовой температуре клетки, откол в море, растекание к соседям ниже по поверхности. */
function icePass(w: World, ann: number): void {
  const H = w.ice!, t = w.terrain;
  const { cols, rows } = t;
  const n = cols * rows;
  const bt = t.baseTemp, bi = t.biome, mo = t.moist, E = t.elev;
  const { T_ICE, ACC, ABL, DT, SELF_COOL, HMAX, FLOW } = GEO;
  for (let i = 0; i < n; i++) {
    const h = H[i];
    const Ta = bt[i] + ann - SELF_COOL * (h < 1 ? h : 1);
    if (h === 0 && Ta >= T_ICE) continue;
    let b = Ta < T_ICE ? ACC * (T_ICE - Ta) * (0.5 + mo[i]) : -ABL * (Ta - T_ICE);
    if (bi[i] <= B.Shallow && b > -0.05) b = -0.05; // в море лёд откалывается и тает
    const v = h + b * DT;
    H[i] = v <= 0 ? 0 : v > HMAX ? HMAX : v;
  }
  // растекание: поверхность (рельеф + 0.3·H) ниже у соседа — часть льда уходит к нему
  const N = (flowBuf && flowBuf.length === n ? flowBuf : (flowBuf = new Float32Array(n)));
  N.set(H);
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const i = y * cols + x;
      const h = H[i];
      if (h <= 0) continue;
      const s = E[i] + 0.3 * h, cap = h * 0.25;
      let j = i - 1, d = s - (E[j] + 0.3 * H[j]);
      if (d > 0) { const q = Math.min(cap, FLOW * d * h); N[i] -= q; N[j] += q; }
      j = i + 1; d = s - (E[j] + 0.3 * H[j]);
      if (d > 0) { const q = Math.min(cap, FLOW * d * h); N[i] -= q; N[j] += q; }
      j = i - cols; d = s - (E[j] + 0.3 * H[j]);
      if (d > 0) { const q = Math.min(cap, FLOW * d * h); N[i] -= q; N[j] += q; }
      j = i + cols; d = s - (E[j] + 0.3 * H[j]);
      if (d > 0) { const q = Math.min(cap, FLOW * d * h); N[i] -= q; N[j] += q; }
    }
  }
  for (let i = 0; i < n; i++) {
    const v = N[i];
    H[i] = v < 1e-6 ? 0 : v > HMAX ? HMAX : v;
  }
}

/** Доля суши подо льдом (H > 0.15), максимум за цикл, список клеток со льдом. */
function iceStats(w: World): void {
  const H = w.ice!, M = w.iceMax!, g = w.geo!, bi = w.terrain.biome;
  const n = H.length;
  const L = (iceBuf && iceBuf.length === n ? iceBuf : (iceBuf = new Int32Array(n)));
  let land = 0, iced = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const h = H[i];
    if (bi[i] > B.Shallow) {
      land++;
      if (h > 0.15) iced++;
    }
    if (h > 0.01) {
      L[m++] = i;
      const q = Math.round(255 * (h < 1 ? h : 1));
      if (q > M[i]) M[i] = q;
    }
  }
  g.iceLand = land ? iced / land : 0;
  if (g.iceLand > g.iceMaxLand) g.iceMaxLand = g.iceLand;
  w.iceList = L.slice(0, m); // своя копия: буфер общий для всех миров процесса
}

/** Летопись цикла: наступление льда, пик (когда таяние уже пошло), конец; сброс максимума льда в межледниковье. */
function cycleLog(w: World): void {
  const g = w.geo!;
  const V = g.Vg;
  if (g.phase === 0) {
    if (V >= 0.25 && g.dGsign > 0) {
      g.phase = 1;
      g.vPeak = V;
      w.log('❄️ Наступает ледниковье: на севере растут ледники, море начинает отступать', 'info', undefined, undefined, 'geo_iceage');
    }
  } else if (g.phase === 1) {
    if (V > g.vPeak) {
      g.vPeak = V;
      g.peakSea = g.seaQ;
      g.peakIce = g.iceLand;
    } else if (g.seaQ < g.peakSea) g.peakSea = g.seaQ;
    if (g.iceLand > g.peakIce) g.peakIce = g.iceLand;
    if (g.vPeak > 0.6 && V < g.vPeak - 0.1) {
      g.phase = 2;
      g.cycleN++;
      g.stats.glacials++;
      g.lastMaxTick = w.tick;
      w.log(`🧊 Пик ледниковья позади: море опускалось на ${-metres(g.peakSea)} м, льдом было покрыто ${Math.round(100 * g.peakIce)}% суши`, 'milestone', undefined, undefined, 'geo_lgm');
      w.log('💧 Ледники тают: море поднимается и затапливает низины', 'info', undefined, undefined, 'geo_termination');
    } else if (V < 0.15) g.phase = 0; // похолодание не дошло до ледниковья
  } else if (V < 0.1) {
    g.phase = 0;
    g.vPeak = g.peakIce = g.peakSea = 0;
    g.iceMaxLand = 0;
    w.iceMax!.fill(0);
  }
}

/**
 * Последствия для травы и корма — разреженный проход после growGrass по клеткам со льдом (сами циклы growGrass и
 * soilPass не тронуты): потолок травы, листвы и ягод ×max(0, 1 − ICE_FOOD·H).
 */
export function geoHabitat(w: World): void {
  const L = w.iceList;
  if (!L || L.length === 0) return;
  const H = w.ice!, bi = w.terrain.biome, gr = w.grass, br = w.browse, fo = w.forage;
  for (let k = 0; k < L.length; k++) {
    const i = L[k];
    const h = H[i];
    if (h < 0.02) continue;
    const m = 1 - GEO.ICE_FOOD * (h < 1 ? h : 1);
    const K = m > 0 ? m : 0;
    const info = BIOMES[bi[i]];
    if (gr[i] > info.fert * K) gr[i] = info.fert * K;
    if (br[i] > info.browse * K) br[i] = info.browse * K;
    if (fo[i] > info.forage * K) fo[i] = info.forage * K;
  }
}

// ---------------- пороги и пролив (при reset) ----------------

/** Полоса из W рядов в [lo, hi) с наименьшим числом клеток суши. */
function thinBand(w: World, lo: number, hi: number, W: number): number {
  const t = w.terrain, cols = t.cols, bi = t.biome;
  let best = lo, bestN = Infinity;
  for (let y0 = lo; y0 + W <= hi; y0++) {
    let m = 0;
    for (let y = y0; y < y0 + W; y++) for (let x = 0; x < cols; x++) if (bi[y * cols + x] > B.Shallow) m++;
    if (m < bestN) {
      bestN = m;
      best = y0;
    }
  }
  return best;
}

/** Высочайшая клетка суши в рядах [y0, y1) — якорь берега (суша при любом море). */
function anchor(w: World, y0: number, y1: number): number {
  const t = w.terrain, cols = t.cols;
  let best = -1, e = -Infinity;
  for (let y = Math.max(0, y0); y < Math.min(t.rows, y1); y++)
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (t.elev[i] > e) {
        e = t.elev[i];
        best = i;
      }
    }
  return best;
}

/**
 * Пороги при reset (поток mulberry32(seed ^ 0x51115), до цикла травы): мелкий порог поперёк острова в его «талии»
 * (y 0,38…0,62; дно −31…−51 м — сохнет, когда море опустится на 51 м) и пролив Уоллеса на юге (y 0,70…0,85; −390 м —
 * глубоко при любом море). Обе полосы — во всю ширину, так что каждая делит остров надвое.
 */
export function carveSills(w: World): void {
  const g = w.geo, E = w.elevD;
  if (!g || !E || !GEO.SILL_ON) return;
  const t = w.terrain, { cols, rows } = t;
  const sea0 = t.seaLevel;
  const r = mulberry32(w.seed ^ 0x51115);
  const cut = (kind: 'sill' | 'wallace', y0: number, W: number, depth: (x: number) => number): SillRec => {
    const cells: number[] = [];
    for (let y = y0; y < y0 + W; y++)
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const want = sea0 - depth(x);
        if (t.elev[i] <= want) continue;
        E[i] = Math.max(-32767, Math.round((want - t.elev[i]) * 1e4));
        cells.push(i);
      }
    return { kind, cells, name: properName(r), open: false, a: anchor(w, y0 - 25, y0), b: anchor(w, y0 + W, y0 + W + 25), y0, y1: y0 + W };
  };
  // мелкий порог: глубже всего посередине суши полосы — мост открывается от берегов и смыкается в середине
  const ys = thinBand(w, Math.floor(0.38 * rows), Math.ceil(0.62 * rows), GEO.SILL_W);
  let x0 = cols, x1 = -1;
  for (let y = ys; y < ys + GEO.SILL_W; y++)
    for (let x = 0; x < cols; x++)
      if (t.biome[y * cols + x] > B.Shallow) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
  const xc = (x0 + x1) / 2, half = Math.max(1, (x1 - x0) / 2);
  const ph = r() * 2 * Math.PI;
  g.sills.push(cut('sill', ys, GEO.SILL_W, (x) => {
    const s = clamp(Math.abs(x - xc) / half + 0.08 * Math.sin(ph + x * 0.3), 0, 1);
    return GEO.SILL * (1 - 0.4 * s);
  }));
  const yw = thinBand(w, Math.floor(0.7 * rows), Math.ceil(0.85 * rows), GEO.WALLACE_W);
  g.sills.push(cut('wallace', yw, GEO.WALLACE_W, () => GEO.WALLACE));
}

/** Состояние порогов после пересчёта рельефа (живой): мост есть, если якоря берегов на одном материке; летопись. */
function updateSills(w: World): void {
  const g = w.geo!, lm = w.lm!;
  for (const s of g.sills) {
    const open = s.a >= 0 && s.b >= 0 && lm[s.a] >= 0 && lm[s.a] === lm[s.b];
    if (open === s.open) continue;
    s.open = open;
    if (s.kind === 'wallace') continue;
    const t = w.terrain, i = s.cells[s.cells.length >> 1] ?? s.a;
    const x = ((i % t.cols) + 0.5) * w.cell, y = (Math.floor(i / t.cols) + 0.5) * w.cell;
    if (open) {
      g.stats.bridges++;
      w.log(`🌉 Море отступило на ${-metres(g.seaQ)} м — пролив ${s.name} стал перешейком: север и юг соединились`, 'milestone', x, y, 'geo_landbridge');
    } else w.log(`🌊 Перешеек ${s.name} ушёл под воду — север и юг снова разделены`, 'info', x, y, 'geo_sealevel');
  }
}

// ---------------- действия игрока (вкладка «Климат») ----------------

export type GeoAction =
  | { k: 'co2'; ppm: number | null }
  | { k: 'iceAge'; mode: 'cycle' | 'now' | 'end' | 'off' }
  | { k: 'sea'; dm: number }
  | { k: 'geoSpeed'; v: 1 | 4 };

/** Действия «Климата» живой планеты (без неё — ничего). */
export function geoAction(w: World, a: GeoAction): void {
  const g = w.geo;
  if (!w.lp || !g) return;
  switch (a.k) {
    case 'co2': {
      g.co2Pin = a.ppm === null ? null : clamp(Math.round(a.ppm), 100, 3000);
      if (g.co2Pin === null) w.log('🏭 CO₂ снова «как у природы»: следует за ледниками', 'player', undefined, undefined, 'geo_co2');
      else {
        const dC = co2Shift(g.co2Pin) * CLIMATE_C;
        w.log(`🏭 CO₂ теперь ${g.co2Pin} ppm → ${dC >= 0 ? '+' : '−'}${Math.abs(dC).toFixed(1).replace('.', ',')} °C к доиндустриальным 280 ppm (за год)`, 'player', undefined, undefined, 'geo_co2');
      }
      break;
    }
    case 'iceAge': {
      const m = a.mode;
      g.orbit = m === 'cycle';
      g.fPin = m === 'now' ? GEO.PIN_COLD : m === 'end' ? GEO.PIN_WARM : null;
      const text = {
        cycle: '🔁 Ледниковья снова идут по орбите: ритм 100, 41 и 23 тысячи лет',
        now: '❄️ Вы начали ледниковье: холод держится, пока его не отменить',
        end: '💧 Вы закончили ледниковье: тепло держится, лёд тает',
        off: '⏹ Орбита больше не раскачивает климат: ни ледниковий, ни потеплений',
      }[m];
      w.log(text, 'player', undefined, undefined, 'geo_iceage');
      break;
    }
    case 'sea': {
      g.seaPin = clamp(Math.round(a.dm), -150, 80);
      w.log(g.seaPin === 0 ? '🌊 Море снова «как у природы»: за ним следит лёд' : `🌊 Море закреплено: ${g.seaPin > 0 ? '+' : '−'}${Math.abs(g.seaPin)} м к ледникам`, 'player', undefined, undefined, 'geo_sealevel');
      break;
    }
    case 'geoSpeed':
      g.speed = a.v === 4 ? 4 : 1;
      w.log(g.speed === 4 ? '⏩ Геология ×4: орбита и ледники идут вчетверо быстрее, эволюция — нет' : '⏩ Геология ×1: ледниковый цикл — около 8 лет острова', 'player', undefined, undefined, 'geo_timescale');
      break;
  }
}

/** Выделить клеточные поля живой планеты (только при lp). */
export function allocGeoCells(w: World, n: number): void {
  w.ice = new Float32Array(n);
  w.iceMax = new Uint8Array(n);
  w.elevD = new Int16Array(n);
  w.fx8 = new Uint8Array(4 * n);
}
