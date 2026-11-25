import { clamp } from '../lib/random';
import { plural } from '../lib/text';
import { FIELD_ICON, type Fact } from '../planet/facts';
import { GENE_INFO, GENE_KEYS, type GeneKey, type Genome } from '../sim/genome';
import type { Pathogen } from '../sim/microbes';
import type { Species } from '../sim/species';
import { B, BIOMES, soilName } from '../sim/terrain';
import { DAY, DIS, EARTH_ENV, World, type BrainMode, type Creature, type SurfaceEnv } from '../sim/world';
import { Camera } from './camera';
import { SURFACE_FACTS } from './facts';
import { MICROBE_GUILDS } from './microbes';
import { SurfaceRenderer, type Lens } from './renderer';

const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;

const WORLD_W = 3200;
const WORLD_H = 2000;

const PRESETS: { icon: string; name: string; g: Partial<Genome> }[] = [
  { icon: '🐇', name: 'Травоядное', g: { size: 3.5, speed: 1.3, sense: 55, diet: 0.05, tempPref: 0.5, social: 0.6 } },
  { icon: '🐗', name: 'Всеядное', g: { size: 6.5, speed: 1.3, sense: 60, diet: 0.45, tempPref: 0.5, social: 0.5 } },
  { icon: '🦊', name: 'Хищник', g: { size: 6, speed: 2.2, sense: 85, diet: 0.9, tempPref: 0.5, social: 0.6 } },
  { icon: '🐟', name: 'Пловец', g: { size: 4.5, speed: 1.3, sense: 55, diet: 0.15, tempPref: 0.55, swim: 0.85, social: 0.5 } },
  { icon: '🦣', name: 'Снежный гигант', g: { size: 10, speed: 1, sense: 60, diet: 0.05, tempPref: 0.15, social: 0.8 } },
  { icon: '🦎', name: 'Пустынник', g: { size: 2.5, speed: 1.6, sense: 70, diet: 0.1, tempPref: 0.85, social: 0.2 } },
];

const STATE_NAMES: Record<Creature['state'], string> = {
  wander: 'бродит',
  graze: 'пасётся',
  flee: 'убегает!',
  hunt: 'охотится',
  mate: 'ищет пару',
  scavenge: 'ест падаль',
  migrate: 'кочует',
  herd: 'держится стада',
  swim: 'плывёт',
  rest: 'отдыхает',
};

/** Линзы 🔬 по кругу и их легенды. Цвета — как в renderer.lensColor. */
const LENS_ORDER: Lens[] = ['off', 'fert', 'microbes', 'plankton', 'disease'];
const LENS_INFO: Record<Exclude<Lens, 'off'>, { title: string; fact: string; caption: string; grad?: string; lo?: string; hi?: string }> = {
  fert: {
    title: '🟫 Плодородие', fact: 'liebig',
    caption: 'Плодородие почвы относительно нормы: зелёное — трава растёт быстрее, красное — медленнее',
    grad: 'linear-gradient(90deg,rgb(200,85,60),rgb(175,165,120) 50%,rgb(60,190,90))', lo: 'медленнее', hi: 'быстрее',
  },
  microbes: {
    title: '🍄 Микробы почвы', fact: 'decomposers',
    caption: 'Бактерии и грибы почвы. Ярче там, где тепло, влажно и есть что есть; голубое — спят от мороза',
    grad: 'linear-gradient(90deg,#5a78aa 0 9%,#141a33 9%,#6b3fa0 55%,#ff7ad9)', lo: '❄ спят · мало', hi: 'много',
  },
  plankton: {
    title: '🌊 Планктон', fact: 'plankton',
    caption: 'Фитопланктон. Цветёт там, куда реки несут питательные вещества',
    grad: 'linear-gradient(90deg,#0b1f4d,#1b8fbf 55%,#7fe07a)', lo: 'пусто', hi: 'цветёт',
  },
  disease: { title: '☣️ Болезни', fact: 'sir', caption: '<b class="red">●</b> болеют · <b class="blue">●</b> защищены (переболели или иммунитет от матери) · остальные здоровы' },
};

const pct = (v: number) => `${Math.round(v * 100)}%`;
/**
 * Условная температура мира → °C, по порогам отрисовки и биомов: морской лёд (0.04) ≈ −3 °C, снег (0.1) ≈ 0 °C,
 * граница тундры (0.2) ≈ +5 °C, пустыни (0.66) ≈ +25 °C.
 */
const TEMP_C = [[-0.2, -35], [0.04, -3], [0.1, 0], [0.2, 5], [0.5, 15], [0.66, 25], [1, 42]];
const tempC = (t: number) => {
  if (t <= TEMP_C[0][0]) return TEMP_C[0][1];
  for (let k = 1; k < TEMP_C.length; k++) {
    const [t1, c1] = TEMP_C[k];
    if (t <= t1) {
      const [t0, c0] = TEMP_C[k - 1];
      return Math.round(c0 + ((t - t0) / (t1 - t0)) * (c1 - c0));
    }
  }
  return TEMP_C[TEMP_C.length - 1][1];
};
/** Сколько больных у болезни сейчас. */
const nowSick = (P: Pathogen) => (P.ended === null ? P.curve[P.curve.length - 1] ?? 0 : 0);

const dietIcon = (d: number) => (d < 0.3 ? '🌿' : d < 0.65 ? '🍽' : '🍖');
const spColor = (sp: Species, l = 62) => `hsl(${sp.hue},65%,${l}%)`;

const TEMPLATE = /* html */ `
<div class="s-layout">
  <section class="s-stage">
    <canvas class="s-canvas"></canvas>
    <div class="s-hud">
      <div class="s-env"></div>
      <div class="s-time"></div>
      <div class="s-region"></div>
    </div>
    <div class="s-top">
      <div class="s-speed">
        <button data-speed="0" title="Пауза (пробел)">⏸</button>
        <button data-speed="1" class="active">1×</button>
        <button data-speed="4">4×</button>
        <button data-speed="12">12×</button>
      </div>
      <select class="s-mode" title="Как существа принимают решения">
        <option value="rules">⚙️ Правила</option>
        <option value="neural">🧠 Нейросети</option>
      </select>
      <button class="s-reset">↻ Новый мир</button>
      <button class="s-back" hidden>↩ К планете</button>
    </div>
    <div class="s-tools">
      <button data-tool="inspect" class="active" title="Выбрать / двигать карту">🔍</button>
      <button data-tool="grass" title="Сажать траву">🌱</button>
      <button data-tool="spawn" title="Поселить существ">➕</button>
      <button data-tool="meteor" title="Метеорит">☄️</button>
      <button data-act="drought" title="Засуха">🔥</button>
      <button data-act="epidemic" title="Новая болезнь у самого многочисленного вида">🦠</button>
      <button data-act="lens" title="Микроскоп: невидимая жизнь (M)">🔬</button>
      <label class="s-explain" title="Научные карточки"><input type="checkbox" checked>💡</label>
    </div>
    <div class="s-spawn" hidden></div>
    <div class="s-lenslegend" hidden></div>
    <canvas class="s-mini" title="Миникарта: нажмите, чтобы перейти"></canvas>
    <div class="s-inspect" hidden></div>
    <div class="s-player" hidden></div>
    <div class="p-fact s-fact" hidden></div>
    <div class="s-modal" hidden></div>
  </section>
  <aside class="s-panel">
    <nav class="s-tabs">
      <button data-tab="species" class="active">Виды</button>
      <button data-tab="tree">Древо</button>
      <button data-tab="web">Связи</button>
      <button data-tab="charts">Графики</button>
      <button data-tab="micro">Микромир</button>
      <button data-tab="log">Летопись</button>
    </nav>
    <div class="s-tab" data-tab="species"><div class="s-spcard"></div><ol class="s-splist"></ol></div>
    <div class="s-tab" data-tab="tree" hidden>
      <p class="muted small">Древо жизни: каждая линия — вид, от рождения до вымирания. Толщина — сколько особей было на пике. Нажмите на линию, чтобы подсветить вид.</p>
      <div class="s-treewrap"><canvas class="s-tree"></canvas></div>
    </div>
    <div class="s-tab" data-tab="web" hidden>
      <p class="muted small">Пищевая сеть: стрелка — «кого едят → кто ест», толщина — сколько энергии течёт по ней сейчас. Внизу — растения, наверху — хищники.</p>
      <canvas class="s-web"></canvas>
    </div>
    <div class="s-tab" data-tab="charts" hidden>
      <h4>Численность видов</h4>
      <canvas class="s-pop"></canvas>
      <div class="s-legend"></div>
      <h4>Эволюция гена <select class="s-gene"></select></h4>
      <canvas class="s-genechart"></canvas>
    </div>
    <div class="s-tab" data-tab="micro" hidden>
      <h4>Круговорот веществ <a data-fact="decomposers">?</a></h4>
      <canvas class="s-cycle"></canvas>
      <p class="muted small">Микробы возвращают растениям то, что осталось от мёртвых. Часть уносят реки в море. Толщина стрелки — насколько поток сильнее или слабее обычного.</p>
      <h4>Невидимые жители</h4>
      <div class="s-guilds"></div>
      <h4>Эпидемии <a data-fact="sir">?</a></h4>
      <canvas class="s-epi"></canvas>
      <ol class="s-outbreaks"></ol>
      <h4>Почва и планктон <a data-fact="bloom">?</a></h4>
      <canvas class="s-soilchart"></canvas>
      <div class="s-legend s-soillegend"></div>
    </div>
    <div class="s-tab" data-tab="log" hidden><ol class="s-log"></ol></div>
  </aside>
</div>`;

export class SurfaceView {
  world = new World(WORLD_W, WORLD_H);
  cam = new Camera(WORLD_W, WORLD_H);
  renderer: SurfaceRenderer;
  active = false;
  onBack: (() => void) | null = null;

