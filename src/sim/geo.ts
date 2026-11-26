// 🌋 «Живая планета»: изменяемый рельеф, ледники, уровень моря, катастрофы (без DOM — общий для страницы, стенда и воркера).
//
// Этап 0 — только ядро: рельеф — чистая функция снимаемого состояния (seaQ, elevD, …), все правки рельефа идут
// через очередь geo.pend и применяются лишь в живом пересчёте (deriveTerrain(w, true) в начале шага). Восстановление
// снимка пересчитывает рельеф из уже применённого состояния и очередь не трогает — поэтому перемотка ≡ живой прогон.
// Все случайности — World.r() (поток мира, ctx null) или mulberry32(seed ^ c); Math.random здесь нет.
import { clamp, mulberry32 } from '../lib/random';
import { BASE_INPUT, BIOMES, B, deriveHash, properName, type DeriveInput } from './terrain';
import type { Creature, GeoEnv, World } from './world';
import type { Genome } from './genome';
import { P } from './modules';
import { aerShift, catHabitat, catPass, volcPass } from './geoCat';
import { bridgeClosed, bridgeOpened, meltOnMax, rangeOnGlacial, rangeOnInterglacial, refugiaAtMax, updateHomes } from './geoTrack';

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
  FIRE_EVERY: 10, FIRE_P: 0.5, FIRE_MAX: 4000, LIGHTNING: 2e-4,
  EXT_SHARE: 0.5, EXT_MIN: 4, ISOLATE: 2 * YEAR, LOG_GAP: 300,
  /** После катастрофы радиацию (🌳) считаем через RAD_WAIT тактов. */
  RAD_WAIT: 4 * YEAR,
  DRIFT_T: 1500, UPLIFT: 700, UPLIFT_W: 4, OCEAN_FLOOR: -0.13,
  /** Плиты: на сколько клеток плита B может уехать вбок, на север (надвиг) и на юг (разлом). */
  PLATE_MAXX: 20, PLATE_MAXN: 10, PLATE_MAXS: 8,
  /** Поднятие при столкновении — не выше гор + UPLIFT_TOP; хребет игрока — горы + RIDGE_H посередине, полуширина RIDGE_HW клеток. */
  UPLIFT_TOP: 0.08, RIDGE_H: 0.05, RIDGE_HW: 2.2,
  /** Поднимается только кора не глубже исходного моря + UPLIFT_MIN (−0,15 ≈ −450 м: суша, шельф, дно пролива Уоллеса). */
  UPLIFT_MIN: -0.15,
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
  /** Выпахивание: раз в SCOUR_EVERY тактов (пачкой, а не каждый проход) — SCOUR×(проходов)×скорость под льдом H > 0.5. */
  SCOUR_EVERY: 600,
  /** Затравок озёр (котловин) не больше. */
  LAKE_SEEDS: 2000,
  /** Сколько пеших особей вида на каждой стороне нужно, чтобы следить за половинами; ниже — запись забыта. */
  ISO_KEEP: 4,
  /** Перешеек игрока: суша на +0,035 (≈ +105 м) над исходным морем; пролив игрока — до −0,13 (как Уоллес) или мелкий (порог). */
  ISTHMUS_H: 0.035,
  /** Полуширина пролива или перешейка игрока, клеток. */
  LINE_HW: 1.6,
  /**
   * 🌍 Связь с планетой (этап 4, env.geo): сдвиг цели Vg у тёплой (iceAge 0: циклы выключены, море ≈ +42 м) и у
   * ледяной эпохи (iceAge 2: лёд не уходит); вулканы сами — VEI 6 с вероятностью VOLC_P·volc за 20 тактов геологии,
   * VEI 7 — в VOLC_7 раз реже (VEI 8 сам не бывает).
   */
  BIAS_WARM: -0.35, BIAS_COLD: 0.5, VOLC_P: 2e-5, VOLC_7: 0.1,
  /** ♾️ «Холод — это отбор»: строка летописи, если доля мохнатых на суше выросла хотя бы на FUR_DP (и в FUR_K раза). */
  FUR_DP: 0.08, FUR_K: 1.3,
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
  /** Ось пролива (px, от x0,y0 к x1,y1) и его полуширина: стороны моста — по знаку векторного произведения. */
  p: [number, number, number, number];
  hw: number;
}

