// ⏪ Машина времени: действия, ветки, снимки и перемотка (без DOM — общее для страницы, стенда и воркера).
//
// Мир меняется только тремя путями: шаг симуляции, действие (World.apply) и ввод/настройки, которые Timeline
// сам записывает перед каждым шагом. Поэтому из любого снимка история повторяется до бита: восстановить снимок
// и снова приложить записанные действия и ввод в те же такты. Ветка — своя запись действий и ввода поверх
// общего начала (линии предков); снимки прореживаются по возрасту и укладываются в бюджет памяти.
import { GENE_KEYS, type Genome } from './genome';
import type { PresetBody } from './modules';
import { CLIMATE_C, DAY, guildOf, type Sample, type Settings, type World, type WorldEvent } from './world';
import { recycleSnap, snapshotProblems, type WorldSnap } from './snapshot';

// ---------------- действия ----------------

export type Action = { t: number } & (
  | { k: 'meteor'; x: number; y: number }
  | { k: 'drought' }
  | { k: 'epidemic' }
  /** Точки (x, y подряд) одного такта сливаются в одно действие. */
  | { k: 'grass'; pts: number[]; r: number }
  /** body — тело «завезённых» (♾️ краб, летун, мутант; строится в мире из его костей). */
  | { k: 'spawn'; g: Partial<Genome>; n: number; x: number; y: number; icon: string; label: string; body?: PresetBody }
  /** ♾️ Всплеск мутаций: у зверей рядом год органы потомков меняются чаще. */
  | { k: 'mutagen'; x: number; y: number }
  | { k: 'possess'; id: number | null }
  /** Записывается сам, по разнице настроек перед шагом (и «Мутации ×2/×½»). */
  | { k: 'settings'; s: Settings }
  /** Опыт уроков «без разложителей»; quiet — без записи в летопись (так же пишется разница перед шагом). */
  | { k: 'experiment'; e: { noDecomposers: boolean }; quiet?: boolean }
  | { k: 'rescue'; sp: number; n: number }
  | { k: 'remove'; sp: number }
  /** Эффект бабочки: сдвиг одной особи (без костей). */
  | { k: 'nudge'; id: number; dx: number }
  | { k: 'reseed'; salt: number }
  /** Опыты уроков: убрать корм на время / вернуть его. */
  | { k: 'resource'; kind: 'browse' | 'forage'; ticks: number }
  | { k: 'restoreRes'; kind: 'browse' | 'forage' }
  /** Климат: сдвиг температуры к target (единицы модели, 0,05 ≈ 4 °C) за ramp тактов. */
  | { k: 'climate'; target: number; ramp: number }
  /** Только подпись на шкале, не применяется. */
  | { k: 'undo'; ref: number }
);
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Действие без такта — его ставит тот, кто записывает (страница: SurfaceView.act). */
export type ActionInput = DistOmit<Action, 't'>;

/** Действия, которые можно отменить тостом «↶ Отменить». */
export const UNDOABLE: ReadonlySet<Action['k']> = new Set(['meteor', 'drought', 'epidemic', 'spawn', 'remove', 'rescue', 'mutagen']);
/** Разница, записанная машиной времени, а не поступок игрока. */
export const isDiff = (a: Action): boolean => a.k === 'settings' || (a.k === 'experiment' && !!a.quiet);

/** Компактная запись ввода игрока: 13 байт на изменение (страница пишет Math.fround — запись точная). */
export class InputLog {
  n = 0;
  t = new Int32Array(1024);
  dx = new Float32Array(1024);
  dy = new Float32Array(1024);
  run = new Uint8Array(1024);

  push(t: number, dx: number, dy: number, run: boolean): void {
    if (this.n === this.t.length) this.grow(this.n * 2);
    this.t[this.n] = t;
    this.dx[this.n] = dx;
    this.dy[this.n] = dy;
    this.run[this.n] = run ? 1 : 0;
    this.n++;
  }

  truncate(n: number): void {
    this.n = Math.max(0, Math.min(this.n, n));
  }

  get bytes(): number {
    return this.t.length * 13;
  }

  private grow(m: number): void {
    const t = new Int32Array(m), dx = new Float32Array(m), dy = new Float32Array(m), run = new Uint8Array(m);
    t.set(this.t);
    dx.set(this.dx);
    dy.set(this.dy);
    run.set(this.run);
    Object.assign(this, { t, dx, dy, run });
  }
}

// ---------------- данные шкалы ----------------

export interface SeriesRow {
  t: number;
  n: number;
  g: [number, number, number, number];
  live: number;
  /** species.peekNextId — виды с id ≥ nx родились позже. */
  nx: number;
  /** Виды с численностью ≥ 3 (до 40, по убыванию). */
  ids: Int32Array;
  cnt: Int32Array;
  /** Средние гены 8 самых многочисленных (8 × GENE_KEYS.length). */
  mean: Float32Array;
  /** Числа из записи истории этого такта (трава, почва, больные…). */
  x: Record<string, number>;
}
export interface Mark {
  t: number;
  text: string;
  kind: WorldEvent['kind'] | 'guild';
  x?: number;
  y?: number;
  icon: string;
  major: boolean;
  /** Номер действия в линии ветки (для «за миг до» и отмены). */
  act?: number;
}
export type SnapKind = 'root' | 'auto' | 'pre' | 'event' | 'head' | 'book';
export interface SnapMeta {
  id: number;
  branch: number;
  tick: number;
  kind: SnapKind;
  label?: string;
  snap: WorldSnap;
  forks: Set<number>;
}
export interface Branch {
  id: number;
  letter: string;
  name: string;
  color: string;
  icon: string;
  parent: number | null;
  forkTick: number;
  forkSnap: number | null;
  /** Курсоры линии предка в точке развилки: действия [0, parentActN) и ввод [0, parentInN) — общие. */
  parentActN: number;
  parentInN: number;
  /** species.peekNextId в момент развилки: виды с меньшим id — общие у веток. */
  nxFork: number;
  intervention: Action | null;
  actions: Action[];
  input: InputLog;
  /** Запись «без этого действия»: остальные действия и ввод, которые ветка повторит сама. */
  scheduled: Action[] | null;
  scheduledIn: InputLog | null;
  rows: SeriesRow[];
  marks: Mark[];
  samples: Sample[];
  snaps: SnapMeta[];
  /** Настоящее ветки, пока она не активна (или пока мы в её прошлом). */
  head: SnapMeta | null;
  headTick: number;
  /** Запись полная: «Как было» повторит историю точно. */
  exact: boolean;
  /** Ветка считается в фоне: задание, цель, откуда начали и докуда дошли. */
  bg: null | { job: number; target: number; from: number; tick: number };
  /** Имена и цвета видов, которых ветка видела в рядах (для сравнения: у другой ветки свой реестр видов). */
  names: Map<number, { name: string; hue: number }>;
  // служебное
  schedA: number;
  schedI: number;
  gPrev: number[];
  gMark: number[];
  gGone: boolean[];
  sampleBytes: number;
  sThin: number;
  rThin: number;
}

export const BRANCH_LETTERS = 'АБВГДЕЖЗИКЛМ';
export const BRANCH_COLORS = ['#e8c547', '#56b4e9', '#e5735c', '#7ccf7a', '#c58be8', '#f0a04b', '#4fd1c5', '#e86fae'];
export const GUILD = [
  { icon: '🌿', name: 'травоядные', gen: 'травоядных', back: 'Травоядные вернулись', color: '#5fb85a' },
  { icon: '🍽', name: 'всеядные', gen: 'всеядных', back: 'Всеядные вернулись', color: '#d9a441' },
  { icon: '🍖', name: 'хищники', gen: 'хищников', back: 'Хищники вернулись', color: '#e0584f' },
  { icon: '🐟', name: 'пловцы', gen: 'пловцов', back: 'Пловцы вернулись', color: '#4fa3e0' },
];
export const TM = {
  SNAP_EVERY: 300, ROW_EVERY: 100, MAX_BYTES: 48 << 20, MAX_BYTES_SMALL: 24 << 20, MAX_BRANCHES: 12,
  PRE_KEEP: 8, PRE_KEEP_SMALL: 4, MAX_SNAPS: 40, PRE_REUSE: 100, EVENT_KEEP: 8, UNDO_WINDOW: 1200, MARKS_CAP: 5000,
  ACTIONS_CAP: 50_000, INPUT_CAP: 1_000_000, RESIM_MAX: 600, RESIM_BUDGET_MS: 20, HIST_FULL: 18_000, HIST_EVERY: 100,
  /** Телефон: давние записи истории и ряды шкалы реже (иначе за 200 000 тактов они съедают половину 24 МБ). */
  HIST_EVERY_SMALL: 500, ROW_EVERY_OLD_SMALL: 500,
  /** Фон (воркер): снимок ветки раз в BG_SNAP тактов; «параллельная вселенная» — не дальше FOLLOW_AHEAD от живой ветки. */
  BG_SNAP: 3000, FOLLOW_AHEAD: 600, FOLLOW_CHUNK: 1200,
};

