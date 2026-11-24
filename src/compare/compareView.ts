/**
 * Вкладка «🌍 Сравнение миров»: Земля, Марс и Венера (и, по желанию, четвёртый мир)
 * в одной модели, на одной шкале времени.
 */
import './compare.css';
import { clamp } from '../lib/random';
import { STAGE_COLORS, xToTime } from '../planet/charts';
import { FACTS, FIELD_ICON, type Fact } from '../planet/facts';
import { Globe, type GlobeOptions } from '../planet/globe';
import { PRESETS, randomPlanet, simulate, type PlanetParams, type Sample, type SimResult } from '../planet/model';
import { drawCompareMetric, drawCompareTimeline, METRICS, type Row } from './compareCharts';
import { COMPARE_FACTS, WHY_ORDER } from './compareFacts';
import {
  applyWhatIf,
  EXTRA_COLOR,
  fmtGyr,
  fmtP,
  fmtT,
  isNatural,
  maxStageBy,
  microbeChip,
  outcomeText,
  pressureOf,
  sampleAt,
  setbacksBy,
  SOLAR,
  STAGE_SHORT,
  stageLabel,
  TODAY,
  waterChip,
  WHATIFS,
  type CompareWorld,
} from './worlds';

type PresetKey = keyof typeof PRESETS;

const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** Событие мира → автокарточка. */
const TRIGGERS: Record<string, string> = {
  'mars:dynamo': 'cmp_dynamo',
  'mars:atmoloss': 'cmp_size',
  'venus:runaway': 'cmp_runaway',
  'venus:carbonates': 'cmp_carbon',
  'earth:runaway': 'cmp_future',
};

/** Свои подписи событий для понятности. */
const EVENT_LABELS: Record<string, string> = {
  'venus:runaway': '🔥 Океаны Венеры выкипели',
  'venus:carbonates': '🌋 CO₂ из камней уходит в воздух Венеры',
  'mars:snowball': '❄️ Марс замёрз: Солнцу не хватает сил его согреть',
  'mars:dynamo': '🧲 Ядро Марса остыло — магнитный щит пропал',
  'mars:atmoloss': '🌫 Воздух Марса почти улетел в космос',
  'earth:runaway': '🔥 Океаны Земли выкипели — она стала как Венера',
};

const TEMPLATE = /* html */ `
<div class="cmp">
  <header class="cmp-head">
    <div class="cmp-title">
      <h2>🌍 Сравнение миров</h2>
      <p class="muted">Три соседа, одно Солнце, одинаковое начало — и три разные судьбы</p>
    </div>
    <div class="cmp-tools">
      <select class="cmp-preset" title="Допущения о том, как легко появляется жизнь">
        <option value="pessimist">${PRESETS.pessimist.name}</option>
        <option value="realist" selected>${PRESETS.realist.name}</option>
        <option value="optimist">${PRESETS.optimist.name}</option>
      </select>
      <div class="cmp-addwrap">
        <button class="cmp-add" aria-haspopup="true">➕ Мир</button>
        <div class="cmp-menu" hidden></div>
      </div>
      <label class="cmp-explain" title="Показывать научные карточки и ставить паузу"><input type="checkbox" checked> 💡 карточки</label>
    </div>
    <p class="cmp-note" hidden></p>
  </header>
  <div class="cmp-cols"></div>
  <div class="cmp-tablewrap"><table class="cmp-table"></table></div>
  <section class="cmp-charts">
    ${METRICS.map((m) => `<figure><figcaption>${m.label}${m.key === 'water' ? ' <small>— сплошная: жидкая, штрихи: лёд, точки: пар</small>' : m.key === 'T' ? ' <small>— зелёная полоса: 0…+50 °C</small>' : m.key === 'P' ? ' <small>— Земля сегодня: 1 бар</small>' : ''}</figcaption><canvas class="cmp-chart" data-m="${m.key}" title="Перетащите, чтобы перемотать историю"></canvas></figure>`).join('')}
  </section>
  <section class="cmp-whatif">
    <h3>🧪 Что если…</h3>
    <p class="muted">Поменяем одно свойство планеты и пересчитаем всю её историю. Ответ не заготовлен — его считает модель.</p>
    <div class="cmp-wi-btns">
      ${WHATIFS.map((w) => `<button data-wi="${w.key}">${w.label}</button>`).join('')}
      <button data-wi="reset" class="cmp-wi-reset">↺ Как в природе</button>
    </div>
    <div class="cmp-wi-out"></div>
  </section>
  <section class="cmp-why">
    <h3>🔬 Почему они такие разные</h3>
    <div class="cmp-why-grid"></div>
  </section>
  <div class="cmp-controls">
    <button class="cmp-play" title="Пробел">▶</button>
    <div class="cmp-age"></div>
    <select class="cmp-speed" title="Скорость проигрывания">
      <option value="0.1">0,1 млрд/с</option>
      <option value="0.3" selected>0,3 млрд/с</option>
      <option value="1">1 млрд/с</option>
    </select>
    <button class="cmp-today" title="Перейти к сегодняшнему дню — 4,57 млрд лет">⏩ Сегодня</button>
    <canvas class="cmp-timeline" title="Перетащите, чтобы перемотать историю"></canvas>
  </div>
  <div class="p-fact cmp-fact" hidden></div>
</div>`;

