// ⏪ «🔬 Повторится ли?» (Блаунт): окно опыта. Перезапускаем историю с новыми костями из трёх снимков всё ближе к
// событию — и смотрим, с какого момента оно начинает повторяться.
import { DAY } from '../sim/world';
import type { GeneKey } from '../sim/genome';
import { GUILD, type Mark, type SeriesRow } from '../sim/timeline';
import type { DoneMsg } from '../sim/tmJob';
import { blountJobs, blountPlan, blountRepeated, blountVerdict, type BlountPlan, type BlountRow } from '../sim/tmBlount';
import type { ExpHost } from './tapeView';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const day = (t: number) => Math.floor(t / DAY);

interface BRun { start: number; run: number; reseed: boolean; job: number; rows: SeriesRow[]; tick: number; from: number; done: DoneMsg | null }

export class BlountView {
  private plan: BlountPlan | null = null;
  private runs: BRun[] = [];
  private t0 = 0;
  private finished = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private el: HTMLElement, private host: ExpHost) {}

  get open(): boolean {
    return !this.el.hidden && this.el.dataset.kind === 'blount';
  }

  /** Можно ли поставить опыт для этой отметки (есть снимки до неё). */
  can(m: Mark): boolean {
    return !!blountPlan(this.host.tl, m);
  }

  show(m: Mark): boolean {
    const { tl, runner } = this.host;
    const P = blountPlan(tl, m);
    if (!runner.ok || tl.disabled || !P) return false;
    this.plan = P;
    this.el.dataset.kind = 'blount';
    this.el.hidden = false;
    this.host.setOpen(true);
    this.setup();
    return true;
  }

  close(): void {
    for (const r of this.runs) if (!r.done) this.host.runner.cancel(r.job);
    this.runs = [];
    clearInterval(this.timer);
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.host.setOpen(false);
  }

  private what(P: BlountPlan): string {
    if (P.kind === 'birth') return `появится ли снова вид, похожий на «${esc(P.name!)}»`;
    if (P.kind === 'extinct') return `вымрет ли снова «${esc(P.name!)}»`;
    return `исчезнут ли снова все ${GUILD[P.guild]?.name ?? 'звери этой гильдии'}`;
  }

  private setup(): void {
    const P = this.plan!;
    const { world: w, runner } = this.host;
    const ticks = P.starts.reduce((n, s, i) => n + (P.until - s.tick) * (i === P.starts.length - 1 ? 3 : 2), 0);
    const ms = w.brainMode === 'neural' ? 1.6 : 2.6;
    const eta = Math.round((ms * ticks * 1.15) / Math.max(1, runner.expWorkers.length) / 1000);
    this.el.innerHTML = `<div class="tm-card">
      <div class="row"><b>🔬 Повторится ли?</b><button data-t="close" class="x" title="Закрыть">✕</button></div>
      <p class="small">День ${day(P.t)}: <b>${esc(P.text)}</b></p>
      <p class="small">Перезапустим историю с новыми «костями» из ${P.starts.length} ${P.starts.length === 1 ? 'снимка' : 'снимков'} — всё ближе к событию — по 2 мира из каждого и посмотрим, ${this.what(P)} к дню ${day(P.until)}. Так Зак Блаунт размораживал бактерии Ленски из разных «эпох». <a data-fact="tm_blount">?</a></p>
      <div class="muted small">Старт: ${P.starts.map((s) => `день ${day(s.tick)}`).join(' · ')} · займёт около ${eta} с</div>
      <div class="row"><span></span><button data-t="go" class="act">▶ Запустить</button></div>
    </div>`;
    this.el.onclick = (e) => this.click(e);
  }

  private click(e: Event): void {
    const t = e.target as HTMLElement;
    const f = t.closest('[data-fact]') as HTMLElement | null;
    if (f) return this.host.queueFact(f.dataset.fact!, true);
    const b = t.closest('[data-t]') as HTMLElement | null;
    if (!b || (b as HTMLButtonElement).disabled) return;
    if (b.dataset.t === 'close') this.close();
    else if (b.dataset.t === 'go') this.launch();
  }

  private launch(): void {
    const P = this.plan!;
    const { tl, runner } = this.host;
    const pool = runner.expWorkers;
    this.t0 = performance.now();
    this.finished = false;
    this.runs = [];
    for (const j of blountJobs(tl, P)) {
      const r: BRun = { start: j.start, run: j.run, reseed: j.reseed, job: 0, rows: [], tick: j.job.snap.tick, from: j.job.snap.tick, done: null };
      this.runs.push(r);
      r.job = runner.submit(pool[j.run % pool.length], (job) => ({ ...j.job, job }), {
        progress: (m) => {
          r.rows.push(...m.rows);
          r.tick = m.tick;
        },
        done: (m) => {
          r.done = m;
          r.tick = m.tick;
          this.render();
        },
      });
    }
    this.render();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.open && this.progress(), 500);
  }

  private pct(): number {
    const P = this.plan!;
    const all = this.runs.reduce((n, r) => n + (P.until - r.from), 0);
    const done = this.runs.reduce((n, r) => n + (r.tick - r.from), 0);
    return Math.round((100 * done) / Math.max(1, all));
  }

  private progress(): void {
    const s = this.el.querySelector('.tm-status');
    if (s && !this.runs.every((r) => r.done)) s.textContent = `считаю… ${this.pct()}%`;
  }

  /** Итог по точкам старта; ref — точный повтор («ваша история»). */
  result(): { rows: BlountRow[]; ref: boolean | null; verdict: string } | null {
    const P = this.plan!;
    if (!this.runs.length || !this.runs.every((r) => r.done && r.done.summary)) return null;
    const ref = this.runs.find((r) => !r.reseed);
    const Xmean: Record<GeneKey, number> | null = P.kind === 'birth' ? ref?.done?.summary?.watch?.mean ?? null : null;
    const rows: BlountRow[] = P.starts.map((s) => ({ tick: s.tick, yes: 0, of: 0 }));
    for (const r of this.runs) {
      if (!r.reseed) continue;
      const rep = blountRepeated(P, r.done!.summary!, r.rows, Xmean);
      if (rep === null) continue;
      rows[r.start].of++;
      if (rep) rows[r.start].yes++;
    }
    let refOk: boolean | null = null;
    if (ref?.done?.summary) {
      if (P.kind === 'birth') refOk = !!ref.done.summary.watch?.found;
      else refOk = blountRepeated(P, ref.done.summary, ref.rows, Xmean);
    }
    return { rows, ref: refOk, verdict: blountVerdict(rows, P.kind) };
  }

  private render(): void {
    const P = this.plan;
    if (!P || !this.open) return;
    const all = this.runs.every((r) => r.done);
    const failed = this.runs.some((r) => r.done && (r.done.error || r.done.cancelled));
    const head = `<div class="row"><b>🔬 Повторится ли? · день ${day(P.t)}</b><button data-t="close" class="x" title="Закрыть">✕</button></div>
      <p class="small">${esc(P.text)} — ${this.what(P)}?</p>
      <div class="small muted tm-status">${all ? `готово за ${Math.round((performance.now() - this.t0) / 1000)} с` : `считаю… ${this.pct()}%`}</div>`;
    let body = '';
    const res = all && !failed ? this.result() : null;
    if (failed) body = '<p class="small">Часть миров не досчиталась.</p>';
    else if (res) {
      const cells = res.rows.map((r) => `<div class="bl-row"><span>с дня ${day(r.tick)}</span>${r.of ? `<b>${r.yes} из ${r.of}</b><i class="bl-bar"><i style="width:${(100 * r.yes) / r.of}%"></i></i>` : '<em class="muted">вида ещё не было</em>'}</div>`);
      body = `<div class="bl-table">${cells.join('')}</div>
        <p class="small"><b>${esc(res.verdict)}</b></p>
        ${res.ref === false ? '<p class="small muted">Точный повтор («ваша история») не дошёл до события — запись истории неполная.</p>' : ''}
        <p class="small muted">«Повторилось» — ${P.kind === 'birth' ? 'появился новый вид, похожий на этот (средние гены отличаются меньше чем на 5%), и дорос хотя бы до 8 особей' : P.kind === 'extinct' ? 'вид вымер к концу прогона' : 'гильдия исчезла с острова около того же дня'}.</p>`;
    }
    this.el.innerHTML = `<div class="tm-card">${head}${body}</div>`;
    this.el.onclick = (e) => this.click(e);
    if (res && !this.finished) {
      this.finished = true;
      clearInterval(this.timer);
      this.host.queueFact('tm_blount');
    }
  }
}
