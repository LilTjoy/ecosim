import type { DrakeView } from '../planet/drakeView';
import { FIELD_ICON, type Fact } from '../planet/facts';
import type { McView } from '../planet/mcView';
import type { PlanetParams } from '../planet/model';
import type { PlanetView } from '../planet/planetView';
import type { World } from '../sim/world';
import type { SurfaceView } from '../surface/view';
import { lessonProgress, load, save, type Mem } from './progress';
import type { TwinStats } from './scenarios';
import { abortTwin, runTwin } from './twin';

export type ViewName = 'planet' | 'mc' | 'drake' | 'eco' | 'compare' | 'learn';

export interface LearnCtx {
  planet: PlanetView;
  mc: McView;
  drake: DrakeView;
  surface: SurfaceView;
  show(v: ViewName): void;
  /** «Сравнение миров» создаётся при первом заходе — карточку открываем через app.ts. */
  openCompareFact?(id: string): void;
}

export interface Quiz {
  q: string;
  options: string[];
  correct: number;
  explain: string;
}

export interface LessonCtx extends LearnCtx {
  /** = surface.world (никогда не пересоздаётся). */
  world: World;
  /** Сохраняется между перезагрузками. */
  mem: Mem;
  /** Не сохраняется: счётчики прогресса. */
  live: Record<string, number>;
  twin(base: PlanetParams, a: Partial<PlanetParams>, b: Partial<PlanetParams>, n: number): Promise<[TwinStats, TwinStats] | null>;
  /** false — урок или шаг уже сменились, результат долгого расчёта надо выбросить. */
  alive(): boolean;
}

export interface Step {
  /** Где идёт опыт — если открыта другая вкладка, коуч покажет «↪ К опыту». */
  view?: 'planet' | 'mc' | 'eco';
  /** После перезагрузки урок продолжится с ближайшей такой точки. */
  checkpoint?: boolean;
  /** Какие карточки планеты ставят паузу на этом шаге (по умолчанию — никакие). */
  focus?: string[];
  text: string;
  quiz?: Quiz;
  /** Сначала предсказание, потом опыт. */
  quizFirst?: boolean;
  action?: {
    label: string;
    /** Ключи mem, которые надо стереть перед опытом (их проверяет watch). */
    clear?: string[];
    /** false — расчёт прервали. */
    run(c: LessonCtx): void | boolean | Promise<void | boolean>;
  };
  after?: string | ((c: LessonCtx) => string);
  watch?: {
    hint(c: LessonCtx): string;
    test(c: LessonCtx): boolean;
    done(c: LessonCtx): string;
    onPass?(c: LessonCtx): void;
    /** eco — тактов мира после опыта; planet — возраст планеты; ms — для расчётов. */
    giveUp?: { ticks?: number; gyr?: number; ms?: number; text?: string };
  };
  /** Не null — «Опыт изменился: …». По умолчанию сравнивает планету/мир с запомненными. */
  guard?(c: LessonCtx): string | null;
  /** Живая строка с числами под подсказкой. */
  readout?(c: LessonCtx): string;
}

export interface Lesson {
  id: string;
  icon: string;
  title: string;
  teaser: string;
  minutes: number;
  /** id карточек справочника, о которых урок. */
  cards: string[];
  locked?(c: LessonCtx): string | null;
  steps: Step[];
  onExit?(c: LessonCtx): void;
  readout?(c: LessonCtx): string;
}

interface StepState {
  acted: boolean;
  running: boolean;
  passed: boolean;
  done: string;
  wrong: number;
  picked: number[];
  quizOk: boolean;
  err: string;
  interrupted: boolean;
  gave: boolean;
  guard: string | null;
  tick0: number;
  gyr0: number;
  ms0: number;
}

const freshState = (): StepState => ({
  acted: false, running: false, passed: false, done: '', wrong: 0, picked: [], quizOk: false,
  err: '', interrupted: false, gave: false, guard: null, tick0: 0, gyr0: 0, ms0: 0,
});

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

const VIEW_LABEL: Record<string, string> = { planet: '🪐 Планета', mc: '🎲 10 000 миров', eco: '🦊 Поверхность' };

/** Ведёт урок: шаги, проверки раз в 300 мс, «коуч» — панель под вкладками. */
/** Повтор действия шага (не путать с «↻ Новый мир» на панели «Поверхности»). */
const AGAIN = '↻ Ещё раз';

