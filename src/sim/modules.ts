// ♾️ Открытая эволюция: модули тела. Геном несёт 8 «слотов» (вид модуля + происхождение + уровень),
// из них при рождении один раз собирается фенотип ph — множители, которые читает мир.
// Земной «нейтральный набор» (kitFor) даёт ровно сегодняшнего зверя: все множители = 1.
// Случайность — только из переданного потока (кости мира или особи), никогда Math.random.
import { clamp, gauss, type Rand } from '../lib/random';
import type { Genome } from './genome';

/** Виды модулей. 0 — пустой слот. */
export const enum M {
  None,
  EYE, EAR, NOSE, PIT, AMPUL, MAG, // рецепторы: свет, звук, запах, тепло (ИК), электричество, магнитное поле
  PHOTO, VOICE, SCENT, EORGAN, // излучатели
  ENDO, AFP, ANAER, FAT, TORPOR, PSYM, // физиология
  SHELL, FUR, MEMB, CLAW, TOXIN, DIG, HORN, // тело
  LIMB, // последним: у ног нет накопленного слота в ph (ноги считаются)
  COUNT, // 25 < 32 → вид помещается в 5 бит
}
export const NSLOT = 8;

/** km[i] = вид | (происхождение << 5); lvl[i] 0..1. НИКОГДА не меняется на месте (делится между копиями генома). */
export interface Body {
  km: Int32Array;
  lvl: Float32Array;
  /** Форма: 0 — плоский/круглый, 0.5 — обычный, 1 — обтекаемый. */
  shape: number;
}
export const kindOf = (km: number): M => (km & 31) as M;
export const originOf = (km: number): number => km >>> 5;

/** Индекс фенотипа. Накопленный уровень вида модуля X лежит в ph[X − 1] (EYE..HORN). */
export const enum P {
  EYE, EAR, NOSE, PIT, AMPUL, MAG, PHOTO, VOICE, SCENT, EORGAN, ENDO, AFP, ANAER, FAT, TORPOR, PSYM,
  SHELL, FUR, MEMB, CLAW, TOXIN, DIG, HORN, // 0..22 — накопленные уровни
  LEGS, LEGLEN, METAB, UPKEEP, LANDMUL, WATERMUL, FLY, PROTECT, TOL, EYEQ, FATK, DEF, BENTH,
  COUNT, // 36
}
/** Последний накопленный индекс ph. */
export const P_ACC = P.HORN;

/** Условия экспрессии — одни на мир (никаких глобальных переменных модуля). */
export interface ExprCtx {
  gravity: number;
  on: boolean;
  allowed: readonly M[];
}
export const EARTH_EXPR: ExprCtx = Object.freeze({ gravity: 1, on: false, allowed: Object.freeze([]) as readonly M[] });
/** Имена видов модулей по номеру (для стенда и отладки; const enum во время работы имён не имеет). */
export const KIND_NAMES = ['None', 'EYE', 'EAR', 'NOSE', 'PIT', 'AMPUL', 'MAG', 'PHOTO', 'VOICE', 'SCENT', 'EORGAN', 'ENDO', 'AFP', 'ANAER',
  'FAT', 'TORPOR', 'PSYM', 'SHELL', 'FUR', 'MEMB', 'CLAW', 'TOXIN', 'DIG', 'HORN', 'LIMB'] as const;
export const ALL_KINDS: readonly M[] = Array.from({ length: M.COUNT - 1 }, (_, i) => (i + 1) as M);

