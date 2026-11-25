// ⏪ «🎲 Плёнка жизни» (Гулд, Ленски): перемотать мир и запустить снова 3–6 раз с другими костями — что повторится?
import { mix32 } from '../lib/random';
import { GENE_INFO, type GeneKey } from '../sim/genome';
import { DAY, YEAR, type Creature, type World } from '../sim/world';
import { GUILD, isDiff, InputLog, inputArrays, type Action, type Branch, type ExpStart, type SeriesRow, type Timeline } from '../sim/timeline';
import { geneDistance, type DoneMsg, type ProgressMsg, type SpInfo, type TapeSummary } from '../sim/tmJob';
import type { WorldSnap } from '../sim/snapshot';
import type { TmRunner } from './tmRunner';
import type { SurfaceRenderer } from './renderer';

/** Что опытам нужно от страницы. */
export interface ExpHost {
  readonly tl: Timeline;
  readonly world: World;
  readonly runner: TmRunner;
  readonly renderer: SurfaceRenderer;
  queueFact(id: string, now?: boolean, extra?: string): void;
  /** Мир опыта стал веткой. */
  adopted(b: Branch): void;
  /** Окно опыта открыто (мир на паузе) / закрыто. */
  setOpen(on: boolean): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const day = (t: number) => Math.floor(t / DAY);
/** «в 3 из 4 мирах» */
const inN = (n: number, K: number) => `в ${n} из ${K} ${K % 10 === 1 && K % 100 !== 11 ? 'мире' : 'мирах'}`;

/** Короткое описание вида по средним генам (§10.1). */
export function describe(m: Record<GeneKey, number>): string {
  const size = m.size > 8 ? 'крупный ' : m.size < 3 ? 'мелкий ' : '';
  const diet = m.diet > 0.65 ? 'хищник' : m.diet < 0.3 ? 'травоядный' : 'всеядный';
  const suf = m.swim > 0.6 ? '-пловец' : m.tempPref < 0.28 ? ' с холодов' : m.tempPref > 0.72 ? ' из жарких мест' : '';
  return size + diet + suf;
}

interface Run {
  k: number;
  acts: Action[];
  input: InputLog;
  rows: SeriesRow[];
  prog: ProgressMsg[];
  tick: number;
  done: DoneMsg | null;
  snap: WorldSnap | null;
  sum: TapeSummary | null;
  job: number;
  branch: Branch | null;
  salt: number;
}

export class TapeView {
  private runs: Run[] = [];
  private start: ExpStart | null = null;
  private horizon = YEAR;
  private K = 3;
  private repeat = true;
  private fromRoot = false;
  private t0 = 0;
  private finished = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private el: HTMLElement, private host: ExpHost) {}

  get open(): boolean {
    return !this.el.hidden && this.el.dataset.kind === 'tape';
  }

  show(): void {
    const { tl, runner } = this.host;
    if (!runner.ok || tl.disabled) return;
    this.el.dataset.kind = 'tape';
    this.el.hidden = false;
    this.host.setOpen(true);
    this.host.queueFact('tm_gould');
    this.setup();
  }

  close(): void {
    for (const r of this.runs) if (!r.done) this.host.runner.cancel(r.job);
    this.runs = [];
    clearInterval(this.timer);
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.host.setOpen(false);
  }

  // ---------------- выбор опыта ----------------