  private canvas: HTMLCanvasElement;
  private mini: HTMLCanvasElement;
  private speed = 1;
  private tool: 'inspect' | 'grass' | 'meteor' | 'spawn' = 'inspect';
  private preset = 0;
  private selected: Creature | null = null;
  private follow = false;
  private family = new Set<number>();
  private tab = 'species';
  private gene: GeneKey = 'size';
  private frame = 0;
  private explain = true;
  private shownFacts = new Set<string>();
  private lastEventTick = 0;
  private keys = new Set<string>();
  private cursor: [number, number] | null = null;
  private modalOpen = false;
  private treeRows: { sp: Species; y: number }[] = [];
  private fitted = false;
  /** Клетка в инспекторе (клик мимо существ). */
  private selectedCell: number | null = null;
  /** Карточки ждут своей очереди, пока открыта предыдущая. */
  private factQueue: string[] = [];
  private factNow: string | null = null;
  private factTimer: ReturnType<typeof setTimeout> | undefined;
  /** Какая болезнь на графике «Эпидемии». */
  private epiSel: number | null = null;
  /** Схема круговорота: текущие потоки, их «обычный» уровень и фазы бегущих точек. */
  private cyc = { v: [] as number[], ref: [] as number[], ph: [0, 0, 0, 0, 0, 0, 0], tick: -1 };
  private htmlCache = new WeakMap<HTMLElement, string>();

  constructor(private root: HTMLElement) {
    root.innerHTML = TEMPLATE;
    this.canvas = $(root, '.s-canvas');
    this.mini = $(root, '.s-mini');
    this.renderer = new SurfaceRenderer(this.canvas, this.world, this.cam);
    this.bindUi();
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe($(root, '.s-stage'));
    requestAnimationFrame(() => this.loop());
  }

  /** Перенести сюда условия планеты. */
  setEnv(env: SurfaceEnv, seed?: number): void {
    this.world.reset(this.world.brainMode, seed, env);
    this.afterReset();
    $(this.root, '.s-back').hidden = !this.onBack || env === EARTH_ENV;
    if (env.o2 > 0.25 || env.o2 < 0.17 || env.gravity > 1.2 || env.gravity < 0.8) this.queueFact('oxygen');
    if (!env.landLife) this.queueFact('stromatolites');
    if (env.o2 < 0.1) this.queueFact('o2decay'); // как в мире: гниение медленнее только ниже 10%
  }

  private afterReset(): void {
    this.renderer.rebuild();
    this.selected = null;
    this.selectedCell = null;
    this.epiSel = null;
    this.cyc = { v: [], ref: [], ph: [0, 0, 0, 0, 0, 0, 0], tick: -1 };
    this.family.clear();
    this.renderer.focusSpecies = null;
    this.lastEventTick = 0;
    // карточки прошлого мира здесь ни к чему
    this.factQueue = [];
    this.factNow = null;
    clearTimeout(this.factTimer);
    $(this.root, '.s-fact').hidden = true;
    this.closeModal();
    this.resize();
    this.cam.fit(this.canvas.clientWidth, this.canvas.clientHeight);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (!this.fitted || this.cam.zoom < this.cam.minZoom(w, h)) {
      this.cam.fit(w, h);
      this.fitted = true;
    }
  }

  // ---------------- кнопки ----------------

