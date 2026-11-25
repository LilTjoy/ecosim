// ⏪ 📌 Закладки машины времени: мир целиком в IndexedDB (structuredClone снимка — без своего формата).
// Закладка переживает перезагрузку страницы; открыть — значит начать новую историю с этой точки.
import { plural } from '../lib/text';
import { SNAP_VERSION, type WorldSnap } from '../sim/snapshot';
import { DAY, guildOf, type BrainMode, type Sample, type SurfaceEnv, type World } from '../sim/world';
import { inputArrays, type Action, type InputArrays, type Mark, type SeriesRow, type Timeline } from '../sim/timeline';

/** Сколько закладок держим (≈ 3 МБ каждая). */
export const BOOK_CAP = 20;

/** Что показывает список (без снимка — его читаем только при открытии). */
export interface BookMeta {
  id: number;
  v: number;
  name: string;
  created: number;
  ua: string;
  seed: number;
  salt: number;
  mode: BrainMode;
  env: SurfaceEnv;
  tick: number;
  branchName: string;
  thumb: string;
  stats: { species: number; n: number; g: number[] };
  bytes: number;
}
export interface Bookmark extends BookMeta {
  snap: WorldSnap;
  history: Sample[];
  rows: SeriesRow[];
  marks: Mark[];
  names: [number, string, number][];
  actions: Action[];
  input: InputArrays;
}

const DB = 'ecosim-tm';

/** IndexedDB: store «books» — закладки целиком, «meta» — то же без снимка (для списка). */
export class BookStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((ok, fail) => {
        const rq = indexedDB.open(DB, 1);
        rq.onupgradeneeded = () => {
          const d = rq.result;
          if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id', autoIncrement: true });
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        };
        rq.onsuccess = () => ok(rq.result);
        rq.onerror = () => fail(rq.error);
        rq.onblocked = () => fail(new Error('blocked'));
      });
      this.db.catch(() => (this.db = null));
    }
    return this.db;
  }

  private async tx<T>(stores: string[], mode: IDBTransactionMode, f: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
    const d = await this.open();
    return new Promise<T | undefined>((ok, fail) => {
      const t = d.transaction(stores, mode);
      let out: T | undefined;
      const rq = f(t);
      if (rq) rq.onsuccess = () => (out = rq.result);
      t.oncomplete = () => ok(out);
      t.onerror = () => fail(t.error);
      t.onabort = () => fail(t.error ?? new Error('abort'));
    });
  }

  async list(): Promise<BookMeta[]> {
    const all = (await this.tx<BookMeta[]>(['meta'], 'readonly', (t) => t.objectStore('meta').getAll())) ?? [];
    return all.sort((a, b) => b.created - a.created);
  }

  async get(id: number): Promise<Bookmark | null> {
    return (await this.tx<Bookmark>(['books'], 'readonly', (t) => t.objectStore('books').get(id))) ?? null;
  }

  /** Сохранить; вернуть номер. Снимок клонируется прямо в put (после этого его можно отдать в пул). */
  async put(b: Omit<Bookmark, 'id'>): Promise<number> {
    const d = await this.open();
    return new Promise<number>((ok, fail) => {
      const t = d.transaction(['books', 'meta'], 'readwrite');
      let id = 0;
      const rq = t.objectStore('books').add(b);
      rq.onsuccess = () => {
        id = rq.result as number;
        const { snap: _s, history: _h, rows: _r, marks: _m, names: _n, actions: _a, input: _i, ...meta } = b;
        t.objectStore('meta').put({ ...meta, id });
      };
      t.oncomplete = () => ok(id);
      t.onerror = () => fail(t.error);
      t.onabort = () => fail(t.error ?? new Error('abort'));
    });
  }

  async rename(id: number, name: string): Promise<void> {
    const d = await this.open();
    await new Promise<void>((ok, fail) => {
      const t = d.transaction(['books', 'meta'], 'readwrite');
      for (const st of ['books', 'meta']) {
        const s = t.objectStore(st);
        const rq = s.get(id);
        rq.onsuccess = () => rq.result && s.put({ ...rq.result, name });
      }
      t.oncomplete = () => ok();
      t.onerror = () => fail(t.error);
    });
  }

  async remove(id: number): Promise<void> {
    await this.tx(['books', 'meta'], 'readwrite', (t) => {
      t.objectStore('books').delete(id);
      t.objectStore('meta').delete(id);
    });
  }
}

