import { FIELD_ICON, type Field } from '../planet/facts';
import { allCards, cardById, cardFor, FIELD_ORDER, SOURCE_LABEL, type Card, type CardSource } from './catalog';
import { LessonEngine, toast, type LearnCtx, type ViewName } from './engine';
import { LESSONS } from './lessons';
import { goLink, linkLabel } from './links';
import { load, reset, save } from './progress';

export type { LearnCtx } from './engine';

const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Подсветить слова поиска: сначала находим места в «нормальном» тексте, потом экранируем куски. */
function mark(text: string, words: string[]): string {
  if (!words.length) return esc(text);
  const n = norm(text);
  if (n.length !== text.length) return esc(text);
  const hit = new Uint8Array(text.length);
  for (const w of words) {
    let i = n.indexOf(w);
    while (i >= 0) {
      hit.fill(1, i, i + w.length);
      i = n.indexOf(w, i + w.length);
    }
  }
  let out = '';
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && hit[j] === hit[i]) j++;
    const part = esc(text.slice(i, j));
    out += hit[i] ? `<mark>${part}</mark>` : part;
    i = j;
  }
  return out;
}

const TEMPLATE = /* html */ `
<div class="l-page">
  <div class="l-wrap">
    <header class="l-header">
      <h2>📚 Справочник и уроки</h2>
      <p class="muted">Все научные карточки EcoSim в одном месте — и короткие опыты, где вы сами проверяете идеи на настоящих симуляциях.</p>
      <div class="l-counter"></div>
    </header>
    <section class="l-sec">
      <h3 class="l-h">🎓 Проверь сам</h3>
      <p class="muted small">Урок ведёт вас по шагам прямо поверх симуляции: вы делаете опыт, предсказываете и проверяете. Прогресс сохраняется.</p>
      <div class="l-lessons"></div>
    </section>
    <section class="l-sec">
      <h3 class="l-h">📖 Энциклопедия</h3>
      <div class="l-tools">
        <input type="search" class="l-search" placeholder="Поиск: кислород, луна, вымирание…" aria-label="Поиск по карточкам" autocomplete="off">
        <div class="l-chips l-fields" role="group" aria-label="Науки"></div>
        <div class="l-chips l-sources" role="group" aria-label="Разделы"></div>
        <button class="l-resetf" hidden>Сбросить фильтры</button>
      </div>
      <div class="l-results"></div>
    </section>
    <footer class="l-foot">
      <button class="l-resetp">Сбросить прогресс</button>
    </footer>
  </div>
</div>`;

export class LearnView {
  active = false;
  private engine: LessonEngine;
  private query = '';
  private fields = new Set<Field>();
  private sources = new Set<CardSource>();
  private timer = 0;

  constructor(
    private root: HTMLElement,
    private ctx: LearnCtx,
  ) {
    root.innerHTML = TEMPLATE;
    this.engine = new LessonEngine(ctx, LESSONS);
    this.engine.onChange = () => this.active && this.renderTop();
    this.engine.onSeen = (id) => this.seen(id);
    this.engine.cardText = (id) => cardById(id);
    this.bind();
    this.render();
  }

  /** Вид показал научную карточку. */
  markSeen(source: 'planet' | 'surface', key: string): void {
    const c = cardFor(source, key);
    if (c) this.seen(c.id);
  }

  onShow(v: ViewName): void {
    this.engine.onShow(v);
    if (v === 'learn') this.render();
  }

  restore(): void {
    this.engine.restore();
  }

