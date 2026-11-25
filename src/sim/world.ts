import { HID, IN, OUT, think as runBrain } from './brain';
import { crossover, distance, genome, GENE_KEYS, MATE_LIMIT, mutate, type GeneKey, type Genome } from './genome';
import { clamp, mix32 } from '../lib/random';
import { SpeciesRegistry, type Species } from './species';
import { B, BIOMES, Terrain } from './terrain';
import { pathogenName, type Pathogen } from './microbes';
import { captureWorld, loadWorld, type WorldInternals, type WorldSnap } from './snapshot';
import type { Action } from './timeline';

/**
 * Активность микробов от температуры (Q10 = 2): удвоение каждые 0.125 ед. (= 10 °C при 80 °C/ед.),
 * 1.0 при T = 0.5 (≈15 °C), потолок 3 (≈31 °C, оптимум ферментов). Мороз 0.05..0.25 — плавный разгон.
 */
const Q10T = new Float32Array(128);
for (let k = 0; k < 128; k++) {
  const T = k / 127;
  Q10T[k] = T < 0.05 ? 0 : Math.min(3, Math.pow(2, (T - 0.5) / 0.125)) * Math.min(1, (T - 0.05) * 5);
}
/**
 * Почва: разложение, выветривание, вымывание, усвоение, отмирание травы, туши → опад, навоз, потолки;
 * TAU — время сглаживания нормировки плодородия (тактов).
 * UN = 0.15 (а не 0.25): иначе под стадами луга истощаются так, что четверть суши упирается в границы множителя.
 * SG = 0: опад от старения — это отмирающие корни (питание из почвы), надземный корм не убывает;
 * со SG = 1 стада гигантов заметно уступали мелким травоядным (стенд, 32 прогона).
 * DUNG = 0.95: навоз возвращает почти всё, что растение взяло из почвы (5% остаётся в теле → в тушу);
 * листва деревьев навоза не даёт (её рост почву не тратит), ягоды — полдоли, как и берут. Навоз ≤ усвоения.
 */
export const SOIL = { KD: 4.6e-4, KR: 1 / 6000, KL: 2e-5, UN: 0.15, KS: 2e-4, CN: 9e-4, DUNG: 0.95, SMAX: 2.5, LMAX: 6, TAU: 3000, SG: 0 };
/** Границы множителя роста от плодородия (суша, вода; суженные — запасная ручка №1) и множителя скорости разложения туш. */
export const NUT_CLAMP: { land: [number, number]; water: [number, number]; corpse: [number, number] } = { land: [0.75, 1.2], water: [0.7, 1.25], corpse: [0.5, 1.8] };

/**
 * Болезни: заражение β·(сумма β больных соседей), иммунитет после болезни, перелив в новый вид, лихорадка,
 * материнские антитела, мутация вирулентности при передаче; инструмент «эпидемия» (доля, вирулентность,
 * повышенный риск на время волны); потолок риска для больного.
 * SPILL = 2e-6 (а не 5e-7): иначе за 30 тыс. тактов объявлялось всего 1–2 вспышки (многие глохнут, R < 1).
 * BOOST_RISK = 0.003 (а не 0.0012): самый многочисленный вид обычно всеядный и живёт врозь (≈1 сородич рядом),
 * волна почти не идёт дальше заражённых инструментом — при 0.0012 погибало лишь 4–7% вида.
 */
export const DIS = { BETA: 0.0035, IMM: 3000, IMM_VAR: 2000, SPILL: 2e-6, SPILL_MIN_N: 40, COOLDOWN: 1500,
  FEVER: 0.04, MAT_IMM: 600, MUT: 0.08 /* ×(r1+r2+r3−1.5) → σ≈0.04 */, TOOL_SHARE: 0.12, TOOL_VIR: 0.85,
  BOOST_RISK: 0.003, BOOST_T: 1500, RISK_CAP: 0.01 };
/** Длительность болезни: мягкие штаммы болеют дольше (компромисс «заразность — вирулентность»). */
const DUR = (v: number) => Math.round(220 + 160 * (1 - v));

export type State = 'wander' | 'graze' | 'flee' | 'hunt' | 'mate' | 'scavenge' | 'migrate' | 'herd' | 'swim' | 'rest';

export interface Creature {
  id: number;
  sp: number;
  g: Genome;
  x: number;
  y: number;
  heading: number;
  /** Скорость на прошлом тике — для анимации лап. */
  v: number;
  energy: number;
  age: number;
  generation: number;
  mother: number | null;
  father: number | null;
  children: number;
  kills: number;
  alive: boolean;
  state: State;
  cooldown: number;
  /** Пауза после неудачной атаки. */
  cooldownHunt: number;
  /** Кэш признаков, зависящих только от генов. */
  pv: number;
  reachK: number;
  fe: number;
  /** Запомненное место с кормом и до какого такта мы туда идём. */
  gx: number;
  gy: number;
  gt: number;
  lonely: number;
  /** Сколько сородичей рядом (для охоты стаей). */
  pack: number;
  /** Тиков до конца тревоги. */
  alarm: number;
  activations: Float32Array | null;
  player: boolean;
  cause: string | null;
  /** Навоз в кишечнике — выпадает раз в 32 такта. */
  dung: number;
  /** Тактов болезни осталось (0 — здоров), тактов иммунитета, вирулентность штамма и заразность. */
  sick: number;
  immune: number;
  vir: number;
  beta: number;
  /** Личные «кости» (mulberry32): последствия вмешательства расходятся волной, а не меняют весь мир сразу. */
  rs: number;
  /** Фаза выпадения навоза (0..31, со дня рождения): раз в 32 такта, но у каждого в свой такт. */
  dph: number;
}

/** Всё, из чего собирается особь (обязательное — кто, где; остальное — по умолчанию как у новорождённого). */
export type CreatureInit = Pick<Creature, 'id' | 'sp' | 'g' | 'x' | 'y' | 'heading' | 'rs'> & Partial<Creature>;

/** Гильдия, как её считают пришельцы с большой земли и стенд: 0 травоядные, 1 всеядные, 2 хищники, 3 пловцы. */
export function guildOf(g: Genome): 0 | 1 | 2 | 3 {
  return g.swim > 0.6 ? 3 : g.diet < 0.3 ? 0 : g.diet <= 0.65 ? 1 : 2;
}

export interface Corpse {
  x: number;
  y: number;
  energy: number;
  size: number;
  hue: number;
  age: number;
  /** Клетка, начальная энергия (для стадий разложения), вид, был ли болен. */
  idx: number;
  e0: number;
  sp: number;
  sick: boolean;
}

export interface Ancestor {
  id: number;
  mother: number | null;
  sp: number;
  g: Genome;
  generation: number;
  born: number;
  died: number | null;
}

export interface WorldEvent {
  tick: number;
  text: string;
  kind: 'extinct' | 'disaster' | 'milestone' | 'info' | 'species' | 'migration' | 'player' | 'micro' | 'disease';
  x?: number;
  y?: number;
}

/** Мгновенные события для визуальных эффектов (сердечки, вспышки и т.п.). */
export interface Fx {
  kind: 'birth' | 'mate' | 'kill' | 'meteor' | 'newSpecies' | 'outbreak';
  x: number;
  y: number;
  hue: number;
}

export interface Sample {
  tick: number;
  counts: Map<number, number>;
  means: Map<number, Record<GeneKey, number>>;
  grass: number;
  /** Почва (суша): плодородие (1 = норма), опад, редуценты, азотфиксаторы; микориза (лес/болото); планктон (вода). */
  soil: number;
  litter: number;
  mic: number;
  fix: number;
  myc: number;
  plankton: number;
  /** Больных во всём мире; индекс CO₂ (зарезервировано, пока 0). */
  sick: number;
  co2: number;
}

export type BrainMode = 'rules' | 'neural';

/** Условия на поверхности — приходят с уровня «Планета». */
export interface SurfaceEnv {
  name: string;
  /** Доля поверхности под водой. */
  sea: number;
  /** Сдвиг температуры (в единицах модели, 0.1 ≈ 8 °C). */
  tempOffset: number;
  /** Доля кислорода в воздухе. */
  o2: number;
  gravity: number;
  /** Размах сезонов (без большой луны — больше). */
  seasonAmp: number;
  /** Есть ли уже жизнь на суше (иначе — только морские животные). */
  landLife: boolean;
  /** Цвет света звезды. */
  starTint: [number, number, number];
  /** Вулканизм (тектоника плит → 1, иначе 0.3): число горячих источников. */
  volcanism?: number;
  /** Стадия жизни на планете (0..7, как в model.ts). */
  lifeStage?: number;
}

export const EARTH_ENV: SurfaceEnv = { name: 'Земля', sea: 0.3, tempOffset: 0, o2: 0.21, gravity: 1, seasonAmp: 0.16, landLife: true, starTint: [1, 1, 1], volcanism: 1, lifeStage: 7 };

export interface Settings {
  mutationRate: number;
  grassGrowth: number;
  seasons: boolean;
  /** Почва и микробы: круговорот питательных веществ. */
  soil: boolean;
  /** Болезни: внутривидовые эпидемии вместо безликого «риска тесноты». */
  disease: boolean;
  /** Хищники чаще ловят больных (отложено, пока не используется). */
  healthyHerd: boolean;
}

export const DAY = 150;
export const YEAR = DAY * 40;
const HASH = 80;

/** Стартовые «предки». Каждый живёт в своём климате. */
const FOUNDERS: { n: number; g: Partial<Genome> }[] = [
  { n: 140, g: { size: 3.5, speed: 1.3, sense: 50, diet: 0.05, tempPref: 0.5, social: 0.6, hue: 110 } },
  { n: 50, g: { size: 4.5, speed: 1.1, sense: 60, diet: 0.05, tempPref: 0.2, social: 0.8, hue: 30 } },
  { n: 50, g: { size: 2.5, speed: 1.6, sense: 70, diet: 0.08, tempPref: 0.8, social: 0.2, hue: 50 } },
  { n: 30, g: { size: 4.5, speed: 1.2, sense: 90, diet: 0.15, tempPref: 0.55, swim: 0.8, social: 0.25, hue: 190 } },
  { n: 40, g: { size: 6.5, speed: 1.3, sense: 60, diet: 0.45, tempPref: 0.5, social: 0.5, hue: 280 } },
  { n: 16, g: { size: 6, speed: 2, sense: 85, diet: 0.9, tempPref: 0.5, social: 0.6, hue: 5 } },
  { n: 10, g: { size: 6.5, speed: 2, sense: 90, diet: 0.9, tempPref: 0.2, social: 0.2, hue: 220 } },
  // крупные пастбищные гиганты — им не страшны мелкие хищники
  { n: 30, g: { size: 9, speed: 1.1, sense: 60, diet: 0.03, tempPref: 0.45, social: 0.85, hue: 25, pattern: 0.1 } },
  // мелкий хищник — ловит грызунов, а не конкурирует с крупными
  { n: 14, g: { size: 3, speed: 2.4, sense: 75, diet: 0.85, tempPref: 0.55, social: 0.1, hue: 35, pattern: 0.9 } },
  // падальщики-стервятники: зоркие, стайные, едят останки
  { n: 16, g: { size: 5, speed: 1.6, sense: 130, diet: 0.6, tempPref: 0.6, social: 0.75, hue: 320 } },
];

