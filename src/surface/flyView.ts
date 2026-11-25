// ⏪ «🦋 Эффект бабочки» (Лоренц): два мира шаг в шаг, в одном особь сдвинута на миллионную долю пикселя.
import { DAY } from '../sim/world';
import { inputArrays, type Action, type Branch, type ExpStart, type InputLog } from '../sim/timeline';
import { FLY_GRID, type DoneMsg, type FrameMsg, type ProgressMsg } from '../sim/tmJob';
import type { WorldSnap } from '../sim/snapshot';
import type { ExpHost } from './tapeView';

const FLY_DX = 1e-6;
const HORIZON = 2400;
const MAX = 6000;

export class FlyView {
  private start: ExpStart | null = null;
  private job = 0;
  private frame: FrameMsg | null = null;
  private series: { t: number; s: number }[] = [];
  private first: number | null = null;
  private half: number | null = null;
  private done: DoneMsg | null = null;
  private snap: WorldSnap | null = null;
  private prog: ProgressMsg[] = [];
  private acts: Action[] = [];
  private input: InputLog | null = null;
  private target = { id: 0, x: 0, y: 0 };
  private branch: Branch | null = null;
  private shown = false;

  constructor(private el: HTMLElement, private host: ExpHost) {}

  get open(): boolean {
    return !this.el.hidden && this.el.dataset.kind === 'fly';
  }

  /** Запустить опыт: c — особь-бабочка (выбранная или из середины списка). */
  show(cId: number | null): void {
    const { tl, world: w, runner } = this.host;
    if (!runner.ok || tl.disabled) return;
    const c = (cId !== null ? w.creatures.find((x) => x.id === cId && x.alive) : null) ?? w.creatures[w.creatures.length >> 1];
    if (!c) return;
    this.el.dataset.kind = 'fly';
    this.el.hidden = false;
    this.host.setOpen(true);
    const st = (this.start = tl.expStart(w));
    this.target = { id: c.id, x: c.x, y: c.y };
    this.frame = null;
    this.series = [];
    this.first = this.half = null;
    this.done = null;
    this.snap = null;
    this.prog = [];
    this.branch = null;
    this.shown = false;
    const lin = tl.lineageActsFrom(tl.active, st.cur[0]);
    this.input = tl.lineageInputFrom(tl.active, st.cur[1]);
    const nudge: Action = { k: 'nudge', id: c.id, dx: FLY_DX, t: st.tick };
    this.acts = [nudge, ...lin];
    const input = this.input;
    this.job = runner.submit(runner.expWorkers[0], (job) => ({
      type: 'multi', job, snap: st.snap, runs: [{ pre: [] }, { pre: [nudge] }], acts: lin, actBase: st.cur[0], input: inputArrays(input), inBase: st.cur[1],
      until: st.tick + HORIZON, extend: { max: st.tick + MAX, share: 0.5 }, every: 25, keep: 1,
    }), {
      frame: (m) => this.onFrame(m),
      progress: (m) => this.prog.push(m),
      snap: (m) => (this.snap = m.snap),
      done: (m) => {
        this.done = m;
        this.finish();
        this.render();
      },
    });
    this.render();
  }

  close(): void {
    if (this.job && !this.done) this.host.runner.cancel(this.job);
    this.job = 0;
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.host.setOpen(false);
  }

  private onFrame(m: FrameMsg): void {
    const st = this.start!;
    this.frame = m;
    this.series.push({ t: m.tick, s: m.share });
    if (this.first === null && m.cells > 0) this.first = m.tick;
    if (this.half === null && m.share >= 0.5) {
      this.half = m.tick;
      this.finish();
    }
    if (!this.open) return;
    this.draw();
    const s = this.el.querySelector('.fly-status');
    if (s) s.textContent = this.status();
    const d = this.el.querySelector('.fly-day');
    if (d) d.textContent = `день ${Math.floor(m.tick / DAY)} (+${Math.floor((m.tick - st.tick) / DAY)})`;
  }

  /** Карточка — когда известны обе даты (или к концу опыта). */
  private finish(): void {
    if (this.shown || this.first === null || !this.start) return;
    const st = this.start;
    const d1 = Math.max(1, Math.round((this.first - st.tick) / DAY));
    if (this.half === null && !this.done) return;
    this.shown = true;
    const extra = this.half !== null
      ? `В этом опыте разница стала видна через ${d1} дн., а полострова разошлось за ${Math.round((this.half - st.tick) / DAY)} дн.`
      : `В этом опыте разница стала видна через ${d1} дн.`;
    this.host.queueFact('tm_butterfly', true, extra);
  }

  private status(): string {
    const f = this.frame;
    if (!f || f.cells === 0) return 'Миры совпадают — разница меньше пикселя, но она растёт';
    if (this.half !== null) return `День ${Math.floor(this.half / DAY)}: различается полострова`;
    return `День ${Math.floor(this.first! / DAY)}: первые различия — рядом с бабочкой`;
  }

