import { mutateBrain, randomBrain } from './brain';
import { clamp, gauss } from '../lib/random';

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
  /** Внешность — нейтральные гены, по ним видно родство. */
  hue: number;
  pattern: number;
  brain: Float32Array | null;
}

export const GENE_KEYS = ['size', 'speed', 'sense', 'diet', 'tempPref', 'swim', 'social', 'generosity'] as const;
export type GeneKey = (typeof GENE_KEYS)[number];

export const GENE_INFO: Record<GeneKey, { label: string; min: number; max: number; lo: string; hi: string }> = {
  size: { label: 'Размер', min: 2.2, max: 18, lo: 'крошечный', hi: 'гигант' },
  speed: { label: 'Скорость', min: 0.2, max: 4.5, lo: 'медленный', hi: 'быстрый' },
  sense: { label: 'Зрение', min: 15, max: 220, lo: 'близорукий', hi: 'зоркий' },
  diet: { label: 'Хищничество', min: 0, max: 1, lo: 'трава', hi: 'мясо' },
  tempPref: { label: 'Теплолюбивость', min: 0, max: 1, lo: 'холод', hi: 'жара' },
  swim: { label: 'Плавание', min: 0, max: 1, lo: 'сухопутный', hi: 'пловец' },
  social: { label: 'Стадность', min: 0, max: 1, lo: 'одиночка', hi: 'стадо' },
  generosity: { label: 'Забота о потомстве', min: 0.2, max: 0.8, lo: 'мало', hi: 'много' },
};

export function genome(p: Partial<Genome>, neural: boolean): Genome {
  return {
    size: 4,
    speed: 1.2,
    sense: 50,
    diet: 0,
    tempPref: 0.5,
    swim: 0.1,
    social: 0.3,
    generosity: 0.45,
    hue: Math.random() * 360,
    pattern: Math.random(),
    brain: neural ? randomBrain() : null,
    ...p,
  };
}

export function mutate(g: Genome, rate: number): Genome {
  const out = { ...g };
  for (const k of GENE_KEYS) {
    const { min, max } = GENE_INFO[k];
    out[k] = clamp(g[k] + gauss() * rate * 0.35 * (max - min), min, max);
  }
  out.hue = (g.hue + gauss() * rate * 80 + 360) % 360;
  out.pattern = clamp(g.pattern + gauss() * rate * 0.6, 0, 1);
  out.brain = g.brain ? mutateBrain(g.brain, rate) : null;
  return out;
}

/** Потомок двух родителей: каждый ген берётся от одного из них или смешивается. */
export function crossover(a: Genome, b: Genome): Genome {
  const out = { ...a };
  for (const k of GENE_KEYS) {
    const r = Math.random();
    out[k] = r < 0.4 ? a[k] : r < 0.8 ? b[k] : (a[k] + b[k]) / 2;
  }
  out.hue = Math.random() < 0.5 ? a.hue : b.hue;
  out.pattern = Math.random() < 0.5 ? a.pattern : b.pattern;
  if (a.brain && b.brain) {
    const w = new Float32Array(a.brain.length);
    // мозг наследуется блоками — целыми нейронами от одного из родителей
    const block = 13;
    for (let i = 0; i < w.length; i += block) {
      const src = Math.random() < 0.5 ? a.brain : b.brain;
      for (let j = i; j < Math.min(w.length, i + block); j++) w[j] = src[j];
    }
    out.brain = w;
  }
  return out;
}

/** Генетическое расстояние 0..1. Чем больше — тем дальше родство. */
export function distance(a: Genome, b: Genome): number {
  let s = 0;
  for (const k of GENE_KEYS) {
    const { min, max } = GENE_INFO[k];
    s += Math.abs(a[k] - b[k]) / (max - min);
  }
  let dh = Math.abs(a.hue - b.hue);
  if (dh > 180) dh = 360 - dh;
  s += (dh / 180) * 0.6 + Math.abs(a.pattern - b.pattern) * 0.4;
  return s / (GENE_KEYS.length + 1);
}

/** Генетическое расстояние, выше которого скрещивание невозможно. */
export const MATE_LIMIT = 0.1;
/** Расстояние от основателя вида, после которого появляется новый вид. */
export const SPECIES_LIMIT = 0.12;