type Tier = { age: number; every: number };
export const TIERS: Tier[] = [{ age: 3000, every: 300 }, { age: 30000, every: 3000 }, { age: Infinity, every: 12000 }];
export const TIERS_SMALL: Tier[] = [{ age: 1200, every: 300 }, { age: 12000, every: 3000 }, { age: Infinity, every: 24000 }];
export const IDLE: Tier[] = [{ age: Infinity, every: 6000 }];
/** Оставить ли авто-снимок такта `tick` сейчас. Ярусы вложены: выброшенный однажды больше не понадобится. */
export const keepAuto = (tick: number, now: number, tiers: Tier[]): boolean => {
  const a = now - tick;
  for (const T of tiers) if (a <= T.age) return tick % T.every === 0;
  return false;
};

// ---------------- общие для страницы и воркера ----------------

/** Строка ряда шкалы: численности гильдий и видов в такт t (между шагами). */
export function rowOf(w: World): SeriesRow {
  const g: [number, number, number, number] = [0, 0, 0, 0];
  for (const c of w.creatures) g[guildOf(c.g)]++;
  const live = w.species.living();
  const top = live.filter((s) => s.count >= 3).slice(0, 40);
  const K = GENE_KEYS.length;
  const mean = new Float32Array(8 * K);
  for (let i = 0; i < Math.min(8, live.length); i++) for (let k = 0; k < K; k++) mean[i * K + k] = live[i].mean[GENE_KEYS[k]];
  const x: Record<string, number> = {};
  const h = w.history.at(-1);
  if (h && h.tick === w.tick) for (const [k, v] of Object.entries(h)) if (k !== 'tick' && typeof v === 'number') x[k] = v;
  return {
    t: w.tick, n: w.creatures.length, g, live: live.length, nx: w.species.peekNextId,
    ids: Int32Array.from(top, (s) => s.id), cnt: Int32Array.from(top, (s) => s.count), mean, x,
  };
}

const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})️?(?:‍\p{Extended_Pictographic}️?)*/u;
export const iconOf = (text: string): string => EMOJI.exec(text)?.[0] ?? '•';

/** Отметка шкалы по записи летописи. Крупные: стихии, поступки игрока, вымирание вида с пиком ≥ 30. */
export function eventMark(e: WorldEvent, act?: number): Mark {
  const peak = e.kind === 'extinct' ? Number(/на пике было (\d+)/.exec(e.text)?.[1] ?? 0) : 0;
  return { t: e.tick, text: e.text, kind: e.kind, x: e.x, y: e.y, icon: iconOf(e.text), major: e.kind === 'disaster' || e.kind === 'player' || peak >= 30, act };
}

/** Сколько последних записей летописи сделано в такт t. */
export function trailing(ev: WorldEvent[], t: number): number {
  let n = 0;
  for (let i = ev.length - 1; i >= 0 && ev[i].tick === t; i--) n++;
  return n;
}

const sampleBytes = (s: Sample) => 64 + 300 * s.counts.size;

/** Отметки шкалы за действие, только что приложенное к миру (k0 — trailing до него): его записи летописи или подпись. */
export function actMarks(w: World, a: Action, idx: number, k0: number): Mark[] {
  const k1 = trailing(w.events, w.tick);
  const out: Mark[] = [];
  for (let i = w.events.length - Math.max(0, k1 - k0); i < w.events.length; i++) out.push(eventMark(w.events[i], idx));
  if (k1 <= k0 && !isDiff(a) && a.k !== 'undo') {
    const text = actionText(a);
    out.push({ t: a.t, text, kind: 'player', icon: iconOf(text), major: a.k === 'reseed' || a.k === 'nudge', act: idx });
  }
  return out;
}

/** Отметки за шаг: записи летописи этого такта. */
export function stepMarks(w: World): Mark[] {
  const n = trailing(w.events, w.tick);
  const out: Mark[] = [];
  for (let i = w.events.length - n; i < w.events.length; i++) out.push(eventMark(w.events[i]));
  return out;
}

/** Ввод для воркера: типизированные массивы ровно по длине записи. */
export interface InputArrays { t: Int32Array; dx: Float32Array; dy: Float32Array; run: Uint8Array }
export const inputArrays = (L: InputLog): InputArrays => ({ t: L.t.slice(0, L.n), dx: L.dx.slice(0, L.n), dy: L.dy.slice(0, L.n), run: L.run.slice(0, L.n) });

/** Что нужно воркеру, чтобы продолжить или пересчитать ветку: снимок, действия и ввод (сквозные номера с actBase/inBase). */
export interface BgSpec { snap: WorldSnap; acts: Action[]; actBase: number; input: InputLog; inBase: number; until: number }
/** Начало опыта (плёнка жизни, бабочка): точка линии, откуда считают миры. */
export interface ExpStart {
  tick: number;
  cur: [number, number];
  /** Ветка, которой принадлежит точка; meta — снимок линии в этой точке (если есть). */
  owner: number;
  meta: SnapMeta | null;
  snap: WorldSnap;
  /** species.peekNextId в этой точке. */
  nx: number;
}
/** Посчитанный в воркере мир, который становится веткой. */
export interface Adopted {
  acts: Action[];
  applied: number;
  input: InputLog;
  inApplied: number;
  head: WorldSnap;
  rows: SeriesRow[];
  marks: Mark[];
  names: [number, string, number][];
  name: string;
  icon: string;
  intervention: Action;
}

/** Подпись действия для отметки и отмены. */
export function actionText(a: Action): string {
  switch (a.k) {
    case 'meteor': return '☄️ метеорит';
    case 'drought': return '🔥 засуха';
    case 'epidemic': return '🦠 эпидемия';
    case 'grass': return '🌱 трава';
    case 'spawn': return `${a.icon} «${a.label}»`;
    case 'mutagen': return '☢️ всплеск мутаций';
    case 'possess': return a.id === null ? '👑 вы покинули особь' : `👑 вселение в #${a.id}`;
    case 'settings': return '🧪 настройки';
    case 'experiment': return '🧫 опыт';
    case 'rescue': return '🧬 спасение вида';
    case 'remove': return '🚫 вид убран';
    case 'nudge': return '🦋 взмах бабочки';
    case 'reseed': return '🎲 новый случай';
    case 'resource': return '🍂 корм убран';
    case 'restoreRes': return '🌿 корм возвращён';
    case 'climate': return a.target > 0 ? '🌡 потепление' : a.target < 0 ? '❄️ похолодание' : '🌡 климат как был';
    case 'undo': return '↶ отмена';
  }
}

/** Имя и значок ветки по вмешательству (§3.7). `without` — ветка «что если бы этого не было». */
/** prev — настройки мира до вмешательства (имя «Мутации ×2/×½» — по отношению к ним). */
export function branchName(a: Action | null, tick: number, without = false, past = true, spName?: string, prev?: Settings): { name: string; icon: string } {
  const d = Math.floor(tick / DAY);
  if (!a) return { name: `Что если: я вмешался (день ${d})`, icon: '🌿' };
  if (without) {
    if (a.k === 'meteor') return { name: 'Без метеорита', icon: '☄️✕' };
    if (a.k === 'drought') return { name: 'Без засухи', icon: '🔥✕' };
    if (a.k === 'epidemic') return { name: 'Без эпидемии', icon: '🦠✕' };
    if (a.k === 'spawn') return { name: `Без «${a.label}»`, icon: '✕' };
    return { name: `Без: ${actionText(a)}`, icon: '✕' };
  }
  switch (a.k) {
    case 'reseed': return { name: `Новый случай (день ${d})`, icon: '🎲' };
    case 'nudge': return { name: 'Взмах бабочки', icon: '🦋' };
    case 'spawn': return { name: `+ ${a.label} (день ${d})`, icon: a.icon };
    case 'meteor': return { name: past ? `Что если: метеорит, день ${d}` : `Метеорит, день ${d}`, icon: '☄️' };
    case 'drought': return { name: past ? `Что если: засуха, день ${d}` : `Засуха, день ${d}`, icon: '🔥' };
    case 'epidemic': return { name: past ? `Что если: эпидемия, день ${d}` : `Эпидемия, день ${d}`, icon: '🦠' };
    case 'rescue': return { name: `Спасти «${spName ?? '?'}»`, icon: '🧬' };
    case 'remove': return { name: `Без «${spName ?? '?'}»`, icon: '🚫' };
    case 'settings': {
      const r = a.s.mutationRate / (prev?.mutationRate || 0.08);
      const x = r >= 1 ? `×${Math.round(r * 10) / 10}`.replace('.', ',') : Math.abs(r - 0.5) < 0.01 ? '×½' : `×${Math.round(r * 100) / 100}`.replace('.', ',');
      return { name: `Мутации ${x}`, icon: '🧪' };
    }
    case 'climate': {
      const c = Math.round(a.target * CLIMATE_C);
      return c > 0 ? { name: `Потепление +${c} °C`, icon: '🌡' } : c < 0 ? { name: `Похолодание −${-c} °C`, icon: '❄️' } : { name: 'Климат как был', icon: '🌡' };
    }
    case 'possess': return { name: `Что если: я вмешался (день ${d})`, icon: '👑' };
    case 'grass': return { name: `Что если: я вмешался (день ${d})`, icon: '🌱' };
    default: return { name: `Что если: я вмешался (день ${d})`, icon: '🌿' };
  }
}

