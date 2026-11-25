// ⏪ Фоновые прогоны машины времени на странице: один воркер для веток, до трёх — для опытов (плёнка жизни,
// бабочка). Очередь у каждого воркера своя; в скрытой вкладке всё на паузе.
import { TM, inputArrays, type Branch, type Timeline } from '../sim/timeline';
import type { DoneMsg, FrameMsg, FromWorker, MultiJob, ProgressMsg, RunJob, SnapMsg, ToWorker } from '../sim/tmJob';

export interface JobHandlers {
  progress?(m: ProgressMsg): void;
  snap?(m: SnapMsg): void;
  frame?(m: FrameMsg): void;
  done?(m: DoneMsg): void;
}
type JobMsg = RunJob | MultiJob;
interface Job { id: number; wi: number; msg: JobMsg; h: JobHandlers; cancelled: boolean }
export type BgKind = 'follow' | 'catch' | 'count';

export class TmRunner {
  /** Воркеры есть (иначе ветки досчитываются вживую, опыты недоступны). */
  readonly ok: boolean;
  /** Сколько воркеров для опытов: min(3, ядра − 2), не меньше одного. */
  readonly pool: number;
  /** Ветка закончила считаться в фоне (не прервана). */
  onBranchDone: ((b: Branch, kind: BgKind, m: DoneMsg) => void) | null = null;
  onError: ((text: string) => void) | null = null;
  private workers: (Worker | null)[] = [];
  private busy: (Job | null)[] = [];
  private queues: Job[][] = [];
  private jobs = new Map<number, Job>();
  private kinds = new Map<number, BgKind>();
  private seq = 1;
  private paused = false;