export class World {
  terrain!: Terrain;
  grass!: Float32Array;
  /** Листва — корм крупных. */
  browse!: Float32Array;
  /** Ягоды и насекомые — корм всеядных. */
  forage!: Float32Array;
  /** Кто самый крупный пасся на клетке (для конкуренции). */
  private claim!: Float32Array;
  private claimTick!: Int32Array;
  creatures: Creature[] = [];
  corpses: Corpse[] = [];
  species = new SpeciesRegistry();
  ancestors = new Map<number, Ancestor>();
  /** «хищник>жертва» → интенсивность (со временем затухает). 0 = трава, -1 = падаль. */
  web = new Map<string, number>();
  tick = 0;
  history: Sample[] = [];
  events: WorldEvent[] = [];
  fx: Fx[] = [];
  settings: Settings = { mutationRate: 0.08, grassGrowth: 1, seasons: true, soil: true, disease: true, healthyHerd: false };
  brainMode: BrainMode = 'rules';
  env: SurfaceEnv = EARTH_ENV;
  drought = 0;
  seed = 1;
  /** «Соль» зерна: та же карта (seed), но другие основатели, трава и кости. */
  salt = 0;
  /** Поток мира: основатели, мигранты, стихии, инструменты (между шагами и вне хода особи). */
  rng = 1;
  /** Чья очередь ходить в step(): её личные кости; null — поток мира. */
  private ctx: Creature | null = null;
  /**
   * Единственный источник случайности симуляции (mulberry32 по потоку `ctx` или мира).
   * Других источников случайности в src/sim нет — иначе перемотка и ветки не повторятся.
   */
  readonly r = (): number => {
    const c = this.ctx;
    let s: number;
    if (c) s = c.rs = (c.rs + 0x6d2b79f5) | 0;
    else s = this.rng = (this.rng + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Ввод игрока: направление и бег. */
  input = { dx: 0, dy: 0, run: false };
  player: Creature | null = null;
  playerStats = { generation: 0, possessed: 0, deaths: 0 };

  private nextId = 1;
  /** Пространственная сетка: массив корзин вместо Map — заметно быстрее. */
  private grid: Creature[][] = [];
  private corpseGrid: Corpse[][] = [];
  private gw = 0;
  private gh = 0;
  /** Сдвиг температуры текущего сезона (кэш на такт). */
  private shiftNow = 0;
  /** Риск болезни для видов (обновляется раз в 20 тактов). */
  private crowdRisk = new Map<number, number>();
  // ---- почва и микробы (по клеткам) ----
  soil!: Float32Array;
  litter!: Float32Array;
  mic!: Float32Array;
  fix!: Float32Array;
  myc!: Float32Array;
  /** Кэш: активность микробов и множитель роста травы. */
  act!: Float32Array;
  nut!: Float32Array;
  private microBase!: Float32Array;
  private leachK!: Float32Array;
  private s0!: Float32Array;
  /** 0 — суша, 1 — вода, 2 — суша с микоризой (лес, болото). */
  private isWater!: Uint8Array;
  /** Взвешенное по росту среднее «сырого» плодородия — нормировка, чтобы общая продуктивность не дрейфовала. */
  nutRef = { land: 1, water: 1 };
  private nutAcc = { wl: 0, fl: 0, ww: 0, fw: 0, nl: 0, nw: 0 };
  /** Средний множитель роста там, где трава растёт (за последние 20 тактов) — диагностика. */
  nutGrow = { land: 1, water: 1 };
  private corpseRef = 1;
  /**
   * Опыты уроков 📚 (не Settings: сбрасываются вместе с миром). По умолчанию выключены и ничего не меняют.
   * noDecomposers — бактерии и грибы почвы выключены: опад не гниёт, почва не пополняется из него,
   * туши сохнут в 7 раз медленнее (остаются жуки и солнце), но лежат не дольше обычных 1500 тактов
   * (потом крошатся в опад, который не гниёт; не больше 2500 туш); нормировки плодородия заморожены.
   */
  experiment = { noDecomposers: false };
  /** Эффект Бёрча: всплеск дыхания почвы после засухи. */
  private birch = 0;
  /** Потоки за окно в 20 тактов и их сглаженные значения (для схемы круговорота). */
  flux = { decomp: 0, gpp: 0, uptake: 0, litterIn: 0, dungIn: 0, carrionIn: 0, runoff: 0, corpseDecay: 0, resp: 0 };
  fluxEma = { decomp: 0, gpp: 0, uptake: 0, litterIn: 0, dungIn: 0, carrionIn: 0, runoff: 0, corpseDecay: 0, resp: 0 };
  micro = { corpsesRecycled: 0, lastGiantLog: -1e9, sick: 0, outbreaksTotal: 0, lastMeteor: null as null | { x: number; y: number; tick: number } };
  /** Кости на месте разложившихся туш (только для вида, не более 400). */
  boneMarks: { x: number; y: number; size: number; t: number }[] = [];
  // ---- болезни ----
  /** Активные вспышки (по виду-хозяину) и архив закончившихся (не более 30). */
  pathogens = new Map<number, Pathogen>();
  outbreaks: Pathogen[] = [];
  /** Бюджет смертности тесноты, разделённый между больными и здоровыми (раз в 20 тактов). */
  private sickRisk = new Map<number, number>();
  private healthyRisk = new Map<number, number>();
  /** Средний квадрат вирулентности больных вида; до какого такта действует усиленный риск (инструмент). */
  private meanV2 = new Map<number, number>();
  private boost = new Map<number, number>();
  private nextPath = 1;
  /** Уже рассказывали, что вспышка может заглохнуть сама. */
  private fizzleLogged = false;
  /** Весеннее цветение: минимум планктона за прошлую зиму и год последней записи. */
  private bloomMin = Infinity;
  private bloomYear = 0;
  private nin = new Float32Array(IN);
  private nout = new Float32Array(OUT);

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell = 16,
  ) {
    this.reset();
  }

  /** Новый мир. (seed, env, mode, salt) полностью задают его, включая основателей; рельеф зависит только от seed и env. */
  reset(mode: BrainMode = this.brainMode, seed = (Math.random() * 1e9) | 0 /* entropy: new world */, env: SurfaceEnv = this.env, salt = 0): void {
    this.brainMode = mode;
    this.seed = seed;
    this.salt = salt;
    this.rng = mix32(seed ^ 0x5bd1e995 ^ mix32(salt));
    this.ctx = null;
    this.species.rand = this.r;
    this.env = env;
    this.terrain = new Terrain(this.width, this.height, this.cell, seed, env.sea, env.tempOffset, env.volcanism ?? 1);
    this.grass = new Float32Array(this.terrain.cols * this.terrain.rows);
    this.claim = new Float32Array(this.grass.length);
    this.claimTick = new Int32Array(this.grass.length).fill(-10);
    this.browse = new Float32Array(this.grass.length);
    this.forage = new Float32Array(this.grass.length);
    for (let i = 0; i < this.grass.length; i++) {
      const b = BIOMES[this.terrain.biome[i]];
      this.grass[i] = b.fert * this.r();
      this.browse[i] = b.browse * (0.5 + this.r() * 0.5);
      this.forage[i] = b.forage * this.r();
    }
    this.initSoil();
    this.creatures = [];
    this.corpses = [];
    this.species.clear();
    this.ancestors.clear();
    this.web.clear();
    this.history = [];
    this.events = [];
    this.fx = [];
    this.tick = 0;
    this.drought = 0;
    this.nextId = 1;
    this.player = null;
    this.playerStats = { generation: 0, possessed: 0, deaths: 0 };
    this.crowdRisk.clear();
    this.deaths.clear();
    for (const f of FOUNDERS) {
      // до выхода на сушу живут только морские существа
      const g = env.landLife ? f.g : { ...f.g, swim: 0.9 };
      this.colonize(g, Math.round(f.n * (mode === 'neural' ? 1.8 : 1.3)));
    }
    this.log(
      mode === 'neural' ? 'Мир создан. Мозги случайные — посмотрим, кто научится выживать.' : 'Мир создан. Жизнь начинается.',
      'info',
    );
  }

  /** Почва без случайностей: тёплый старт около равновесия (поток случайных чисел основателей не меняется). */
  private initSoil(): void {
    const t = this.terrain;
    const N = this.grass.length;
    const land = this.env.landLife;
    this.soil = new Float32Array(N);
    this.litter = new Float32Array(N);
    this.mic = new Float32Array(N);
    this.fix = new Float32Array(N).fill(0.25);
    this.myc = new Float32Array(N);
    this.act = new Float32Array(N);
    this.nut = new Float32Array(N).fill(1);
    this.microBase = new Float32Array(N);
    this.leachK = new Float32Array(N);
    this.s0 = new Float32Array(N);
    this.isWater = new Uint8Array(N);
    const o2k = Math.min(1, Math.max(0.3, this.env.o2 / 0.1));
    for (let i = 0; i < N; i++) {
      const b = t.biome[i];
      const info = BIOMES[b];
      const w = info.water;
      const mycCap = b === B.Forest || b === B.Swamp;
      this.isWater[i] = w ? 1 : mycCap ? 2 : 0;
      this.microBase[i] = w ? 1 : Math.min(1.2, Math.max(0.15, t.moist[i] * 2)) * (b === B.Swamp ? 0.35 : 1);
      this.leachK[i] = w ? 0 : SOIL.KL * 16 * t.moist[i] * (t.river[i] >= 1 ? 3 : 1);
      this.s0[i] = b === B.Shallow ? 1.1 : b === B.Deep ? 0.9 : land ? 1 : 0.4;
      this.soil[i] = b === B.Shallow ? 1.1 : b === B.Deep ? 0.9 : land ? 1 : 0.3;
      const T = t.baseTemp[i];
      const a0 = Q10T[T <= 0 ? 0 : T >= 1 ? 127 : (T * 127) | 0] * this.microBase[i] * o2k;
      const L = w ? 0.05 : Math.min(4, (0.065 * info.fert) / Math.max(0.03, a0));
      this.litter[i] = L;
      this.mic[i] = Math.max(0.03, Math.min(1, a0 / 1.5) * (L / (L + 0.3)));
      this.myc[i] = mycCap ? 1 : 0;
      this.act[i] = a0;
    }
    this.nutRef = { land: 1, water: 1 };
    this.nutAcc = { wl: 0, fl: 0, ww: 0, fw: 0, nl: 0, nw: 0 };
    this.nutGrow = { land: 1, water: 1 };
    this.corpseRef = 1;
    this.experiment = { noDecomposers: false };
    this.birch = 0;
    for (const k in this.flux) {
      this.flux[k as keyof World['flux']] = 0;
      this.fluxEma[k as keyof World['flux']] = 0;
    }
    this.micro = { corpsesRecycled: 0, lastGiantLog: -1e9, sick: 0, outbreaksTotal: 0, lastMeteor: null };
    this.boneMarks = [];
    this.pathogens.clear();
    this.outbreaks = [];
    this.sickRisk.clear();
    this.healthyRisk.clear();
    this.meanV2.clear();
    this.boost.clear();
    this.nextPath = 1;
    this.fizzleLogged = false;
    this.bloomMin = Infinity;
    this.bloomYear = 0;
  }

  /**
   * Почва и микробы: каждый такт — 1/16 клеток (dt = 16).
   * Опад → (редуценты, Q10) → минеральное плодородие → трава; азотфиксаторы растут только там, где голодно;
   * с суши вещества вымываются вниз по стоку — к устьям рек; в море зимой перемешивание поднимает их к поверхности.
   */
  private soilPass(): void {
    const t = this.terrain;
    const N = this.grass.length;
    const cols = t.cols;
    const A = this.act, S = this.soil, Lt = this.litter, M = this.mic, F = this.fix, MY = this.myc, NU = this.nut;
    const MB = this.microBase, LK = this.leachK, S0 = this.s0, W = this.isWater, D = t.drain, bt = t.baseTemp, G = this.grass;
    const fl = this.flux;
    const shift = this.shiftNow;
    const o2k = Math.min(1, Math.max(0.3, this.env.o2 / 0.1));
    const dryF = this.drought > 0 ? 0.3 : 1 + (0.5 * this.birch) / 1500;
    const wint = Math.max(0, -shift / Math.max(0.01, this.env.seasonAmp));
    const refL = this.nutRef.land, refW = this.nutRef.water;
    const [lo, hi] = NUT_CLAMP.land, [wlo, whi] = NUT_CLAMP.water;
    const KD = SOIL.KD * 16, KR = SOIL.KR * 16, KS = SOIL.KS * 16, UN = SOIL.UN, SG = SOIL.SG, SMAX = SOIL.SMAX, LMAX = SOIL.LMAX;
    let decS = 0, runS = 0, senS = 0;
    const noDec = this.experiment.noDecomposers;
    // непрерывный кусок из N/16 клеток (а не каждая 16-я): так массивы читаются целыми строками кэша
    const blk = Math.ceil(N / 16);
    const i0 = (this.tick & 15) * blk, i1 = Math.min(N, i0 + blk);
    for (let i = i0; i < i1; i++) {
      const w = W[i] === 1;
      const T = bt[i] + shift;
      const a = Q10T[T <= 0 ? 0 : T >= 1 ? 127 : (T * 127) | 0] * MB[i] * o2k * (w ? 1 : dryF);
      A[i] = a;
      let l = Lt[i], s = S[i], m = M[i], f = F[i];
      // старение: часть травы (там, где не мороз) отмирает и становится опадом;
      // доля SG — из надземной травы, остальное — отмирающие корни (питание берётся из почвы, корм не трогаем)
      if (T >= 0.03) {
        const sen = KS * G[i];
        G[i] -= sen * SG;
        const u = UN * sen;
        l += u;
        s -= u * (1 - SG);
        senS += u;
      }
      // редуценты следуют за едой и теплом (отклик ≈ 2 дня)
      const mt = noDec ? 0 : (a > 1.5 ? 1 : a / 1.5) * (l / (l + 0.3));
      m += 0.06 * (mt - m);
      if (m < 0.03) m = 0.03;
      // разложение: полураспад опада ≈ четверть года при a = 1, m = 0.5 (опыт урока: разложителей нет)
      let dec = noDec ? 0 : KD * a * l * (0.5 + m);
      if (dec > l) dec = l;
      l -= dec;
      s += 0.85 * dec; // 15% уходит в воздух как CO₂
      decS += dec;
      // азотфиксаторы: процветают только там, где не хватает питания (гомеостат)
      let ft = 1.25 - s;
      ft = ft < 0.03 ? 0.03 : ft > 1 ? 1 : ft;
      f += 0.02 * (ft - f);
      if (w) {
        // вода: сезонное перемешивание (зимой питательные вещества поднимаются) и диффузия между соседями
        s += 2 * KR * (S0[i] * (1 + 0.35 * wint) - s);
        const x = i % cols;
        let sum = 0, k = 0;
        if (x > 0 && W[i - 1] === 1) { sum += S[i - 1]; k++; }
        if (x < cols - 1 && W[i + 1] === 1) { sum += S[i + 1]; k++; }
        if (i >= cols && W[i - cols] === 1) { sum += S[i - cols]; k++; }
        if (i + cols < N && W[i + cols] === 1) { sum += S[i + cols]; k++; }
        if (k) s += 0.1 * (sum / k - s);
      } else {
        // выветривание + фиксация азота (если бедно) / денитрификация (если богато)
        s += KR * (S0[i] - s) * (s < S0[i] ? 0.6 + 1.6 * f : 1);
        const lch = LK[i] * s;
        s -= lch;
        const d = D[i];
        if (d >= 0) {
          const v = S[d] + lch;
          S[d] = v > SMAX ? SMAX : v;
          if (W[d] === 1) runS += lch;
        }
        if (W[i] === 2 && MY[i] < 1) MY[i] += 16 * 0.0003 * (1 - MY[i]);
      }
      s = s < 0 ? 0 : s > SMAX ? SMAX : s;
      Lt[i] = l > LMAX ? LMAX : l;
      S[i] = s;
      M[i] = m;
      F[i] = f;
      // закон Моно, нормированный так, что f(1) = 1, затем — на взвешенное среднее
      const nu = (1.5 * s) / (s + 0.5) / (w ? refW : refL);
      NU[i] = w ? (nu < wlo ? wlo : nu > whi ? whi : nu) : nu < lo ? lo : nu > hi ? hi : nu;
    }
    fl.litterIn += senS;
    fl.decomp += decS;
    fl.resp += decS;
    fl.runoff += runS;
  }

  /** Поселить группу одинаковых особей туда, где им комфортно. */
  colonize(base: Partial<Genome>, n: number, x?: number, y?: number): Species {
    const neural = this.brainMode === 'neural';
    const g0 = genome(base, neural, this.r);
    let cx = x;
    let cy = y;
    if (cx === undefined || cy === undefined) [cx, cy] = this.findHome(g0);
    const region = this.terrain.regionAt(cx, cy)?.name ?? 'неизвестные земли';
    // основатели — всегда отдельный вид; пришельцы присоединяются к очень близкому родственнику
    const sp = this.tick === 0 ? this.species.create(g0, null, 0, region) : this.species.match(g0, this.tick, region);
    for (let i = 0; i < n; i++) {
      const g = mutate(g0, 0.03, this.r);
      if (neural) g.brain = genome({}, true, this.r).brain;
      g.hue = g0.hue + (this.r() - 0.5) * 10;
      const [px, py] = this.nearbyLand(cx, cy, 120, g);
      this.spawn(sp.id, g, px, py);
    }
    return sp;
  }

  /** Случайная точка, где этому геному удобно: подходящая температура и можно стоять. */
  findHome(g: Genome): [number, number] {
    let best: [number, number] = [this.width / 2, this.height / 2];
    let bestScore = -Infinity;
    for (let i = 0; i < 400; i++) {
      const x = this.r() * this.width;
      const y = this.r() * this.height;
      const idx = this.terrain.index(x, y);
      if (!this.passable(g, idx)) continue;
      const wet = BIOMES[this.terrain.biome[idx]].water;
      const score = -Math.abs(this.temp(idx) - g.tempPref) * 3 + this.maxGrass(idx) * (1 - g.diet) + (g.swim > 0.6 ? (wet ? 2 : -1) : 0);
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
    return best;
  }

  private nearbyLand(x: number, y: number, r: number, g: Genome): [number, number] {
    for (let i = 0; i < 30; i++) {
      const px = clamp(x + (this.r() - 0.5) * 2 * r, 0, this.width - 1);
      const py = clamp(y + (this.r() - 0.5) * 2 * r, 0, this.height - 1);
      if (this.passable(g, this.terrain.index(px, py))) return [px, py];
    }
    return [x, y];
  }

  // ---------------- климат ----------------

  get season(): { name: string; icon: string; shift: number; phase: number } {
    const phase = (this.tick % YEAR) / YEAR;
    if (!this.settings.seasons) return { name: 'Вечное лето', icon: '☀️', shift: 0.05, phase };
    const shift = this.env.seasonAmp * Math.sin(phase * Math.PI * 2);
    const names: [string, string][] = [
      ['Весна', '🌸'],
      ['Лето', '☀️'],
      ['Осень', '🍂'],
      ['Зима', '❄️'],
    ];
    const [name, icon] = names[Math.floor(phase * 4)];
    return { name, icon, shift, phase };
  }

  /** 0 — полночь, 0.5 — полдень. */
  get dayTime(): number {
    // мир начинается утром
    return ((this.tick + DAY * 0.3) % DAY) / DAY;
  }

  /** Насколько светло, 0..1. */
  get daylight(): number {
    return clamp(0.5 - 0.5 * Math.cos(this.dayTime * Math.PI * 2) + 0.15, 0, 1);
  }

  get year(): number {
    return Math.floor(this.tick / YEAR) + 1;
  }

  temp(idx: number): number {
    return this.terrain.baseTemp[idx] + this.shiftNow;
  }

  maxGrass(idx: number): number {
    return BIOMES[this.terrain.biome[idx]].fert;
  }

  passable(g: Genome, idx: number): boolean {
    const b = this.terrain.biome[idx];
    if (b === B.Deep) return g.swim > 0.5;
    if (b === B.Shallow) return g.swim > 0.15;
    return true;
  }

  // ---------------- существа ----------------

  spawn(sp: number, g: Genome, x: number, y: number): Creature {
    const heading = this.r() * Math.PI * 2;
    // личный поток — из текущего: у детёныша — из маминых костей, у основателя и пришельца — из костей мира
    const rs = (this.r() * 4294967296) | 0;
    const dph = (this.r() * 32) | 0;
    const c = this.makeCreature({ id: this.nextId++, sp, g, x, y, heading, rs, dph, energy: this.maxEnergy(g) * 0.5 });
    this.creatures.push(c);
    this.ancestors.set(c.id, { id: c.id, mother: null, sp, g, generation: 0, born: this.tick, died: null });
    return c;
  }

  /**
   * Единственное место, где собирается особь (рождение и восстановление снимка): один порядок полей —
   * один скрытый класс у всех особей, иначе после перемотки шаг заметно медленнее.
   */
  private makeCreature(o: CreatureInit): Creature {
    const g = o.g;
    return {
      id: o.id,
      sp: o.sp,
      g,
      x: o.x,
      y: o.y,
      heading: o.heading,
      v: o.v ?? 0,
      energy: o.energy ?? this.maxEnergy(g) * 0.5,
      age: o.age ?? 0,
      generation: o.generation ?? 0,
      mother: o.mother ?? null,
      father: o.father ?? null,
      children: o.children ?? 0,
      kills: o.kills ?? 0,
      alive: o.alive ?? true,
      state: o.state ?? 'wander',
      cooldown: o.cooldown ?? 0,
      cooldownHunt: o.cooldownHunt ?? 0,
      gx: o.gx ?? 0,
      gy: o.gy ?? 0,
      gt: o.gt ?? 0,
      pv: o.pv ?? Math.pow(1 - g.diet, 1.1),
      reachK: o.reachK ?? clamp((g.size - 4.5) / 3.5, 0, 1),
      fe: o.fe ?? clamp(1 - Math.abs(g.diet - 0.45) * 2.6, 0, 1),
      lonely: o.lonely ?? 0,
      pack: o.pack ?? 0,
      alarm: o.alarm ?? 0,
      activations: g.brain ? new Float32Array(IN + HID + OUT) : null,
      player: o.player ?? false,
      cause: o.cause ?? null,
      dung: o.dung ?? 0,
      sick: o.sick ?? 0,
      immune: o.immune ?? 0,
      vir: o.vir ?? 0,
      beta: o.beta ?? 0,
      rs: o.rs,
      dph: o.dph ?? 0,
    };
  }

  /** Предельный размер тела: кислород позволяет вырасти, гравитация — мешает. */
  get maxSize(): number {
    return clamp(14 * Math.sqrt(this.env.o2 / 0.21) / Math.sqrt(this.env.gravity), 2.5, 18);
  }

  /**
   * Болезни и паразиты: чем теснее живёт вид, тем быстрее они распространяются.
   * Это естественный тормоз для «взрыва» численности одного вида.
   */
  crowding(sp: number): number {
    const n = this.species.all.get(sp)?.count ?? 0;
    return n > 400 ? 0.0005 * (n / 400 - 1) : 0;
  }

  maxEnergy(g: Genome): number {
    return 40 * g.size * g.size;
  }

  maturity(g: Genome): number {
    return 140 + g.size * 18;
  }

  lifespan(g: Genome): number {
    return 3500 + g.size * 450;
  }

  radius(c: Creature): number {
    return c.g.size;
  }

  /** Может ли `a` съесть `b`. Стая позволяет брать добычу крупнее. */
  canEat(a: Creature, b: Creature): boolean {
    if (a.g.diet < 0.35 || a.sp === b.sp) return false;
    return b.g.size < this.preyLimit(a);
  }

  /** Самая крупная добыча, которую хищник может одолеть. Стая позволяет брать крупнее. */
  preyLimit(a: Creature): number {
    const pack = 1 + Math.min(0.8, a.pack * 0.25 * a.g.social);
    return a.g.size * (0.45 + a.g.diet * 0.75) * pack;
  }

  /**
   * Шанс одолеть добычу при контакте: мелкую — почти наверняка, крупную (у предела) — редко.
   * Так у травоядных появляется смысл расти: размер — это защита.
   */
  captureChance(a: Creature, b: Creature): number {
    const r = b.g.size / this.preyLimit(a);
    return clamp(1.25 - r * 1.15, 0.04, 1);
  }

  ready(c: Creature): boolean {
    return c.cooldown <= 0 && c.age > this.maturity(c.g) && c.energy > this.maxEnergy(c.g) * 0.6;
  }

  compatible(a: Creature, b: Creature): boolean {
    return a.sp === b.sp && distance(a.g, b.g) < MATE_LIMIT;
  }

  /**
   * Расход энергии за тик. Обмен веществ растёт как size^1.5 (как закон Клейбера),
   * а запас энергии — как size², поэтому крупным жить выгоднее, но они дольше растут.
   */
  private cost(c: Creature, v: number, idx: number): number {
    const { size, sense, speed, swim } = c.g;
    const m = size * Math.sqrt(size);
    // мало кислорода — обмен веществ менее выгоден; гравитация утяжеляет движение
    const air = Math.pow(0.21 / Math.max(0.02, this.env.o2), 0.3);
    const base = 0.05 * m * air;
    const muscles = 0.006 * m * speed * speed;
    const move = 0.008 * m * v * v * this.env.gravity;
    const eyes = 0.0008 * sense;
    const gills = 0.012 * swim * m;
    const d = Math.max(0, Math.abs(this.temp(idx) - c.g.tempPref) - 0.1);
    // правило Бергмана: мелким в неподходящем климате хуже — тепло уходит через поверхность
    const climate = 0.6 * m * d * d * (4 / size);
    const b = this.terrain.biome[idx];
    const wet = b === B.Deep || b === B.Shallow ? 0.03 * m * v * v * (1 - swim) : 0;
    return base + muscles + move + eyes + gills + climate + wet;
  }

  // ---------------- пространственный хеш ----------------

  private buildHash(): void {
    this.gw = Math.ceil(this.width / HASH) + 1;
    this.gh = Math.ceil(this.height / HASH) + 1;
    const n = this.gw * this.gh;
    if (this.grid.length !== n) {
      this.grid = Array.from({ length: n }, () => []);
      this.corpseGrid = Array.from({ length: n }, () => []);
    }
    for (const b of this.grid) b.length = 0;
    for (const b of this.corpseGrid) b.length = 0;
    for (const c of this.creatures) this.grid[this.cellOf(c.x, c.y)].push(c);
    for (const k of this.corpses) this.corpseGrid[this.cellOf(k.x, k.y)].push(k);
  }

  private cellOf(x: number, y: number): number {
    const gx = clamp(Math.floor(x / HASH), 0, this.gw - 1);
    const gy = clamp(Math.floor(y / HASH), 0, this.gh - 1);
    return gy * this.gw + gx;
  }

  forNear(x: number, y: number, r: number, fn: (o: Creature, d2: number) => void): void {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor((x - r) / HASH));
    const x1 = Math.min(this.gw - 1, Math.floor((x + r) / HASH));
    const y0 = Math.max(0, Math.floor((y - r) / HASH));
    const y1 = Math.min(this.gh - 1, Math.floor((y + r) / HASH));
    for (let hy = y0; hy <= y1; hy++) {
      const row = hy * this.gw;
      for (let hx = x0; hx <= x1; hx++) {
        const bucket = this.grid[row + hx];
        for (let k = 0; k < bucket.length; k++) {
          const o = bucket[k];
          const dx = o.x - x;
          const dy = o.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < r2) fn(o, d2);
        }
      }
    }
  }