// ---------------- машина времени ----------------

interface Play {
  kind: 'seek' | 'asWas';
  until: number;
  /** В такт `until` приложить только действия с номером < stopBefore. */
  stopBefore: number;
  then?: (w: World) => void;
  guards: SnapMeta[];
  gi: number;
}

export type DropWhy = 'tier' | 'budget' | 'undo' | 'delete';
export interface TimelineStats {
  captures: number;
  captureMs: number[];
  guardChecks: number;
  desyncs: number;
  dropped: { tier: number; budget: number; undo: number; delete: number };
  lastReplay: null | 'same' | 'diverged';
}

export class Timeline {
  branches: Branch[] = [];
  active!: Branch;
  /** Мы в прошлом активной ветки (мир заморожен, пока не идёт пересчёт). cursor — курсоры линии в этой точке. */
  visiting: { tick: number; snap: SnapMeta | null } | null = null;
  /** Курсоры линии активной ветки в прошлом: [действия, ввод]. */
  cur: [number, number] = [0, 0];
  play: Play | null = null;
  /** Новая часть мира не сохраняется в снимок — машина времени выключена (мир идёт как обычно). */
  disabled = false;
  /** Телефон или мало памяти: бюджет 24 МБ, короче ярусы. */
  small = false;
  /** Ловушка: системная случайность (не кости мира) вокруг шага и действий бросает исключение (dev-сборка, стенд). */
  trap = false;
  /** Поднять шаг снимков до 600 тактов, если снимок дольше 12 мс (p95). */
  autoRaise = false;
  snapEvery = TM.SNAP_EVERY;
  onToast: (text: string) => void = () => {};
  /** «Как было» дошёл до настоящего: same — до бита то же. */
  onReplayEnd: ((same: boolean) => void) | null = null;
  /** Идёт урок: шкала заблокирована (в прошлое и на новые ветки нельзя), запись продолжается. */
  locked = false;
  /** Счётчик восстановлений мира из снимка (страница по нему обновляет выбор, панели и шкалу). */
  restores = 0;
  onDrop: ((s: SnapMeta, why: DropWhy) => void) | null = null;
  /** «Параллельная вселенная»: ветка, которая идёт дальше в фоне (воркер), пока игрок в её потомке. */
  follow: number | null = null;
  /** После развилки в настоящем предок идёт дальше в фоне («Сравнивать с основной веткой»). */
  followOnFork = true;
  stats: TimelineStats = { captures: 0, captureMs: [], guardChecks: 0, desyncs: 0, dropped: { tier: 0, budget: 0, undo: 0, delete: 0 }, lastReplay: null };
  private seq = 0;
  private bseq = 0;
  private base = { dx: 0, dy: 0, run: false, set: '', exp: '' };
  private full = false;
  /** Последнее действие — мазок травы, в который ещё можно дописывать точки этого такта (после снимка — нельзя). */
  private grassOpen: Action | null = null;

  get replaying(): boolean {
    return this.play !== null;
  }
  /** Что за пересчёт идёт: точный переход (seek) или «Как было» до настоящего (asWas). */
  get replayKind(): Play['kind'] | null {
    return this.play?.kind ?? null;
  }

  /** Урок: заблокировать шкалу (из прошлого — сначала в настоящее). */
  lock(w: World): void {
    if (this.visiting || this.play) this.toPresent(w);
    this.locked = true;
  }
  unlock(): void {
    this.locked = false;
  }
  /** Что можно делать во время урока, если вдруг мы в прошлом (страница туда не пускает): только опыты урока. */
  lessonAllowed(k: Action['k']): boolean {
    return k === 'resource' || k === 'restoreRes' || k === 'experiment' || k === 'epidemic';
  }

  get maxBytes(): number {
    return this.small ? TM.MAX_BYTES_SMALL : TM.MAX_BYTES;
  }

  // ---------------- линия ветки ----------------

  branch(id: number): Branch {
    const b = this.branches.find((x) => x.id === id);
    if (!b) throw new Error(`нет ветки ${id}`);
    return b;
  }
  parentOf(b: Branch): Branch | null {
    return b.parent === null ? null : this.branch(b.parent);
  }
  /** Предки от корня до самой ветки. */
  lineage(b: Branch): Branch[] {
    const out: Branch[] = [];
    for (let x: Branch | null = b; x; x = this.parentOf(x)) out.unshift(x);
    return out;
  }
  private aOff = (b: Branch) => (b.parent === null ? 0 : b.parentActN);
  private iOff = (b: Branch) => (b.parent === null ? 0 : b.parentInN);
  actLen(b: Branch = this.active): number {
    return this.aOff(b) + b.actions.length;
  }
  inLen(b: Branch = this.active): number {
    return this.iOff(b) + b.input.n;
  }
  /** Действие линии ветки по сквозному номеру. */
  actAt(b: Branch, g: number): Action {
    let x = b;
    while (g < this.aOff(x)) x = this.parentOf(x)!;
    return x.actions[g - this.aOff(x)];
  }
  private inAt(b: Branch, g: number): [InputLog, number] {
    let x = b;
    while (g < this.iOff(x)) x = this.parentOf(x)!;
    return [x.input, g - this.iOff(x)];
  }

  /** Предок ветки и потомок на пути к ней: элементы предка, которые ещё общие (до развилки включительно). */
  private portions<T>(b: Branch, pick: (x: Branch) => T[], keep: (item: T, child: Branch) => boolean): T[] {
    const L = this.lineage(b);
    const out: T[] = [];
    for (let i = 0; i < L.length; i++) {
      const child = L[i + 1];
      for (const it of pick(L[i])) if (!child || keep(it, child)) out.push(it);
    }
    return out;
  }
  lineageSnaps(b: Branch = this.active): SnapMeta[] {
    return this.portions(b, (x) => x.snaps, (s, c) => s.tick < c.forkTick || (s.tick === c.forkTick && s.snap.actN <= c.parentActN && s.snap.inN <= c.parentInN));
  }
  lineageRows(b: Branch = this.active): SeriesRow[] {
    return this.portions(b, (x) => x.rows, (r, c) => r.t <= c.forkTick);
  }
  lineageMarks(b: Branch = this.active): Mark[] {
    return this.portions(b, (x) => x.marks, (m, c) => m.t < c.forkTick || (m.t === c.forkTick && (m.act === undefined || m.act < c.parentActN)));
  }
  lineageSamples(b: Branch = this.active): Sample[] {
    return this.portions(b, (x) => x.samples, (s, c) => s.tick <= c.forkTick);
  }
  /** Графики для мира в такт t: записи линии до t (последние 900; давние — прорежены). */
  lineageHistory(b: Branch, t: number): Sample[] {
    const all = this.lineageSamples(b);
    let n = all.length;
    while (n > 0 && all[n - 1].tick > t) n--;
    return all.slice(Math.max(0, n - 900), n);
  }
  /** Ближайший снимок линии не позже (tick, номер действия stopBefore). */
  nearestSnap(b: Branch, tick: number, stopBefore = Infinity): SnapMeta | null {
    let best: SnapMeta | null = null;
    for (const s of this.lineageSnaps(b)) if (s.tick < tick || (s.tick === tick && s.snap.actN <= stopBefore)) best = s;
    return best;
  }
  /** Сквозной номер последнего действия ветки, которое можно отменить (−1 — нет). */
  lastUndoable(b: Branch = this.active): number {
    for (let i = b.actions.length - 1; i >= 0; i--) if (UNDOABLE.has(b.actions[i].k)) return this.aOff(b) + i;
    return -1;
  }

