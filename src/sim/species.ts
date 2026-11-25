import { distance, GENE_KEYS, SPECIES_LIMIT, type GeneKey, type Genome } from './genome';
import { mulberry32, pick, type Rand } from '../lib/random';
import { P } from './modules';

export interface Species {
  id: number;
  name: string;
  latin: string;
  parent: number | null;
  /** Геном основателя — от него меряем, насколько вид «уплыл». */
  founder: Genome;
  hue: number;
  born: number;
  extinct: number | null;
  origin: string;
  count: number;
  peak: number;
  /** Регионы, где вид когда-либо жил. */
  regions: Set<number>;
  /** Средние гены живых особей. */
  mean: Record<GeneKey, number>;
  depth: number;
  /** Объявлен ли вид (набрал минимальную численность). */
  announced: boolean;
  /** Сейчас идёт эпидемия из-за тесноты. */
  crowded: boolean;
  /** Когда закончилась последняя вспышка болезни (передышка перед новой). */
  lastOutbreak: number;
  x: number;
  y: number;
  // ---- ♾️ открытая эволюция ----
  /** Корень линии: самый древний предок (основатель или пришелец). */
  root: number;
  /** Завезён игроком (наследуется дочерними видами): не считается открытием эволюции. */
  introduced: boolean;
  /** История облика для конвергенции: кольцо 40 × FORM_D (раз в 1000 тактов), такты и число записей. Только при oe. */
  formHist: Float32Array | null;
  formT: Int32Array | null;
  formN: number;
  /** Умения (рецепты, которые есть у ≥ 15% особей). */
  abil: Set<string>;
  /** Средний фенотип живых особей (только при oe) и средние внешность и форма. */
  mph: Float32Array | null;
  mhue: number;
  mpat: number;
  mshape: number;
}

const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];

/** Имя по телу (♾️): кости тратятся так же, как без него — имя не меняет ход мира. */
function noun(g: Genome, rand: Rand, oe: boolean): [string, string] {
  const base = baseNoun(g, rand);
  if (oe) {
    // ♾️ тело важнее генов: сначала самые заметные органы (с набором ни одно условие не выполняется)
    const p = g.ph;
    if (p[P.FLY] >= 1) return ['Летун', 'Volucer'];
    if (p[P.FLY] >= 0.45) return ['Планер', 'Planator'];
    if (p[P.SHELL] >= 0.6) return ['Панцирник', 'Testudo'];
    if (p[P.DIG] >= 0.5 && g.size < 5) return ['Землерой', 'Fossor'];
    if (p[P.LEGS] === 0 && g.swim < 0.5) return ['Ползун', 'Serpens'];
    if (p[P.LEGS] >= 4) return ['Многоног', 'Myriapus'];
    if (p[P.CLAW] >= 0.5) return ['Клешнец', 'Chelifer'];
    if (p[P.HORN] >= 0.5 && g.diet >= 0.3) return ['Рогоносец', 'Ceratophorus'];
  }
  return base;
}

function baseNoun(g: Genome, rand: Rand): [string, string] {
  if (g.swim > 0.65) return pick([['Плавун', 'Natator'], ['Ныряльщик', 'Mergus'], ['Водолюб', 'Hydrophilus']] as const, rand);
  if (g.diet < 0.3) {
    if (g.size < 3) return pick([['Прыгун', 'Saltator'], ['Шуршун', 'Susurrus'], ['Грызун', 'Rodens']] as const, rand);
    if (g.size < 7) return pick([['Травоед', 'Herbivorus'], ['Жвачник', 'Ruminans'], ['Пасун', 'Pastor']] as const, rand);
    return pick([['Рогач', 'Cornutus'], ['Толстокож', 'Pachyderm'], ['Великан', 'Gigas']] as const, rand);
  }
  if (g.diet < 0.65) {
    if (g.social > 0.6) return ['Падальщик', 'Necrophagus'];
    return pick([['Всеед', 'Omnivorax'], ['Кабанчик', 'Suillus'], ['Рылец', 'Rostratus']] as const, rand);
  }
  if (g.size < 4) return pick([['Хорёк', 'Mustela'], ['Кусач', 'Mordax']] as const, rand);
  if (g.size < 9) return pick([['Клыкач', 'Dentifer'], ['Охотник', 'Venator'], ['Ловчий', 'Captor']] as const, rand);
  return pick([['Тиран', 'Tyrannus'], ['Зверь', 'Bestia']] as const, rand);
}