/** Ручки открытой эволюции (стенд переопределяет любую: --P_DUP=0 …). */
export const EVO = {
  P_DUP: 0.03, P_NEO: 0.03, P_NEW: 0.004, LOSS: 0.03, SIGMA: 0.5, NEW_LO: 0.2, NEW_HI: 0.5, // [A-measured]
  BODY_W: 0.04, // [A-measured]
  RCAP: 1.25, // [new, B]
  TOX_HIT: 0.4, TOX_DIE: 0.15, TASTE_T: 2000, HUE_TOL: 18, HUNGRY: 0.35, // [A/C-measured]
  DIG_WARM: 0.6, DIG_SPD: 0.15, DIG_HIDE: 0.7, // [C-measured]
  HORN_DEF: 0.35, HORN_HURT: 2, // [new, B]
  JIT: 0.15, // [new, B]
  BENTHIC: false,
  MUT_BOOST: 4,
};
/** Происхождение модуля: 1..24 — наследство (= вид), 31 — заготовка игрока, 33..56 — палитра, ≥ 100 — новое. */
export const ORIGIN = { INTRODUCED: 31, PALETTE: 32, FRESH: 100 };

/** Счётчики эволюции тела (мир держит один объект, mutateBody прибавляет). */
export interface EvoStats {
  poisoned: number;
  poisonDeaths: number;
  zaps: number;
  births: number;
  dup: number;
  neo: number;
  nu: number;
}
export const newEvoStats = (): EvoStats => ({ poisoned: 0, poisonDeaths: 0, zaps: 0, births: 0, dup: 0, neo: 0, nu: 0 });

// ---------------- таблицы ----------------

/** Содержание: доля базового обмена 0.05·m·air за единицу уровня. EYE, ENDO, ANAER, PSYM — 0 (платятся иначе). */
export const UPKEEP = new Float64Array(M.COUNT);
UPKEEP[M.EAR] = 0.04; UPKEEP[M.NOSE] = 0.04; UPKEEP[M.PIT] = 0.06; UPKEEP[M.AMPUL] = 0.06; UPKEEP[M.MAG] = 0.02;
UPKEEP[M.PHOTO] = 0.08; UPKEEP[M.VOICE] = 0.08; UPKEEP[M.SCENT] = 0.04; UPKEEP[M.EORGAN] = 0.16;
UPKEEP[M.AFP] = 0.06; UPKEEP[M.FAT] = 0.04; UPKEEP[M.TORPOR] = 0.02;
UPKEEP[M.SHELL] = 0.16; UPKEEP[M.FUR] = 0.04; UPKEEP[M.MEMB] = 0.06; UPKEEP[M.CLAW] = 0.06; UPKEEP[M.TOXIN] = 0.12;
UPKEEP[M.DIG] = 0.08; UPKEEP[M.HORN] = 0.08; UPKEEP[M.LIMB] = 0.04;

/** Гомология: во что может превратиться копия модуля (неофункционализация). */
export const HOMOLOGY: readonly (readonly M[])[] = (() => {
  const h: M[][] = Array.from({ length: M.COUNT }, () => []);
  h[M.EYE] = [M.PIT, M.PHOTO];
  h[M.EAR] = [M.VOICE, M.AMPUL];
  h[M.NOSE] = [M.SCENT, M.PIT];
  h[M.PIT] = [M.EYE, M.NOSE];
  h[M.AMPUL] = [M.EORGAN, M.MAG, M.EAR];
  h[M.MAG] = [M.AMPUL];
  h[M.PHOTO] = [M.EYE, M.TOXIN];
  h[M.VOICE] = [M.EAR];
  h[M.SCENT] = [M.TOXIN, M.NOSE];
  h[M.EORGAN] = [M.AMPUL, M.LIMB];
  h[M.ENDO] = [M.FAT, M.FUR];
  h[M.AFP] = [M.ANAER];
  h[M.ANAER] = [M.AFP, M.TORPOR];
  h[M.FAT] = [M.TORPOR, M.ENDO];
  h[M.TORPOR] = [M.FAT, M.ANAER];
  h[M.PSYM] = [M.PHOTO];
  h[M.LIMB] = [M.CLAW, M.MEMB, M.EORGAN, M.DIG];
  h[M.SHELL] = [M.FUR, M.CLAW, M.HORN];
  h[M.FUR] = [M.MEMB, M.SHELL];
  h[M.MEMB] = [M.LIMB, M.FUR];
  h[M.CLAW] = [M.LIMB, M.SHELL, M.DIG, M.HORN];
  h[M.TOXIN] = [M.SCENT, M.PHOTO];
  h[M.DIG] = [M.LIMB, M.CLAW];
  h[M.HORN] = [M.SHELL, M.CLAW];
  return h;
})();