  // ---------------- начало, шаг, запись ----------------

  /** Новый мир: одна ветка А «Основная история» и корневой снимок. */
  reset(w: World): void {
    for (const b of this.branches) {
      for (const s of b.snaps) recycleSnap(s.snap);
      if (b.head && b.head.kind === 'head') recycleSnap(b.head.snap);
    }
    this.branches = [];
    this.visiting = null;
    this.play = null;
    this.follow = null;
    this.full = false;
    this.bseq = 0;
    this.snapEvery = TM.SNAP_EVERY;
    this.stats.captureMs = [];
    const b = this.newBranch(null, w.tick, 0, 0, w.species.peekNextId, null);
    b.name = 'Основная история';
    b.icon = '🌍';
    this.active = b;
    this.resetBase(w);
    b.gPrev = rowOf(w).g;
    for (const h of w.history) this.pushSample(b, h);
    this.disabled = snapshotProblems().length > 0;
    if (!this.disabled) this.insertSnap(b, this.capture(w, 'root', [0, 0]));
  }

  /**
   * Мир открыт из закладки (уже восстановлен в w): новая история с корнем в этой точке. Ряды и крупные отметки
   * закладки — её предыстория на шкале (номера действий у отметок снимаются: тех действий в новой линии нет).
   */
  fromBook(w: World, name: string, rows: SeriesRow[], marks: Mark[], names: [number, string, number][]): void {
    this.reset(w);
    const b = this.active;
    b.name = `Закладка «${name}»`;
    b.icon = '📌';
    b.rows = rows.filter((r) => r.t <= w.tick);
    b.marks = marks.filter((m) => m.t <= w.tick).map((m) => {
      const { act: _act, ...rest } = m;
      return rest;
    });
    for (const [id, nm, hue] of names) b.names.set(id, { name: nm, hue });
    for (let g = 0; g < 4; g++) b.gGone[g] = b.gPrev[g] === 0 && b.rows.some((r) => r.g[g] > 0);
  }

  /** Один шаг мира (единственное, что вызывают страница и стенд). В прошлом без пересчёта мир стоит. */
  step(w: World): void {
    if (this.play) {
      this.advance(w, 0);
      return;
    }
    if (this.visiting) return;
    if (this.disabled) {
      this.trapped(() => w.step());
      return;
    }
    this.runScheduled(w);
    this.diff(w);
    this.trapped(() => w.step());
    this.afterStep(w);
  }

  /**
   * Записать поступок (и приложить его к миру). В прошлом это развилка — новая ветка.
   * apply = false — изменение уже сделано (разница настроек).
   */
  record(w: World, a: Action, apply = true): void {
    if (this.visiting || this.play) {
      this.forkHere(w, a);
      return;
    }
    if (this.disabled) {
      if (apply) this.trapped(() => w.apply(a));
      return;
    }
    if (!isDiff(a)) this.flush(w);
    const b = this.active;
    const last = b.actions.at(-1);
    // мазок травы того же такта дописывается в прошлое действие, только пока его конец не вошёл в снимок или развилку
    if (a.k === 'grass' && last && last.k === 'grass' && last.t === a.t && last.r === a.r && this.grassOpen === last) {
      if (apply) this.trapped(() => w.apply(a));
      last.pts.push(...a.pts);
      return;
    }
    const idx = this.actLen(b);
    if (!isDiff(a)) this.preAnchor(w, b, idx, iconOf(actionText(a)));
    const k0 = trailing(w.events, w.tick);
    if (apply) this.trapped(() => w.apply(a));
    for (const m of actMarks(w, a, idx, k0)) this.addMark(b, m);
    b.actions.push(a);
    this.grassOpen = a.k === 'grass' ? a : null;
    if (a.k === 'settings') this.base.set = JSON.stringify(w.settings);
    if (a.k === 'experiment') this.base.exp = JSON.stringify(w.experiment);
    if (this.actLen(b) > TM.ACTIONS_CAP) b.exact = false;
  }

  /** Пересчёт (перемотка вперёд по записи) — шаги, пока не кончится бюджет времени кадра (или maxSteps шагов). */
  advance(w: World, budgetMs = TM.RESIM_BUDGET_MS, maxSteps = Infinity): void {
    const t0 = performance.now();
    for (let n = 0; this.play && n < maxSteps; n++) {
      const p = this.play;
      if (w.tick >= p.until) {
        this.arrive(w);
        break;
      }
      this.replayActs(w, Infinity);
      if (this.play !== p) break; // расхождение
      this.replayInput(w);
      this.trapped(() => w.step());
      this.guard(w);
      if (performance.now() - t0 >= budgetMs) break;
    }
  }

  /** Довести пересчёт до конца (стенд, отмена). */
  finish(w: World): void {
    this.advance(w, Infinity);
  }

  // ---------------- прошлое ----------------

  /** Встать в снимок прошлого (только для чтения, пока не вмешались). */
  visit(w: World, s: SnapMeta): void {
    if (this.disabled || this.locked) return;
    this.restores++;
    if (!this.visiting && !this.play) {
      this.flush(w);
      this.captureHead(w);
    }
    this.play = null;
    w.loadState(s.snap, this.lineageHistory(this.active, s.tick));
    this.visiting = { tick: s.tick, snap: s };
    this.cur = [s.snap.actN, s.snap.inN];
    this.resetBase(w);
  }

  /**
   * Точный переход: ближайший снимок линии и пересчёт до такта `tick`, где приложены только действия
   * с номером < stopBefore («за миг до» действия). Дальше RESIM_MAX от снимка — встаём в сам снимок (false).
   * Пересчёт идёт в advance() (страница — по бюджету кадра); then — когда дошли точно.
   */
  seekExact(w: World, tick: number, stopBefore = Infinity, then?: (w: World) => void): boolean {
    const s = this.nearestSnap(this.active, tick, stopBefore);
    if (!s || this.disabled || this.locked) return false;
    this.visit(w, s);
    if (tick - s.tick > TM.RESIM_MAX) return false; // слишком далеко от снимка: стоим в нём (then не зовём)
    this.startPlay(w, 'seek', tick, stopBefore, then);
    return true;
  }

  /** ▶ «Как было (те же кости)»: из прошлого — по записи до настоящего ветки, без новой ветки. */
  asWas(w: World): boolean {
    const h = this.active.head;
    if (!this.visiting || !h || !this.active.exact || this.disabled || this.locked) return false;
    this.startPlay(w, 'asWas', h.tick, h.snap.actN);
    return true;
  }

  /** ⏭ В настоящее ветки. */
  toPresent(w: World): void {
    const h = this.active.head;
    if ((!this.visiting && !this.play) || !h) return;
    this.play = null;
    this.restores++;
    w.loadState(h.snap, this.lineageHistory(this.active, h.tick));
    this.visiting = null;
    this.releaseHead(this.active);
    this.resetBase(w);
  }

  // ---------------- ветки ----------------

  /** Развилка здесь: в прошлом — в посещённой точке, иначе в настоящем. intervention — первое действие новой ветки. */
  forkHere(w: World, intervention: Action | null, name?: { name: string; icon: string }): Branch | null {
    if (this.disabled) {
      if (intervention) this.trapped(() => w.apply(intervention));
      return null;
    }
    if (this.branches.length >= TM.MAX_BRANCHES) {
      this.onToast('Слишком много веток — удалите ненужные во вкладке ⏳');
      return null;
    }
    if (!this.visiting && !this.play) this.flush(w);
    this.play = null;
    const T = w.tick;
    const past = !!this.visiting;
    const cur: [number, number] = past ? [this.cur[0], this.cur[1]] : [this.actLen(), this.inLen()];
    const owner = this.ownerOf(T, cur);
    let s = this.lineageSnaps().find((x) => x.tick === T && x.snap.actN === cur[0] && x.snap.inN === cur[1]) ?? null;
    if (!s) {
      s = this.capture(w, 'pre', cur, owner);
      this.insertSnap(owner, s);
    } else if (s.kind === 'auto' || s.kind === 'event') s.kind = 'pre';
    if (!past) {
      this.releaseHead(this.active);
      this.active.head = s;
      this.active.headTick = T;
      if (this.followOnFork) this.follow = this.active.id;
    }
    const b = this.newBranch(owner.id, T, cur[0], cur[1], w.species.peekNextId, intervention);
    b.forkSnap = s.id;
    s.forks.add(b.id);
    const sp = intervention && (intervention.k === 'rescue' || intervention.k === 'remove') ? w.species.all.get(intervention.sp)?.name : undefined;
    Object.assign(b, name ?? branchName(intervention, T, false, past, sp, w.settings));
    this.active = b;
    this.visiting = null;
    this.resetBase(w);
    b.gPrev = rowOf(w).g;
    if (intervention) this.record(w, intervention);
    this.thin();
    return b;
  }

