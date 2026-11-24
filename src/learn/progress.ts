/** Прогресс уроков и встреченные карточки. localStorage может быть недоступен — тогда храним в памяти. */
const KEY = 'ecosim.learn.v1';

export type Mem = Record<string, number | string | boolean>;

export interface LessonProgress {
  step: number;
  done: boolean;
  /** Первый ответ на вопрос шага: номер варианта. */
  answers: Record<number, number>;
  mem: Mem;
  doneAt?: number;
}

export interface Progress {
  v: 1;
  lessons: Record<string, LessonProgress>;
  seen: string[];
  /** Урок, который был открыт последним и не закончен. */
  last?: string;
}

const fresh = (): Progress => ({ v: 1, lessons: {}, seen: [] });

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function valid(x: unknown): x is Progress {
  if (!isObj(x) || x.v !== 1 || !isObj(x.lessons) || !Array.isArray(x.seen)) return false;
  if (!x.seen.every((s) => typeof s === 'string')) return false;
  if (x.last !== undefined && typeof x.last !== 'string') return false;
  return Object.values(x.lessons).every(
    (l) => isObj(l) && typeof l.step === 'number' && typeof l.done === 'boolean' && isObj(l.answers) && isObj(l.mem),
  );
}

let memory: Progress | null = null;

export function load(): Progress {
  if (memory) return memory;
  let p = fresh();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const x: unknown = JSON.parse(raw);
      if (valid(x)) p = x;
    }
  } catch {
    /* приватное окно или испорченные данные — начинаем заново */
  }
  memory = p;
  return p;
}

export function save(): void {
  if (!memory) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* хранилище недоступно — прогресс живёт до перезагрузки */
  }
}

export function reset(): void {
  memory = fresh();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ничего */
  }
}

export function lessonProgress(id: string): LessonProgress {
  const p = load();
  return (p.lessons[id] ??= { step: 0, done: false, answers: {}, mem: {} });
}
