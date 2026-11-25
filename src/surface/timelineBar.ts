// ⏪ Шкала машины времени под картой: гильдии по времени, снимки, развилки, события; перетаскивание — в прошлое.
import { DAY, YEAR, type World } from '../sim/world';
import { GUILD, type Mark, type Timeline } from '../sim/timeline';

/** Что шкала просит у страницы. */
export interface BarHost {
  readonly tl: Timeline;
  readonly world: World;
  /** Перетаскивание: встать в снимок, ближайший к t (или в настоящее). */
  scrub(t: number): void;
  stepSnap(dir: -1 | 1): void;
  openMenu(): void;
  /** Точно встать в такт t (stopBefore — до действия с этим номером); then — когда дошли. */
  seek(t: number, stopBefore?: number, then?: () => void): void;
  forkWithout(ref: number): void;
  /** Встать незадолго до t и открыть меню «Что если…». */
  intervene(t: number): void;
  /** Встать незадолго до вымирания вида и спасти его. */
  rescue(name: string, tEnd: number): void;
  setOpen(on: boolean): void;
  toast(text: string): void;
  /** 🎲 Плёнка жизни и 🦋 Эффект бабочки. */
  openTape(): void;
  openFly(): void;
  /** 📌 Закладка (B). */
  bookmark(): void;
  /** «🔬 Повторится ли?» для отметки (false — опыт для неё невозможен). */
  canBlount(m: Mark): boolean;
  blount(m: Mark): void;
  /** Что считается в фоне (подпись в углу шкалы). */
  bgText(): string;
}

/** Значок группы отметок — самого «важного» вида события. */
const PRIORITY = ['☄️', '💀', '🍖', '🦠', '🔥', '🧬', '⛵', '👑', '🌿'];
const prio = (icon: string) => {
  const i = PRIORITY.findIndex((p) => icon.startsWith(p.replace('️', '')));
  return i < 0 ? PRIORITY.length : i;
};
const nameIn = (text: string) => /«([^»]+)»/.exec(text)?.[1] ?? null;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** x — начало склейки, ix — где нарисован значок (у отметки, давшей значок). */
interface Cluster { x: number; ix: number; marks: Mark[]; icon: string; major: boolean }

export class TimelineBar {
  /** Шкала за последние 2 года (иначе — вся история). */
  recent = false;
  open = true;
  private canvas: HTMLCanvasElement;
  private tip: HTMLElement;
  private more: HTMLElement;
  private clusters: Cluster[] = [];
  private geo = { t0: 0, t1: 1, W: 1, lane: 18 };
  private dragging = false;
  private lastScrub = 0;
  private pendingT: number | null = null;
  private tipPinned = false;
  private tipTimer: ReturnType<typeof setTimeout> | undefined;
  private tipKey = '';
  /** Отметка подсказки, для которой можно поставить опыт «🔬 Повторится ли?». */
  private tipMark: Mark | null = null;

