// ⏪ Фоновые прогоны машины времени (без DOM — общий для воркера и стенда): продолжить ветку, пересчитать её
// «точно так же», плёнка жизни (миры с другими костями), эффект бабочки (два мира шаг в шаг).
// Воркер только пересылает сообщения сюда; стенд гоняет тот же JobRunner у себя (drain), так что проверяется один код.
import { GENE_KEYS, type GeneKey } from './genome';
import { guildOf, type Sample, type World } from './world';
import { recycleSnap, sameWorld, snapBuffers, type WorldSnap } from './snapshot';
import { actMarks, rowOf, stepMarks, TM, trailing, type Action, type InputArrays, type Mark, type SeriesRow } from './timeline';
import { mix32 } from '../lib/random';
import type { Species } from './species';

// ---------------- протокол ----------------

/** Один мир от снимка до такта until с действиями и вводом (сквозные номера линии — с actBase/inBase). */
export interface RunJob {
  type: 'run';
  job: number;
  run: number;
  snap: WorldSnap;
  acts: Action[];
  actBase: number;
  input: InputArrays;
  inBase: number;
  until: number;
  /** Снимок каждые snapEvery тактов (по абсолютному такту), 0 — нет. */
  snapEvery: number;
  rows: boolean;
  samples: boolean;
  marks: boolean;
  /** Прислать снимок в конце (голова ветки). */
  final: boolean;
  /** Плёнка жизни: итог с видами, родившимися после nx (−1 — после начала прогона). */
  summary?: number;
  /** «🔬 Повторится ли?»: новые виды в итоге — с пиком не меньше bornPeak (по умолчанию 20). */
  bornPeak?: number;
  /** «🔬 Повторится ли?»: следить за видом с этим именем (был ли он в начале, жив ли в конце, его средние гены). */
  watch?: string;
}

/** Эффект бабочки: несколько миров шаг в шаг от одного снимка; у каждого свои первые действия (pre). */
export interface MultiJob {
  type: 'multi';
  job: number;
  snap: WorldSnap;
  runs: { pre: Action[] }[];
  /** Общие действия и ввод (запись линии после начала). */
  acts: Action[];
  actBase: number;
  input: InputArrays;
  inBase: number;
  until: number;
  /** Не меньше until; если к until различается меньше share — считать дальше, но не дальше max. */
  extend?: { max: number; share: number };
  every: number;
  /** Мир, который можно сделать веткой: его ряды, отметки и снимок в конце. */
  keep: number;
}

export type ToWorker = RunJob | MultiJob | { type: 'cancel'; job: number } | { type: 'pause' } | { type: 'resume' };

export interface ProgressMsg {
  type: 'progress';
  job: number;
  run: number;
  tick: number;
  rows: SeriesRow[];
  marks: Mark[];
  samples: Sample[];
  /** [id, имя, оттенок] видов, впервые попавших в ряды. */
  names: [number, string, number][];
}
export interface SnapMsg { type: 'snap'; job: number; run: number; snap: WorldSnap; final: boolean }
/** Кадр бабочки: точки миров (x, y, оттенок подряд) и клетки 32×20, где миры различаются. */
export interface FrameMsg { type: 'frame'; job: number; tick: number; dots: Float32Array[]; diff: Uint8Array; share: number; cells: number }
export interface DoneMsg {
  type: 'done';
  job: number;
  run: number;
  tick: number;
  digest: number[];
  /** Сколько действий и записей ввода приложено (для ветки из этого мира). */
  applied: number;
  inApplied: number;
  cancelled?: boolean;
  error?: string;
  summary?: TapeSummary;
}
export type FromWorker = ProgressMsg | SnapMsg | FrameMsg | DoneMsg;

/** Решётка различий эффекта бабочки. */
export const FLY_GRID = [32, 20] as const;

// ---------------- итог мира для плёнки жизни ----------------

export interface SpInfo { id: number; name: string; hue: number; pattern: number; count: number; peak: number; alive: boolean; mean: Record<GeneKey, number> }
export interface TapeSummary {
  tick: number;
  n: number;
  g: number[];
  live: number;
  /** Живых видов, родившихся после начала. */
  fresh: number;
  top: SpInfo[];
  /** Виды, родившиеся после начала, с пиком ≥ 20 (для конвергенции). */
  born: SpInfo[];
  /** Вид, за которым следили (RunJob.watch): был ли в начале прогона и что с ним в конце. */
  watch?: { atStart: boolean; found: boolean; count: number; extinct: boolean; mean: Record<GeneKey, number> | null };
}

