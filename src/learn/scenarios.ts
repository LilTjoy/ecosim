/**
 * Чистые данные и расчёты для уроков (без DOM и без three.js):
 * их используют уроки, ссылки справочника и scripts/learn-check.ts.
 */
import { EARTH, luminosity0, PRESETS, simulate, type PlanetParams, type SimResult } from '../planet/model';
import type { Pathogen } from '../sim/microbes';
import type { World } from '../sim/world';
import { BIOMES } from '../sim/terrain';
import { sillSide } from '../sim/geo';

/** Орбита, на которой планета у звезды массы m получает `flux` земного тепла. */
export const orbitFor = (m: number, flux: number) => Math.sqrt(luminosity0(m) / 0.72 / flux);
/** Орбита у Солнца для заданного тепла. */
export const fluxOrbit = (f: number) => 1 / Math.sqrt(f);

export const MARS: PlanetParams = { ...EARTH, mass: 0.11, tectonics: null };
export const MARS_RD: PlanetParams = { ...MARS, starMass: 0.3, orbit: orbitFor(0.3, 1) };

/** Сценарий планеты для кнопки «▶ Посмотреть в симуляции». */
export interface PlanetLink {
  params?: Partial<PlanetParams>;
  /** id события, к которому перемотать (по умолчанию — ключ карточки). */
  event?: string;
  /** Часть текста события — когда у события несколько разных поводов. */
  match?: string;
  /** Момент, если события нет. */
  t?: number;
  /** Карточка не привязана к событию — просто открыть мир. */
  noEvent?: boolean;
}

const earthEvents = ['water', 'abiogenesis', 'photosynthesis', 'goe', 'o2modern', 'eukaryotes', 'multicellular', 'land', 'intelligence', 'technology', 'redgiant', 'impact500', 'impact100', 'impact10', 'volcano', 'extinction', 'thaw'];

export const PLANET_LINKS: Record<string, PlanetLink> = {
  ...Object.fromEntries(earthEvents.map((k) => [k, {}])),
  snowball: { params: { orbit: fluxOrbit(0.75) }, match: 'целиком', t: 1.29 },
  intelligence_sea: { params: { water: 10, seed: 8 } },
  supernova: { params: { seed: 3 } },
  flare: { params: { starMass: 0.45, orbit: orbitFor(0.45, 1), seed: 133 } },
  dynamo: { params: { mass: 0.11, tectonics: null } },
  atmoloss: { params: { mass: 0.11, tectonics: null } },
  carbonates: { params: { orbit: fluxOrbit(1.4) }, t: 4.27 },
  axis: { params: { moon: 0 } },
  co2starve: { params: { orbit: fluxOrbit(1.25) } },
  runaway: { params: { orbit: fluxOrbit(1.4) }, t: 4.26 },
  tectonics: { t: 0, noEvent: true },
  faintsun: { t: 0, noEvent: true },
};

export interface Guilds {
  herb: number;
  omni: number;
  carn: number;
  swim: number;
  giants: number;
  smallHerb: number;
  /** Самое крупное существо (без того, в кого вселился игрок). */
  max: number;
  /** Самое крупное среди родившихся в этом мире (основатели и пришельцы не в счёт). */
  maxBorn: number;
  n: number;
}

/** Гильдии по тому же правилу, что и scripts/bench.ts. Гигант — травоядное крупнее 8. */
export function guilds(w: World): Guilds {
  let herb = 0, omni = 0, carn = 0, swim = 0, giants = 0, max = 0, maxBorn = 0;
  for (const c of w.creatures) {
    if (!c.alive) continue;
    const g = c.g;
    if (!c.player) max = Math.max(max, g.size);
    if (!c.player && c.generation > 0) maxBorn = Math.max(maxBorn, g.size);
    if (g.swim > 0.6) swim++;
    else if (g.diet < 0.3) {
      herb++;
      if (g.size > 8 && !c.player) giants++;
    } else if (g.diet < 0.65) omni++;
    else carn++;
  }
  return { herb, omni, carn, swim, giants, smallHerb: herb - giants, max, maxBorn, n: herb + omni + carn + swim };
}

/** Потолок размера при 8% кислорода (World.maxSize при o2 = 0,08 и обычной гравитации) — 8,64. */
export const CAP8 = 14 * Math.sqrt(0.08 / 0.21);

/** Травоядные (не пловцы, не игрок) крупнее size: родившиеся при 8% O₂ не бывают крупнее CAP8. */
export function herbsOver(w: World, size: number): number {
  let n = 0;
  for (const c of w.creatures) if (c.alive && !c.player && c.g.swim <= 0.6 && c.g.diet < 0.3 && c.g.size > size + 0.01) n++;
  return n;
}