export class LessonEngine {
  private el: HTMLElement;
  private lesson: Lesson | null = null;
  private cur = 0;
  private viewIdx = 0;
  private st: StepState[] = [];
  private timer = 0;
  private curView: ViewName = 'planet';
  private minimised = false;
  private resumeId: string | null = null;
  private token = 0;
  private live: Record<string, number> = {};
  private sig = '';
  private hintText = '';
  private readText = '';
  private cardsOpen = false;
  /** Прогресс изменился — перерисовать страницу справочника. */
  onChange: () => void = () => {};
  /** Коуч показал карточку. */
  onSeen: (id: string) => void = () => {};
  /** Карточки справочника по id (для блока «Карточки урока»). */
  cardText: (id: string) => Fact | undefined = () => undefined;

  constructor(
    private base: LearnCtx,
    readonly lessons: Lesson[],
  ) {
    this.el = document.createElement('div');
    this.el.className = 'l-coach';
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', 'Урок');
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener(
      'toggle',
      (e) => {
        const d = e.target as HTMLDetailsElement;
        if (!d.classList.contains('l-lcards')) return;
        this.cardsOpen = d.open;
        if (d.open) this.lesson?.cards.filter((id) => id.startsWith('stats.')).forEach((id) => this.onSeen(id));
      },
      true,
    );
    new ResizeObserver(() => {
      const h = this.el.hidden ? 0 : this.el.offsetHeight;
      const prev = document.documentElement.style.getPropertyValue('--coach-h');
      if (prev !== `${h}px`) {
        document.documentElement.style.setProperty('--coach-h', `${h}px`);
        window.dispatchEvent(new Event('resize'));
      }
    }).observe(this.el);
  }

  get running(): Lesson | null {
    return this.lesson;
  }

  /** Коуч на экране: идёт урок или предложено «Продолжить» после перезагрузки. */
  get visible(): boolean {
    return !this.el.hidden;
  }

  lessonById(id: string): Lesson | undefined {
    return this.lessons.find((l) => l.id === id);
  }

  /** Контекст для проверок «заблокирован ли урок». */
  probeCtx(): LessonCtx {
    return this.ctx(-1, {});
  }

  private ctx(tok: number, mem: Mem): LessonCtx {
    const id = this.lesson?.id;
    const step = this.cur;
    return {
      ...this.base,
      world: this.base.surface.world,
      mem,
      live: this.live,
      twin: (b, a, v, n) =>
        runTwin(b, a, v, n, (d, t) => {
          this.live.done = d;
          this.live.total = t;
        }),
      alive: () => tok === this.token && this.lesson?.id === id && this.cur === step,
    };
  }

  private get mem(): Mem {
    return this.lesson ? lessonProgress(this.lesson.id).mem : {};
  }

  onShow(v: ViewName): void {
    this.curView = v;
    this.render();
  }

  // ---------------- жизненный цикл ----------------

