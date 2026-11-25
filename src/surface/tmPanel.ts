// ⏳ Вкладка «Ветки»: дерево веток машины времени и сравнение двух–четырёх миров (Брей — Кёртис, выводы).
import { DAY, type World } from '../sim/world';
import { GUILD, type Branch, type SeriesRow, type Timeline } from '../sim/timeline';
import { comparePair, commonPoint, rowAt } from '../sim/tmCompare';

export interface PanelHost {
  readonly tl: Timeline;
  readonly world: World;
  switchTo(id: number): void;
  showFact(id: string): void;
  toast(text: string): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const day = (t: number) => Math.floor(t / DAY);

export class TmPanel {
  /** Ветки в сравнении (до 4); пусто — активная и её предок. */
  private cmp: number[] = [];
  /** Ветка, для которой открыты действия под деревом. */
  private sel: number | null = null;
  private confirmDel = false;
  private renaming = false;
  private rowsY: { id: number; y: number }[] = [];
  private tree: HTMLCanvasElement;
  private actsEl: HTMLElement;
  private cmpEl: HTMLElement;
  private html = new WeakMap<HTMLElement, string>();

  constructor(el: HTMLElement, private host: PanelHost) {
    el.innerHTML = `<p class="muted small">Каждая линия — своя история мира. Ветка появляется, когда вы вмешиваетесь в прошлое (перетащите шкалу внизу ⏪) или нажимаете 🌿 «Что если…». Нажмите на линию, чтобы сравнить ветки.</p>
      <canvas class="tm-tree"></canvas>
      <div class="tm-acts"></div>
      <div class="tm-cmp"></div>`;
    this.tree = el.querySelector('.tm-tree')!;
    this.actsEl = el.querySelector('.tm-acts')!;
    this.cmpEl = el.querySelector('.tm-cmp')!;
    this.tree.addEventListener('click', (e) => {
      const r = this.tree.getBoundingClientRect();
      const y = e.clientY - r.top;
      let best: { id: number; y: number } | null = null;
      for (const row of this.rowsY) if (!best || Math.abs(row.y - y) < Math.abs(best.y - y)) best = row;
      if (!best || Math.abs(best.y - y) > 13) return;
      const id = best.id;
      this.sel = id;
      this.confirmDel = false;
      this.renaming = false;
      const cur = this.compareSet();
      if (cur.includes(id)) {
        if (cur.length > 2) this.cmp = cur.filter((x) => x !== id);
      } else this.cmp = [...cur, id].slice(-4);
      this.render();
    });
    this.actsEl.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-tm]') as HTMLElement | null;
      if (!b || this.sel === null) return;
      const { tl } = this.host;
      const k = b.dataset.tm;
      if (k === 'go') this.host.switchTo(this.sel);
      else if (k === 'ren') this.renaming = true;
      else if (k === 'save') {
        const v = this.actsEl.querySelector<HTMLInputElement>('input')?.value.trim();
        const br = tl.branches.find((x) => x.id === this.sel);
        if (br && v) br.name = v.slice(0, 40);
        this.renaming = false;
      } else if (k === 'del') {
        if (!this.confirmDel) this.confirmDel = true;
        else {
          if (tl.deleteBranch(this.sel)) {
            this.host.toast('🗑 Ветка удалена');
            this.cmp = this.cmp.filter((x) => x !== this.sel);
            this.sel = null;
          }
          this.confirmDel = false;
        }
      } else if (k === 'close') this.sel = null;
      this.render();
    });
    this.actsEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.actsEl.querySelector<HTMLElement>('[data-tm=save]')?.click();
    });
    // сравнение перерисовывается с живыми цифрами — ловим нажатие, а не click
    this.cmpEl.addEventListener('pointerdown', (e) => {
      const f = (e.target as HTMLElement).closest('[data-fact]') as HTMLElement | null;
      if (f) this.host.showFact(f.dataset.fact!);
    });
  }

  /** Ветки в сравнении: выбранные или активная с предком (или с первой другой). */
  compareSet(): number[] {
    const { tl } = this.host;
    const ids = new Set(tl.branches.map((b) => b.id));
    const set = this.cmp.filter((id) => ids.has(id));
    if (set.length >= 2) return set;
    const A = tl.active;
    const other = A.parent ?? tl.branches.find((b) => b !== A)?.id;
    return other === undefined ? [A.id] : [A.id, other];
  }

  render(): void {
    this.drawTree();
    this.renderActs();
    this.renderCompare();
  }

  private setHtml(el: HTMLElement, s: string): void {
    if (this.html.get(el) === s) return;
    this.html.set(el, s);
    el.innerHTML = s;
  }

  // ---------------- дерево ----------------

  /** Ветки в порядке обхода (дети — по такту развилки). */
  private order(): { b: Branch; depth: number }[] {
    const { tl } = this.host;
    const out: { b: Branch; depth: number }[] = [];
    const walk = (b: Branch, d: number) => {
      out.push({ b, depth: d });
      tl.branches.filter((x) => x.parent === b.id).sort((x, y) => x.forkTick - y.forkTick).forEach((x) => walk(x, d + 1));
    };
    for (const r of tl.branches.filter((b) => b.parent === null)) walk(r, 0);
    return out;
  }

  private drawTree(): void {
    const { tl } = this.host;
    const cv = this.tree;
    const list = this.order();
    const cw = cv.clientWidth || 320;
    const ch = 18 + 26 * list.length;
    const dpr = window.devicePixelRatio || 1;
    cv.style.height = `${ch}px`;
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const maxT = Math.max(1, ...tl.branches.map((b) => b.headTick));
    const X = (t: number) => 34 + (t / maxT) * (cw - 46);
    const cmp = new Set(this.compareSet());
    const Y = new Map<number, number>();
    this.rowsY = [];
    list.forEach(({ b }, i) => {
      const y = 18 + 26 * i;
      Y.set(b.id, y);
      this.rowsY.push({ id: b.id, y });
    });
    for (const { b } of list) {
      const y = Y.get(b.id)!;
      const on = b === tl.active;
      if (cmp.has(b.id)) {
        ctx.fillStyle = 'rgba(232,197,71,0.08)';
        ctx.fillRect(0, y - 12, cw, 24);
      }
      if (this.sel === b.id) {
        ctx.strokeStyle = 'rgba(158,203,255,0.45)';
        ctx.strokeRect(0.5, y - 11.5, cw - 1, 23);
      }
      // связь с предком
      if (b.parent !== null) {
        const py = Y.get(b.parent);
        if (py !== undefined) {
          ctx.strokeStyle = b.color;
          ctx.globalAlpha = 0.6;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(X(b.forkTick), py);
          ctx.lineTo(X(b.forkTick), y);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      ctx.strokeStyle = b.color;
      ctx.lineWidth = on ? 5 : 3;
      ctx.beginPath();
      ctx.moveTo(X(b.forkTick), y);
      ctx.lineTo(Math.max(X(b.forkTick) + 2, X(b.headTick)), y);
      ctx.stroke();
      // крупные события ветки
      ctx.font = '9px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const m of b.marks) if (m.major && m.t >= b.forkTick) ctx.fillText(m.icon, X(m.t), y - 8);
      // развилка со значком вмешательства
      if (b.parent !== null) {
        ctx.fillStyle = '#121417';
        ctx.beginPath();
        ctx.arc(X(b.forkTick), y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.font = '9px system-ui';
        ctx.fillStyle = '#fff';
        ctx.fillText([...b.icon][0] ?? '🌿', X(b.forkTick), y + 0.5);
      }
      ctx.textAlign = 'left';
      ctx.font = `${on ? 'bold ' : ''}12px system-ui`;
      ctx.fillStyle = b.color;
      ctx.fillText(`${on ? '▶' : ' '}${b.letter}`, 2, y);
      ctx.textBaseline = 'alphabetic';
    }
  }

  private renderActs(): void {
    const { tl } = this.host;
    const b = this.sel === null ? null : tl.branches.find((x) => x.id === this.sel) ?? null;
    if (!b) {
      this.setHtml(this.actsEl, '');
      return;
    }
    const leaf = !tl.branches.some((x) => x.parent === b.id);
    const canDel = leaf && b !== tl.active && b.parent !== null;
    const name = this.renaming
      ? `<input class="tm-name" value="${esc(b.name)}" maxlength="40"><button data-tm="save">✔</button>`
      : `<b style="color:${b.color}">${b.letter} · ${esc(b.name)}</b>`;
    const info = `<div class="muted small">${b.parent === null ? 'с сотворения мира' : `от ветки ${tl.branch(b.parent).letter}, день ${day(b.forkTick)}`} · сейчас день ${day(b.headTick)}${b.exact ? '' : ' · запись неполная'}</div>`;
    this.setHtml(this.actsEl, `<div class="tm-acthead">${name}<button data-tm="close" class="x" title="Закрыть">✕</button></div>${info}<div class="tm-actbtns">
      <button data-tm="go" ${b === tl.active && !tl.visiting ? 'disabled' : ''}>▶ Перейти</button>
      <button data-tm="ren">✏️ Переименовать</button>
      ${canDel ? `<button data-tm="del" class="${this.confirmDel ? 'danger' : ''}">${this.confirmDel ? '🗑 Точно удалить?' : '🗑 Удалить'}</button>` : ''}
    </div>`);
    if (this.renaming) this.actsEl.querySelector<HTMLInputElement>('input')?.focus();
  }

  // ---------------- сравнение ----------------

  private renderCompare(): void {
    const { tl } = this.host;
    const ids = this.compareSet();
    if (ids.length < 2) {
      this.setHtml(this.cmpEl, `<div class="tm-empty">Пока у мира одна история. Перетащите шкалу внизу в прошлое ⏪ и вмешайтесь — или нажмите 🌿 «Что если…»: появится вторая ветка, и здесь можно будет сравнить два мира.</div>`);
      return;
    }
    const br = ids.map((id) => tl.branch(id));
    const pairs = br.slice(1).map((b) => comparePair(tl, br[0], b));
    const p = pairs[0];
    if (!p) {
      this.setHtml(this.cmpEl, '<div class="tm-empty">Ветки ещё не набрали истории для сравнения.</div>');
      return;
    }
    const tag = (b: Branch) => `<b style="color:${b.color}">${b.letter}</b>`;
    const head = `<h4>${tag(p.A)} · ${esc(p.A.name)} <span>vs</span> ${tag(p.B)} · ${esc(p.B.name)}</h4>
      <div class="small">Общий предок: день ${day(p.td)}</div>
      ${pairs.map((q) => q && `<div class="tm-bc">Разошлись на <b>${q.pct}%</b> ${br.length > 2 ? `(${tag(q.A)}–${tag(q.B)}) ` : ''}к дню ${day(q.tc)} <a data-fact="tm_braycurtis" title="Как считается">?</a></div>`).join('')}
      ${br.some((b) => b.headTick < Math.max(...br.map((x) => x.headTick))) ? `<div class="muted small">Заштриховано время, до которого ветка ещё не дожила — перейдите на неё, чтобы она шла дальше.</div>` : ''}`;
    const leaders = `<h4>Кто правит в день ${day(p.tc)}</h4><div class="tm-lead">${br
      .map((b) => {
        const r = rowAt(tl.lineageRows(b), p.tc);
        const nx = b === p.A || b === p.B ? p.nx : commonPoint(tl, br[0], b).nx;
        const rows = r ? [...r.ids].slice(0, 3).map((id, i) => {
          const nm = tl.spName(b, id);
          return `<li><i style="background:hsl(${nm?.hue ?? 0},65%,60%)"></i>${esc(nm?.name ?? `вид #${id}`)} <span class="muted">${r.cnt[i]}</span>${id >= nx ? ' <em class="tm-new">новый</em>' : ''}</li>`;
        }) : [];
        return `<div>${tag(b)}<ol>${rows.join('') || '<li class="muted">никого</li>'}</ol></div>`;
      })
      .join('')}</div>`;
    const bullets = p.bullets.length ? `<ul class="tm-sum">${p.bullets.map((x) => `<li>${esc(x.text)}${x.fact ? ` <a data-fact="${x.fact}">?</a>` : ''}</li>`).join('')}</ul>` : '';
    this.setHtml(this.cmpEl, `${head}
      <h4>Всего животных</h4><canvas class="tm-c" data-c="n"></canvas>
      <div class="tm-guilds">${GUILD.map((G, g) => `<div><div class="small">${G.icon} ${G.name}</div><canvas class="tm-c sm" data-c="g${g}"></canvas></div>`).join('')}</div>
      <h4>Число видов</h4><canvas class="tm-c" data-c="sp"></canvas>
      ${leaders}${bullets}`);
    const val: Record<string, (r: SeriesRow) => number> = { n: (r) => r.n, sp: (r) => r.live };
    GUILD.forEach((_, g) => (val[`g${g}`] = (r) => r.g[g]));
    this.cmpEl.querySelectorAll<HTMLCanvasElement>('canvas.tm-c').forEach((cv) => this.drawSeries(cv, br, p.td, val[cv.dataset.c!]));
  }

  private drawSeries(cv: HTMLCanvasElement, br: Branch[], td: number, v: (r: SeriesRow) => number): void {
    const { tl } = this.host;
    const cw = cv.clientWidth || 300, ch = cv.clientHeight || 70;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const tMax = Math.max(...br.map((b) => b.headTick));
    const span = Math.max(600, tMax - td);
    const t0 = Math.max(0, td - 0.1 * span), t1 = Math.max(t0 + 1, tMax);
    const X = (t: number) => 2 + ((t - t0) / (t1 - t0)) * (cw - 4);
    const series = br.map((b) => tl.lineageRows(b).filter((r) => r.t >= t0 - 100));
    let max = 1;
    for (const s of series) for (const r of s) max = Math.max(max, v(r));
    const Yv = (x: number) => ch - 3 - (x / max) * (ch - 14);
    // не дожившее время — заштриховано
    for (const b of br) if (b.headTick < tMax) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(X(b.headTick), 0, X(tMax) - X(b.headTick), ch);
    }
    ctx.fillStyle = 'rgba(230,232,223,0.45)';
    ctx.font = '9px system-ui';
    ctx.fillText(String(Math.round(max)), 3, 9);
    // развилка
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(td) + 0.5, 0);
    ctx.lineTo(X(td) + 0.5, ch);
    ctx.stroke();
    ctx.setLineDash([]);
    const line = (rows: SeriesRow[], color: string, w: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      rows.forEach((r, i) => (i ? ctx.lineTo(X(Math.max(t0, r.t)), Yv(v(r))) : ctx.moveTo(X(Math.max(t0, r.t)), Yv(v(r)))));
      ctx.stroke();
    };
    // общее начало — один раз серым, дальше — каждая ветка своим цветом
    line(series[0].filter((r) => r.t <= td), '#8b929a', 1.5);
    series.forEach((s, i) => {
      const own = s.filter((r) => r.t >= td);
      const prev = s.filter((r) => r.t < td).at(-1);
      line(prev ? [prev, ...own] : own, br[i].color, i === 0 ? 2 : 1.6);
    });
  }
}
