// ⏪ «🔬 Повторится ли?» (Блаунт): событие линии (новый вид, вымирание, исчезновение гильдии) — повторится ли оно,
// если перезапустить историю с костями заново из снимков всё ближе к событию? Без DOM: общий для страницы и стенда.
import { GENE_INFO, type GeneKey } from './genome';
import { mix32 } from '../lib/random';
import { DAY } from './world';
import { GUILD, inputArrays, type Action, type Mark, type SeriesRow, type SnapMeta, type Timeline } from './timeline';
import { geneDistance, type RunJob, type TapeSummary } from './tmJob';

export type BlountKind = 'birth' | 'extinct' | 'guild';
/** Сколько тактов до события берём точки старта; сколько считаем после события. */
export const BLOUNT_BACK = [6000, 2400, 600];
export const BLOUNT_AFTER = 1200;
export const BLOUNT_REPEATS = 2;

export interface BlountPlan {
  kind: BlountKind;
  /** Такт события и его текст. */
  t: number;
  text: string;
  /** Вид (для нового вида и вымирания). */
  name: string | null;
  /** Гильдия (для исчезновения гильдии). */
  guild: number;
  /** Точки старта (снимки линии до события), по возрастанию такта. */
  starts: SnapMeta[];
  until: number;
}

const nameIn = (text: string) => /«([^»]+)»/.exec(text)?.[1] ?? null;

/** Какое это событие для опыта (или null — не подходит). */
export function blountKind(m: Mark): BlountKind | null {
  if (m.kind === 'species' && m.icon.startsWith('🧬') && nameIn(m.text)) return 'birth';
  if (m.kind === 'extinct' && m.icon.startsWith('💀') && nameIn(m.text)) return 'extinct';
  if (m.kind === 'guild' && m.major && GUILD.some((G) => m.text.startsWith(`${G.icon} На острове не осталось`))) return 'guild';
  return null;
}

/** Опыт для отметки m линии активной ветки: три снимка поближе к tE − 6000, tE − 2400, tE − 600. */
export function blountPlan(tl: Timeline, m: Mark): BlountPlan | null {
  const kind = blountKind(m);
  if (!kind) return null;
  const A = tl.active;
  const L = tl.lineageSnaps(A).filter((s) => s.tick <= m.t - 100 && s.tick <= A.headTick);
  const picked: SnapMeta[] = [];
  for (const back of BLOUNT_BACK) {
    const target = m.t - back;
    let best: SnapMeta | null = null;
    for (const s of L) if (!picked.includes(s) && (!best || Math.abs(s.tick - target) < Math.abs(best.tick - target))) best = s;
    if (best && !picked.some((p) => p.tick === best!.tick)) picked.push(best);
  }
  if (!picked.length) return null;
  picked.sort((a, b) => a.tick - b.tick);
  return {
    kind, t: m.t, text: m.text, name: kind === 'guild' ? null : nameIn(m.text),
    guild: kind === 'guild' ? GUILD.findIndex((G) => m.text.startsWith(G.icon)) : -1,
    starts: picked, until: m.t + BLOUNT_AFTER,
  };
}

/**
 * Задания: для каждой точки старта — точный повтор (run 0, «ваша история», только для последней точки) и
 * BLOUNT_REPEATS миров с новыми костями (с действиями и вводом линии).
 */
export function blountJobs(tl: Timeline, P: BlountPlan, seed = Date.now()): { start: number; run: number; reseed: boolean; job: Omit<RunJob, 'job'> }[] {
  const A = tl.active;
  const out: { start: number; run: number; reseed: boolean; job: Omit<RunJob, 'job'> }[] = [];
  const watch = P.name ?? undefined;
  let run = 0;
  P.starts.forEach((s, i) => {
    const acts = tl.lineageActsFrom(A, s.snap.actN).filter((a) => a.t < P.until);
    const input = inputArrays(tl.lineageInputFrom(A, s.snap.inN));
    const reps = i === P.starts.length - 1 ? [false, ...Array(BLOUNT_REPEATS).fill(true)] : Array(BLOUNT_REPEATS).fill(true);
    for (const reseed of reps) {
      const salt = mix32(seed ^ Math.imul(run + 1, 0x9e3779b9));
      const own: Action[] = reseed ? [{ k: 'reseed', salt, t: s.tick } as Action, ...acts] : acts;
      out.push({
        start: i, run, reseed,
        job: {
          type: 'run', run, snap: s.snap, acts: own, actBase: s.snap.actN, input, inBase: s.snap.inN, until: P.until,
          snapEvery: 0, rows: P.kind === 'guild', samples: false, marks: false, final: false, summary: -1, bornPeak: 8, watch,
        },
      });
      run++;
    }
  });
  return out;
}

/** Повторилось ли событие в мире? null — не к чему сравнить (вида ещё не было в начале). */
export function blountRepeated(P: BlountPlan, sum: TapeSummary, rows: SeriesRow[], Xmean: Record<GeneKey, number> | null): boolean | null {
  if (P.kind === 'guild') return rows.some((r) => r.t >= P.t - 600 && r.t <= P.until && r.g[P.guild] === 0);
  if (P.kind === 'extinct') {
    if (!sum.watch?.atStart) return null;
    return sum.watch.extinct;
  }
  if (!Xmean) return null;
  return sum.born.some((b) => b.peak >= 8 && geneDistance(b.mean, Xmean, GENE_INFO) < 0.05);
}

export interface BlountRow { tick: number; yes: number; of: number }

/** Вывод по строкам «с дня a: k из n» (§10.3). */
export function blountVerdict(rows: BlountRow[]): string {
  const R = rows.filter((r) => r.of > 0);
  if (!R.length) return 'Не с чем сравнить: в начале прогонов этого вида ещё не было.';
  const rate = R.map((r) => r.yes / r.of);
  const rising = rate.every((x, i) => i === 0 || x >= rate[i - 1]) && rate[rate.length - 1] > rate[0];
  if (rising) {
    const j = rate.findIndex((x) => x > rate[0]);
    return `К дню ${Math.floor(R[j].tick / DAY)} уже случилось то, что сделало событие возможным — историческая случайность, как у Блаунта.`;
  }
  if (rate.every((x) => x === 1)) return 'Событие повторяется, откуда ни начни, — оно не зависит от того, откуда начать: это закономерность.';
  if (rate.every((x) => x === 0)) return 'Событие не повторилось ни разу — оно не зависит от того, откуда начать: похоже на редкую случайность.';
  return 'Событие не зависит от того, откуда начать (при двух мирах на точку разброс большой — попробуйте ещё раз).';
}