  private setup(): void {
    const { tl, world: w, runner } = this.host;
    const now = tl.expStart(w);
    const later = (st: ExpStart) => tl.actLen() - st.cur[0];
    const hasActs = (root: boolean) => later(root ? tl.expRoot() ?? now : now) > 0;
    const ms = w.brainMode === 'neural' ? 1.6 : 2.6;
    const eta = (K: number, H: number) => Math.round((ms * H * Math.ceil((K + 1) / runner.pool) * 1.15) / 1000);
    const draw = () => {
      const six = runner.pool > 1;
      if (!six) this.K = 3;
      if (!six && this.horizon > YEAR) this.horizon = YEAR;
      this.el.innerHTML = `<div class="tm-card">
        <div class="row"><b>🎲 Плёнка жизни</b><button data-t="close" class="x" title="Закрыть">✕</button></div>
        <p class="small">Перемотаем историю и запустим её снова — несколько раз, с другими «костями». Что повторится, а что нет? <a data-fact="tm_gould">?</a></p>
        <div class="tm-opt"><span>Откуда</span>
          <button data-t="root" class="${this.fromRoot ? 'active' : ''}">С сотворения мира</button>
          <button data-t="now" class="${this.fromRoot ? '' : 'active'}">С этого момента (день ${day(w.tick)})</button></div>
        <div class="tm-opt"><span>Сколько миров</span>
          <button data-t="k3" class="${this.K === 3 ? 'active' : ''}">3</button>
          <button data-t="k6" class="${this.K === 6 ? 'active' : ''}" ${six ? '' : 'disabled title="На этом устройстве — только 3"'}>6</button>
          <em class="muted small">у Ленски было 12</em></div>
        <div class="tm-opt"><span>Насколько вперёд</span>
          <button data-t="h1" class="${this.horizon === YEAR ? 'active' : ''}">1 год</button>
          <button data-t="h2" class="${this.horizon === 2 * YEAR ? 'active' : ''}" ${six ? '' : 'disabled'}>2 года</button></div>
        ${hasActs(this.fromRoot) ? `<label class="tm-opt small"><input type="checkbox" data-t="rep" ${this.repeat ? 'checked' : ''}> Повторить мои вмешательства во всех мирах (тогда различаются только кости)</label>` : ''}
        <div class="muted small">Плюс «Ваш мир» для сравнения · займёт около ${eta(this.K, this.horizon)} с</div>
        <div class="row"><span></span><button data-t="go" class="act">▶ Запустить</button></div>
      </div>`;
    };
    draw();
    this.el.onclick = (e) => {
      const t = e.target as HTMLElement;
      const f = t.closest('[data-fact]') as HTMLElement | null;
      if (f) return this.host.queueFact(f.dataset.fact!, true);
      const b = t.closest('[data-t]') as HTMLElement | null;
      if (!b || (b as HTMLButtonElement).disabled) return;
      const k = b.dataset.t;
      if (k === 'close') return this.close();
      if (k === 'root') this.fromRoot = true;
      else if (k === 'now') this.fromRoot = false;
      else if (k === 'k3') this.K = 3;
      else if (k === 'k6') this.K = 6;
      else if (k === 'h1') this.horizon = YEAR;
      else if (k === 'h2') this.horizon = 2 * YEAR;
      else if (k === 'rep') this.repeat = (b as HTMLInputElement).checked;
      else if (k === 'go') return this.launch(this.fromRoot ? tl.expRoot() ?? now : now);
      draw();
    };
  }

  // ---------------- прогоны ----------------