interface Col {
  sec: HTMLElement;
  box: HTMLElement;
  head: HTMLElement;
  stage: HTMLElement;
  metrics: HTMLElement;
  log: HTMLElement;
  real: HTMLElement;
}

interface Cell {
  icon: string;
  label: string;
  value: string;
  cls?: string;
  fact?: string;
  title?: string;
}

export class CompareView {
  onOpen: (p: PlanetParams, preset: PresetKey) => void = () => {};
  getLucky: () => PlanetParams[] = () => [];
  getPlanet: () => PlanetParams | null = () => null;
  onNeedMc: () => void = () => {};

  private worlds: CompareWorld[] = SOLAR.map((w) => ({ ...w }));
  private results: SimResult[] = [];
  /** Результаты «как в природе» — для сравнения в «Что если…» и в карточке «Модель против реальности». */
  private natural: SimResult[] = [];
  private globes: (Globe | null)[] = [];
  private cols: Col[] = [];
  private preset: PresetKey = 'realist';
  private now = 0;
  private playing = true;
  private speed = 0.3;
  private end = 10;
  private last = performance.now();
  private tick = 0;
  private dirty: boolean[] = [];
  private rr = 0;
  private pendingBake: number[] = [];
  private explain = true;
  private started = false;
  private shownFacts = new Set<string>();
  private factQueue: string[] = [];
  private noteTimer = 0;
  private globeOpts: GlobeOptions = {
    maxDpr: 1.5,
    trueScale: true,
    camDist: 3.6,
    camElev: 0.3, // чуть сверху — видно северную полярную шапку
    moonDist: 2.3,
    fit: true,
    controls: matchMedia('(pointer: coarse)').matches ? 'none' : 'rotate',
  };
  private _active = false;

  constructor(private root: HTMLElement) {
    root.innerHTML = TEMPLATE;
    this.worlds.forEach((_, i) => this.addColumn(i));
    this.recompute();
    this.renderWhy();
    this.bind();
    this.renderDynamic(true);
    requestAnimationFrame(() => this.loop());
  }

  get active(): boolean {
    return this._active;
  }

  set active(v: boolean) {
    this._active = v;
    if (!v) return;
    this.last = performance.now();
    this.dirty = this.dirty.map(() => true);
    if (!this.started) {
      this.started = true;
      // карточка «t = 0» — окно (from, to] её никогда не поймает, показываем сразу
      if (this.explain) {
        this.shownFacts.add('cmp_distance');
        this.playing = false;
        this.showFact('cmp_distance');
      }
    }
    requestAnimationFrame(() => this.renderDynamic(true));
  }

  /** Четвёртый мир (null — убрать). Возвращает false, если такой мир уже показан. */
  setSlot(i: 3, w: CompareWorld | null): boolean {
    if (!w) {
      if (this.worlds.length <= i) return true;
      this.globes[i]?.dispose();
      this.cols[i].sec.remove();
      this.worlds.length = this.results.length = this.globes.length = this.cols.length = this.dirty.length = i;
      this.pendingBake = this.pendingBake.filter((k) => k < i);
      this.layout();
      this.recompute();
      this.renderDynamic(true);
      return true;
    }
    if (isNatural(w.params)) return false;
    const world = { ...w, color: w.color || EXTRA_COLOR, params: { ...w.params } };
    if (this.worlds.length > i) {
      this.worlds[i] = world;
    } else {
      this.worlds[i] = world;
      this.addColumn(i);
    }
    this.layout();
    this.recompute(i);
    this.renderDynamic(true);
    return true;
  }