/** Подписи модулей: эмодзи, название, родительный падеж («зачаток …»), карточка. */
export const MOD_INFO: readonly { emoji: string; label: string; gen: string; fact: string }[] = (() => {
  const t: { emoji: string; label: string; gen: string; fact: string }[] = Array.from({ length: M.COUNT }, () => ({ emoji: '', label: '', gen: '', fact: '' }));
  const s = (k: M, emoji: string, label: string, gen: string, fact: string) => (t[k] = { emoji, label, gen, fact });
  s(M.EYE, '👁', 'зрение', 'глаза', 'sense');
  s(M.EAR, '👂', 'слух', 'уха', 'echolocation');
  s(M.NOSE, '👃', 'нюх', 'носа', 'pheromone');
  s(M.PIT, '🌡', 'тепловые ямки', 'тепловых ямок', 'infrared');
  s(M.AMPUL, '🦈', 'электрорецепторы', 'электрорецепторов', 'electrorecept');
  s(M.MAG, '🧭', 'магнитное чувство', 'магнитного чувства', 'magneto');
  s(M.PHOTO, '✨', 'светящийся орган', 'светящегося органа', 'glow');
  s(M.VOICE, '📣', 'голос', 'голоса', 'alarmcalls');
  s(M.SCENT, '🌸', 'пахучая железа', 'пахучей железы', 'pheromone');
  s(M.EORGAN, '⚡', 'электрический орган', 'электрического органа', 'eshock');
  s(M.ENDO, '🔥', 'теплокровность', 'теплокровности', 'endothermy');
  s(M.AFP, '🧊', 'антифриз', 'антифриза', 'antifreeze');
  s(M.ANAER, '🌫', 'бескислородный обмен', 'бескислородного обмена', 'anaerobic');
  s(M.FAT, '🐫', 'жировой запас', 'жирового запаса', 'fatstore');
  s(M.TORPOR, '💤', 'спячка', 'спячки', 'hibernation');
  s(M.PSYM, '🌿', 'водоросли-симбионты', 'водорослей-симбионтов', 'photosym');
  s(M.SHELL, '🐢', 'панцирь', 'панциря', 'armor');
  s(M.FUR, '🧶', 'мех', 'меха', 'endothermy');
  s(M.MEMB, '🪂', 'перепонки', 'перепонок', 'gliding');
  s(M.CLAW, '🦀', 'клешни', 'клешней', 'carcinization');
  s(M.TOXIN, '☠️', 'ядовитая железа', 'ядовитой железы', 'poison');
  s(M.DIG, '⛏', 'роющие лапы', 'роющих лап', 'burrow');
  s(M.HORN, '🦏', 'рога', 'рогов', 'horns');
  s(M.LIMB, '🦵', 'ноги', 'ноги', 'manylegs');
  return t;
})();

// ---------------- тело ----------------

function emptyBody(shape: number): Body {
  return { km: new Int32Array(NSLOT), lvl: new Float32Array(NSLOT), shape };
}

/** Тело из списка [вид, уровень]; происхождение по умолчанию — сам вид (наследство). */
export function bodyFrom(list: readonly (readonly [M, number])[], shape: number, origin?: number): Body {
  const b = emptyBody(shape);
  for (let i = 0; i < list.length && i < NSLOT; i++) {
    const [k, l] = list[i];
    b.km[i] = k | ((origin ?? k) << 5);
    b.lvl[i] = l;
  }
  return b;
}