  /** Открыть карточку (#learn/<id>, можно в URL-кодировке): снять мешающие фильтры, прокрутить и подсветить. */
  openCard(raw: string): void {
    let id = raw;
    try {
      id = decodeURIComponent(raw);
    } catch {
      /* битая ссылка — ищем как есть */
    }
    const card = cardById(id);
    if (!card) return;
    if (!this.matches(card)) {
      this.query = '';
      $<HTMLInputElement>(this.root, '.l-search').value = '';
      this.fields.clear();
      this.sources.clear();
    }
    this.render();
    const el = this.root.querySelector<HTMLElement>(`.l-card[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1300);
    });
  }

  private seen(id: string): void {
    const p = load();
    if (p.seen.includes(id)) return;
    p.seen.push(id);
    save();
    if (!this.active) return;
    this.renderCounter();
    this.root.querySelector(`.l-card[data-id="${CSS.escape(id)}"] .l-unseen`)?.remove();
  }

  // ---------------- события ----------------

  private bind(): void {
    const r = this.root;
    const search = $<HTMLInputElement>(r, '.l-search');
    search.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.query = search.value;
        this.renderCards();
      }, 80);
    });
    r.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!b) return;
      b.blur();
      const d = b.dataset;
      if (d.start) this.engine.start(d.start, d.restart === '1');
      else if (d.field) {
        const f = d.field as Field;
        if (!this.fields.delete(f)) this.fields.add(f);
        this.renderCards();
      } else if (d.source) {
        const s = d.source as CardSource;
        if (!this.sources.delete(s)) this.sources.add(s);
        this.renderCards();
      } else if (d.link) {
        const c = cardById(d.link);
        if (c) goLink(this.ctx, c, (id) => this.engine.start(id));
      } else if (d.lesson) this.engine.start(d.lesson);
      else if (d.copy) this.copy(d.copy);
      else if (b.classList.contains('l-resetf')) {
        this.fields.clear();
        this.sources.clear();
        this.query = '';
        search.value = '';
        this.renderCards();
      } else if (b.classList.contains('l-resetp')) {
        if (!confirm('Стереть пройденные уроки и встреченные карточки?')) return;
        if (this.engine.visible) this.engine.close();
        reset();
        this.render();
      }
    });
  }

  private copy(id: string): void {
    const url = `${location.origin}${location.pathname}#learn/${encodeURIComponent(id)}`;
    try {
      history.replaceState(null, '', `#learn/${encodeURIComponent(id)}`);
    } catch {
      /* ничего */
    }
    const done = () => toast('🔗 Ссылка на карточку скопирована');
    try {
      navigator.clipboard.writeText(url).then(done, () => toast(url));
    } catch {
      toast(url);
    }
  }

  // ---------------- отрисовка ----------------

  private render(): void {
    this.renderTop();
    this.renderCards();
  }

  private renderTop(): void {
    this.renderCounter();
    this.renderLessons();
  }

  private renderCounter(): void {
    const cards = allCards();
    const seen = new Set(load().seen);
    const met = cards.filter((c) => seen.has(c.id)).length;
    const c = this.engine.probeCtx();
    const open = LESSONS.filter((l) => !l.locked?.(c));
    const done = open.filter((l) => load().lessons[l.id]?.done).length;
    $(this.root, '.l-counter').innerHTML = `
      <div><b>${met}</b> из ${cards.length} карточек встречено<div class="l-meter"><i style="width:${(met / Math.max(1, cards.length)) * 100}%"></i></div></div>
      <div><b>${done}</b> из ${open.length} уроков пройдено<div class="l-meter"><i style="width:${(done / Math.max(1, open.length)) * 100}%"></i></div></div>`;
    $(this.root, '.l-counter').setAttribute('aria-label', `Встречено: ${met} из ${cards.length} карточек · Уроков пройдено: ${done} из ${open.length}`);
  }

  private renderLessons(): void {
    const c = this.engine.probeCtx();
    const running = this.engine.running?.id;
    $(this.root, '.l-lessons').innerHTML = LESSONS.map((L) => {
      const lock = L.locked?.(c) ?? null;
      const lp = load().lessons[L.id];
      const step = lp?.step ?? 0;
      const inProgress = !!lp && step > 0 && step < L.steps.length;
      let pill = '';
      if (lock) pill = '<span class="l-pill lock">🔒 скоро</span>';
      else if (running === L.id) pill = `<span class="l-pill now">идёт · шаг ${step + 1} из ${L.steps.length}</span>`;
      else if (lp?.done) pill = '<span class="l-pill ok">✓ пройден</span>';
      else if (inProgress) pill = `<span class="l-pill">шаг ${step + 1} из ${L.steps.length}</span>`;
      const btn = lock
        ? `<span class="l-lock">${lock.replace(/^🔒\s*/, '')}</span>`
        : lp?.done && !inProgress
          ? `<button data-start="${L.id}" data-restart="1">Пройти ещё раз</button>`
          : inProgress || running === L.id
            ? `<button class="primary" data-start="${L.id}">Продолжить</button>`
            : `<button data-start="${L.id}">Начать</button>`;
      return `<article class="l-lesson${lp?.done ? ' done' : ''}${lock ? ' locked' : ''}">
        <div class="l-lhead"><span class="l-licon">${L.icon}</span>${pill}</div>
        <h4>${L.title}</h4>
        <p>${L.teaser}</p>
        <div class="l-lfoot"><span class="muted small">≈${L.minutes} мин · ${L.steps.length} ${plural(L.steps.length, 'шаг', 'шага', 'шагов')}</span>${btn}</div>
      </article>`;
    }).join('');
  }

  /** Слова поиска с обрезанным окончанием: «луна» найдёт и «Луны», и «Луной». */
  private words(): string[] {
    return norm(this.query)
      .split(/[\s,.;:!?«»"()]+/)
      .filter(Boolean)
      .map((w) => (w.length >= 4 && /[аеиоуыэюяйь]$/.test(w) ? w.slice(0, -1) : w));
  }

  private hay(c: Card): string {
    return norm(`${c.title} ${c.text} ${c.earth ?? ''} ${c.field} ${SOURCE_LABEL[c.source]}`);
  }

  private matches(c: Card, ignore?: 'field' | 'source'): boolean {
    if (ignore !== 'field' && this.fields.size && !this.fields.has(c.field)) return false;
    if (ignore !== 'source' && this.sources.size && !this.sources.has(c.source)) return false;
    const h = this.hay(c);
    return this.words().every((w) => h.includes(w));
  }

  private renderCards(): void {
    const all = allCards();
    const seen = new Set(load().seen);
    const words = this.words();
    const c = this.engine.probeCtx();

    // фильтры: число карточек с учётом остальных условий
    const fieldN = (f: Field) => all.filter((x) => x.field === f && this.matches(x, 'field')).length;
    $(this.root, '.l-fields').innerHTML = FIELD_ORDER.filter((f) => all.some((x) => x.field === f))
      .map((f) => `<button data-field="${f}" class="${this.fields.has(f) ? 'on' : ''}" aria-pressed="${this.fields.has(f)}">${FIELD_ICON[f]} ${f} <small>${fieldN(f)}</small></button>`)
      .join('');
    const sources = (Object.keys(SOURCE_LABEL) as CardSource[]).filter((s) => all.some((x) => x.source === s));
    $(this.root, '.l-sources').innerHTML = sources
      .map((s) => {
        const n = all.filter((x) => x.source === s && this.matches(x, 'source')).length;
        return `<button data-source="${s}" class="${this.sources.has(s) ? 'on' : ''}" aria-pressed="${this.sources.has(s)}">${SOURCE_LABEL[s]} <small>${n}</small></button>`;
      })
      .join('');
    $(this.root, '.l-resetf').hidden = !(this.fields.size || this.sources.size || this.query.trim());

    const shown = all.filter((x) => this.matches(x));
    if (!shown.length) {
      $(this.root, '.l-results').innerHTML = '<p class="l-empty">Ничего не нашлось. Попробуйте другое слово.</p>';
      return;
    }
    const groups = FIELD_ORDER.map((f) => [f, shown.filter((x) => x.field === f)] as const).filter(([, list]) => list.length);
    $(this.root, '.l-results').innerHTML = groups
      .map(
        ([f, list]) => `<h3 class="l-group">${FIELD_ICON[f]} ${f} <small>${list.length}</small></h3>
        <div class="l-cards">${list.map((card) => this.cardHtml(card, words, seen.has(card.id), c)).join('')}</div>`,
      )
      .join('');
  }

  private cardHtml(card: Card, words: string[], met: boolean, c: ReturnType<LessonEngine['probeCtx']>): string {
    const label = linkLabel(card);
    const lessons = card.lessons
      .map((id) => this.engine.lessonById(id))
      .filter((L) => L && !L.locked?.(c))
      .map((L) => `<button class="l-chip" data-lesson="${L!.id}">🎓 Урок «${L!.title}»${load().lessons[L!.id]?.done ? ' ✓' : ''}</button>`)
      .join('');
    return `<article class="l-card" data-id="${card.id}">
      <div class="tag">${FIELD_ICON[card.field]} ${card.field} · ${SOURCE_LABEL[card.source]}</div>
      <h4>${mark(card.title, words)}</h4>
      <p>${mark(card.text, words)}</p>
      ${card.earth ? `<p class="earth">🌍 ${mark(card.earth, words)}</p>` : ''}
      ${met ? '' : '<small class="muted l-unseen">ещё не встречалась</small>'}
      <div class="l-cbtns">
        ${label ? `<button data-link="${card.id}">${label}</button>` : ''}
        ${lessons}
        <button class="l-copy" data-copy="${card.id}" title="Скопировать ссылку на карточку" aria-label="Скопировать ссылку на карточку">🔗</button>
      </div>
    </article>`;
  }
}

/** 1 шаг · 2–4 шага · 5+ шагов (с учётом 11–14). */
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