  private bindUi(): void {
    const r = this.root;
    r.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
      b.onclick = () => this.setSpeed(Number(b.dataset.speed));
    });
    const mode = $<HTMLSelectElement>(r, '.s-mode');
    mode.onchange = () => {
      this.world.reset(mode.value as BrainMode, undefined, this.world.env);
      this.afterReset();
    };
    $(r, '.s-reset').onclick = () => {
      this.world.reset(this.world.brainMode, undefined, this.world.env);
      this.afterReset();
    };
    $(r, '.s-back').onclick = () => this.onBack?.();
    r.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.onclick = () => {
        this.tool = b.dataset.tool as typeof this.tool;
        r.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
        $(r, '.s-spawn').hidden = this.tool !== 'spawn';
        this.canvas.style.cursor = this.tool === 'inspect' ? 'grab' : 'crosshair';
      };
    });
    $(r, '[data-act=drought]').onclick = () => this.world.startDrought();
    $(r, '[data-act=epidemic]').onclick = () => {
      const top = this.world.species.living()[0];
      this.world.epidemic();
      const P = top ? this.world.pathogens.get(top.id) : undefined;
      if (P) this.epiSel = P.id;
      this.setLens('disease');
      // без болезней (SIR) инструмент просто выкашивает вид — тогда и карточка другая
      this.queueFact(this.world.settings.disease ? 'rinderpest' : 'disease', true);
      this.openTab('micro');
    };
    $(r, '[data-act=lens]').onclick = () => this.cycleLens();
    $(r, '.s-lenslegend').addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-a=lensoff]')) this.setLens('off');
      const f = t.closest('[data-fact]') as HTMLElement | null;
      if (f) this.showFact(f.dataset.fact!);
    });
    // HUD перерисовывается 4 раза в секунду — ловим нажатие, а не click
    $(r, '.s-time').addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('.s-sick')) return;
      this.setLens('disease');
      this.openTab('micro');
    });
    // вкладка «Микромир»: показать линзу, карточка, выбор болезни
    $(r, '.s-tab[data-tab=micro]').addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const l = t.closest('[data-glens]') as HTMLElement | null;
      if (l) this.setLens(l.dataset.glens as Lens);
      const f = t.closest('[data-fact]') as HTMLElement | null;
      if (f) this.showFact(f.dataset.fact!);
    });
    // строки списка вспышек перерисовываются с живыми цифрами — выбираем по нажатию, а не по click
    $(r, '.s-outbreaks').addEventListener('pointerdown', (e) => {
      const p = (e.target as HTMLElement).closest('[data-p]') as HTMLElement | null;
      if (!p) return;
      this.epiSel = Number(p.dataset.p);
      this.renderMicro();
    });
    $<HTMLInputElement>(r, '.s-explain input').onchange = (e) => (this.explain = (e.target as HTMLInputElement).checked);

    const spawn = $(r, '.s-spawn');
    spawn.innerHTML = '<div class="muted small">Кликните по карте — поселим группу:</div>' +
      PRESETS.map((p, i) => `<button data-p="${i}" class="${i === 0 ? 'active' : ''}">${p.icon} ${p.name}</button>`).join('');
    spawn.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-p]') as HTMLElement | null;
      if (!b) return;
      this.preset = Number(b.dataset.p);
      spawn.querySelectorAll('[data-p]').forEach((x) => x.classList.toggle('active', x === b));
    });

    r.querySelectorAll<HTMLButtonElement>('.s-tabs [data-tab]').forEach((b) => {
      b.onclick = () => {
        this.tab = b.dataset.tab!;
        r.querySelectorAll('.s-tabs [data-tab]').forEach((x) => x.classList.toggle('active', x === b));
        r.querySelectorAll<HTMLElement>('.s-tab').forEach((t) => (t.hidden = t.dataset.tab !== this.tab));
        this.renderPanel();
      };
    });
    const geneSel = $<HTMLSelectElement>(r, '.s-gene');
    geneSel.innerHTML = GENE_KEYS.map((k) => `<option value="${k}">${GENE_INFO[k].label}</option>`).join('');
    geneSel.onchange = () => {
      this.gene = geneSel.value as GeneKey;
      this.renderPanel();
    };

    // клики по спискам
    $(r, '.s-splist').addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest('[data-sp]') as HTMLElement | null;
      if (li) this.focus(Number(li.dataset.sp));
    });
    $(r, '.s-spcard').addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-goto]')) this.gotoSpecies(this.renderer.focusSpecies!);
      if (t.closest('[data-unfocus]')) this.focus(null);
      const f = t.closest('[data-fact]') as HTMLElement | null;
      if (f) this.showFact(f.dataset.fact!);
    });
    $(r, '.s-log').addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest('[data-x]') as HTMLElement | null;
      if (li) this.cam.flyTo(Number(li.dataset.x), Number(li.dataset.y), 1.5);
      const f = (e.target as HTMLElement).closest('[data-fact]') as HTMLElement | null;
      if (f) this.showFact(f.dataset.fact!);
    });
    $(r, '.s-tree').addEventListener('click', (e) => {
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const y = e.clientY - rect.top;
      let best: { sp: Species; y: number } | null = null;
      for (const row of this.treeRows) if (!best || Math.abs(row.y - y) < Math.abs(best.y - y)) best = row;
      if (best && Math.abs(best.y - y) < 8) {
        this.focus(best.sp.id);
        this.tab = 'species';
        $<HTMLButtonElement>(r, '.s-tabs [data-tab=species]').click();
      }
    });
    $(r, '.s-inspect').addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = (t.closest('[data-a]') as HTMLElement | null)?.dataset.a;
      if (act === 'close') this.select(null);
      if (act === 'follow') this.follow = !this.follow;
      if (act === 'possess' && this.selected) {
        this.world.possess(this.selected);
        this.follow = true;
        this.cam.flyTo(this.selected.x, this.selected.y, 2);
      }
      if (act === 'species' && this.selected) this.focus(this.selected.sp);
      const f = t.closest('[data-fact]') as HTMLElement | null;
      if (f) this.showFact(f.dataset.fact!);
      this.renderInspector();
    });
    $(r, '.s-player').addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-a=leave]')) {
        this.world.possess(null);
        this.renderPlayer();
      }
    });
    $(r, '.s-fact').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      // сначала закрыть: setLens покажет карточку линзы, и её нельзя тут же спрятать
      const lens = b.dataset.lens;
      this.closeFact();
      if (lens) this.setLens(lens as Lens);
    });
    $(r, '.s-modal').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-heir]') as HTMLElement | null;
      if (!b) return;
      const id = Number(b.dataset.heir);
      const heir = this.world.creatures.find((c) => c.id === id && c.alive) ?? null;
      this.world.possess(heir);
      if (heir) {
        this.select(heir);
        this.follow = true;
      }
      this.closeModal();
    });
  }

  private setSpeed(v: number): void {
    this.speed = v;
    this.root.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('active', Number((x as HTMLElement).dataset.speed) === v));
  }

  // ---------------- мышь, тач, клавиатура ----------------

  private bindInput(): void {
    const c = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let start: { x: number; y: number } | null = null;
    let moved = false;
    let pinch = 0;
    const local = (e: PointerEvent | WheelEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const [x, y] = local(e);
      pointers.set(e.pointerId, { x, y });
      start = { x, y };
      moved = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
      if (this.tool === 'grass') this.world.paintGrass(...this.cam.toWorld(x, y, c.clientWidth, c.clientHeight), 50);
    });
    c.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      this.cursor = this.cam.toWorld(x, y, c.clientWidth, c.clientHeight);
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      if (pointers.size === 2) {
        pointers.set(e.pointerId, { x, y });
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this.cam.zoomAt(d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2, c.clientWidth, c.clientHeight);
        pinch = d;
        moved = true;
        return;
      }
      if (start && Math.hypot(x - start.x, y - start.y) > 5) moved = true;
      const p = this.world.player;
      if (p?.alive && this.tool === 'inspect') {
        // ваше существо идёт туда, куда вы держите палец/мышь
        const [wx, wy] = this.cam.toWorld(x, y, c.clientWidth, c.clientHeight);
        this.world.input.dx = wx - p.x;
        this.world.input.dy = wy - p.y;
      } else if (this.tool === 'grass') {
        this.world.paintGrass(...this.cursor, 50);
      } else if (moved) {
        this.cam.pan(x - prev.x, y - prev.y, c.clientWidth, c.clientHeight);
        this.follow = false;
        c.style.cursor = 'grabbing';
      }
      pointers.set(e.pointerId, { x, y });
    });
    const up = (e: PointerEvent) => {
      const [x, y] = local(e);
      pointers.delete(e.pointerId);
      if (this.tool === 'inspect') c.style.cursor = 'grab';
      if (this.world.player?.alive && !this.keys.size) {
        this.world.input.dx = 0;
        this.world.input.dy = 0;
      }
      if (moved || pointers.size) return;
      const [wx, wy] = this.cam.toWorld(x, y, c.clientWidth, c.clientHeight);
      if (this.tool === 'inspect' && !this.world.player?.alive) {
        const hit = this.world.creatureAt(wx, wy, 10 / this.cam.zoom);
        if (hit) this.select(hit);
        else if (wx >= 0 && wy >= 0 && wx < WORLD_W && wy < WORLD_H) this.selectCell(this.world.terrain.index(wx, wy));
      }
      else if (this.tool === 'meteor') this.world.meteor(wx, wy);
      else if (this.tool === 'spawn') {
        const p = PRESETS[this.preset];
        const sp = this.world.colonize({ ...p.g, hue: Math.random() * 360 }, 8, wx, wy);
        this.world.log(`${p.icon} Вы поселили группу: «${sp.name}» (8)`, 'info', wx, wy);
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', (e) => pointers.delete(e.pointerId));
    c.addEventListener('pointerleave', () => (this.cursor = null));
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const [x, y] = local(e);
        this.cam.zoomAt(Math.exp(-e.deltaY * 0.0015), x, y, c.clientWidth, c.clientHeight);
      },
      { passive: false },
    );

    // миникарта
    let miniDown = false;
    const miniGo = (e: PointerEvent) => {
      const r = this.mini.getBoundingClientRect();
      this.cam.flyTo(((e.clientX - r.left) / r.width) * WORLD_W, ((e.clientY - r.top) / r.height) * WORLD_H);
      this.follow = false;
    };
    this.mini.addEventListener('pointerdown', (e) => {
      miniDown = true;
      this.mini.setPointerCapture(e.pointerId);
      miniGo(e);
    });
    this.mini.addEventListener('pointermove', (e) => miniDown && miniGo(e));
    this.mini.addEventListener('pointerup', () => (miniDown = false));

    window.addEventListener('keydown', (e) => {
      if (!this.active || (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.setSpeed(this.speed === 0 ? 1 : 0);
        return;
      }
      if (e.code === 'Escape') {
        this.select(null);
        this.focus(null);
      }
      if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey) {
        this.cycleLens();
        return;
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  private applyKeys(): void {
    const k = this.keys;
    const dx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const dy = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    const p = this.world.player;
    if (p?.alive) {
      if (k.size) {
        this.world.input.dx = dx;
        this.world.input.dy = dy;
      }
      this.world.input.run = k.has('ShiftLeft') || k.has('ShiftRight');
    } else if (dx || dy) {
      this.cam.pan(-dx * 12, -dy * 12, this.canvas.clientWidth, this.canvas.clientHeight);
      this.follow = false;
    }
  }

  // ---------------- выбор ----------------

  private select(c: Creature | null): void {
    this.selected = c;
    this.selectedCell = null;
    this.follow = false;
    this.family = new Set(c ? this.world.descendants(c.id).map((d) => d.id) : []);
    if (c && c.g.diet < 0.3 && this.world.tick > 4000) this.queueFact('dung');
    this.renderInspector();
  }

  private selectCell(i: number): void {
    this.select(null);
    this.selectedCell = i;
    const b = this.world.terrain.biome[i];
    this.queueFact('soils');
    if (b === B.Tundra) this.queueFact('permafrost');
    if (b === B.Forest) this.queueFact('mycorrhiza');
    this.renderInspector();
  }

  private openTab(name: string): void {
    $<HTMLButtonElement>(this.root, `.s-tabs [data-tab=${name}]`).click();
  }

  // ---------------- линзы 🔬 ----------------

  private cycleLens(): void {
    const i = LENS_ORDER.indexOf(this.renderer.lens);
    this.setLens(LENS_ORDER[(i + 1) % LENS_ORDER.length]);
  }

  private setLens(l: Lens): void {
    this.renderer.setLens(l);
    const btn = $(this.root, '[data-act=lens]');
    btn.classList.toggle('active', l !== 'off');
    btn.title = l === 'off' ? 'Микроскоп: невидимая жизнь (M)' : `Линза: ${LENS_INFO[l].title.slice(LENS_INFO[l].title.indexOf(' ') + 1)} — нажмите для следующей (M)`;
    const el = $(this.root, '.s-lenslegend');
    el.hidden = l === 'off';
    if (l === 'off') return;
    const info = LENS_INFO[l];
    const k = LENS_ORDER.indexOf(l);
    el.innerHTML = `<div class="row"><b>${info.title}</b><span class="muted small">${k}/4</span><button data-a="lensoff" class="x" title="Выключить линзу">✕</button></div>${
      info.grad ? `<div class="lg-bar" style="background:${info.grad}"></div><div class="lg-ends"><span>${info.lo}</span><span>${info.hi}</span></div>` : ''
    }<p>${info.caption} <a data-fact="${info.fact}">?</a></p><div class="lg-cursor"></div>`;
    this.renderLensCursor();
    this.queueFact(info.fact, true);
  }

  /** Строка легенды «что под курсором». */
  private renderLensCursor(): void {
    const l = this.renderer.lens;
    if (l === 'off') return;
    const el = this.root.querySelector<HTMLElement>('.s-lenslegend .lg-cursor');
    if (!el) return;
    const w = this.world;
    const [x, y] = this.cursor ?? [this.cam.x, this.cam.y];
    if (x < 0 || y < 0 || x >= WORLD_W || y >= WORLD_H) {
      el.textContent = '';
      return;
    }
    const i = w.terrain.index(x, y);
    const b = BIOMES[w.terrain.biome[i]];
    const water = w.terrain.waterAt(x, y);
    let txt: string;
    if (l === 'disease') {
      let sick = 0, imm = 0, n = 0;
      for (const c of w.creatures) {
        if (Math.abs(c.x - x) > 120 || Math.abs(c.y - y) > 120) continue;
        n++;
        if (c.sick > 0) sick++;
        else if (c.immune > 0) imm++;
      }
      txt = n ? `Рядом: ${n} ${plural(n, 'зверь', 'зверя', 'зверей')} · болеют ${sick} · защищены ${imm}` : 'Рядом никого нет';
    } else if (b.water) txt = `🌊 Планктон ${pct(this.planktonAt(i))} · питательных веществ ×${w.soil[i].toFixed(2)}`;
    else txt = `Почва ×${w.nut[i].toFixed(2)} · микробы ${pct(w.mic[i])} · азотфиксаторы ${pct(w.fix[i])}`;
    el.textContent = txt + (water ? ` · 〰 ${water}` : '');
  }

  /** Густота планктона в водной клетке, 0..1 (как красит линза). */
  private planktonAt(i: number): number {
    const w = this.world;
    return clamp(clamp(w.grass[i] / BIOMES[w.terrain.biome[i]].fert, 0, 1) * w.nut[i], 0, 1);
  }

  private focus(id: number | null): void {
    this.renderer.focusSpecies = this.renderer.focusSpecies === id ? null : id;
    this.renderPanel();
  }

  private gotoSpecies(id: number): void {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const c of this.world.creatures) if (c.sp === id) {
      sx += c.x;
      sy += c.y;
      n++;
    }
    if (n) this.cam.flyTo(sx / n, sy / n, 1.2);
  }

  // ---------------- карточки ----------------

  /** Показать карточку один раз. Если открыта другая — встаёт в очередь (now — показать сразу, а ту отложить). */
  private queueFact(id: string, now = false): void {
    if (!this.explain) return;
    if (now) {
      // уже ждёт в очереди — показать сейчас
      const q = this.factQueue.indexOf(id);
      if (q >= 0) {
        this.factQueue.splice(q, 1);
        if (!$(this.root, '.s-fact').hidden && this.factNow) this.factQueue.unshift(this.factNow);
        this.showFact(id);
        return;
      }
    }
    if (this.shownFacts.has(id)) return;
    this.shownFacts.add(id);
    if (!$(this.root, '.s-fact').hidden && this.factNow) {
      if (!now) {
        this.factQueue.push(id);
        return;
      }
      this.factQueue.unshift(this.factNow);
    }
    this.showFact(id);
  }

  private showFact(id: string): void {
    const f: Fact | undefined = SURFACE_FACTS[id];
    if (!f) return;
    const el = $(this.root, '.s-fact');
    this.factNow = id;
    this.shownFacts.add(id); // прочитанную вручную не показываем ещё раз сами
    el.innerHTML = `<div class="tag">${FIELD_ICON[f.field]} ${f.field}</div><h4>${f.title}</h4><p>${f.text}</p>${
      f.earth ? `<p class="earth">🌍 ${f.earth}</p>` : ''
    }<div class="btns">${f.action && f.action.lens !== this.renderer.lens ? `<button data-lens="${f.action.lens}" class="act">${f.action.label}</button>` : ''}<button>Понятно</button></div>`;
    el.hidden = false;
  }

  private closeFact(): void {
    $(this.root, '.s-fact').hidden = true;
    this.factNow = null;
    clearTimeout(this.factTimer);
    if (!this.factQueue.length) return;
    // следующая карточка — после паузы, чтобы не сыпались одна за другой
    this.factTimer = setTimeout(() => {
      if (!$(this.root, '.s-fact').hidden) return;
      const id = this.factQueue.shift();
      if (id && this.explain) this.showFact(id);
    }, 1500);
  }

  private checkEvents(): void {
    for (const e of this.world.events) {
      if (e.tick <= this.lastEventTick) continue;
      if (e.kind === 'species') this.queueFact('species');
      else if (e.kind === 'migration' && e.text.startsWith('🧭')) this.queueFact('migration');
      else if (e.kind === 'extinct') this.queueFact('extinct');
      else if (e.kind === 'disaster' && e.text.includes('расплодились')) this.queueFact('disease');
      else if (e.kind === 'micro' && e.text.startsWith('🍄')) this.queueFact('carcass');
      else if (e.kind === 'micro' && e.text.startsWith('🌊')) this.queueFact('bloom');
      else if (e.kind === 'disease' && e.text.includes('вспышка')) this.queueFact('sir');
      else if (e.kind === 'disease' && e.text.includes('заглохла')) this.queueFact('r0');
    }
    const w = this.world;
    this.lastEventTick = w.tick;
    if (w.tick > 3000) this.queueFact('niche');
    if (w.tick > 9000) this.queueFact('cycle');
    // микромир: по одной карточке на открытие (§7.10)
    if (w.tick > 600 && w.terrain.rivers.length) this.queueFact('rivers');
    if (w.micro.corpsesRecycled >= 1 && w.tick > 1500) this.queueFact('decomposers');
    if (w.season.name === 'Зима' && w.year >= 2) this.queueFact('q10');
    // «увиденное» на карте — не в первые же секунды, пока игрок осматривается
    const seen = this.renderer.seen;
    if (w.tick > 400) {
      if (seen.fairy) this.queueFact('fairyring');
      if (seen.bubble) this.queueFact('methane');
      if (seen.glow) this.queueFact('biolum');
    }
    const z = this.cam.zoom;
    const t = w.terrain;
    if (z > 1 && this.cam.x >= 0 && this.cam.y >= 0 && this.cam.x < WORLD_W && this.cam.y < WORLD_H && t.biome[t.index(this.cam.x, this.cam.y)] === B.Swamp) this.queueFact('peat');
    if (z > 1.5 && t.springs.some((i) => Math.hypot(((i % t.cols) + 0.5) * w.cell - this.cam.x, (((i / t.cols) | 0) + 0.5) * w.cell - this.cam.y) < 60)) this.queueFact('hotsprings');
    if (w.micro.lastMeteor && w.tick - w.micro.lastMeteor.tick > 1500) this.queueFact('succession');
    if (w.outbreaks.some((P) => P.rEff < 1)) this.queueFact('r0');
    for (const P of [...w.pathogens.values(), ...w.outbreaks]) if (P.vir0 >= 0.75 && P.virMean <= P.vir0 - 0.15) this.queueFact('virulence');
  }

  // ---------------- игрок ----------------

  private renderPlayer(): void {
    const el = $(this.root, '.s-player');
    const p = this.world.player;
    if (!p) {
      el.hidden = true;
      return;
    }
    if (!p.alive) {
      el.hidden = true;
      if (!this.modalOpen) this.openDynasty(p);
      return;
    }
    const sp = this.world.species.all.get(p.sp);
    const e = clamp(p.energy / this.world.maxEnergy(p.g), 0, 1);
    el.hidden = false;
    el.innerHTML = `
      <div class="row"><b>👑 Вы — ${sp?.name ?? ''}</b><button data-a="leave" title="Перестать управлять">✕</button></div>
      <div class="bar"><div style="width:${e * 100}%;background:${e < 0.25 ? '#ff6b5b' : ''}"></div></div>
      <div class="muted small">Поколение ${p.generation} · детей ${p.children} · добыча ${p.kills} · ${STATE_NAMES[p.state]}</div>
      <div class="muted small hint">WASD / стрелки или держите палец — идти · Shift — бежать · пара рядом → потомство · трава под ногами — еда</div>`;
  }

  private openDynasty(dead: Creature): void {
    this.modalOpen = true;
    this.setSpeed(0);
    const heirs = this.world.descendants(dead.id).sort((a, b) => b.generation - a.generation || b.energy - a.energy).slice(0, 8);
    const sp = this.world.species.all.get(dead.sp);
    const el = $(this.root, '.s-modal');
    el.innerHTML = `<div class="card">
      <h3>💀 Ваше существо погибло</h3>
      <p class="muted">Причина: ${dead.cause ?? 'неизвестно'}. Вид: «${sp?.name}». Прожило ${Math.floor(dead.age / DAY)} дн., детей: ${dead.children}.</p>
      ${heirs.length ? '<p>Продолжить династию за потомка:</p>' : '<p>Живых потомков не осталось — династия прервалась.</p>'}
      <div class="heirs">${heirs
        .map((h) => `<button data-heir="${h.id}"><i style="background:hsl(${h.g.hue},65%,60%)"></i>#${h.id} · пок. ${h.generation} · ${this.world.species.all.get(h.sp)?.name}</button>`)
        .join('')}</div>
      <button data-heir="-1" class="watch">👁 Просто наблюдать</button>
    </div>`;
    el.hidden = false;
  }

  private closeModal(): void {
    this.modalOpen = false;
    $(this.root, '.s-modal').hidden = true;
    if (this.speed === 0) this.setSpeed(1);
  }

  // ---------------- инспектор ----------------

  private renderInspector(): void {
    const el = $(this.root, '.s-inspect');
    const c = this.selected;
    if (!c && this.selectedCell !== null && !this.world.player?.alive) {
      this.renderCell(el, this.selectedCell);
      return;
    }
    if (!c || this.world.player?.alive) {
      el.hidden = true;
      return;
    }
    const sp = this.world.species.all.get(c.sp)!;
    const e = clamp(c.energy / this.world.maxEnergy(c.g), 0, 1);
    const parent = c.mother !== null ? this.world.ancestors.get(c.mother) : undefined;
    const genes = GENE_KEYS.map((k) => {
      const info = GENE_INFO[k];
      const v = (c.g[k] - info.min) / (info.max - info.min);
      let diff = '';
      if (parent) {
        const d = c.g[k] - parent.g[k];
        if (Math.abs(d) / (info.max - info.min) > 0.01) diff = `<em class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'}</em>`;
      }
      return `<div class="gene" data-fact="${k}" title="${info.lo} ← → ${info.hi}"><span>${info.label} ${diff}</span><div class="gbar"><div style="width:${v * 100}%"></div></div><b>?</b></div>`;
    }).join('');
    el.hidden = false;
    this.htmlCache.delete(el);
    el.innerHTML = `
      <div class="head">
        <canvas class="portrait"></canvas>
        <div>
          <div class="spname" data-a="species" style="color:${spColor(sp)}">${sp.name}</div>
          <div class="latin">${sp.latin}</div>
          <div class="muted small">#${c.id} · поколение ${c.generation} · ${Math.floor(c.age / DAY)} дн. · ${c.alive ? STATE_NAMES[c.state] + (c.state === 'rest' ? ' <a data-fact="rest">?</a>' : '') : '✝ ' + (c.cause ?? '')}</div>
          <div class="bar"><div style="width:${e * 100}%"></div></div>
        </div>
        <button data-a="close" class="x">✕</button>
      </div>
      ${c.alive ? this.healthRow(c) : ''}
      <div class="muted small">Ест: ${this.dietText(c)}</div>
      <div class="genes">${genes}</div>
      <div class="muted small">Детей: ${c.children} · живых потомков: <b class="gold">${this.family.size}</b> · добыча: ${c.kills}${c.father === null && c.mother !== null ? ' · рождён без отца <a data-fact="parthenogenesis">?</a>' : ''}</div>
      <div class="btns">
        <button data-a="possess" ${c.alive ? '' : 'disabled'}>👑 Вселиться</button>
        <button data-a="follow" class="${this.follow ? 'active' : ''}">🎯 Следить</button>
      </div>`;
    this.renderer.portrait($(el, '.portrait'), c);
  }

  /** Здоровье: болеет, иммунитет от матери, переболел или здоров. */
  private healthRow(c: Creature): string {
    if (c.sick > 0) {
      const P = this.world.pathogens.get(c.sp);
      return `<div class="health sick">🤒 Болеет «${P?.name ?? 'неизвестная болезнь'}» — ещё ${Math.ceil((c.sick / DAY) * 24)} ч, вирулентность ${Math.round(c.vir * 100)}% <a data-fact="sir">?</a></div>`;
    }
    if (c.immune > 0 && c.age < DIS.MAT_IMM + 50) return '<div class="health imm">🍼 Иммунитет от матери</div>';
    if (c.immune > 0) return `<div class="health imm">🛡 Иммунитет: ещё ${Math.ceil(c.immune / DAY)} дн.</div>`;
    return '<div class="health">💚 Здоров</div>';
  }

  /** Инспектор клетки: почва, микробы, вода (клик мимо существ). */
  private renderCell(el: HTMLElement, i: number): void {
    const w = this.world;
    const t = w.terrain;
    const cols = t.cols;
    const x = ((i % cols) + 0.5) * w.cell;
    const y = (((i / cols) | 0) + 0.5) * w.cell;
    const bi = t.biome[i] as B;
    const b = BIOMES[bi];
    const reg = t.regionAt(x, y);
    const water = t.waterAt(x, y);
    // вечные снега гор — всегда мороз (они там из-за высоты, а не из-за широты)
    const deg = bi === B.Snow ? Math.min(-3, tempC(w.temp(i))) : tempC(w.temp(i));
    const bar = (label: string, v: number, color: string, note = '') =>
      `<div class="crow"><span>${label}</span><div class="gbar"><div style="width:${clamp(v, 0, 1) * 100}%;background:${color}"></div></div></div>${note ? `<div class="muted small cnote">${note}</div>` : ''}`;
    const fact = (id: string) => ` <a data-fact="${id}">?</a>`;
    const rows: string[] = [];
    rows.push(`<div class="small">🟫 Почва: <b>${soilName(t, i)}</b>${fact('soils')} · 🌡 ≈ ${deg} °C</div>`);
    if (b.water) {
      rows.push(bar(`Питательные вещества ×${w.soil[i].toFixed(2)}`, (w.soil[i] - 0.3) / 1.4, '#5ec7e8'));
      const pl = this.planktonAt(i);
      rows.push(bar(`🌊 Планктон ${pct(pl)}${fact('plankton')}`, pl, 'linear-gradient(90deg,#1b8fbf,#7fe07a)'));
    } else {
      const nut = w.nut[i];
      rows.push(bar(`Плодородие ×${nut.toFixed(2)}${fact('liebig')}`, (nut - 0.6) / 0.8, nut >= 1 ? '#5fc46a' : '#d0694c'));
      rows.push(bar('Мёртвая органика', w.litter[i] / (w.litter[i] + 1), '#a07a52'));
      const m = w.mic[i];
      const per = m >= 0.95 ? 'до миллиарда' : m < 0.1 ? `≈ ${Math.max(10, Math.round(m * 100) * 10)} млн` : `≈ ${Math.round(m * 10) * 100} млн`;
      rows.push(bar(`Микробы ${pct(m)}`, m, 'linear-gradient(90deg,#6b3fa0,#ff7ad9)', `${per} бактерий в грамме${w.act[i] < 0.15 && w.temp(i) < 0.25 ? ' · спят от холода' : ''}`));
      rows.push(bar(`Азотфиксаторы ${pct(w.fix[i])}${fact('nitrogen')}`, w.fix[i], '#c9e86b'));
      if (bi === B.Forest || bi === B.Swamp) rows.push(bar(`Грибница ${pct(w.myc[i])}${fact('mycorrhiza')}`, w.myc[i], '#d8c3a0'));
      if (bi === B.Tundra) rows.push(`<div class="small">❄ Холод не даёт органике сгнить — здесь копится углерод${fact('permafrost')}</div>`);
      if (bi === B.Swamp) rows.push(`<div class="small">🫧 Выделяет болотный газ${fact('methane')}</div>`);
    }
    if (water) rows.push(`<div class="small">〰 ${water}${fact('rivers')}</div>`);
    if (t.springs.includes(i)) rows.push(`<div class="small">♨ Горячий источник${fact('hotsprings')}</div>`);
    if (w.corpses.some((k) => k.energy > 0 && Math.abs(k.x - x) < 30 && Math.abs(k.y - y) < 30 && Math.hypot(k.x - x, k.y - y) < 30))
      rows.push(`<div class="small">🦴 Здесь разлагается туша${fact('carcass')}</div>`);
    const html = `<div class="row"><b>📍 ${reg ? reg.name : b.water ? 'Море' : 'Безымянные земли'} · ${b.name}</b><button data-a="close" class="x">✕</button></div>${rows.join('')}`;
    el.hidden = false;
    this.setHtml(el, html);
  }

  /** innerHTML только если что-то поменялось (иначе клики по «?» теряются при перерисовке). */
  private setHtml(el: HTMLElement, html: string): void {
    if (this.htmlCache.get(el) === html) return;
    this.htmlCache.set(el, html);
    el.innerHTML = html;
  }

  /** Чем питается существо — по его генам и нишам. */
  private dietText(c: Creature): string {
    const w = this.world;
    const parts: string[] = [];
    const pv = w.plantValue(c);
    if (c.g.swim > 0.5 && pv > 0.2) parts.push('водоросли');
    if (pv > 0.2 && w.grassAccess(c, w.terrain.index(c.x, c.y)) > 0.2 && c.g.swim < 0.7) parts.push('траву <a data-fact="gut">(с помощью микробов)</a>');
    if (w.reach(c) * pv > 0.15) parts.push('<a data-fact="browse">листву</a>');
    if (w.forageEff(c) > 0.2) parts.push('<a data-fact="niche">ягоды и насекомых</a>');
    if (c.g.diet > 0.35) parts.push(`добычу до размера ${w.preyLimit(c).toFixed(1)}`);
    if (c.g.diet > 0.3) parts.push('падаль');
    return parts.join(', ') || '—';
  }

  // ---------------- панель ----------------

  private renderHud(): void {
    const w = this.world;
    const s = w.season;
    const env = w.env;
    $(this.root, '.s-env').innerHTML = `<b>${env.name}</b> <span>O₂ ${Math.round(env.o2 * 100)}%</span><span>g ${env.gravity.toFixed(2)}</span>${env.landLife ? '' : '<span>🌊 жизнь пока только в море</span>'}`;
    const t = w.dayTime;
    const dayIcon = t < 0.2 || t > 0.8 ? '🌙' : t < 0.3 ? '🌅' : t > 0.7 ? '🌇' : '☀️';
    $(this.root, '.s-time').innerHTML = `<span>${s.icon} ${s.name}, год ${w.year}</span><span>${dayIcon} день ${Math.floor(w.tick / DAY)}</span><span>🐾 ${w.creatures.length}</span><span>🧬 ${w.species.living().length} видов</span>${
      w.drought > 0 ? '<span>🔥 засуха</span>' : ''
    }${w.micro.sick > 0 ? `<span class="s-sick" title="Открыть «Микромир» и линзу болезней">🤒 больных ${w.micro.sick}</span>` : ''}`;
    const at = this.cursor ?? [this.cam.x, this.cam.y];
    const reg = w.terrain.regionAt(at[0], at[1]);
    const water = w.terrain.waterAt(at[0], at[1]);
    let txt = reg ? `📍 ${reg.name}${water ? ' · 〰 ' + water : ''}` : water ? `〰 ${water}` : '';
    if (this.renderer.lens !== 'off' && at[0] >= 0 && at[1] >= 0 && at[0] < WORLD_W && at[1] < WORLD_H) {
      // с линзой — что творится в почве под курсором
      const i = w.terrain.index(at[0], at[1]);
      const bi = w.terrain.biome[i] as B;
      const b = BIOMES[bi];
      if (b.water) txt += ` · планктон ${pct(this.planktonAt(i))}`;
      else {
        const a = w.act[i];
        const st = bi === B.Swamp ? 'задыхаются (болото)' : a > 0.6 ? 'активны' : a >= 0.15 ? 'медленно' : w.temp(i) < 0.25 ? 'спят (мороз)' : 'медленно';
        txt += ` · почва ×${w.nut[i].toFixed(2)} · микробы: ${st}`;
      }
    }
    $(this.root, '.s-region').textContent = txt;
  }

  private renderPanel(): void {
    if (this.tab === 'species') this.renderSpecies();
    else if (this.tab === 'tree') this.drawTree();
    else if (this.tab === 'web') this.drawWeb();
    else if (this.tab === 'charts') this.drawCharts();
    else if (this.tab === 'micro') this.renderMicro();
    else this.renderLog();
  }

  private renderSpecies(): void {
    const living = this.world.species.living();
    const max = Math.max(1, ...living.map((s) => s.count));
    const focus = this.renderer.focusSpecies;
    $(this.root, '.s-splist').innerHTML = living
      .slice(0, 40)
      .map(
        (s) => `<li data-sp="${s.id}" class="${s.id === focus ? 'on' : ''}">
          <i style="background:${spColor(s)}"></i>
          <span class="nm">${dietIcon(s.mean.diet)} ${s.name}<small>${s.latin}</small></span>
          <span class="ct">${s.count}</span>
          <div class="mb"><div style="width:${(s.count / max) * 100}%;background:${spColor(s, 50)}"></div></div>
        </li>`,
      )
      .join('');
    const card = $(this.root, '.s-spcard');
    const sp = focus !== null ? this.world.species.all.get(focus) : null;
    if (!sp) {
      card.innerHTML = `<p class="muted small">${living.length} живых видов, всего за историю — ${this.world.species.all.size}. Нажмите на вид, чтобы подсветить его на карте.</p>`;
      return;
    }
    const parent = sp.parent ? this.world.species.all.get(sp.parent) : null;
    card.innerHTML = `<div class="card">
      <div class="row"><b style="color:${spColor(sp)}">${sp.name}</b><button data-unfocus class="x">✕</button></div>
      <div class="latin">${sp.latin}</div>
      <div class="muted small">Возник на ${Math.floor(sp.born / DAY)}-й день в «${sp.origin}»${parent ? `, предок — «${parent.name}»` : ' (основатель)'}. Освоил регионов: ${sp.regions.size}. Пик численности: ${sp.peak}.</div>${this.diseaseRow(sp)}
      <div class="genes">${GENE_KEYS.map((k) => {
        const i = GENE_INFO[k];
        const v = (sp.mean[k] - i.min) / (i.max - i.min);
        return `<div class="gene" data-fact="${k}"><span>${i.label}</span><div class="gbar"><div style="width:${v * 100}%;background:${spColor(sp, 55)}"></div></div><b>?</b></div>`;
      }).join('')}</div>
      <button data-goto>📍 Показать на карте</button>
    </div>`;
  }

  /** Строка карточки вида: идёт ли среди него болезнь. */
  private diseaseRow(sp: Species): string {
    const P = this.world.pathogens.get(sp.id);
    if (!P) return '';
    const I = nowSick(P);
    return `<div class="health sick small">🦠 «${P.name}» — болеют ${I} (${pct(I / Math.max(1, sp.count))}), переболели ${P.recovered}, погибли ${P.deaths} <a data-fact="sir">?</a></div>`;
  }

  private canvasCtx(c: HTMLCanvasElement, h?: number): [CanvasRenderingContext2D, number, number] {
    const dpr = window.devicePixelRatio || 1;
    if (h) c.style.height = `${h}px`;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(hh * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    return [ctx, w, hh];
  }

  private drawTree(): void {
    const all = [...this.world.species.all.values()];
    // показываем заметные виды и их предков (чтобы дерево было связным)
    const keep = new Set<number>();
    for (const s of all) {
      if (s.peak >= 8 || (s.extinct === null && s.count >= 3)) {
        let cur: Species | undefined = s;
        while (cur && !keep.has(cur.id)) {
          keep.add(cur.id);
          cur = cur.parent ? this.world.species.all.get(cur.parent) : undefined;
        }
      }
    }
    const nodes = all.filter((s) => keep.has(s.id));
    const kids = new Map<number | null, Species[]>();
    for (const s of nodes) {
      const p = s.parent !== null && keep.has(s.parent) ? s.parent : null;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p)!.push(s);
    }
    const order: Species[] = [];
    const visit = (p: number | null) => {
      for (const s of (kids.get(p) ?? []).sort((a, b) => a.born - b.born)) {
        order.push(s);
        visit(s.id);
      }
    };
    visit(null);
    const ROW = 15;
    const [ctx, w, h] = this.canvasCtx($(this.root, '.s-tree'), Math.max(240, order.length * ROW + 30));
    const now = Math.max(1, this.world.tick);
    const X = (t: number) => 8 + (t / now) * (w - 130);
    const ys = new Map<number, number>();
    order.forEach((s, i) => ys.set(s.id, 14 + i * ROW));
    this.treeRows = order.map((s) => ({ sp: s, y: ys.get(s.id)! }));
    ctx.font = '11px system-ui';
    for (const s of order) {
      const y = ys.get(s.id)!;
      const x0 = X(s.born);
      const x1 = X(s.extinct ?? now);
      const alive = s.extinct === null;
      if (s.parent !== null && ys.has(s.parent)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, ys.get(s.parent)!);
        ctx.lineTo(x0, y);
        ctx.stroke();
      }
      ctx.strokeStyle = alive ? spColor(s) : `hsla(${s.hue},30%,45%,0.6)`;
      ctx.lineWidth = Math.min(7, 1 + Math.log2(1 + s.peak) * 0.7);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(Math.max(x0 + 2, x1), y);
      ctx.stroke();
      if (s.id === this.renderer.focusSpecies) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 - 3, y - 6, x1 - x0 + 6, 12);
      }
      ctx.fillStyle = alive ? '#e6e8df' : 'rgba(230,232,223,0.4)';
      ctx.fillText(alive ? s.name : `✝ ${s.name}`, Math.max(x0 + 2, x1) + 6, y + 4);
    }
    void h;
  }

  private drawWeb(): void {
    const w0 = this.world;
    const living = w0.species.living().filter((s) => s.count >= 3).slice(0, 12);
    const [ctx, w, h] = this.canvasCtx($(this.root, '.s-web'), 450);
    type Node = { id: number; x: number; y: number; r: number; label: string; color: string };
    const nodes = new Map<number, Node>();
    // нижний ряд — еда без хозяина; подписи под узлами в две строки
    const yb = h - 44;
    nodes.set(0, { id: 0, x: w * 0.28, y: yb, r: 14, label: '🌿 Трава, водоросли', color: '#4fae5b' });
    nodes.set(-1, { id: -1, x: w * 0.78, y: yb, r: 10, label: '🦴 Падаль', color: '#bfb59a' });
    nodes.set(-2, { id: -2, x: w * 0.46, y: yb, r: 11, label: '🍓 Ягоды, насекомые', color: '#d85a7f' });
    nodes.set(-3, { id: -3, x: w * 0.1, y: yb, r: 12, label: '🌳 Листва', color: '#2f7d3a' });
    // микромир: опад, разложители (едят падаль и опад), болезни (едят всех понемногу)
    nodes.set(-5, { id: -5, x: w * 0.62, y: yb, r: 9, label: '🍂 Опад и помёт', color: '#a07a52' });
    nodes.set(-4, { id: -4, x: w * 0.88, y: yb - 50, r: 10, label: '🍄 Разложители', color: '#c9a27a' });
    nodes.set(-6, { id: -6, x: w * 0.92, y: 30, r: 9, label: '🦠 Болезни', color: '#9bd36a' });
    const sorted = [...living].sort((a, b) => a.mean.diet - b.mean.diet);
    sorted.forEach((s, i) => {
      const y = h - 120 - s.mean.diet * (h - 165);
      const x = 34 + ((i + 0.5) / sorted.length) * (w - 68);
      // соседние узлы сдвигаем по вертикали, чтобы подписи не слипались
      nodes.set(s.id, { id: s.id, x, y: y + (i % 2 ? 26 : -26) * (sorted.length > 4 ? 1 : 0), r: 5 + Math.sqrt(s.count) * 0.7, label: s.name, color: spColor(s) });
    });
    const edges = [...w0.web.entries()]
      .map(([k, v]) => {
        const [a, b] = k.split('>').map(Number);
        return { pred: nodes.get(a), prey: nodes.get(b), v };
      })
      .filter((e) => e.pred && e.prey && e.v > 0.05);
    const vmax = Math.max(1, ...edges.map((e) => e.v));
    for (const e of edges) {
      const a = e.prey!;
      const b = e.pred!;
      ctx.strokeStyle = b.color;
      ctx.globalAlpha = 0.25 + 0.6 * Math.sqrt(e.v / vmax);
      ctx.lineWidth = 1 + 5 * Math.sqrt(e.v / vmax);
      const mx = (a.x + b.x) / 2 + (a.y - b.y) * 0.15;
      const my = (a.y + b.y) / 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
      ctx.stroke();
      // наконечник у того, кто ест
      const ang = Math.atan2(b.y - my, b.x - mx);
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.moveTo(b.x - Math.cos(ang) * b.r, b.y - Math.sin(ang) * b.r);
      ctx.lineTo(b.x - Math.cos(ang - 0.4) * (b.r + 9), b.y - Math.sin(ang - 0.4) * (b.r + 9));
      ctx.lineTo(b.x - Math.cos(ang + 0.4) * (b.r + 9), b.y - Math.sin(ang + 0.4) * (b.r + 9));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // разложители возвращают траве азот и фосфор — замыкаем круг пунктиром
    const dA = nodes.get(-4)!;
    const dB = nodes.get(0)!;
    const qx = (dA.x + dB.x) / 2;
    const qy = Math.min(dA.y, dB.y) - 46;
    ctx.strokeStyle = '#c9a27a';
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(dA.x - dA.r, dA.y);
    ctx.quadraticCurveTo(qx, qy, dB.x + dB.r * 0.7, dB.y - dB.r * 0.7);
    ctx.stroke();
    ctx.setLineDash([]);
    const ang = Math.atan2(dB.y - dB.r * 0.7 - qy, dB.x + dB.r * 0.7 - qx);
    const tx = dB.x + dB.r * 0.7;
    const ty = dB.y - dB.r * 0.7;
    ctx.fillStyle = '#c9a27a';
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - Math.cos(ang - 0.45) * 8, ty - Math.sin(ang - 0.45) * 8);
    ctx.lineTo(tx - Math.cos(ang + 0.45) * 8, ty - Math.sin(ang + 0.45) * 8);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    for (const n of nodes.values()) {
      ctx.fillStyle = n.color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      const words = n.label.split(' ');
      if (n.id <= 0) {
        // еда и микромир: значок в кружке, подпись мелко и с переносом
        ctx.font = `${Math.round(n.r * 1.1)}px system-ui`;
        ctx.fillText(words[0], n.x, n.y + n.r * 0.4);
        ctx.font = '9.5px system-ui';
        ctx.fillStyle = '#e6e8df';
        const lines: string[] = [];
        for (const wd of words.slice(1)) {
          const l = lines.length ? `${lines[lines.length - 1]} ${wd}` : wd;
          if (lines.length && ctx.measureText(l).width <= 56) lines[lines.length - 1] = l;
          else lines.push(wd);
        }
        lines.slice(0, 2).forEach((l, j) => ctx.fillText(l, n.x, n.y + n.r + 11 + j * 10));
        continue;
      }
      ctx.font = '10.5px system-ui';
      ctx.fillStyle = '#e6e8df';
      ctx.fillText(words[0], n.x, n.y + n.r + 11);
      if (words[1]) ctx.fillText(words.slice(1).join(' '), n.x, n.y + n.r + 22);
    }

    // подпись пунктира — у разложителей, поверх всего, на подложке
    ctx.font = '10px system-ui';
    ctx.textAlign = 'right';
    const lt = '↶ азот, фосфор';
    const lw = ctx.measureText(lt).width + 8;
    const lx = dA.x - dA.r - 4;
    const ly = dA.y - dA.r - 4;
    ctx.fillStyle = 'rgba(18,20,23,0.85)';
    ctx.fillRect(lx - lw + 4, ly - 10, lw, 14);
    ctx.fillStyle = '#c9a27a';
    ctx.fillText(lt, lx, ly);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(230,232,223,0.45)';
    ctx.fillText('хищники ↑', 6, 14);
  }

  private drawCharts(): void {
    const hist = this.world.history;
    const top = this.world.species.living().slice(0, 8);
    const [ctx, w, h] = this.canvasCtx($(this.root, '.s-pop'), 160);
    const n = hist.length;
    if (n > 1) {
      const max = Math.max(5, ...hist.flatMap((s) => top.map((sp) => s.counts.get(sp.id) ?? 0)));
      for (const sp of top) {
        ctx.strokeStyle = spColor(sp);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        let started = false;
        hist.forEach((s, i) => {
          const v = s.counts.get(sp.id);
          if (v === undefined) {
            started = false;
            return;
          }
          const x = (i / (n - 1)) * w;
          const y = h - 4 - (v / max) * (h - 10);
          started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          started = true;
        });
        ctx.stroke();
      }
    }
    $(this.root, '.s-legend').innerHTML = top.map((s) => `<span style="color:${spColor(s)}">● ${s.name}</span>`).join('');
    const [g, gw, gh] = this.canvasCtx($(this.root, '.s-genechart'), 140);
    const info = GENE_INFO[this.gene];
    g.fillStyle = 'rgba(230,232,223,0.4)';
    g.font = '10px system-ui';
    g.fillText(info.hi, 4, 11);
    g.fillText(info.lo, 4, gh - 4);
    if (n > 1) {
      for (const sp of top) {
        g.strokeStyle = spColor(sp);
        g.lineWidth = 1.6;
        g.beginPath();
        let started = false;
        hist.forEach((s, i) => {
          const m = s.means.get(sp.id);
          if (!m) {
            started = false;
            return;
          }
          const x = (i / (n - 1)) * gw;
          const y = gh - 4 - ((m[this.gene] - info.min) / (info.max - info.min)) * (gh - 10);
          started ? g.lineTo(x, y) : g.moveTo(x, y);
          started = true;
        });
        g.stroke();
      }
    }
  }

  // ---------------- Микромир ----------------

  private renderMicro(): void {
    this.updateCycle();
    this.drawCycle();
    this.renderGuilds();
    this.drawEpidemic();
    this.drawSoilChart();
  }

  /** Потоки круговорота сейчас и их «обычный» уровень (скользящее среднее за ~полгода). */
  private updateCycle(): void {
    const w = this.world;
    const fe = w.fluxEma;
    let graze = 0;
    for (const [k, v] of w.web) {
      const j = k.indexOf('>');
      const a = Number(k.slice(0, j));
      const b = Number(k.slice(j + 1));
      if (a > 0 && (b === 0 || b === -2 || b === -3)) graze += v;
    }
    // Растения → Животные → Туши и помёт → Разложители → Перегной и опад → Минеральные → Растения; + реки → море
    const v = [graze, fe.dungIn + fe.carrionIn, fe.corpseDecay, fe.carrionIn + fe.dungIn, fe.decomp, fe.uptake, fe.runoff];
    const c = this.cyc;
    const dt = c.tick < 0 || w.tick < c.tick ? -1 : w.tick - c.tick;
    v.forEach((x, i) => {
      if (dt < 0 || !(c.ref[i] > 0)) c.ref[i] = x;
      else c.ref[i] += (x - c.ref[i]) * Math.min(1, dt / 3000);
    });
    c.v = v;
    c.tick = w.tick;
  }

  private drawCycle(): void {
    const cv = $<HTMLCanvasElement>(this.root, '.s-cycle');
    const W = cv.clientWidth;
    if (!W) return;
    const H = 252;
    const dpr = window.devicePixelRatio || 1;
    if (cv.style.height !== `${H}px`) cv.style.height = `${H}px`;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const c = this.cyc;
    if (!c.v.length) this.updateCycle();
    const ratio = (i: number) => (c.ref[i] > 0 ? clamp(c.v[i] / c.ref[i], 0, 3) : 0);
    const NODES: [string, string, string][] = [
      ['🌿', 'Растения', '#4fae5b'],
      ['🐾', 'Животные', '#e0b04f'],
      ['🦴', 'Туши и помёт', '#bfb59a'],
      ['🍄', 'Разложители', '#c9a27a'],
      ['🟫', 'Перегной и опад', '#8d6a48'],
      ['⚗️', 'Минеральные вещества', '#7fc3d8'],
    ];
    const EDGE = ['поедают', 'смерть, помёт', 'гниение', 'перегной', 'минерализация', 'корни'];
    // круг — эллипс: слева остаётся место для «рек»
    const cx = W / 2 + 10;
    const cy = 126;
    const Rx = Math.min(W / 2 - 74, 112);
    const Ry = 86;
    const r = 16;
    const ang = (k: number) => -Math.PI / 2 + (k * Math.PI) / 3;
    const px = (a: number, f = 1) => cx + Math.cos(a) * Rx * f;
    const py = (a: number, f = 1) => cy + Math.sin(a) * Ry * f;
    const step = this.speed > 0 && !this.modalOpen ? 1 : 0;
    const d = (r + 5) / ((Rx + Ry) / 2);
    // стрелки по кругу
    for (let k = 0; k < 6; k++) {
      const q = ratio(k);
      const a0 = ang(k) + d;
      const a1 = ang(k + 1) - d - 0.05;
      ctx.strokeStyle = NODES[k][2];
      ctx.globalAlpha = 0.35 + 0.4 * Math.min(1, q);
      ctx.lineWidth = 1 + 4.5 * Math.sqrt(q);
      ctx.beginPath();
      ctx.ellipse(cx, cy, Rx, Ry, 0, a0, a1);
      ctx.stroke();
      // наконечник — по касательной к эллипсу
      const ae = a1 + 0.05;
      const hx = px(ae);
      const hy = py(ae);
      const tg = Math.atan2(Math.cos(ae) * Ry, -Math.sin(ae) * Rx);
      const s = (5 + 2 * Math.sqrt(q)) * 1.6;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = NODES[k][2];
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx - Math.cos(tg - 0.5) * s, hy - Math.sin(tg - 0.5) * s);
      ctx.lineTo(hx - Math.cos(tg + 0.5) * s, hy - Math.sin(tg + 0.5) * s);
      ctx.fill();
      // бегущие точки: скорость ∝ потоку
      c.ph[k] = (c.ph[k] + step * 0.004 * Math.min(q, 2.5)) % 1;
      ctx.fillStyle = '#fff';
      for (let j = 0; j < 4; j++) {
        const t = (c.ph[k] + j / 4) % 1;
        const a = a0 + (a1 - a0) * t;
        ctx.globalAlpha = 0.75 * Math.sin(t * Math.PI) * Math.min(1, q + 0.15);
        ctx.beginPath();
        ctx.arc(px(a), py(a), 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      // подпись потока — внутри круга
      const am = (ang(k) + ang(k + 1)) / 2;
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#e6e8df';
      ctx.font = '9.5px system-ui';
      ctx.textAlign = 'center';
      const f = k === 1 || k === 4 ? 0.5 : 0.6; // горизонтальные — ближе к центру, чтобы не наезжали на дуги
      ctx.fillText(EDGE[k], px(am, f), py(am, f) + 3);
    }
    // реки уносят часть минеральных веществ в море
    const qr = ratio(6);
    const mx = px(ang(5)) - r * 0.9;
    const my = py(ang(5)) + r * 0.5;
    const ex = 30;
    const ey = cy + 4;
    ctx.globalAlpha = 0.4 + 0.4 * Math.min(1, qr);
    ctx.strokeStyle = '#5ec7e8';
    ctx.lineWidth = 1 + 3 * Math.sqrt(qr);
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.quadraticCurveTo(ex + 4, my, ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    c.ph[6] = (c.ph[6] + step * 0.006 * Math.min(qr, 2.5)) % 1;
    ctx.fillStyle = '#5ec7e8';
    for (let j = 0; j < 3; j++) {
      const t = (c.ph[6] + j / 3) % 1;
      const u = 1 - t;
      ctx.globalAlpha = 0.8 * Math.sin(t * Math.PI) * Math.min(1, qr + 0.15);
      ctx.beginPath();
      ctx.arc(u * u * mx + 2 * u * t * (ex + 4) + t * t * ex, u * u * my + 2 * u * t * my + t * t * ey, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.95;
    ctx.font = '10.5px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('〰 реки', ex, ey + 15);
    ctx.fillText('↓', ex, ey + 27);
    ctx.fillText('🌊 планктон', ex + 4, ey + 40);
    // узлы; подписи — снаружи круга
    for (let k = 0; k < 6; k++) {
      const a = ang(k);
      const x = px(a);
      const y = py(a);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#1b1e17';
      ctx.strokeStyle = NODES[k][2];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = '15px system-ui';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(NODES[k][0], x, y + 5);
      ctx.font = '10.5px system-ui';
      ctx.fillStyle = '#e6e8df';
      const words = NODES[k][1].split(' ');
      const lines = words.length > 1 ? [words[0], words.slice(1).join(' ')] : words;
      const up = Math.sin(a) < 0;
      const y0 = up ? y - r - 6 - (lines.length - 1) * 11 : y + r + 12;
      // боковые подписи чуть наружу — чтобы не наезжали на наконечники стрелок
      const lx = x + Math.sign(Math.round(Math.cos(a) * 10)) * 13;
      lines.forEach((l, j) => ctx.fillText(l, lx, y0 + j * 11));
    }
    // в центре — сезон и как работают микробы
    const s = this.world.season;
    const q = ratio(4);
    ctx.textAlign = 'center';
    ctx.font = '20px system-ui';
    ctx.fillText(s.icon, cx, cy - 12);
    ctx.font = '10px system-ui';
    ctx.fillStyle = q > 1.15 ? '#9be37a' : q < 0.75 ? '#9ecbff' : '#8b917f';
    ctx.fillText(q > 1.15 ? 'гниёт быстрее' : q < 0.75 ? 'гниёт медленнее' : 'как обычно', cx, cy + 20);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  private renderGuilds(): void {
    const el = $(this.root, '.s-guilds');
    const w = this.world;
    const list = MICROBE_GUILDS.filter((g) => !g.show || g.show(w));
    const lens = this.renderer.lens;
    this.setHtml(
      el,
      list
        .map(
          (g) => `<div class="g-card">
          <div class="g-ic">${g.icon}</div>
          <div class="g-body"><div class="g-head"><b>${g.name}</b><a data-fact="${g.fact}" title="Научная карточка">?</a></div><div class="muted small">${g.who}</div><div class="small">${g.role}</div>
          <div class="g-foot"><span class="g-metric small"></span>${g.lens ? `<button data-glens="${g.lens === lens ? 'off' : g.lens}" class="${g.lens === lens ? 'active' : ''}">🔬 ${g.lens === lens ? 'скрыть' : 'показать'}</button>` : ''}</div></div>
        </div>`,
        )
        .join(''),
    );
    // цифры обновляем отдельно, чтобы не пересоздавать кнопки (иначе теряются клики)
    el.querySelectorAll<HTMLElement>('.g-metric').forEach((m, i) => {
      const t = list[i].metric(w);
      if (m.textContent !== t) m.textContent = t;
    });
  }

  /** Выбранная на графике болезнь: по клику, иначе самая большая из идущих, иначе последняя. */
  private epiPathogen(): Pathogen | null {
    const w = this.world;
    const all = [...w.pathogens.values(), ...w.outbreaks];
    const sel = this.epiSel !== null ? all.find((P) => P.id === this.epiSel) : undefined;
    if (sel) return sel;
    let best: Pathogen | null = null;
    for (const P of w.pathogens.values()) if (P.announced && (!best || nowSick(P) > nowSick(best))) best = P;
    if (!best) for (const P of w.pathogens.values()) if (!best || nowSick(P) > nowSick(best)) best = P;
    return best ?? w.outbreaks[w.outbreaks.length - 1] ?? null;
  }

  private drawEpidemic(): void {
    const w = this.world;
    const [ctx, cw, ch] = this.canvasCtx($(this.root, '.s-epi'), 160);
    const P = this.epiPathogen();
    ctx.font = '11px system-ui';
    if (!P || P.curve.length < 2) {
      ctx.fillStyle = 'rgba(230,232,223,0.5)';
      ctx.textAlign = 'center';
      ctx.fillText(P ? `«${P.name}» только началась…` : 'Пока все здоровы. Болезни вспыхивают в тесных стадах —', cw / 2, ch / 2 - 4);
      if (!P) ctx.fillText('или нажмите 🦠, чтобы запустить новую.', cw / 2, ch / 2 + 12);
      ctx.textAlign = 'left';
    } else {
      const n = P.curve.length;
      const L = 4;
      const Rr = cw - 30;
      const top = 42;
      const bot = ch - 16;
      const max = Math.max(5, ...P.curve);
      const X = (i: number) => L + (i / (n - 1)) * (Rr - L);
      const Y = (v: number) => bot - (v / max) * (bot - top);
      ctx.fillStyle = 'rgba(255,107,91,0.32)';
      ctx.strokeStyle = '#ff6b5b';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(X(0), bot);
      P.curve.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
      ctx.lineTo(X(n - 1), bot);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      P.curve.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
      ctx.stroke();
      // вирулентность — правая ось 0..100%
      const V = (v: number) => bot - v * (bot - top);
      ctx.strokeStyle = 'rgba(255,184,107,0.45)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L, V(P.vir0));
      ctx.lineTo(Rr, V(P.vir0));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#ffb86b';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      P.virCurve.forEach((v, i) => (i ? ctx.lineTo(X(i), V(v)) : ctx.moveTo(X(i), V(v))));
      ctx.stroke();
      ctx.font = '10px system-ui';
      ctx.fillStyle = '#ffb86b';
      ctx.textAlign = 'right';
      ctx.fillText('100%', cw - 2, top + 4);
      ctx.fillText('0', cw - 2, bot);
      ctx.fillText('вирул.', cw - 2, (top + bot) / 2 + 3);
      ctx.fillStyle = '#ff8a7a';
      ctx.textAlign = 'right';
      ctx.fillText(`больных до ${max}`, cw - 2, 15);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(230,232,223,0.5)';
      const t1 = P.ended ?? w.tick;
      ctx.fillText(`д.${Math.floor(Math.max(P.born, t1 - (n - 1) * 20) / DAY)}`, L, ch - 3);
      ctx.textAlign = 'right';
      ctx.fillText(P.ended === null ? 'сейчас' : `д.${Math.floor(P.ended / DAY)}`, Rr, ch - 3);
    }
    if (P) {
      // крупная подпись: растёт или затухает
      ctx.textAlign = 'left';
      ctx.font = 'bold 15px system-ui';
      const grow = P.rEff >= 1;
      ctx.fillStyle = P.ended !== null ? '#9be37a' : grow ? '#ff6b5b' : '#9be37a';
      ctx.fillText(P.ended !== null ? '✔ отступила' : `R ≈ ${P.rEff.toFixed(1)} — ${grow ? 'растёт' : 'затухает'}`, 6, 17);
      ctx.font = '10.5px system-ui';
      ctx.fillStyle = 'rgba(230,232,223,0.7)';
      ctx.fillText(`«${P.name}» · ${w.species.all.get(P.host)?.name ?? '?'}`, 6, 30);
    }
    // список: идущие, затем последние 8 закончившихся
    const host = (P0: Pathogen) => w.species.all.get(P0.host)?.name ?? '?';
    const rows = [...[...w.pathogens.values()].sort((a, b) => nowSick(b) - nowSick(a)), ...w.outbreaks.slice(-8).reverse()];
    const el = $(this.root, '.s-outbreaks');
    this.setHtml(
      el,
      rows.length
        ? rows
            .map((Q) => {
              const dv = Q.virMean - Q.vir0;
              const tr = dv > 0.02 ? '<em class="up">▲</em>' : dv < -0.02 ? '<em class="down">▼</em>' : '';
              const live = Q.ended === null;
              return `<li data-p="${Q.id}" class="${live ? 'live' : 'done'}${P && Q.id === P.id ? ' on' : ''}"><b>${live ? '🦠' : '✔'} ${Q.name}</b> · «${host(Q)}»<br><span class="muted">${live ? `больны ${nowSick(Q)} · ` : ''}переболели ${Q.recovered} · погибли ${Q.deaths} · вирулентность ${pct(Q.virMean)} ${tr}</span></li>`;
            })
            .join('')
        : '<li class="muted">Вспышек ещё не было.</li>',
    );
  }

  private drawSoilChart(): void {
    const hist = this.world.history;
    const [ctx, w, h] = this.canvasCtx($(this.root, '.s-soilchart'), 130);
    const n = hist.length;
    const LINES: [keyof (typeof hist)[number], string, string][] = [
      ['soil', '#c9e86b', 'плодородие'],
      ['litter', '#a07a52', 'опад'],
      ['mic', '#ff7ad9', 'микробы'],
      ['plankton', '#5ec7e8', 'планктон'],
    ];
    if (n > 1) {
      const X = (i: number) => (i / (n - 1)) * w;
      // больные — фоном, по правой оси
      const smax = Math.max(5, ...hist.map((s) => s.sick));
      ctx.fillStyle = 'rgba(255,107,91,0.22)';
      ctx.beginPath();
      ctx.moveTo(0, h);
      hist.forEach((s, i) => ctx.lineTo(X(i), h - (s.sick / smax) * (h - 10)));
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
      for (const [k, col] of LINES) {
        const max = Math.max(1e-6, ...hist.map((s) => s[k] as number));
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        hist.forEach((s, i) => {
          const y = h - 4 - ((s[k] as number) / max) * (h - 12);
          i ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y);
        });
        ctx.stroke();
      }
      ctx.fillStyle = '#ff8a7a';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(`больных до ${smax}`, w - 3, 11);
      ctx.textAlign = 'left';
    }
    this.setHtml(
      $(this.root, '.s-soillegend'),
      LINES.map(([, c, l]) => `<span style="color:${c}">● ${l}</span>`).join('') + '<span style="color:#ff8a7a">▮ больные</span><span class="muted">каждая линия — от своего максимума</span>',
    );
  }

  private renderLog(): void {
    const factFor = (kind: string, text: string) =>
      kind === 'species' ? 'species' : kind === 'extinct' ? 'extinct' : kind === 'migration' && text.startsWith('🧭') ? 'migration'
        : text.includes('заглохла') ? 'r0' : text.includes('расплодились') || text.startsWith('🦠 Эпидемия') ? 'disease'
        : text.startsWith('🦠 Новая болезнь') ? 'rinderpest' : text.startsWith('🦠') ? 'sir' : text.startsWith('✔') ? 'virulence' : text.startsWith('🍄') ? 'carcass' : text.startsWith('🌊') ? 'bloom' : '';
    $(this.root, '.s-log').innerHTML = this.world.events
      .slice()
      .reverse()
      .map((e) => {
        const f = factFor(e.kind, e.text);
        return `<li class="${e.kind}" ${e.x !== undefined ? `data-x="${e.x}" data-y="${e.y}"` : ''}><span>д.${Math.floor(e.tick / DAY)}</span> ${e.text}${f ? ` <a data-fact="${f}">💡</a>` : ''}</li>`;
      })
      .join('');
  }

  // ---------------- цикл ----------------

  private loop(): void {
    requestAnimationFrame(() => this.loop());
    if (!this.active) return;
    this.applyKeys();
    const steps = this.modalOpen ? 0 : this.speed;
    for (let i = 0; i < steps; i++) this.world.step();
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const p = this.world.player;
    const target = p?.alive ? p : this.follow && this.selected?.alive ? this.selected : null;
    if (target) this.cam.follow(target.x, target.y);
    this.cam.update(w, h);
    this.renderer.draw(this.selected, this.family, this.cursor);
    this.frame++;
    if (this.frame % 3 === 0) this.renderer.drawMinimap(this.mini, w, h);
    if (this.frame % 15 === 0) {
      this.renderHud();
      this.renderPlayer();
      this.checkEvents();
      if (this.selected) {
        if (this.frame % 60 === 0) this.family = new Set(this.world.descendants(this.selected.id).map((d) => d.id));
        this.renderInspector();
      } else if (this.selectedCell !== null) this.renderInspector();
      this.renderLensCursor();
    }
    if (this.frame % 30 === 0) this.renderPanel();
    else if (this.tab === 'micro' && this.frame % 2 === 0) this.drawCycle();
  }
}
