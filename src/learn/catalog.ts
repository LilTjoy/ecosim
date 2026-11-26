import * as planetFacts from '../planet/facts';
import type { Fact, Field } from '../planet/facts';
import type { PlanetParams } from '../planet/model';
import type { GeneKey } from '../sim/genome';
import type { SurfaceEnv } from '../sim/world';
import * as surfaceFacts from '../surface/facts';
import * as compareFacts from '../compare/compareFacts';
import { EXTRA_FACTS } from './extraFacts';
import { LESSONS } from './lessons';
import { PLANET_LINKS } from './scenarios';

export type CardSource = 'planet' | 'compare' | 'surface' | 'microbes' | 'island' | 'geo' | 'stats';

export const SOURCE_LABEL: Record<CardSource, string> = {
  planet: '🪐 Планета',
  compare: '🌍 Сравнение миров',
  surface: '🦊 Жизнь на поверхности',
  microbes: '🦠 Микромир',
  island: '🗺️ Устройство мира',
  geo: '🌋 Живая планета',
  stats: '🎲 Методы науки',
};

/** Карточки микромира живут в SURFACE_FACTS — отбираем их по ключу (если они уже есть). */
export const MICRO_KEYS = ['decomposers', 'carcass', 'q10', 'peat', 'methane', 'nitrogen', 'liebig', 'dung', 'plankton', 'bloom',
  'biolum', 'mycorrhiza', 'fairyring', 'gut', 'sir', 'r0', 'virulence', 'rinderpest', 'stromatolites', 'o2decay', 'hotsprings'];
export const ISLAND_KEYS = ['rivers', 'soils', 'permafrost', 'succession'];

export const FIELD_ORDER: Field[] = ['Астрономия', 'Физика', 'Химия', 'Геология', 'Климат', 'Биология', 'Вероятность'];

export type EcoTab = 'species' | 'tree' | 'web' | 'charts' | 'log' | 'micro' | 'discover' | 'time';

export type SimLink =
  | { view: 'planet'; params?: Partial<PlanetParams>; event?: string; match?: string; t?: number; label?: string }
  | { view: 'eco'; env?: Partial<SurfaceEnv>; envName?: string; tab?: EcoTab; gene?: GeneKey; label?: string }
  | { view: 'mc'; label?: string }
  | { view: 'drake'; label?: string }
  | { view: 'compare'; label?: string }
  | { view: 'lesson'; id: string; label?: string };

export interface Card extends Fact {
  /** Карточки «Сравнения миров»: строка значений Земля | Марс | Венера. */
  valLabel?: string;
  vals?: [string, string, string];
  id: string;
  key: string;
  source: CardSource;
  link?: SimLink;
  lessons: string[];
}

const GENES = ['size', 'speed', 'sense', 'diet', 'tempPref', 'swim', 'social', 'generosity'];

function surfaceLink(key: string, source: CardSource): SimLink | undefined {
  // 🌋 карточки живой планеты — к уроку о ледниках
  if (source === 'geo') return { view: 'lesson', id: 'ice', label: '❄️ Урок «Ледниковый период»' };
  if (source !== 'surface') {
    if (key === 'o2decay') return { view: 'eco', env: { o2: 0.08 }, envName: 'Мир с O₂ 8%', tab: 'micro', label: '▶ Новый мир: O₂ 8%' };
    if (key === 'stromatolites') return { view: 'eco', env: { landLife: false }, envName: 'Мир до выхода на сушу', tab: 'micro', label: '▶ Новый мир: до выхода на сушу' };
    return { view: 'eco', tab: 'micro' };
  }
  if (['niche', 'rest', 'refuge', 'parthenogenesis'].includes(key)) return { view: 'eco', tab: 'species' };
  if (['species', 'extinct'].includes(key)) return { view: 'eco', tab: 'tree' };
  if (['migration', 'disease'].includes(key)) return { view: 'eco', tab: 'log' };
  if (key === 'cycle') return { view: 'eco', tab: 'charts' };
  if (GENES.includes(key)) return { view: 'eco', tab: 'charts', gene: key as GeneKey };
  if (key === 'browse') return { view: 'eco', tab: 'web' };
  if (key.startsWith('tm_')) return { view: 'eco', tab: 'time', label: '▶ Открыть «⏳ Ветки»' };
  if (key === 'oxygen') return { view: 'eco', env: { o2: 0.08 }, envName: 'Мир с O₂ 8%', label: '▶ Новый мир: O₂ 8%' };
  return { view: 'eco' };
}

