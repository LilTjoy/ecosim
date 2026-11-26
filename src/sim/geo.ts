// 🌋 «Живая планета»: изменяемый рельеф, ледники, уровень моря, катастрофы (без DOM — общий для страницы, стенда и воркера).
//
// Этап 0 — только ядро: рельеф — чистая функция снимаемого состояния (seaQ, elevD, …), все правки рельефа идут
// через очередь geo.pend и применяются лишь в живом пересчёте (deriveTerrain(w, true) в начале шага). Восстановление
// снимка пересчитывает рельеф из уже применённого состояния и очередь не трогает — поэтому перемотка ≡ живой прогон.
// Все случайности — World.r() (поток мира, ctx null) или mulberry32(seed ^ c); Math.random здесь нет.
import { mulberry32 } from '../lib/random';
import { BASE_INPUT, BIOMES, B, deriveHash, type DeriveInput } from './terrain';
import type { Creature, World } from './world';
import type { Genome } from './genome';

/** Такты года (= world.YEAR; свой — чтобы не было цикла импорта при вычислении таблицы). */
const YEAR = 6000;

export const GEO = {
  EVERY: 60, P: 8 * YEAR, SPEEDS: [1, 4] as const,
  A: 0.055, AMPS0: [1, 0.5, 0.4], ALB: 0.04, CO2_FOLLOW: 90,
  TAU_UP: 2 * YEAR, TAU_DN: 0.4 * YEAR, V_SHIFT: 0.19, SEA_V: 0.04,
  T_ICE: 0.05, ACC: 0.6, ABL: 1.2, FLOW: 0.12, HMAX: 1, SELF_COOL: 0.08, ICE_COOL: 0.05, ICE_MOVE: 0.3, DT: 0.05,
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
} as const;

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
  speed: 1 | 4; orbit: boolean; orbT: number; phis: [number, number, number]; amps: [number, number, number];
  Vg: number; /** = clamp(Vg, 0, 1) — для HUD и порогов */ G: number; iceLand: number; iceMaxLand: number;
  dGsign: -1 | 0 | 1; cycleN: number; lastMaxTick: number;
  co2: number; co2Pin: number | null; seaPin: number; seaOff: number; seaQ: number; lastDerive: number;
  /** Правки рельефа, ждущие следующего пересчёта: подряд [клетка, dz (1e-4 единицы)]. */
  pend: number[];
  kettleQ: number[]; shadow: boolean; lakes: boolean;
  aer: number; dark: number; geoShift: number; isolatedUntil: number; lastLogT: number;
  fire: number[]; sills: { kind: 'sill' | 'wallace' | 'player'; cells: number[]; name: string; open: boolean }[];
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
  return {
    speed: 1, orbit: false, orbT: 0, phis, amps: [GEO.AMPS0[0], GEO.AMPS0[1], GEO.AMPS0[2]],
    Vg: 0, G: 0, iceLand: 0, iceMaxLand: 0,
    dGsign: 0, cycleN: 0, lastMaxTick: -1,
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
      const v = Math.max(-GEO.TERRA_MAX, Math.min(GEO.TERRA_MAX, cur + want)) - cur;
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

/** Геологический проход (раз в GEO.EVERY тактов). Этап 0 — заготовка: орбиты, льда и моря ещё нет. */
export function geoPass(w: World): void {
  const g = w.geo;
  if (!g) return;
  g.geoShift = 0;
}

/**
 * Последствия для травы и корма — разреженный проход после growGrass по льду, пеплу, гари и соли (сами циклы
 * growGrass/soilPass не тронуты). Этап 0 — без эффектов: льда и пепла ещё нет.
 */
export function geoHabitat(w: World): void {
  const L = w.iceList;
  if (!L || L.length === 0) return;
}

/** Выделить клеточные поля живой планеты (только при lp). */
export function allocGeoCells(w: World, n: number): void {
  w.ice = new Float32Array(n);
  w.iceMax = new Uint8Array(n);
  w.elevD = new Int16Array(n);
  w.fx8 = new Uint8Array(4 * n);
}