const spInfo = (s: Species): SpInfo => ({
  id: s.id, name: s.name, hue: s.hue, pattern: s.founder.pattern, count: s.count, peak: s.peak, alive: s.extinct === null, mean: { ...s.mean },
});

export function tapeSummary(w: World, nx: number, bornPeak = 20): TapeSummary {
  const g = [0, 0, 0, 0];
  for (const c of w.creatures) g[guildOf(c.g)]++;
  const live = w.species.living();
  const born = [...w.species.all.values()].filter((s) => s.id >= nx && s.peak >= bornPeak).sort((a, b) => b.peak - a.peak).slice(0, 30);
  return {
    tick: w.tick, n: w.creatures.length, g, live: live.length, fresh: live.filter((s) => s.id >= nx).length,
    top: live.slice(0, 3).map(spInfo), born: born.map(spInfo),
  };
}

/** Мера различия средних генов (0 — одинаковы), как в §10.1: средняя по генам доля размаха. */
export function geneDistance(a: Record<GeneKey, number>, b: Record<GeneKey, number>, range: Record<GeneKey, { min: number; max: number }>): number {
  let d = 0;
  for (const k of GENE_KEYS) d += Math.abs(a[k] - b[k]) / Math.max(1e-9, range[k].max - range[k].min);
  return d / GENE_KEYS.length;
}

// ---------------- исполнитель ----------------

type Post = (m: FromWorker, transfer?: Transferable[]) => void;

/** Ход одного мира по записи: действия этого такта, затем ввод, затем шаг. */
class Cursor {
  ai = 0;
  ii = 0;
  constructor(private w: World, private acts: Action[], private input: InputArrays, public marks: Mark[] | null, private actBase: number) {
    while (this.ai < acts.length && acts[this.ai].t < w.tick) this.ai++;
    while (this.ii < input.t.length && input.t[this.ii] < w.tick) this.ii++;
  }
  /** Действия в текущий такт. */
  acts0(): void {
    const { w, acts } = this;
    while (this.ai < acts.length && acts[this.ai].t === w.tick) {
      const a = acts[this.ai];
      const k0 = trailing(w.events, w.tick);
      w.apply(a);
      if (this.marks) this.marks.push(...actMarks(w, a, this.actBase + this.ai, k0));
      this.ai++;
    }
  }
  in0(): void {
    const { w, input: I } = this;
    while (this.ii < I.t.length && I.t[this.ii] === w.tick) {
      Object.assign(w.input, { dx: I.dx[this.ii], dy: I.dy[this.ii], run: I.run[this.ii] === 1 });
      this.ii++;
    }
  }
}

export class JobRunner {
  paused = false;
  private worlds: World[] = [];
  private queue: (RunJob | MultiJob)[] = [];
  private gen: Generator<void> | null = null;
  private cur: { job: number; run: number; cancel: boolean } | null = null;
  private waiting = false;

  /** mk — новый мир (воркер ставит ловушку системной случайности после конструктора); later — следующая порция. */
  constructor(private post: Post, private mk: (w: number, h: number, cell: number) => World, private later: (f: () => void) => void = () => {}) {}

  handle(m: ToWorker): void {
    if (m.type === 'cancel') {
      if (this.cur?.job === m.job) this.cur.cancel = true;
      else this.queue = this.queue.filter((q) => q.job !== m.job);
    } else if (m.type === 'pause') this.paused = true;
    else if (m.type === 'resume') {
      this.paused = false;
      this.pump();
    } else {
      this.queue.push(m);
      this.pump();
    }
  }

  /** Работать порциями ~25 мс (между ними приходят отмена и пауза). */
  pump(): void {
    if (this.waiting) return;
    const t0 = performance.now();
    while (!this.paused && performance.now() - t0 < 25) if (!this.next()) return;
    if (this.paused || (!this.gen && !this.queue.length)) return;
    this.waiting = true;
    this.later(() => {
      this.waiting = false;
      this.pump();
    });
  }

  /** Всё до конца, без пауз (стенд). */
  drain(): void {
    while (this.next());
  }

  get idle(): boolean {
    return !this.gen && !this.queue.length;
  }

