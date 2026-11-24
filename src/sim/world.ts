import { HID, IN, OUT, think as runBrain } from './brain';
import { crossover, distance, genome, GENE_KEYS, MATE_LIMIT, mutate, type GeneKey, type Genome } from './genome';
import { clamp } from './random';
import { SpeciesRegistry, type Species } from './species';
import { B, BIOMES, Terrain } from './terrain';

export type State = 'wander' | 'graze' | 'flee' | 'hunt' | 'mate' | 'scavenge' | 'migrate' | 'herd' | 'swim';

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
  { n: 50, g: { size: 6, speed: 1.1, sense: 60, diet: 0.05, tempPref: 0.2, social: 0.8, hue: 30 } },
  { n: 50, g: { size: 2.5, speed: 1.6, sense: 70, diet: 0.08, tempPref: 0.8, social: 0.2, hue: 50 } },
  { n: 30, g: { size: 4.5, speed: 1.2, sense: 55, diet: 0.15, tempPref: 0.55, swim: 0.8, social: 0.5, hue: 190 } },
  { n: 30, g: { size: 5, speed: 1.3, sense: 60, diet: 0.45, tempPref: 0.5, social: 0.3, hue: 280 } },
  { n: 16, g: { size: 6, speed: 1.7, sense: 85, diet: 0.9, tempPref: 0.5, social: 0.6, hue: 5 } },
  { n: 10, g: { size: 7, speed: 1.5, sense: 90, diet: 0.9, tempPref: 0.2, social: 0.2, hue: 220 } },
];

export class World {
  terrain!: Terrain;
  grass!: Float32Array;
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
  drought = 0;
  seed = 1;
  /** Ввод игрока: направление и бег. */
  input = { dx: 0, dy: 0, run: false };
  player: Creature | null = null;
  playerStats = { generation: 0, possessed: 0, deaths: 0 };

