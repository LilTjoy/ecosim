import { distance, GENE_KEYS, SPECIES_LIMIT, type GeneKey, type Genome } from './genome';
import { pick } from '../lib/random';

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
  x: number;
  y: number;
}

const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];

function noun(g: Genome): [string, string] {
  if (g.swim > 0.65) return pick([['Плавун', 'Natator'], ['Ныряльщик', 'Mergus'], ['Водолюб', 'Hydrophilus']] as const);
  if (g.diet < 0.3) {
    if (g.size < 3) return pick([['Прыгун', 'Saltator'], ['Шуршун', 'Susurrus'], ['Грызун', 'Rodens']] as const);
    if (g.size < 7) return pick([['Травоед', 'Herbivorus'], ['Жвачник', 'Ruminans'], ['Пасун', 'Pastor']] as const);
    return pick([['Рогач', 'Cornutus'], ['Толстокож', 'Pachyderm'], ['Великан', 'Gigas']] as const);
  }
  if (g.diet < 0.65) {
    if (g.social > 0.6) return ['Падальщик', 'Necrophagus'];
    return pick([['Всеед', 'Omnivorax'], ['Кабанчик', 'Suillus'], ['Рылец', 'Rostratus']] as const);
  }
  if (g.size < 4) return pick([['Хорёк', 'Mustela'], ['Кусач', 'Mordax']] as const);
  if (g.size < 9) return pick([['Клыкач', 'Dentifer'], ['Охотник', 'Venator'], ['Ловчий', 'Captor']] as const);
  return pick([['Тиран', 'Tyrannus'], ['Зверь', 'Bestia']] as const);
}

function adjective(g: Genome): [string, string] {
  const options: [string, string][] = [];
  if (g.tempPref < 0.28) options.push(['Снежный', 'nivalis'], ['Северный', 'borealis']);
  if (g.tempPref > 0.72) options.push(['Пустынный', 'deserti'], ['Знойный', 'aestivus']);
  if (g.speed > 3) options.push(['Быстрый', 'velox']);
  if (g.social > 0.7) options.push(g.diet > 0.5 ? ['Стайный', 'gregarius'] : ['Стадный', 'gregalis']);
  if (g.sense > 150) options.push(['Зоркий', 'oculatus']);
  if (g.size < 2.5) options.push(['Крошечный', 'minimus']);
  if (g.size > 10) options.push(['Огромный', 'maximus']);
  if (g.pattern > 0.75) options.push(['Полосатый', 'striatus']);
  if (g.pattern < 0.2) options.push(['Пятнистый', 'maculatus']);
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
  return pick(options);
}

export class SpeciesRegistry {
  all = new Map<number, Species>();
  private nextId = 1;
  private names = new Map<string, number>();

  clear(): void {
    this.all.clear();
    this.names.clear();
    this.nextId = 1;
  }

  create(founder: Genome, parent: number | null, tick: number, origin: string): Species {
    const [n, genus] = noun(founder);
    const [a, epithet] = adjective(founder);
    const base = `${a} ${n.toLowerCase()}`;
    const k = this.names.get(base) ?? 0;
    this.names.set(base, k + 1);
    const sp: Species = {
      id: this.nextId++,
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
      x: 0,
      y: 0,
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
      const d = distance(g, sp.founder);
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
      if (distance(g, sp.founder) < SPECIES_LIMIT * 0.75) return { species: sp, isNew: false };
    }
    return { species: this.create(g, best?.id ?? null, tick, origin), isNew: true };
  }

  /** Подобрать существующий вид для «чужака» (кнопка добавить) или создать новый. */
  match(g: Genome, tick: number, origin: string): Species {
    let best: Species | null = null;
    let bestD = SPECIES_LIMIT * 0.5;
    for (const sp of this.all.values()) {
      if (sp.extinct !== null) continue;
      const d = distance(g, sp.founder);
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