/** Сухопутный мост через порог: кто прошёл, кто прижился за ним, кто из местных вымер. Стороны — 0 (север/запад), 1. */
export interface BridgeRec {
  sill: number; open: number; close: number | null;
  /** Видов «родом» с каждой стороны при открытии. */
  a: number; b: number;
  /** Переходов (по одному на особь) со стороны 0 и со стороны 1; летуны — отдельно. */
  cross: [number, number]; fly: number;
  /** Особи, уже посчитанные в cross (не больше 2000). */
  seen: Set<number>;
  /** Вид → его сторона (где было больше особей, когда его впервые увидели у моста). */
  nat: Map<number, 0 | 1>;
  /** Пришельцы: t — когда прижились (≥ INVADE_N особей ≥ INVADE_T тактов), −1 — пока нет. */
  invaders: { sp: number; from: 0 | 1; t: number; since: number }[];
  /** Местные виды, вымершие при прижившихся пришельцах. */
  lost: number[]; reported: boolean;
}
/** Половины вида по разные стороны барьера: метки сторон, поколения врозь, расхождение генов, утечки генов. */
export interface IsoRec {
  sp: number; t: number; sill: number;
  /** Особей на сторонах (последний обход). */
  parts: number[]; gen0: number[]; ga: number; d: number; half: boolean;
  /** id особи → сторона барьера. */
  tag: Map<number, 0 | 1>;
  /** Утечек генов (переход или скрещивание через барьер); dirty — счёт поколений сбросить на обходе. */
  leak: number; dirty: boolean; mixLogged: boolean;
  /** Основатели за проливом Уоллеса (летопись разделений — сводкой). */
  founder: boolean;
}
/** Южная плита: ряды от rift исходного рельефа, сдвиг ox, oy; vx, vy ∈ {−1, 0, 1} — шаг раз в DRIFT_T/скорость тактов. */
export interface PlateRec {
  rift: number; ox: number; oy: number; vx: number; vy: number; next: number;
  /** Было ли столкновение (летопись — один раз), имя хребта, объявлены ли горы, расходились ли, шагов всего. */
  collided: boolean; name: string; mtn: boolean; rifted: boolean; steps: number;
}
export interface RefRec { region: number; lm: number; species: number[]; n: number; /** базовые регионы рефугиума */ regions: number[] }

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
  /** ⛰ Хребет игрока ждёт пересчёта: тогда включится дождевая тень. Сколько клеток суши в тени было в последней записи летописи. */
  shadowQ: boolean; shadowN: number;
  aer: number; dark: number; geoShift: number; isolatedUntil: number; lastLogT: number;
  fire: number[]; sills: SillRec[];
  lands: { n: number; anchors: number[]; sizes: number[] };
  bridges: BridgeRec[]; isolates: IsoRec[]; refugia: RefRec[] | null;
  /** Такт последних рефугиумов (линза 🏔 — два года). */
  refT: number;
  /** [вид, северная граница y] в начале ледниковья */ rangeRef: [number, number][];
  /** виды, чей ареал отступил на юг в этом цикле */ wide: number[];
  /** Разделения основателей за проливом Уоллеса, ещё не записанные в летопись (сводка), и такт последней сводки. */
  wsplit: string[]; wLogT: number;
  /** Затравки озёр — клетки котловин (вход пересчёта рельефа). */
  lakeSeeds: number[];
  /** 💀 Виды, жившие при катастрофе (через год — сколько исчезло), её такт, медиана размера травоядных и число зверей тогда. */
  extRing: number[]; extT: number; med0: number; n0: number; lastMass: number; lastCause: number;
  /** Итог «год спустя» последней катастрофы (панель, урок). */
  lastSum: { t: number; k: number; N: number; m0: number; m1: number; n0: number; n1: number } | null;
  /** История катастроф (последние CAT.HIST). */
  cats: { t: number; kind: 'volcano' | 'impact' | 'tsunami' | 'fire'; x: number; y: number; text: string }[];
  /** Пожар сейчас: сколько клеток выгорело, где начался, объявлен ли мегапожар. */
  fireEp: { n: number; x: number; y: number; mega: boolean; t: number } | null;
  /** Есть ли на клетках пепел, гарь или соль (иначе их проходы пропускаются). */
  fxOn: boolean;
  /** Плита B (юг, от середины пролива Уоллеса): сдвиг (клеток), скорость (клеток за шаг), такт следующего шага. */
  plate: PlateRec | null;
  /**
   * 🌍 Связь с планетой (из env.geo при reset; снимок несёт их сам — sameWorld env.geo не сравнивает): эпоха планеты
   * (null — остров сам по себе, как Земля), естественный CO₂ межледниковья, сдвиг цели Vg, сила вулканизма.
   */
  iceAge: 0 | 1 | 2 | null; co2Base: number; vBias: number; volc: number;
  /** ♾️ Доля мохнатых среди сухопутных в начале ледниковья (−1 — не мерили). */
  fur0: number;
  stats: { glacials: number; bridges: number; splits: number; vicariance: number; impacts: number; eruptions: number; fires: number; massExt: number; derives: number;
    leaks: number; invaders: number; moraines: number; kettles: number; lakes: number; refugia: number;
    /** Разделения по барьерам: мелкий порог, Уоллес, пролив игрока. */ sSill: number; sWall: number; sPlay: number };
}

/**
 * Новое состояние живой планеты. ge — условия с уровня «Планета» (нет — как на Земле, всё по умолчанию):
 * вытянутость орбиты задаёт силу 100-тысячелетнего ритма, без большой луны наклон оси качается втрое сильнее,
 * эпоха планеты (iceAge) включает или выключает циклы и сдвигает цель льда, CO₂ — естественный уровень острова.
 */
export function newGeo(seed: number, ge?: GeoEnv): GeoState {
  const r = mulberry32(seed ^ 0x6e0c1);
  const phis: [number, number, number] = [r() * 2 * Math.PI, r() * 2 * Math.PI, r() * 2 * Math.PI];
  const amps: [number, number, number] = [GEO.AMPS0[0], GEO.AMPS0[1], GEO.AMPS0[2]];
  if (ge) {
    // Земля (ecc 0,017, большая Луна) → ровно AMPS0
    amps[0] = (GEO.AMPS0[0] * (0.6 + 8 * clamp(ge.ecc, 0, 0.6))) / (0.6 + 8 * 0.017);
    amps[1] = ge.moon ? GEO.AMPS0[1] : 1.6;
  }
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
    speed: 1, orbit: !ge || ge.iceAge !== 0, orbT: orb0, orb0, phis, amps,
    Vg: 0, G: 0, iceLand: 0, iceMaxLand: 0,
    dGsign: 0, cycleN: 0, lastMaxTick: -1,
    phase: 0, vPeak: 0, peakSea: 0, peakIce: 0, fPin: null,
    co2: ge ? clamp(Math.round(ge.co2ppm), 150, 5000) : 280, co2Pin: null, seaPin: 0, seaOff: 0, seaQ: 0, lastDerive: -1e9,
    pend: [], kettleQ: [], shadow: false, lakes: false, shadowQ: false, shadowN: 0,
    aer: 0, dark: 0, geoShift: 0, isolatedUntil: 0, lastLogT: -1e9,
    fire: [], sills: [], lands: { n: 0, anchors: [], sizes: [] },
    bridges: [], isolates: [], refugia: null, refT: -1e9, rangeRef: [], wide: [], wsplit: [], wLogT: -1e9, lakeSeeds: [],
    extRing: [], extT: -1e9, med0: 0, n0: 0, lastMass: -1e9, lastCause: -1e9, lastSum: null, cats: [], fireEp: null, fxOn: false, plate: null,
    iceAge: ge ? ge.iceAge : null,
    co2Base: ge ? clamp(Math.round(ge.co2ppm), 150, 5000) : 280,
    vBias: !ge || ge.iceAge === 1 ? 0 : ge.iceAge === 0 ? GEO.BIAS_WARM : GEO.BIAS_COLD,
    volc: ge ? clamp(ge.volcanism, 0, 3) : 1,
    fur0: -1,
    stats: { glacials: 0, bridges: 0, splits: 0, vicariance: 0, impacts: 0, eruptions: 0, fires: 0, massExt: 0, derives: 0, leaks: 0, invaders: 0, moraines: 0, kettles: 0, lakes: 0, refugia: 0, sSill: 0, sWall: 0, sPlay: 0 },
  };
}

/** 🌍 Первая строка летописи острова, спустившегося с планеты. */
export function geoDescent(ge: GeoEnv): string {
  const ppm = clamp(Math.round(ge.co2ppm), 150, 5000);
  const epoch = ge.iceAge === 0 ? 'тёплая эпоха' : ge.iceAge === 1 ? 'ледниковая эпоха' : 'эпоха вечного льда';
  const isl = ge.iceAge === 0 ? 'на острове не будут оледенения (море выше нынешнего)' : ge.iceAge === 1 ? 'на острове будут оледенения' : 'лёд на острове не уйдёт и в тёплые века';
  const moon = ge.moon ? '' : ' Большой луны нет — наклон оси качается сильнее, ледниковья резче.';
  return `🌍 Планета сейчас: ${epoch}, CO₂ ${ppm} ppm — ${isl}.${moon}`;
}