function adjective(g: Genome, rand: Rand, oe: boolean): [string, string] {
  const options: [string, string][] = [];
  const p = g.ph;
  if (g.tempPref < 0.28) options.push(['Снежный', 'nivalis'], ['Северный', 'borealis']);
  if (g.tempPref > 0.72) options.push(['Пустынный', 'deserti'], ['Знойный', 'aestivus']);
  if (g.speed > 3) options.push(['Быстрый', 'velox']);
  if (g.social > 0.7) options.push(g.diet > 0.5 ? ['Стайный', 'gregarius'] : ['Стадный', 'gregalis']);
  if (g.sense > 150 && (!oe || p[P.EYE] >= 0.6)) options.push(['Зоркий', 'oculatus']);
  if (g.size < 2.5) options.push(['Крошечный', 'minimus']);
  if (g.size > 10) options.push(['Огромный', 'maximus']);
  if (g.pattern > 0.75) options.push(['Полосатый', 'striatus']);
  if (g.pattern < 0.2) options.push(['Пятнистый', 'maculatus']);
  if (oe) {
    if (p[P.PHOTO] >= 0.4) options.push(['Светящийся', 'lucidus']);
    if (p[P.TOXIN] >= 0.4) options.push(['Ядовитый', 'venenosus']);
    if (p[P.EYEQ] === 0) options.push(['Слепой', 'caecus']);
    if (p[P.ENDO] < 0.3) options.push(['Холоднокровный', 'frigidus']);
    if (Math.min(p[P.EAR], p[P.VOICE]) >= 0.4) options.push(['Щелкун', 'sonans']);
    if (p[P.FUR] >= 0.6) options.push(['Мохнатый', 'villosus']);
    if (p[P.DIG] >= 0.5) options.push(['Роющий', 'fossorius']);
    if (p[P.HORN] >= 0.5) options.push(['Рогатый', 'cornutus']);
  }
  const h = g.hue;
  const color: [string, string] =
    h < 20 || h >= 340 ? ['Красный', 'ruber'] :
    h < 45 ? ['Рыжий', 'rufus'] :
    h < 70 ? ['Золотой', 'aureus'] :
    h < 160 ? ['Зелёный', 'viridis'] :
    h < 200 ? ['Бирюзовый', 'cyaneus'] :
    h < 250 ? ['Синий', 'caeruleus'] :
    h < 300 ? ['Фиолетовый', 'violaceus'] : ['Розовый', 'roseus'];
  options.push(color);
  return pick(options, rand);
}

/** Сохранённый реестр (живые ссылки — вызывающий клонирует, см. snapshot.ts). */
export interface SpeciesSave {
  all: [number, Species][];
  nextId: number;
  names: [string, number][];
  /** ♾️ Вес тела в расстоянии (0 — без открытой эволюции). */
  bodyW?: number;
  oe?: boolean;
}

export class SpeciesRegistry {
  all = new Map<number, Species>();
  private nextId = 1;
  private names = new Map<string, number>();
  /** Поток случайных чисел для имён: мир подставляет свой (имя берётся из «костей» того, кто родил вид). */
  rand: Rand = mulberry32(1);
  /** ♾️ Вес тела в генетическом расстоянии: мир ставит EVO.BODY_W при открытой эволюции, иначе 0. */
  bodyW = 0;
  /** ♾️ Открытая эволюция: имена по органам тела. */
  oe = false;

  get peekNextId(): number {
    return this.nextId;
  }

  /** ЖИВЫЕ ссылки — вызывающий обязан клонировать (одним structuredClone вместе с остальным). */
  save(): SpeciesSave {
    return { all: [...this.all], nextId: this.nextId, names: [...this.names], bodyW: this.bodyW, oe: this.oe };
  }

