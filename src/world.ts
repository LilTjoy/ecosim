import { defaultGenes, mutate, type Genes, type Species } from './genes';

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
}

export interface Settings {
  mutationRate: number;
  grassGrowth: number;
}

export interface Sample {
  herb: number;
  carn: number;
  grass: number;
}

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
  creatures: Creature[] = [];
  tick = 0;
  history: Sample[] = [];
  settings: Settings = { mutationRate: 0.08, grassGrowth: 1 };

  private nextId = 1;
  private hash = new Map<number, Creature[]>();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / CELL);
    this.rows = Math.ceil(height / CELL);
    this.grass = new Float32Array(this.cols * this.rows);
    this.fertility = new Float32Array(this.cols * this.rows);
    this.reset();
  }

  reset(): void {
    this.creatures = [];
    this.history = [];
    this.tick = 0;
    this.nextId = 1;
    this.generateTerrain();
    for (let i = 0; i < 120; i++) this.spawn('herb');
    for (let i = 0; i < 12; i++) this.spawn('carn');
  }

  /** Плодородие — сумма нескольких «пятен», чтобы были луга и пустоши. */
  private generateTerrain(): void {
    const blobs = Array.from({ length: 9 }, () => ({
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      r: 120 + Math.random() * 220,
    }));
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const px = (cx + 0.5) * CELL;
        const py = (cy + 0.5) * CELL;
        let f = 0.08;
        for (const b of blobs) {
          const d2 = (px - b.x) ** 2 + (py - b.y) ** 2;
          f += Math.exp(-d2 / (b.r * b.r));
        }
        const i = cy * this.cols + cx;
        this.fertility[i] = Math.min(1, f);
        this.grass[i] = this.fertility[i] * Math.random();
      }
    }
  }

  spawn(species: Species, x?: number, y?: number, genes?: Genes): Creature {
    const g = genes ?? defaultGenes(species);
    const c: Creature = {
      id: this.nextId++,
      species,
      genes: g,
      x: x ?? Math.random() * this.width,
      y: y ?? Math.random() * this.height,
      heading: Math.random() * Math.PI * 2,
      energy: this.maxEnergy(g) * 0.5,
      age: 0,
      generation: 0,
      parentId: null,
      children: 0,
      kills: 0,
      alive: true,
      state: 'wander',
    };
    this.creatures.push(c);
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
    const move = 0.004 * size * size * v * v; // движение: кинетическая энергия
    const eyes = 0.0006 * sense; // мозг и глаза тоже стоят энергии
    return base + muscles + move + eyes;
  }

  private buildHash(): void {
    this.hash.clear();
    for (const c of this.creatures) {
      const k = this.hashKey(c.x, c.y);
      let bucket = this.hash.get(k);
      if (!bucket) this.hash.set(k, (bucket = []));
      bucket.push(c);
    }
  }

  private hashKey(x: number, y: number): number {
    return Math.floor(x / HASH) * 100003 + Math.floor(y / HASH);
  }

  /** Ближайшее существо нужного вида в радиусе r. */
  private nearest(c: Creature, species: Species, r: number): Creature | null {
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
          if (!o.alive || o.species !== species || o === c) continue;
          const d = (o.x - c.x) ** 2 + (o.y - c.y) ** 2;
          if (d < bestD) {
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
      const r = Math.max(c.genes.size + 6, 10);
      if (d < r * r && d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  grassIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / CELL)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / CELL)));
    return cy * this.cols + cx;
  }

  get cellSize(): number {
    return CELL;
  }

  /** Посадить траву кистью. */
  paintGrass(x: number, y: number, radius: number): void {
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const d = Math.hypot((cx + 0.5) * CELL - x, (cy + 0.5) * CELL - y);
        if (d < radius) {
          const i = cy * this.cols + cx;
          this.fertility[i] = Math.min(1, this.fertility[i] + 0.15);
          this.grass[i] = Math.min(1, this.grass[i] + 0.3);
        }
      }
    }
  }

  step(): void {
    this.tick++;
    this.growGrass();
    this.buildHash();

    const born: Creature[] = [];
    for (const c of this.creatures) {
      if (!c.alive) continue;
      this.think(c);
      const v = this.move(c);
      c.energy -= this.cost(c, v);
      c.age++;
      this.feed(c);

      const max = this.maxEnergy(c.genes);
      if (c.energy > max) c.energy = max;
      if (c.energy > max * 0.8 && c.age > 150) born.push(this.reproduce(c));
      const lifespan = c.species === 'herb' ? 4000 : 6000;
      if (c.energy <= 0 || c.age > lifespan) c.alive = false;
    }

    this.creatures = this.creatures.filter((c) => c.alive);
    this.creatures.push(...born);

    // Не даём миру опустеть совсем: изредка «мигрант» приходит из-за края карты.
    if (this.tick % 600 === 0) {
      const herbs = this.creatures.filter((c) => c.species === 'herb').length;
      const carns = this.creatures.length - herbs;
      if (herbs < 5) for (let i = 0; i < 10; i++) this.spawn('herb');
      if (carns < 2 && herbs > 60) {
        // мигранты-хищники приходят «подготовленными»: чуть быстрее местных травоядных
        const avg = this.averageGenes('herb')!;
        for (let i = 0; i < 4; i++) {
          const g = defaultGenes('carn');
          g.speed = Math.min(4, avg.speed * 1.15);
          this.spawn('carn', undefined, undefined, g).energy = this.maxEnergy(g) * 0.8;
        }
      }
    }

    if (this.tick % 10 === 0) this.record();
  }

  private growGrass(): void {
    const rate = 0.0015 * this.settings.grassGrowth;
    const g = this.grass;
    const f = this.fertility;
    for (let i = 0; i < g.length; i++) {
      if (g[i] < f[i]) g[i] = Math.min(f[i], g[i] + rate * f[i]);
    }
  }

  private think(c: Creature): void {
    const { sense } = c.genes;
    if (c.species === 'herb') {
      const predator = this.nearest(c, 'carn', sense);
      if (predator) {
        c.heading = Math.atan2(c.y - predator.y, c.x - predator.x);
        c.state = 'flee';
        return;
      }
      // Ищем самую сочную клетку среди нескольких точек в поле зрения.
      const here = this.grass[this.grassIndex(c.x, c.y)];
      if (here > 0.3) {
        c.state = 'graze';
        return;
      }
      let bestA = c.heading;
      let bestG = here;
      for (let i = 0; i < 6; i++) {
        const a = c.heading + (Math.random() - 0.5) * Math.PI * 1.6;
        const d = sense * (0.3 + Math.random() * 0.7);
        const gx = c.x + Math.cos(a) * d;
        const gy = c.y + Math.sin(a) * d;
        if (gx < 0 || gy < 0 || gx >= this.width || gy >= this.height) continue;
        const v = this.grass[this.grassIndex(gx, gy)];
        if (v > bestG) {
          bestG = v;
          bestA = a;
        }
      }
      c.heading = bestA;
      c.state = bestG > here ? 'graze' : 'wander';
      if (c.state === 'wander') c.heading += (Math.random() - 0.5) * 0.6;
    } else {
      const prey = this.nearest(c, 'herb', sense);
      if (prey) {
        c.heading = Math.atan2(prey.y - c.y, prey.x - c.x);
        c.state = 'hunt';
      } else {
        c.heading += (Math.random() - 0.5) * 0.5;
        c.state = 'wander';
      }
    }
  }

  /** Двигает существо, возвращает фактическую скорость. */
  private move(c: Creature): number {
    let v = c.genes.speed;
    if (c.state === 'wander') v *= 0.5;
    if (c.state === 'graze' && this.grass[this.grassIndex(c.x, c.y)] > 0.3) v *= 0.15;
    c.x += Math.cos(c.heading) * v;
    c.y += Math.sin(c.heading) * v;
    // Отскок от стен
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
    if (c.species === 'herb') {
      const i = this.grassIndex(c.x, c.y);
      const bite = Math.min(this.grass[i], 0.02 * c.genes.size);
      this.grass[i] -= bite;
      c.energy += bite * 40;
    } else {
      const prey = this.nearest(c, 'herb', c.genes.size + 4);
      // Добычу поймать можно, только если она не крупнее хищника в полтора раза.
      if (prey && prey.genes.size < c.genes.size * 1.5) {
        prey.alive = false;
        c.energy += (prey.energy + this.maxEnergy(prey.genes) * 0.3) * 0.7;
        c.kills++;
      }
    }
  }

  private reproduce(parent: Creature): Creature {
    const genes = mutate(parent.genes, this.settings.mutationRate);
    const a = Math.random() * Math.PI * 2;
    const child = this.spawn(
      parent.species,
      parent.x + Math.cos(a) * parent.genes.size * 2,
      parent.y + Math.sin(a) * parent.genes.size * 2,
      genes,
    );
    // spawn уже добавил ребёнка в массив — убираем, чтобы не обработать его в этом же тике
    this.creatures.pop();
    const gift = parent.energy * parent.genes.generosity;
    parent.energy -= gift;
    child.energy = gift * 0.9;
    child.generation = parent.generation + 1;
    child.parentId = parent.id;
    parent.children++;
    return child;
  }

  private record(): void {
    let herb = 0;
    let carn = 0;
    for (const c of this.creatures) c.species === 'herb' ? herb++ : carn++;
    let grass = 0;
    for (let i = 0; i < this.grass.length; i++) grass += this.grass[i];
    this.history.push({ herb, carn, grass: grass / this.grass.length });
    if (this.history.length > 600) this.history.shift();
  }

  averageGenes(species: Species): (Genes & { count: number; maxGen: number }) | null {
    const list = this.creatures.filter((c) => c.species === species);
    if (!list.length) return null;
    const avg = { speed: 0, sense: 0, size: 0, generosity: 0, hue: 0, count: list.length, maxGen: 0 };
    for (const c of list) {
      avg.speed += c.genes.speed;
      avg.sense += c.genes.sense;
      avg.size += c.genes.size;
      avg.generosity += c.genes.generosity;
      avg.maxGen = Math.max(avg.maxGen, c.generation);
    }
    avg.speed /= list.length;
    avg.sense /= list.length;
    avg.size /= list.length;
    avg.generosity /= list.length;
    return avg;
  }
}