  /**
   * ✕ «Что если бы этого не было?»: точно встать за миг до действия ref и пустить новую ветку без него;
   * остальные действия (или только настройки, withActions = false) и весь ввод после — ветка повторит сама.
   * Удаление действия на костях мира (эпидемия) сдвигает и дальнейшие кости мира (мигранты); кости особей — те же.
   */
  forkWithout(w: World, ref: number, withActions = true, then?: (b: Branch | null) => void): boolean {
    const A = this.active;
    if (this.disabled || this.locked || ref < 0 || ref >= this.actLen(A)) return false;
    const a = this.actAt(A, ref);
    const sched: Action[] = [];
    for (let i = ref + 1; i < this.actLen(A); i++) {
      const x = this.actAt(A, i);
      if (x.k !== 'undo' && (withActions || isDiff(x))) sched.push(structuredClone(x));
    }
    const IL = this.inLen(A);
    const go = (w: World) => {
      const inS = new InputLog();
      for (let j = this.cur[1]; j < IL; j++) {
        const [L, k] = this.inAt(A, j);
        inS.push(L.t[k], L.dx[k], L.dy[k], L.run[k] === 1);
      }
      const b = this.forkHere(w, null, branchName(a, a.t, true));
      if (b) {
        b.scheduled = sched;
        b.scheduledIn = inS;
        b.intervention = { k: 'undo', ref, t: a.t };
      }
      then?.(b);
    };
    if (!this.seekExact(w, a.t, ref, go)) {
      then?.(null);
      return false;
    }
    return true;
  }

  /** Перейти на другую ветку (в её настоящее). */
  switchTo(w: World, id: number): boolean {
    const t = this.branch(id);
    if (t === this.active) {
      this.toPresent(w);
      return true;
    }
    if (!t.head || t.bg || this.disabled || this.locked) return false;
    this.play = null;
    if (this.follow === t.id) this.follow = null;
    this.restores++;
    if (!this.visiting) {
      this.flush(w);
      this.captureHead(w);
    }
    const h = t.head;
    w.loadState(h.snap, this.lineageHistory(t, h.tick));
    this.active = t;
    this.visiting = null;
    this.releaseHead(t);
    this.resetBase(w);
    t.gPrev = rowOf(w).g;
    this.thin();
    return true;
  }

  /**
   * ↶ Отменить последнее действие: можно, если ему не больше UNDO_WINDOW тактов и после него от ветки
   * не отходили другие ветки. Иначе — forkWithout. История после действия стирается.
   */
  undoLast(w: World, ref = this.lastUndoable()): boolean {
    const b = this.active;
    if (this.visiting || this.play || this.disabled || this.locked || ref < this.aOff(b) || ref >= this.actLen(b)) return false;
    const a = this.actAt(b, ref), tm = a.t;
    if (w.tick - tm > TM.UNDO_WINDOW) return false;
    if (this.branches.some((x) => x.parent === b.id && (x.forkTick > tm || (x.forkTick === tm && x.parentActN > ref)))) return false;
    if (!this.seekExact(w, tm, ref)) {
      this.toPresent(w);
      return false;
    }
    this.finish(w);
    if (!this.visiting || w.tick !== tm || this.cur[0] !== ref) {
      this.toPresent(w);
      return false;
    }
    b.snaps = b.snaps.filter((s) => {
      const keep = s.tick < tm || (s.tick === tm && s.snap.actN <= ref);
      if (!keep) this.drop(s, 'undo');
      return keep;
    });
    b.rows = b.rows.filter((r) => r.t <= tm);
    b.rThin = Math.min(b.rThin, b.rows.length);
    b.samples = b.samples.filter((s) => s.tick <= tm);
    b.sampleBytes = b.samples.reduce((n, s) => n + sampleBytes(s), 0);
    b.sThin = Math.min(b.sThin, b.samples.length);
    b.marks = b.marks.filter((m) => m.t <= tm && !(m.act !== undefined && m.act >= ref));
    b.actions.length = ref - this.aOff(b);
    b.input.truncate(this.cur[1] - this.iOff(b));
    b.headTick = tm;
    this.releaseHead(b);
    this.visiting = null;
    this.resetBase(w);
    b.gPrev = rowOf(w).g;
    b.marks.push({ t: tm, text: `↶ Отменено: ${actionText(a)}`, kind: 'player', icon: '↶', major: false });
    return true;
  }

  // ---------------- фон: ветки считаются в воркере (§5) ----------------

  /** Действия линии ветки [from, to) — копии (воркеру и новой ветке). */
  lineageActsFrom(b: Branch, from: number, to = this.actLen(b)): Action[] {
    const out: Action[] = [];
    for (let i = from; i < to; i++) out.push(structuredClone(this.actAt(b, i)));
    return out;
  }

  /** Ввод линии ветки [from, to) — копия. */
  lineageInputFrom(b: Branch, from: number, to = this.inLen(b)): InputLog {
    const L = new InputLog();
    for (let j = from; j < to; j++) {
      const [log, k] = this.inAt(b, j);
      L.push(log.t[k], log.dx[k], log.dy[k], log.run[k] === 1);
    }
    return L;
  }

  /** Продолжить неактивную ветку в фоне от её головы до такта until (со своими отложенными действиями и вводом). */
  bgSpec(b: Branch, until: number): BgSpec | null {
    if (this.disabled || b === this.active || !b.head || b.bg || until <= b.headTick || !this.branches.includes(b)) return null;
    const acts = b.scheduled ? b.scheduled.slice(b.schedA).map((a) => structuredClone(a)) : [];
    const input = new InputLog();
    const L = b.scheduledIn;
    if (L) for (let j = b.schedI; j < L.n; j++) input.push(L.t[j], L.dx[j], L.dy[j], L.run[j] === 1);
    return { snap: b.head.snap, acts, actBase: this.actLen(b), input, inBase: this.inLen(b), until };
  }

  bgBegin(b: Branch, job: number, until: number): void {
    b.bg = { job, target: until, from: b.headTick, tick: b.headTick };
  }

  /** Ряды, отметки и записи истории из фона (до очередного снимка — предварительно). */
  bgProgress(b: Branch, job: number, p: { tick: number; rows: SeriesRow[]; marks: Mark[]; samples: Sample[]; names: [number, string, number][] }): void {
    if (!b.bg || b.bg.job !== job) return;
    for (const [id, name, hue] of p.names) if (!b.names.has(id)) b.names.set(id, { name, hue });
    for (const r of p.rows) {
      b.rows.push(r);
      this.guildMarks(b, r, true);
    }
    for (const m of p.marks) this.addMark(b, m);
    for (const h of p.samples) this.pushSample(b, h);
    b.bg.tick = p.tick;
  }

  /** Снимок из фона — новая голова ветки (на сетке BG_SNAP он же авто-снимок); исполненное переходит в запись ветки. */
  bgSnap(b: Branch, job: number, snap: WorldSnap): void {
    if (!b.bg || b.bg.job !== job) return;
    const nA = snap.actN - this.actLen(b);
    for (let i = 0; i < nA && b.scheduled && b.schedA < b.scheduled.length; i++) b.actions.push(b.scheduled[b.schedA++]);
    if (b.scheduled && b.schedA >= b.scheduled.length) b.scheduled = null;
    const nI = snap.inN - this.inLen(b);
    const L = b.scheduledIn;
    for (let i = 0; i < nI && L && b.schedI < L.n; i++, b.schedI++) b.input.push(L.t[b.schedI], L.dx[b.schedI], L.dy[b.schedI], L.run[b.schedI] === 1);
    if (L && b.schedI >= L.n) b.scheduledIn = null;
    const auto = snap.tick % TM.BG_SNAP === 0;
    const s: SnapMeta = { id: ++this.seq, branch: b.id, tick: snap.tick, kind: auto ? 'auto' : 'head', snap, forks: new Set() };
    this.releaseHead(b);
    if (auto) this.insertSnap(b, s);
    b.head = s;
    b.headTick = snap.tick;
    b.bg.tick = Math.max(b.bg.tick, snap.tick);
    this.thin();
  }