  // ---------------- построение ----------------

  private addColumn(i: number): void {
    const sec = document.createElement('section');
    sec.className = 'cmp-col';
    sec.dataset.i = String(i);
    sec.innerHTML = `
      <div class="cmp-globe"></div>
      <h3 class="cmp-colhead"></h3>
      <div class="cmp-stage"></div>
      <dl class="cmp-metrics"></dl>
      <ol class="cmp-log"></ol>
      <dl class="cmp-real" hidden></dl>`;
    $(this.root, '.cmp-cols').appendChild(sec);
    this.cols[i] = {
      sec,
      box: $(sec, '.cmp-globe'),
      head: $(sec, '.cmp-colhead'),
      stage: $(sec, '.cmp-stage'),
      metrics: $(sec, '.cmp-metrics'),
      log: $(sec, '.cmp-log'),
      real: $(sec, '.cmp-real'),
    };
    this.globes[i] = null;
    this.dirty[i] = false;
    this.layout();
  }

  private layout(): void {
    const n = this.worlds.length;
    $(this.root, '.cmp-cols').style.setProperty('--n', String(n));
    $(this.root, '.cmp-timeline').style.height = `${14 + n * 14}px`;
    $(this.root, '.cmp-tablewrap').classList.toggle('wide', n > 3);
  }

  private renderHeads(): void {
    this.worlds.forEach((w, i) => {
      const c = this.cols[i];
      c.sec.style.setProperty('--wc', w.color);
      c.sec.classList.toggle('modified', !!w.modified || i === 3);
      c.head.innerHTML = `<span class="cmp-ic">${w.icon}</span><span class="cmp-name">${esc(w.name)}</span>
        <button data-open="${i}" title="Открыть на вкладке «Планета»" aria-label="Открыть на вкладке «Планета»">↗</button>
        ${i === 3 ? `<button data-remove title="Убрать этот мир" aria-label="Убрать этот мир">✕</button>` : ''}`;
    });
  }

  private renderWhy(): void {
    $(this.root, '.cmp-why-grid').innerHTML = WHY_ORDER.map((id) => {
      const f = COMPARE_FACTS[id];
      const vals = f.vals
        ? `<div class="cmp-vals"><span class="cmp-vl">${f.valLabel ?? ''}</span>${f.vals.map((v, k) => `<span style="--wc:${SOLAR[k].color}"><i></i>${SOLAR[k].name}: <b>${v}</b></span>`).join('')}</div>`
        : '';
      return `<button class="cmp-card" data-fact="${id}"><span class="tag">${FIELD_ICON[f.field]} ${f.field}</span><span class="cmp-card-t">${f.title}</span>${vals}<span class="cmp-more">Читать →</span></button>`;
    }).join('');
  }

  // ---------------- расчёт ----------------

  private recompute(idx?: number): void {
    const a = PRESETS[this.preset].a;
    if (idx === undefined) this.natural = SOLAR.map((w) => simulate(w.params, a, true));
    const list = idx === undefined ? this.worlds.map((_, i) => i) : [idx];
    for (const i of list) {
      const w = this.worlds[i];
      const natIdx = SOLAR.findIndex((s) => s.params === w.params);
      this.results[i] = natIdx >= 0 && this.natural[natIdx] ? this.natural[natIdx] : simulate(w.params, a, true);
      const g = this.globes[i];
      // глобус уже есть — меняем дёшево (рельеф пересчитается, только если сменился seed)
      if (g) g.setPlanet(w.params, this.results[i].derived, { rock: w.rock });
      else if (!this.pendingBake.includes(i)) this.pendingBake.push(i);
      this.dirty[i] = true;
    }
    this.end = Math.max(...this.results.map((r) => r.end));
    this.now = Math.min(this.now, this.end);
    this.renderHeads();
    this.renderWhatIf();
  }

  private bakeOne(): void {
    const i = this.pendingBake.shift();
    if (i === undefined || i >= this.worlds.length) return;
    const w = this.worlds[i];
    const g = (this.globes[i] ??= new Globe(this.cols[i].box, this.globeOpts));
    g.setPlanet(w.params, this.results[i].derived, { rock: w.rock });
    this.dirty[i] = true;
  }

  // ---------------- события интерфейса ----------------