/**
 * Цель опыта Гаузе: гигантов хотя бы втрое меньше (крупные травоядные в этой модели неплохо живут и на траве).
 * Замер после того, как листва перестала отрастать уже внутри growGrass (зёрна 42, 7, 3, 1 × 2 прогона):
 * цель достигается за 4 000–8 000 тактов после опыта; порог «10% от исходного» за 12 000 тактов — не всегда.
 */
export const gauseGoal = (g0: number) => Math.max(2, g0 / 3);

/** Среднее по суше (каждая 4-я клетка) — для полей почвы и опада. */
export function landMean(w: World, arr: ArrayLike<number>): number {
  const b = w.terrain.biome;
  let s = 0, n = 0;
  for (let i = 0; i < arr.length; i += 4) {
    if (BIOMES[b[i]].water) continue;
    s += arr[i];
    n++;
  }
  return n ? s / n : 0;
}

/** Поля микромира: минеральное питание почвы и опад (по клеткам). */
export interface SoilFields {
  soil: ArrayLike<number>;
  litter: ArrayLike<number>;
}

/** null — почва выключена (старая модель: опад и плодородие не считаются). */
export function soilFields(w: World): SoilFields | null {
  return w.settings.soil ? { soil: w.soil, litter: w.litter } : null;
}

/** Переключатель опыта «без разложителей» (World.experiment; сбрасывается с каждым новым миром). */
export function decomposerSwitch(w: World): { noDecomposers: boolean } | null {
  return w.settings.soil ? w.experiment : null;
}

/** Включена ли модель болезней (SIR с иммунитетом, src/sim/microbes.ts) — без неё урок об эпидемии не работает. */
export function diseaseModel(w: World): boolean {
  return w.settings.disease;
}

/** Сколько больных сейчас (по последней записи истории, раз в 20 тактов). */
export function sickNow(w: World): number | null {
  const h = w.history.at(-1);
  return h ? h.sick : null;
}

/** Вспышка, начатая уроком (по id болезни): ещё идёт — в w.pathogens, закончилась — в архиве w.outbreaks. */
export function outbreakById(w: World, id: number): Pathogen | null {
  for (const P of w.pathogens.values()) if (P.id === id) return P;
  for (let i = w.outbreaks.length - 1; i >= 0; i--) if (w.outbreaks[i].id === id) return w.outbreaks[i];
  return null;
}

/** Больные этой болезнью сейчас (0 — вспышка закончилась). Обновляется раз в 20 тактов. */
export const outbreakSick = (P: Pathogen | null): number => (!P || P.ended !== null ? 0 : (P.curve.at(-1) ?? 0));

/** Урок «Как растёт эпидемия»: заразить самый многочисленный вид новой болезнью. Возвращает вспышку или null. */
export function startLessonEpidemic(w: World, run: () => void = () => w.epidemic()): { P: Pathogen; host: number; hostName: string; n0: number } | null {
  const top = w.species.living()[0];
  if (!top || !w.settings.disease) return null;
  const n0 = top.count;
  run(); // на странице — через машину времени (SurfaceView.act), в стенде — прямо
  const P = w.pathogens.get(top.id);
  return P ? { P, host: top.id, hostName: top.name, n0 } : null;
}

/** Итог опыта с «близнецами»: n миров с одинаковыми зёрнами случайности и одной разницей. */
export interface TwinStats {
  n: number;
  /** Сколько миров дошли до ступени ≥ k. */
  reached: number[];
  /** Сколько раз случилось каждое событие (по id). */
  events: Record<string, number>;
}

export const emptyTwin = (): TwinStats => ({ n: 0, reached: new Array(8).fill(0), events: {} });

export function addTwin(s: TwinStats, r: SimResult): void {
  s.n++;
  for (let k = 0; k <= r.maxStage && k < 8; k++) s.reached[k]++;
  for (const e of r.events) if (e.id) s.events[e.id] = (s.events[e.id] ?? 0) + 1;
}

/** Один мир опыта: зерно seed, базовые параметры + вариант. */
export function twinWorld(base: PlanetParams, variant: Partial<PlanetParams>, seed: number, preset: keyof typeof PRESETS): SimResult {
  return simulate({ ...base, ...variant, seed }, PRESETS[preset].a, false);
}

// ---------------- 🌋 урок «Ледниковый период» ----------------