/**
 * Нейтральный набор для генома (уже слитого с умолчаниями): глаза, немного слуха и нюха, теплокровность,
 * две пары ног; мех — у холодолюбивых. С `rand` уровни случайно сдвинуты (стенд --kit=random).
 */
export function kitFor(g: Genome, rand?: Rand): Body {
  const sw = g.swim > 0.6;
  const leg = sw ? 0.3 : 0.5;
  const list: [M, number][] = [[M.EYE, 1], [M.EAR, 0.3], [M.NOSE, 0.3], [M.ENDO, 0.8], [M.LIMB, leg], [M.LIMB, leg]];
  if (g.tempPref <= 0.25) list.push([M.FUR, 0.5]);
  if (rand) for (const e of list) e[1] = clamp(e[1] * (0.6 + 0.8 * rand()), 0.05, 1);
  return bodyFrom(list, sw ? 0.6 : 0.5);
}

/**
 * Мутация тела при рождении: дрейф уровней и потеря слабых модулей, дрейф формы и не больше одного
 * структурного события — удвоение (то же происхождение), неофункционализация копии в родственный модуль
 * или редкое «изобретение» с нуля. Всегда возвращает НОВОЕ тело.
 */
export function mutateBody(b: Body, rate: number, ctx: ExprCtx, boost: number, newOrigin: () => number, stats: EvoStats, rand: Rand): Body {
  const o: Body = { km: new Int32Array(b.km), lvl: new Float32Array(b.lvl), shape: b.shape };
  const k = (rate / 0.08) * boost;
  for (let i = 0; i < NSLOT; i++) {
    if (o.km[i] === 0) continue;
    const v = Math.min(1, o.lvl[i] + gauss(rand) * rate * EVO.SIGMA);
    if (v < EVO.LOSS) {
      o.km[i] = 0;
      o.lvl[i] = 0;
    } else o.lvl[i] = v;
  }
  o.shape = clamp(o.shape + gauss(rand) * rate * 0.3, 0, 1);
  const r = rand();
  const pDup = EVO.P_DUP * k, pNeo = pDup + EVO.P_NEO * k, pNew = pNeo + EVO.P_NEW * k;
  if (r >= pNew) return o;
  let empty = -1, occ = 0;
  for (let i = 0; i < NSLOT; i++) {
    if (o.km[i] !== 0) occ++;
    else if (empty < 0) empty = i;
  }
  if (empty < 0) return o; // все 8 слотов заняты — тело уже «торгуется» за место
  const newLvl = () => EVO.NEW_LO + rand() * (EVO.NEW_HI - EVO.NEW_LO);
  if (r < pNeo) {
    if (occ === 0) return o;
    let j = Math.floor(rand() * occ), src = -1;
    for (let i = 0; i < NSLOT; i++) if (o.km[i] !== 0 && j-- === 0) { src = i; break; }
    if (r < pDup) {
      o.km[empty] = o.km[src]; // то же семейство генов
      o.lvl[empty] = newLvl();
      stats.dup++;
      return o;
    }
    const h = HOMOLOGY[kindOf(o.km[src])];
    if (!h.length) return o;
    const to = h[Math.floor(rand() * h.length)];
    if (!ctx.allowed.includes(to)) return o;
    o.km[empty] = to | (newOrigin() << 5);
    o.lvl[empty] = newLvl();
    stats.neo++;
    return o;
  }
  if (!ctx.allowed.length) return o;
  const to = ctx.allowed[Math.floor(rand() * ctx.allowed.length)];
  o.km[empty] = to | (newOrigin() << 5);
  o.lvl[empty] = newLvl();
  stats.nu++;
  return o;
}

