// Микромир: возбудители болезней (внутривидовая SIR с эволюцией вирулентности).

export type PathogenKind = 'вирус' | 'бактерия' | 'грибок' | 'простейшее';

/** Вспышка одной болезни у одного вида-хозяина. */
export interface Pathogen {
  id: number;
  /** Вид-хозяин. */
  host: number;
  name: string;
  kind: PathogenKind;
  /** Где началась. */
  region: string;
  born: number;
  ended: number | null;
  cases: number;
  deaths: number;
  recovered: number;
  /** Наибольшее число больных одновременно. */
  peak: number;
  /** Больные и средняя вирулентность каждые 20 тактов (не более 300 точек). */
  curve: number[];
  virCurve: number[];
  vir0: number;
  virMean: number;
  /** Новые случаи и выбывшие (умерли + выздоровели) за окно в 200 тактов → эффективное R. */
  newW: number;
  outW: number;
  rEff: number;
  /** Объявлена ли в летописи (набрала 8 случаев). */
  announced: boolean;
  x: number;
  y: number;
}

const NOUNS: [string, PathogenKind][] = [
  ['лихорадка', 'вирус'],
  ['чума', 'бактерия'],
  ['хворь', 'простейшее'],
  ['парша', 'грибок'],
  ['оспа', 'вирус'],
  ['лихоманка', 'бактерия'],
];

/** «Тундра Каэль» → «Каэльская лихорадка» (вирус). В море — «Морская …». */
export function pathogenName(regionName: string, rand: () => number = Math.random): { name: string; kind: PathogenKind } {
  const proper = regionName.split(' ')[1];
  const adj = proper ? proper.replace(/[аяоеиыуюэ]$/i, '') + 'ская' : 'Морская';
  const [noun, kind] = NOUNS[Math.floor(rand() * NOUNS.length)];
  return { name: `${adj} ${noun}`, kind };
}