  /** Фон кончился или прерван: всё, что пришло после последнего снимка (головы), убрать. */
  bgEnd(b: Branch, job: number): void {
    if (!b.bg || b.bg.job !== job) return;
    b.bg = null;
    const T = b.headTick;
    if (b.rows.length && b.rows[b.rows.length - 1].t > T) {
      b.rows = b.rows.filter((r) => r.t <= T);
      b.rThin = Math.min(b.rThin, b.rows.length);
    }
    if (b.samples.length && b.samples[b.samples.length - 1].tick > T) {
      b.samples = b.samples.filter((h) => h.tick <= T);
      b.sampleBytes = b.samples.reduce((n, h) => n + sampleBytes(h), 0);
      b.sThin = Math.min(b.sThin, b.samples.length);
    }
    b.marks = b.marks.filter((m) => m.t <= T);
  }

  /**
   * 🔁 «Точно так же»: пересчитать ветку с её развилки (корень — с сотворения) её же действиями и вводом
   * до головы (у активной — до «сейчас»); digest — с чем сверить конец.
   */
  verifySpec(w: World, b: Branch): { spec: BgSpec; digest: number } | null {
    if (this.disabled || b.bg) return null;
    let tick: number, actN: number, inN: number, digest: number;
    if (b === this.active && !this.visiting && !this.play) {
      this.flush(w);
      (tick = w.tick), (actN = this.actLen(b)), (inN = this.inLen(b)), (digest = this.digestNow(w));
    } else if (b.head) {
      const h = b.head.snap;
      (tick = h.tick), (actN = h.actN), (inN = h.inN), (digest = h.digest);
    } else return null;
    const L = this.lineageSnaps(b);
    const from = b.parent === null ? L[0] : L.find((s) => s.id === b.forkSnap);
    if (!from || tick <= from.tick) return null;
    const f = from.snap;
    return { spec: { snap: f, acts: this.lineageActsFrom(b, f.actN, actN), actBase: f.actN, input: this.lineageInputFrom(b, f.inN, inN), inBase: f.inN, until: tick }, digest };
  }

  /** Начало опыта — мир сейчас (в настоящем или в посещённом прошлом). Снимок в линию не кладётся, пока мир не станет веткой. */
  expStart(w: World): ExpStart {
    this.flush(w);
    this.grassOpen = null;
    const cur: [number, number] = this.visiting ? [this.cur[0], this.cur[1]] : [this.actLen(), this.inLen()];
    const owner = this.ownerOf(w.tick, cur);
    const meta = this.lineageSnaps().find((x) => x.tick === w.tick && x.snap.actN === cur[0] && x.snap.inN === cur[1]) ?? null;
    // копия: снимок линии может быть вытеснен (и его буферы отданы в пул), пока опыт идёт или ждёт «Сделать веткой»
    let snap = meta ? structuredClone(meta.snap) : undefined;
    if (!snap) {
      snap = w.captureState();
      snap.actN = cur[0];
      snap.inN = cur[1];
    }
    return { tick: w.tick, cur, owner: owner.id, meta, snap, nx: w.species.peekNextId };
  }

  /** Начало опыта — сотворение мира (корневой снимок). */
  expRoot(): ExpStart | null {
    const R = this.branches.find((b) => b.parent === null);
    const s = R?.snaps.find((x) => x.kind === 'root');
    if (!R || !s) return null;
    return { tick: s.tick, cur: [0, 0], owner: R.id, meta: s, snap: structuredClone(s.snap), nx: R.nxFork };
  }

  /** Мир, посчитанный в воркере от начала опыта, — новая ветка (не активная). */
  adopt(st: ExpStart, r: Adopted): Branch | null {
    if (this.disabled) return null;
    if (this.branches.length >= TM.MAX_BRANCHES) {
      this.onToast('Слишком много веток — удалите ненужные во вкладке ⏳');
      return null;
    }
    const owner = this.branches.find((x) => x.id === st.owner);
    if (!owner) return null;
    let meta = st.meta && this.branches.some((x) => x.snaps.includes(st.meta!)) ? st.meta : null;
    if (!meta) {
      meta = { id: ++this.seq, branch: owner.id, tick: st.tick, kind: 'pre', snap: st.snap, forks: new Set() };
      this.insertSnap(owner, meta);
      st.meta = meta;
    } else if (meta.kind === 'auto' || meta.kind === 'event') meta.kind = 'pre';
    const b = this.newBranch(owner.id, st.tick, st.cur[0], st.cur[1], st.nx, r.intervention);
    b.exact = true;
    b.forkSnap = meta.id;
    meta.forks.add(b.id);
    b.name = r.name;
    b.icon = r.icon;
    b.actions = r.acts.slice(0, r.applied);
    const rest = r.acts.slice(r.applied);
    b.scheduled = rest.length ? rest : null;
    const L = r.input;
    for (let j = 0; j < r.inApplied; j++) b.input.push(L.t[j], L.dx[j], L.dy[j], L.run[j] === 1);
    if (r.inApplied < L.n) {
      b.scheduledIn = new InputLog();
      for (let j = r.inApplied; j < L.n; j++) b.scheduledIn.push(L.t[j], L.dx[j], L.dy[j], L.run[j] === 1);
    }
    for (const [id, name, hue] of r.names) if (!b.names.has(id)) b.names.set(id, { name, hue });
    let prev: SeriesRow | null = null;
    for (const x of this.lineageRows(owner)) if (x.t <= st.tick) prev = x;
    b.gPrev = prev ? [...prev.g] : [0, 0, 0, 0];
    for (const row of r.rows) {
      b.rows.push(row);
      this.guildMarks(b, row, true);
    }
    for (const m of r.marks) this.addMark(b, m);
    b.head = { id: ++this.seq, branch: b.id, tick: r.head.tick, kind: 'head', snap: r.head, forks: new Set() };
    b.headTick = r.head.tick;
    this.thin();
    return b;
  }

  // ---------------- память ----------------

  /** Оценка памяти: уникальные снимки + архив графиков + ряды + записи. */
  bytes(): number {
    const seen = new Set<SnapMeta>();
    let n = 0;
    for (const b of this.branches) {
      for (const s of b.snaps) if (!seen.has(s)) (seen.add(s), (n += s.snap.bytes));
      if (b.head && !seen.has(b.head)) (seen.add(b.head), (n += b.head.snap.bytes));
      n += b.sampleBytes + b.rows.length * 1024 + b.input.bytes + b.actions.length * 64 + b.marks.length * 96;
    }
    // последние 900 записей активной ветки — это и есть живые графики мира (w.history): они в памяти и без машины времени
    const S = this.active.samples;
    for (let i = Math.max(0, S.length - 900); i < S.length; i++) n -= sampleBytes(S[i]);
    return n;
  }

  /** Сколько снимков держим (уникальных). */
  snapCount(): number {
    const seen = new Set<SnapMeta>();
    for (const b of this.branches) {
      for (const s of b.snaps) seen.add(s);
      if (b.head) seen.add(b.head);
    }
    return seen.size;
  }

  /** Удалить ветку: только лист и не активную. */
  deleteBranch(id: number): boolean {
    const b = this.branches.find((x) => x.id === id);
    if (!b || b === this.active || b.parent === null || this.branches.some((x) => x.parent === id)) return false;
    if (this.follow === id) this.follow = null;
    for (const x of this.branches) for (const s of x.snaps) s.forks.delete(id);
    for (const s of b.snaps) this.drop(s, 'delete');
    this.releaseHead(b);
    this.branches = this.branches.filter((x) => x !== b);
    this.thin();
    return true;
  }

  /** Имя вида по id так, как его видела ветка (общие виды — у предков). */
  spName(b: Branch, id: number): { name: string; hue: number } | null {
    for (let x: Branch | null = b; x; ) {
      const n = x.names.get(id);
      if (n) return n;
      if (x.parent === null || id >= x.nxFork) return null;
      x = this.parentOf(x);
    }
    return null;
  }

  /** Прореживание: ярусы по возрасту, архив графиков, затем бюджет памяти (§3.6). */
  thin(): void {
    const A = this.active;
    for (const b of this.branches) {
      const tiers = b === A ? (this.small ? TIERS_SMALL : TIERS) : IDLE;
      b.snaps = b.snaps.filter((s) => {
        if (s.kind !== 'auto' || s.forks.size || keepAuto(s.tick, b.headTick, tiers)) return true;
        this.drop(s, 'tier');
        return false;
      });
      // архив графиков: старше HIST_FULL — одна запись на HIST_EVERY тактов (на телефоне и ряды шкалы — реже)
      const lim = b.headTick - TM.HIST_FULL;
      const every = this.small ? TM.HIST_EVERY_SMALL : TM.HIST_EVERY;
      let i = b.sThin;
      if (i < b.samples.length && b.samples[i].tick < lim) {
        const kept: Sample[] = [];
        for (; i < b.samples.length && b.samples[i].tick < lim; i++) {
          const s = b.samples[i];
          if (s.tick % every === 0) kept.push(s);
          else b.sampleBytes -= sampleBytes(s);
        }
        b.samples = b.samples.slice(0, b.sThin).concat(kept, b.samples.slice(i));
        b.sThin += kept.length;
      }
      if (this.small) {
        let j = b.rThin;
        if (j < b.rows.length && b.rows[j].t < lim) {
          const kept: SeriesRow[] = [];
          for (; j < b.rows.length && b.rows[j].t < lim; j++) if (b.rows[j].t % TM.ROW_EVERY_OLD_SMALL === 0) kept.push(b.rows[j]);
          b.rows = b.rows.slice(0, b.rThin).concat(kept, b.rows.slice(j));
          b.rThin += kept.length;
        }
      }
    }
    this.evict();
  }