  load(s: SpeciesSave): void {
    this.all = new Map(s.all);
    this.nextId = s.nextId;
    this.names = new Map(s.names);
    this.bodyW = s.bodyW ?? 0;
    this.oe = s.oe ?? false;
    // старые снимки (закладки) — без полей открытой эволюции
    for (const sp of this.all.values()) {
      if (sp.abil) continue;
      sp.introduced = false;
      sp.formHist = sp.formT = sp.mph = null;
      sp.formN = 0;
      sp.abil = new Set();
      sp.mhue = sp.hue;
      sp.mpat = sp.founder.pattern;
      sp.mshape = sp.founder.body?.shape ?? 0.5;
    }
    for (const sp of this.all.values()) if (sp.root === undefined) sp.root = this.rootOf(sp);
  }

  /** Корень линии по цепочке родителей. */
  private rootOf(sp: Species): number {
    let s = sp;
    for (let i = 0; i < 10000 && s.parent !== null; i++) {
      const p = this.all.get(s.parent);
      if (!p) break;
      s = p;
    }
    return s.id;
  }

  clear(): void {
    this.all.clear();
    this.names.clear();
    this.nextId = 1;
  }

  create(founder: Genome, parent: number | null, tick: number, origin: string, introduced = false): Species {
    const [n, genus] = noun(founder, this.rand, this.oe);
    const [a, epithet] = adjective(founder, this.rand, this.oe);
    const id = this.nextId++;
    const par = parent ? this.all.get(parent) : undefined;
    const base = `${a} ${n.toLowerCase()}`;
    const k = this.names.get(base) ?? 0;
    this.names.set(base, k + 1);
    const sp: Species = {
      id,
      name: base + (ROMAN[k] ?? ` ${k + 1}`),
      latin: `${genus} ${epithet}`,
      parent,
      founder: { ...founder, brain: null },
      hue: founder.hue,
      born: tick,
      extinct: null,
      origin,
      count: 0,
      peak: 0,
      regions: new Set(),
      mean: Object.fromEntries(GENE_KEYS.map((k) => [k, founder[k]])) as Record<GeneKey, number>,
      depth: parent ? (this.all.get(parent)?.depth ?? 0) + 1 : 0,
      announced: false,
      crowded: false,
      lastOutbreak: -1e9,
      x: 0,
      y: 0,
      root: par ? par.root : id,
      introduced: par ? par.introduced : introduced,
      formHist: null,
      formT: null,
      formN: 0,
      abil: new Set(),
      mph: null,
      mhue: founder.hue,
      mpat: founder.pattern,
      mshape: founder.body.shape,
    };
    this.all.set(sp.id, sp);
    return sp;
  }

  /**
   * Определить вид новорождённого. Если он слишком далеко ушёл от основателя
   * своего вида — это новый вид.
   */
  classify(g: Genome, parents: number[], tick: number, origin: string): { species: Species; isNew: boolean } {
    let best: Species | null = null;
    let bestD = Infinity;
    for (const id of parents) {
      const sp = this.all.get(id);
      if (!sp) continue;
      const d = distance(g, sp.founder, this.bodyW);
      if (d < bestD) {
        bestD = d;
        best = sp;
      }
    }
    if (best && bestD < SPECIES_LIMIT) return { species: best, isNew: false };
    // Может, «сёстры» уже откололись в ту же сторону — тогда присоединяемся к их виду,
    // а не плодим по виду на каждую особь.
    for (const sp of this.all.values()) {
      if (sp.extinct !== null || sp.parent !== best?.id) continue;
      if (distance(g, sp.founder, this.bodyW) < SPECIES_LIMIT * 0.75) return { species: sp, isNew: false };
    }
    return { species: this.create(g, best?.id ?? null, tick, origin), isNew: true };
  }

  /** Подобрать существующий вид для «чужака» (кнопка добавить) или создать новый. Завезённые игроком — всегда новый вид. */
  match(g: Genome, tick: number, origin: string, introduced = false): Species {
    if (introduced) return this.create(g, null, tick, origin, true);
    let best: Species | null = null;
    let bestD = SPECIES_LIMIT * 0.5;
    for (const sp of this.all.values()) {
      if (sp.extinct !== null) continue;
      const d = distance(g, sp.founder, this.bodyW);
      if (d < bestD) {
        bestD = d;
        best = sp;
      }
    }
    return best ?? this.create(g, null, tick, origin);
  }

  living(): Species[] {
    return [...this.all.values()].filter((s) => s.extinct === null).sort((a, b) => b.count - a.count);
  }
}