  start(id: string, restart = false): void {
    const L = this.lessonById(id);
    if (!L) return;
    if (L.locked?.(this.probeCtx())) return;
    if (this.lesson) this.exit();
    const lp = lessonProgress(id);
    if (restart || lp.step >= L.steps.length) {
      lp.step = 0;
      lp.mem = {};
      lp.answers = {};
    }
    let s = Math.min(lp.step, L.steps.length - 1);
    while (s > 0 && !L.steps[s].checkpoint) s--;
    this.lesson = L;
    this.resumeId = null;
    this.minimised = false;
    this.cardsOpen = false;
    this.st = L.steps.map(freshState);
    this.cur = s;
    this.viewIdx = s;
    lp.step = s;
    load().last = id;
    save();
    // опыт на «Поверхности»: машина времени на замке (в прошлое и на ветки нельзя), запись идёт дальше
    if (L.steps.some((x) => x.view === 'eco')) this.base.surface.lockTime(true);
    this.enter(s);
    document.body.classList.add('lesson-on');
    this.el.hidden = false;
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.poll(), 300);
    this.render(true);
    this.onChange();
  }

  /** После перезагрузки: незаконченный урок — свёрнутый коуч с «Продолжить». */
  restore(): void {
    const p = load();
    const L = p.last ? this.lessonById(p.last) : undefined;
    if (!L || p.lessons[L.id]?.done || L.locked?.(this.probeCtx())) return;
    this.resumeId = L.id;
    document.body.classList.add('lesson-on');
    this.el.hidden = false;
    this.render(true);
  }

  close(): void {
    if (this.resumeId) {
      this.resumeId = null;
      load().last = undefined;
      save();
    }
    if (this.lesson) {
      this.exit();
      load().last = undefined;
      save();
    }
    this.hide();
  }

  private hide(): void {
    clearInterval(this.timer);
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.sig = '';
    document.body.classList.remove('lesson-on');
    document.documentElement.style.setProperty('--coach-h', '0px');
    window.dispatchEvent(new Event('resize'));
    this.onChange();
  }

  private exit(): void {
    const L = this.lesson;
    if (!L) return;
    this.token++;
    try {
      L.onExit?.(this.ctx(-1, this.mem));
    } catch (e) {
      console.warn(e);
    }
    this.base.planet.focusFacts = null;
    // опыт на «Поверхности» шёл на 12× — дальше мир идёт своим ходом (кнопка «🌍 Обычная Земля» вернёт обычный мир)
    if (L.steps.some((s) => s.view === 'eco')) this.base.surface.endLesson();
    this.base.surface.lockTime(false);
    abortTwin();
    this.lesson = null;
  }

  private finish(): void {
    const L = this.lesson;
    if (!L) return;
    const lp = lessonProgress(L.id);
    lp.done = true;
    lp.doneAt = Date.now();
    lp.step = 0;
    load().last = undefined;
    save();
    this.exit();
    this.hide();
    toast('🎓 Урок пройден!');
    this.base.show('learn');
  }

  private enter(i: number): void {
    const s = this.lesson!.steps[i];
    this.base.planet.focusFacts = new Set(s.focus ?? []);
    const ss = (this.st[i] = freshState());
    this.mark(ss);
    if (!s.action && !s.quiz && !s.watch) ss.passed = true;
  }

  private mark(ss: StepState): void {
    ss.tick0 = this.base.surface.world.tick;
    ss.gyr0 = this.base.planet.snapshot().now;
    ss.ms0 = Date.now();
  }

  // ---------------- действия ----------------

  private async act(i: number): Promise<void> {
    const L = this.lesson;
    if (!L) return;
    const s = L.steps[i];
    if (!s.action) return;
    if (i < this.cur) {
      // повтор прошлого шага: он снова текущий, дальнейшие — заново
      for (let j = i; j < L.steps.length; j++) this.st[j] = freshState();
      this.cur = i;
      lessonProgress(L.id).step = i;
    }
    this.viewIdx = i;
    this.base.planet.focusFacts = new Set(s.focus ?? []);
    const ss = (this.st[i] = { ...freshState(), wrong: this.st[i].wrong, picked: this.st[i].picked, quizOk: this.st[i].quizOk });
    const mem = this.mem;
    for (const k of s.action.clear ?? []) delete mem[k];
    this.live = {};
    const tok = ++this.token;
    const c = this.ctx(tok, mem);
    ss.acted = true;
    ss.running = true;
    this.render();
    try {
      const p = s.action.run(c);
      this.mark(ss);
      const r = await p;
      if (!c.alive()) return;
      if (r === false) {
        ss.acted = false;
        ss.interrupted = true;
      }
    } catch (e) {
      if (!c.alive()) return;
      ss.acted = false;
      ss.err = e instanceof Error ? e.message : String(e);
      console.error(e);
    }
    ss.running = false;
    if (ss.acted && !s.watch && (!s.quiz || s.quizFirst)) ss.passed = true;
    save();
    this.poll();
    this.render();
  }

  private answer(i: number, o: number): void {
    const L = this.lesson;
    if (!L) return;
    const s = L.steps[i];
    const ss = this.st[i];
    if (!s.quiz || ss.quizOk || ss.wrong >= 2) return;
    const lp = lessonProgress(L.id);
    if (lp.answers[i] === undefined) lp.answers[i] = o;
    if (!ss.picked.includes(o)) ss.picked.push(o);
    if (o === s.quiz.correct) ss.quizOk = true;
    else ss.wrong++;
    if ((ss.quizOk || ss.wrong >= 2) && !s.action && !s.watch) ss.passed = true;
    save();
    this.render();
  }

  private next(): void {
    const L = this.lesson;
    if (!L) return;
    if (this.viewIdx < this.cur) {
      this.viewIdx++;
      this.render();
      return;
    }
    const ss = this.st[this.cur];
    if (!ss.passed) return;
    if (this.cur >= L.steps.length - 1) {
      this.finish();
      return;
    }
    this.cur++;
    this.viewIdx = this.cur;
    this.enter(this.cur);
    lessonProgress(L.id).step = this.cur;
    save();
    this.render();
    this.onChange();
  }

  private acceptGiveUp(): void {
    const L = this.lesson;
    if (!L) return;
    const s = L.steps[this.cur];
    const ss = this.st[this.cur];
    const c = this.ctx(this.token, this.mem);
    try {
      s.watch?.onPass?.(c);
      ss.done = s.watch?.done(c) ?? '';
    } catch (e) {
      console.warn(e);
    }
    ss.passed = true;
    save();
    this.render();
  }

  /** «↻ Повторить опыт»: вернуться к ближайшей контрольной точке и запустить её опыт заново. */
  private retry(): void {
    const L = this.lesson;
    if (!L) return;
    let i = this.cur;
    while (i > 0 && !L.steps[i].checkpoint) i--;
    for (let j = i; j < L.steps.length; j++) this.st[j] = freshState();
    this.cur = i;
    this.viewIdx = i;
    lessonProgress(L.id).step = i;
    this.enter(i);
    if (L.steps[i].action) void this.act(i);
    else this.render();
  }

  private onClick(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    b.blur();
    const c = b.dataset.c;
    if (c === 'close') this.close();
    else if (c === 'min') {
      this.minimised = !this.minimised;
      this.render();
    } else if (c === 'resume' && this.resumeId) this.start(this.resumeId);
    else if (c === 'back' && this.viewIdx > 0) {
      this.viewIdx--;
      this.render();
    } else if (c === 'next') this.next();
    else if (c === 'act') void this.act(this.viewIdx);
    else if (c === 'play') {
      const p = this.base.planet;
      p.seek(p.snapshot().now, true);
      this.base.show('planet');
      this.render();
    }
    else if (c === 'goto') {
      const v = this.lesson?.steps[this.viewIdx].view;
      if (v) this.base.show(v);
    } else if (c === 'giveup') this.acceptGiveUp();
    else if (c === 'retry') this.retry();
    else if (c === 'opt') this.answer(this.viewIdx, Number(b.dataset.o));
  }

  // ---------------- проверки ----------------

  private defaultGuard(s: Step, c: LessonCtx): string | null {
    if (s.view === 'planet' && typeof c.mem.gen === 'number' && c.planet.snapshot().gen !== c.mem.gen)
      return 'на «Планете» открыт другой мир или сдвинут ползунок.';
    if (s.view === 'eco' && typeof c.mem.rg === 'number' && c.world.resetGen !== c.mem.rg) return 'мир на «Поверхности» создан заново.';
    return null;
  }

  private watching(i: number): boolean {
    const s = this.lesson!.steps[i];
    const ss = this.st[i];
    if (!s.watch || ss.passed) return false;
    if (s.quizFirst && !(ss.quizOk || ss.wrong >= 2)) return false;
    return s.action ? ss.acted : true;
  }

  private poll(): void {
    const L = this.lesson;
    if (!L) return;
    const i = this.cur;
    const s = L.steps[i];
    const ss = this.st[i];
    const c = this.ctx(this.token, this.mem);
    try {
      const active = !ss.passed && (ss.acted || !s.action);
      ss.guard = active && s.view ? (s.guard ? s.guard(c) : this.defaultGuard(s, c)) : null;
      if (!ss.guard && this.watching(i) && !ss.running && s.watch!.test(c)) {
        s.watch!.onPass?.(c);
        ss.done = s.watch!.done(c);
        ss.passed = true;
        save();
      } else if (!ss.guard && this.watching(i) && !ss.gave && s.watch!.giveUp) {
        const g = s.watch!.giveUp;
        if (g.ticks !== undefined && c.world.tick - ss.tick0 >= g.ticks) ss.gave = true;
        if (g.gyr !== undefined && c.planet.snapshot().now >= g.gyr) ss.gave = true;
        if (g.ms !== undefined && Date.now() - ss.ms0 >= g.ms) ss.gave = true;
      }
    } catch (e) {
      ss.err = e instanceof Error ? e.message : String(e);
      console.error(e);
    }
    this.render();
  }

  // ---------------- отрисовка ----------------

  private render(force = false): void {
    if (this.el.hidden) return;
    if (this.resumeId && !this.lesson) {
      const L = this.lessonById(this.resumeId)!;
      const sig = `resume:${L.id}`;
      if (sig === this.sig && !force) return;
      this.sig = sig;
      this.el.className = 'l-coach min resume';
      this.el.innerHTML = `<div class="l-head"><span class="l-ic">${L.icon}</span><b class="l-title">${L.title}</b>
        <button class="primary" data-c="resume">▶ Продолжить урок</button><button data-c="close" title="Закрыть" aria-label="Закрыть урок">✕</button></div>`;
      return;
    }
    const L = this.lesson;
    if (!L) return;
    const i = this.viewIdx;
    const s = L.steps[i];
    const ss = this.st[i];
    const review = i < this.cur;
    const c = this.ctx(this.token, this.mem);
    const watching = !review && this.watching(i) && !ss.guard;
    // история планеты стоит, а карточки нет (её закрыли ✕ или остановили ⏸) — сама она не пойдёт
    let stuck = false;
    if (watching && s.view === 'planet' && !ss.running && !ss.gave) {
      const p = c.planet.snapshot();
      stuck = !p.playing && p.now < p.result.end - 1e-6 && !c.planet.factOpen;
    }
    const sig = JSON.stringify([L.id, i, this.cur, ss, this.minimised, this.curView, this.st.map((x) => x.passed), watching, stuck]);
    let hint = '';
    if (watching) {
      const eco = s.view === 'eco';
      if (ss.gave) hint = '';
      else if (eco && (c.surface.speedNow === 0 || !c.surface.active) && !ss.running) hint = '⏸ Мир стоит — включите 12× (↪ К опыту)';
      else if (stuck) hint = '⏸ История планеты стоит — нажмите «▶ Дальше по истории»';
      else {
        try {
          hint = s.watch!.hint(c);
        } catch {
          hint = '';
        }
      }
    }
    const ro = s.readout ?? (s.view === 'eco' || s.view === 'planet' ? L.readout : undefined);
    let read = '';
    if (ro && !review && (ss.acted || !s.action)) {
      try {
        read = ro(c);
      } catch {
        read = '';
      }
    }
    if (sig === this.sig && !force) {
      if (hint !== this.hintText) {
        this.hintText = hint;
        const h = this.el.querySelector('.l-hint');
        if (h) h.textContent = hint;
      }
      if (read !== this.readText) {
        this.readText = read;
        const r = this.el.querySelector('.l-readout');
        if (r) r.textContent = read;
      }
      return;
    }
    this.sig = sig;
    this.hintText = hint;
    this.readText = read;

    const dots = L.steps
      .map((_, k) => `<i class="${k === i ? 'now' : ''} ${this.st[k].passed && k <= this.cur ? 'ok' : ''}" title="Шаг ${k + 1}"></i>`)
      .join('');
    const last = this.cur === L.steps.length - 1 && !review;

    // вопрос
    let quiz = '';
    if (s.quiz) {
      const q = s.quiz;
      const closed = ss.quizOk || ss.wrong >= 2;
      const opts = q.options
        .map((o, k) => {
          const cls = ss.picked.includes(k) ? (k === q.correct ? 'ok' : 'bad') : closed && k === q.correct ? 'ok' : '';
          return `<button data-c="opt" data-o="${k}" class="${cls}" ${closed ? 'disabled' : ''}>${o}</button>`;
        })
        .join('');
      let msg = '';
      if (ss.quizOk) msg = `<p class="l-ok">✓ Верно! ${q.explain}</p>`;
      else if (ss.wrong >= 2) msg = `<p class="l-explain">Правильный ответ отмечен зелёным. ${q.explain}</p>`;
      else if (ss.wrong === 1) msg = '<p class="l-bad">Не совсем — подумайте ещё.</p>';
      quiz = `<div class="l-quiz"><p class="l-q">❓ ${q.q}</p>${opts}${msg}</div>`;
    }

    // итог шага
    let result = '';
    if (ss.err) result = `<p class="l-bad">Не получилось: ${esc(ss.err)}</p>`;
    else if (ss.interrupted) result = '<p class="l-bad">Расчёт прервали — нажмите ещё раз.</p>';
    else if (ss.guard && !review)
      result = `<div class="l-guard"><p>⚠️ Опыт изменился: ${ss.guard}</p><button data-c="retry">↻ Повторить опыт</button></div>`;
    else if (ss.passed && ss.done) result = `<div class="l-done">${ss.done}</div>`;
    else if (ss.passed && s.after && ss.acted) {
      try {
        result = `<div class="l-done">${typeof s.after === 'string' ? s.after : s.after(c)}</div>`;
      } catch {
        result = '';
      }
    } else if (ss.gave && !review)
      result = `<div class="l-guard"><p>${s.watch?.giveUp?.text ?? (s.action ? `Так бывает — случайность. Можно повторить опыт кнопкой «${AGAIN}» ниже.` : 'Так бывает — случайность.')}</p><button data-c="giveup">Засчитать и идти дальше</button></div>`;

    // кнопки
    const showAction = !!s.action && (!s.quizFirst || ss.quizOk || ss.wrong >= 2);
    const actLabel = s.action ? (review || (ss.acted && !ss.running) ? AGAIN : s.action.label) : '';
    const needAction = showAction && !ss.acted && !review;
    const btns = [
      i > 0 ? '<button data-c="back">← Назад</button>' : '',
      s.view && this.curView !== s.view ? `<button data-c="goto">↪ К опыту: ${VIEW_LABEL[s.view]}</button>` : '',
      stuck ? '<button data-c="play" class="primary">▶ Дальше по истории</button>' : '',
      showAction ? `<button data-c="act" class="${needAction ? 'primary' : ''}" ${ss.running ? 'disabled' : ''}>${ss.running ? '⏳ Идёт…' : actLabel}</button>` : '',
      `<button data-c="next" class="${!needAction && (ss.passed || review) ? 'primary' : ''}" ${ss.passed || review ? '' : 'disabled'}>${last ? '🎓 Завершить' : 'Дальше →'}</button>`,
    ].join('');

    // карточки урока (методы науки встречаются только здесь)
    const stats = L.cards.filter((id) => id.startsWith('stats.'));
    const cards = stats.length
      ? `<details class="l-lcards" ${this.cardsOpen ? 'open' : ''}><summary>📖 Карточки урока (${stats.length})</summary>${stats
          .map((id) => {
            const f = this.cardText(id);
            return f ? `<div class="l-mini"><div class="tag">${FIELD_ICON[f.field]} ${f.field}</div><b>${f.title}</b><p>${f.text}</p>${f.earth ? `<p class="earth">🌍 ${f.earth}</p>` : ''}</div>` : '';
          })
          .join('')}</details>`
      : '';

    this.el.className = `l-coach${this.minimised ? ' min' : ''}${watching ? ' watching' : ''}`;
    this.el.innerHTML = `
      <div class="l-head">
        <span class="l-ic">${L.icon}</span><b class="l-title">${L.title}</b>
        <span class="l-step">Шаг ${i + 1} из ${L.steps.length}${review ? ' · повтор' : ''}</span>
        <span class="l-dots" aria-hidden="true">${dots}</span>
        <span class="l-sp"></span>
        <button data-c="min" title="${this.minimised ? 'Развернуть' : 'Свернуть'}" aria-label="${this.minimised ? 'Развернуть урок' : 'Свернуть урок'}">${this.minimised ? '▢' : '▁'}</button>
        <button data-c="close" title="Закрыть урок" aria-label="Закрыть урок">✕</button>
      </div>
      <div class="l-body">
        <p class="l-text">${s.text}</p>
        ${quiz}
        ${result}
        <p class="l-hint" aria-live="polite">${esc(hint)}</p>
        <p class="l-readout">${esc(read)}</p>
        <div class="l-btns">${btns}</div>
        ${cards}
      </div>`;
  }
}

export function toast(text: string): void {
  const t = document.createElement('div');
  t.className = 'l-toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