  // ---------------- внутреннее ----------------

  private newBranch(parent: number | null, forkTick: number, parentActN: number, parentInN: number, nxFork: number, intervention: Action | null): Branch {
    const id = this.bseq++;
    const k = id; // буква и цвет — по номеру ветки: после удаления ветки буквы не повторяются
    const b: Branch = {
      id, letter: BRANCH_LETTERS[k % BRANCH_LETTERS.length] + (k >= BRANCH_LETTERS.length ? String(Math.floor(k / BRANCH_LETTERS.length) + 1) : ''),
      name: '', color: BRANCH_COLORS[k % BRANCH_COLORS.length], icon: '🌿',
      parent, forkTick, forkSnap: null, parentActN, parentInN, nxFork, intervention,
      actions: [], input: new InputLog(), scheduled: null, scheduledIn: null,
      rows: [], marks: [], samples: [], snaps: [], head: null, headTick: forkTick,
      exact: parent === null ? true : this.active.exact, bg: null, names: new Map(),
      schedA: 0, schedI: 0, gPrev: [0, 0, 0, 0], gMark: [-1e9, -1e9, -1e9, -1e9], gGone: [false, false, false, false], sampleBytes: 0, sThin: 0, rThin: 0,
    };
    this.branches.push(b);
    return b;
  }

  /** Самая глубокая ветка линии, которой принадлежит точка (T, cur). */
  private ownerOf(T: number, cur: [number, number]): Branch {
    let b = this.active;
    for (;;) {
      if (b.parent === null) return b;
      if (T > b.forkTick || (T === b.forkTick && cur[0] >= b.parentActN && cur[1] >= b.parentInN)) return b;
      b = this.parentOf(b)!;
    }
  }

  private trapped(f: () => void): void {
    if (!this.trap) return f();
    // через M: в src/sim имя системного генератора встречается ровно один раз (зерно нового мира, G2)
    const M: { random: () => number } = Math;
    const r = M.random;
    M.random = () => {
      throw new Error('Системная случайность в симуляции (нужно this.r())');
    };
    try {
      f();
    } finally {
      M.random = r;
    }
  }

  private resetBase(w: World): void {
    this.grassOpen = null;
    const i = w.input;
    this.base = { dx: i.dx, dy: i.dy, run: i.run, set: JSON.stringify(w.settings), exp: JSON.stringify(w.experiment) };
  }

  /**
   * В настоящем: записать ввод и настройки, изменённые после шага (на паузе), прежде чем мир попадёт в снимок,
   * развилку или опыт — иначе снимок хранит то, чего нет в записи, и повтор из прошлого разойдётся.
   */
  private flush(w: World): void {
    if (!this.visiting && !this.play && !this.disabled) this.diff(w);
  }

  /** Перед шагом: записать изменившийся ввод и настройки. */
  private diff(w: World): void {
    const i = w.input, B = this.base, b = this.active;
    if (i.dx !== B.dx || i.dy !== B.dy || i.run !== B.run) {
      // страница пишет Math.fround — иначе запись неточная, и «Как было» станет новой веткой
      if (Math.fround(i.dx) !== i.dx || Math.fround(i.dy) !== i.dy) b.exact = false;
      b.input.push(w.tick, i.dx, i.dy, i.run);
      B.dx = i.dx;
      B.dy = i.dy;
      B.run = i.run;
      if (this.inLen(b) > TM.INPUT_CAP) b.exact = false;
    }
    const s = JSON.stringify(w.settings);
    if (s !== B.set) this.record(w, { k: 'settings', t: w.tick, s: { ...w.settings } }, false);
    const e = JSON.stringify(w.experiment);
    if (e !== B.exp) this.record(w, { k: 'experiment', t: w.tick, e: { ...w.experiment }, quiet: true }, false);
  }

  /** Ветка «без действия» сама повторяет остальную запись в свои такты. */
  private runScheduled(w: World): void {
    const b = this.active;
    const S = b.scheduled;
    if (S) {
      while (b.schedA < S.length && S[b.schedA].t <= w.tick) {
        const a = S[b.schedA++];
        if (a.t === w.tick) this.record(w, structuredClone(a));
      }
      if (b.schedA >= S.length) b.scheduled = null;
    }
    const L = b.scheduledIn;
    if (L) {
      while (b.schedI < L.n && L.t[b.schedI] <= w.tick) {
        const j = b.schedI++;
        if (L.t[j] === w.tick) Object.assign(w.input, { dx: L.dx[j], dy: L.dy[j], run: L.run[j] === 1 });
      }
      if (b.schedI >= L.n) b.scheduledIn = null;
    }
  }

  private afterStep(w: World): void {
    const b = this.active, T = w.tick;
    const h = w.history.at(-1);
    if (h && h.tick === T) this.pushSample(b, h);
    if (T % TM.ROW_EVERY === 0) {
      const row = rowOf(w);
      b.rows.push(row);
      for (const id of row.ids) if (!b.names.has(id)) {
        const sp = w.species.all.get(id);
        if (sp) b.names.set(id, { name: sp.name, hue: sp.hue });
      }
      this.guildMarks(b, row);
    }
    for (const m of stepMarks(w)) this.addMark(b, m);
    b.headTick = T;
    if (T % this.snapEvery === 0) {
      this.insertSnap(b, this.capture(w, 'auto'));
      this.thin();
    }
  }

  private pushSample(b: Branch, h: Sample): void {
    b.samples.push(h);
    b.sampleBytes += sampleBytes(h);
  }

  /** Гильдия исчезла (не чаще раза в 1000 тактов) или вернулась — отметки только шкалы, не летописи мира. */
  private guildMarks(b: Branch, row: SeriesRow, silent = false): void {
    for (let g = 0; g < 4; g++) {
      const prev = b.gPrev[g], now = row.g[g], G = GUILD[g];
      if (prev > 0 && now === 0 && row.t - b.gMark[g] >= 1000) {
        b.gMark[g] = row.t;
        b.gGone[g] = true;
        const text = `${G.icon} На острове не осталось ${G.gen}`;
        this.addMark(b, { t: row.t, text, kind: 'guild', icon: G.icon, major: true });
        if (!silent) this.onToast(text);
      } else if (prev === 0 && now > 0 && b.gGone[g]) {
        b.gGone[g] = false;
        this.addMark(b, { t: row.t, text: `${G.icon} ${G.back}`, kind: 'guild', icon: G.icon, major: false });
      }
    }
    b.gPrev = row.g;
  }

  private addMark(b: Branch, m: Mark): void {
    b.marks.push(m);
    if (b.marks.length > TM.MARKS_CAP) {
      const i = b.marks.findIndex((x) => !x.major);
      b.marks.splice(i >= 0 ? i : 0, 1);
    }
    // крупное природное событие: ближайший предыдущий авто-снимок — «до события» (у поступков есть свой 'pre')
    if (m.major && m.act === undefined) {
      for (let i = b.snaps.length - 1; i >= 0; i--) {
        const s = b.snaps[i];
        if (m.t - s.tick > 600) break;
        if (s.kind === 'auto') {
          s.kind = 'event';
          s.label = m.icon;
          break;
        }
      }
    }
  }

  /** Перед поступком: снимок «до» (или ближайший недавний снимок линии становится им). */
  private preAnchor(w: World, b: Branch, idx: number, icon: string): void {
    const L = this.lineageSnaps(b);
    for (let i = L.length - 1; i >= 0; i--) {
      const s = L[i];
      if (w.tick - s.tick > TM.PRE_REUSE) break;
      if (s.kind === 'head' || s.kind === 'book') continue;
      if (s.kind === 'auto' || s.kind === 'event') {
        s.kind = 'pre';
        s.label = icon;
      }
      return;
    }
    const s = this.capture(w, 'pre', [idx, this.inLen(b)]);
    s.label = icon;
    this.insertSnap(b, s);
    this.thin();
  }

