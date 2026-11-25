// ♾️ Открытая эволюция: летопись открытий. Раз в 200 тактов мир передаёт сюда себя; бестиарий считает,
// у каких видов есть «рецепты» (сочетания органов), и пишет в летопись: 🧪 зачаток, 🌱 прижился, 💨 исчез,
// 🌟 открытие, 🔁 изобретено снова, 🔀 параллельно, ⚰ утрачено, ♻ вернулось, 🍂 не успели, 📖 план строения,
// 🪞 конвергенция (Стейтон C1), 🐝 апосематизм, 🎭 мимикрия, ⚠️ бутылочное горлышко и 🌳 радиация.
// Здесь нет случайностей и нет localStorage: всё — из состояния мира. Состояние — простые данные (Map/Set/массивы),
// снимок машины времени клонирует его целиком (SNAP_CLONE 'bestiary').
import { hueDiff, hueNear, kindOf, M, MOD_INFO, NSLOT, ORIGIN, originOf, P, patClass } from './modules';
import type { Genome } from './genome';
import type { Species } from './species';
import type { Creature, World } from './world';

export type Gender = 'm' | 'f' | 'n' | 'p';
interface RCtx {
  /** Есть ли у планеты магнитное поле. */
  mag: boolean;
  /** EYE основателя линии (для «потери глаз»). */
  rootEye: number;
}
export interface Recipe {
  id: string;
  name: string;
  /** Дательный и винительный падежи (строчными): «пришли к …», «не доизобретя …». */
  dat: string;
  acc: string;
  gender: Gender;
  icon: string;
  hint: string;
  defs: readonly M[];
  test: (ph: Float32Array, g: Genome, x: RCtx) => boolean;
}

const no = () => false;
/** 29 рецептов (id = карточка). Порог k = 1 везде, в том числе для основателя линии. */
export const RECIPES: readonly Recipe[] = [
  { id: 'echolocation', name: 'Эхолокация', dat: 'эхолокации', acc: 'эхолокацию', gender: 'f', icon: '🦇', hint: 'звук + слух', defs: [M.EAR, M.VOICE], test: (p) => p[P.EAR] >= 0.4 && p[P.VOICE] >= 0.4 },
  { id: 'electroloc', name: 'Электролокация', dat: 'электролокации', acc: 'электролокацию', gender: 'f', icon: '⚡', hint: 'ток + рецептор, в воде', defs: [M.AMPUL, M.EORGAN], test: (p, g) => p[P.AMPUL] >= 0.4 && p[P.EORGAN] >= 0.3 && g.swim > 0.55 },
  { id: 'eshock', name: 'Электрический разряд', dat: 'электрическому разряду', acc: 'электрический разряд', gender: 'm', icon: '🌩', hint: 'мощный орган из мышц', defs: [M.EORGAN], test: (p) => p[P.EORGAN] >= 0.7 },
  { id: 'electrorecept', name: 'Электрочувство', dat: 'электрочувству', acc: 'электрочувство', gender: 'n', icon: '🦈', hint: 'чувствовать мышцы добычи', defs: [M.AMPUL], test: (p, g) => p[P.AMPUL] >= 0.4 && g.swim > 0.4 },
  { id: 'infrared', name: 'Тепловидение', dat: 'тепловидению', acc: 'тепловидение', gender: 'n', icon: '🌡', hint: 'видеть тепло', defs: [M.PIT], test: (p) => p[P.PIT] >= 0.4 },
  { id: 'magneto', name: 'Магнитный компас', dat: 'магнитному компасу', acc: 'магнитный компас', gender: 'm', icon: '🧭', hint: 'нужно магнитное поле', defs: [M.MAG], test: (p, _g, x) => p[P.MAG] >= 0.4 && x.mag },
  { id: 'glow', name: 'Свечение', dat: 'свечению', acc: 'свечение', gender: 'n', icon: '✨', hint: 'свет в темноте', defs: [M.PHOTO], test: (p) => p[P.PHOTO] >= 0.4 },
  { id: 'lure', name: 'Светящаяся приманка', dat: 'светящейся приманке', acc: 'светящуюся приманку', gender: 'f', icon: '🎣', hint: 'хищник со светом', defs: [M.PHOTO], test: (p, g) => p[P.PHOTO] >= 0.4 && g.diet > 0.65 },
  { id: 'poison', name: 'Ядовитость', dat: 'ядовитости', acc: 'ядовитость', gender: 'f', icon: '☠️', hint: 'невкусная добыча', defs: [M.TOXIN], test: (p, g) => p[P.TOXIN] >= 0.4 && g.diet < 0.65 },
  { id: 'aposematism', name: 'Предупреждающая окраска', dat: 'предупреждающей окраске', acc: 'предупреждающую окраску', gender: 'f', icon: '🐸', hint: 'яд + яркий узор', defs: [M.TOXIN], test: no },
  { id: 'venom', name: 'Яд для охоты', dat: 'яду для охоты', acc: 'яд для охоты', gender: 'm', icon: '🦂', hint: 'яд у хищника', defs: [M.TOXIN], test: (p, g) => p[P.TOXIN] >= 0.4 && g.diet >= 0.65 },
  { id: 'armor', name: 'Панцирь', dat: 'панцирю', acc: 'панцирь', gender: 'm', icon: '🐢', hint: 'броня', defs: [M.SHELL], test: (p) => p[P.SHELL] >= 0.6 },
  { id: 'horns', name: 'Рога', dat: 'рогам', acc: 'рога', gender: 'p', icon: '🦏', hint: 'защита крупных', defs: [M.HORN], test: (p, g) => p[P.HORN] >= 0.5 && g.size >= 5 },
  { id: 'burrow', name: 'Жизнь в норах', dat: 'жизни в норах', acc: 'жизнь в норах', gender: 'f', icon: '⛏', hint: 'рыть землю', defs: [M.DIG], test: (p, g) => p[P.DIG] >= 0.5 && g.size <= 6 },
  { id: 'carcinization', name: 'Крабовидная форма', dat: 'крабовидной форме', acc: 'крабовидную форму', gender: 'f', icon: '🦀', hint: 'панцирь, клешни, много ног, плоское тело', defs: [M.SHELL, M.CLAW],
    test: (p, g) => p[P.SHELL] >= 0.5 && p[P.CLAW] >= 0.3 && p[P.LEGS] >= 3 && g.body.shape <= 0.3 },
  { id: 'flight', name: 'Полёт', dat: 'полёту', acc: 'полёт', gender: 'm', icon: '🕊', hint: 'лёгкое тело + перепонки', defs: [M.MEMB], test: (p, g) => p[P.FLY] >= 1 && g.swim < 0.5 },
  { id: 'gliding', name: 'Планирование', dat: 'планированию', acc: 'планирование', gender: 'n', icon: '🪂', hint: 'перепонки', defs: [M.MEMB], test: (p, g) => p[P.FLY] >= 0.45 && p[P.FLY] < 1 && g.swim < 0.5 },
  { id: 'endothermy', name: 'Теплокровность', dat: 'теплокровности', acc: 'теплокровность', gender: 'f', icon: '🔥', hint: 'свой обогреватель', defs: [M.ENDO], test: (p) => p[P.ENDO] >= 0.6 },
  { id: 'antifreeze', name: 'Антифриз в крови', dat: 'антифризу в крови', acc: 'антифриз в крови', gender: 'm', icon: '🧊', hint: 'холод без меха', defs: [M.AFP], test: (p, g) => p[P.AFP] >= 0.4 && g.tempPref < 0.35 },
  { id: 'hibernation', name: 'Спячка', dat: 'спячке', acc: 'спячку', gender: 'f', icon: '💤', hint: 'переждать зиму', defs: [M.TORPOR], test: (p) => p[P.TORPOR] >= 0.4 },
  { id: 'fatstore', name: 'Жировой запас', dat: 'жировому запасу', acc: 'жировой запас', gender: 'm', icon: '🐫', hint: 'запас на чёрный день', defs: [M.FAT], test: (p) => p[P.FAT] >= 0.6 },
  { id: 'anaerobic', name: 'Жизнь без кислорода', dat: 'жизни без кислорода', acc: 'жизнь без кислорода', gender: 'f', icon: '🌫', hint: 'мало кислорода', defs: [M.ANAER], test: (p) => p[P.ANAER] >= 0.5 },
  { id: 'photosym', name: 'Животное-растение', dat: 'животному-растению', acc: 'животное-растение', gender: 'n', icon: '🌿', hint: 'еда от солнца', defs: [M.PSYM], test: (p) => p[P.PSYM] >= 0.4 },
  { id: 'legless', name: 'Безногость', dat: 'безногости', acc: 'безногость', gender: 'f', icon: '🐍', hint: 'ноги не нужны', defs: [M.LIMB], test: (p, g) => p[P.LEGS] === 0 && g.swim < 0.5 },
  { id: 'manylegs', name: 'Многоногость', dat: 'многоногости', acc: 'многоногость', gender: 'f', icon: '🐛', hint: 'удвоение ног', defs: [M.LIMB], test: (p) => p[P.LEGS] >= 4 },
  { id: 'eyeloss', name: 'Потеря глаз', dat: 'потере глаз', acc: 'потерю глаз', gender: 'f', icon: '🐟', hint: 'темнота', defs: [M.EYE], test: (p, _g, x) => p[P.EYE] < 0.05 && x.rootEye >= 0.4 },
  { id: 'streamline', name: 'Обтекаемое тело', dat: 'обтекаемому телу', acc: 'обтекаемое тело', gender: 'n', icon: '🐬', hint: 'быстрый пловец', defs: [], test: (_p, g) => g.swim > 0.7 && g.body.shape >= 0.75 },
  { id: 'pheromone', name: 'Язык запахов', dat: 'языку запахов', acc: 'язык запахов', gender: 'm', icon: '🦋', hint: 'запах-объявление', defs: [M.SCENT], test: (p) => p[P.SCENT] >= 0.4 && p[P.NOSE] >= 0.4 },
  { id: 'alarmcalls', name: 'Тревожные крики', dat: 'тревожным крикам', acc: 'тревожные крики', gender: 'p', icon: '📣', hint: 'стадо + голос', defs: [M.VOICE], test: (p, g) => p[P.VOICE] >= 0.4 && g.social > 0.6 },
];
const NR = RECIPES.length;
const R_IDX = new Map(RECIPES.map((r, i) => [r.id, i]));
const APO = R_IDX.get('aposematism')!;