/** Тело потомка двух родителей: каждый слот целиком от одного из них (происхождение едет вместе со слотом). */
export function crossBody(a: Body, b: Body, rand: Rand): Body {
  const o = emptyBody(0);
  for (let i = 0; i < NSLOT; i++) {
    const s = rand() < 0.5 ? a : b;
    o.km[i] = s.km[i];
    o.lvl[i] = s.lvl[i];
  }
  o.shape = rand() < 0.5 ? a.shape : b.shape;
  return o;
}

/** Расстояние по телу (≈ 0..2): накопленные уровни, пары ног, форма. */
export function bodyDistance(pa: Float32Array, pb: Float32Array, sa: number, sb: number): number {
  let s = Math.abs(sa - sb);
  for (let i = 0; i <= P_ACC; i++) s += Math.abs(pa[i] - pb[i]);
  return s + 0.25 * Math.abs(pa[P.LEGS] - pb[P.LEGS]);
}

const LEG_MUL = [0.45, 0.95, 1, 1, 0.94];

/** Экспрессия: из слотов — фенотип (один раз при рождении). С нейтральным набором все множители = 1. */
export function express(b: Body, size: number, swim: number, ctx: ExprCtx): Float32Array {
  const p = new Float32Array(P.COUNT);
  let legs = 0, len = 0, nLimb = 0, up = 0;
  for (let i = 0; i < NSLOT; i++) {
    const km = b.km[i];
    if (km === 0) continue;
    const k = kindOf(km), v = b.lvl[i];
    up += UPKEEP[k] * v;
    if (k === M.LIMB) {
      nLimb++;
      len += v;
      if (v >= 0.15) legs++;
      continue;
    }
    // повторные копии: 1 − Π(1 − v) — удвоение усиливает, но с убывающей отдачей
    p[k - 1] = 1 - (1 - p[k - 1]) * (1 - v);
  }
  const endo = p[P.ENDO], shell = p[P.SHELL], psym = p[P.PSYM];
  p[P.LEGS] = legs;
  p[P.LEGLEN] = nLimb ? len / nLimb : 0;
  p[P.METAB] = 0.85 + 0.1875 * endo; // набор (0.8) → 1.0; холоднокровный экономит 15%
  p[P.UPKEEP] = up;
  p[P.LANDMUL] = LEG_MUL[Math.min(legs, 4)] * (1 - 0.35 * shell) * (1 - 0.12 * p[P.MEMB]) * (1.05 - 0.1 * b.shape) * (1 - 0.3 * psym) * (1 - EVO.DIG_SPD * p[P.DIG]);
  p[P.WATERMUL] = (0.9 + 0.2 * b.shape) * (1 - 0.25 * shell) * (1 - 0.3 * psym);
  // полёт: нагрузка на крыло (только мелкие: при g = 1 летает лишь size < 3.5)
  p[P.FLY] = (Math.pow((p[P.MEMB] * 3.5) / size, 1.5) / ctx.gravity) * (1 - 0.5 * shell) * (1 - 0.5 * p[P.FAT]);
  p[P.PROTECT] = Math.min(1, Math.max(endo / 0.8, p[P.AFP] / 0.6, 0.5 * endo + 0.6 * p[P.FUR]));
  p[P.TOL] = 0.1 * (0.6 + 0.5 * endo);
  p[P.EYEQ] = p[P.EYE] > 0 ? 0.4 + 0.6 * Math.min(1, p[P.EYE] / 0.8) : 0;
  p[P.FATK] = 1 + 0.6 * p[P.FAT];
  p[P.DEF] = shell * (1.2 - 0.4 * b.shape) + EVO.HORN_DEF * p[P.HORN] * Math.min(1, size / 6);
  p[P.BENTH] = legs >= 3 && shell >= 0.35 && swim < 0.5 ? 1 : 0;
  return p;
}

/** Пересобрать фенотип (размер и плавание могли измениться). */
export function finish<G extends Genome>(g: G, ctx: ExprCtx): G {
  g.ph = express(g.body, g.size, g.swim, ctx);
  return g;
}
