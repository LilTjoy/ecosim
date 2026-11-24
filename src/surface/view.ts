import { clamp } from '../lib/random';
import { FIELD_ICON, type Fact } from '../planet/facts';
import { GENE_INFO, GENE_KEYS, type GeneKey, type Genome } from '../sim/genome';
import type { Species } from '../sim/species';
import { DAY, EARTH_ENV, World, type BrainMode, type Creature, type SurfaceEnv } from '../sim/world';
import { Camera } from './camera';
import { SURFACE_FACTS } from './facts';
import { SurfaceRenderer } from './renderer';

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
      <button data-act="epidemic" title="Эпидемия самого многочисленного вида">🦠</button>
      <label class="s-explain" title="Научные карточки"><input type="checkbox" checked>💡</label>
    </div>
    <div class="s-spawn" hidden></div>
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
  }

  private afterReset(): void {
    this.renderer.rebuild();
    this.selected = null;
    this.family.clear();
    this.renderer.focusSpecies = null;
    this.lastEventTick = 0;
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
    $(r, '[data-act=epidemic]').onclick = () => this.world.epidemic();
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
      if ((e.target as HTMLElement).closest('button')) $(r, '.s-fact').hidden = true;
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
      if (this.tool === 'inspect' && !this.world.player?.alive) this.select(this.world.creatureAt(wx, wy, 10 / this.cam.zoom));
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
    this.follow = false;
    this.family = new Set(c ? this.world.descendants(c.id).map((d) => d.id) : []);
    this.renderInspector();
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

  private queueFact(id: string): void {
    if (!this.explain || this.shownFacts.has(id)) return;
    this.shownFacts.add(id);
    this.showFact(id);
  }

  private showFact(id: string): void {
    const f: Fact | undefined = SURFACE_FACTS[id];
    if (!f) return;
    const el = $(this.root, '.s-fact');
    el.innerHTML = `<div class="tag">${FIELD_ICON[f.field]} ${f.field}</div><h4>${f.title}</h4><p>${f.text}</p>${
      f.earth ? `<p class="earth">🌍 ${f.earth}</p>` : ''
    }<div class="btns"><button>Понятно</button></div>`;
    el.hidden = false;
  }

  private checkEvents(): void {
    for (const e of this.world.events) {
      if (e.tick <= this.lastEventTick) continue;
      if (e.kind === 'species') this.queueFact('species');
      else if (e.kind === 'migration' && e.text.startsWith('🧭')) this.queueFact('migration');
      else if (e.kind === 'extinct') this.queueFact('extinct');
      else if (e.kind === 'disaster' && e.text.includes('расплодились')) this.queueFact('disease');
    }
    this.lastEventTick = this.world.tick;
    if (this.world.tick > 3000) this.queueFact('niche');
    if (this.world.tick > 9000) this.queueFact('cycle');
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
      <div class="muted small">Ест: ${this.dietText(c)}</div>
      <div class="genes">${genes}</div>
      <div class="muted small">Детей: ${c.children} · живых потомков: <b class="gold">${this.family.size}</b> · добыча: ${c.kills}${c.father === null && c.mother !== null ? ' · рождён без отца <a data-fact="parthenogenesis">?</a>' : ''}</div>
      <div class="btns">
        <button data-a="possess" ${c.alive ? '' : 'disabled'}>👑 Вселиться</button>
        <button data-a="follow" class="${this.follow ? 'active' : ''}">🎯 Следить</button>
      </div>`;
    this.renderer.portrait($(el, '.portrait'), c);
  }

  /** Чем питается существо — по его генам и нишам. */
  private dietText(c: Creature): string {
    const w = this.world;
    const parts: string[] = [];
    const pv = w.plantValue(c);
    if (c.g.swim > 0.5 && pv > 0.2) parts.push('водоросли');
    if (pv > 0.2 && w.grassAccess(c, w.terrain.index(c.x, c.y)) > 0.2 && c.g.swim < 0.7) parts.push('траву');
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
    }`;
    const at = this.cursor ?? [this.cam.x, this.cam.y];
    const reg = w.terrain.regionAt(at[0], at[1]);
    $(this.root, '.s-region').textContent = reg ? `📍 ${reg.name}` : '';
  }

  private renderPanel(): void {
    if (this.tab === 'species') this.renderSpecies();
    else if (this.tab === 'tree') this.drawTree();
    else if (this.tab === 'web') this.drawWeb();
    else if (this.tab === 'charts') this.drawCharts();
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
      <div class="muted small">Возник на ${Math.floor(sp.born / DAY)}-й день в «${sp.origin}»${parent ? `, предок — «${parent.name}»` : ' (основатель)'}. Освоил регионов: ${sp.regions.size}. Пик численности: ${sp.peak}.</div>
      <div class="genes">${GENE_KEYS.map((k) => {
        const i = GENE_INFO[k];
        const v = (sp.mean[k] - i.min) / (i.max - i.min);
        return `<div class="gene" data-fact="${k}"><span>${i.label}</span><div class="gbar"><div style="width:${v * 100}%;background:${spColor(sp, 55)}"></div></div><b>?</b></div>`;
      }).join('')}</div>
      <button data-goto>📍 Показать на карте</button>
    </div>`;
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
    const [ctx, w, h] = this.canvasCtx($(this.root, '.s-web'), 420);
    type Node = { id: number; x: number; y: number; r: number; label: string; color: string };
    const nodes = new Map<number, Node>();
    nodes.set(0, { id: 0, x: w * 0.35, y: h - 24, r: 14, label: '🌿 Трава, водоросли', color: '#4fae5b' });
    nodes.set(-1, { id: -1, x: w * 0.9, y: h - 24, r: 10, label: '🦴 Падаль', color: '#bfb59a' });
    nodes.set(-2, { id: -2, x: w * 0.6, y: h - 24, r: 11, label: '🍓 Ягоды, насекомые', color: '#d85a7f' });
    nodes.set(-3, { id: -3, x: w * 0.12, y: h - 24, r: 12, label: '🌳 Листва', color: '#2f7d3a' });
    const sorted = [...living].sort((a, b) => a.mean.diet - b.mean.diet);
    sorted.forEach((s, i) => {
      const y = h - 70 - s.mean.diet * (h - 120);
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
    ctx.font = '10.5px system-ui';
    ctx.textAlign = 'center';
    for (const n of nodes.values()) {
      ctx.fillStyle = n.color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e6e8df';
      const words = n.label.split(' ');
      ctx.fillText(words[0], n.x, n.y + n.r + 11);
      if (words[1]) ctx.fillText(words.slice(1).join(' '), n.x, n.y + n.r + 22);
    }
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

  private renderLog(): void {
    const factFor = (kind: string, text: string) =>
      kind === 'species' ? 'species' : kind === 'extinct' ? 'extinct' : kind === 'migration' && text.startsWith('🧭') ? 'migration' : '';
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
      }
    }
    if (this.frame % 30 === 0) this.renderPanel();
  }
}