/** Ручки (стенд: --SPLIT=4000 …). */
export const BEST = {
  /** Вид «владеет» рецептом: n ≥ MIN_N и носителей ≥ max(MIN_HOLD, SHARE·n). */
  MIN_N: 12, MIN_HOLD: 5, SHARE: 0.1, // запасная ручка 1 спецификации (было 6 и 0.15): первое 🌟 18.9k → 15.6k
  /** 🧪: не чаще раза в SIGHT_T тактов и не больше SIGHT_MAX за мир; 🌱 — при HOLD_N носителях, не больше HOLD_MAX. */
  SIGHT_T: 1500, SIGHT_MAX: 8, HOLD_N: 5, HOLD_MAX: 3,
  /** ⚰: нет носителей LOSS_T тактов. */
  LOSS_T: 1000,
  /** 📖 не чаще раза в PLAN_T тактов. */
  PLAN_T: 3000,
  /** 🐝 и 🎭: сколько обходов за 1000 тактов и сколько записей за мир. */
  APO_AVOID: 300, APO_TOX: 0.2, MIM_TOX: 0.05, APO_MAX: 3, MIM_MAX: 3,
  /** Бутылочное горлышко: падение ниже DROP от максимума за 1000 тактов, минимум на ABS особей; пауза COOL; радиация через RAD_T. */
  BN_DROP: 0.5, BN_ABS: 200, BN_COOL: 6000, RAD_T: 6000, RAD_MIN: 4,
  /** Мир после катастрофы (наследство планеты): первые виды отделяются только к 12–15 тысячам тактов — ждём радиацию дольше. */
  RAD_HER: 21000,
};
/** Конвергенция Стейтона C1. */
export const CONV = { SPLIT: 8000, TIP: 0.25, MAX: 0.7, C1: 0.65, DEDUP: 5000, N: 8 };

/** Стенд: записать все пары с похожим обликом (tip ≤ 0.45) — [такт, tip, Dmax, возраст разделения]. */
export const CONV_DIAG = { on: false, rows: [] as number[][] };
/** Измерения облика (L1). */
export const FORM_D = 11;
const RING = 40;

