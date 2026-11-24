import { HID, IN, OUT, think as runBrain } from './brain';
import { defaultGenes, GENE_KEYS, mutate, SPECIES, SPECIES_INFO, type GeneKey, type Genes, type Species } from './genes';

export interface Creature {
  id: number;
  species: Species;
  genes: Genes;
  x: number;
  y: number;
  /** Направление движения, радианы. */
  heading: number;
  energy: number;
  age: number;
  generation: number;
  parentId: number | null;
  children: number;
  kills: number;
  alive: boolean;
  /** Что существо сейчас делает — для инспектора. */
  state: 'wander' | 'graze' | 'flee' | 'hunt';
  /** Последние активации нейросети (для визуализации). */
  activations: Float32Array | null;
}

/** Запись в родословной — переживает смерть особи, пока жив кто-то из потомков. */
export interface Ancestor {
  id: number;
  parentId: number | null;
  species: Species;
  genes: Genes;
  generation: number;
  born: number;
  died: number | null;
}

export type BrainMode = 'rules' | 'neural';

export interface Settings {
  mutationRate: number;
  grassGrowth: number;
  seasons: boolean;
}

export type GeneAvg = Record<GeneKey, number>;

export interface Sample {
  tick: number;
  count: Record<Species, number>;
  grass: number;
  genes: Record<Species, GeneAvg | null>;
}

export interface WorldEvent {
  tick: number;
  text: string;
  kind: 'extinct' | 'disaster' | 'milestone' | 'info';
}

export const YEAR = 4000; // тиков в году
export const DAY = 100;
const CELL = 16; // размер клетки травы
const HASH = 64; // размер ячейки пространственного хеша

export class World {
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
  /** Количество травы в клетке, 0..1. */
  grass: Float32Array;
  /** Плодородие клетки: 0 — пустыня, 1 — луг. */
  fertility: Float32Array;
  /** 1 — вода (непроходима). */
  water: Uint8Array;
  creatures: Creature[] = [];
  ancestors = new Map<number, Ancestor>();
  tick = 0;
  history: Sample[] = [];
  events: WorldEvent[] = [];
  settings: Settings = { mutationRate: 0.08, grassGrowth: 1, seasons: true };
  brainMode: BrainMode = 'rules';
  /** Тиков засухи осталось. */
  drought = 0;
  /** Гены последнего успешного родителя каждого вида — из них «рождаются» мигранты. */
  private champions: Partial<Record<Species, Genes>> = {};
  private maxGeneration: Record<Species, number> = { herb: 0, omni: 0, carn: 0 };

