import { mutateBrain, randomBrain } from './brain';

export type Species = 'herb' | 'omni' | 'carn';
export const SPECIES: Species[] = ['herb', 'omni', 'carn'];

export const SPECIES_INFO: Record<Species, { name: string; icon: string; color: string }> = {
  herb: { name: 'Травоядные', icon: '🐇', color: '#9be37a' },
  omni: { name: 'Всеядные', icon: '🐗', color: '#c99bff' },
  carn: { name: 'Хищники', icon: '🦊', color: '#ff6b5b' },
};

/** Гены — числа, которые задают тело и поведение существа. */
export interface Genes {
  /** Максимальная скорость (единиц мира за тик). */
  speed: number;
  /** Радиус зрения. */
  sense: number;
  /** Размер тела: больше — больше запас энергии, но дороже жизнь. */
  size: number;
  /** Доля энергии, которую родитель отдаёт потомку (0..1). */
  generosity: number;
  /** Оттенок цвета — нейтральный ген, по нему видно родословные линии. */
  hue: number;
  /** Веса нейросети (только в режиме «нейросеть»). */
  brain: Float32Array | null;
}

export const GENE_KEYS = ['speed', 'sense', 'size', 'generosity'] as const;
export type GeneKey = (typeof GENE_KEYS)[number];

export const GENE_LABELS: Record<GeneKey, string> = {
  speed: 'Скорость',
  sense: 'Зрение',
  size: 'Размер',
  generosity: 'Забота о потомстве',
};

export const LIMITS: Record<GeneKey, [number, number]> = {
  speed: [0.2, 4],
  sense: [10, 200],
  size: [2, 12],
  generosity: [0.2, 0.8],
};

const BASE: Record<Species, Omit<Genes, 'hue' | 'brain'> & { hue: [number, number] }> = {
  herb: { speed: 1.2, sense: 50, size: 4, generosity: 0.45, hue: [100, 150] },
  omni: { speed: 1.3, sense: 60, size: 5.5, generosity: 0.5, hue: [260, 300] },
  carn: { speed: 1.5, sense: 80, size: 6, generosity: 0.5, hue: [-10, 20] },
};

export function defaultGenes(species: Species, neural: boolean): Genes {
  const b = BASE[species];
  return {
    speed: b.speed,
    sense: b.sense,
    size: b.size,
    generosity: b.generosity,
    hue: (b.hue[0] + Math.random() * (b.hue[1] - b.hue[0]) + 360) % 360,
    brain: neural ? randomBrain() : null,
  };
}

/** Нормально распределённое случайное число (преобразование Бокса — Мюллера). */
export function gauss(): number {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Копия генов с мутациями. rate — сила мутации (≈ относительное отклонение). */
export function mutate(g: Genes, rate: number): Genes {
  const out = { ...g };
  for (const k of GENE_KEYS) {
    const [lo, hi] = LIMITS[k];
    out[k] = clamp(g[k] * (1 + gauss() * rate), lo, hi);
  }
  out.hue = (g.hue + gauss() * rate * 60 + 360) % 360;
  out.brain = g.brain ? mutateBrain(g.brain, rate) : null;
  return out;
}