export interface Disc {
  id: string;
  /** Вид-первооткрыватель, его имя и регион. */
  sp: number;
  spName: string;
  region: string;
  tick: number;
  /** «Каэльская эхолокация». */
  title: string;
  /** 🏛 досталось от предков (не открытие). */
  inherited: boolean;
  fromPalette: boolean;
  viaMutagen: boolean;
  /** Подписи происхождения: для каждого независимого изобретения — происхождения модулей рецепта. */
  origins: number[][];
  /** Сколько раз изобретено независимо (первое — 1). */
  times: number;
  /** Сколько линий пришли параллельно (из общего древнего зачатка). */
  parallel: number;
  /** Корни линий и виды, у которых рецепт уже был. */
  roots: number[];
  seen: number[];
  /** Когда в последний раз были носители; когда утрачено (null — есть). */
  lastHeld: number;
  lost: number | null;
  x: number;
  y: number;
}
export interface Plan {
  sig: number;
  ru: string;
  latin: string;
  sp: number;
  tick: number;
  /** Какие органы дали имя (ключи таблицы имён). */
  keys: string[];
}
export interface Watch {
  origin: number;
  kind: M;
  tick: number;
  sp: number;
}
export interface Conv {
  a: number;
  b: number;
  tick: number;
  fact: string;
  logged: boolean;
}
export interface Bottleneck {
  tick: number;
  survivors: number[];
  n: number;
  /** Сколько ждать радиацию (нет — BEST.RAD_T; горлышко из наследства планеты — BEST.RAD_HER). */
  wait?: number;
}

export interface BestiaryState {
  /** Открытые (и 🏛 унаследованные) рецепты. */
  found: Map<string, Disc>;
  /** Новое происхождение, которое прижилось: когда и у кого. */
  originInfo: Map<number, { tick: number; sp: number; kind: M }>;
  watch: Watch[];
  /** Виды модулей: замечен ли зачаток (🧪), прижился ли (🌱), сколько происхождений в наблюдении. */
  sighted: number[];
  held: number[];
  watchN: number[];
  beats: { '🧪': number; '🌱': number; '💨': number };
  lastSight: number;
  /** Живые новые зачатки сейчас (для вкладки): [происхождение, вид, носителей], до 5. */
  live: [number, number, number][];
  /** Прогресс неоткрытых рецептов (0..0.99) и вид, у которого «близко». */
  prog: Map<string, number>;
  near: Map<string, number>;
  /** Независимых изобретений и параллельных линий (всего), 🍂 записей. */
  independent: number;
  parallel: number;
  contingency: number;
  plans: Map<number, Plan>;
  planCand: Map<number, number>;
  planNames: Map<string, number>;
  founderSigs: Set<number>;
  lastPlanLog: number;
  conv: Conv[];
  convPairs: Set<string>;
  cladeLog: Map<number, number>;
  apoSp: number[];
  mimPairs: string[];
  avoidTot: number;
  /** Диагностика конвергенции: пар с похожим обликом (tip ≤ TIP) проверено, из них отсеяно разделением, лучший Dmax. */
  convDiag: { tried: number; young: number; best: number };
  /** Численность каждые 20 тактов (кольцо 50 = последние 1000 тактов) и бутылочное горлышко. */
  popRing: Float32Array;
  bn: Bottleneck | null;
  lastBn: number;
  bnLogs: number;
}

export function newBestiary(): BestiaryState {
  return {
    found: new Map(), originInfo: new Map(), watch: [],
    sighted: [], held: [], watchN: new Array(M.COUNT).fill(0), beats: { '🧪': 0, '🌱': 0, '💨': 0 }, lastSight: -1e9, live: [],
    prog: new Map(), near: new Map(), independent: 0, parallel: 0, contingency: 0,
    plans: new Map(), planCand: new Map(), planNames: new Map(), founderSigs: new Set(), lastPlanLog: -1e9,
    conv: [], convPairs: new Set(), cladeLog: new Map(), apoSp: [], mimPairs: [], avoidTot: 0, convDiag: { tried: 0, young: 0, best: 0 },
    popRing: new Float32Array(50), bn: null, lastBn: -1e9, bnLogs: 0,
  };
}

/** Сколько открыто эволюцией (без 🏛 унаследованных). */
export function foundCount(b: BestiaryState): number {
  let n = 0;
  for (const d of b.found.values()) if (!d.inherited) n++;
  return n;
}

// ---------------- имена ----------------

const GEN_ADJ: Record<Gender, string> = { m: 'ский', f: 'ская', n: 'ское', p: 'ские' };
const SEA: Record<Gender, string> = { m: 'Морской', f: 'Морская', n: 'Морское', p: 'Морские' };
/** Собственное имя региона: «Тундра Каэль» → «Каэль» (или null для «море», «неизвестные земли»). */
function properOf(region: string): string | null {
  const p = region.split(' ')[1];
  return p && /^[А-ЯЁ]/.test(p) ? p : null;
}
/** «Тундра Каэль» → «Каэльская» (как pathogenName в microbes.ts); без региона — «Морская». */
export function regionAdj(region: string, gender: Gender): string {
  const p = properOf(region);
  return p ? p.replace(/[аяоеиыуюэ]$/i, '') + GEN_ADJ[gender] : SEA[gender];
}
const TR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ы: 'y', э: 'e', ю: 'yu', я: 'ya', ь: '', ъ: '',
};
export function translit(s: string): string {
  let o = '';
  for (const ch of s.toLowerCase()) o += TR[ch] ?? ch;
  return o;
}
/** Глагол «изобретён» в роде названия. */
const INVENTED: Record<Gender, string> = { m: 'изобретён', f: 'изобретена', n: 'изобретено', p: 'изобретены' };

/** Таблица имён планов: ключ → [прилагательное, существительное, латинская приставка, суффикс]. */
const PLAN_NAMES: Record<string, [string, string, string, string]> = {
  EYE: ['Зоркий', 'глазач', 'Ophthalm', 'ops'], EYE0: ['Слепой', 'слепыш', 'Typhl', 'ops'], EAR: ['Чуткий', 'ушан', 'Ot', 'otis'],
  NOSE: ['Нюхастый', 'нюхач', 'Rhin', 'rhinus'], PIT: ['Тепловидящий', 'тепловид', 'Therm', 'scopus'], AMPUL: ['Электрочуткий', 'щуп', 'Electr', 'aesthes'],
  MAG: ['Компасный', 'странник', 'Magnet', 'dromus'], PHOTO: ['Светящийся', 'светляк', 'Luc', 'phorus'], VOICE: ['Голосистый', 'крикун', 'Phon', 'phonus'],
  SCENT: ['Пахучий', 'пахун', 'Osm', 'odus'], EORGAN: ['Электрический', 'разрядник', 'Fulgur', 'ichthys'], ENDO: ['Теплокровный', 'теплыш', 'Calid', 'therium'],
  AFP: ['Морозостойкий', 'ледовик', 'Cry', 'philus'], ANAER: ['Бездыханный', 'бездых', 'Anaer', 'bius'], FAT: ['Тучный', 'толстяк', 'Lip', 'gaster'],
  TORPOR: ['Сонный', 'соня', 'Hypn', 'dormus'], PSYM: ['Солнечный', 'зеленец', 'Chlor', 'phyton'], 'LIMB+': ['Многоногий', 'многоног', 'Myri', 'pus'],
  LIMB0: ['Безногий', 'ползун', 'Apod', 'ophis'], SHELL: ['Панцирный', 'панцирник', 'Aspid', 'aspis'], FUR: ['Мохнатый', 'мохнач', 'Lasi', 'thrix'],
  MEMB: ['Крылатый', 'летун', 'Pter', 'pteryx'], CLAW: ['Клешнястый', 'клешнец', 'Chel', 'cheles'], TOXIN: ['Ядовитый', 'ядозуб', 'Tox', 'odon'],
  DIG: ['Роющий', 'землерой', 'Oryct', 'oryctes'], HORN: ['Рогатый', 'рогоносец', 'Cerat', 'ceras'],
};
const KEY_OF: string[] = ['', 'EYE', 'EAR', 'NOSE', 'PIT', 'AMPUL', 'MAG', 'PHOTO', 'VOICE', 'SCENT', 'EORGAN', 'ENDO', 'AFP', 'ANAER', 'FAT', 'TORPOR', 'PSYM',
  'SHELL', 'FUR', 'MEMB', 'CLAW', 'TOXIN', 'DIG', 'HORN'];
