// Микромир для интерфейса: «невидимые жители» острова — карточки во вкладке «Микромир».
import { B } from '../sim/terrain';
import type { World } from '../sim/world';
import type { Lens } from './renderer';

export interface Guild {
  icon: string;
  name: string;
  /** Кто это (примеры). */
  who: string;
  /** Что делает. */
  role: string;
  /** Какую линзу 🔬 включает «показать». */
  lens: Lens | null;
  /** Научная карточка «?». */
  fact: string;
  /** Короткая сводка по текущему миру. */
  metric(w: World): string;
  /** Показывать ли (термофилы — только если есть горячие источники). */
  show?(w: World): boolean;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const last = (w: World) => w.history[w.history.length - 1];

/** Число клеток болота (раз на мир). */
const swampCache = new WeakMap<object, number>();
function swamps(w: World): number {
  let n = swampCache.get(w.terrain);
  if (n === undefined) {
    n = 0;
    for (let i = 0; i < w.terrain.biome.length; i++) if (w.terrain.biome[i] === B.Swamp) n++;
    swampCache.set(w.terrain, n);
  }
  return n;
}

export const MICROBE_GUILDS: Guild[] = [
  {
    icon: '🍄', name: 'Разложители', who: 'бактерии и грибы', role: 'разбирают туши, помёт и опад',
    lens: 'microbes', fact: 'decomposers',
    metric: (w) => `микробов на суше ${pct(last(w)?.mic ?? 0)} · туш разложено ${w.micro.corpsesRecycled}`,
  },
  {
    icon: '🫘', name: 'Азотфиксаторы', who: 'клубеньковые бактерии, цианобактерии', role: 'берут азот из воздуха, первыми заселяют голую землю',
    lens: 'fert', fact: 'nitrogen',
    metric: (w) => `покрывают ${pct(last(w)?.fix ?? 0)} суши`,
  },
  {
    icon: '🕸', name: 'Микориза', who: 'грибница', role: 'кормит деревья в обмен на сахар',
    lens: null, fact: 'mycorrhiza',
    metric: (w) => `грибница в лесах и болотах ${pct(last(w)?.myc ?? 0)}`,
  },
  {
    icon: '🌊', name: 'Фитопланктон', who: 'водоросли, цианобактерии, динофлагелляты', role: 'основа морской жизни; ночью светятся',
    lens: 'plankton', fact: 'plankton',
    metric: (w) => `густота планктона ${pct(last(w)?.plankton ?? 0)}`,
  },
  {
    icon: '🐄', name: 'Кишечная микрофлора', who: 'бактерии и инфузории желудка', role: 'переваривает траву за зверя',
    lens: null, fact: 'gut',
    metric: (w) => {
      let n = 0;
      for (const s of w.species.living()) if (s.mean.diet < 0.3) n += s.count;
      return `хозяев: ${n}`;
    },
  },
  {
    icon: '🫧', name: 'Археи-метаногены', who: 'древние микробы без кислорода', role: 'живут в болотах и желудках, выделяют метан',
    lens: 'microbes', fact: 'methane',
    metric: (w) => {
      const n = swamps(w);
      return n ? `болот: ${n} клеток` : 'болот на острове нет — только в желудках';
    },
  },
  {
    icon: '☣️', name: 'Возбудители болезней', who: 'вирусы, бактерии, грибки', role: 'тормоз для перенаселения',
    lens: 'disease', fact: 'sir',
    metric: (w) => `активных болезней ${w.pathogens.size} · больных ${w.micro.sick}`,
  },
  {
    icon: '♨', name: 'Термофилы', who: 'бактерии и археи', role: 'живут в кипятке горячих источников',
    lens: null, fact: 'hotsprings',
    metric: (w) => `горячих источников: ${w.terrain.springs.length}`,
    show: (w) => w.terrain.springs.length > 0,
  },
];