/** Внутренности World, которые нужны живой планете (в классе они private). */
type GeoWorld = { [K in keyof World]: World[K] } & {
  ctx: Creature | null;
  deriveStatics(cells: ArrayLike<number>): void;
  nearbyLand(x: number, y: number, r: number, g: Genome): [number, number];
  soil: Float32Array;
  litter: Float32Array;
  s0: Float32Array;
  claim: Float32Array;
  claimTick: Int32Array;
};

/** Входы пересчёта рельефа из состояния мира (без живой планеты — исходный рельеф). */
export function deriveInput(w: World): DeriveInput {
  const g = w.geo;
  if (!w.lp || !g) return BASE_INPUT;
  return { seaQ: g.seaQ, elevD: w.elevD, plate: g.plate ? { ox: g.plate.ox, oy: g.plate.oy, rift: g.plate.rift } : null, lakes: g.lakes, shadow: g.shadow, lakeSeeds: g.lakes ? g.lakeSeeds : null };
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
export const GEO_PERF = { on: false, ms: [] as number[], drift: [] as number[], riders: 0 };

let warmed = false;
/**
 * Прогрев пересчёта рельефа (один раз на процесс, при первом reset живой планеты): первые 3–4 пересчёта идут до
 * оптимизации кода движком и стоят 15–50 мс. Пересчёт — чистая функция входов на месте, поэтому лишние прогоны с
 * другими входами (море ниже, сдвиг плиты, дождевая тень) ничего не меняют: следом идёт настоящий пересчёт.
 */
export function warmDerive(w: World): void {
  if (warmed || !w.lp || !w.geo) return;
  warmed = true;
  const t = w.terrain, inp = deriveInput(w);
  const plate = { ox: 1, oy: -1, rift: plateRift(w) };
  for (const v of [{ seaQ: inp.seaQ - 0.008 }, { seaQ: inp.seaQ - 0.004, plate }, { seaQ: inp.seaQ - 0.012, shadow: true }, { seaQ: inp.seaQ - 0.016, plate, shadow: true }])
    t.derive({ ...inp, ...v });
}

function deriveTerrain0(w: World, live: boolean): void {
  const W = w as unknown as GeoWorld;
  const g = w.lp ? w.geo : null;
  if (live && g && w.elevD) {
    const E = w.elevD;
    // котловины: середина −KETTLE_D, четыре соседа — вполовину (чтобы впадина была шире клетки)
    const cols = w.terrain.cols, n = E.length;
    for (const i of g.kettleQ) {
      g.pend.push(i, -GEO.KETTLE_D);
      const x = i % cols, h = GEO.KETTLE_D >> 1;
      if (x > 0) g.pend.push(i - 1, -h);
      if (x < cols - 1) g.pend.push(i + 1, -h);
      if (i >= cols) g.pend.push(i - cols, -h);
      if (i + cols < n) g.pend.push(i + cols, -h);
    }
    g.kettleQ = [];
    if (g.shadowQ) {
      g.shadow = true;
      g.shadowQ = false;
    }
    const P = g.pend;
    for (let k = 0; k + 1 < P.length; k += 2) {
      const v = E[P[k]] + P[k + 1];
      E[P[k]] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
    }
    g.pend = [];
  }
  const t = w.terrain;
  const lakes0 = live && g ? new Set(t.lakes.map((l) => l.name)) : null;
  const out = t.derive(deriveInput(w));
  w.moistK = t.moistK;
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
      updateHomes(w);
      if (t.moistK) shadowLog(w);
      if (g.plate) plateLog(w);
      // 🏞 новые озёра — в летопись (одной строкой)
      const fresh = t.lakes.filter((l) => !lakes0!.has(l.name));
      if (fresh.length) {
        g.stats.lakes += fresh.length;
        const l0 = fresh[0], x = ((l0.cell % t.cols) + 0.5) * w.cell, y = (Math.floor(l0.cell / t.cols) + 0.5) * w.cell;
        // ☄️🌋 озеро у недавнего кратера или кальдеры — не от льда
        const crater = g.cats.find((c) => (c.kind === 'volcano' || c.kind === 'impact') && Math.hypot(c.x - x, c.y - y) < 400);
        if (crater) w.log(`🏞 Новое озеро «${l0.name}» — в ${crater.kind === 'volcano' ? 'кальдере вулкана' : 'кратере от удара'}`, 'info', x, y, crater.kind === 'volcano' ? 'geo_supervolcano' : 'geo_impactwinter');
        else w.log(fresh.length === 1 ? `🏞 Новое озеро «${l0.name}» — подарок тающего льда` : `🏞 Новые озёра — подарок тающего льда: ${fresh.slice(0, 4).map((l) => `«${l.name}»`).join(', ')}${fresh.length > 4 ? ` и ещё ${fresh.length - 4}` : ''}`, 'info', x, y, 'geo_kettle');
      }
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
/**
 * Сдвиг от CO₂ для острова: относительно естественного уровня планеты (co2Base). Тепло самой планеты уже в её
 * температуре (env.tempOffset) — второй раз его не считаем. На Земле (280 ppm) — ровно co2Shift.
 */
export const co2Warm = (g: GeoState, ppm: number): number => co2Shift(ppm) - (g.co2Base === 280 ? 0 : co2Shift(g.co2Base));

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
  // (у планеты с другим естественным CO₂ — та же доля: 190/280 в ледниковье)
  const cT = g.co2Pin ?? (g.co2Base === 280 ? 280 - GEO.CO2_FOLLOW * clamp(g.Vg, 0, 1) : g.co2Base * (1 - (GEO.CO2_FOLLOW / 280) * clamp(g.Vg, 0, 1)));
  g.co2 += (cT - g.co2) * Math.min(1, k / YEAR);
  // ☄️🌋 дымка и темнота оседают, следы катастроф убывают, молнии в засуху (этап 2) — до сдвига: в нём дымка
  catPass(w);
  if (g.volc > 0) volcPass(w);
  const gs = GEO.A * F + (g.fPin ?? 0) + co2Warm(g, g.co2) - GEO.ALB * g.iceLand;
  g.geoShift = g.aer > 0 ? gs + aerShift(g) : gs;
  // годовой сдвиг (без сезона) — с кнопкой игрока «🌡» тоже: оба складываются. Лёд — и глобальный Vg, и ледники
  // острова — дымку не чувствует: она живёт год-два, а лёд копится тысячелетиями (трава и звери её чувствуют)
  const ann = gs + w.climate.shift;
  // 🌍 эпоха планеты сдвигает цель льда: тёплая — льда нет и море выше, ледяная — лёд не уходит
  const Vt = clamp(g.vBias ? -ann / GEO.V_SHIFT + g.vBias : -ann / GEO.V_SHIFT, -0.5, 1.2);
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
  if (g.phase === 2) kettles(w);
  const seaDue = Math.abs(g.seaOff - g.seaQ) >= GEO.SEA_STEP;
  // 🧭 шаг плиты (этап 3): сдвиг клеток и зверей, поднятие у шва — и пересчёт сразу (в том же шаге, до чтения рельефа)
  const pt0 = GEO_PERF.on ? performance.now() : 0;
  const drift = g.plate !== null && (g.plate.vx !== 0 || g.plate.vy !== 0) && w.tick >= g.plate.next && driftStep(w);
  if (drift || (w.tick - g.lastDerive >= GEO.REBUILD_MIN && (seaDue || g.kettleQ.length))) {
    if (seaDue) g.seaQ = Math.round(g.seaOff / GEO.SEA_STEP) * GEO.SEA_STEP;
    deriveTerrain(w, true);
    if (drift && GEO_PERF.on) GEO_PERF.drift.push(performance.now() - pt0);
  }
  // выпахивание — пачкой и после пересчёта: правки ждут в очереди до начала следующего шага (как мазок кисти)
  if (w.tick % GEO.SCOUR_EVERY === 0) scour(w);
}

/** Детерминированное «случайное» 0..1 по клетке и номеру цикла (котловины — без потока костей). */
export function hash01(i: number, k: number): number {
  let h = Math.imul(i ^ Math.imul(k + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Клетки, где лёд толще MOR_HI сошёл (бит 1 плоскости морен — уже разыграна): с вероятностью KETTLE_P — котловина. */
function kettles(w: World): void {
  const g = w.geo!, H = w.ice!, M = w.iceMax!, F = w.fx8!, bi = w.terrain.biome;
  const n = H.length, hi = Math.round(255 * GEO.MOR_HI), o = 3 * n;
  const sill = sillMask(w);
  for (let i = 0; i < n; i++) {
    if (M[i] < hi || H[i] >= 0.02 || F[o + i] & 2) continue;
    F[o + i] |= 2;
    if (bi[i] <= B.Shallow || sill[i]) continue;
    if (hash01(i, g.cycleN) >= GEO.KETTLE_P) continue;
    g.kettleQ.push(i);
    g.stats.kettles++;
    if (g.lakeSeeds.length < GEO.LAKE_SEEDS) {
      g.lakeSeeds.push(i);
      g.lakes = true;
    }
  }
}

/** Клетки проливов и порогов (производное от sills; кэш по массиву). */
const sillMasks = new WeakMap<SillRec[], { n: number; m: Uint8Array }>();
function sillMask(w: World): Uint8Array {
  const S = w.geo!.sills;
  let c = sillMasks.get(S);
  if (!c || c.n !== S.length) {
    const m = new Uint8Array(w.terrain.cols * w.terrain.rows);
    for (const s of S) for (const i of s.cells) m[i] = 1;
    sillMasks.set(S, (c = { n: S.length, m }));
  }
  return c.m;
}

/** Выпахивание: под толстым льдом (H > 0.5) суша опускается — до −SCOUR_MAX всего (правки — через очередь). */
function scour(w: World): void {
  const g = w.geo!, H = w.ice!, E = w.elevD!, bi = w.terrain.biome;
  const L = w.iceList;
  if (!L || !L.length) return;
  const step = GEO.SCOUR * (GEO.SCOUR_EVERY / GEO.EVERY) * g.speed;
  const sums = pendSum(g);
  for (let k = 0; k < L.length; k++) {
    const i = L[k];
    if (H[i] <= 0.5 || bi[i] <= B.Shallow) continue;
    const cur = E[i] + (sums.get(i) ?? 0);
    if (cur <= -GEO.SCOUR_MAX) continue;
    g.pend.push(i, Math.max(-step, -GEO.SCOUR_MAX - cur));
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

/** ♾️ Доля сухопутных зверей с мехом (уровень ≥ 0,5) — только открытая эволюция. */
function furShare(w: World): number {
  let n = 0, f = 0;
  for (const c of w.creatures) {
    if (!c.alive || c.g.swim > 0.6) continue;
    n++;
    if (c.g.ph[P.FUR] >= 0.5) f++;
  }
  return n ? f / n : 0;
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
      rangeOnGlacial(w);
      g.fur0 = w.oe ? furShare(w) : -1;
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
      refugiaAtMax(w);
      meltOnMax(w);
      if (w.oe && g.fur0 >= 0) {
        // ♾️ холод — это отбор: мех обходится дорого (в тепле — жарко), а в ледниковье окупается
        const f1 = furShare(w);
        if (f1 - g.fur0 >= GEO.FUR_DP && f1 >= g.fur0 * GEO.FUR_K)
          w.log(`❄️ За ледниковье звери с мехом стали обычнее: ${Math.round(100 * g.fur0)}% → ${Math.round(100 * f1)}% сухопутных`, 'evo', undefined, undefined, 'geo_glacialfur');
        g.fur0 = -1;
      }
      w.log('💧 Ледники тают: море поднимается и затапливает низины', 'info', undefined, undefined, 'geo_termination');
    } else if (V < 0.15) g.phase = 0; // похолодание не дошло до ледниковья
  } else if (V < 0.1) {
    rangeOnInterglacial(w);
    g.phase = 0;
    g.vPeak = g.peakIce = g.peakSea = 0;
    g.iceMaxLand = 0;
    w.iceMax!.fill(0);
    // «котловина уже разыграна в этом цикле» — бит 1 плоскости морен
    const F = w.fx8!, n = w.iceMax!.length;
    for (let i = 3 * n; i < 4 * n; i++) F[i] &= 1;
  }
}

/**
 * Последствия для травы и корма — разреженный проход после growGrass по клеткам со льдом (сами циклы growGrass и
 * soilPass не тронуты): потолок травы, листвы и ягод ×max(0, 1 − ICE_FOOD·H).
 */
export function geoHabitat(w: World): void {
  if (w.geo!.fxOn || w.geo!.dark > 0.02) catHabitat(w);
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
    const yc = (y0 + W / 2) * w.cell;
    return { kind, cells, name: properName(r), open: false, a: anchor(w, y0 - 25, y0), b: anchor(w, y0 + W, y0 + W + 25), y0, y1: y0 + W, p: [0, yc, cols * w.cell, yc], hw: (W / 2) * w.cell };
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
  g.sills.forEach((s, si) => {
    // 🧭 якорь накрыла плита — новый: высочайшая суша своей стороны (до шва плит)
    if (s.a < 0 || s.b < 0) {
      const suture = g.plate ? g.plate.rift + g.plate.oy : w.terrain.rows;
      if (s.a < 0) s.a = anchor(w, s.y0 - 25, Math.min(s.y0, suture - 3));
      if (s.b < 0) s.b = anchor(w, Math.max(s.y1, suture + 3), s.y1 + 25);
    }
    const open = s.a >= 0 && s.b >= 0 && lm[s.a] >= 0 && lm[s.a] === lm[s.b];
    if (open === s.open) return;
    s.open = open;
    const t = w.terrain, i = s.cells[s.cells.length >> 1] ?? s.a;
    const x = ((i % t.cols) + 0.5) * w.cell, y = (Math.floor(i / t.cols) + 0.5) * w.cell;
    const [a, b] = sideWords(s);
    if (open) {
      g.stats.bridges++;
      if (s.kind === 'sill') w.log(`🌉 Море отступило на ${-metres(g.seaQ)} м — пролив ${s.name} стал перешейком: ${a} и ${b} соединились`, 'milestone', x, y, 'geo_landbridge');
      else w.log(`🌉 Через пролив ${s.name} лёг перешеек: ${a} и ${b} соединились`, 'milestone', x, y, 'geo_landbridge');
      bridgeOpened(w, si);
    } else {
      w.log(`🌊 Перешеек ${s.name} ушёл под воду — ${a} и ${b} снова разделены`, 'info', x, y, 'geo_sealevel');
      bridgeClosed(w, si);
    }
  });
}

/** Стороны пролива словами: «север» и «юг» у широтного, «запад» и «восток» у меридионального. */
export function sideWords(s: SillRec, gen = false): [string, string] {
  const [x0, y0, x1, y1] = s.p;
  const ew = Math.abs(x1 - x0) >= Math.abs(y1 - y0);
  return gen ? (ew ? ['севера', 'юга'] : ['запада', 'востока']) : ew ? ['север', 'юг'] : ['запад', 'восток'];
}

/** Сторона пролива для точки (px): 0, 1 или −1 — в самом проливе. */
export function sillSide(s: SillRec, x: number, y: number): -1 | 0 | 1 {
  const [x0, y0, x1, y1] = s.p;
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
  const d = (dx * (y - y0) - dy * (x - x0)) / L;
  // ось с запада на восток: отрицательное — север; с севера на юг — положительное у запада (сторона 0)
  const v = Math.abs(dx) >= Math.abs(dy) ? d * Math.sign(dx || 1) : -d * Math.sign(dy || 1);
  return Math.abs(d) < s.hw ? -1 : v < 0 ? 0 : 1;
}

// ---------------- 🧭 дрейф плит и дождевая тень (этап 3) ----------------

/** Клеточные поля, которые едут вместе с плитой (= SNAP_CELLS снимка; проверка — в snapshot.ts). */
export const PLATE_CELLS = ['grass', 'browse', 'forage', 'soil', 'litter', 'mic', 'fix', 'myc', 'act', 'nut'] as const satisfies readonly (keyof World)[];

/** Граница плит по умолчанию: середина пролива Уоллеса (или 0,775 высоты без него). */
export function plateRift(w: World): number {
  const s = w.geo?.sills.find((q) => q.kind === 'wallace');
  return s ? s.y0 + ((s.y1 - s.y0) >> 1) : Math.round(0.775 * w.terrain.rows);
}

/**
 * Шаг плиты B на (vx, vy) клеток: клеточные поля плиты (корм, почва, микробы, лёд, правки высоты, следы), звери, туши,
 * кости и все клеточные номера живой планеты (очередь правок, котловины, озёра, пожар, якоря проливов) — вместе с ней;
 * на освободившемся месте — дно разлома, у шва при надвиге — поднятие (в очередь). Пересчёт рельефа — сразу после.
 * Без случайностей. false — плита упёрлась (скорость сброшена, шага нет).
 */
let plateBuf: Uint8Array | null = null;
function driftStep(w: World): boolean {
  const W = w as unknown as GeoWorld;
  const g = w.geo!, p = g.plate!, t = w.terrain;
  const { cols, rows } = t, n = cols * rows, cell = w.cell;
  let dx = p.vx, dy = p.vy;
  p.next = w.tick + Math.round(GEO.DRIFT_T / g.speed);
  if (Math.abs(p.ox + dx) > GEO.PLATE_MAXX) dx = p.vx = 0;
  if (p.oy + dy < -GEO.PLATE_MAXN || p.oy + dy > GEO.PLATE_MAXS) dy = p.vy = 0;
  if (dx === 0 && dy === 0) {
    w.log('🧭 Плита упёрлась: дальше она не сдвинется', 'info', undefined, undefined, 'geo_plates');
    return false;
  }
  // плита B сейчас — прямоугольник рядов [rift + oy, rows + oy) × столбцов [ox, cols + ox) (обрезанный краем карты);
  // после шага — он же, сдвинутый на (dx, dy)
  const d = dx + dy * cols;
  if (!plateBuf || plateBuf.length !== 2 * n) plateBuf = new Uint8Array(2 * n);
  const inOld = plateBuf.subarray(0, n), inNew = plateBuf.subarray(n, 2 * n);
  const rect = (a: Uint8Array, ox: number, oy: number) => {
    a.fill(0);
    const y0 = Math.max(0, p.rift + oy), y1 = Math.min(rows, rows + oy), x0 = Math.max(0, ox), x1 = Math.min(cols, cols + ox);
    if (x1 > x0) for (let cy = y0; cy < y1; cy++) a.fill(1, cy * cols + x0, cy * cols + x1);
  };
  rect(inOld, p.ox, p.oy);
  rect(inNew, p.ox + dx, p.oy + dy);
  // плита — прямоугольник: ряд за рядом copyWithin (порядок рядов — чтобы источник читался до перезаписи)
  const ny0 = Math.max(0, p.rift + p.oy + dy), ny1 = Math.min(rows, rows + p.oy + dy);
  const nx0 = Math.max(0, p.ox + dx), nx1 = Math.min(cols, cols + p.ox + dx);
  const segs: number[] = []; // [куда, откуда, длина]
  if (nx1 > nx0)
    for (let k = 0; k < ny1 - ny0; k++) {
      const y = dy > 0 ? ny1 - 1 - k : ny0 + k;
      segs.push(y * cols + nx0, y * cols + nx0 - d, nx1 - nx0);
    }
  const gaps: number[] = []; // [начало, длина] клеток, откуда плита ушла
  for (let i = 0; i < n; ) {
    if (inOld[i] && !inNew[i]) {
      let j = i;
      while (j < n && inOld[j] && !inNew[j]) j++;
      gaps.push(i, j - i);
      i = j;
    } else i++;
  }
  type TA = Float32Array | Int32Array | Uint8Array | Int16Array;
  const move = (a: TA, o: number, gap: number | null) => {
    for (let k = 0; k < segs.length; k += 3) a.copyWithin(o + segs[k], o + segs[k + 1], o + segs[k + 1] + segs[k + 2]);
    if (gap !== null) for (let k = 0; k < gaps.length; k += 2) a.fill(gap, o + gaps[k], o + gaps[k] + gaps[k + 1]);
  };
  for (const k of PLATE_CELLS) move(w[k] as Float32Array, 0, null);
  move(W.claim, 0, 0);
  move(W.claimTick, 0, -10);
  move(w.ice!, 0, 0);
  move(w.iceMax!, 0, 0);
  move(w.elevD!, 0, 0);
  for (let pl = 0; pl < 4; pl++) move(w.fx8!, pl * n, 0);
  // клеточные номера: клетка плиты — со сдвигом; накрытая плитой клетка A — пропала (−1)
  const mv = (i: number) => (i < 0 || i >= n ? i : inOld[i] ? i + d : inNew[i] ? -1 : i);
  const pairs = (a: number[]) => {
    const out: number[] = [];
    for (let k = 0; k + 1 < a.length; k += 2) {
      const j = mv(a[k]);
      if (j >= 0) out.push(j, a[k + 1]);
    }
    return out;
  };
  g.pend = pairs(g.pend);
  g.fire = pairs(g.fire);
  g.kettleQ = g.kettleQ.map(mv).filter((i) => i >= 0);
  g.lakeSeeds = g.lakeSeeds.map(mv).filter((i) => i >= 0);
  g.sills = g.sills.map((s) => ({ ...s, cells: s.cells.map(mv).filter((i) => i >= 0), a: mv(s.a), b: mv(s.b) }));
  // звери, туши и кости на плите едут с ней
  const ix = (x: number, y: number) => clamp(Math.floor(y / cell), 0, rows - 1) * cols + clamp(Math.floor(x / cell), 0, cols - 1);
  const X = dx * cell, Y = dy * cell, wd = w.width - 0.5, ht = w.height - 0.5;
  let riders = 0;
  for (const c of w.creatures) {
    if (!c.alive || !inOld[ix(c.x, c.y)]) continue;
    c.x = clamp(c.x + X, 0.5, wd);
    c.y = clamp(c.y + Y, 0.5, ht);
    c.gx += X;
    c.gy += Y;
    c.cell = ix(c.x, c.y);
    riders++;
  }
  for (const k of w.corpses) {
    if (!inOld[k.idx]) continue;
    k.x = clamp(k.x + X, 0.5, wd);
    k.y = clamp(k.y + Y, 0.5, ht);
    k.idx = ix(k.x, k.y);
  }
  for (const b of w.boneMarks) {
    if (!inOld[ix(b.x, b.y)]) continue;
    b.x += X;
    b.y += Y;
  }
  p.ox += dx;
  p.oy += dy;
  p.steps++;
  rebuildIceList(w); // список клеток со льдом — производное: после сдвига льда (как при восстановлении снимка)
  g.shadow = true;
  // надвиг: поднятие у шва (первый ряд плиты B — s), в очередь, не выше гор + UPLIFT_TOP
  if (dy < 0) {
    const s = p.rift + p.oy;
    const sums = pendSum(g);
    const top = t.mountainLevel + GEO.UPLIFT_TOP, sea0 = t.seaLevel - g.seaQ;
    const ph0 = hash01(w.seed, 0x0c09) * 2 * Math.PI, ph1 = hash01(w.seed, 0x0c0a) * 2 * Math.PI;
    const prof: [number, number][] = [[-2, 0.5], [-1, 1], [0, 1], [1, 1], [2, 0.5]];
    for (const [ry, k] of prof) {
      const y = s + ry;
      if (y < 0 || y >= rows) continue;
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        // высота клетки на новом месте: у плиты B — та, что приехала, у A — своя
        const e = (inNew[i] ? t.elev[i - d] : t.elev[i]) + (sums.get(i) ?? 0) * 1e-4;
        // мнётся только материковая кора (суша, шельф, дно пролива); глубокий океан уходит под плиту без гор
        if (e < sea0 + GEO.UPLIFT_MIN) continue;
        // хребет неровный: пики и перевалы вдоль шва (гладкий «шум» по столбцу, фазы — от зерна)
        const f = 0.8 + 0.3 * Math.sin(x * 0.23 + ph0) + 0.15 * Math.sin(x * 0.61 + ph1);
        const v = Math.min(Math.round(GEO.UPLIFT * k * f), Math.round((top - e) * 1e4), 32767 - w.elevD![i] - (sums.get(i) ?? 0));
        if (v <= 0) continue;
        g.pend.push(i, v);
        sums.set(i, (sums.get(i) ?? 0) + v);
      }
    }
    pendSums.get(g.pend)!.n = g.pend.length;
  }
  const yc = (p.rift + p.oy) * cell, xc = w.width / 2;
  if (dy < 0 && !p.collided) {
    p.collided = true;
    w.log(`⛰ Плиты столкнулись: на шве растёт хребет ${p.name}`, 'milestone', xc, yc, 'geo_orogeny');
  } else if (dy > 0 && !p.rifted) {
    p.rifted = true;
    w.log('🌊 Плиты расходятся: между ними раскрывается разлом — новое океанское дно', 'info', xc, yc, 'geo_plates');
  }
  if (GEO_PERF.on) GEO_PERF.riders += riders;
  return true;
}

/** Летопись плит после пересчёта: хребет поднялся (горы на шве). */
function plateLog(w: World): void {
  const g = w.geo!, p = g.plate!, t = w.terrain;
  if (!p.collided || p.mtn) return;
  const s = p.rift + p.oy, cols = t.cols;
  let k = 0;
  for (let y = Math.max(0, s - 2); y <= Math.min(t.rows - 1, s + 2); y++)
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x, b = t.biome[i];
      // горы, которых не было: поднятие не меньше шага и без него клетка ниже гор
      if ((b === B.Mountain || b === B.Snow) && w.elevD![i] >= GEO.UPLIFT && t.elev[i] - w.elevD![i] * 1e-4 <= t.mountainLevel) k++;
    }
  if (k < 20) return;
  p.mtn = true;
  w.log(`⛰ Хребет ${p.name} поднялся: ${k} клеток гор там, где сходятся плиты`, 'milestone', w.width / 2, s * w.cell, 'geo_orogeny');
}

/** 🏜 Летопись дождевой тени: стало заметно больше суши, где влажность ниже исходной на 15 % и больше. */
function shadowLog(w: World): void {
  const g = w.geo!, t = w.terrain, K = t.moistK!;
  const n = K.length, reg = new Map<number, number>();
  let k = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    if (K[i] >= 0.85 || t.biome[i] <= B.Shallow) continue;
    k++;
    sum += 1 - K[i];
    const r = t.region[i];
    if (r >= 0) reg.set(r, (reg.get(r) ?? 0) + 1);
  }
  if (k < 40 || k < 1.5 * g.shadowN + 40) {
    if (k < g.shadowN / 2) g.shadowN = k;
    return;
  }
  g.shadowN = k;
  let best = -1, bn = 0;
  for (const [r, c] of reg) if (c > bn || (c === bn && r < best)) { bn = c; best = r; }
  const R = best >= 0 ? t.regions[best] : null;
  w.log(`🏜 За хребтом стало сухо${R ? `: «${R.name}»` : ''} — влажность ниже на ${Math.round((100 * sum) / k)}% (${k} клеток)`, 'info', R?.cx, R?.cy, 'geo_rainshadow');
}

/** Шаг плиты сейчас (стенд и урок): то же, что в проходе, без ожидания DRIFT_T. */
export const _driftStep = driftStep;

// ---------------- действия игрока (вкладка «Климат») ----------------

export type GeoAction =
  | { k: 'strait'; pts: number[]; deep: boolean }
  | { k: 'isthmus'; pts: number[] }
  | { k: 'co2'; ppm: number | null }
  | { k: 'iceAge'; mode: 'cycle' | 'now' | 'end' | 'off' }
  | { k: 'sea'; dm: number }
  | { k: 'geoSpeed'; v: 1 | 4 }
  | { k: 'ridge'; pts: number[] }
  | { k: 'drift'; vx: -1 | 0 | 1; vy: -1 | 0 | 1 };

/** Действия «Климата» живой планеты (без неё — ничего). */
export function geoAction(w: World, a: GeoAction): void {
  const g = w.geo;
  if (!w.lp || !g) return;
  switch (a.k) {
    case 'strait':
    case 'isthmus':
      lineTool(w, a.pts, a.k === 'strait' ? (a.deep ? 'deep' : 'shallow') : 'raise');
      break;
    case 'co2': {
      g.co2Pin = a.ppm === null ? null : clamp(Math.round(a.ppm), 100, 3000);
      if (g.co2Pin === null) w.log('🏭 CO₂ снова «как у природы»: следует за ледниками', 'player', undefined, undefined, 'geo_co2');
      else {
        const dC = co2Warm(g, g.co2Pin) * CLIMATE_C;
        w.log(`🏭 CO₂ теперь ${g.co2Pin} ppm → ${dC >= 0 ? '+' : '−'}${Math.abs(dC).toFixed(1).replace('.', ',')} °C к ${g.co2Base === 280 ? 'доиндустриальным 280' : `естественным для этой планеты ${g.co2Base}`} ppm (за год)`, 'player', undefined, undefined, 'geo_co2');
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
    case 'ridge':
      ridgeTool(w, a.pts);
      break;
    case 'drift': {
      const vx = clamp(Math.round(a.vx), -1, 1), vy = clamp(Math.round(a.vy), -1, 1);
      const p = (g.plate ??= { rift: plateRift(w), ox: 0, oy: 0, vx: 0, vy: 0, next: 0, collided: false, name: properName(mulberry32(w.seed ^ 0x0c09e)), mtn: false, rifted: false, steps: 0 });
      const was = p.vx !== 0 || p.vy !== 0;
      p.vx = vx;
      p.vy = vy;
      if (!was) p.next = w.tick + Math.round(GEO.DRIFT_T / g.speed);
      const dir = vy < 0 ? 'на север — навстречу северной' : vy > 0 ? 'на юг — прочь от северной' : vx < 0 ? 'на запад — вдоль разлома' : vx > 0 ? 'на восток — вдоль разлома' : '';
      w.log(dir ? `🧭 Южная плита поехала ${dir}${vx && vy ? (vx < 0 ? ' и на запад' : ' и на восток') : ''}: клетка за ${(GEO.DRIFT_T / g.speed / 6000).toFixed(2).replace('.', ',')} года` : '🧭 Плиты остановились', 'player', undefined, undefined, vy < 0 ? 'geo_orogeny' : 'geo_plates');
      break;
    }
    case 'geoSpeed':
      g.speed = a.v === 4 ? 4 : 1;
      w.log(g.speed === 4 ? '⏩ Геология ×4: орбита и ледники идут вчетверо быстрее, эволюция — нет' : '⏩ Геология ×1: ледниковый цикл — около 8 лет острова', 'player', undefined, undefined, 'geo_timescale');
      break;
  }
}

/** Клетки не дальше hw клеток от ломаной pts (px). */
function lineCells(w: World, pts: number[], hw: number): number[] {
  const t = w.terrain, cell = w.cell, R = hw * cell;
  const out = new Set<number>();
  for (let k = 0; k + 3 < pts.length || (k === 0 && pts.length >= 2); k += 2) {
    const ax = pts[k], ay = pts[k + 1], bx = pts[k + 2] ?? ax, by = pts[k + 3] ?? ay;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - R) / cell)), c1 = Math.min(t.cols - 1, Math.floor((Math.max(ax, bx) + R) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - R) / cell)), r1 = Math.min(t.rows - 1, Math.floor((Math.max(ay, by) + R) / cell));
    for (let cy = r0; cy <= r1; cy++)
      for (let cx = c0; cx <= c1; cx++) {
        const px = (cx + 0.5) * cell, py = (cy + 0.5) * cell;
        const u = L2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1) : 0;
        if (Math.hypot(px - (ax + u * dx), py - (ay + u * dy)) <= R) out.add(cy * t.cols + cx);
      }
    if (pts.length < 4) break;
  }
  return [...out].sort((a, b) => a - b);
}