  private capture(w: World, kind: SnapKind, cur?: [number, number], b: Branch = this.active): SnapMeta {
    this.grassOpen = null;
    const t0 = performance.now();
    const snap = w.captureState();
    const ms = performance.now() - t0;
    snap.actN = cur ? cur[0] : this.actLen();
    snap.inN = cur ? cur[1] : this.inLen();
    const st = this.stats;
    st.captures++;
    st.captureMs.push(ms);
    if (st.captureMs.length > 40) st.captureMs.shift();
    if (this.autoRaise && this.snapEvery === TM.SNAP_EVERY && st.captureMs.length >= 20) {
      const sorted = [...st.captureMs].sort((x, y) => x - y);
      if (sorted[Math.floor(sorted.length * 0.95)] > 12) this.snapEvery = 600;
    }
    if (snapshotProblems().length && !this.disabled) {
      this.disabled = true;
      this.onToast('Машина времени выключена: новая часть мира ещё не умеет сохраняться');
    }
    return { id: ++this.seq, branch: b.id, tick: w.tick, kind, snap, forks: new Set() };
  }

  /** Снимки ветки упорядочены по (такт, номер действия). */
  private insertSnap(b: Branch, s: SnapMeta): void {
    s.branch = b.id;
    const L = b.snaps;
    let i = L.length;
    while (i > 0 && (L[i - 1].tick > s.tick || (L[i - 1].tick === s.tick && L[i - 1].snap.actN > s.snap.actN))) i--;
    L.splice(i, 0, s);
  }

  private captureHead(w: World): void {
    const b = this.active;
    this.releaseHead(b);
    b.head = this.capture(w, 'head');
    b.headTick = w.tick;
  }

  private releaseHead(b: Branch): void {
    const h = b.head;
    b.head = null;
    if (h && h.kind === 'head') recycleSnap(h.snap);
  }

  private drop(s: SnapMeta, why: DropWhy): void {
    this.stats.dropped[why]++;
    this.onDrop?.(s, why);
    if (this.visiting?.snap === s) this.visiting.snap = null;
    if (!this.branches.some((b) => b.head === s)) recycleSnap(s.snap);
  }

  /** Сверх бюджета (память или MAX_SNAPS снимков): выбрасываем по очереди (§3.6); закреплённые (корень, головы, развилки, свежие 'pre') — никогда. */
  private evict(): void {
    let bytes = this.bytes();
    let count = this.snapCount();
    const MAX = this.maxBytes;
    const over = () => bytes > MAX || count > TM.MAX_SNAPS;
    if (!over()) {
      this.full = false;
      return;
    }
    const A = this.active;
    const keepPre = this.small ? TM.PRE_KEEP_SMALL : TM.PRE_KEEP;
    const pinned = new Set<SnapMeta>();
    for (const b of this.branches) {
      if (b.head) pinned.add(b.head);
      const pres = b.snaps.filter((s) => s.kind === 'pre');
      for (const s of pres.slice(-keepPre)) pinned.add(s);
      for (const s of b.snaps) if (s.forks.size || s.kind === 'root' || s.kind === 'book') pinned.add(s);
    }
    const all = this.branches.flatMap((b) => b.snaps.map((s) => ({ s, b }))).filter(({ s }) => !pinned.has(s));
    const byTick = (x: { s: SnapMeta }, y: { s: SnapMeta }) => x.s.tick - y.s.tick;
    const tiers = this.small ? TIERS_SMALL : TIERS;
    const now = A.headTick;
    const events = all.filter(({ s }) => s.kind === 'event').sort(byTick);
    const order = [
      ...all.filter(({ s, b }) => s.kind === 'auto' && b !== A).sort(byTick),
      ...events.slice(0, Math.max(0, events.length - TM.EVENT_KEEP)),
      ...events.slice(Math.max(0, events.length - TM.EVENT_KEEP)),
      ...all.filter(({ s }) => s.kind === 'pre').sort(byTick),
      ...all.filter(({ s, b }) => s.kind === 'auto' && b === A && now - s.tick > tiers[1].age).sort(byTick),
      ...all.filter(({ s, b }) => s.kind === 'auto' && b === A && now - s.tick > tiers[0].age && now - s.tick <= tiers[1].age).sort(byTick),
    ];
    for (const { s, b } of order) {
      if (!over()) break;
      const i = b.snaps.indexOf(s);
      if (i < 0) continue;
      b.snaps.splice(i, 1);
      bytes -= s.snap.bytes;
      count--;
      this.drop(s, 'budget');
    }
    if (bytes > MAX && !this.full) {
      this.full = true;
      this.onToast('Память машины времени заполнена — удалите ветки');
    }
  }

  private startPlay(w: World, kind: Play['kind'], until: number, stopBefore: number, then?: (w: World) => void): void {
    const from = w.tick;
    const a0 = this.cur[0];
    const guards = this.lineageSnaps().filter((s) => (s.tick > from || (s.tick === from && s.snap.actN > a0)) && s.tick <= until && !(s.tick === until && s.snap.actN > stopBefore));
    this.play = { kind, until, stopBefore, then, guards, gi: 0 };
    if (w.tick >= until) this.arrive(w);
  }

  /** Приложить действия линии этого такта (с номером < stop), сверяя снимки на пути. */
  private replayActs(w: World, stop: number): void {
    const A = this.active, L = this.actLen(A);
    while (this.cur[0] < L && this.cur[0] < stop) {
      const a = this.actAt(A, this.cur[0]);
      if (a.t > w.tick) break;
      if (a.t === w.tick && a.k !== 'undo') this.trapped(() => w.apply(a));
      this.cur[0]++;
      this.guard(w);
      if (!this.play) return;
    }
  }

  private replayInput(w: World): void {
    const A = this.active, L = this.inLen(A);
    while (this.cur[1] < L) {
      const [log, j] = this.inAt(A, this.cur[1]);
      if (log.t[j] > w.tick) break;
      if (log.t[j] === w.tick) Object.assign(w.input, { dx: log.dx[j], dy: log.dy[j], run: log.run[j] === 1 });
      this.cur[1]++;
    }
  }

  /** Сторож расхождения: на каждом снимке линии по пути отпечаток пересчёта должен совпасть с записанным. */
  private guard(w: World): void {
    const p = this.play;
    if (!p) return;
    const G = p.guards;
    while (p.gi < G.length && (G[p.gi].tick < w.tick || (G[p.gi].tick === w.tick && G[p.gi].snap.actN < this.cur[0]))) p.gi++;
    while (p.gi < G.length && G[p.gi].tick === w.tick && G[p.gi].snap.actN === this.cur[0]) {
      const s = G[p.gi++];
      if (s.snap.inN !== this.cur[1]) continue;
      this.stats.guardChecks++;
      if (this.digestNow(w) !== s.snap.digest) {
        this.desync(w, s);
        return;
      }
    }
  }

  /** Отпечаток мира сейчас (буферы временного снимка — обратно в пул). */
  digestNow(w: World): number {
    const s = w.captureState();
    recycleSnap(s);
    return s.digest;
  }

  private desync(w: World, s: SnapMeta): void {
    this.stats.desyncs++;
    this.stats.lastReplay = 'diverged';
    this.onToast('⚠️ История разошлась с записью (другая версия игры или браузер)');
    this.play = null;
    this.restores++;
    w.loadState(s.snap, this.lineageHistory(this.active, s.tick));
    this.visiting = { tick: s.tick, snap: s };
    this.cur = [s.snap.actN, s.snap.inN];
    this.resetBase(w);
  }

  /** Пересчёт дошёл до цели. */
  private arrive(w: World): void {
    const p = this.play!;
    this.replayActs(w, p.stopBefore);
    if (this.play !== p) return;
    this.play = null;
    this.restores++;
    if (p.kind === 'asWas') {
      this.replayInput(w); // ввод такта головы (записанный на паузе) — до сверки, как в самой голове
      const h = this.active.head!;
      const same = this.digestNow(w) === h.snap.digest;
      this.stats.lastReplay = same ? 'same' : 'diverged';
      if (!same) {
        this.stats.desyncs++;
        this.onToast('⚠️ История разошлась с записью (другая версия игры или браузер)');
        w.loadState(h.snap, this.lineageHistory(this.active, h.tick));
      } else this.onToast('🔁 История повторилась до последнего бита: тот же мир + те же кости = то же будущее');
      this.visiting = null;
      this.releaseHead(this.active);
      this.resetBase(w);
      this.onReplayEnd?.(same);
    } else {
      this.visiting = { tick: w.tick, snap: null };
      this.resetBase(w);
    }
    p.then?.(w);
  }
}