  /** Туши поблизости (через ту же сетку). */
  private forCorpses(x: number, y: number, r: number, fn: (k: Corpse, d2: number) => void): void {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor((x - r) / HASH));
    const x1 = Math.min(this.gw - 1, Math.floor((x + r) / HASH));
    const y0 = Math.max(0, Math.floor((y - r) / HASH));
    const y1 = Math.min(this.gh - 1, Math.floor((y + r) / HASH));
    for (let hy = y0; hy <= y1; hy++) {
      for (let hx = x0; hx <= x1; hx++) {
        for (const k of this.corpseGrid[hy * this.gw + hx]) {
          if (k.energy <= 0) continue;
          const d2 = (k.x - x) ** 2 + (k.y - y) ** 2;
          if (d2 < r2) fn(k, d2);
        }
      }
    }
  }


  creatureAt(x: number, y: number, slack = 8): Creature | null {
    let best = null as Creature | null;
    let bestD = Infinity;
    this.forNear(x, y, 40, (c, d2) => {
      const r = c.g.size + slack;
      if (c.alive && d2 < r * r && d2 < bestD) {
        bestD = d2;
        best = c;
      }
    });
    return best;
  }

  // ---------------- восприятие ----------------

  private perceive(c: Creature, range: number) {
    let threat = null as Creature | null;
    let threatD = Infinity;
    let prey = null as Creature | null;
    let preyD = Infinity;
    let mate = null as Creature | null;
    let mateD = Infinity;
    let fx = 0;
    let fy = 0;
    let hx = 0;
    let hy = 0;
    let n = 0;
    let alarm = null as Creature | null;
    // больные сородичи рядом: сумма их заразности и вирулентность штамма (без отдельного поиска)
    let sickB = 0;
    let srcV = 0;
    const wantMate = this.ready(c);
    const hungry = c.energy < this.maxEnergy(c.g) * 0.85;
    this.forNear(c.x, c.y, range, (o, d2) => {
      if (o === c || !o.alive) return;
      if (o.sp === c.sp) {
        if (d2 < range * range * 0.36) {
          n++;
          fx += o.x;
          fy += o.y;
          hx += Math.cos(o.heading);
          hy += Math.sin(o.heading);
          if (o.alarm > 0 && !alarm) alarm = o;
          if (o.sick > 0) {
            sickB += o.beta;
            srcV = o.vir;
          }
        }
        if (wantMate && d2 < mateD && this.ready(o) && this.compatible(c, o)) {
          mateD = d2;
          mate = o;
        }
        return;
      }
      // от хищника, который нас почти не может одолеть, не бегаем (слон не боится льва)
      if (d2 < threatD && this.canEat(o, c) && this.captureChance(o, c) > 0.15) {
        threatD = d2;
        threat = o;
      } else if (hungry && this.canEat(c, o)) {
        // не гонимся за теми, кто заметно быстрее, если они не совсем рядом
        // всеядные охотятся только на лёгкую добычу — медленную или совсем рядом
        const reach = c.g.diet > 0.65 ? 1.1 : 0.85;
        if (o.g.speed < c.g.speed * reach || d2 < (c.g.size * 5) ** 2) {
          // выбираем не просто ближайшую, а ту, которую реально одолеть
          const ch = this.captureChance(c, o);
          const eff = d2 / (ch * ch);
          if (eff < preyD) {
            preyD = eff;
            prey = o;
          }
        }
      }
    });
    c.pack = n;
    return { threat, threatD, prey, preyD, mate, mateD, n, fx, fy, hx, hy, alarm: alarm as Creature | null, sickB, srcV };
  }

  private senseRange(c: Creature, idx: number): number {
    const night = 0.65 + 0.35 * this.daylight;
    return c.g.sense * BIOMES[this.terrain.biome[idx]].sense * night;
  }

  // ---------------- шаг ----------------

  step(): void {
    this.tick++;
    this.shiftNow = this.season.shift;
    if (this.drought > 0 && --this.drought === 0) {
      this.log('🌧 Засуха закончилась.', 'info');
      this.birch = 1500; // эффект Бёрча: после дождя почва «вздыхает»
    } else if (this.birch > 0) this.birch--;
    this.growGrass();
    this.buildHash();
    this.updateCorpses();

    const born: Creature[] = [];
    const soilOn = this.settings.soil;
    const disOn = this.settings.disease;
    for (const c of this.creatures) {
      if (!c.alive) continue;
      this.ctx = c; // всё случайное в ходе этой особи — из её личных костей
      const idx = this.terrain.index(c.x, c.y);
      const p = this.perceive(c, this.senseRange(c, idx));
      let throttle: number;
      if (c.player) throttle = this.thinkPlayer(c);
      else if (c.g.brain) throttle = this.thinkNeural(c, p, idx);
      else throttle = this.thinkRules(c, p, idx);
      if (c.alarm > 0) c.alarm--;

      const v = this.move(c, throttle);
      const idx2 = this.terrain.index(c.x, c.y);
      c.energy -= this.cost(c, v, idx2);
      c.age++;
      if (c.cooldown > 0) c.cooldown--;
      if (c.cooldownHunt > 0) c.cooldownHunt--;
      this.feed(c, idx2, p.prey);
      // навоз выпадает порциями: в воде — сразу в «почву», на суше — в опад
      // такт — по возрасту и личной фазе, а не по номеру: одно лишнее рождение сдвигает все номера (номера
      // в решениях не участвуют); фаза случайная, а не «от рождения» — с одной лишь фазой рождения навоз выпадал
      // в такт с размножением, и баланс сдвигался (стенд: +17% особей, +23% видов, травоядные мельче)
      if (soilOn && ((c.age + c.dph) & 31) === 0 && c.dung > 0) {
        if (this.isWater[idx2] === 1) this.soil[idx2] = Math.min(SOIL.SMAX, this.soil[idx2] + c.dung);
        else this.litter[idx2] = Math.min(SOIL.LMAX, this.litter[idx2] + c.dung);
        c.dung = 0;
      }

      // спаривание при касании
      if (p.mate && p.mate.alive && this.ready(c) && this.ready(p.mate)) {
        const r = c.g.size + p.mate.g.size + 4;
        if (p.mateD < r * r) born.push(this.breed(c, p.mate));
      }
      // одиночка размножается сам (партеногенез) — иначе изолированные группы не выживут
      if (this.ready(c)) {
        if (!p.mate) c.lonely++;
        if (c.lonely > 700) born.push(this.breed(c, null));
      }

      const max = this.maxEnergy(c.g);
      if (c.energy > max) c.energy = max;
      let risk = 0;
      const wasSick = c.sick > 0;
      if (!disOn) risk = this.crowdRisk.get(c.sp) ?? 0;
      else if (wasSick) {
        // лихорадка ≈ 0.02·m при v = 0.5 (40% основного обмена); смерть — из бюджета тесноты, вес ∝ v²
        c.energy -= DIS.FEVER * c.vir * c.g.size * Math.sqrt(c.g.size) * 0.5;
        const w2 = (c.vir * c.vir) / (this.meanV2.get(c.sp) ?? 0.25);
        risk = (this.sickRisk.get(c.sp) ?? 0) * (w2 < 0.25 ? 0.25 : w2 > 3 ? 3 : w2);
      } else {
        risk = this.healthyRisk.get(c.sp) ?? 0; // == crowding(), пока в виде никто не болеет
        if (c.immune > 0) c.immune--;
        else if (p.sickB > 0) {
          if (this.r() < DIS.BETA * p.sickB) this.infect(c, p.srcV + (this.r() + this.r() + this.r() - 1.5) * DIS.MUT);
        } else if (p.n >= 6 && !this.pathogens.has(c.sp)) this.trySpill(c, p.n);
      }
      if (c.energy <= 0) this.die(c, disOn && wasSick ? 'болезнь' : 'голод');
      else if (risk && this.r() < risk) this.die(c, 'болезнь');
      else if (c.age > this.lifespan(c.g)) this.die(c, 'старость');
      else if (this.terrain.biome[idx2] === B.Deep && c.g.swim < 0.5) this.die(c, 'утонул');
      // выздоровление — только если пережил этот такт (иначе die() уже записал исход)
      if (wasSick && c.alive && --c.sick === 0) {
        c.immune = DIS.IMM + ((this.r() * DIS.IMM_VAR) | 0);
        const P = this.pathogens.get(c.sp);
        if (P) {
          P.recovered++;
          P.outW++;
        }
      }
    }
    this.ctx = null;

    this.creatures = this.creatures.filter((c) => c.alive);
    this.creatures.push(...born);

    if (this.tick % 20 === 0) {
      this.updateNutRef();
      this.record();
    }
    if (this.tick % 500 === 0) this.migrantsFromAfar();
    if (this.tick % 1000 === 0) this.pruneAncestors();
  }

  deaths = new Map<string, number>();
  private die(c: Creature, cause: string, corpse = true): void {
    const key = `${this.species.all.get(c.sp)?.name}:${cause.startsWith('съеден') ? 'съеден' : cause}`;
    this.deaths.set(key, (this.deaths.get(key) ?? 0) + 1);
    c.alive = false;
    c.cause = cause;
    const a = this.ancestors.get(c.id);
    if (a) a.died = this.tick;
    const idx = this.terrain.index(c.x, c.y);
    if (corpse) {
      const e = this.maxEnergy(c.g) * 0.35 + Math.max(0, c.energy);
      this.corpses.push({ x: c.x, y: c.y, energy: e, size: c.g.size, hue: c.g.hue, age: 0, idx, e0: e, sp: c.sp, sick: c.sick > 0 });
    }
    if (c.sick > 0) {
      const P = this.pathogens.get(c.sp);
      if (P) {
        // смерть больного от болезни — в счёт вспышки; съеденный или утонувший больной просто выбывает
        if (cause === 'болезнь') {
          P.deaths++;
          this.bump(-6, c.sp, 1);
        }
        P.outW++;
      }
    }
    if (c.dung > 0 && this.settings.soil) {
      if (this.isWater[idx] === 1) this.soil[idx] = Math.min(SOIL.SMAX, this.soil[idx] + c.dung);
      else this.litter[idx] = Math.min(SOIL.LMAX, this.litter[idx] + c.dung);
      c.dung = 0;
    }
    if (c.player) {
      this.playerStats.deaths++;
      this.log(`👑 Ваше существо погибло (${cause}). Выберите потомка, чтобы продолжить династию.`, 'player', c.x, c.y);
    }
  }

  /**
   * Туши разлагаются быстрее в тепле и там, где много микробов (нормировано на среднее, чтобы падальщикам
   * доставалось столько же); съеденное и сгнившее мясо возвращается в почву.
   */
  private updateCorpses(): void {
    const soilOn = this.settings.soil;
    const A = this.act, Lt = this.litter;
    let ms = 0, mn = 0;
    const [clo, chi] = NUT_CLAMP.corpse;
    const noDec = this.experiment.noDecomposers;
    for (const k of this.corpses) {
      k.age++;
      let m = 1;
      if (soilOn) {
        const a = A[k.idx];
        const raw = 0.5 + 0.5 * (a < 2.6 ? a : 2.6);
        ms += raw;
        mn++;
        m = raw / this.corpseRef;
        m = m < clo ? clo : m > chi ? chi : m;
      }
      let d = (0.3 + 0.001 * k.energy) * m;
      if (noDec) d *= 0.15; // без бактерий и грибов туши только сохнут и их едят жуки
      if (d > k.energy) d = k.energy;
      k.energy -= d;
      if (soilOn && d > 0) {
        const v = Lt[k.idx] + SOIL.CN * d;
        Lt[k.idx] = v > SOIL.LMAX ? SOIL.LMAX : v;
        this.flux.carrionIn += SOIL.CN * d;
        // без разложителей туша не гниёт, а сохнет и крошится в опад — в «гниение» и дыхание не идёт
        if (!noDec) {
          this.flux.corpseDecay += d;
          this.flux.resp += d * 0.01;
        }
      }
    }
    if (mn && !noDec) this.corpseRef += (ms / mn - this.corpseRef) * 0.002;
    // опыт без разложителей: туши копятся — держим не больше 2500 (самые старые уходят), чтобы не тормозило
    if (noDec && this.corpses.length > 2500) this.corpses.splice(0, this.corpses.length - 2500);
    if (this.tick % 10 === 0) {
      const keep: Corpse[] = [];
      for (const k of this.corpses) {
        if (k.energy > 0 && k.age < 1500) {
          keep.push(k);
          continue;
        }
        if (!soilOn) continue;
        // остаток туши уходит в опад; без разложителей там он и лежит (опад не гниёт) — это не переработка
        if (k.energy > 0) Lt[k.idx] = Math.min(SOIL.LMAX, Lt[k.idx] + SOIL.CN * k.energy);
        this.boneMarks.push({ x: k.x, y: k.y, size: k.size, t: this.tick });
        if (this.boneMarks.length > 400) this.boneMarks.shift();
        if (noDec) continue;
        this.micro.corpsesRecycled++;
        if (k.size >= 8 && this.tick - this.micro.lastGiantLog > 2000) {
          this.micro.lastGiantLog = this.tick;
          const r = this.terrain.regionAt(k.x, k.y)?.name ?? 'неизвестные земли';
          this.log(`🍄 Останки гиганта в «${r}» разложились — скоро здесь вырастет самая густая трава`, 'micro', k.x, k.y);
        }
      }
      this.corpses = keep;
    }
  }

  /** Раз в 20 тактов: обновляем нормировку плодородия (τ = 3000 тактов) по взвешенному росту. */
  private updateNutRef(): void {
    const acc = this.nutAcc;
    if (this.experiment.noDecomposers) {
      // опыт урока: нормировка заморожена, иначе она за ~3000 тактов «спрятала» бы обеднение почвы
      acc.wl = acc.fl = acc.ww = acc.fw = acc.nl = acc.nw = 0;
      return;
    }
    // в начале τ короче (как у среднего с поправкой на старт): нормировка сразу догоняет оседающую почву
    const k = 20 / Math.min(SOIL.TAU, Math.max(200, this.tick / 2));
    if (acc.wl > 0) {
      this.nutRef.land += (acc.fl / acc.wl - this.nutRef.land) * k;
      this.nutGrow.land = acc.nl / acc.wl;
    }
    if (acc.ww > 0) {
      this.nutRef.water += (acc.fw / acc.ww - this.nutRef.water) * k;
      this.nutGrow.water = acc.nw / acc.ww;
    }
    acc.wl = acc.fl = acc.ww = acc.fw = acc.nl = acc.nw = 0;
  }

  private growGrass(): void {
    const t = this.terrain;
    const rate = 0.0024 * this.settings.grassGrowth * (this.drought > 0 ? 0.1 : 1);
    const br = this.browse;
    const fo = this.forage;
    const shift = this.shiftNow;
    const g = this.grass;
    const soilOn = this.settings.soil;
    if (soilOn) this.soilPass();
    // трава обновляется частями: каждый тик — каждая 4-я клетка (×4 рост), так в 4 раза дешевле
    const phase = this.tick & 3;
    // опыт урока «Принцип Гаузе»: убранный корм не отрастает, пока опыт идёт
    const growBr = !this.blockActive('browse');
    const growFo = !this.blockActive('forage');
    if (!soilOn) {
      for (let i = phase; i < g.length; i += 4) {
        const temp = t.baseTemp[i] + shift;
        const max = BIOMES[t.biome[i]].fert;
        if (temp < 0.03) {
          g[i] *= 0.997; // сильный мороз — трава вянет
          continue;
        }
        const warm = clamp((temp - 0.03) * 4, 0, 1) * clamp((1.05 - temp) * 4, 0, 1);
        if (g[i] < max) g[i] = Math.min(max, g[i] + rate * 4 * max * warm);
        const info = BIOMES[t.biome[i]];
        // листва растёт медленно, но её много; ягоды и насекомые — только в тёплое время
        if (growBr && br[i] < info.browse) br[i] = Math.min(info.browse, br[i] + rate * 1.2 * info.browse * warm);
        if (growFo && temp > 0.25 && fo[i] < info.forage) fo[i] = Math.min(info.forage, fo[i] + rate * 3 * info.forage * warm);
      }
      return;
    }
    // с почвой: рост × плодородие, усвоение, старение травы → опад (суммы — в локальных переменных)
    const S = this.soil, Lt = this.litter, NU = this.nut, W = this.isWater, MY = this.myc, bt = t.baseTemp, bi = t.biome;
    const UN = SOIL.UN;
    let wl = 0, flS = 0, nl = 0, ww = 0, fw = 0, nw = 0, lit = 0, gpp = 0, upt = 0;
    for (let i = phase; i < g.length; i += 4) {
      const temp = bt[i] + shift;
      const info = BIOMES[bi[i]];
      const max = info.fert;
      let gi = g[i];
      // (старение травы → опад — в soilPass)
      if (temp < 0.03) {
        // сильный мороз — трава вянет и уходит в опад
        const w0 = 0.003 * gi;
        g[i] = gi - w0;
        Lt[i] += UN * w0;
        lit += UN * w0;
        continue;
      }
      const w1 = (temp - 0.03) * 4, w2 = (1.05 - temp) * 4;
      const warm = (w1 > 1 ? 1 : w1) * (w2 > 1 ? 1 : w2 < 0 ? 0 : w2);
      const nu = NU[i];
      if (gi < max) {
        const pot = rate * 4 * max * warm;
        let s = S[i];
        const fr = (1.5 * s) / (s + 0.5);
        if (W[i] === 1) {
          ww += pot;
          fw += pot * fr;
          nw += pot * nu;
        } else {
          wl += pot;
          flS += pot * fr;
          nl += pot * nu;
        }
        let add = pot * nu;
        if (add > max - gi) add = max - gi;
        gi += add;
        const u = UN * add;
        S[i] = s > u ? s - u : 0;
        g[i] = gi;
        gpp += add;
        upt += u;
      }
      // листва (микориза помогает деревьям: после метеорита лес восстанавливается медленнее)
      if (growBr && br[i] < info.browse) br[i] = Math.min(info.browse, br[i] + rate * 1.2 * info.browse * warm * (W[i] === 2 ? 0.6 + 0.4 * MY[i] : 1));
      if (growFo && temp > 0.25 && fo[i] < info.forage) {
        const addF = Math.min(info.forage - fo[i], rate * 3 * info.forage * warm * (0.5 + 0.5 * nu));
        fo[i] += addF;
        const u = 0.5 * UN * addF;
        S[i] = S[i] > u ? S[i] - u : 0;
        upt += u;
      }
    }
    const acc = this.nutAcc, fl = this.flux;
    acc.wl += wl;
    acc.fl += flS;
    acc.nl += nl;
    acc.ww += ww;
    acc.fw += fw;
    acc.nw += nw;
    fl.litterIn += lit;
    fl.gpp += gpp;
    fl.uptake += upt;
  }

  /** Лучшее направление: трава × съедобность − неуютная температура. */
  /** Оценка клетки: еда − неуютный климат + «свой» тип среды. */
  private cellScore(c: Creature, i: number): number {
    if (!this.passable(c.g, i)) return -Infinity;
    const d = Math.abs(this.temp(i) - c.g.tempPref);
    const water = BIOMES[this.terrain.biome[i]].water ? 1 : 0;
    const habitat = c.g.swim > 0.6 ? (water ? 0.3 : -0.3) : 0;
    return this.foodValue(c, i) - Math.max(0, d - 0.08) * Math.max(0, d - 0.08) * 6 + habitat;
  }

  /**
   * Куда идти за едой. Животное помнит хорошее место и идёт к нему, а не мечется;
   * если вокруг пусто — ищет дальше (знает свою территорию).
   */
  private scan(c: Creature, idx: number): { angle: number; score: number; dist: number; here: number } {
    const here = this.cellScore(c, idx);
    if (c.gt > this.tick) {
      const dist = Math.hypot(c.gx - c.x, c.gy - c.y);
      const gs = this.cellScore(c, this.terrain.index(c.gx, c.gy));
      if (dist > 6 && gs > here + 0.04) return { angle: Math.atan2(c.gy - c.y, c.gx - c.x), score: gs, dist, here };
      c.gt = 0;
    }
    let best = { angle: c.heading, score: here, dist: 0, here };
    const far = here < 0.12 ? 3.5 : 1.2;
    const r = c.g.sense * far;
    for (let k = 0; k < 8; k++) {
      const a = this.r() * Math.PI * 2;
      const d = r * (0.2 + this.r() * 0.8);
      const x = c.x + Math.cos(a) * d;
      const y = c.y + Math.sin(a) * d;
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
      // чем дальше, тем дороже дорога
      const sc = this.cellScore(c, this.terrain.index(x, y)) - d * 0.0006;
      if (sc > best.score + 0.05) best = { angle: a, score: sc, dist: d, here };
    }
    if (best.dist > 0) {
      c.gx = c.x + Math.cos(best.angle) * best.dist;
      c.gy = c.y + Math.sin(best.angle) * best.dist;
      c.gt = this.tick + 40 + Math.round(best.dist);
    }
    return best;
  }


  /** Сколько травы может съесть существо на этой клетке (пловцы — водоросли, сухопутные — траву). */
  grassAccess(c: Creature, i: number): number {
    const water = BIOMES[this.terrain.biome[i]].water;
    if (water) return c.g.swim > 0.5 ? 1 : 0;
    return clamp(1 - 1.2 * Math.max(0, c.g.swim - 0.3), 0, 1);
  }

  /** Доступ к листве: чем крупнее, тем выше достаёт (жираф, слон). */
  reach(c: Creature): number {
    return c.reachK;
  }

  /** Ягоды и насекомые лучше всего переваривают всеядные. */
  forageEff(c: Creature): number {
    return c.fe;
  }

  /** Насколько «вкусна» клетка для этого существа (для выбора, куда идти). */
  foodValue(c: Creature, i: number): number {
    const plant = this.plantValue(c);
    return this.grass[i] * plant * this.grassAccess(c, i) + this.browse[i] * this.reach(c) * plant * 0.45 + this.forage[i] * this.forageEff(c) * 1.3;
  }

  plantValue(c: Creature): number {
    // всеядные — универсалы: теряют в эффективности меньше, чем могли бы
    return c.pv;
  }

  private nearestCorpse(c: Creature, r: number): Corpse | null {
    if (c.g.diet < 0.3) return null;
    let best = null as Corpse | null;
    let bestD = Infinity;
    this.forCorpses(c.x, c.y, r, (k, d2) => {
      if (d2 < bestD) {
        bestD = d2;
        best = k;
      }
    });
    return best;
  }


  private thinkRules(c: Creature, p: ReturnType<World['perceive']>, idx: number): number {
    const steer = (a: number, w = 1) => {
      let diff = a - c.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      c.heading += diff * w;
    };
    // 1. опасность (своя или тревога стада)
    if (p.threat) {
      steer(Math.atan2(c.y - p.threat.y, c.x - p.threat.x));
      c.state = 'flee';
      c.alarm = Math.round(40 * c.g.social);
      return 1;
    }
    if (p.alarm && c.g.social > 0.3) {
      steer(p.alarm.heading, 0.6);
      c.state = 'flee';
      c.alarm = Math.max(0, p.alarm.alarm - 5);
      return 1;
    }
    const max = this.maxEnergy(c.g);
    // 2. размножение
    if (p.mate && c.energy > max * 0.6) {
      steer(Math.atan2(p.mate.y - c.y, p.mate.x - c.x));
      c.state = 'mate';
      return 0.7;
    }
    // 3. охота
    if (p.prey) {
      steer(Math.atan2(p.prey.y - c.y, p.prey.x - c.x));
      c.state = 'hunt';
      return 1;
    }
    // сытый хищник отдыхает — как львы, которые спят до 20 часов в сутки
    if (c.g.diet > 0.65 && c.energy > max * 0.65) {
      c.state = 'rest';
      return 0.04;
    }
    // 4. падаль
    if (c.energy < max * 0.8) {
      const k = this.nearestCorpse(c, c.g.sense);
      if (k) {
        steer(Math.atan2(k.y - c.y, k.x - c.x));
        c.state = 'scavenge';
        return 0.8;
      }
    }
    // 5. пастись / искать климат получше
    let throttle = 0.5;
    const s = this.scan(c, idx);
    const tempBad = Math.abs(this.temp(idx) - c.g.tempPref) > 0.2;
    if (s.dist > 0) {
      steer(s.angle, 0.8);
      c.state = tempBad ? 'migrate' : 'graze';
      throttle = tempBad ? 0.9 : 0.7;
    } else if (this.foodValue(c, idx) > 0.2) {
      c.state = 'graze';
      throttle = 0.12;
    } else {
      c.heading += (this.r() - 0.5) * 0.5;
      c.state = 'wander';
    }
    // 6. стадо: держимся вместе и смотрим в одну сторону
    if (p.n > 0 && c.g.social > 0.2) {
      const cx = p.fx / p.n;
      const cy = p.fy / p.n;
      const dist = Math.hypot(cx - c.x, cy - c.y);
      const w = c.g.social * 0.15;
      if (dist > 25) steer(Math.atan2(cy - c.y, cx - c.x), w);
      steer(Math.atan2(p.hy, p.hx), w * 0.5);
      if (c.state === 'wander') c.state = 'herd';
    }
    return throttle;
  }

  private thinkNeural(c: Creature, p: ReturnType<World['perceive']>, idx: number): number {
    const inp = this.nin;
    inp.fill(0);
    const range = c.g.sense;
    const rel = (x: number, y: number, k: number) => {
      const a = Math.atan2(y - c.y, x - c.x) - c.heading;
      inp[k] = Math.sin(a);
      inp[k + 1] = Math.cos(a);
      inp[k + 2] = clamp(1 - Math.hypot(x - c.x, y - c.y) / range, 0, 1);
    };
    if (p.prey) rel(p.prey.x, p.prey.y, 0);
    else {
      const s = this.scan(c, idx);
      if (s.dist > 0) rel(c.x + Math.cos(s.angle) * s.dist, c.y + Math.sin(s.angle) * s.dist, 0);
    }
    if (p.threat) rel(p.threat.x, p.threat.y, 3);
    if (p.mate) rel(p.mate.x, p.mate.y, 6);
    inp[9] = this.foodValue(c, idx);
    inp[10] = c.energy / this.maxEnergy(c.g);
    inp[11] = clamp((this.temp(idx) - c.g.tempPref) * 3, -1, 1);
    inp[12] = 1;
    runBrain(c.g.brain!, inp, this.nout, c.activations ?? undefined);
    c.heading += this.nout[0] * 0.5;
    c.state = p.threat ? 'flee' : p.prey ? 'hunt' : p.mate ? 'mate' : inp[9] > 0.2 ? 'graze' : 'wander';
    return this.nout[1];
  }

  private thinkPlayer(c: Creature): number {
    const { dx, dy, run } = this.input;
    if (dx === 0 && dy === 0) {
      c.state = 'graze';
      return 0;
    }
    c.heading = Math.atan2(dy, dx);
    c.state = run ? 'hunt' : 'wander';
    return run ? 1 : 0.55;
  }

  private move(c: Creature, throttle: number): number {
    const idx = this.terrain.index(c.x, c.y);
    const b = this.terrain.biome[idx];
    let mul = BIOMES[b].move;
    if (BIOMES[b].water) mul = 0.25 + 0.75 * c.g.swim;
    // плавники на суше мешают
    else mul *= 1 - 0.55 * Math.max(0, c.g.swim - 0.3);
    const v = c.g.speed * throttle * mul;
    c.v = v;
    if (v === 0) return 0;
    const nx = c.x + Math.cos(c.heading) * v;
    const ny = c.y + Math.sin(c.heading) * v;
    if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height || !this.passable(c.g, this.terrain.index(nx, ny))) {
      // упёрлись в воду или край — разворот
      if (!c.player) c.heading += Math.PI * (0.5 + this.r());
      return v * 0.3;
    }
    c.x = nx;
    c.y = ny;
    if (BIOMES[this.terrain.biome[this.terrain.index(nx, ny)]].water && c.state === 'wander') c.state = 'swim';
    return v;
  }

  private feed(c: Creature, idx: number, prey: Creature | null): void {
    // трава (или водоросли — для пловцов)
    const plant = this.plantValue(c) * this.grassAccess(c, idx);
    if (plant > 0.02) {
      // крупные едят эффективнее: укус растёт быстрее, чем обмен веществ
      let bite = Math.min(this.grass[idx], 0.008 * Math.pow(c.g.size, 1.85));
      // конкуренция: если на этой клетке пасётся кто-то гораздо крупнее — мелкого оттесняют
      const rival = this.claim[idx];
      if (rival > c.g.size * 1.4 && this.claimTick[idx] >= this.tick - 1) bite *= 0.35;
      if (c.g.size > rival || this.claimTick[idx] < this.tick - 1) {
        this.claim[idx] = c.g.size;
        this.claimTick[idx] = this.tick;
      }
      if (bite > 0) {
        this.grass[idx] -= bite;
        // правило Джармана — Белла: крупные лучше переваривают грубую пищу
        const digest = 42 * Math.pow(c.g.size / 4, 0.3);
        c.energy += bite * digest * plant;
        this.bump(c.sp, 0, bite * 0.2);
        if (this.settings.soil) this.eatDung(c, bite);
      }
    }
    // листва: грубая пища, но её много — ниша гигантов
    const reach = this.reach(c) * this.plantValue(c);
    if (reach > 0.02 && this.browse[idx] > 0) {
      const bite = Math.min(this.browse[idx], 0.01 * Math.pow(c.g.size, 1.85) * reach);
      this.browse[idx] -= bite;
      c.energy += bite * 26 * Math.pow(c.g.size / 4, 0.3);
      this.bump(c.sp, -3, bite * 0.2);
      // листва (деревья) растёт без счёта почвы — значит, и навоза из неё нет: иначе питание из ничего
    }
    // ягоды и насекомые: ценная пища для всеядных
    const fe = this.forageEff(c);
    if (fe > 0.02 && this.forage[idx] > 0) {
      const bite = Math.min(this.forage[idx], 0.006 * Math.pow(c.g.size, 1.5));
      this.forage[idx] -= bite;
      c.energy += bite * 28 * fe;
      this.bump(c.sp, -2, bite * 0.2);
      if (this.settings.soil) this.eatDung(c, bite * 0.5); // ягоды взяли из почвы полдоли травы — столько и вернётся
    }
    if (c.g.diet < 0.3) return;
    // цена универсальности: всеядный переваривает мясо хуже настоящего хищника
    const meat = Math.pow(c.g.diet, 0.8);
    // охота: касание = поймал
    const target = prey && prey.alive ? prey : null;
    if (target) {
      const r = c.g.size + target.g.size + 2;
      if ((target.x - c.x) ** 2 + (target.y - c.y) ** 2 < r * r && this.canEat(c, target) && c.cooldownHunt <= 0) {
        if (this.r() > this.captureChance(c, target)) {
          // добыча отбилась: хищник тратит силы, а крупная жертва может ранить
          c.cooldownHunt = 40;
          c.energy -= this.maxEnergy(c.g) * (target.g.size > c.g.size * 0.8 ? 0.08 : 0.02);
          target.alarm = 30;
          return;
        }
        this.die(target, `съеден (${this.species.all.get(c.sp)?.name ?? 'хищник'})`, false);
        c.energy += (target.energy + this.maxEnergy(target.g) * 0.5) * meat;
        c.kills++;
        this.bump(c.sp, target.sp, 1);
        this.fx.push({ kind: 'kill', x: target.x, y: target.y, hue: target.g.hue });
      }
    }
    // падаль
    const k = this.nearestCorpse(c, c.g.size + 16);
    if (k && (k.x - c.x) ** 2 + (k.y - c.y) ** 2 < (c.g.size + k.size + 2) ** 2) {
      const bite = Math.min(k.energy, 2 + c.g.size * 1.5);
      k.energy -= bite;
      c.energy += bite * meat * 0.8;
      this.bump(c.sp, -1, bite * 0.01);
    }
  }

  /** Съеденное растение → будущий навоз (большая часть питательных веществ возвращается). */
  private eatDung(c: Creature, bite: number): void {
    const d = bite * SOIL.UN * SOIL.DUNG;
    c.dung += d;
    this.flux.dungIn += d;
  }

  private bump(pred: number, prey: number, v: number): void {
    const key = `${pred}>${prey}`;
    this.web.set(key, (this.web.get(key) ?? 0) + v);
  }

  // ---------------- болезни ----------------

  /** Раз в 20 тактов: кривая вспышки, эффективное R, объявление и конец. */
  private trackPathogens(sickN: Map<number, number>, sickV: Map<number, number>): void {
    for (const P of [...this.pathogens.values()]) {
      const ns = sickN.get(P.host) ?? 0;
      if (ns === 0) {
        this.endPathogen(P);
        continue;
      }
      P.virMean = sickV.get(P.host)! / ns;
      P.curve.push(ns);
      P.virCurve.push(P.virMean);
      if (P.curve.length > 300) {
        P.curve.shift();
        P.virCurve.shift();
      }
      if (ns > P.peak) P.peak = ns;
      if (this.tick % 200 === 0) {
        P.rEff = 0.5 * P.rEff + (0.5 * P.newW) / Math.max(1, P.outW);
        P.newW = P.outW = 0;
      }
      if (!P.announced && P.cases >= 8) this.announcePathogen(P, true);
    }
  }

  private announcePathogen(P: Pathogen, log: boolean): void {
    P.announced = true;
    this.micro.outbreaksTotal++;
    const sp = this.species.all.get(P.host);
    if (log) this.log(`🦠 Среди «${sp?.name ?? '?'}» вспышка: «${P.name}» (${P.kind})`, 'disease', P.x, P.y);
    this.fx.push({ kind: 'outbreak', x: P.x, y: P.y, hue: sp?.hue ?? 100 });
  }

  /** Заразить особь штаммом вирулентности v: мягкие болеют дольше, злые — заразнее. */
  private infect(o: Creature, v: number): void {
    v = v < 0.05 ? 0.05 : v > 0.95 ? 0.95 : v;
    o.sick = DUR(v);
    o.vir = v;
    o.beta = 0.4 + 0.6 * Math.sqrt(v);
    const P = this.pathogens.get(o.sp);
    if (P) {
      P.cases++;
      P.newW++;
    }
  }

  /** Новая болезнь в тесном стаде: «перелив» от безымянного резервуара (чаще, когда вид расплодился). */
  private trySpill(c: Creature, n: number): void {
    const sp = this.species.all.get(c.sp);
    if (!sp || sp.count < DIS.SPILL_MIN_N || this.tick - sp.lastOutbreak <= DIS.COOLDOWN) return;
    if (this.r() >= DIS.SPILL * (n - 5) * (this.crowding(c.sp) > 0 ? 20 : 1)) return;
    const P = this.newPathogen(c.sp, c.x, c.y, 0.35 + 0.3 * this.r());
    this.infect(c, P.vir0);
  }

  private newPathogen(host: number, x: number, y: number, vir0: number): Pathogen {
    const region = this.terrain.regionAt(x, y)?.name ?? 'море';
    const { name, kind } = pathogenName(region, this.r);
    const P: Pathogen = { id: this.nextPath++, host, name, kind, region, born: this.tick, ended: null, cases: 0, deaths: 0, recovered: 0, peak: 0,
      curve: [], virCurve: [], vir0, virMean: vir0, newW: 0, outW: 0, rEff: 1, announced: false, x, y };
    this.pathogens.set(host, P);
    return P;
  }

  /** Вспышка закончилась: в архив, виду — передышка. */
  private endPathogen(P: Pathogen, silent = false): void {
    P.ended = this.tick;
    const sp = this.species.all.get(P.host);
    if (sp) sp.lastOutbreak = this.tick;
    this.pathogens.delete(P.host);
    this.outbreaks.push(P);
    if (this.outbreaks.length > 30) this.outbreaks.shift();
    if (silent) return;
    if (P.announced) this.log(`✔ «${P.name}» отступила: переболели ${P.recovered}, погибли ${P.deaths}`, 'disease');
    else if (!this.fizzleLogged && sp) {
      this.fizzleLogged = true;
      this.log(`🦠 Вспышка среди «${sp.name}» заглохла сама — каждый больной заражал меньше одного (R < 1)`, 'disease');
    }
  }

  private breed(a: Creature, b: Creature | null): Creature {
    let g = b ? crossover(a.g, b.g, this.r) : { ...a.g };
    g = mutate(g, this.settings.mutationRate, this.r);
    g.size = Math.min(g.size, this.maxSize);
    const angle = this.r() * Math.PI * 2;
    let x = a.x + Math.cos(angle) * a.g.size * 2;
    let y = a.y + Math.sin(angle) * a.g.size * 2;
    if (!this.passable(g, this.terrain.index(x, y))) [x, y] = [a.x, a.y];
    const region = this.terrain.regionAt(x, y)?.name ?? 'море';
    const { species, isNew } = this.species.classify(g, b ? [a.sp, b.sp] : [a.sp], this.tick, region);
    const child = this.spawn(species.id, g, x, y);
    this.creatures.pop(); // добавим после тика

    const giftA = a.energy * a.g.generosity * (b ? 0.5 : 1);
    const giftB = b ? b.energy * b.g.generosity * 0.5 : 0;
    a.energy -= giftA;
    if (b) b.energy -= giftB;
    child.energy = (giftA + giftB) * 0.9;
    child.generation = Math.max(a.generation, b?.generation ?? 0) + 1;
    child.mother = a.id;
    child.father = b?.id ?? null;
    const rec = this.ancestors.get(child.id)!;
    rec.mother = a.id;
    rec.generation = child.generation;
    a.children++;
    if (b) b.children++;
    a.cooldown = 220;
    if (b) b.cooldown = 220;
    a.lonely = 0;
    if (b) b.lonely = 0;
    // материнские антитела: детёныш переболевшей матери первое время не заражается
    child.immune = a.immune > 0 ? DIS.MAT_IMM : 0;

    this.fx.push({ kind: b ? 'mate' : 'birth', x: a.x, y: a.y, hue: a.g.hue });
    if (isNew) {
        species.x = x;
      species.y = y;
    }
    if (a.player || b?.player) this.log(`👶 У вас родился потомок (поколение ${child.generation})`, 'player', x, y);
    return child;
  }

  /** Если какой-то трофический уровень пуст — с большой земли приплывают новые колонисты. */
  private migrantsFromAfar(): void {
    // гильдии: пловцы отдельно, иначе по диете (как в стенде scripts/bench.ts)
    const gc = [0, 0, 0, 0];
    for (const c of this.creatures) gc[guildOf(c.g)]++;
    const [herb, omni, meat, swim] = gc;
    const arrive = (base: Partial<Genome>, n: number, what: string) => {
      const sp = this.colonize(base, n);
      this.log(`⛵ С большой земли приплыли ${what}: «${sp.name}» (${n})`, 'migration');
    };
    const pickF = (f: (g: Partial<Genome>) => boolean) => {
      const list = FOUNDERS.filter((x) => f(x.g));
      return list[Math.floor(this.r() * list.length)].g;
    };
    if (this.env.landLife) {
      if (herb < 25) arrive(pickF((g) => (g.diet ?? 0) < 0.3 && (g.swim ?? 0) < 0.6), 30, 'травоядные');
      if (omni < 10) arrive(pickF((g) => g.diet === 0.45 || g.diet === 0.6), 20, 'всеядные');
      if (meat < 4 && herb + omni > 150) arrive(pickF((g) => (g.diet ?? 0) > 0.65), 8, 'хищники');
    }
    if (swim < 10) arrive(pickF((g) => (g.swim ?? 0) > 0.6), 20, 'морские травоядные');
  }

  // ---------------- инструменты и катастрофы ----------------

  meteor(x: number, y: number): void {
    const R = 160;
    let killed = 0;
    for (const c of this.creatures) {
      if (c.alive && Math.hypot(c.x - x, c.y - y) < R) {
        this.die(c, 'метеорит', false);
        killed++;
      }
    }
    this.creatures = this.creatures.filter((c) => c.alive);
    const t = this.terrain;
    for (let cy = Math.max(0, Math.floor((y - R * 1.3) / this.cell)); cy <= Math.min(t.rows - 1, (y + R * 1.3) / this.cell); cy++) {
      for (let cx = Math.max(0, Math.floor((x - R * 1.3) / this.cell)); cx <= Math.min(t.cols - 1, (x + R * 1.3) / this.cell); cx++) {
        if (Math.hypot((cx + 0.5) * this.cell - x, (cy + 0.5) * this.cell - y) < R * 1.3) {
          const i = cy * t.cols + cx;
          this.grass[i] = 0;
          // пепел и сгоревшая биомасса; микробы и микориза погибли — первыми вернутся азотфиксаторы
          this.soil[i] *= 0.5;
          this.litter[i] = Math.min(SOIL.LMAX, this.litter[i] + 0.4);
          this.mic[i] = 0.03;
          this.fix[i] = 0.03;
          this.myc[i] = 0;
        }
      }
    }
    this.micro.lastMeteor = { x, y, tick: this.tick };
    this.fx.push({ kind: 'meteor', x, y, hue: 30 });
    this.log(`☄️ Метеорит упал на «${t.regionAt(x, y)?.name ?? 'море'}». Погибло: ${killed}`, 'disaster', x, y);
  }

  startDrought(): void {
    this.drought = YEAR / 3;
    this.log('🔥 Засуха — трава почти не растёт.', 'disaster');
  }

  /** Инструмент «эпидемия»: новая болезнь у самого многочисленного вида (доля DIS.TOOL_SHARE). */
  epidemic(): void {
    const top = this.species.living()[0];
    if (!top) return;
    if (this.settings.disease) {
      // новая болезнь: заражаем долю вида злым штаммом — дальше волна идёт сама
      const hosts = this.creatures.filter((c) => c.alive && c.sp === top.id);
      if (!hosts.length) return;
      // против нового штамма иммунитета нет ни у кого
      let oldSick = 0;
      for (const c of hosts) {
        c.immune = 0;
        if (c.sick > 0) oldSick++;
      }
      // прежняя вспышка вида — молча в архив; её больные дальше считаются за новую болезнь
      const old = this.pathogens.get(top.id);
      if (old) {
        old.cases -= oldSick;
        this.endPathogen(old, true);
      }
      const first = hosts[Math.floor(this.r() * hosts.length)];
      const P = this.newPathogen(top.id, first.x, first.y, DIS.TOOL_VIR);
      P.cases = oldSick;
      const k = Math.min(hosts.length, Math.max(5, Math.round(DIS.TOOL_SHARE * hosts.length)));
      for (let i = 0; i < k; i++) {
        // частичная перетасовка Фишера — Йетса: k разных особей
        const j = i + Math.floor(this.r() * (hosts.length - i));
        const c = hosts[j];
        hosts[j] = hosts[i];
        hosts[i] = c;
        if (c.sick === 0) this.infect(c, DIS.TOOL_VIR);
      }
      this.boost.set(top.id, this.tick + DIS.BOOST_T);
      this.announcePathogen(P, false); // запись в летопись — ниже, своя
      this.log(`🦠 Новая болезнь «${P.name}» среди «${top.name}» — против неё ни у кого нет иммунитета`, 'disaster', P.x, P.y);
      return;
    }
    let killed = 0;
    for (const c of this.creatures) {
      if (c.sp === top.id && this.r() < 0.6) {
        this.die(c, 'эпидемия');
        killed++;
      }
    }
    this.creatures = this.creatures.filter((c) => c.alive);
    this.log(`🦠 Эпидемия среди «${top.name}»: погибло ${killed}`, 'disaster');
  }

  paintGrass(x: number, y: number, r: number): void {
    const t = this.terrain;
    for (let cy = Math.max(0, Math.floor((y - r) / this.cell)); cy <= Math.min(t.rows - 1, (y + r) / this.cell); cy++) {
      for (let cx = Math.max(0, Math.floor((x - r) / this.cell)); cx <= Math.min(t.cols - 1, (x + r) / this.cell); cx++) {
        const i = cy * t.cols + cx;
        if (Math.hypot((cx + 0.5) * this.cell - x, (cy + 0.5) * this.cell - y) < r) {
          this.grass[i] = Math.min(1, this.grass[i] + 0.3);
          this.soil[i] = Math.min(SOIL.SMAX, this.soil[i] + 0.15); // сажаем с удобрением
        }
      }
    }
  }

  // ---------------- машина времени ----------------

  /** Новые «кости»: перемешать поток мира и потоки всех особей (мир тот же — дальше другой случай). */
  reseed(salt: number): void {
    const k = Math.imul(salt | 0, 0x9e3779b9);
    this.rng = mix32(this.rng ^ k);
    for (const c of this.creatures) c.rs = mix32(c.rs ^ k ^ c.id);
    if (this.player && !this.player.alive) this.player.rs = mix32(this.player.rs ^ k);
  }

  /**
   * Действие игрока или урока (между шагами, на костях мира). Страница и машина времени меняют мир только так
   * (плюс ввод и настройки, которые машина времени записывает сама): тогда перемотка повторяет историю точно.
   */
  apply(a: Action): void {
    if (this.ctx) throw new Error('World.apply во время хода особи');
    switch (a.k) {
      case 'meteor':
        this.meteor(a.x, a.y);
        break;
      case 'drought':
        this.startDrought();
        break;
      case 'epidemic':
        this.epidemic();
        break;
      case 'grass':
        for (let i = 0; i + 1 < a.pts.length; i += 2) this.paintGrass(a.pts[i], a.pts[i + 1], a.r);
        break;
      case 'spawn': {
        const sp = this.colonize({ ...a.g, hue: this.r() * 360 }, a.n, a.x, a.y);
        this.log(`${a.icon} Вы поселили группу: «${sp.name}» (${a.n})`, 'player', a.x, a.y);
        break;
      }
      case 'possess':
        if (a.id === null) this.possess(null);
        else {
          const c = this.creatures.find((o) => o.id === a.id && o.alive);
          if (c) this.possess(c);
        }
        break;
      case 'settings':
        Object.assign(this.settings, a.s);
        break;
      case 'experiment': {
        const was = this.experiment.noDecomposers;
        Object.assign(this.experiment, a.e);
        if (!a.quiet && was !== this.experiment.noDecomposers)
          this.log(this.experiment.noDecomposers ? '🧫 Опыт: бактерии и грибы почвы выключены' : '🧫 Опыт окончен: бактерии и грибы снова работают', this.experiment.noDecomposers ? 'disaster' : 'info');
        break;
      }
      case 'rescue':
        this.rescue(a.sp, a.n);
        break;
      case 'remove':
        this.removeSpecies(a.sp);
        break;
      case 'nudge': {
        const c = this.creatures.find((o) => o.id === a.id);
        if (c) c.x += a.dx;
        break;
      }
      case 'reseed':
        this.reseed(a.salt);
        break;
      case 'resource':
        this.removeResource(a.kind, a.ticks);
        break;
      case 'restoreRes':
        this.restoreResource(a.kind);
        break;
      case 'undo':
        break;
    }
  }

  /** «Спасти вид»: n новых особей рядом с живыми сородичами (или, если вид уже вымер, — из его средних генов). */
  private rescue(spId: number, n: number): void {
    const sp = this.species.all.get(spId);
    if (!sp || n <= 0) return;
    const m = this.creatures.filter((c) => c.alive && c.sp === spId);
    let x: number, y: number;
    if (m.length) {
      for (let i = 0; i < n; i++) {
        const c = m[(this.r() * m.length) | 0];
        const g = mutate(c.g, 0.02, this.r);
        const [px, py] = this.nearbyLand(c.x, c.y, 40, g);
        const ch = this.spawn(spId, g, px, py);
        ch.generation = c.generation;
        ch.mother = c.id;
        const rec = this.ancestors.get(ch.id)!;
        rec.mother = c.id;
        rec.generation = c.generation;
      }
      ({ x, y } = m[0]);
    } else {
      const g0 = genome({ ...sp.mean, hue: sp.founder.hue, pattern: sp.founder.pattern }, this.brainMode === 'neural', this.r);
      [x, y] = this.findHome(g0);
      for (let i = 0; i < n; i++) {
        const g = mutate(g0, 0.02, this.r);
        const [px, py] = this.nearbyLand(x, y, 120, g);
        this.spawn(spId, g, px, py);
      }
      sp.extinct = null; // вид снова живой: его численность снова считается
    }
    this.log(`🧬 Вы спасли «${sp.name}»: +${n}`, 'player', x, y);
  }

  /** «Убрать вид»: все его особи исчезают с острова (без туш). */
  private removeSpecies(spId: number): void {
    const sp = this.species.all.get(spId);
    if (!sp) return;
    for (const c of this.creatures) if (c.alive && c.sp === spId) this.die(c, 'вмешательство', false);
    this.creatures = this.creatures.filter((c) => c.alive);
    this.log(`🚫 Вы убрали «${sp.name}» с острова`, 'player');
  }

  /** Точный снимок мира (между шагами). */
  captureState(): WorldSnap {
    return captureWorld(this as unknown as WorldInternals);
  }

  /** Вернуть мир в снимок (тот же seed, env и размеры). `history` — графики из архива машины времени. */
  loadState(s: WorldSnap, history: Sample[] = []): void {
    loadWorld(this as unknown as WorldInternals, s, history);
  }

  // ---------------- игрок ----------------

  possess(c: Creature | null): void {
    if (this.player) this.player.player = false;
    this.player = c;
    if (c) {
      c.player = true;
      this.playerStats.possessed++;
      this.playerStats.generation = Math.max(this.playerStats.generation, c.generation);
      this.log(`👑 Вы вселились в особь #${c.id} («${this.species.all.get(c.sp)?.name}»)`, 'player', c.x, c.y);
    }
  }

  // ---------------- родословная ----------------

  private pruneAncestors(): void {
    const keep = new Set<number>();
    for (const c of this.creatures) {
      let id: number | null = c.id;
      while (id !== null && !keep.has(id)) {
        keep.add(id);
        id = this.ancestors.get(id)?.mother ?? null;
      }
    }
    if (this.player) keep.add(this.player.id);
    for (const id of this.ancestors.keys()) if (!keep.has(id)) this.ancestors.delete(id);
  }

  lineage(id: number, max = 12): Ancestor[] {
    const out: Ancestor[] = [];
    let cur = this.ancestors.get(id)?.mother ?? null;
    while (cur !== null && out.length < max) {
      const a = this.ancestors.get(cur);
      if (!a) break;
      out.push(a);
      cur = a.mother;
    }
    return out;
  }

  descendants(id: number): Creature[] {
    const memo = new Map<number, boolean>([[id, true]]);
    const isDesc = (start: number | null): boolean => {
      const path: number[] = [];
      let cur = start;
      let found = false;
      while (cur !== null) {
        const m = memo.get(cur);
        if (m !== undefined) {
          found = m;
          break;
        }
        path.push(cur);
        cur = this.ancestors.get(cur)?.mother ?? null;
      }
      for (const p of path) memo.set(p, found);
      return found;
    };
    return this.creatures.filter((c) => c.id !== id && (isDesc(c.mother) || (c.father !== null && isDesc(c.father))));
  }

  // ---------------- статистика ----------------

  log(text: string, kind: WorldEvent['kind'], x?: number, y?: number): void {
    this.events.push({ tick: this.tick, text, kind, x, y });
    if (this.events.length > 120) this.events.shift();
  }

  private record(): void {
    const disOn = this.settings.disease;
    const counts = new Map<number, number>();
    const sums = new Map<number, Record<GeneKey, number>>();
    // больные по видам: число, сумма v и v²
    const sickN = new Map<number, number>();
    const sickV = new Map<number, number>();
    const sickV2 = new Map<number, number>();
    let sickAll = 0;
    for (const c of this.creatures) {
      counts.set(c.sp, (counts.get(c.sp) ?? 0) + 1);
      if (c.sick > 0) {
        sickAll++;
        sickN.set(c.sp, (sickN.get(c.sp) ?? 0) + 1);
        sickV.set(c.sp, (sickV.get(c.sp) ?? 0) + c.vir);
        sickV2.set(c.sp, (sickV2.get(c.sp) ?? 0) + c.vir * c.vir);
      }
      let s = sums.get(c.sp);
      if (!s) sums.set(c.sp, (s = Object.fromEntries(GENE_KEYS.map((k) => [k, 0])) as Record<GeneKey, number>));
      for (const k of GENE_KEYS) s[k] += c.g[k];
    }
    // освоение новых регионов
    if (this.tick % 200 === 0) {
      const presence = new Map<string, number>();
      for (const c of this.creatures) {
        const r = this.terrain.regionAt(c.x, c.y);
        if (!r) continue;
        const key = `${c.sp}:${r.id}`;
        presence.set(key, (presence.get(key) ?? 0) + 1);
      }
      for (const [key, n] of presence) {
        if (n < 4) continue;
        const [spId, rId] = key.split(':').map(Number);
        const sp = this.species.all.get(spId);
        if (!sp || sp.regions.has(rId)) continue;
        const first = sp.regions.size === 0;
        sp.regions.add(rId);
        const region = this.terrain.regions[rId];
        if (!first && this.tick > 400) this.log(`🧭 «${sp.name}» пришли в регион «${region.name}»`, 'migration', region.cx, region.cy);
      }
    }
    for (const sp of this.species.all.values()) {
      if (sp.extinct !== null) continue;
      const n = counts.get(sp.id) ?? 0;
      sp.count = n;
      sp.peak = Math.max(sp.peak, n);
      const risk = this.crowding(sp.id);
      if (!disOn) {
        if (risk > 0) this.crowdRisk.set(sp.id, risk);
        else this.crowdRisk.delete(sp.id);
      } else {
        // бюджет тесноты (n·crowding) целиком тратится на больных, остаток — на здоровых: смертей не больше, чем было
        const ns = sickN.get(sp.id) ?? 0;
        const want = risk * n;
        if (ns > 0) {
          let sr = Math.min(DIS.RISK_CAP, want / ns);
          if ((this.boost.get(sp.id) ?? 0) > this.tick) sr = Math.max(sr, DIS.BOOST_RISK); // только инструмент «эпидемия»
          else this.boost.delete(sp.id);
          this.sickRisk.set(sp.id, sr);
          this.meanV2.set(sp.id, sickV2.get(sp.id)! / ns);
          const rest = n > ns ? Math.max(0, want - sr * ns) / (n - ns) : 0;
          if (rest > 0) this.healthyRisk.set(sp.id, rest);
          else this.healthyRisk.delete(sp.id);
        } else {
          this.sickRisk.delete(sp.id);
          this.meanV2.delete(sp.id);
          if ((this.boost.get(sp.id) ?? Infinity) <= this.tick) this.boost.delete(sp.id);
          if (risk > 0) this.healthyRisk.set(sp.id, risk);
          else this.healthyRisk.delete(sp.id);
        }
      }
      if (n > 600 && !sp.crowded) {
        sp.crowded = true;
        this.log(`🦠 «${sp.name}» слишком расплодились — среди них гуляют болезни`, 'disaster');
      } else if (n < 300) sp.crowded = false;
      if (!sp.announced && n >= 8) {
        sp.announced = true;
        if (this.tick > 100) {
          const parent = sp.parent ? this.species.all.get(sp.parent) : null;
          this.log(`🧬 Новый вид: «${sp.name}»${parent ? ` — потомок «${parent.name}»` : ''}`, 'species', sp.x, sp.y);
          this.fx.push({ kind: 'newSpecies', x: sp.x, y: sp.y, hue: sp.hue });
        }
      }
      const s = sums.get(sp.id);
      if (s) for (const k of GENE_KEYS) sp.mean[k] = s[k] / n;
      if (n === 0 && this.tick - sp.born > 40) {
        sp.extinct = this.tick;
        this.meanV2.delete(sp.id);
        this.boost.delete(sp.id);
        this.sickRisk.delete(sp.id);
        this.healthyRisk.delete(sp.id);
        this.crowdRisk.delete(sp.id);
        if (sp.peak >= 10) this.log(`💀 Вид «${sp.name}» вымер (на пике было ${sp.peak})`, 'extinct');
      }
    }
    this.micro.sick = sickAll;
    if (disOn) this.trackPathogens(sickN, sickV);
    // связи затухают — пищевая сеть показывает «что происходит сейчас»
    for (const [k, v] of this.web) {
      const nv = v * 0.97;
      if (nv < 0.01) this.web.delete(k);
      else this.web.set(k, nv);
    }
    const means = new Map<number, Record<GeneKey, number>>();
    for (const id of sums.keys()) means.set(id, { ...this.species.all.get(id)!.mean });
    let grass = 0;
    for (let i = 0; i < this.grass.length; i++) grass += this.grass[i];
    // почва — по каждой 4-й клетке, сдвиг выборки меняется от записи к записи
    const S = this.soil, W = this.isWater, t = this.terrain;
    let sl = 0, ll = 0, ml = 0, fl = 0, nl = 0, my = 0, nm = 0, pl = 0, nw = 0;
    for (let i = (this.tick / 20) & 3; i < S.length; i += 4) {
      if (W[i] === 1) {
        pl += (this.grass[i] / BIOMES[t.biome[i]].fert) * this.nut[i];
        nw++;
        continue;
      }
      const s = S[i];
      sl += (1.5 * s) / (s + 0.5);
      ll += this.litter[i];
      ml += this.mic[i];
      fl += this.fix[i];
      nl++;
      if (W[i] === 2) {
        my += this.myc[i];
        nm++;
      }
    }
    const nl1 = Math.max(1, nl);
    // пищевая сеть: разложители едят падаль и опад, опад кормит траву
    const fl0 = this.flux;
    // (множители подобраны так, чтобы стрелки были толщиной со среднюю стрелку «вид > трава»)
    if (fl0.corpseDecay > 0) this.bump(-4, -1, fl0.corpseDecay * 0.015);
    if (fl0.decomp > 0) this.bump(-4, -5, fl0.decomp * 0.3);
    if (fl0.litterIn > 0) this.bump(-5, 0, fl0.litterIn * 1.6);
    // весеннее цветение: планктон заметно выше зимнего минимума — запись раз в год
    const bloom = nw ? pl / nw : 0;
    if (nw && this.settings.seasons) {
      const ph = this.season.phase;
      if (ph >= 0.75) this.bloomMin = Math.min(this.bloomMin, bloom);
      else if (ph >= 0.05 && ph <= 0.35 && this.year !== this.bloomYear && bloom > 1.15 * this.bloomMin) {
        this.bloomYear = this.year;
        this.bloomMin = Infinity;
        this.log('🌊 У берегов зацвёл планктон — весеннее цветение', 'micro');
      } else if (ph > 0.35 && ph < 0.75) this.bloomMin = Infinity;
    }
    // потоки круговорота: сглаживаем окно в 20 тактов
    const fe = this.fluxEma;
    for (const k in this.flux) {
      const key = k as keyof World['flux'];
      fe[key] += (this.flux[key] - fe[key]) * 0.05;
      this.flux[key] = 0;
    }
    this.history.push({
      tick: this.tick,
      counts,
      means,
      grass: grass / this.grass.length,
      soil: sl / nl1 / this.nutRef.land,
      litter: ll / nl1,
      mic: ml / nl1,
      fix: fl / nl1,
      myc: nm ? my / nm : 0,
      plankton: nw ? pl / nw : 0,
      sick: sickAll,
      co2: 0,
    });
    if (this.history.length > 900) this.history.shift();
  }

  // ---------------- опыты для уроков 📚 (по умолчанию ничего не меняют) ----------------

  private lessonTerrain: Terrain | null = null;
  private lessonGen = 0;
  /** Растёт после каждого reset() (новый мир = новый рельеф) — уроки замечают «↻ Новый мир». */
  get resetGen(): number {
    if (this.lessonTerrain !== this.terrain) {
      this.lessonTerrain = this.terrain;
      this.lessonGen++;
    }
    return this.lessonGen;
  }

  /** До какого такта корм не отрастает (0 — растёт как обычно). Действует только в том мире, где опыт начат. */
  blocked = { browse: 0, forage: 0 };
  private blockedTerrain: Terrain | null = null;

  /** Опыт: убрать листву или ягоды и не давать им отрастать `ticks` тактов. */
  removeResource(kind: 'browse' | 'forage', ticks: number): void {
    if (this.blockedTerrain !== this.terrain) this.blocked = { browse: 0, forage: 0 };
    this.blockedTerrain = this.terrain;
    this[kind].fill(0);
    this.blocked[kind] = this.tick + ticks;
    this.log(kind === 'browse' ? '🍂 Опыт: листва исчезла' : '🫐 Опыт: ягоды и насекомые исчезли', 'disaster');
  }

  /** Вернуть корм досрочно (ничего не делает, если опыт уже кончился). */
  restoreResource(kind: 'browse' | 'forage'): void {
    if (this.blockedTerrain !== this.terrain || this.blocked[kind] <= this.tick) return;
    this.blocked[kind] = 0;
    this.log('🌿 Опыт окончен: корм снова растёт', 'info');
  }

  /** Опыт ещё идёт — этот корм не отрастает (вызывается из growGrass раз за такт, до кормёжки зверей). */
  private blockActive(k: 'browse' | 'forage'): boolean {
    if (!this.blocked[k]) return false;
    if (this.blockedTerrain !== this.terrain) {
      this.blocked[k] = 0; // мир создан заново — опыт забыт
      return false;
    }
    if (this.tick < this.blocked[k]) return true;
    this.blocked[k] = 0;
    this.log('🌿 Опыт окончен: корм снова растёт', 'info');
    return false;
  }
}