const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];
// существительные плана — мужского рода, кроме «соня»: прилагательное к ней — женского
const femAdj = (a: string) => a.replace(/(ый|ий|ой)$/, (m) => (m === 'ий' && /[кгхжшчщ]ий$/.test(a) ? 'ая' : m === 'ий' ? 'яя' : 'ая'));

// ---------------- рабочие массивы прохода (не состояние: пересчитываются каждый раз) ----------------

interface Acc {
  n: number;
  ph: Float64Array;
  shape: number;
  hc: number;
  hs: number;
  pat: number;
  size: number;
  speed: number;
  diet: number;
  swim: number;
  hold: Int32Array;
  rootEye: number;
}
const accs = new Map<number, Acc>();
const holdAll = new Int32Array(NR);
/** Новые происхождения (≥ 100) с уровнем ≥ 0.2: ключ origin·32 + вид → [носителей, особь]. */
const fresh = new Map<number, { n: number; c: Creature }>();
const herK = new Int32Array(M.COUNT);

function accOf(w: World, spId: number): Acc {
  let a = accs.get(spId);
  if (!a) {
    a = { n: 0, ph: new Float64Array(P.COUNT), shape: 0, hc: 0, hs: 0, pat: 0, size: 0, speed: 0, diet: 0, swim: 0, hold: new Int32Array(NR), rootEye: 1 };
    accs.set(spId, a);
  }
  if (a.n === 0) {
    a.ph.fill(0);
    a.hold.fill(0);
    a.shape = a.hc = a.hs = a.pat = a.size = a.speed = a.diet = a.swim = 0;
    const sp = w.species.all.get(spId);
    const root = sp ? w.species.all.get(sp.root) : undefined;
    a.rootEye = root ? root.founder.ph[P.EYE] : 1;
  }
  return a;
}

const holds = (a: Acc, r: number) => a.n >= BEST.MIN_N && a.hold[r] >= Math.max(BEST.MIN_HOLD, BEST.SHARE * a.n);
const rctx: RCtx = { mag: true, rootEye: 1 };

/** Облик вида (11 измерений) из средних. */
function formOf(a: Acc, out: Float32Array, o = 0): void {
  const n = a.n, ph = a.ph;
  out[o] = a.size / n / 9;
  out[o + 1] = a.speed / n / 3;
  out[o + 2] = a.diet / n;
  out[o + 3] = a.swim / n;
  out[o + 4] = a.shape / n;
  out[o + 5] = ph[P.SHELL] / n;
  out[o + 6] = ph[P.CLAW] / n;
  out[o + 7] = Math.min(4, ph[P.LEGS] / n) / 4;
  out[o + 8] = Math.min(1, ph[P.FLY] / n);
  out[o + 9] = ph[P.FUR] / n;
  out[o + 10] = ph[P.EYEQ] / n;
}
function formOfGenome(g: Genome): Float32Array {
  const p = g.ph;
  return new Float32Array([g.size / 9, g.speed / 3, g.diet, g.swim, g.body.shape, p[P.SHELL], p[P.CLAW], Math.min(4, p[P.LEGS]) / 4, Math.min(1, p[P.FLY]), p[P.FUR], p[P.EYEQ]]);
}
const l1 = (a: ArrayLike<number>, b: ArrayLike<number>, ao = 0, bo = 0): number => {
  let s = 0;
  for (let i = 0; i < FORM_D; i++) s += Math.abs(a[ao + i] - b[bo + i]);
  return s;
};

// ---------------- главный проход ----------------

/** Раз в 200 тактов (из World.record при oe). */
export function updateBestiary(w: World): void {
  const B = w.bestiary, tick = w.tick;
  rctx.mag = w.env.magField !== false;
  // A. счёт: по видам — носители рецептов и суммы фенотипа; новые происхождения
  // порядок обхода видов — только из порядка особей этого мира (не из прошлых проходов и не из другого мира)
  accs.clear();
  holdAll.fill(0);
  fresh.clear();
  herK.fill(0);
  for (const c of w.creatures) {
    if (!c.alive) continue;
    const g = c.g, ph = g.ph, a = accOf(w, c.sp);
    a.n++;
    for (let i = 0; i < P.COUNT; i++) a.ph[i] += ph[i];
    a.shape += g.body.shape;
    a.hc += Math.cos((g.hue * Math.PI) / 180);
    a.hs += Math.sin((g.hue * Math.PI) / 180);
    a.pat += g.pattern;
    a.size += g.size;
    a.speed += g.speed;
    a.diet += g.diet;
    a.swim += g.swim;
    rctx.rootEye = a.rootEye;
    for (let r = 0; r < NR; r++) {
      if (RECIPES[r].test(ph, g, rctx)) {
        a.hold[r]++;
        holdAll[r]++;
      }
    }
    const km = g.body.km, lv = g.body.lvl;
    let herMask = 0;
    for (let i = 0; i < NSLOT; i++) {
      if (km[i] === 0 || lv[i] < 0.2) continue;
      const o = originOf(km[i]), k = kindOf(km[i]);
      if (o >= ORIGIN.FRESH) {
        const key = o * 32 + k, e = fresh.get(key);
        if (e) e.n++;
        else fresh.set(key, { n: 1, c });
      } else if (!(herMask & (1 << k))) {
        herMask |= 1 << k;
        herK[k]++;
      }
    }
  }
  // средние вида — в реестр (вкладка, карточка вида, мимикрия)
  for (const [id, a] of accs) {
    if (a.n === 0) continue;
    const sp = w.species.all.get(id);
    if (!sp) continue;
    const m = sp.mph ?? (sp.mph = new Float32Array(P.COUNT));
    for (let i = 0; i < P.COUNT; i++) m[i] = a.ph[i] / a.n;
    sp.mhue = ((Math.atan2(a.hs, a.hc) * 180) / Math.PI + 360) % 360;
    sp.mpat = a.pat / a.n;
    sp.mshape = a.shape / a.n;
    sp.abil.clear();
    if (a.n >= 8) for (let r = 0; r < NR; r++) if (a.hold[r] >= 3 && a.hold[r] >= 0.15 * a.n) sp.abil.add(RECIPES[r].id);
    if (B.apoSp.includes(id)) sp.abil.add('aposematism');
  }
  beats(w, B, tick);
  discoveries(w, B, tick);
  if (tick % 1000 === 0) {
    plans(w, B, tick);
    convergence(w, B, tick);
    aposematism(w, B);
  }
}