/** «занято 48 из ~300 МБ» (если браузер говорит). */
export async function storageText(): Promise<string> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e || !e.quota) return '';
    const mb = (x: number) => Math.round(x / 1048576);
    return `занято ${mb(e.usage ?? 0)} из ~${mb(e.quota)} МБ`;
  } catch {
    return '';
  }
}

/** Картинка 160×100: миникарта и точки существ. */
export function thumbOf(w: World, miniBase: HTMLCanvasElement): string {
  const cv = document.createElement('canvas');
  cv.width = 160;
  cv.height = 100;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#0b0d10';
  g.fillRect(0, 0, 160, 100);
  const sc = Math.min(160 / w.width, 100 / w.height);
  const ox = (160 - w.width * sc) / 2, oy = (100 - w.height * sc) / 2;
  g.drawImage(miniBase, ox, oy, w.width * sc, w.height * sc);
  for (const c of w.creatures) {
    g.fillStyle = `hsl(${c.g.hue},75%,62%)`;
    g.fillRect(ox + c.x * sc - 0.75, oy + c.y * sc - 0.75, 1.5, 1.5);
  }
  try {
    return cv.toDataURL('image/png');
  } catch {
    return '';
  }
}

/**
 * Закладка мира сейчас (в настоящем или в посещённом прошлом активной ветки). Снимок — всегда свой (копия снимка
 * линии): пока страница ждёт базу, снимок линии могут вытеснить и отдать его буферы следующему снимку.
 */
export function makeBook(tl: Timeline, w: World, miniBase: HTMLCanvasElement): Omit<Bookmark, 'id'> {
  const A = tl.active;
  const st = tl.expStart(w);
  const T = w.tick;
  const allRows = tl.lineageRows(A).filter((r) => r.t <= T);
  const k = Math.ceil(allRows.length / 600);
  const rows = k <= 1 ? allRows : allRows.filter((_, i) => i % k === 0 || i === allRows.length - 1);
  const marks = tl.lineageMarks(A).filter((m) => m.major && m.t <= T).slice(-300);
  const ids = new Set<number>();
  for (const r of rows) for (const id of r.ids) ids.add(id);
  const names: [number, string, number][] = [];
  for (const id of ids) {
    const live = w.species.all.get(id);
    const n = live ? { name: live.name, hue: live.hue } : tl.spName(A, id);
    if (n) names.push([id, n.name, n.hue]);
  }
  const history = tl.lineageHistory(A, T).filter((h) => h.tick % 100 === 0);
  const g = [0, 0, 0, 0];
  for (const c of w.creatures) g[guildOf(c.g)]++;
  const sp = w.species.living().length;
  const book: Omit<Bookmark, 'id'> = {
    v: SNAP_VERSION, name: defaultName(w, sp), created: Date.now(), ua: navigator.userAgent,
    seed: w.seed, salt: w.salt, mode: w.brainMode, env: w.env, tick: T, branchName: `${A.letter} · ${A.name}`,
    thumb: thumbOf(w, miniBase), stats: { species: sp, n: w.creatures.length, g }, bytes: st.snap.bytes,
    snap: st.meta ? structuredClone(st.snap) : st.snap, history, rows, marks, names,
    actions: tl.lineageActsFrom(A, 0, st.cur[0]), input: inputArrays(tl.lineageInputFrom(A, 0, st.cur[1])),
  };
  return book;
}

export function defaultName(w: World, species: number): string {
  return `Год ${w.year}, ${w.season.name.toLowerCase()} — ${species} ${plural(species, 'вид', 'вида', 'видов')}`;
}

export const bookDay = (b: BookMeta): number => Math.floor(b.tick / DAY);

// ---------------- список закладок во вкладке «⏳ Ветки» ----------------

