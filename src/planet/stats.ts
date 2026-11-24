import { randomPlanet, simulate, type Assumptions, type PlanetParams, type SimResult } from './model';

export interface Bucket {
  n: number;
  life: number;
  animals: number;
  intel: number;
  tech: number;
}

export interface Lucky {
  params: PlanetParams;
  maxStage: number;
  intelAt: number | null;
  star: string;
}

export interface McStats {
  n: number;
  /** Сколько планет дошли до каждой ступени (индекс = ступень). */
  reached: number[];
  /** Сколько миров хоть 100 млн лет имели жидкую воду. */
  habitable: number;
  factors: Record<string, Record<string, Bucket>>;
  /** Гистограмма времени появления разума (бины по 0,5 млрд лет). */
  intelTimes: number[];
  lifeTimes: number[];
  killers: Record<string, number>;
  lucky: Lucky[];
}

export function emptyStats(): McStats {
  return { n: 0, reached: new Array(8).fill(0), habitable: 0, factors: {}, intelTimes: new Array(24).fill(0), lifeTimes: new Array(24).fill(0), killers: {}, lucky: [] };
}

function factorKeys(r: SimResult): [string, string][] {
  const p = r.params;
  const d = r.derived;
  return [
    ['Тип звезды', { M: 'Красный карлик (M)', K: 'Оранжевый (K)', G: 'Как Солнце (G)', F: 'Жёлто-белая (F)' }[d.starClass]],
    ['Крупная луна', p.moon > 0.3 ? 'Есть' : 'Нет'],
    ['Тектоника плит', d.tectonics ? 'Есть' : 'Нет'],
    ['Гигант-щит', p.giant ? 'Есть' : 'Нет'],
    ['Вода', p.water < 0.1 ? 'Сухой мир' : p.water > 3 ? 'Океанический мир' : 'Как на Земле'],
    ['Масса планеты', p.mass < 0.5 ? 'Меньше ½ Земли' : p.mass > 2 ? 'Суперземля (>2)' : 'Как Земля'],
    ['Приливный захват', d.tidalLock ? 'Да' : 'Нет'],
  ];
}

export function addResult(s: McStats, r: SimResult): void {
  s.n++;
  for (let k = 1; k <= r.maxStage; k++) s.reached[k]++;
  if (r.habitableTime >= 0.1) s.habitable++;
  for (const [f, v] of factorKeys(r)) {
    const g = (s.factors[f] ??= {});
    const b = (g[v] ??= { n: 0, life: 0, animals: 0, intel: 0, tech: 0 });
    b.n++;
    if (r.maxStage >= 1) b.life++;
    if (r.maxStage >= 4) b.animals++;
    if (r.maxStage >= 6) b.intel++;
    if (r.maxStage >= 7) b.tech++;
  }
  const bin = (t: number | null) => (t === null ? -1 : Math.min(23, Math.floor(t / 0.5)));
  const ti = bin(r.firstReached[6]);
  if (ti >= 0) s.intelTimes[ti]++;
  const tl = bin(r.firstReached[1]);
  if (tl >= 0) s.lifeTimes[tl]++;
  for (const why of r.setbacks) s.killers[why] = (s.killers[why] ?? 0) + 1;
  if (r.maxStage >= 6 && s.lucky.length < 40) {
    s.lucky.push({ params: r.params, maxStage: r.maxStage, intelAt: r.firstReached[6], star: r.derived.starClass });
  }
}

export function merge(a: McStats, b: McStats): McStats {
  const out = emptyStats();
  out.n = a.n + b.n;
  out.habitable = a.habitable + b.habitable;
  out.reached = a.reached.map((v, i) => v + b.reached[i]);
  out.intelTimes = a.intelTimes.map((v, i) => v + b.intelTimes[i]);
  out.lifeTimes = a.lifeTimes.map((v, i) => v + b.lifeTimes[i]);
  for (const src of [a, b]) {
    for (const [f, g] of Object.entries(src.factors)) {
      for (const [v, bk] of Object.entries(g)) {
        const t = ((out.factors[f] ??= {})[v] ??= { n: 0, life: 0, animals: 0, intel: 0, tech: 0 });
        t.n += bk.n;
        t.life += bk.life;
        t.animals += bk.animals;
        t.intel += bk.intel;
        t.tech += bk.tech;
      }
    }
    for (const [k, v] of Object.entries(src.killers)) out.killers[k] = (out.killers[k] ?? 0) + v;
  }
  out.lucky = [...a.lucky, ...b.lucky].sort((x, y) => y.maxStage - x.maxStage).slice(0, 40);
  return out;
}

export function runBatch(start: number, count: number, a: Assumptions): McStats {
  const s = emptyStats();
  for (let i = 0; i < count; i++) addResult(s, simulate(randomPlanet(start + i), a, false));
  return s;
}

/** 95% доверительный интервал для доли (Уилсон) — чтобы честно показать разброс. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