// ---------------- B. зачатки ----------------

function beats(w: World, B: BestiaryState, tick: number): void {
  const N = w.creatures.length;
  // наблюдаемые происхождения: прижились или исчезли
  for (let i = B.watch.length - 1; i >= 0; i--) {
    const wt = B.watch[i], e = fresh.get(wt.origin * 32 + wt.kind), n = e?.n ?? 0;
    if (n >= BEST.HOLD_N) {
      B.watch.splice(i, 1);
      if (B.held.includes(wt.kind) || B.beats['🌱'] >= BEST.HOLD_MAX) continue;
      B.held.push(wt.kind);
      B.beats['🌱']++;
      const sp = w.species.all.get(e!.c.sp);
      B.originInfo.set(wt.origin, { tick, sp: e!.c.sp, kind: wt.kind });
      w.log(`🌱 Зачаток ${MOD_INFO[wt.kind].gen} прижился: у «${sp?.name ?? '?'}» уже ${n} носителей`, 'evo', e!.c.x, e!.c.y, 'duplication');
    } else if (n === 0) {
      B.watch.splice(i, 1);
      if (B.held.includes(wt.kind)) continue;
      if (B.beats['💨']++ === 0)
        w.log(`💨 Зачаток ${MOD_INFO[wt.kind].gen} исчез вместе с последним носителем — так пропадает большинство мутаций`, 'evo', undefined, undefined, 'drift');
    }
  }
  // живые зачатки (вкладка) и прижившиеся без наблюдения — в originInfo (подсказка в инспекторе)
  const live: [number, number, number][] = [];
  for (const [key, e] of fresh) {
    const o = Math.floor(key / 32), k = key & 31;
    live.push([o, k, e.n]);
    if (e.n >= BEST.HOLD_N && !B.originInfo.has(o)) B.originInfo.set(o, { tick, sp: e.c.sp, kind: k as M });
  }
  live.sort((a, b) => b[2] - a[2] || a[0] - b[0]);
  B.live = live.slice(0, 5);
  // 🧪 первое новое происхождение ещё не замеченного вида модуля (редкого среди «наследственных»)
  if (tick - B.lastSight >= BEST.SIGHT_T && B.beats['🧪'] < BEST.SIGHT_MAX) {
    let best: { key: number; n: number; c: Creature } | null = null;
    for (const [key, e] of fresh) {
      const k = key & 31;
      if (B.sighted.includes(k) || herK[k] > 0.2 * N) continue;
      if (!best || e.n > best.n) best = { key, n: e.n, c: e.c };
    }
    if (best) {
      const k = (best.key & 31) as M, o = Math.floor(best.key / 32);
      B.sighted.push(k);
      B.beats['🧪']++;
      B.lastSight = tick;
      B.watch.push({ origin: o, kind: k, tick, sp: best.c.sp });
      B.watchN[k]++;
      const sp = w.species.all.get(best.c.sp);
      w.log(`🧪 У детёныша «${sp?.name ?? '?'}» мутация — зачаток ${MOD_INFO[k].gen}. Приживётся ли?`, 'evo', best.c.x, best.c.y, 'duplication');
    }
  }
  // второе происхождение того же вида — под наблюдение молча (до 2 на вид)
  for (const [key] of fresh) {
    const k = key & 31, o = Math.floor(key / 32);
    if (!B.sighted.includes(k) || B.held.includes(k) || B.watchN[k] >= 2) continue;
    if (B.watch.some((x) => x.origin === o && x.kind === k)) continue;
    B.watch.push({ origin: o, kind: k as M, tick, sp: fresh.get(key)!.c.sp });
    B.watchN[k]++;
  }
}

// ---------------- C–E. открытия ----------------

/** Подпись рецепта у вида: для каждого модуля рецепта — самое частое (мода) происхождение самой сильной копии у носителей. */
function sigOf(w: World, spId: number, r: number): { sig: number[]; x: number; y: number; mut: number; n: number } {
  const R = RECIPES[r], cnt = R.defs.map(() => new Map<number, number>());
  let x = 0, y = 0, n = 0, mut = 0;
  const sp = w.species.all.get(spId), root = sp ? w.species.all.get(sp.root) : undefined;
  rctx.rootEye = root ? root.founder.ph[P.EYE] : 1;
  for (const c of w.creatures) {
    if (c.sp !== spId || !c.alive || (r !== APO && !R.test(c.g.ph, c.g, rctx))) continue; // апосематизм — у всего вида
    n++;
    x += c.x;
    y += c.y;
    if (c.mutT > 0) mut++;
    const km = c.g.body.km, lv = c.g.body.lvl;
    R.defs.forEach((kind, j) => {
      let best = -1, bo = -1;
      for (let i = 0; i < NSLOT; i++) if (km[i] !== 0 && kindOf(km[i]) === kind && lv[i] > best) { best = lv[i]; bo = originOf(km[i]); }
      if (bo >= 0) cnt[j].set(bo, (cnt[j].get(bo) ?? 0) + 1);
    });
  }
  const sig: number[] = [];
  for (const m of cnt) {
    let bo = -1, bn = 0;
    for (const [o, k] of m) if (k > bn || (k === bn && o < bo)) { bo = o; bn = k; }
    if (bo >= 0) sig.push(bo);
  }
  return { sig, x: n ? x / n : 0, y: n ? y / n : 0, mut, n };
}

/** Был ли рецепт уже у основателя линии (тогда это просто наследство, а не параллельная эволюция). */
function rootHas(w: World, sp: Species, r: number): boolean {
  const root = w.species.all.get(sp.root);
  if (!root) return false;
  rctx.rootEye = root.founder.ph[P.EYE];
  return RECIPES[r].test(root.founder.ph, root.founder, rctx);
}