  constructor(private el: HTMLElement, private opener: HTMLElement, private host: BarHost) {
    el.innerHTML = `<div class="tl-btns">
        <button data-tl="prev" title="Назад к прошлому снимку ( [ )">⏪</button>
        <button data-tl="next" class="tl-wide" title="Вперёд ( ] )">⏩</button>
        <button data-tl="menu" title="Что если… — вмешаться и пустить историю по новой ветке">🌿</button>
        <button data-tl="tape" class="tl-wide" title="Плёнка жизни: перемотать и запустить снова">🎲</button>
        <button data-tl="fly" class="tl-wide" title="Эффект бабочки">🦋</button>
        <button data-tl="book" class="tl-wide" title="Закладка (B): сохранить мир — переживёт перезагрузку">📌</button>
        <button data-tl="range" class="tl-wide" title="Вся история / последние 2 года">↔</button>
        <button data-tl="more" class="tl-narrow" title="Ещё">⋯</button>
      </div>
      <canvas class="tl-canvas"></canvas>
      <button data-tl="hide" class="tl-hide tl-wide" title="Свернуть шкалу времени">▾</button>
      <div class="tl-tip" hidden></div>
      <div class="tl-more" hidden>
        <button data-tl="next">⏩ Вперёд</button>
        <button data-tl="tape">🎲 Плёнка жизни</button>
        <button data-tl="fly">🦋 Эффект бабочки</button>
        <button data-tl="book">📌 Закладка</button>
        <button data-tl="range">↔ Вся история / 2 года</button>
        <button data-tl="hide">▾ Свернуть шкалу</button>
      </div>`;
    this.canvas = el.querySelector('.tl-canvas')!;
    this.tip = el.querySelector('.tl-tip')!;
    this.more = el.querySelector('.tl-more')!;
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-tl]') as HTMLElement | null;
      if (!b || (b as HTMLButtonElement).disabled) return;
      const k = b.dataset.tl;
      if (k !== 'more') this.more.hidden = true;
      if (this.host.tl.locked && k !== 'hide' && k !== 'more') {
        this.host.toast('🔒 Во время урока машина времени на паузе');
        return;
      }
      if (k === 'prev') this.host.stepSnap(-1);
      else if (k === 'next') this.host.stepSnap(1);
      else if (k === 'menu') this.host.openMenu();
      else if (k === 'tape') this.host.openTape();
      else if (k === 'fly') this.host.openFly();
      else if (k === 'book') this.host.bookmark();
      else if (k === 'range') {
        this.recent = !this.recent;
        this.draw();
      } else if (k === 'more') this.more.hidden = !this.more.hidden;
      else if (k === 'hide') this.host.setOpen(false);
    });
    opener.addEventListener('click', () => this.host.setOpen(true));
    this.tip.addEventListener('click', (e) => this.tipClick(e));
    this.tip.addEventListener('pointerenter', () => clearTimeout(this.tipTimer));
    this.tip.addEventListener('pointerleave', () => this.hideTipSoon());
    this.bindCanvas();
  }

  setOpen(on: boolean): void {
    this.open = on;
    this.el.hidden = !on;
    this.opener.hidden = on;
    if (on) this.draw();
  }

  // ---------------- рисование ----------------

  draw(): void {
    if (!this.open) return;
    const cv = this.canvas;
    const cw = cv.clientWidth, ch = cv.clientHeight;
    if (!cw || !ch) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
    }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const { tl, world: w } = this.host;
    const A = tl.active;
    this.el.classList.toggle('locked', tl.locked);
    this.el.querySelectorAll<HTMLButtonElement>('.tl-btns [data-tl]:not([data-tl=more])').forEach((b) => (b.disabled = tl.locked || tl.disabled));
    const lane = ch < 50 ? 15 : 18;
    const t1 = Math.max(A.headTick, w.tick, 1);
    const t0 = this.recent ? Math.max(0, t1 - 2 * YEAR) : 0;
    const W = cw;
    const X = (t: number) => 6 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 12);
    this.geo = { t0, t1, W, lane };
    const top = lane, bot = ch - 6, H = bot - top;
    // дорожка: гильдии стопкой
    const rows = tl.lineageRows(A);
    let i0 = 0;
    while (i0 < rows.length - 1 && rows[i0 + 1].t < t0) i0++;
    const vis = rows.slice(i0);
    let maxN = 5;
    for (const r of vis) maxN = Math.max(maxN, r.n);
    const nowX = X(w.tick);
    const paint = (alpha: number) => {
      for (let g = 3; g >= 0; g--) {
        ctx.fillStyle = GUILD[g].color;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(X(Math.max(t0, vis[0].t)), bot);
        for (const r of vis) {
          let s = 0;
          for (let k = 0; k <= g; k++) s += r.g[k];
          ctx.lineTo(X(Math.max(t0, r.t)), bot - (s / maxN) * H);
        }
        ctx.lineTo(X(vis[vis.length - 1].t), bot);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    if (vis.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, nowX, ch);
      ctx.clip();
      paint(0.45);
      ctx.restore();
      if (nowX < W) {
        // записанное будущее, пока мы в прошлом, — бледное
        ctx.save();
        ctx.beginPath();
        ctx.rect(nowX, 0, W - nowX, ch);
        ctx.clip();
        paint(0.16);
        ctx.restore();
      }
    }
    // годы
    ctx.font = '9px system-ui';
    ctx.fillStyle = 'rgba(230,232,223,0.45)';
    ctx.strokeStyle = 'rgba(230,232,223,0.12)';
    ctx.lineWidth = 1;
    const yStep = t1 - t0 > 20 * YEAR ? 5 * YEAR : YEAR;
    for (let t = Math.ceil(t0 / yStep) * yStep; t <= t1; t += yStep) {
      if (t === 0) continue;
      const x = Math.round(X(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bot);
      ctx.stroke();
      if (x + 26 < W) ctx.fillText(`г.${t / YEAR + 1}`, x + 2, bot - 2);
    }
    // снимки
    const snaps = tl.lineageSnaps(A);
    for (const s of snaps) {
      if (s.tick < t0) continue;
      ctx.fillStyle = s.kind === 'auto' ? '#6b7280' : s.kind === 'pre' || s.kind === 'event' ? '#e8c547' : '#ffffff';
      ctx.fillRect(Math.round(X(s.tick)) - 1, ch - 5, 2, 5);
    }
    // развилки: ветки, которые отходят от линии
    const lin = new Set(tl.lineage(A).map((b) => b.id));
    ctx.font = 'bold 10px system-ui';
    for (const b of tl.branches) {
      if (b.parent === null || !lin.has(b.parent) || b.forkTick < t0) continue;
      const x = Math.round(X(b.forkTick)) + 0.5;
      ctx.strokeStyle = b.color;
      ctx.fillStyle = b.color;
      ctx.globalAlpha = lin.has(b.id) ? 1 : 0.75;
      ctx.beginPath();
      ctx.moveTo(x, top - 2);
      ctx.lineTo(x, bot);
      ctx.stroke();
      ctx.fillText(b.letter, x + 2, top + 9);
      ctx.globalAlpha = 1;
    }
    // настоящее (пунктир), пока мы в прошлом; головка — белая
    if (tl.visiting || tl.replaying) {
      const hx = Math.round(X(A.headTick)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, top);
      ctx.lineTo(hx, bot);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nowX, top);
    ctx.lineTo(nowX, ch);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(nowX - 4, ch);
    ctx.lineTo(nowX + 4, ch);
    ctx.lineTo(nowX, ch - 6);
    ctx.fill();
    // отметки: жадная склейка соседних
    const marks = tl.lineageMarks(A);
    const cl: Cluster[] = [];
    let c: Cluster | null = null;
    for (const m of marks) {
      if (m.t < t0) continue;
      const x = X(m.t);
      if (c && x - c.x < 16) {
        c.marks.push(m);
        if ((m.major && !c.major) || (m.major === c.major && prio(m.icon) < prio(c.icon))) {
          c.major = m.major;
          c.icon = m.icon;
          c.ix = x;
        }
      } else {
        c = { x, ix: x, marks: [m], icon: m.icon, major: m.major };
        cl.push(c);
      }
    }
    this.clusters = cl;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const k of cl) {
      if (k.major) {
        ctx.font = `${lane - 5}px system-ui`;
        ctx.globalAlpha = k.marks[0].t > w.tick ? 0.45 : 1;
        ctx.fillText(k.icon, k.ix, lane / 2);
        const n = k.marks.filter((m) => m.major).length;
        if (n > 1) {
          ctx.font = 'bold 8px system-ui';
          ctx.fillStyle = '#e8c547';
          ctx.fillText(String(n), k.ix + 8, 4);
          ctx.fillStyle = '#fff';
        }
      } else {
        ctx.globalAlpha = k.marks[0].t > w.tick ? 0.3 : 0.6;
        ctx.fillStyle = '#9aa3ad';
        ctx.beginPath();
        ctx.arc(k.ix, lane / 2 + 2, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
      }
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    // фоновая работа — в правом верхнем углу
    const bg = this.host.bgText();
    if (bg) {
      ctx.font = '9px system-ui';
      const tw = ctx.measureText(bg).width;
      ctx.fillStyle = 'rgba(10,12,16,0.8)';
      ctx.fillRect(W - tw - 8, 0, tw + 8, 12);
      ctx.fillStyle = '#9ecbff';
      ctx.fillText(bg, W - tw - 4, 9);
    }
  }

  // ---------------- мышь и палец ----------------

  private tAt(px: number): number {
    const { t0, t1, W } = this.geo;
    return Math.round(t0 + ((px - 6) / Math.max(1, W - 12)) * (t1 - t0));
  }

  private clusterAt(px: number): Cluster | null {
    let best: Cluster | null = null, d = 10;
    for (const k of this.clusters) if (Math.abs(k.ix - px) < d) (d = Math.abs(k.ix - px)), (best = k);
    return best;
  }

  private bindCanvas(): void {
    const cv = this.canvas;
    const pos = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    cv.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      if (y < this.geo.lane + 2) {
        const k = this.clusterAt(x);
        if (k) {
          this.showTip(k, true);
          return;
        }
      }
      if (this.host.tl.locked) {
        this.host.toast('🔒 Во время урока машина времени на паузе');
        return;
      }
      this.hideTip();
      cv.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.scrubTo(x, true);
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      if (this.dragging) {
        this.scrubTo(x, false);
        return;
      }
      if (e.pointerType !== 'mouse') return;
      const k = y < this.geo.lane + 2 ? this.clusterAt(x) : null;
      if (k) this.showTip(k, false);
      else if (!this.tipPinned) this.hideTipSoon();
    });
    const up = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      const [x] = pos(e);
      this.pendingT = null;
      this.host.scrub(this.tAt(x));
      this.draw();
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', () => (this.dragging = false));
    cv.addEventListener('pointerleave', () => !this.tipPinned && this.hideTipSoon());
  }

  /** Не чаще 10 раз в секунду — восстановление снимка стоит несколько мс. */
  private scrubTo(x: number, now: boolean): void {
    const t = this.tAt(x);
    const ms = performance.now();
    if (now || ms - this.lastScrub >= 100) {
      this.lastScrub = ms;
      this.pendingT = null;
      this.host.scrub(t);
      this.draw();
    } else if (this.pendingT === null) {
      this.pendingT = t;
      setTimeout(() => {
        if (this.pendingT !== null && this.dragging) {
          this.lastScrub = performance.now();
          this.host.scrub(this.pendingT);
          this.pendingT = null;
          this.draw();
        }
      }, 100 - (ms - this.lastScrub));
    } else this.pendingT = t;
  }

  // ---------------- подсказка у отметок ----------------

  private showTip(k: Cluster, pin: boolean): void {
    clearTimeout(this.tipTimer);
    const key = `${k.marks[0].t}:${k.marks.length}`;
    this.tipPinned = pin || (this.tipPinned && this.tipKey === key);
    if (this.tipKey === key && !this.tip.hidden) return;
    this.tipKey = key;
    const { tl } = this.host;
    const list = [...k.marks].sort((a, b) => +b.major - +a.major).slice(0, 6).sort((a, b) => a.t - b.t);
    const lines = list.map((m) => `<div class="tl-line${m.major ? ' major' : ''}"><span>д.${Math.floor(m.t / DAY)}</span> ${esc(m.text)}</div>`);
    if (k.marks.length > list.length) lines.push(`<div class="muted small">…и ещё ${k.marks.length - list.length}</div>`);
    // действия — для самой важной отметки группы
    const m = list.find((x) => x.major) ?? list[0];
    const btns: string[] = [];
    if (!tl.locked && !tl.disabled) {
      if (m.act !== undefined) {
        btns.push(`<button data-tip="before" data-t="${m.t}" data-a="${m.act}">⏪ За миг до</button>`);
        btns.push(`<button data-tip="without" data-a="${m.act}">✕ Что если бы этого не было?</button>`);
      } else {
        btns.push(`<button data-tip="near" data-t="${m.t}">⏪ Незадолго до</button>`);
        btns.push(`<button data-tip="meddle" data-t="${m.t}">🛠 Вмешаться</button>`);
      }
      // 💀 или 🧬: если вид вымрет в этой линии — спасти его незадолго до конца
      const nm = nameIn(m.text);
      if (nm && (m.icon.startsWith('💀') || m.icon.startsWith('🧬'))) {
        const end = tl.lineageMarks(tl.active).find((x) => x.kind === 'extinct' && x.t >= m.t && x.text.includes(`«${nm}»`));
        if (end) btns.push(`<button data-tip="rescue" data-t="${end.t}" data-n="${esc(nm)}">🧬 Спасти «${esc(nm)}»</button>`);
      }
      // 🔬 для главной отметки группы или для первой подходящей (новый вид, вымирание, исчезновение гильдии)
      this.tipMark = [m, ...list].find((x) => this.host.canBlount(x)) ?? null;
      if (this.tipMark) {
        const nm2 = this.tipMark === m ? null : nameIn(this.tipMark.text);
        btns.push(`<button data-tip="blount" title="Перезапустить историю из разных точек до события: повторится ли оно?">🔬 Повторится ли?${nm2 ? ` («${esc(nm2)}»)` : ''}</button>`);
      }
    }
    this.tip.innerHTML = lines.join('') + (btns.length ? `<div class="tl-tipbtns">${btns.join('')}</div>` : '');
    this.tip.hidden = false;
    const W = this.el.clientWidth;
    const left = this.canvas.offsetLeft + k.ix;
    const tw = Math.min(300, W - 8);
    this.tip.style.width = `${tw}px`;
    this.tip.style.left = `${Math.max(4, Math.min(W - tw - 4, left - tw / 2))}px`;
  }

  private hideTipSoon(): void {
    clearTimeout(this.tipTimer);
    this.tipTimer = setTimeout(() => this.hideTip(), 350);
  }

  hideTip(): void {
    clearTimeout(this.tipTimer);
    this.tip.hidden = true;
    this.tipPinned = false;
    this.tipKey = '';
  }

  private tipClick(e: Event): void {
    const b = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement | null;
    if (!b) return;
    const t = Number(b.dataset.t), a = Number(b.dataset.a);
    const k = b.dataset.tip;
    this.hideTip();
    if (k === 'before') this.host.seek(t, a);
    else if (k === 'without') this.host.forkWithout(a);
    else if (k === 'near') this.host.seek(Math.max(0, t - 30));
    else if (k === 'meddle') this.host.intervene(Math.max(0, t - 30));
    else if (k === 'rescue') this.host.rescue(b.dataset.n!, t);
    else if (k === 'blount' && this.tipMark) this.host.blount(this.tipMark);
  }
}