/** Ближайшая клетка суши к точке (px) в радиусе 12 клеток (−1 — нет). */
function landNear(w: World, x: number, y: number): number {
  const t = w.terrain, cx = Math.floor(x / w.cell), cy = Math.floor(y / w.cell);
  let best = -1, bd = Infinity;
  for (let dy = -12; dy <= 12; dy++)
    for (let dx = -12; dx <= 12; dx++) {
      const xx = cx + dx, yy = cy + dy;
      if (xx < 0 || yy < 0 || xx >= t.cols || yy >= t.rows) continue;
      const i = yy * t.cols + xx;
      const d = dx * dx + dy * dy;
      if (t.biome[i] > B.Shallow && d < bd) {
        bd = d;
        best = i;
      }
    }
  return best;
}

/**
 * ✂️ Пролив (глубокий — как Уоллес, или мелкий — порог, что сохнет в ледниковье) и 🌉 перешеек вдоль линии игрока —
 * правками в очередь (рельеф пересчитается в начале следующего шага). Пролив становится порогом игрока: якоря — суша
 * по обе стороны от середины линии.
 */
function lineTool(w: World, pts: number[], mode: 'deep' | 'shallow' | 'raise'): void {
  const g = w.geo!, t = w.terrain, E = w.elevD!;
  if (pts.length < 2) return;
  const sea0 = t.seaLevel - g.seaQ;
  const cells = lineCells(w, pts, GEO.LINE_HW);
  const sums = pendSum(g);
  const target = mode === 'raise' ? sea0 + GEO.ISTHMUS_H : sea0 - (mode === 'deep' ? GEO.WALLACE : GEO.SILL);
  const carved: number[] = [];
  for (const i of cells) {
    const p = sums.get(i) ?? 0;
    const cur = t.elev[i] + p * 1e-4;
    if (mode === 'raise' ? cur >= target : cur <= target) continue;
    const dz = clamp(Math.round((target - cur) * 1e4), -32767 - E[i] - p, 32767 - E[i] - p);
    if (dz === 0) continue;
    g.pend.push(i, dz);
    carved.push(i);
  }
  const x0 = pts[0], y0 = pts[1], x1 = pts[pts.length - 2], y1 = pts[pts.length - 1];
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
  const where = t.regionAt(mx, my)?.name;
  if (mode === 'raise') {
    w.log(`🌉 Вы насыпали перешеек${where ? ` у «${where}»` : ''}: ${carved.length} клеток стали сушей`, 'player', mx, my, 'geo_gabi');
    return;
  }
  const off = (GEO.LINE_HW + 4) * w.cell;
  const r = mulberry32(w.seed ^ (carved[0] ?? 0) ^ 0x57a17);
  const name = properName(r);
  const ys = cells.map((i) => Math.floor(i / t.cols));
  const s: SillRec = {
    kind: 'player', cells: carved, name, open: true,
    a: landNear(w, mx + nx * off, my + ny * off),
    b: landNear(w, mx - nx * off, my - ny * off),
    y0: ys.length ? Math.min(...ys) : 0, y1: ys.length ? Math.max(...ys) + 1 : 0,
    p: [x0, y0, x1, y1], hw: GEO.LINE_HW * w.cell,
  };
  if (Math.abs(x1 - x0) >= 0.9 * t.cols * w.cell) {
    // во всю ширину (как «Берингия»): якоря — высочайшая суша в 25 рядах по обе стороны, как у порогов reset
    s.a = anchor(w, s.y0 - 25, s.y0);
    s.b = anchor(w, s.y1, s.y1 + 25);
  }
  // сторона 0 — север/запад: якорь a должен лежать на ней
  if (s.a >= 0 && sillSide(s, ((s.a % t.cols) + 0.5) * w.cell, (Math.floor(s.a / t.cols) + 0.5) * w.cell) === 1) [s.a, s.b] = [s.b, s.a];
  g.sills = [...g.sills, s];
  w.log(`✂️ Вы прорезали ${mode === 'deep' ? 'глубокий пролив' : 'мелкий пролив (в ледниковье осохнет)'} ${name}${where ? ` у «${where}»` : ''}`, 'player', mx, my, mode === 'deep' ? 'geo_wallace' : 'geo_landbridge');
}