  private nextId = 1;
  private hash = new Map<number, Creature[]>();
  private nin = new Float32Array(IN);
  private nout = new Float32Array(OUT);

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell = 16,
  ) {
    this.reset();
  }

  reset(mode: BrainMode = this.brainMode, seed = (Math.random() * 1e9) | 0): void {
    this.brainMode = mode;
    this.seed = seed;
    this.terrain = new Terrain(this.width, this.height, this.cell, seed);
    this.grass = new Float32Array(this.terrain.cols * this.terrain.rows);
    for (let i = 0; i < this.grass.length; i++) this.grass[i] = this.maxGrass(i) * Math.random();
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
    for (const f of FOUNDERS) this.colonize(f.g, mode === 'neural' ? Math.round(f.n * 1.5) : f.n);
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
      const score = -Math.abs(this.temp(idx) - g.tempPref) * 3 + this.maxGrass(idx) * (1 - g.diet) + (g.swim > 0.6 && BIOMES[this.terrain.biome[idx]].water ? 0.5 : 0);
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
    const shift = 0.16 * Math.sin(phase * Math.PI * 2);
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
    return (this.tick % DAY) / DAY;
  }

  /** Насколько светло, 0..1. */
  get daylight(): number {
    return clamp(0.5 - 0.5 * Math.cos(this.dayTime * Math.PI * 2) + 0.15, 0, 1);
  }

  get year(): number {
    return Math.floor(this.tick / YEAR) + 1;
  }

  temp(idx: number): number {
    return this.terrain.baseTemp[idx] + this.season.shift;
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
    const pack = 1 + Math.min(0.8, a.pack * 0.25 * a.g.social);
    return b.g.size < a.g.size * (0.45 + a.g.diet * 0.75) * pack;
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
    const base = 0.05 * m;
    const muscles = 0.01 * m * speed * speed;
    const move = 0.008 * m * v * v;
    const eyes = 0.0008 * sense;
    const gills = 0.012 * swim * m;
    const d = Math.max(0, Math.abs(this.temp(idx) - c.g.tempPref) - 0.1);
    const climate = 0.6 * m * d * d;
    const b = this.terrain.biome[idx];
    const wet = b === B.Deep || b === B.Shallow ? 0.03 * m * v * v * (1 - swim) : 0;
    return base + muscles + move + eyes + gills + climate + wet;
  }

  // ---------------- пространственный хеш ----------------

  private buildHash(): void {
    this.hash.clear();
    for (const c of this.creatures) {
      const k = Math.floor(c.x / HASH) * 4096 + Math.floor(c.y / HASH);
      let bucket = this.hash.get(k);
      if (!bucket) this.hash.set(k, (bucket = []));
      bucket.push(c);
    }
  }

  forNear(x: number, y: number, r: number, fn: (o: Creature, d2: number) => void): void {
    const r2 = r * r;
    const x0 = Math.floor((x - r) / HASH);
    const x1 = Math.floor((x + r) / HASH);
    const y0 = Math.floor((y - r) / HASH);
    const y1 = Math.floor((y + r) / HASH);
    for (let hx = x0; hx <= x1; hx++) {
      for (let hy = y0; hy <= y1; hy++) {
        const bucket = this.hash.get(hx * 4096 + hy);
        if (!bucket) continue;
        for (const o of bucket) {
          const d2 = (o.x - x) ** 2 + (o.y - y) ** 2;
          if (d2 < r2) fn(o, d2);
        }
      }
    }
  }

  creatureAt(x: number, y: number, slack = 8): Creature | null {
    let best: Creature | null = null;
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
    let threat: Creature | null = null;
    let threatD = Infinity;
    let prey: Creature | null = null;
    let preyD = Infinity;
    let mate: Creature | null = null;
    let mateD = Infinity;
    let fx = 0;
    let fy = 0;
    let hx = 0;
    let hy = 0;
    let n = 0;
    let alarm: Creature | null = null;
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
      if (d2 < threatD && this.canEat(o, c)) {
        threatD = d2;
        threat = o;
      } else if (hungry && d2 < preyD && this.canEat(c, o)) {
        // не гонимся за теми, кто заметно быстрее, если они не совсем рядом
        if (o.g.speed < c.g.speed * 1.1 || d2 < 900) {
          preyD = d2;
          prey = o;
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
      if (c.energy <= 0) this.die(c, 'голод');
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
    const rate = 0.0016 * this.settings.grassGrowth * (this.drought > 0 ? 0.1 : 1);
    const shift = this.season.shift;
    const g = this.grass;
    // трава обновляется частями: каждый тик — каждая 4-я клетка (×4 рост), так в 4 раза дешевле
    const phase = this.tick & 3;
    for (let i = phase; i < g.length; i += 4) {
      const temp = t.baseTemp[i] + shift;
      const max = BIOMES[t.biome[i]].fert;
      if (temp < 0.12) {
        g[i] *= 0.994; // мороз — трава вянет
        continue;
      }
      const warm = clamp((temp - 0.12) * 4, 0, 1) * clamp((1.05 - temp) * 4, 0, 1);
      if (g[i] < max) g[i] = Math.min(max, g[i] + rate * 4 * max * warm);
    }
  }

  /** Лучшее направление: трава × съедобность − неуютная температура. */
  private scan(c: Creature, idx: number): { angle: number; score: number; dist: number; here: number } {
    const plant = this.plantValue(c);
    const scoreAt = (i: number) => {
      if (!this.passable(c.g, i)) return -Infinity;
      const d = Math.abs(this.temp(i) - c.g.tempPref);
      return this.grass[i] * plant - d * d * 3;
    };
    const here = scoreAt(idx);
    let best = { angle: c.heading, score: here, dist: 0, here };
    const r = c.g.sense;
    for (let i = 0; i < 6; i++) {
      const a = c.heading + (Math.random() - 0.5) * Math.PI * 1.8;
      const d = r * (0.3 + Math.random() * 0.9);
      const x = c.x + Math.cos(a) * d;
      const y = c.y + Math.sin(a) * d;
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
      const s = scoreAt(this.terrain.index(x, y));
      if (s > best.score + 0.02) best = { angle: a, score: s, dist: d, here };
    }
    return best;
  }

  plantValue(c: Creature): number {
    return Math.pow(1 - c.g.diet, 1.5);
  }

  private nearestCorpse(c: Creature, r: number): Corpse | null {
    if (c.g.diet < 0.3) return null;
    let best: Corpse | null = null;
    let bestD = r * r;
    for (const k of this.corpses) {
      const d = (k.x - c.x) ** 2 + (k.y - c.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
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
    } else if (this.grass[idx] * this.plantValue(c) > 0.2) {
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
    inp[9] = this.grass[idx] * this.plantValue(c);
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
    // трава
    const plant = this.plantValue(c);
    if (plant > 0.02) {
      const bite = Math.min(this.grass[idx], 0.012 * c.g.size * Math.sqrt(c.g.size));
      if (bite > 0) {
        this.grass[idx] -= bite;
        c.energy += bite * 42 * plant;
        this.bump(c.sp, 0, bite * 0.2);
      }
    }
    if (c.g.diet < 0.3) return;
    const meat = Math.pow(c.g.diet, 0.7);
    // охота: касание = поймал
    const target = prey && prey.alive ? prey : null;
    if (target) {
      const r = c.g.size + target.g.size + 2;
      if ((target.x - c.x) ** 2 + (target.y - c.y) ** 2 < r * r && this.canEat(c, target)) {
        this.die(target, `съеден (${this.species.all.get(c.sp)?.name ?? 'хищник'})`, false);
        c.energy += (target.energy + this.maxEnergy(target.g) * 0.5) * meat;
        c.kills++;
        this.bump(c.sp, target.sp, 1);
        this.fx.push({ kind: 'kill', x: target.x, y: target.y, hue: target.g.hue });
      }
    }
    // падаль
    for (const k of this.corpses) {
      if (k.energy <= 0) continue;
      const r = c.g.size + k.size + 2;
      if ((k.x - c.x) ** 2 + (k.y - c.y) ** 2 < r * r) {
        const bite = Math.min(k.energy, 2 + c.g.size * 1.5);
        k.energy -= bite;
        c.energy += bite * meat * 0.8;
        this.bump(c.sp, -1, bite * 0.01);
        break;
      }
    }
  }

  private bump(pred: number, prey: number, v: number): void {
    const key = `${pred}>${prey}`;
    this.web.set(key, (this.web.get(key) ?? 0) + v);
  }

  private breed(a: Creature, b: Creature | null): Creature {
    let g = b ? crossover(a.g, b.g) : { ...a.g };
    g = mutate(g, this.settings.mutationRate);
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
    let plants = 0;
    let meat = 0;
    for (const c of this.creatures) c.g.diet < 0.5 ? plants++ : meat++;
    const arrive = (base: Partial<Genome>, n: number, what: string) => {
      const sp = this.colonize(base, n);
      this.log(`⛵ С большой земли приплыли ${what}: «${sp.name}» (${n})`, 'migration');
    };
    if (plants < 40) arrive(FOUNDERS[Math.floor(Math.random() * 4)].g, 40, 'травоядные');
    if (meat < 4 && plants > 150) arrive(FOUNDERS[5 + Math.floor(Math.random() * 2)].g, 8, 'хищники');
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