  private render(): void {
    if (!this.open || !this.start) return;
    const st = this.start;
    const f = this.frame;
    const btn = this.branch
      ? `<span class="small muted">Сохранено: ветка ${this.branch.letter}</span>`
      : `<button data-f="branch" ${this.snap && this.done && !this.done.error ? '' : 'disabled'}>🌿 Сохранить мир с бабочкой как ветку</button>`;
    this.el.innerHTML = `<div class="tm-card wide">
      <div class="row"><b>🦋 Эффект бабочки</b><button data-f="close" class="x" title="Закрыть">✕</button></div>
      <p class="small">Два одинаковых мира — с теми же «костями». В правом особь #${this.target.id} сдвинута на миллионную долю пикселя. Красное — где миры различаются. <a data-fact="tm_butterfly">?</a></p>
      <div class="fly-maps"><div><div class="small">Без бабочки</div><canvas class="fly-a"></canvas></div><div><div class="small">С бабочкой 🦋</div><canvas class="fly-b"></canvas></div></div>
      <div class="small"><b class="fly-status">${this.status()}</b> · <span class="muted fly-day">${f ? `день ${Math.floor(f.tick / DAY)} (+${Math.floor((f.tick - st.tick) / DAY)})` : ''}</span></div>
      <div class="small">Сколько острова различается, %</div><canvas class="fly-chart"></canvas>
      <div class="row"><span class="small muted">${this.done ? (this.done.error ? 'Не удалось досчитать' : `Готово: ${Math.round((this.done.tick - st.tick) / DAY)} дн.`) : 'считаю…'}</span>${btn}</div>
    </div>`;
    this.el.onclick = (e) => {
      const t = e.target as HTMLElement;
      const fa = t.closest('[data-fact]') as HTMLElement | null;
      if (fa) return this.host.queueFact(fa.dataset.fact!, true);
      const b = t.closest('[data-f]') as HTMLElement | null;
      if (!b || (b as HTMLButtonElement).disabled) return;
      if (b.dataset.f === 'close') this.close();
      else if (b.dataset.f === 'branch') this.adopt();
    };
    this.draw();
  }

  private draw(): void {
    const f = this.frame;
    const base = this.host.renderer.miniBase;
    const { world: w } = this.host;
    const [GX, GY] = FLY_GRID;
    this.el.querySelectorAll<HTMLCanvasElement>('.fly-a, .fly-b').forEach((cv, i) => {
      const cw = cv.clientWidth || 200, ch = cv.clientHeight || 125;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(cw * dpr)) (cv.width = Math.round(cw * dpr)), (cv.height = Math.round(ch * dpr));
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (base) ctx.drawImage(base, 0, 0, cw, ch);
      if (!f) return;
      const sx = cw / w.width, sy = ch / w.height;
      const d = f.dots[i];
      for (let o = 0; o < d.length; o += 3) {
        ctx.fillStyle = `hsl(${d[o + 2]},70%,72%)`;
        ctx.fillRect(d[o] * sx - 0.75, d[o + 1] * sy - 0.75, 1.5, 1.5);
      }
      ctx.fillStyle = 'rgba(255,60,50,0.35)';
      const cx = cw / GX, cy = ch / GY;
      for (let k = 0; k < f.diff.length; k++) if (f.diff[k]) ctx.fillRect((k % GX) * cx, Math.floor(k / GX) * cy, cx, cy);
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(this.target.x * sx, this.target.y * sy, 6, 0, Math.PI * 2);
      ctx.stroke();
    });
    const cv = this.el.querySelector<HTMLCanvasElement>('.fly-chart');
    if (!cv || !this.start) return;
    const cw = cv.clientWidth || 300, ch = cv.clientHeight || 60;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const t0 = this.start.tick, t1 = Math.max(t0 + HORIZON, this.series.at(-1)?.t ?? 0);
    const X = (t: number) => 2 + ((t - t0) / (t1 - t0)) * (cw - 4);
    const Y = (s: number) => ch - 2 - s * (ch - 6);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, Y(0.5));
    ctx.lineTo(cw, Y(0.5));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(230,232,223,0.5)';
    ctx.font = '9px system-ui';
    ctx.fillText('50%', 3, Y(0.5) - 2);
    ctx.strokeStyle = '#ff6b5b';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    this.series.forEach((p, k) => (k ? ctx.lineTo(X(p.t), Y(p.s)) : ctx.moveTo(X(p.t), Y(p.s))));
    ctx.stroke();
  }

  private adopt(): void {
    const { tl } = this.host;
    const st = this.start;
    if (!st || !this.snap || !this.done || this.branch || !this.input) return;
    const b = tl.adopt(st, {
      acts: this.acts, applied: this.done.applied, input: this.input, inApplied: this.done.inApplied, head: this.snap,
      rows: this.prog.flatMap((m) => m.rows), marks: this.prog.flatMap((m) => m.marks), names: this.prog.flatMap((m) => m.names),
      name: 'Взмах бабочки', icon: '🦋', intervention: this.acts[0],
    });
    if (!b) return;
    this.branch = b;
    this.snap = null;
    this.host.adopted(b);
    this.render();
  }
}
