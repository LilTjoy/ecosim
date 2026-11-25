import { mutateBrain, randomBrain } from './brain';
import { clamp, gauss, type Rand } from '../lib/random';
import { bodyDistance, crossBody, EARTH_EXPR, finish, kitFor, mutateBody, type Body, type EvoStats, type ExprCtx } from './modules';

/**
 * Геном. Никаких «видов» в генах нет — есть только числа.
 * Виды возникают сами, когда группы особей генетически расходятся.
 */
export interface Genome {
  size: number;
  speed: number;
  sense: number;
  /** 0 — только трава, 1 — только мясо. Между ними — всеядные и падальщики. */
  diet: number;
  /** Любимая температура: 0 — холод, 1 — жара. */
  tempPref: number;
  /** Умение плавать: 0 — тонет на глубине, 1 — как рыба. */
  swim: number;
  /** Стадность: держаться вместе, поднимать тревогу, охотиться стаей. */
  social: number;
  /** Доля энергии, которая уходит потомку. */
  generosity: number;
  /** Внешность почти нейтральна — но хищники запоминают окраску ядовитых. */
  hue: number;
  pattern: number;
  brain: Float32Array | null;
  /** ♾️ Модули тела (слоты). Никогда не меняется на месте — копии генома делят его. */
  body: Body;
  /** Фенотип, собранный из тела (express) — производный, не редактируется на месте. */
  ph: Float32Array;
}

/** Что нужно мутации для «изобретений» (только в мире с открытой эволюцией, только при рождении). */
export interface Innov {
  boost: number;
  newOrigin: () => number;
  stats: EvoStats;
}

export const GENE_KEYS = ['size', 'speed', 'sense', 'diet', 'tempPref', 'swim', 'social', 'generosity'] as const;
export type GeneKey = (typeof GENE_KEYS)[number];

export const GENE_INFO: Record<GeneKey, { label: string; min: number; max: number; lo: string; hi: string }> = {
  size: { label: 'Размер', min: 2.2, max: 18, lo: 'крошечный', hi: 'гигант' },
  speed: { label: 'Скорость', min: 0.2, max: 4.5, lo: 'медленный', hi: 'быстрый' },
  sense: { label: 'Дальность чувств', min: 15, max: 220, lo: 'вблизи', hi: 'далеко' },
  diet: { label: 'Хищничество', min: 0, max: 1, lo: 'трава', hi: 'мясо' },
  tempPref: { label: 'Теплолюбивость', min: 0, max: 1, lo: 'холод', hi: 'жара' },
  swim: { label: 'Плавание', min: 0, max: 1, lo: 'сухопутный', hi: 'пловец' },
  social: { label: 'Стадность', min: 0, max: 1, lo: 'одиночка', hi: 'стадо' },
  generosity: { label: 'Забота о потомстве', min: 0.2, max: 0.8, lo: 'мало', hi: 'много' },
};

/** Новый геном: значения по умолчанию, поверх — `p`. Случайные внешность и мозг — из потока `rand`. */
export function genome(p: Partial<Genome>, neural: boolean, rand: Rand, ctx: ExprCtx = EARTH_EXPR): Genome {
  const out = {
    size: 4,
    speed: 1.2,
    sense: 50,
    diet: 0,
    tempPref: 0.5,
    swim: 0.1,
    social: 0.3,
    generosity: 0.45,
    hue: rand() * 360,
    pattern: rand(),
    brain: neural ? randomBrain(rand) : null,
    ...p,
  } as Genome;
  out.body = p.body ?? kitFor(out);
  return finish(out, ctx);
}

/** Мутация. Тело «изобретает» только с `innov` в мире с открытой эволюцией (основатели — никогда). */
export function mutate(g: Genome, rate: number, rand: Rand, ctx: ExprCtx = EARTH_EXPR, innov?: Innov): Genome {
  const out = { ...g };
  for (const k of GENE_KEYS) {
    const { min, max } = GENE_INFO[k];
    out[k] = clamp(g[k] + gauss(rand) * rate * 0.35 * (max - min), min, max);
  }
  out.hue = (g.hue + gauss(rand) * rate * 80 + 360) % 360;
  out.pattern = clamp(g.pattern + gauss(rand) * rate * 0.6, 0, 1);
  out.brain = g.brain ? mutateBrain(g.brain, rate, rand) : null;
  if (innov && ctx.on) out.body = mutateBody(g.body, rate, ctx, innov.boost, innov.newOrigin, innov.stats, rand);
  return finish(out, ctx); // размер и плавание изменились
}

/** Потомок двух родителей: каждый ген берётся от одного из них или смешивается. */
export function crossover(a: Genome, b: Genome, rand: Rand, ctx: ExprCtx = EARTH_EXPR): Genome {
  const out = { ...a };
  for (const k of GENE_KEYS) {
    const r = rand();
    out[k] = r < 0.4 ? a[k] : r < 0.8 ? b[k] : (a[k] + b[k]) / 2;
  }
  out.hue = rand() < 0.5 ? a.hue : b.hue;
  out.pattern = rand() < 0.5 ? a.pattern : b.pattern;
  if (a.brain && b.brain) {
    const w = new Float32Array(a.brain.length);
    // мозг наследуется блоками — целыми нейронами от одного из родителей
    const block = 13;
    for (let i = 0; i < w.length; i += block) {
      const src = rand() < 0.5 ? a.brain : b.brain;
      for (let j = i; j < Math.min(w.length, i + block); j++) w[j] = src[j];
    }
    out.brain = w;
  }
  if (ctx.on) out.body = crossBody(a.body, b.body, rand); // выключено — тело матери, без лишних костей
  return finish(out, ctx);
}

/** Генетическое расстояние 0..1. Чем больше — тем дальше родство. `bodyW` — вес тела (0 — без открытой эволюции). */
export function distance(a: Genome, b: Genome, bodyW = 0): number {
  let s = 0;
  for (const k of GENE_KEYS) {
    const { min, max } = GENE_INFO[k];
    s += Math.abs(a[k] - b[k]) / (max - min);
  }
  let dh = Math.abs(a.hue - b.hue);
  if (dh > 180) dh = 360 - dh;
  s += (dh / 180) * 0.6 + Math.abs(a.pattern - b.pattern) * 0.4;
  if (bodyW) s += bodyW * bodyDistance(a.ph, b.ph, a.body.shape, b.body.shape);
  return s / (GENE_KEYS.length + 1);
}

/** Генетическое расстояние, выше которого скрещивание невозможно. */
export const MATE_LIMIT = 0.1;
/** Расстояние от основателя вида, после которого появляется новый вид. */
export const SPECIES_LIMIT = 0.12;
