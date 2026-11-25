/**
 * Чистые данные и расчёты для уроков (без DOM и без three.js):
 * их используют уроки, ссылки справочника и scripts/learn-check.ts.
 */
import { EARTH, luminosity0, PRESETS, simulate, type PlanetParams, type SimResult } from '../planet/model';
import type { World } from '../sim/world';
import { BIOMES } from '../sim/terrain';

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

/** Поля микромира (появятся вместе с микробами в почве). Проверяем «на лету», чтобы урок работал и до, и после. */
export interface SoilFields {
  soil: ArrayLike<number>;
  litter: ArrayLike<number>;
}

export function soilFields(w: World): SoilFields | null {
  const x = w as unknown as Partial<Record<'soil' | 'litter', unknown>>;
  const ok = (v: unknown): v is ArrayLike<number> => v instanceof Float32Array || v instanceof Float64Array;
  return ok(x.soil) && ok(x.litter) ? { soil: x.soil, litter: x.litter } : null;
}

/** Переключатель опыта «без разложителей», если мир его поддерживает. */
export function decomposerSwitch(w: World): { noDecomposers: boolean } | null {
  if (!('soil' in w.settings)) return null;
  const e = (w as unknown as { experiment?: unknown }).experiment;
  if (typeof e !== 'object' || e === null || !('noDecomposers' in e)) return null;
  const sw = e as { noDecomposers: unknown };
  return typeof sw.noDecomposers === 'boolean' ? (sw as { noDecomposers: boolean }) : null;
}

/** Есть ли новая модель болезней (волна, иммунитет) — без неё урок об эпидемии не работает. */
export function diseaseModel(w: World): boolean {
  return 'disease' in w.settings && w.settings.disease === true;
}

/** Сколько больных в последней записи истории (если мир это считает). */
export function sickNow(w: World): number | null {
  const h = w.history.at(-1) as unknown as Record<string, unknown> | undefined;
  return h && typeof h.sick === 'number' ? h.sick : null;
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