/**
 * ⛰ Хребет вдоль линии игрока: суша поднимается до гор + RIDGE_H посередине (к краям — ниже) — правками в очередь;
 * со следующим пересчётом включается дождевая тень (западный ветер теряет пар на хребте, за ним — сухо).
 */
function ridgeTool(w: World, pts: number[]): void {
  const g = w.geo!, t = w.terrain, E = w.elevD!;
  if (pts.length < 2) return;
  const cells = lineCells(w, pts, GEO.RIDGE_HW);
  const sums = pendSum(g);
  const R = GEO.RIDGE_HW * w.cell;
  let k = 0;
  for (const i of cells) {
    const px = ((i % t.cols) + 0.5) * w.cell, py = (Math.floor(i / t.cols) + 0.5) * w.cell;
    const dd = segDist(pts, px, py) / R;
    const target = t.mountainLevel + GEO.RIDGE_H * (1 - 0.6 * dd * dd);
    const pv = sums.get(i) ?? 0;
    const cur = t.elev[i] + pv * 1e-4;
    if (cur >= target) continue;
    const dz = Math.min(Math.round((target - cur) * 1e4), 32767 - E[i] - pv);
    if (dz <= 0) continue;
    g.pend.push(i, dz);
    sums.set(i, pv + dz);
    k++;
  }
  pendSums.get(g.pend)!.n = g.pend.length;
  g.shadowQ = true;
  const mx = (pts[0] + pts[pts.length - 2]) / 2, my = (pts[1] + pts[pts.length - 1]) / 2;
  const where = t.regionAt(mx, my)?.name;
  w.log(`⛰ Вы подняли хребет${where ? ` у «${where}»` : ''}: ${k} клеток стали горами — ветер дует с запада, посмотрим, что станет за ним`, 'player', mx, my, 'geo_rainshadow');
}