  private launch(st: ExpStart): void {
    const { tl, runner } = this.host;
    this.start = st;
    this.finished = false;
    this.t0 = performance.now();
    const A = tl.active;
    const acts = tl.lineageActsFrom(A, st.cur[0]);
    const input = tl.lineageInputFrom(A, st.cur[1]);
    const until = st.tick + this.horizon;
    const pool = runner.expWorkers;
    this.runs = [];
    for (let k = 0; k <= this.K; k++) {
      const salt = k === 0 ? 0 : mix32(Date.now() ^ (k * 0x9e3779b9));
      const own: Action[] = k === 0 ? acts : [{ k: 'reseed', salt, t: st.tick } as Action, ...(this.repeat ? acts : acts.filter(isDiff))].map((a) => structuredClone(a));
      const inp = k === 0 || this.repeat ? input : new InputLog();
      const r: Run = { k, acts: own, input: inp, rows: [], prog: [], tick: st.tick, done: null, snap: null, sum: null, job: 0, branch: null, salt };
      this.runs.push(r);
      r.job = runner.submit(pool[k % pool.length], (job) => ({
        type: 'run', job, run: k, snap: st.snap, acts: own, actBase: st.cur[0], input: inputArrays(inp), inBase: st.cur[1],
        until, snapEvery: 0, rows: true, samples: false, marks: true, final: true, summary: st.nx,
      }), {
        progress: (m) => {
          r.rows.push(...m.rows);
          r.prog.push(m);
          r.tick = m.tick;
        },
        snap: (m) => (r.snap = m.snap),
        done: (m) => {
          r.done = m;
          r.sum = m.summary ?? null;
          r.tick = m.tick;
          this.render();
        },
      });
    }
    this.render();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.open && this.refresh(), 400);
  }

  private render(): void {
    const st = this.start;
    if (!st || !this.open) return;
    const until = st.tick + this.horizon;
    const N = this.runs.length;
    const all = this.runs.every((r) => r.done);
    const failed = this.runs.some((r) => r.done && (r.done.error || r.done.cancelled));
    const left = this.runs.filter((r) => !r.done).length;
    const pctDone = Math.round((100 * this.runs.reduce((n, r) => n + (r.tick - st.tick), 0)) / Math.max(1, N * this.horizon));
    const cards = this.runs.map((r) => {
      const s = r.sum;
      const C = s ? (s.g[2] > 0 ? 'есть' : '✝ вымерли') : '…';
      return `<div class="tm-world${r.k === 0 ? ' yours' : ''}" data-k="${r.k}">
        <div class="small"><b>${r.k === 0 ? '🌍 Ваш мир' : `🎲 Мир ${r.k}`}</b> ${r.done ? '' : `<span class="muted tm-pct">${Math.round((100 * (r.tick - st.tick)) / this.horizon)}%</span>`}</div>
        <canvas class="tm-wc"></canvas>
        ${s ? `<div class="tm-king"><canvas class="tm-pt"></canvas><div class="small">Царь горы: <b>${esc(s.top[0]?.name ?? '—')}</b> ${s.top[0]?.count ?? ''}</div></div>
          <div class="small">видов ${s.live} (новых ${s.fresh}) · хищники: ${C}</div>
          ${r.k > 0 ? (r.branch ? `<div class="small muted">ветка ${r.branch.letter}</div>` : `<button data-t="branch" data-k="${r.k}" ${r.snap ? '' : 'disabled'}>🌿 Сделать веткой</button>`) : ''}` : r.done?.error ? `<div class="small red">ошибка</div>` : ''}
      </div>`;
    });
    const head = `<div class="row"><b>🎲 Плёнка жизни · ${this.fromRoot ? 'с сотворения мира' : `с дня ${day(st.tick)}`} → день ${day(until)}</b><button data-t="close" class="x" title="Закрыть">✕</button></div>
      <div class="small muted tm-status">${all ? `готово за ${Math.round((performance.now() - this.t0) / 1000)} с` : `считаю… ${pctDone}% · осталось миров: ${left}`}</div>`;
    const sum = all && !failed ? this.summary() : failed ? '<p class="small">Часть миров не досчиталась.</p>' : '';
    this.el.innerHTML = `<div class="tm-card wide">${head}<div class="tm-grid">${cards.join('')}</div>${sum}</div>`;
    this.el.querySelectorAll<HTMLElement>('.tm-world').forEach((card) => {
      const r = this.runs[Number(card.dataset.k)];
      this.drawMini(card.querySelector('.tm-wc')!, r.rows, st.tick, until);
      const pt = card.querySelector<HTMLCanvasElement>('.tm-pt');
      const top = r.sum?.top[0];
      if (pt && top) this.host.renderer.portrait(pt, fakeCreature(top, this.host.world.width / 2, this.host.world.height / 2));
    });
    this.el.onclick = (e) => {
      const t = e.target as HTMLElement;
      const f = t.closest('[data-fact]') as HTMLElement | null;
      if (f) return this.host.queueFact(f.dataset.fact!, true);
      const b = t.closest('[data-t]') as HTMLElement | null;
      if (!b || (b as HTMLButtonElement).disabled) return;
      if (b.dataset.t === 'close') this.close();
      else if (b.dataset.t === 'branch') this.adopt(this.runs[Number(b.dataset.k)]);
    };
    if (all && !this.finished && !failed) {
      this.finished = true;
      clearInterval(this.timer);
      this.host.queueFact('tm_lenski');
      const sums = this.runs.map((r) => r.sum!);
      for (let g = 0; g < 4; g++) {
        const alive = sums.filter((s) => s.g[g] > 0).length;
        if (alive > 0 && alive < sums.length) {
          this.host.queueFact('tm_drift');
          break;
        }
      }
      if (this.converge()) this.host.queueFact('tm_convergence');
    }
  }

  /** Пока миры считаются — только проценты и графики (кнопки не перерисовываем: нажатия не теряются). */
  private refresh(): void {
    const st = this.start;
    if (!st) return;
    const until = st.tick + this.horizon;
    const N = this.runs.length;
    const pctDone = Math.round((100 * this.runs.reduce((n, r) => n + (r.tick - st.tick), 0)) / Math.max(1, N * this.horizon));
    const status = this.el.querySelector('.tm-status');
    if (status && !this.runs.every((r) => r.done)) status.textContent = `считаю… ${pctDone}% · осталось миров: ${this.runs.filter((r) => !r.done).length}`;
    this.el.querySelectorAll<HTMLElement>('.tm-world').forEach((card) => {
      const r = this.runs[Number(card.dataset.k)];
      if (r.done) return;
      const p = card.querySelector('.tm-pct');
      if (p) p.textContent = `${Math.round((100 * (r.tick - st.tick)) / this.horizon)}%`;
      this.drawMini(card.querySelector('.tm-wc')!, r.rows, st.tick, until);
    });
  }

  private drawMini(cv: HTMLCanvasElement, rows: SeriesRow[], t0: number, t1: number): void {
    const cw = cv.clientWidth || 140, ch = cv.clientHeight || 44;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    let max = 5;
    for (const r of rows) max = Math.max(max, r.n);
    const X = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * cw;
    for (let g = 3; g >= 0; g--) {
      ctx.fillStyle = GUILD[g].color;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(X(t0), ch);
      for (const r of rows) {
        let s = 0;
        for (let k = 0; k <= g; k++) s += r.g[k];
        ctx.lineTo(X(r.t), ch - (s / max) * (ch - 2));
      }
      if (rows.length) ctx.lineTo(X(rows[rows.length - 1].t), ch);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------------- выводы ----------------

  /** Похожие новые виды из разных миров: [число миров, описание] или null. */
  private converge(): [number, string] | null {
    const born: { run: number; s: SpInfo }[] = [];
    for (const r of this.runs) for (const s of r.sum?.born ?? []) born.push({ run: r.k, s });
    let best: { runs: Set<number>; s: SpInfo } | null = null;
    for (const a of born) {
      const runs = new Set([a.run]);
      for (const b of born) if (b.run !== a.run && geneDistance(a.s.mean, b.s.mean, GENE_INFO) < 0.05) runs.add(b.run);
      if (runs.size >= 2 && (!best || runs.size > best.runs.size)) best = { runs, s: a.s };
    }
    return best ? [best.runs.size, describe(best.s.mean)] : null;
  }

  private summary(): string {
    const S = this.runs.map((r) => r.sum!);
    const K = S.length;
    const st = this.start!;
    const lines: { text: string; n: number }[] = [];
    // 1. самая многочисленная гильдия
    const top = S.map((s) => s.g.indexOf(Math.max(...s.g)));
    const mode = (xs: number[]) => {
      const c = new Map<number, number>();
      for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
      let bx = xs[0], bn = 0;
      for (const [x, n] of c) if (n > bn) (bx = x), (bn = n);
      return [bx, bn] as const;
    };
    const [g1, n1] = mode(top);
    lines.push({ text: `Больше всех — ${GUILD[g1].icon} ${GUILD[g1].name}: ${inN(n1, K)}`, n: n1 });
    // 2. хищники есть
    const pred = S.filter((s) => s.g[2] >= 5).length;
    lines.push({ text: pred >= K - pred ? `🍖 Хищники выжили ${inN(pred, K)}` : `🍖 Хищники вымерли ${inN(K - pred, K)}`, n: Math.max(pred, K - pred) });
    // 3. тот же царь горы (общий вид — родился до начала)
    const lead = S.map((s, i) => (s.top[0] && s.top[0].id < st.nx ? s.top[0].id : -1 - i));
    const [lid, ln] = mode(lead);
    const lname = S.flatMap((s) => s.top).find((x) => x.id === lid)?.name;
    lines.push({ text: lid >= 0 && ln > 1 ? `👑 Царь горы тот же — «${esc(lname ?? '?')}»: ${inN(ln, K)}` : '👑 Царь горы везде свой', n: lid >= 0 ? ln : 1 });
    // 4. новые виды
    const fr = S.map((s) => s.fresh);
    const lo = Math.min(...fr), hi = Math.max(...fr);
    const [fm] = mode(fr);
    lines.push({ text: `🧬 Новых видов: ${lo === hi ? `везде ${lo}` : `от ${lo} до ${hi}`}`, n: fr.filter((x) => Math.abs(x - fm) <= 1).length });
    // 5. пловцы ≥ 30%
    const sw = S.filter((s) => s.g[3] >= 0.3 * Math.max(1, s.n)).length;
    lines.push({ text: sw >= K - sw ? `🐟 Пловцов не меньше трети ${inN(sw, K)}` : `🐟 Пловцов меньше трети ${inN(K - sw, K)}`, n: Math.max(sw, K - sw) });
    const strong = lines.filter((l) => l.n >= 0.75 * K).length >= 4;
    const conv = this.converge();
    return `<h4>Что повторилось, а что нет</h4><ul class="tm-sum">${lines.map((l) => `<li>${l.text}</li>`).join('')}${
      conv ? `<li>🔁 Похожие виды возникли независимо ${inN(conv[0], K)}: ${esc(conv[1])} <a data-fact="tm_convergence">?</a></li>` : ''
    }</ul><p class="tm-verdict">${strong
      ? 'Здесь отбор сильнее случая: многое повторяется (как рост приспособленности во всех 12 колбах Ленски).'
      : 'Случай решает многое: перемотайте плёнку — получится другой мир (Гулд).'} <a data-fact="tm_lenski">?</a></p>`;
  }

  private adopt(r: Run): void {
    const { tl } = this.host;
    if (!this.start || !r.snap || !r.done || r.branch) return;
    const b = tl.adopt(this.start, {
      acts: r.acts, applied: r.done.applied, input: r.input, inApplied: r.done.inApplied, head: r.snap,
      rows: r.prog.flatMap((m) => m.rows), marks: r.prog.flatMap((m) => m.marks), names: r.prog.flatMap((m) => m.names),
      name: `Плёнка жизни: мир ${r.k} (день ${day(this.start.tick)})`, icon: '🎲', intervention: r.acts[0],
    });
    if (!b) return;
    r.branch = b;
    r.snap = null; // снимок теперь — голова ветки
    this.host.adopted(b);
    this.render();
  }
}

/** Существо для портрета: средние гены вида, его цвет и узор. */
export function fakeCreature(s: SpInfo, x: number, y: number): Creature {
  return { x, y, heading: 0, v: 0, age: 9999, energy: 1e9, sick: 0, vir: 0, g: { ...s.mean, hue: s.hue, pattern: s.pattern, brain: null } } as unknown as Creature;
}