  private bind(): void {
    const r = this.root;
    const play = $<HTMLButtonElement>(r, '.cmp-play');
    play.onclick = () => {
      if (this.now >= this.end - 0.01) this.now = 0;
      this.playing = !this.playing;
      if (this.playing) this.hideFact(true);
      this.renderDynamic(true);
    };
    $<HTMLSelectElement>(r, '.cmp-speed').onchange = (e) => (this.speed = Number((e.target as HTMLSelectElement).value));
    $(r, '.cmp-today').onclick = () => {
      this.now = Math.min(TODAY, this.end);
      this.playing = false;
      if (this.explain && !this.shownFacts.has('cmp_model')) {
        this.shownFacts.add('cmp_model');
        this.showFact('cmp_model');
      }
      this.renderDynamic(true);
    };
    $<HTMLSelectElement>(r, '.cmp-preset').onchange = (e) => {
      this.preset = (e.target as HTMLSelectElement).value as PresetKey;
      this.recompute();
      this.renderDynamic(true);
    };
    $<HTMLInputElement>(r, '.cmp-explain input').onchange = (e) => {
      this.explain = (e.target as HTMLInputElement).checked;
      if (!this.explain) this.factQueue = [];
    };

    // перемотка по шкале и всем графикам
    const scrub = (canvas: HTMLCanvasElement) => {
      let down = false;
      const go = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        this.now = clamp(xToTime(e.clientX - rect.left, this.end, rect.width), 0, this.end);
        this.renderDynamic(true);
      };
      canvas.addEventListener('pointerdown', (e) => {
        down = true;
        this.playing = false;
        canvas.setPointerCapture(e.pointerId);
        go(e);
      });
      canvas.addEventListener('pointermove', (e) => down && go(e));
      canvas.addEventListener('pointerup', () => (down = false));
      canvas.addEventListener('pointercancel', () => (down = false));
    };
    scrub($(r, '.cmp-timeline'));
    r.querySelectorAll<HTMLCanvasElement>('.cmp-chart').forEach(scrub);

    // колонки: открыть мир, убрать 4-й, событие, микробы
    $(r, '.cmp-cols').addEventListener('click', (e) => this.onInfoClick(e));
    $(r, '.cmp-table').addEventListener('click', (e) => this.onInfoClick(e));