const isPalette = (o: number) => o > ORIGIN.PALETTE && o < ORIGIN.PALETTE + M.COUNT;

function discover(w: World, B: BestiaryState, r: number, sp: Species, tick: number, inherited: boolean): Disc {
  const R = RECIPES[r], s = sigOf(w, sp.id, r);
  const region = w.terrain.regionAt(s.x, s.y)?.name ?? sp.origin;
  const d: Disc = {
    id: R.id, sp: sp.id, spName: sp.name, region, tick, title: regionAdj(region, R.gender) + ' ' + R.name.toLowerCase(),
    inherited, fromPalette: s.sig.some(isPalette), viaMutagen: s.n > 0 && s.mut > s.n / 2,
    origins: [s.sig], times: 1, parallel: 0, roots: [sp.root], seen: [sp.id], lastHeld: tick, lost: null, x: s.x, y: s.y,
  };
  B.found.set(R.id, d);
  if (!inherited) {
    w.log(`🌟 Эволюция открыла: ${R.icon} ${R.name}! Первыми — «${sp.name}» (${region})`, 'evo', s.x, s.y, R.id);
    w.fx.push({ kind: 'discovery', x: s.x, y: s.y, hue: 50 });
  }
  return d;
}

function discoveries(w: World, B: BestiaryState, tick: number): void {
  const S = w.species.all;
  for (const [id, a] of accs) {
    if (a.n < BEST.MIN_N) continue;
    const sp = S.get(id);
    if (!sp || sp.extinct !== null || sp.introduced) continue;
    for (let r = 0; r < NR; r++) {
      if (r === APO || !holds(a, r)) continue;
      const R = RECIPES[r], d = B.found.get(R.id);
      if (!d) {
        discover(w, B, r, sp, tick, rootHas(w, sp, r));
        continue;
      }
      d.lastHeld = tick;
      if (d.lost !== null) {
        // вернулось: из новой мутации или те же носители снова набрали порог
        const s = sigOf(w, id, r), stored = new Set(d.origins.flat());
        if (s.sig.some((o) => o >= ORIGIN.FRESH) && s.sig.every((o) => o < ORIGIN.FRESH || !stored.has(o))) {
          d.origins.push(s.sig);
          w.log(`♻ ${R.name} — снова в этом мире, из новой мутации`, 'evo', s.x, s.y, 'dollo');
        }
        d.lost = null;
        if (!d.seen.includes(id)) d.seen.push(id);
        if (!d.roots.includes(sp.root)) d.roots.push(sp.root);
        continue;
      }
      if (d.seen.includes(id)) continue;
      d.seen.push(id);
      const s = sigOf(w, id, r);
      const nonHer = s.sig.filter((o) => o >= ORIGIN.FRESH);
      const stored = new Set(d.origins.flat());
      if (nonHer.length && nonHer.every((o) => !stored.has(o))) {
        d.origins.push(s.sig);
        d.times++;
        B.independent++;
        if (d.times <= 3 || d.times % 3 === 0)
          w.log(`🔁 ${R.icon} ${R.name} ${INVENTED[R.gender]} снова — независимо, у «${sp.name}». Это другая мутация, не наследство (уже ${d.times}-й раз)`,
            'evo', s.x, s.y, 'convergence');
      } else if (!nonHer.length && !d.roots.includes(sp.root) && !rootHas(w, sp, r)) {
        // своя линия, у основателя рецепта не было — дошли сами из общего древнего зачатка
        d.parallel++;
        if (B.parallel++ === 0) w.log(`🔀 «${sp.name}» пришли к ${R.dat} параллельно — из общего древнего зачатка`, 'evo', s.x, s.y, 'homology');
      }
      if (!d.roots.includes(sp.root)) d.roots.push(sp.root);
    }
  }
  // D. утрата: ни одного носителя LOSS_T тактов
  for (const d of B.found.values()) {
    const r = R_IDX.get(d.id)!;
    if (r === APO || d.lost !== null) continue;
    if (holdAll[r] > 0) d.lastHeld = Math.max(d.lastHeld, tick);
    else if (tick - d.lastHeld >= BEST.LOSS_T) {
      d.lost = tick;
      const R = RECIPES[r];
      w.log(`⚰ Утрачено: ${R.icon} ${R.name} — последние носители вымерли. Если вернётся, то уже из новой мутации`, 'evo', undefined, undefined, 'dollo');
    }
  }
  // E. прогресс неоткрытых и «🍂 не успели»
  for (const [rid, spId] of B.near) {
    const sp = S.get(spId);
    if (B.found.has(rid)) B.near.delete(rid);
    else if (!sp || sp.extinct !== null) {
      B.near.delete(rid);
      if (sp && B.contingency < 3) {
        B.contingency++;
        w.log(`🍂 «${sp.name}» вымерли, так и не доизобретя ${RECIPES[R_IDX.get(rid)!].acc}`, 'evo', undefined, undefined, 'contingency');
      }
    }
  }
  for (let r = 0; r < NR; r++) {
    const R = RECIPES[r];
    if (r === APO || B.found.has(R.id)) {
      B.prog.delete(R.id);
      continue;
    }
    let best = 0, bestSp = -1;
    for (const [id, a] of accs) {
      if (a.n < 8 || !a.hold[r]) continue;
      const sp = S.get(id);
      if (!sp || sp.introduced) continue;
      const p = Math.min(0.99, a.hold[r] / Math.max(BEST.MIN_HOLD, BEST.SHARE * a.n));
      if (p > best) { best = p; bestSp = id; }
    }
    if (best > 0) B.prog.set(R.id, best);
    else B.prog.delete(R.id);
    if (best >= 0.5) B.near.set(R.id, bestSp);
    else B.near.delete(R.id);
  }
}

// ---------------- 7.3 планы строения ----------------

/** Подпись плана из средних вида: органы ≥ 0.4, класс ног, пловец, класс питания. */
function planSig(ph: ArrayLike<number>, swim: number, diet: number): number {
  let s = 0;
  for (let k = M.EYE; k < M.LIMB; k++) if (ph[k - 1] >= 0.4) s += 2 ** (k - 1);
  const legs = ph[P.LEGS];
  s += (legs < 0.5 ? 0 : legs < 2.5 ? 1 : 2) * 2 ** 25;
  if (swim > 0.6) s += 2 ** 27;
  s += (diet < 0.3 ? 0 : diet < 0.65 ? 1 : 2) * 2 ** 28;
  return s;
}