  private nextId = 1;
  private hash = new Map<number, Creature[]>();
  private input = new Float32Array(IN);
  private output = new Float32Array(OUT);

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / CELL);
    this.rows = Math.ceil(height / CELL);
    this.grass = new Float32Array(this.cols * this.rows);
    this.fertility = new Float32Array(this.cols * this.rows);
    this.water = new Uint8Array(this.cols * this.rows);
    this.reset();
  }

  reset(mode: BrainMode = this.brainMode): void {
    this.brainMode = mode;
    this.creatures = [];
    this.ancestors.clear();
    this.history = [];
    this.events = [];
    this.champions = {};
    this.maxGeneration = { herb: 0, omni: 0, carn: 0 };
    this.tick = 0;
    this.drought = 0;
    this.nextId = 1;
    this.generateTerrain();
    const neural = mode === 'neural';
    // со случайными мозгами многие погибнут сразу — стартуем с большей популяцией
    const k = neural ? 2 : 1;
    for (let i = 0; i < 110 * k; i++) this.spawnRandom('herb');
    for (let i = 0; i < 14 * k; i++) this.spawnRandom('omni');
    for (let i = 0; i < 10 * k; i++) this.spawnRandom('carn');
    this.log(neural ? 'Мир создан. Мозги случайные — посмотрим, кто научится выживать.' : 'Мир создан.', 'info');
  }

  get cellSize(): number {
    return CELL;
  }

  get season(): { name: string; icon: string; growth: number; winter: number; phase: number } {
    const phase = (this.tick % YEAR) / YEAR;
    if (!this.settings.seasons) return { name: 'Вечное лето', icon: '☀️', growth: 1, winter: 0, phase };
    // рост: максимум летом (phase 0.25), минимум зимой (phase 0.75)
    const s = Math.sin(phase * Math.PI * 2);
    const growth = 0.3 + 0.9 * (0.5 + 0.5 * s);
    const winter = Math.max(0, -s);
    const names = [
      ['Весна', '🌸'],
      ['Лето', '☀️'],
      ['Осень', '🍂'],
      ['Зима', '❄️'],
    ];
    const [name, icon] = names[Math.floor(phase * 4)];
    return { name, icon, growth, winter, phase };
  }

  get year(): number {
    return Math.floor(this.tick / YEAR) + 1;
  }

  // ---------------- рельеф ----------------

  /** Плодородие — сумма «пятен»; озёра — тоже пятна, вокруг них земля плодороднее. */
  private generateTerrain(): void {
    const blob = (rMin: number, rMax: number) => ({
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      r: rMin + Math.random() * (rMax - rMin),
    });
    const meadows = Array.from({ length: 9 }, () => blob(120, 340));
    const lakes = Array.from({ length: 2 + Math.floor(Math.random() * 2) }, () => blob(50, 110));
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const px = (cx + 0.5) * CELL;
        const py = (cy + 0.5) * CELL;
        const i = cy * this.cols + cx;
        let f = 0.08;
        for (const b of meadows) f += Math.exp(-((px - b.x) ** 2 + (py - b.y) ** 2) / (b.r * b.r));
        let wet = 0;
        for (const l of lakes) {
          // немного «рваный» край озера
          const wobble = 1 + 0.18 * Math.sin(Math.atan2(py - l.y, px - l.x) * 5 + l.r);
          wet = Math.max(wet, (l.r * wobble) / Math.hypot(px - l.x, py - l.y));
        }
        this.water[i] = wet > 1 ? 1 : 0;
        f += Math.max(0, wet - 0.4) * 0.8; // берега плодородны
        this.fertility[i] = this.water[i] ? 0 : Math.min(1, f);
        this.grass[i] = this.fertility[i] * Math.random();
      }
    }
  }

  grassIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / CELL)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / CELL)));
    return cy * this.cols + cx;
  }

  isWater(x: number, y: number): boolean {
    return this.water[this.grassIndex(x, y)] === 1;
  }

  private randomLand(): [number, number] {
    for (;;) {
      const x = Math.random() * this.width;
      const y = Math.random() * this.height;
      if (!this.isWater(x, y)) return [x, y];
    }
  }

  // ---------------- существа ----------------

  private spawnRandom(species: Species): Creature {
    const [x, y] = this.randomLand();
    return this.spawn(species, x, y);
  }

  spawn(species: Species, x: number, y: number, genes?: Genes): Creature {
    const g = genes ?? defaultGenes(species, this.brainMode === 'neural');
    const c: Creature = {
      id: this.nextId++,
      species,
      genes: g,
      x,
      y,
      heading: Math.random() * Math.PI * 2,
      energy: this.maxEnergy(g) * 0.5,
      age: 0,
      generation: 0,
      parentId: null,
      children: 0,
      kills: 0,
      alive: true,
      state: 'wander',
      activations: g.brain ? new Float32Array(IN + HID + OUT) : null,
    };
    this.creatures.push(c);
    this.ancestors.set(c.id, { id: c.id, parentId: null, species, genes: g, generation: 0, born: this.tick, died: null });
    return c;
  }

  maxEnergy(g: Genes): number {
    return 40 * g.size * g.size;
  }

  /** Сколько энергии существо тратит за тик при данной скорости. */
  private cost(c: Creature, v: number): number {
    const { size, sense, speed } = c.genes;
    const base = 0.02 * size * size; // обмен веществ
    const muscles = 0.004 * size * size * speed * speed; // содержание мышц — даже в покое
    const move = 0.004 * size * size * v * v; // движение
    const eyes = 0.0006 * sense; // мозг и глаза тоже стоят энергии
    const cold = this.season.winter * 0.004 * size * size; // зимой холодно
    return base + muscles + move + eyes + cold;
  }

  /** Может ли хищник `a` съесть `b`. */
  canEat(a: Creature, b: Creature): boolean {
    if (a.species === 'carn') {
      // крупного кабана хищнику не одолеть
      if (b.species === 'omni') return b.genes.size < a.genes.size * 0.9;
      return b.species === 'herb' && b.genes.size < a.genes.size * 1.5;
    }
    if (a.species === 'omni') return b.species === 'herb' && b.genes.size < a.genes.size * 0.9;
    return false;
  }

  private buildHash(): void {
    this.hash.clear();
    for (const c of this.creatures) {
      const k = Math.floor(c.x / HASH) * 100003 + Math.floor(c.y / HASH);
      let bucket = this.hash.get(k);
      if (!bucket) this.hash.set(k, (bucket = []));
      bucket.push(c);
    }
  }

  /** Ближайшее существо в радиусе r, подходящее под условие. */
  private nearest(c: Creature, r: number, pred: (o: Creature) => boolean): Creature | null {
    let best: Creature | null = null;
    let bestD = r * r;
    const x0 = Math.floor((c.x - r) / HASH);
    const x1 = Math.floor((c.x + r) / HASH);
    const y0 = Math.floor((c.y - r) / HASH);
    const y1 = Math.floor((c.y + r) / HASH);
    for (let hx = x0; hx <= x1; hx++) {
      for (let hy = y0; hy <= y1; hy++) {
        const bucket = this.hash.get(hx * 100003 + hy);
        if (!bucket) continue;
        for (const o of bucket) {
          if (!o.alive || o === c) continue;
          const d = (o.x - c.x) ** 2 + (o.y - c.y) ** 2;
          if (d < bestD && pred(o)) {
            bestD = d;
            best = o;
          }
        }
      }
    }
    return best;
  }

  creatureAt(x: number, y: number): Creature | null {
    let best: Creature | null = null;
    let bestD = Infinity;
    for (const c of this.creatures) {
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      const r = Math.max(c.genes.size + 6, 12);
      if (d < r * r && d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // ---------------- инструменты и катастрофы ----------------

  private forCells(x: number, y: number, radius: number, fn: (i: number, d: number) => void): void {
    const c0 = Math.max(0, Math.floor((x - radius) / CELL));
    const c1 = Math.min(this.cols - 1, Math.floor((x + radius) / CELL));
    const r0 = Math.max(0, Math.floor((y - radius) / CELL));
    const r1 = Math.min(this.rows - 1, Math.floor((y + radius) / CELL));
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const d = Math.hypot((cx + 0.5) * CELL - x, (cy + 0.5) * CELL - y);
        if (d < radius) fn(cy * this.cols + cx, d);
      }
    }
  }

  paintGrass(x: number, y: number, radius: number): void {
    this.forCells(x, y, radius, (i) => {
      if (this.water[i]) return;
      this.fertility[i] = Math.min(1, this.fertility[i] + 0.15);
      this.grass[i] = Math.min(1, this.grass[i] + 0.3);
    });
  }

  meteor(x: number, y: number): number {
    const R = 110;
    let killed = 0;
    for (const c of this.creatures) {
      if (Math.hypot(c.x - x, c.y - y) < R) {
        c.alive = false;
        killed++;
      }
    }
    this.creatures = this.creatures.filter((c) => c.alive);
    this.forCells(x, y, R * 1.3, (i) => (this.grass[i] = 0));
    this.log(`☄️ Метеорит! Погибло существ: ${killed}`, 'disaster');
    return killed;
  }

  startDrought(): void {
    this.drought = YEAR / 2;
    this.log('🔥 Началась засуха — трава почти не растёт.', 'disaster');
  }

  epidemic(): void {
    // болезнь бьёт по самому многочисленному виду: чем теснее живут, тем быстрее заражаются
    const counts = this.counts();
    const target = SPECIES.reduce((a, b) => (counts[a] >= counts[b] ? a : b));
    let killed = 0;
    for (const c of this.creatures) {
      if (c.species === target && Math.random() < 0.6) {
        c.alive = false;
        killed++;
      }
    }
    this.creatures = this.creatures.filter((c) => c.alive);
    this.log(`🦠 Эпидемия среди «${SPECIES_INFO[target].name.toLowerCase()}»: погибло ${killed}`, 'disaster');
  }

  // ---------------- шаг симуляции ----------------

  step(): void {
    this.tick++;
    if (this.drought > 0 && --this.drought === 0) this.log('🌧 Засуха закончилась.', 'info');
    this.growGrass();
    this.buildHash();

    const born: Creature[] = [];
    for (const c of this.creatures) {
      if (!c.alive) continue;
      const throttle = c.genes.brain ? this.thinkNeural(c) : this.thinkRules(c);
      const v = this.move(c, throttle);
      c.energy -= this.cost(c, v);
      c.age++;
      this.feed(c);

      const max = this.maxEnergy(c.genes);
      if (c.energy > max) c.energy = max;
      if (c.energy > max * 0.8 && c.age > 150) born.push(this.reproduce(c));
      const lifespan = c.species === 'herb' ? 4000 : 6000;
      if (c.energy <= 0 || c.age > lifespan) c.alive = false;
    }

    for (const c of this.creatures) if (!c.alive) this.ancestors.get(c.id)!.died = this.tick;
    this.creatures = this.creatures.filter((c) => c.alive);
    this.creatures.push(...born);

    if (this.tick % 600 === 0) this.migrants();
    if (this.tick % 10 === 0) this.record();
    if (this.tick % 1000 === 0) this.pruneAncestors();
  }

  private growGrass(): void {
    const rate = 0.0015 * this.settings.grassGrowth * this.season.growth * (this.drought > 0 ? 0.1 : 1);
    const g = this.grass;
    const f = this.fertility;
    for (let i = 0; i < g.length; i++) {
      if (g[i] < f[i]) g[i] = Math.min(f[i], g[i] + rate * f[i]);
    }
  }

  /** Лучшее направление на траву среди нескольких случайных точек в поле зрения. */
  private scanGrass(c: Creature): { angle: number; value: number; dist: number } {
    const here = this.grass[this.grassIndex(c.x, c.y)];
    let best = { angle: c.heading, value: here, dist: 0 };
    for (let i = 0; i < 6; i++) {
      const a = c.heading + (Math.random() - 0.5) * Math.PI * 1.6;
      const d = c.genes.sense * (0.3 + Math.random() * 0.7);
      const gx = c.x + Math.cos(a) * d;
      const gy = c.y + Math.sin(a) * d;
      if (gx < 0 || gy < 0 || gx >= this.width || gy >= this.height) continue;
      const v = this.grass[this.grassIndex(gx, gy)];
      if (v > best.value) best = { angle: a, value: v, dist: d };
    }
    return best;
  }

  private findThreat(c: Creature): Creature | null {
    if (c.species === 'carn') return null;
    return this.nearest(c, c.genes.sense, (o) => this.canEat(o, c));
  }

  private findPrey(c: Creature): Creature | null {
    if (c.species === 'herb') return null;
    return this.nearest(c, c.genes.sense, (o) => this.canEat(c, o));
  }

  /** Поведение по правилам. Возвращает «газ» 0..1. */
  private thinkRules(c: Creature): number {
    const threat = this.findThreat(c);
    if (threat) {
      c.heading = Math.atan2(c.y - threat.y, c.x - threat.x);
      c.state = 'flee';
      return 1;
    }
    const prey = this.findPrey(c);
    // всеядные не тратят силы на погоню за теми, кого не догнать
    if (prey && (c.species === 'carn' || prey.genes.speed < c.genes.speed)) {
      c.heading = Math.atan2(prey.y - c.y, prey.x - c.x);
      c.state = 'hunt';
      return 1;
    }
    if (c.species !== 'carn') {
      const here = this.grass[this.grassIndex(c.x, c.y)];
      if (here > 0.3) {
        c.state = 'graze';
        return 0.15;
      }
      const g = this.scanGrass(c);
      if (g.value > here) {
        c.heading = g.angle;
        c.state = 'graze';
        return 1;
      }
    }
    c.heading += (Math.random() - 0.5) * 0.6;
    c.state = 'wander';
    return 0.5;
  }

  /** Поведение нейросети: ей даются только «ощущения», решения принимает она сама. */
  private thinkNeural(c: Creature): number {
    const inp = this.input;
    inp.fill(0);
    const rel = (x: number, y: number, k: number) => {
      const a = Math.atan2(y - c.y, x - c.x) - c.heading;
      inp[k] = Math.sin(a);
      inp[k + 1] = Math.cos(a);
      inp[k + 2] = 1 - Math.hypot(x - c.x, y - c.y) / c.genes.sense;
    };
    const prey = this.findPrey(c);
    if (prey) rel(prey.x, prey.y, 0);
    else if (c.species !== 'carn') {
      const g = this.scanGrass(c);
      if (g.dist > 0) rel(c.x + Math.cos(g.angle) * g.dist, c.y + Math.sin(g.angle) * g.dist, 0);
    }
    const threat = this.findThreat(c);
    if (threat) rel(threat.x, threat.y, 3);
    inp[6] = this.grass[this.grassIndex(c.x, c.y)];
    inp[7] = c.energy / this.maxEnergy(c.genes);
    inp[8] = 1;

    runBrain(c.genes.brain!, inp, this.output, c.activations ?? undefined);
    c.heading += this.output[0] * 0.5;
    c.state = threat ? 'flee' : prey ? 'hunt' : inp[6] > 0.3 ? 'graze' : 'wander';
    return this.output[1];
  }

  /** Двигает существо, возвращает фактическую скорость. */
  private move(c: Creature, throttle: number): number {
    const v = c.genes.speed * throttle;
    const nx = c.x + Math.cos(c.heading) * v;
    const ny = c.y + Math.sin(c.heading) * v;
    if (this.isWater(nx, ny)) {
      // в воду не заходим — разворачиваемся
      c.heading += Math.PI * (0.6 + Math.random() * 0.8);
      return v;
    }
    c.x = nx;
    c.y = ny;
    if (c.x < 0 || c.x > this.width) {
      c.x = Math.max(0, Math.min(this.width, c.x));
      c.heading = Math.PI - c.heading;
    }
    if (c.y < 0 || c.y > this.height) {
      c.y = Math.max(0, Math.min(this.height, c.y));
      c.heading = -c.heading;
    }
    return v;
  }

  private feed(c: Creature): void {
    if (c.species !== 'carn') {
      const i = this.grassIndex(c.x, c.y);
      const bite = Math.min(this.grass[i], 0.02 * c.genes.size);
      this.grass[i] -= bite;
      // всеядные переваривают траву хуже
      c.energy += bite * (c.species === 'herb' ? 40 : 28);
    }
    if (c.species !== 'herb') {
      const prey = this.nearest(c, c.genes.size + 4, (o) => this.canEat(c, o));
      if (prey) {
        prey.alive = false;
        c.energy += (prey.energy + this.maxEnergy(prey.genes) * 0.3) * 0.7;
        c.kills++;
      }
    }
  }

  private reproduce(parent: Creature): Creature {
    const genes = mutate(parent.genes, this.settings.mutationRate);
    const a = Math.random() * Math.PI * 2;
    let x = parent.x + Math.cos(a) * parent.genes.size * 2;
    let y = parent.y + Math.sin(a) * parent.genes.size * 2;
    if (this.isWater(x, y)) [x, y] = [parent.x, parent.y];
    const child = this.spawn(parent.species, x, y, genes);
    // spawn добавил ребёнка в массив — убираем, чтобы не обработать его в этом же тике
    this.creatures.pop();
    const gift = parent.energy * parent.genes.generosity;
    parent.energy -= gift;
    child.energy = gift * 0.9;
    child.generation = parent.generation + 1;
    child.parentId = parent.id;
    const rec = this.ancestors.get(child.id)!;
    rec.parentId = parent.id;
    rec.generation = child.generation;
    parent.children++;
    this.champions[parent.species] = parent.genes;

    const sp = parent.species;
    if (child.generation > this.maxGeneration[sp]) {
      this.maxGeneration[sp] = child.generation;
      if (child.generation % 25 === 0) {
        this.log(`${SPECIES_INFO[sp].icon} ${SPECIES_INFO[sp].name}: родилось ${child.generation}-е поколение`, 'milestone');
      }
    }
    return child;
  }

  /** Изредка из-за края карты приходят мигранты — потомки последних успешных особей вида. */
  private migrants(): void {
    const n = this.counts();
    const come = (sp: Species, k: number) => {
      for (let i = 0; i < k; i++) {
        const champ = this.champions[sp];
        const g = champ ? mutate(champ, this.settings.mutationRate * 2) : undefined;
        if (g && sp === 'carn') {
          const prey = this.averageGenes('herb');
          if (prey) g.speed = Math.min(4, Math.max(g.speed, prey.speed * 1.1));
        }
        const [x, y] = this.randomLand();
        this.spawn(sp, x, y, g).energy = this.maxEnergy(g ?? defaultGenes(sp, false)) * 0.8;
      }
      this.log(`${SPECIES_INFO[sp].icon} Пришли мигранты: ${SPECIES_INFO[sp].name.toLowerCase()} (${k})`, 'info');
    };
    if (n.herb < 5) come('herb', 12);
    if (n.omni < 2 && n.herb > 60) come('omni', 4);
    if (n.carn < 2 && n.herb + n.omni > 60) come('carn', 4);
  }

  /** Удаляем из родословной тех, у кого не осталось живых потомков. */
  private pruneAncestors(): void {
    const keep = new Set<number>();
    for (const c of this.creatures) {
      let id: number | null = c.id;
      while (id !== null && !keep.has(id)) {
        keep.add(id);
        id = this.ancestors.get(id)?.parentId ?? null;
      }
    }
    for (const id of this.ancestors.keys()) if (!keep.has(id)) this.ancestors.delete(id);
  }

  /** Цепочка предков, от родителя вверх. */
  lineage(id: number, max = 12): Ancestor[] {
    const out: Ancestor[] = [];
    let cur = this.ancestors.get(id)?.parentId ?? null;
    while (cur !== null && out.length < max) {
      const a = this.ancestors.get(cur);
      if (!a) break;
      out.push(a);
      cur = a.parentId;
    }
    return out;
  }

  /** Живые потомки особи (любого колена). */
  descendants(id: number): Set<Creature> {
    const result = new Set<Creature>();
    const memo = new Map<number, boolean>();
    const isDesc = (start: number): boolean => {
      const path: number[] = [];
      let cur: number | null = start;
      let found = false;
      while (cur !== null) {
        if (memo.has(cur)) {
          found = memo.get(cur)!;
          break;
        }
        if (cur === id) {
          found = true;
          break;
        }
        path.push(cur);
        cur = this.ancestors.get(cur)?.parentId ?? null;
      }
      for (const p of path) memo.set(p, found);
      return found;
    };
    for (const c of this.creatures) {
      if (c.id !== id && c.parentId !== null && isDesc(c.parentId)) result.add(c);
    }
    return result;
  }

  // ---------------- статистика ----------------

  counts(): Record<Species, number> {
    const n = { herb: 0, omni: 0, carn: 0 };
    for (const c of this.creatures) n[c.species]++;
    return n;
  }

  private log(text: string, kind: WorldEvent['kind']): void {
    this.events.push({ tick: this.tick, text, kind });
    if (this.events.length > 60) this.events.shift();
  }

  private record(): void {
    const count = this.counts();
    const prev = this.history[this.history.length - 1];
    if (prev) {
      for (const sp of SPECIES) {
        if (prev.count[sp] > 0 && count[sp] === 0) this.log(`💀 ${SPECIES_INFO[sp].name} вымерли`, 'extinct');
      }
    }
    let grass = 0;
    for (let i = 0; i < this.grass.length; i++) grass += this.grass[i];
    const genes = {} as Record<Species, GeneAvg | null>;
    for (const sp of SPECIES) genes[sp] = this.averageGenes(sp);
    this.history.push({ tick: this.tick, count, grass: grass / this.grass.length, genes });
    if (this.history.length > 800) this.history.shift();
  }

  averageGenes(species: Species): (GeneAvg & { count: number; maxGen: number }) | null {
    let n = 0;
    let maxGen = 0;
    const avg = { speed: 0, sense: 0, size: 0, generosity: 0 };
    for (const c of this.creatures) {
      if (c.species !== species) continue;
      n++;
      for (const k of GENE_KEYS) avg[k] += c.genes[k];
      if (c.generation > maxGen) maxGen = c.generation;
    }
    if (!n) return null;
    for (const k of GENE_KEYS) avg[k] /= n;
    return { ...avg, count: n, maxGen };
  }
}