/** Ледники и море живой планеты сейчас (null — мир без неё). */
export interface IceNow {
  /** Море от исходного уровня, м. */
  sea: number;
  /** Доля суши подо льдом. */
  ice: number;
  /** Сдвиг температуры острова (климат + геология), °C. */
  dT: number;
  co2: number;
  Vg: number;
  /** Мелкий порог посреди острова осушен — север и юг соединены. */
  bridge: boolean;
  /** Пролив Уоллеса на юге всё ещё разделяет (глубокий). */
  wallace: boolean;
  /** Самый южный ряд клеток суши со льдом толще 0,15 (−1 — льда нет). */
  iceRow: number;
}
export function iceNow(w: World): IceNow | null {
  const g = w.geo;
  if (!w.lp || !g || !w.ice) return null;
  const t = w.terrain, H = w.ice;
  let iceRow = -1;
  for (let i = H.length - 1; i >= 0; i--) if (H[i] > 0.15 && !BIOMES[t.biome[i]].water) { iceRow = Math.floor(i / t.cols); break; }
  return {
    sea: Math.round(g.seaQ * 3000),
    ice: g.iceLand,
    dT: ((g.geoShift + w.climate.shift) * 100) / 3,
    co2: g.co2,
    Vg: g.Vg,
    bridge: g.sills.some((s) => s.kind === 'sill' && s.open),
    wallace: g.sills.some((s) => s.kind === 'wallace' && !s.open),
    iceRow,
  };
}
/** Цели урока: перешеек открыт и Vg ≥ 0,4; пик — Vg ≥ 0,85 и льдом покрыто ≥ 15 % суши. */
export const iceBridgeOk = (s: IceNow | null) => !!s && s.Vg >= 0.4 && s.bridge;
export const icePeakOk = (s: IceNow | null) => !!s && s.Vg >= 0.85 && s.ice >= 0.15;
/** Клетка карты ≈ 16 км (1 единица мира ≈ 1 км). */
export const KM_PER_ROW = 16;

// ---------------- 🌋 уроки «Пролив рождает виды» и «Опыт „Панама“» ----------------

/** Половины видов и разделения сейчас (null — мир без живой планеты). */
export interface VicNow {
  /** Записей «половины вида по разные стороны пролива». */
  iso: number;
  /** Лидер: дальше всех «врозь». */
  best: { name: string; ga: number; d: number; leak: number; sill: string } | null;
  /** Видов, родившихся от викарианса, и утечек генов (переплыли — гены смешались). */
  splits: number;
  leaks: number;
}
export function vicNow(w: World): VicNow | null {
  const g = w.geo;
  if (!w.lp || !g) return null;
  let best: VicNow['best'] = null;
  for (const r of g.isolates) {
    const sp = w.species.all.get(r.sp);
    if (!sp || (best && best.ga >= r.ga)) continue;
    best = { name: sp.name, ga: r.ga, d: r.d, leak: r.leak, sill: g.sills[r.sill]?.name ?? '?' };
  }
  return { iso: g.isolates.length, best, splits: g.stats.vicariance, leaks: g.stats.leaks };
}

/** Фауны по обе стороны пролива Уоллеса: виды суши (≥ 5 особей) к северу, к югу и общие. */
export function wallaceFaunas(w: World): { north: number; south: number; shared: number; onlySouth: string[] } | null {
  const g = w.geo;
  const s = g?.sills.find((x) => x.kind === 'wallace');
  if (!w.lp || !g || !s) return null;
  const cnt = new Map<number, [number, number]>();
  for (const c of w.creatures) {
    if (!c.alive || c.g.swim > 0.6) continue;
    const sd = sillSide(s, c.x, c.y);
    if (sd < 0) continue;
    let v = cnt.get(c.sp);
    if (!v) cnt.set(c.sp, (v = [0, 0]));
    v[sd as 0 | 1]++;
  }
  let north = 0, south = 0, shared = 0;
  const onlySouth: string[] = [];
  for (const [id, v] of cnt) {
    const n = v[0] >= 5, so = v[1] >= 5;
    if (n) north++;
    if (so) south++;
    if (n && so) shared++;
    if (so && !n) onlySouth.push(w.species.all.get(id)?.name ?? '?');
  }
  return { north, south, shared, onlySouth };
}

/** Перешеек через пролив Уоллеса: открыт ли и что показал обмен. */
export interface PanamaNow {
  open: boolean;
  /** Тактов с открытия (−1 — моста ещё нет). */
  age: number;
  fromN: number;
  fromS: number;
  lost: number;
  cross: [number, number];
  reported: boolean;
}
export function panamaNow(w: World): PanamaNow | null {
  const g = w.geo;
  const si = g ? g.sills.findIndex((x) => x.kind === 'wallace') : -1;
  if (!w.lp || !g || si < 0) return null;
  const r = [...g.bridges].reverse().find((b) => b.sill === si) ?? null;
  const est = r ? r.invaders.filter((v) => v.t >= 0) : [];
  return {
    open: g.sills[si].open,
    age: r ? w.tick - r.open : -1,
    fromN: est.filter((v) => v.from === 0).length,
    fromS: est.filter((v) => v.from === 1).length,
    lost: r ? r.lost.length : 0,
    cross: r ? [r.cross[0], r.cross[1]] : [0, 0],
    reported: !!r?.reported,
  };
}

/** Зёрна уроков (подобраны стендом learn-check: викарианс и обмен там случаются за время урока). */
export const VIC_SEED = 7;
export const PANAMA_SEED = 42;