function plans(w: World, B: BestiaryState, tick: number): void {
  const S = w.species.all;
  for (const sp of S.values()) {
    if (sp.parent !== null) continue;
    const g = sp.founder;
    B.founderSigs.add(planSig(g.ph, g.swim, g.diet));
  }
  const seen = new Set<number>();
  for (const [id, a] of accs) {
    if (a.n < 8) continue;
    const sp = S.get(id);
    if (!sp || sp.introduced || sp.extinct !== null) continue;
    const m = sp.mph!;
    const sig = planSig(m, a.swim / a.n, a.diet / a.n);
    if (B.plans.has(sig) || B.founderSigs.has(sig) || seen.has(sig)) continue;
    seen.add(sig);
    const held = (B.planCand.get(sig) ?? 0) + 1;
    B.planCand.set(sig, held);
    if (held < 2) continue;
    // имя: два органа, сильнее всего отличающихся от основателя линии
    const root = S.get(sp.root)?.founder ?? sp.founder, rp = root.ph;
    const sc: [string, number][] = [];
    for (let k = M.EYE; k < M.LIMB; k++) {
      const d = m[k - 1] - rp[k - 1];
      if (k === M.EYE && m[P.EYE] < 0.05 && rp[P.EYE] >= 0.4) sc.push(['EYE0', rp[P.EYE] - m[P.EYE]]);
      else if (d > 0.3) sc.push([KEY_OF[k], d]);
    }
    if (m[P.LEGS] >= 3) sc.push(['LIMB+', (m[P.LEGS] - 2) / 2]);
    else if (m[P.LEGS] < 0.5 && rp[P.LEGS] >= 1) sc.push(['LIMB0', 1]);
    sc.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const top = sc.filter((x) => x[1] > 0.3).slice(0, 2);
    if (!top.length) continue; // отличие только в классе ног или питания — не новый план
    const k1 = top[0][0], k2 = (top[1] ?? top[0])[0];
    const [adj] = PLAN_NAMES[k1], [, noun, , suf] = PLAN_NAMES[k2], pre = PLAN_NAMES[k1][2];
    let ru = `${noun === 'соня' ? femAdj(adj) : adj} ${noun}`;
    const c = B.planNames.get(ru) ?? 0;
    B.planNames.set(ru, c + 1);
    ru += ROMAN[c] ?? ` ${c + 1}`;
    const proper = properOf(sp.origin);
    const latin = (pre + 'o' + suf).replace(/([aeiouy])\1/g, '$1') + ' ' + (proper ? translit(proper) + 'ensis' : 'marinus');
    const plan: Plan = { sig, ru, latin, sp: id, tick, keys: top.map((x) => x[0]) };
    B.plans.set(sig, plan);
    B.planCand.delete(sig);
    if (tick - B.lastPlanLog >= BEST.PLAN_T) {
      B.lastPlanLog = tick;
      w.log(`📖 Новый план строения: «${ru}» (${latin}) — «${sp.name}»`, 'evo', sp.x, sp.y);
    }
  }
  // кандидаты, которые не удержались два раза подряд, забываем
  for (const sig of [...B.planCand.keys()]) if (!seen.has(sig)) B.planCand.delete(sig);
}

// ---------------- 7.4 конвергенция облика ----------------

function formAt(sp: Species, T: number): number {
  if (!sp.formHist || !sp.formT) return -1;
  for (let i = 0, m = Math.min(sp.formN, RING); i < m; i++) if (sp.formT[i] === T) return i * FORM_D;
  return -1;
}
function chainOf(S: Map<number, Species>, sp: Species): Species[] {
  const out: Species[] = [sp];
  let s = sp;
  for (let i = 0; i < 5000 && s.parent !== null; i++) {
    const p = S.get(s.parent);
    if (!p) break;
    out.push(p);
    s = p;
  }
  return out;
}

const fBuf = new Float32Array(FORM_D);
function convergence(w: World, B: BestiaryState, tick: number): void {
  const S = w.species.all;
  const live: { sp: Species; a: Acc }[] = [];
  for (const [id, a] of accs) {
    if (a.n < CONV.N) continue;
    const sp = S.get(id);
    if (!sp || sp.extinct !== null) continue;
    if (!sp.formHist) {
      sp.formHist = new Float32Array(RING * FORM_D);
      sp.formT = new Int32Array(RING).fill(-1);
    }
    const slot = sp.formN % RING;
    formOf(a, sp.formHist, slot * FORM_D);
    sp.formT![slot] = tick;
    sp.formN++;
    if (!sp.introduced) live.push({ sp, a });
  }
  live.sort((x, y) => x.sp.id - y.sp.id);
  // история облика нужна только линиям, у которых есть живые потомки
  const keep = new Set<number>();
  for (const sp of S.values()) if (sp.extinct === null) for (const s of chainOf(S, sp)) { if (keep.has(s.id)) break; keep.add(s.id); }
  for (const sp of S.values()) if (sp.formHist && !keep.has(sp.id)) { sp.formHist = sp.formT = null; sp.formN = 0; }
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const A = live[i].sp, Bs = live[j].sp, key = `${A.id}:${Bs.id}`;
      if (B.convPairs.has(key)) continue;
      formOf(live[i].a, fBuf);
      const tip = l1(fBuf, Bs.formHist!, 0, (Bs.formN - 1) % RING * FORM_D);
      if (tip > Math.max(CONV.TIP, CONV_DIAG.on ? 0.45 : 0)) continue;
      const ca = chainOf(S, A), cb = chainOf(S, Bs);
      if (ca.includes(Bs) || cb.includes(A)) continue;
      B.convDiag.tried++;
      let mrca: Species | null = null;
      const inB = new Set(cb.map((s) => s.id));
      for (const s of ca) if (inB.has(s.id)) { mrca = s; break; }
      let split = 0, la = ca, lb = cb;
      if (mrca) {
        la = ca.slice(0, ca.indexOf(mrca));
        lb = cb.slice(0, cb.indexOf(mrca));
        split = Math.min(la[la.length - 1].born, lb[lb.length - 1].born);
        if (!CONV_DIAG.on && tick - split < CONV.SPLIT) { B.convDiag.young++; continue; }
      }
      // наибольшее расхождение линий после разделения (у разных корней — и в самом начале, по основателям)
      let dmax = 0, swimMax = false;
      const terms = (fa: ArrayLike<number>, ao: number, fb: ArrayLike<number>, bo: number) => {
        let s = 0, big = 0, bigI = -1;
        for (let k = 0; k < FORM_D; k++) {
          const t = Math.abs(fa[ao + k] - fb[bo + k]);
          s += t;
          if (t > big) { big = t; bigI = k; }
        }
        if (s > dmax) { dmax = s; swimMax = bigI === 3; }
      };
      if (!mrca) terms(formOfGenome(la[la.length - 1].founder), 0, formOfGenome(lb[lb.length - 1].founder), 0);
      const Ts = new Set<number>();
      for (const s of la) if (s.formT) for (let k = 0, m = Math.min(s.formN, RING); k < m; k++) if (s.formT[k] >= split) Ts.add(s.formT[k]);
      for (const T of Ts) {
        let sa: Species | null = null, oa = -1, sb: Species | null = null, ob = -1;
        for (const s of la) if ((oa = formAt(s, T)) >= 0) { sa = s; break; }
        for (const s of lb) if ((ob = formAt(s, T)) >= 0) { sb = s; break; }
        if (sa && sb) terms(sa.formHist!, oa, sb.formHist!, ob);
      }
      if (CONV_DIAG.on) {
        CONV_DIAG.rows.push([tick, tip, dmax, mrca ? tick - split : 1e9, A.id, Bs.id]);
        if (tip > CONV.TIP || (mrca && tick - split < CONV.SPLIT)) continue;
      }
      if (dmax > B.convDiag.best) B.convDiag.best = dmax;
      if (dmax < CONV.MAX || 1 - tip / dmax < CONV.C1) continue;
      B.convPairs.add(key);
      const ma = A.mph!, mb = Bs.mph!;
      const fact = ma[P.SHELL] >= 0.4 && mb[P.SHELL] >= 0.4 && A.mshape <= 0.35 && Bs.mshape <= 0.35 ? 'carcinization'
        : live[i].a.swim / live[i].a.n > 0.6 && live[j].a.swim / live[j].a.n > 0.6 && swimMax ? 'aquatic' : 'convergence';
      const clade = mrca ? mrca.id : 0, last = B.cladeLog.get(clade) ?? -1e9;
      const logged = tick - last >= CONV.DEDUP;
      B.conv.push({ a: A.id, b: Bs.id, tick, fact, logged });
      if (logged) {
        B.cladeLog.set(clade, tick);
        w.log(`🪞 Конвергенция: «${A.name}» и «${Bs.name}» независимо пришли к похожему облику`, 'evo', A.x, A.y, fact);
      }
    }
  }
}