  constructor(private tl: Timeline) {
    this.ok = typeof Worker !== 'undefined';
    this.pool = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 2));
    document.addEventListener('visibilitychange', () => this.setPaused(document.hidden));
  }

  /** Номера воркеров опытов: 1..pool (0 — ветки). */
  get expWorkers(): number[] {
    return Array.from({ length: this.pool }, (_, i) => i + 1);
  }

  private worker(i: number): Worker | null {
    if (this.workers[i] !== undefined) return this.workers[i];
    let w: Worker | null = null;
    try {
      w = new Worker(new URL('../sim/timeline.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<FromWorker>) => this.onMsg(i, e.data);
      w.onerror = (e) => {
        e.preventDefault();
        this.fail(i, `Фоновый расчёт остановился: ${e.message || 'ошибка воркера'}`);
      };
      if (this.paused) w.postMessage({ type: 'pause' } satisfies ToWorker);
    } catch {
      w = null;
    }
    this.workers[i] = w;
    this.busy[i] = null;
    this.queues[i] = [];
    return w;
  }

  /** Поставить задание воркеру wi; вернуть номер задания (0 — воркера нет). */
  submit(wi: number, make: (job: number) => JobMsg, h: JobHandlers): number {
    if (!this.ok || !this.worker(wi)) return 0;
    const id = this.seq++;
    const job: Job = { id, wi, msg: make(id), h, cancelled: false };
    this.jobs.set(id, job);
    this.queues[wi].push(job);
    this.dispatch(wi);
    return id;
  }

  cancel(id: number): void {
    const j = this.jobs.get(id);
    if (!j || j.cancelled) return;
    j.cancelled = true;
    const q = this.queues[j.wi];
    const k = q.indexOf(j);
    if (k >= 0) {
      q.splice(k, 1);
      this.jobs.delete(id);
    } else this.workers[j.wi]?.postMessage({ type: 'cancel', job: id } satisfies ToWorker);
  }

  /** Сколько заданий ждёт или идёт у воркера. */
  load(wi: number): number {
    return (this.busy[wi] ? 1 : 0) + (this.queues[wi]?.length ?? 0);
  }

  /** Новый мир: всё прочь. */
  reset(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
    this.kinds.clear();
  }

  private setPaused(p: boolean): void {
    this.paused = p;
    for (const w of this.workers) w?.postMessage({ type: p ? 'pause' : 'resume' } satisfies ToWorker);
  }

  private dispatch(wi: number): void {
    if (this.busy[wi]) return;
    const j = this.queues[wi].shift();
    if (!j) return;
    this.busy[wi] = j;
    this.workers[wi]!.postMessage(j.msg);
  }

  private onMsg(wi: number, m: FromWorker): void {
    const j = this.jobs.get(m.job);
    if (j && !j.cancelled) {
      if (m.type === 'progress') j.h.progress?.(m);
      else if (m.type === 'snap') j.h.snap?.(m);
      else if (m.type === 'frame') j.h.frame?.(m);
    }
    if (m.type !== 'done') return;
    if (j) {
      this.jobs.delete(m.job);
      if (m.error) this.onError?.(`Фоновый расчёт не удался: ${m.error}`);
      j.h.done?.(j.cancelled ? { ...m, cancelled: true } : m);
    }
    if (this.busy[wi]?.id === m.job) this.busy[wi] = null;
    this.dispatch(wi);
  }

  /** Воркер упал: его задания закончились ошибкой; следующий запуск создаст новый воркер. */
  private fail(wi: number, text: string): void {
    const all = [this.busy[wi], ...this.queues[wi]].filter((x): x is Job => !!x);
    this.workers[wi]?.terminate();
    delete this.workers[wi];
    this.busy[wi] = null;
    this.queues[wi] = [];
    for (const j of all) {
      this.jobs.delete(j.id);
      j.h.done?.({ type: 'done', job: j.id, run: 0, tick: -1, digest: [], applied: 0, inApplied: 0, error: text });
    }
    this.onError?.(text);
  }

  // ---------------- ветки ----------------

  /** Продолжить неактивную ветку в фоне до такта until (параллельная вселенная, досчитать, «без действия»). */
  continueBranch(b: Branch, until: number, kind: BgKind): boolean {
    const tl = this.tl;
    const spec = tl.bgSpec(b, until);
    if (!spec) return false;
    const id = this.submit(0, (job) => ({
      type: 'run', job, run: 0, snap: spec.snap, acts: spec.acts, actBase: spec.actBase, input: inputArrays(spec.input), inBase: spec.inBase,
      until, snapEvery: TM.BG_SNAP, rows: true, samples: true, marks: true, final: true,
    }), {
      progress: (m) => tl.bgProgress(b, id, m),
      snap: (m) => tl.bgSnap(b, id, m.snap),
      done: (m) => {
        tl.bgEnd(b, id);
        this.kinds.delete(id);
        if (!m.cancelled && !m.error) this.onBranchDone?.(b, kind, m);
      },
    });
    if (!id) return false;
    tl.bgBegin(b, id, until);
    this.kinds.set(id, kind);
    return true;
  }

  /** Что ветка считает в фоне. */
  kindOf(b: Branch): BgKind | null {
    return b.bg ? this.kinds.get(b.bg.job) ?? null : null;
  }

  /** Прервать фон ветки: её голова — последний пришедший снимок. */
  stopBranch(b: Branch): void {
    if (!b.bg) return;
    const id = b.bg.job;
    this.cancel(id);
    this.tl.bgEnd(b, id);
    this.kinds.delete(id);
  }

  /** «Параллельная вселенная»: предок идёт в фоне кусками, не дальше FOLLOW_AHEAD впереди живой ветки. */
  pace(liveTick: number): void {
    const tl = this.tl;
    if (tl.follow === null || tl.disabled) return;
    const F = tl.branches.find((x) => x.id === tl.follow);
    if (!F || F === tl.active) {
      tl.follow = null;
      return;
    }
    if (F.bg || F.headTick >= liveTick + TM.FOLLOW_AHEAD || this.load(0) > 0) return;
    this.continueBranch(F, Math.ceil((liveTick + TM.FOLLOW_CHUNK) / 300) * 300, 'follow');
  }

  /** 🔁 «Точно так же»: пересчитать ветку с развилки её записью; cb(true) — до бита то же. */
  verify(w: Parameters<Timeline['verifySpec']>[0], b: Branch, cb: (same: boolean | null, ticks: number) => void, progress?: (tick: number) => void): boolean {
    const v = this.tl.verifySpec(w, b);
    if (!v) return false;
    const s = v.spec;
    const id = this.submit(0, (job) => ({
      type: 'run', job, run: 0, snap: s.snap, acts: s.acts, actBase: s.actBase, input: inputArrays(s.input), inBase: s.inBase,
      until: s.until, snapEvery: 0, rows: false, samples: false, marks: false, final: false,
    }), {
      progress: (m) => progress?.(m.tick),
      done: (m) => cb(m.cancelled || m.error ? null : m.digest[0] === v.digest, s.until - s.snap.tick),
    });
    return id > 0;
  }
}