  private next(): boolean {
    if (!this.gen) {
      const m = this.queue.shift();
      if (!m) return false;
      this.cur = { job: m.job, run: m.type === 'run' ? m.run : m.keep, cancel: false };
      this.gen = m.type === 'run' ? this.run(m) : this.multi(m);
    }
    try {
      if (this.gen.next().done) this.gen = this.cur = null;
    } catch (e) {
      const c = this.cur!;
      this.gen = this.cur = null;
      this.post({ type: 'done', job: c.job, run: c.run, tick: -1, digest: [], applied: 0, inApplied: 0, error: String((e as Error)?.message ?? e) });
    }
    return true;
  }

  /** Мир номер i, поставленный в снимок (тот же рельеф — без reset). */
  private world(i: number, s: WorldSnap): World {
    let w = this.worlds[i];
    if (!w || w.width !== s.dims[0] || w.height !== s.dims[1] || w.cell !== s.dims[2]) w = this.worlds[i] = this.mk(s.dims[0], s.dims[1], s.dims[2]);
    if (!sameWorld(w, s)) w.reset(s.mode, s.seed, s.env, s.salt);
    w.loadState(s, []);
    return w;
  }

  private sendSnap(w: World, job: number, run: number, actN: number, inN: number, final: boolean): number {
    const s = w.captureState();
    s.actN = actN;
    s.inN = inN;
    const d = s.digest;
    this.post({ type: 'snap', job, run, snap: s, final }, snapBuffers(s));
    return d;
  }

  private digest(w: World): number {
    const s = w.captureState();
    recycleSnap(s);
    return s.digest;
  }

  private *run(m: RunJob): Generator<void> {
    const J = this.cur!;
    const w = this.world(0, m.snap);
    let rows: SeriesRow[] = [], marks: Mark[] = [], samples: Sample[] = [], names: [number, string, number][] = [];
    const seen = new Set<number>();
    const C = new Cursor(w, m.acts, m.input, m.marks ? marks : null, m.actBase);
    const nx0 = w.species.peekNextId;
    const byName = () => (m.watch === undefined ? undefined : [...w.species.all.values()].find((s) => s.name === m.watch));
    const atStart = !!byName();
    const flush = () => {
      this.post({ type: 'progress', job: m.job, run: m.run, tick: w.tick, rows, marks, samples, names });
      rows = [];
      samples = [];
      names = [];
      marks = [];
      if (m.marks) C.marks = marks;
    };
    let n = 0;
    while (w.tick < m.until) {
      if (J.cancel) {
        this.post({ type: 'done', job: m.job, run: m.run, tick: w.tick, digest: [], applied: C.ai, inApplied: C.ii, cancelled: true });
        return;
      }
      C.acts0();
      C.in0();
      w.step();
      const T = w.tick;
      if (m.samples) {
        const h = w.history[w.history.length - 1];
        if (h && h.tick === T) samples.push(h);
      }
      if (m.rows && T % TM.ROW_EVERY === 0) {
        const r = rowOf(w);
        rows.push(r);
        for (const id of r.ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          const sp = w.species.all.get(id);
          if (sp) names.push([id, sp.name, sp.hue]);
        }
      }
      if (m.marks) marks.push(...stepMarks(w));
      if (T % 200 === 0) flush();
      if (m.snapEvery && T % m.snapEvery === 0 && T < m.until) {
        flush();
        this.sendSnap(w, m.job, m.run, m.actBase + C.ai, m.inBase + C.ii, false);
      }
      if (++n % 50 === 0) yield;
    }
    C.acts0(); // действия самого такта until — до снимка (как у головы ветки)
    flush();
    const d = m.final ? this.sendSnap(w, m.job, m.run, m.actBase + C.ai, m.inBase + C.ii, true) : this.digest(w);
    this.post({ type: 'done', job: m.job, run: m.run, tick: w.tick, digest: [d], applied: C.ai, inApplied: C.ii, summary: m.summary !== undefined ? this.summary(w, m, m.summary < 0 ? nx0 : m.summary, atStart, byName()) : undefined });
  }

  private summary(w: World, m: RunJob, nx: number, atStart: boolean, X: Species | undefined): TapeSummary {
    const s = tapeSummary(w, nx, m.bornPeak);
    if (m.watch !== undefined) s.watch = { atStart, found: !!X, count: X?.count ?? 0, extinct: !X || X.extinct !== null || X.count === 0, mean: X ? { ...X.mean } : null };
    return s;
  }