    // ➕ Мир
    const menu = $(r, '.cmp-menu');
    $(r, '.cmp-add').onclick = (e) => {
      e.stopPropagation();
      if (menu.hidden) this.renderMenu();
      menu.hidden = !menu.hidden;
    };
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !(e.target as HTMLElement).closest('.cmp-addwrap')) menu.hidden = true;
    });
    menu.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-add]') as HTMLButtonElement | null;
      if (!b) return;
      menu.hidden = true;
      this.addWorld(b.dataset.add!);
    });

    // что если
    $(r, '.cmp-wi-btns').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-wi]') as HTMLButtonElement | null;
      if (!b) return;
      const key = b.dataset.wi!;
      if (key === 'reset') {
        for (let i = 0; i < 3; i++) {
          if (this.worlds[i].modified) {
            this.worlds[i] = { ...SOLAR[i] };
            this.recompute(i);
          }
        }
      } else {
        const wi = WHATIFS.find((w) => w.key === key)!;
        const cur = this.worlds[wi.base];
        // повторное нажатие — вернуть как в природе
        this.worlds[wi.base] = cur.whatif === key ? { ...SOLAR[wi.base] } : applyWhatIf(wi);
        this.recompute(wi.base);
      }
      this.renderDynamic(true);
    });

    $(r, '.cmp-why-grid').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-fact]') as HTMLElement | null;
      if (b) {
        this.factQueue = [];
        this.showFact(b.dataset.fact!);
      }
    });

    $(r, '.cmp-fact').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.go) {
        // сначала — следующие карточки из очереди, потом продолжаем
        const next = this.factQueue.shift();
        if (next) return this.showFact(next);
        this.hideFact();
        if (this.now < this.end - 0.01) this.playing = true;
      } else {
        this.factQueue = [];
        this.hideFact();
      }
      this.renderDynamic(true);
    });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (!this.active || e.code !== 'Space' || tag === 'INPUT' || tag === 'SELECT') return;
      e.preventDefault();
      play.click();
    });
  }

  private onInfoClick(e: Event): void {
    const t = e.target as HTMLElement;
    const open = t.closest('button[data-open]') as HTMLButtonElement | null;
    if (open) {
      this.onOpen({ ...this.worlds[Number(open.dataset.open)].params }, this.preset);
      return;
    }
    if (t.closest('button[data-remove]')) {
      this.setSlot(3, null);
      return;
    }
    const li = t.closest('[data-t]') as HTMLElement | null;
    if (li) {
      this.now = Number(li.dataset.t);
      this.playing = false;
      if (li.dataset.fact) {
        this.factQueue = [];
        this.showFact(li.dataset.fact);
      }
      this.renderDynamic(true);
      return;
    }
    const f = t.closest('[data-fact]') as HTMLElement | null;
    if (f) {
      this.factQueue = [];
      this.showFact(f.dataset.fact!);
    }
  }

  private renderMenu(): void {
    const lucky = this.getLucky().length > 0;
    const has4 = this.worlds.length > 3;
    $(this.root, '.cmp-menu').innerHTML = `
      <button data-add="planet">🪐 Мир с вкладки «Планета»</button>
      <button data-add="random">🎲 Случайный мир</button>
      ${lucky ? `<button data-add="lucky">🍀 Счастливчик с разумом</button>` : `<button data-add="mc" class="cmp-dim">🍀 Счастливчиков пока нет — запустите 🎲 10 000 миров</button>`}
      ${has4 ? `<button data-add="remove">✕ Убрать четвёртый мир</button>` : ''}`;
  }

  private addWorld(kind: string): void {
    if (kind === 'mc') return this.onNeedMc();
    if (kind === 'remove') {
      this.setSlot(3, null);
      return;
    }
    let p: PlanetParams | null = null;
    let name = '';
    let icon = '🪐';
    if (kind === 'planet') {
      p = this.getPlanet();
      name = p ? `Мир #${p.seed}` : '';
    } else if (kind === 'random') {
      p = randomPlanet((Math.random() * 1e9) | 0);
      name = `Случайный #${p.seed}`;
      icon = '🎲';
    } else if (kind === 'lucky') {
      const list = this.getLucky();
      p = list[Math.floor(Math.random() * list.length)] ?? null;
      name = p ? `Счастливчик #${p.seed}` : '';
      icon = '🍀';
    }
    if (!p) return;
    const ok = this.setSlot(3, { id: 'extra', name, icon, color: EXTRA_COLOR, params: { ...p } });
    this.note(ok ? `Добавлен четвёртый мир: ${name}. Он не настоящий, поэтому сравнения с реальностью у него нет.` : 'Этот мир уже есть среди колонок — на вкладке «Планета» сейчас настоящая планета.');
  }

  private note(text: string): void {
    const el = $(this.root, '.cmp-note');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => (el.hidden = true), 5000);
  }

  // ---------------- отрисовка ----------------

  private sample(i: number): Sample {
    const r = this.results[i];
    return sampleAt(r, Math.min(this.now, r.end));
  }

  private cells(i: number): Cell[] {
    const r = this.results[i];
    const s = this.sample(i);
    const P = pressureOf(s);
    const w = waterChip(s, r);
    const max = maxStageBy(r, this.now);
    const sb = setbacksBy(r, this.now);
    const field = this.now < r.derived.dynamo;
    return [
      { icon: '🌡', label: 'Температура', value: fmtT(s), cls: s.T > 373 ? 'hot' : s.T < 273 ? 'cold' : 'ok' },
      { icon: '🌫', label: 'Давление', value: fmtP(P), title: 'У Земли сегодня — 1 бар' },
      { icon: '🫧', label: 'Кислород', value: `${(s.o2 * 100).toFixed(s.o2 < 0.01 ? (s.o2 === 0 ? 0 : 2) : 0).replace('.', ',')}%` },
      { icon: '💧', label: 'Вода', value: w.text, cls: w.kind, title: 'В земных океанах: 1 — столько воды, сколько в океанах Земли' },
      { icon: '🧲', label: 'Магнитное поле', value: field ? 'есть' : 'нет', cls: field ? 'ok' : 'cold', fact: 'cmp_dynamo' },
      { icon: '☀️', label: 'Свет Солнца', value: `×${s.flux.toFixed(2).replace('.', ',')}`, title: 'Сколько света получает планета, если у Земли сегодня — 1' },
      { icon: '🧬', label: 'Высшая ступень', value: `${STAGE_SHORT[max]}${sb ? ` · откатов: ${sb}` : ''}` },
      { icon: '', label: 'Ниша для микробов', value: microbeChip(s, r), fact: 'cmp_microbes', title: 'Гипотеза, не модель', cls: 'chip' },
    ];
  }

  private logItems(i: number, n: number): string {
    const w = this.worlds[i];
    const r = this.results[i];
    const evs = r.events.filter((e) => e.t <= this.now && e.kind !== 'impact').slice(-n).reverse();
    if (!evs.length) return `<li class="muted">Пока ничего не случилось</li>`;
    return evs
      .map((e) => {
        const key = `${w.id}:${e.id}`;
        const fact = !w.modified && TRIGGERS[key] ? TRIGGERS[key] : FACTS[e.id] ? e.id : '';
        const text = (!w.modified && EVENT_LABELS[key]) || e.text;
        return `<li data-t="${e.t}" ${fact ? `data-fact="${fact}" class="${e.kind} link"` : `class="${e.kind}"`}><span>${fmtGyr(e.t)}</span>${esc(text)}</li>`;
      })
      .join('');
  }

  private renderDynamic(full = false): void {
    const r = this.root;
    if (!this.results.length) return;
    $(r, '.cmp-age').textContent = fmtGyr(this.now);
    $(r, '.cmp-play').textContent = this.playing ? '⏸' : '▶';
    const rows: Row[] = this.worlds.map((w, i) => ({ res: this.results[i], color: w.color, label: w.name }));
    drawCompareTimeline($(r, '.cmp-timeline'), rows, this.now, this.end);
    this.worlds.forEach((_, i) => (this.dirty[i] = true));
    if (!full && this.tick++ % 4 !== 0) return;

    r.querySelectorAll<HTMLCanvasElement>('.cmp-chart').forEach((c) => drawCompareMetric(c, rows, this.now, this.end, METRICS.find((m) => m.key === c.dataset.m)!));

    const nearToday = Math.abs(this.now - TODAY) < 0.15;
    const allCells = this.worlds.map((_, i) => this.cells(i));
    this.worlds.forEach((w, i) => {
      const c = this.cols[i];
      const res = this.results[i];
      const s = this.sample(i);
      const dead = this.now > res.end + 1e-6;
      c.stage.textContent = dead ? '☠ Звезда погибла' : stageLabel(s, res);
      c.stage.style.color = dead || STAGE_COLORS[s.stage] === '#3a3f4a' ? '#9aa0a6' : STAGE_COLORS[s.stage];
      c.metrics.innerHTML = allCells[i]
        .map(
          (m) =>
            `<div class="cmp-m ${m.cls ?? ''}${m.fact ? ' link' : ''}" ${m.fact ? `data-fact="${m.fact}"` : ''} ${m.title ? `title="${m.title}"` : ''}><dt>${m.icon} ${m.label}</dt><dd>${m.value}</dd></div>`,
        )
        .join('');
      c.log.innerHTML = this.logItems(i, 3);
      const real = w.real && !w.modified && nearToday;
      c.real.hidden = !real;
      if (real && w.real) {
        const R = w.real;
        c.real.innerHTML = `<div class="cmp-real-h">📏 На самом деле сегодня</div>
          <div><dt>🌡</dt><dd>${R.T > 0 ? '+' : R.T < 0 ? '−' : ''}${Math.abs(R.T)} °C</dd></div>
          <div><dt>🌫</dt><dd>${fmtP(R.P)}</dd></div>
          <div><dt>🫧</dt><dd>O₂ ${R.o2 >= 0.01 ? Math.round(R.o2 * 100) : (R.o2 * 100).toFixed(2).replace('.', ',')}%</dd></div>
          <div><dt>💧</dt><dd>${R.water}</dd></div>`;
      }
    });

    // телефон: те же данные одной таблицей (строки — величины, столбцы — миры)
    const head = `<thead><tr><th></th>${this.worlds.map((w) => `<th style="--wc:${w.color}"><i></i>${w.icon} ${esc(w.name)}</th>`).join('')}</tr></thead>`;
    const body = allCells[0]
      .map((m, k) => `<tr><th>${m.icon || '🦠'} ${m.label}</th>${allCells.map((cs) => `<td class="${cs[k].cls ?? ''}${cs[k].fact ? ' link' : ''}" ${cs[k].fact ? `data-fact="${cs[k].fact}"` : ''}>${cs[k].value.replace(/^🦠 /, '')}</td>`).join('')}</tr>`)
      .join('');
    const realRow = nearToday
      ? `<tr class="cmp-realrow"><th>📏 На самом деле</th>${this.worlds.map((w) => `<td>${w.real && !w.modified ? `${w.real.T > 0 ? '+' : w.real.T < 0 ? '−' : ''}${Math.abs(w.real.T)} °C · ${fmtP(w.real.P)}` : '—'}</td>`).join('')}</tr>`
      : '';
    const lastRow = `<tr class="cmp-lastrow"><th>📜 Последнее</th>${this.worlds.map((_, i) => `<td><ol class="cmp-log">${this.logItems(i, 1)}</ol></td>`).join('')}</tr>`;
    $(r, '.cmp-table').innerHTML = head + `<tbody>${body}${realRow}${lastRow}</tbody>`;
  }

  private renderWhatIf(): void {
    const r = this.root;
    r.querySelectorAll<HTMLButtonElement>('[data-wi]').forEach((b) => b.classList.toggle('active', this.worlds.some((w) => w.whatif === b.dataset.wi)));
    const out: string[] = [];
    this.worlds.forEach((w, i) => {
      if (!w.whatif) return;
      const wi = WHATIFS.find((x) => x.key === w.whatif)!;
      const o = outcomeText(this.results[i]);
      const base = outcomeText(this.natural[wi.base]);
      out.push(`<div class="cmp-wi-res" style="--wc:${w.color}">
        <div class="cmp-wi-q"><b>${wi.label}</b> — ${wi.question}</div>
        <div>Итог к сегодняшнему дню (${fmtGyr(TODAY)}): <b>${o.now}</b>${o.story ? `<br><span class="muted">${o.story}</span>` : ''}</div>
        <div class="muted">Для сравнения, ${SOLAR[wi.base].name.toLowerCase() === 'земля' ? 'настоящая Земля' : `настоящ${SOLAR[wi.base].name === 'Марс' ? 'ий' : 'ая'} ${SOLAR[wi.base].name}`}: ${base.now}</div>
      </div>`);
    });
    $(r, '.cmp-wi-out').innerHTML = out.length
      ? out.join('')
      : `<p class="muted cmp-wi-empty">Нажмите на любой вопрос — колонка планеты изменится, и вы увидите, как пошла бы её история.</p>`;
  }

  // ---------------- карточки ----------------

  /** Собрать все автокарточки в окне (from, to] у «природных» миров. */
  private collect(from: number, to: number): void {
    if (!this.explain) return;
    const hits: { t: number; id: string }[] = [];
    this.worlds.forEach((w, i) => {
      if (w.modified || i >= 3) return;
      for (const e of this.results[i].events) {
        if (e.t <= from || e.t > to) continue;
        const id = TRIGGERS[`${w.id}:${e.id}`];
        if (id && !this.shownFacts.has(id)) hits.push({ t: e.t, id });
      }
    });
    if (from < TODAY && to >= TODAY && !this.shownFacts.has('cmp_model')) hits.push({ t: TODAY, id: 'cmp_model' });
    if (!hits.length) return;
    hits.sort((a, b) => a.t - b.t);
    for (const h of hits) {
      if (this.shownFacts.has(h.id)) continue;
      this.shownFacts.add(h.id);
      this.factQueue.push(h.id);
    }
    if ($(this.root, '.cmp-fact').hidden) {
      this.now = hits[0].t;
      this.playing = false;
      this.showFact(this.factQueue.shift()!);
    } else {
      this.now = hits[0].t;
      this.playing = false;
    }
  }

  private factExtra(id: string): string {
    if (id === 'cmp_model') {
      const rows = SOLAR.map((w, k) => {
        const r = this.natural[k];
        const s = sampleAt(r, TODAY);
        const R = w.real!;
        const wc = waterChip(s, r);
        return `<tr><th style="color:${w.color}">${w.icon} ${w.name}</th><td>${fmtT(s)}<small>${R.T > 0 ? '+' : R.T < 0 ? '−' : ''}${Math.abs(R.T)} °C</small></td><td>${fmtP(pressureOf(s))}<small>${fmtP(R.P)}</small></td><td>${(s.o2 * 100).toFixed(s.o2 < 0.01 ? 1 : 0).replace('.', ',')}%<small>${R.o2 >= 0.01 ? Math.round(R.o2 * 100) : (R.o2 * 100).toFixed(1).replace('.', ',')}%</small></td><td>${wc.text}<small>${R.water}</small></td></tr>`;
      }).join('');
      const e = sampleAt(this.natural[0], TODAY);
      const dT = 15 - Math.round(e.T - 273);
      return `<table class="cmp-mtable"><thead><tr><th></th><th>🌡</th><th>🌫</th><th>🫧 O₂</th><th>💧</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="muted small">Крупно — модель, мелко — измерения. Вода: в земных океанах.</p>
        <p>Где модель ошибается, честно: Земля в ней ${dT > 0 ? `холоднее на ${dT} °C` : dT < 0 ? `теплее на ${-dT} °C` : 'такая же по температуре'} и с давлением ${fmtP(pressureOf(e))} — так задано стартовое количество азота. А кислорода ${Math.round(e.o2 * 100)}% вместо 21% — как в каменноугольный период, 300 млн лет назад. Но порядок величин у всех трёх планет верный — значит, простые законы физики и химии схвачены правильно.</p>`;
    }
    if (id === 'cmp_future') {
      const boil = this.natural[0].events.find((e) => e.id === 'runaway');
      return boil
        ? `<p class="earth">В нашей модели океаны Земли выкипают только через ${fmtGyr(boil.t)} после её рождения — то есть через ${fmtGyr(boil.t - TODAY)} от сегодняшнего дня. Это позже настоящих оценок: углеродный термостат в модели держится слишком долго. Честная слабость простой модели.</p>`
        : `<p class="earth">В этом прогоне модели океаны Земли так и не выкипают до конца истории — термостат в модели держится дольше, чем в настоящих оценках.</p>`;
    }
    return '';
  }

  private showFact(id: string): void {
    const f: Fact | undefined = COMPARE_FACTS[id] ?? FACTS[id];
    if (!f) return;
    const cf = COMPARE_FACTS[id];
    const vals = cf?.vals
      ? `<div class="cmp-vals">${cf.valLabel ? `<span class="cmp-vl">${cf.valLabel}</span>` : ''}${cf.vals.map((v, k) => `<span style="--wc:${SOLAR[k].color}"><i></i>${SOLAR[k].name}: <b>${v}</b></span>`).join('')}</div>`
      : '';
    const el = $(this.root, '.cmp-fact');
    el.innerHTML = `
      <div class="tag">${FIELD_ICON[f.field]} ${f.field}${id === 'cmp_microbes' ? ' · гипотеза' : ''}</div>
      <h4>${f.title}</h4>
      <p>${f.text}</p>
      ${vals}
      ${this.factExtra(id)}
      ${f.earth ? `<p class="earth">🌍 ${f.earth}</p>` : ''}
      <div class="btns"><button data-go="1">${this.factQueue.length ? 'Дальше ▶ (ещё ' + this.factQueue.length + ')' : 'Дальше ▶'}</button><button aria-label="Закрыть">✕</button></div>`;
    el.hidden = false;
    el.scrollTop = 0;
  }

  private hideFact(clearQueue = false): void {
    if (clearQueue) this.factQueue = [];
    $(this.root, '.cmp-fact').hidden = true;
  }

  // ---------------- цикл ----------------

  private loop(): void {
    const t = performance.now();
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (this._active) {
      // тяжёлые «запекания» рельефа — не больше одного за кадр
      if (this.pendingBake.length) this.bakeOne();
      if (this.playing) {
        const prev = this.now;
        this.now += dt * this.speed;
        this.collect(prev, this.now);
        if (this.now >= this.end) {
          this.now = this.end;
          this.playing = false;
          this.renderDynamic(true);
        } else this.renderDynamic(this.now !== prev + dt * this.speed);
      }
      // перекраска глобусов — не больше одной за кадр (по кругу)
      const n = this.worlds.length;
      for (let k = 0; k < n; k++) {
        const i = (this.rr + k) % n;
        const g = this.globes[i];
        if (!this.dirty[i] || !g) continue;
        const s = this.sample(i);
        g.setState(s, s.stage >= 7);
        this.dirty[i] = false;
        this.rr = i + 1;
        break;
      }
      for (const g of this.globes) g?.frame(dt);
    }
    requestAnimationFrame(() => this.loop());
  }
}