export interface ShelfHost {
  readonly store: BookStore;
  save(): void;
  open(id: number): void;
  toast(text: string): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class BookShelf {
  /** Список закладок (null — ещё не читали; ошибка — IndexedDB недоступна). */
  list: BookMeta[] | null = null;
  failed = false;
  private renaming: number | null = null;
  private confirmDel: number | null = null;
  private used = '';

  constructor(private el: HTMLElement, private host: ShelfHost) {
    el.addEventListener('click', (e) => this.click(e));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.querySelector<HTMLElement>('[data-bk=saveName]')?.click();
      if (e.key === 'Escape') {
        this.renaming = null;
        this.render();
      }
    });
  }

  async refresh(): Promise<void> {
    try {
      this.list = await this.host.store.list();
      this.failed = false;
      this.used = await storageText();
    } catch {
      this.list = [];
      this.failed = true;
    }
    this.render();
  }

  render(): void {
    const L = this.list;
    if (this.failed) {
      this.el.innerHTML = `<h4>📌 Закладки</h4><div class="tm-empty">Закладки недоступны в этом режиме браузера — машина времени в памяти работает как обычно.</div>`;
      return;
    }
    if (!L) {
      this.el.innerHTML = `<h4>📌 Закладки</h4><div class="muted small">читаю…</div>`;
      return;
    }
    const items = L.map((b) => {
      const nm = this.renaming === b.id
        ? `<span class="tm-bkren"><input value="${esc(b.name)}" maxlength="60"><button data-bk="saveName" data-id="${b.id}">✓</button></span>`
        : `<b>${esc(b.name)}</b>`;
      const when = new Date(b.created).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `<li data-id="${b.id}">
        ${b.thumb ? `<img src="${b.thumb}" alt="" width="80" height="50">` : '<span class="tm-bkimg"></span>'}
        <div class="tm-bkinfo">${nm}
          <div class="muted small">день ${bookDay(b)} · ${b.stats.n} особей · ${esc(b.env.name)}${b.mode === 'neural' ? ' · нейросети' : ''}</div>
          <div class="muted small">${when} · сид ${b.seed}${b.salt ? '-' + b.salt : ''}</div>
          <div class="tm-actbtns"><button data-bk="open" data-id="${b.id}">▶ Открыть</button><button data-bk="ren" data-id="${b.id}" title="Переименовать">✏️</button>${
            this.confirmDel === b.id ? `<button data-bk="del" data-id="${b.id}" class="danger">Точно удалить?</button>` : `<button data-bk="del" data-id="${b.id}" title="Удалить">🗑</button>`
          }</div>
        </div></li>`;
    });
    this.el.innerHTML = `<h4>📌 Закладки <span class="muted small">${L.length} из ${BOOK_CAP}${this.used ? ` · ${this.used}` : ''}</span></h4>
      <p class="muted small">Закладка хранит мир целиком и переживёт перезагрузку страницы. Открыть закладку — начать с этой точки новую историю.</p>
      <div class="tm-actbtns"><button data-bk="save">📌 Закладка сейчас <span class="muted">(B)</span></button></div>
      ${L.length ? `<ul class="tm-books">${items.join('')}</ul>` : ''}`;
    if (this.renaming !== null) {
      const inp = this.el.querySelector<HTMLInputElement>('.tm-bkren input');
      inp?.focus();
      inp?.select();
    }
  }

  private async click(e: Event): Promise<void> {
    const b = (e.target as HTMLElement).closest('[data-bk]') as HTMLElement | null;
    if (!b) return;
    const k = b.dataset.bk, id = Number(b.dataset.id);
    if (k !== 'del') this.confirmDel = null;
    try {
      if (k === 'save') return this.host.save();
      if (k === 'open') return this.host.open(id);
      if (k === 'ren') this.renaming = id;
      else if (k === 'saveName') {
        const v = this.el.querySelector<HTMLInputElement>('.tm-bkren input')?.value.trim();
        this.renaming = null;
        if (v) await this.host.store.rename(id, v.slice(0, 60));
        return this.refresh();
      } else if (k === 'del') {
        if (this.confirmDel !== id) this.confirmDel = id;
        else {
          this.confirmDel = null;
          await this.host.store.remove(id);
          this.host.toast('🗑 Закладка удалена');
          return this.refresh();
        }
      }
    } catch {
      this.host.toast('Закладки недоступны в этом режиме браузера');
    }
    this.render();
  }
}
