export type Species = 'herb' | 'carn';

/** Гены — числа, которые задают тело и поведение существа. */
export interface Genes {
  /** Максимальная скорость (единиц мира за тик). */
  speed: number;
  /** Радиус зрения. */
  sense: number;
  /** Размер тела: больше — больше запас энергии, но дороже движение. */
  size: number;
  /** Доля энергии, которую родитель отдаёт потомку (0..1). */
  generosity: number;
  /** Оттенок цвета — нейтральный ген, удобно видеть родословные линии. */
  hue: number;
}

export const GENE_KEYS = ['speed', 'sense', 'size', 'generosity'] as const;
export type GeneKey = (typeof GENE_KEYS)[number];

export const GENE_LABELS: Record<GeneKey, string> = {
  speed: 'Скорость',
  sense: 'Зрение',
  size: 'Размер',
  generosity: 'Забота о потомстве',
};

const LIMITS: Record<GeneKey, [number, number]> = {
  speed: [0.2, 4],
  sense: [10, 200],
  size: [2, 12],
  generosity: [0.2, 0.8],
};

export function defaultGenes(species: Species): Genes {
  return species === 'herb'
    ? { speed: 1.2, sense: 50, size: 4, generosity: 0.45, hue: 110 + Math.random() * 40 }
    : { speed: 1.5, sense: 80, size: 6, generosity: 0.5, hue: Math.random() * 30 - 10 };
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
  return out;
}