// ---------------- 7.5 апосематизм и мимикрия ----------------

function aposematism(w: World, B: BestiaryState): void {
  const S = w.species.all, av = w.avoided;
  for (const v of av.values()) B.avoidTot += v;
  const cand: { sp: Species; tox: number }[] = [];
  for (const [id, a] of accs) {
    if (a.n < BEST.MIN_N) continue;
    const sp = S.get(id);
    if (sp && sp.extinct === null && !sp.introduced) cand.push({ sp, tox: a.ph[P.TOXIN] / a.n });
  }
  for (const { sp, tox } of cand) {
    if (tox < BEST.APO_TOX || patClass(sp.mpat) === 1 || (av.get(sp.id) ?? 0) < BEST.APO_AVOID) continue;
    if (B.apoSp.includes(sp.id) || B.apoSp.length >= BEST.APO_MAX) continue;
    B.apoSp.push(sp.id);
    sp.abil.add('aposematism');
    if (!B.found.has('aposematism')) discover(w, B, APO, sp, w.tick, false);
    w.log(`🐝 Хищники выучили: пёстрых «${sp.name}» лучше не трогать — они ядовиты`, 'evo', sp.x, sp.y, 'aposematism');
  }
  for (const N of cand) {
    if (N.tox >= BEST.MIM_TOX || (av.get(N.sp.id) ?? 0) < BEST.APO_AVOID || B.mimPairs.length >= BEST.MIM_MAX) continue;
    for (const T of cand) {
      if (T.tox < BEST.APO_TOX || T.sp === N.sp) continue;
      const key = `${N.sp.id}:${T.sp.id}`;
      if (B.mimPairs.includes(key)) continue;
      if (![...N.sp.regions].some((r) => T.sp.regions.has(r))) continue;
      if (!hueNear(N.sp.mhue, T.sp.mhue) || patClass(N.sp.mpat) !== patClass(T.sp.mpat)) continue;
      if (N.sp.root === T.sp.root && hueDiff(N.sp.founder.hue, T.sp.mhue) < hueDiff(N.sp.mhue, T.sp.mhue) + 10) continue;
      B.mimPairs.push(key);
      w.log(`🎭 Мимикрия: безвредные «${N.sp.name}» похожи на ядовитых «${T.sp.name}» — и хищники обходят их тоже`, 'evo', N.sp.x, N.sp.y, 'mimicry');
      break;
    }
  }
  av.clear();
}

// ---------------- 7.6 бутылочное горлышко и адаптивная радиация ----------------

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

/** Каждые 20 тактов (из World.record при oe). */
export function trackBottleneck(w: World): void {
  const B = w.bestiary, tick = w.tick, n = w.creatures.length;
  B.popRing[Math.floor(tick / 20) % B.popRing.length] = n;
  let mx = 0;
  for (const v of B.popRing) mx = Math.max(mx, v);
  if (!B.bn && n < BEST.BN_DROP * mx && mx - n >= BEST.BN_ABS && tick - B.lastBn >= BEST.BN_COOL) {
    const survivors: number[] = [];
    for (const sp of w.species.all.values()) if (sp.extinct === null && sp.announced && sp.count > 0) survivors.push(sp.id);
    B.bn = { tick, survivors, n };
    B.lastBn = tick;
    B.bnLogs++;
    w.log(`⚠️ Бутылочное горлышко: выжило ${n} из ${Math.round(mx)}`, 'disaster', undefined, undefined, 'lilliput');
  }
  if (B.bn && tick - B.bn.tick >= (B.bn.wait ?? BEST.RAD_T)) {
    const surv = new Set(B.bn.survivors), per = new Map<number, number>();
    let total = 0;
    for (const sp of w.species.all.values()) {
      if (sp.born <= B.bn.tick || !sp.announced || surv.has(sp.id)) continue;
      let s: Species | undefined = sp;
      for (let i = 0; i < 5000 && s && !surv.has(s.id); i++) s = s.parent !== null ? w.species.all.get(s.parent) : undefined;
      if (!s) continue;
      total++;
      per.set(s.id, (per.get(s.id) ?? 0) + 1);
    }
    if (total >= BEST.RAD_MIN) {
      let top = -1, tn = 0;
      for (const [id, k] of per) if (k > tn) { top = id; tn = k; }
      const name = w.species.all.get(top)?.name ?? '?';
      const who = tn === total ? `потомки «${name}»` : `потомки выживших («${name}» и другие)`;
      w.log(`🌳 Адаптивная радиация: после катастрофы ${who} дали ${total} ${plural(total, 'новый вид', 'новых вида', 'новых видов')}`, 'species', undefined, undefined, 'radiation');
    }
    B.bn = null;
  }
}