const STATS_LINKS: Record<string, SimLink> = {
  montecarlo: { view: 'mc', label: '▶ Открыть «10 000 миров»' },
  confidence: { view: 'mc', label: '▶ Открыть «10 000 миров»' },
  experiment: { view: 'lesson', id: 'moon', label: '🧪 Опыт с близнецами' },
};

/** Уроки, которые стоит предложить у карточки, кроме тех, что перечислены в самих уроках. */
const EXTRA_LESSONS: Record<string, string[]> = {
  'microbes.dung': ['microbes'],
};

const isFact = (x: unknown): x is Fact =>
  typeof x === 'object' && x !== null && typeof (x as Fact).title === 'string' && typeof (x as Fact).text === 'string' && typeof (x as Fact).field === 'string';

/** Все таблицы карточек, экспортированные модулем (новые появятся сами). */
function factTables(mod: Record<string, unknown>): Record<string, Fact>[] {
  return Object.values(mod).filter(
    (v): v is Record<string, Fact> => typeof v === 'object' && v !== null && Object.values(v).length > 0 && Object.values(v).every(isFact),
  );
}

let memo: Card[] | null = null;

export function allCards(): Card[] {
  if (memo) return memo;
  const out: Card[] = [];
  const seen = new Set<string>();
  const add = (key: string, f: Fact, source: CardSource, link?: SimLink) => {
    const id = `${source}.${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ ...f, id, key, source, link, lessons: [] });
  };
  for (const t of factTables(planetFacts as unknown as Record<string, unknown>))
    for (const [k, f] of Object.entries(t)) {
      const l = PLANET_LINKS[k];
      add(k, f, 'planet', l ? { view: 'planet', params: l.params, event: l.noEvent ? '-' : l.event, match: l.match, t: l.t } : { view: 'planet' });
    }
  // «Почему они такие разные» (Земля, Марс, Венера): карточки открываются во вкладке сравнения
  for (const t of factTables(compareFacts as unknown as Record<string, unknown>))
    for (const [k, f] of Object.entries(t)) add(k, f, 'compare', { view: 'compare', label: '▶ Открыть в «Сравнении миров»' });
  for (const t of factTables(surfaceFacts as unknown as Record<string, unknown>))
    for (const [k, f] of Object.entries(t)) {
      const src: CardSource = MICRO_KEYS.includes(k) ? 'microbes' : ISLAND_KEYS.includes(k) ? 'island' : k.startsWith('geo_') ? 'geo' : 'surface';
      add(k, f, src, surfaceLink(k, src));
    }
  for (const [k, f] of Object.entries(EXTRA_FACTS)) add(k, f, 'stats', STATS_LINKS[k]);
  const byId = new Map(out.map((c) => [c.id, c]));
  for (const L of LESSONS) for (const id of L.cards) byId.get(id)?.lessons.push(L.id);
  for (const [id, ls] of Object.entries(EXTRA_LESSONS)) {
    const c = byId.get(id);
    if (c) for (const l of ls) if (!c.lessons.includes(l)) c.lessons.push(l);
  }
  memo = out;
  return out;
}

export function cardById(id: string): Card | undefined {
  return allCards().find((c) => c.id === id);
}

/** Карточка, которую показал вид (для поверхности — с учётом микромира и устройства мира). */
export function cardFor(source: 'planet' | 'surface' | 'compare', key: string): Card | undefined {
  return allCards().find(
    (c) =>
      c.key === key &&
      (source === 'planet' ? c.source === 'planet' : source === 'compare' ? c.source === 'compare' || c.source === 'planet' : c.source === 'surface' || c.source === 'microbes' || c.source === 'island' || c.source === 'geo'),
  );
}
