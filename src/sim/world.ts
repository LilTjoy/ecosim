import { HID, IN, OUT, think as runBrain } from './brain';
import { crossover, distance, genome, GENE_KEYS, MATE_LIMIT, mutate, type GeneKey, type Genome } from './genome';
import { clamp } from '../lib/random';
import { SpeciesRegistry, type Species } from './species';
import { B, BIOMES, Terrain } from './terrain';

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
}

export interface Corpse {
  x: number;
  y: number;
  energy: number;
  size: number;
  hue: number;
  age: number;
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
  kind: 'extinct' | 'disaster' | 'milestone' | 'info' | 'species' | 'migration' | 'player';
  x?: number;
  y?: number;
}

/** Мгновенные события для визуальных эффектов (сердечки, вспышки и т.п.). */
export interface Fx {
  kind: 'birth' | 'mate' | 'kill' | 'meteor' | 'newSpecies';
  x: number;
  y: number;
  hue: number;
}

export interface Sample {
  tick: number;
  counts: Map<number, number>;
  means: Map<number, Record<GeneKey, number>>;
  grass: number;
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
  settings: Settings = { mutationRate: 0.08, grassGrowth: 1, seasons: true };
  brainMode: BrainMode = 'rules';
  env: SurfaceEnv = EARTH_ENV;
  drought = 0;
  seed = 1;
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
  private nin = new Float32Array(IN);
  private nout = new Float32Array(OUT);

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell = 16,
  ) {
    this.reset();
  }

  reset(mode: BrainMode = this.brainMode, seed = (Math.random() * 1e9) | 0, env: SurfaceEnv = this.env): void {
    this.brainMode = mode;
    this.seed = seed;
    this.env = env;
    this.terrain = new Terrain(this.width, this.height, this.cell, seed, env.sea, env.tempOffset, env.volcanism ?? 1);
    this.grass = new Float32Array(this.terrain.cols * this.terrain.rows);
    this.claim = new Float32Array(this.grass.length);
    this.claimTick = new Int32Array(this.grass.length).fill(-10);
    this.browse = new Float32Array(this.grass.length);
    this.forage = new Float32Array(this.grass.length);
    for (let i = 0; i < this.grass.length; i++) {
      const b = BIOMES[this.terrain.biome[i]];
      this.grass[i] = b.fert * Math.random();
      this.browse[i] = b.browse * (0.5 + Math.random() * 0.5);
      this.forage[i] = b.forage * Math.random();
    }
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

  /** Поселить группу одинаковых особей туда, где им комфортно. */
  colonize(base: Partial<Genome>, n: number, x?: number, y?: number): Species {
    const neural = this.brainMode === 'neural';
    const g0 = genome(base, neural);
    let cx = x;
    let cy = y;
    if (cx === undefined || cy === undefined) [cx, cy] = this.findHome(g0);
    const region = this.terrain.regionAt(cx, cy)?.name ?? 'неизвестные земли';
    // основатели — всегда отдельный вид; пришельцы присоединяются к очень близкому родственнику
    const sp = this.tick === 0 ? this.species.create(g0, null, 0, region) : this.species.match(g0, this.tick, region);
    for (let i = 0; i < n; i++) {
      const g = mutate(g0, 0.03);
      if (neural) g.brain = genome({}, true).brain;
      g.hue = g0.hue + (Math.random() - 0.5) * 10;
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
      const x = Math.random() * this.width;
      const y = Math.random() * this.height;
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
      const px = clamp(x + (Math.random() - 0.5) * 2 * r, 0, this.width - 1);
      const py = clamp(y + (Math.random() - 0.5) * 2 * r, 0, this.height - 1);
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
    const c: Creature = {
      id: this.nextId++,
      sp,
      g,
      x,
      y,
      heading: Math.random() * Math.PI * 2,
      v: 0,
      energy: this.maxEnergy(g) * 0.5,
      age: 0,
      generation: 0,
      mother: null,
      father: null,
      children: 0,
      kills: 0,
      alive: true,
      state: 'wander',
      cooldown: 0,
      cooldownHunt: 0,
      gx: 0,
      gy: 0,
      gt: 0,
      pv: Math.pow(1 - g.diet, 1.1),
      reachK: clamp((g.size - 4.5) / 3.5, 0, 1),
      fe: clamp(1 - Math.abs(g.diet - 0.45) * 2.6, 0, 1),
      lonely: 0,
      pack: 0,
      alarm: 0,
      activations: g.brain ? new Float32Array(IN + HID + OUT) : null,
      player: false,
      cause: null,
    };
    this.creatures.push(c);
    this.ancestors.set(c.id, { id: c.id, mother: null, sp, g, generation: 0, born: this.tick, died: null });
    return c;
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
    return { threat, threatD, prey, preyD, mate, mateD, n, fx, fy, hx, hy, alarm: alarm as Creature | null };
  }

  private senseRange(c: Creature, idx: number): number {
    const night = 0.65 + 0.35 * this.daylight;
    return c.g.sense * BIOMES[this.terrain.biome[idx]].sense * night;
  }

  // ---------------- шаг ----------------

  step(): void {
    this.tick++;
    this.shiftNow = this.season.shift;
    if (this.drought > 0 && --this.drought === 0) this.log('🌧 Засуха закончилась.', 'info');
    this.growGrass();
    this.buildHash();
    this.updateCorpses();

    const born: Creature[] = [];
    for (const c of this.creatures) {
      if (!c.alive) continue;
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
      const risk = this.crowdRisk.get(c.sp) ?? 0;
      if (c.energy <= 0) this.die(c, 'голод');
      else if (risk && Math.random() < risk) this.die(c, 'болезнь');
      else if (c.age > this.lifespan(c.g)) this.die(c, 'старость');
      else if (this.terrain.biome[idx2] === B.Deep && c.g.swim < 0.5) this.die(c, 'утонул');
    }

    this.creatures = this.creatures.filter((c) => c.alive);
    this.creatures.push(...born);

    if (this.tick % 20 === 0) this.record();
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
    if (corpse) this.corpses.push({ x: c.x, y: c.y, energy: this.maxEnergy(c.g) * 0.35 + Math.max(0, c.energy), size: c.g.size, hue: c.g.hue, age: 0 });
    if (c.player) {
      this.playerStats.deaths++;
      this.log(`👑 Ваше существо погибло (${cause}). Выберите потомка, чтобы продолжить династию.`, 'player', c.x, c.y);
    }
  }

  private updateCorpses(): void {
    for (const k of this.corpses) {
      k.age++;
      k.energy -= 0.3 + k.energy * 0.001;
    }
    if (this.tick % 10 === 0) this.corpses = this.corpses.filter((k) => k.energy > 0 && k.age < 1500);
  }

  private growGrass(): void {
    const t = this.terrain;
    const rate = 0.0024 * this.settings.grassGrowth * (this.drought > 0 ? 0.1 : 1);
    const br = this.browse;
    const fo = this.forage;
    const shift = this.shiftNow;
    const g = this.grass;
    // трава обновляется частями: каждый тик — каждая 4-я клетка (×4 рост), так в 4 раза дешевле
    const phase = this.tick & 3;
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
      if (br[i] < info.browse) br[i] = Math.min(info.browse, br[i] + rate * 1.2 * info.browse * warm);
      if (temp > 0.25 && fo[i] < info.forage) fo[i] = Math.min(info.forage, fo[i] + rate * 3 * info.forage * warm);
    }
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
      const a = Math.random() * Math.PI * 2;
      const d = r * (0.2 + Math.random() * 0.8);
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
      c.heading += (Math.random() - 0.5) * 0.5;
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
      if (!c.player) c.heading += Math.PI * (0.5 + Math.random());
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
      }
    }
    // листва: грубая пища, но её много — ниша гигантов
    const reach = this.reach(c) * this.plantValue(c);
    if (reach > 0.02 && this.browse[idx] > 0) {
      const bite = Math.min(this.browse[idx], 0.01 * Math.pow(c.g.size, 1.85) * reach);
      this.browse[idx] -= bite;
      c.energy += bite * 26 * Math.pow(c.g.size / 4, 0.3);
      this.bump(c.sp, -3, bite * 0.2);
    }
    // ягоды и насекомые: ценная пища для всеядных
    const fe = this.forageEff(c);
    if (fe > 0.02 && this.forage[idx] > 0) {
      const bite = Math.min(this.forage[idx], 0.006 * Math.pow(c.g.size, 1.5));
      this.forage[idx] -= bite;
      c.energy += bite * 28 * fe;
      this.bump(c.sp, -2, bite * 0.2);
    }
    if (c.g.diet < 0.3) return;
    // цена универсальности: всеядный переваривает мясо хуже настоящего хищника
    const meat = Math.pow(c.g.diet, 0.8);
    // охота: касание = поймал
    const target = prey && prey.alive ? prey : null;
    if (target) {
      const r = c.g.size + target.g.size + 2;
      if ((target.x - c.x) ** 2 + (target.y - c.y) ** 2 < r * r && this.canEat(c, target) && c.cooldownHunt <= 0) {
        if (Math.random() > this.captureChance(c, target)) {
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

  private bump(pred: number, prey: number, v: number): void {
    const key = `${pred}>${prey}`;
    this.web.set(key, (this.web.get(key) ?? 0) + v);
  }

  private breed(a: Creature, b: Creature | null): Creature {
    let g = b ? crossover(a.g, b.g) : { ...a.g };
    g = mutate(g, this.settings.mutationRate);
    g.size = Math.min(g.size, this.maxSize);
    const angle = Math.random() * Math.PI * 2;
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
    let herb = 0;
    let omni = 0;
    let meat = 0;
    let swim = 0;
    for (const c of this.creatures) {
      if (c.g.swim > 0.6) swim++;
      else if (c.g.diet < 0.3) herb++;
      else if (c.g.diet <= 0.65) omni++;
      else meat++;
    }
    const arrive = (base: Partial<Genome>, n: number, what: string) => {
      const sp = this.colonize(base, n);
      this.log(`⛵ С большой земли приплыли ${what}: «${sp.name}» (${n})`, 'migration');
    };
    const pickF = (f: (g: Partial<Genome>) => boolean) => {
      const list = FOUNDERS.filter((x) => f(x.g));
      return list[Math.floor(Math.random() * list.length)].g;
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
        if (Math.hypot((cx + 0.5) * this.cell - x, (cy + 0.5) * this.cell - y) < R * 1.3) this.grass[cy * t.cols + cx] = 0;
      }
    }
    this.fx.push({ kind: 'meteor', x, y, hue: 30 });
    this.log(`☄️ Метеорит упал на «${t.regionAt(x, y)?.name ?? 'море'}». Погибло: ${killed}`, 'disaster', x, y);
  }

  startDrought(): void {
    this.drought = YEAR / 3;
    this.log('🔥 Засуха — трава почти не растёт.', 'disaster');
  }

  epidemic(): void {
    const top = this.species.living()[0];
    if (!top) return;
    let killed = 0;
    for (const c of this.creatures) {
      if (c.sp === top.id && Math.random() < 0.6) {
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
        if (Math.hypot((cx + 0.5) * this.cell - x, (cy + 0.5) * this.cell - y) < r) this.grass[i] = Math.min(1, this.grass[i] + 0.3);
      }
    }
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
    const counts = new Map<number, number>();
    const sums = new Map<number, Record<GeneKey, number>>();
    for (const c of this.creatures) {
      counts.set(c.sp, (counts.get(c.sp) ?? 0) + 1);
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
      if (risk > 0) this.crowdRisk.set(sp.id, risk);
      else this.crowdRisk.delete(sp.id);
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
        if (sp.peak >= 10) this.log(`💀 Вид «${sp.name}» вымер (на пике было ${sp.peak})`, 'extinct');
      }
    }
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
    this.history.push({ tick: this.tick, counts, means, grass: grass / this.grass.length });
    if (this.history.length > 900) this.history.shift();
  }
}