/** Расстояние от точки до ломаной (px). */
function segDist(pts: number[], x: number, y: number): number {
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k += 2) {
    const ax = pts[k], ay = pts[k + 1], bx = pts[k + 2] ?? ax, by = pts[k + 3] ?? ay;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const u = L2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(x - (ax + u * dx), y - (ay + u * dy)));
    if (pts.length < 4) break;
  }
  return best;
}

/** 🗺 «Берингия»: самая узкая полоса суши на севере (y 0,15…0,35) — линия мелкого пролива во всю ширину (px). */
export function beringiaLine(w: World): number[] {
  const t = w.terrain;
  const y = thinBand(w, Math.floor(0.15 * t.rows), Math.ceil(0.35 * t.rows), 3) + 1.5;
  return [0, y * w.cell, t.cols * w.cell, y * w.cell];
}

/** 🌉 «Панама»: линия перешейка через пролив Уоллеса там, где суша по обе стороны ближе всего к середине острова (null — нет). */
export function panamaLine(w: World): number[] | null {
  const g = w.geo;
  const s = g?.sills.find((q) => q.kind === 'wallace');
  if (!g || !s || s.open) return null;
  const t = w.terrain, cols = t.cols;
  // суша материков якорей (иначе перешеек соединит не те берега и мост не откроется)
  const lm = w.lm;
  const la = lm && s.a >= 0 ? lm[s.a] : -1, lb = lm && s.b >= 0 ? lm[s.b] : -1;
  const landOf = (x: number, y: number, L: number) => y >= 0 && y < t.rows && t.biome[y * cols + x] > B.Shallow && (L < 0 || !lm || lm[y * cols + x] === L);
  let best = -1, bd = Infinity;
  for (let x = 2; x < cols - 2; x++) {
    let n = -1, so = -1;
    for (let k = 1; k <= 4 && n < 0; k++) if (landOf(x, s.y0 - k, la)) n = k;
    for (let k = 0; k < 4 && so < 0; k++) if (landOf(x, s.y1 + k, lb)) so = k;
    if (n < 0 || so < 0) continue;
    const d = Math.abs(x - cols / 2) + 8 * (n + so);
    if (d < bd) {
      bd = d;
      best = x;
    }
  }
  if (best < 0) return null;
  const x = (best + 0.5) * w.cell;
  return [x, (s.y0 - 4) * w.cell, x, (s.y1 + 4) * w.cell];
}

/** Выделить клеточные поля живой планеты (только при lp). */
export function allocGeoCells(w: World, n: number): void {
  w.ice = new Float32Array(n);
  w.iceMax = new Uint8Array(n);
  w.elevD = new Int16Array(n);
  w.fx8 = new Uint8Array(4 * n);
}