  private *multi(m: MultiJob): Generator<void> {
    const J = this.cur!;
    const K = m.runs.length;
    const W = m.runs.map((_, i) => this.world(i, m.snap));
    const acts = m.runs.map((r) => [...r.pre.map((a) => ({ ...a, t: m.snap.tick }) as Action), ...m.acts]);
    let rows: SeriesRow[] = [], marks: Mark[] = [], names: [number, string, number][] = [];
    const seen = new Set<number>();
    const C = W.map((w, i) => new Cursor(w, acts[i], m.input, i === m.keep ? marks : null, m.actBase));
    const [GX, GY] = FLY_GRID;
    const NC = GX * GY;
    const hash = W.map(() => new Int32Array(NC)), cnt = W.map(() => new Int32Array(NC));
    const frame = () => {
      for (let i = 0; i < K; i++) {
        const w = W[i], h = hash[i], c = cnt[i];
        h.fill(0);
        c.fill(0);
        const sx = GX / w.width, sy = GY / w.height;
        for (const a of w.creatures) {
          const k = Math.min(GY - 1, Math.max(0, Math.floor(a.y * sy))) * GX + Math.min(GX - 1, Math.max(0, Math.floor(a.x * sx)));
          h[k] = (h[k] + mix32(a.sp * 2654435761 + 0x9e37)) | 0;
          c[k]++;
        }
      }
      const diff = new Uint8Array(NC);
      let nd = 0, occ = 0;
      for (let k = 0; k < NC; k++) {
        let any = cnt[0][k] > 0, d = false;
        for (let i = 1; i < K; i++) {
          if (cnt[i][k] > 0) any = true;
          if (cnt[i][k] !== cnt[0][k] || hash[i][k] !== hash[0][k]) d = true;
        }
        if (any) occ++;
        if (d) (diff[k] = 1), nd++;
      }
      const dots = W.map((w) => {
        const f = new Float32Array(w.creatures.length * 3);
        let o = 0;
        for (const a of w.creatures) (f[o++] = a.x), (f[o++] = a.y), (f[o++] = a.g.hue);
        return f;
      });
      const share = occ ? nd / occ : 0;
      this.post({ type: 'frame', job: m.job, tick: W[0].tick, dots, diff, share, cells: nd }, dots.map((d) => d.buffer));
      return share;
    };
    for (let i = 0; i < K; i++) C[i].acts0(); // взмах — в начальный такт
    let share = frame();
    const w0 = W[0];
    let until = m.until;
    let n = 0;
    for (;;) {
      if (w0.tick >= until) {
        if (m.extend && share < m.extend.share && until < m.extend.max) until = Math.min(m.extend.max, until + m.every * 20);
        else break;
      }
      if (J.cancel) {
        this.post({ type: 'done', job: m.job, run: m.keep, tick: w0.tick, digest: [], applied: 0, inApplied: 0, cancelled: true });
        return;
      }
      for (let i = 0; i < K; i++) {
        const w = W[i];
        C[i].acts0();
        C[i].in0();
        w.step();
      }
      const T = w0.tick, wk = W[m.keep];
      if (T % TM.ROW_EVERY === 0) {
        const r = rowOf(wk);
        rows.push(r);
        for (const id of r.ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          const sp = wk.species.all.get(id);
          if (sp) names.push([id, sp.name, sp.hue]);
        }
      }
      marks.push(...stepMarks(wk));
      if (T % m.every === 0) share = frame();
      if (T % 200 === 0) {
        this.post({ type: 'progress', job: m.job, run: m.keep, tick: T, rows, marks, samples: [], names });
        rows = [];
        names = [];
        marks = [];
        C[m.keep].marks = marks;
      }
      if (++n % 25 === 0) yield;
    }
    for (let i = 0; i < K; i++) C[i].acts0();
    if (rows.length || marks.length) this.post({ type: 'progress', job: m.job, run: m.keep, tick: w0.tick, rows, marks, samples: [], names });
    const digest = W.map((w, i) => (i === m.keep ? 0 : this.digest(w)));
    const k = C[m.keep];
    digest[m.keep] = this.sendSnap(W[m.keep], m.job, m.keep, m.actBase + k.ai, m.inBase + k.ii, true);
    this.post({ type: 'done', job: m.job, run: m.keep, tick: w0.tick, digest, applied: k.ai, inApplied: k.ii });
  }
}
