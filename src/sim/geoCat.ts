// 🌋 «Живая планета», этап 2 — катастрофы: извержение (VEI 6/7/8), удар астероида (1 ≡ метеорит, 2, 3 — K–Pg),
// цунами, пожар (клеточный автомат на фронтах), вулканическая и ударная зима, массовое вымирание и «закрытый остров».
// Без DOM. Все случайности — World.r() с ctx null (поток мира); правки рельефа (конус, кальдера, кратер) — в geo.pend,
// рельеф пересчитается в начале следующего шага. Следы на клетках — в fx8: пепел [0, n), гарь [n, 2n), соль [2n, 3n).
import { B, BIOMES } from './terrain';
import { GEO, hash01, type GeoState } from './geo';
import type { Creature, World } from './world';
import type { Genome } from './genome';
import { P } from './modules';

const YEAR = 6000;
const CLIMATE_C = 100 / 3;

/** Ручки катастроф (стенд: --ASH_DEC=… и т. п. меняют их, как и GEO). */
export const CAT = {
  /** Пепел, гарь и соль убывают на столько за геопроход (60 тактов): 255 → 0 примерно за год. */
  ASH_DEC: 2, SALT_DEC: 2, BURN_DEC: 3,
  /** Пепел: потолок травы, листвы и ягод ×(1 − ASH_GROW·ash/255); за каждую убывшую единицу — почве +ASH_SOIL/255. */
  ASH_GROW: 0.9, ASH_SOIL: 2,
  /** Эллипс пепла: длина VEI.ash (px) к востоку, полуширина — доля длины. */
  ASH_W: 0.18,
  /** Темнота и дымка: рост травы ×(1 − DARK_GROW·dark)(1 − AER_GROW·min(1, aer)); е-время темноты, дымки (тактов). */
  DARK_GROW: 0.9, AER_GROW: 0.5,
  /** В темноте трава, листва и ягоды вянут: ×(1 − DARK_WILT·dark) за каждый проход четверти клеток (раз в 4 такта). */
  DARK_WILT: 0.05,
  /** …но не ниже DARK_FLOOR·потолка: семена и корни переживают темноту (мелким этих крох хватает, крупным — нет). */
  DARK_FLOOR: 0.08, DARK_T: 0.25 * YEAR, AER_T: YEAR,
  /** Дымка не копится без конца: несколько катастроф подряд — не больше AER_MAX (≈ −8 °C). */
  AER_MAX: 2,
  /** Конус вулкана (+, 1e-4 ед. в центре) и кальдера VEI 8 (−, радиус 2 клетки). */
  CONE: 250, CALDERA: 450,
  /** Кратер: чаша глубиной CRATER·(1 − (r/R)²), вал +RIM на R…1,35R; R = kill/CRATER_R px. */
  CRATER: 600, RIM: 150, CRATER_R: 4,
  /** Цунами: источник — вода в TSU_R px; суша ниже моря + TSU_H (≈ 30 м) не дальше TSU_D клеток от воды. */
  TSU_R: 900, TSU_H: 0.01, TSU_D: 6,
  /** Пожар: клетка горит FIRE_BURN проходов; урон зверям — доля запаса за проход; удобрение золой. */
  FIRE_BURN: 3, FIRE_DMG: 0.25, FIRE_ASH: 0.25, SCAR: 240, MEGA: 200,
  /** Удар: выжженный круг — доля радиуса гибели; поджог: клетки с опадом больше LITTER в 600 px. */
  SCORCH: 0.7, LITTER: 1, IGNITE_R: 600,
  /** Сколько лет ждать сводки «год спустя» и сколько катастроф хранить в истории. */
  HIST: 12,
};

export type CatAction =
  | { k: 'volcano'; x: number; y: number; vei: 6 | 7 | 8 }
  | { k: 'impact'; x: number; y: number; size: 1 | 2 | 3 }
  | { k: 'tsunami'; x: number; y: number }
  | { k: 'fire'; x: number; y: number };

/** Внутренности World для катастроф (в классе они private). */
type Inner = {
  ctx: Creature | null;
  die(c: Creature, cause: string, corpse?: boolean): void;
  soil: Float32Array;
  litter: Float32Array;
  mic: Float32Array;
  fix: Float32Array;
  myc: Float32Array;
  nut: Float32Array;
};
const X = (w: World) => w as unknown as Inner;

const plural = (n: number, a: string, b: string, c: string) => {
  const m = n % 100, k = n % 10;
  return m >= 11 && m <= 14 ? c : k === 1 ? a : k >= 2 && k <= 4 ? b : c;
};
/** Тысячи через узкий пробел (без Intl: первый вызов toLocaleString в процессе стоит ~10 мс). */
const km2 = (cells: number) => String(cells * 256).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
const region = (w: World, x: number, y: number) => w.terrain.regionAt(x, y)?.name ?? 'открытом море';
const cellXY = (w: World, i: number): [number, number] => [((i % w.terrain.cols) + 0.5) * w.cell, (Math.floor(i / w.terrain.cols) + 0.5) * w.cell];
const isLand = (w: World, i: number) => w.terrain.biome[i] > B.Shallow;
/** Летун открытой эволюции (переживает цунами и уходит от огня). */
const flyer = (w: World, g: Genome) => w.oe && g.ph[P.FLY] >= 1;

/** Действие «Неба» (без живой планеты — ничего). */
export function catAction(w: World, a: CatAction): void {
  const g = w.geo;
  if (!w.lp || !g) return;
  const W = X(w);
  const saved = W.ctx;
  W.ctx = null;
  try {
    if (a.k === 'volcano') volcano(w, a.x, a.y, a.vei);
    else if (a.k === 'impact') impact(w, a.x, a.y, a.size);
    else if (a.k === 'tsunami') tsunami(w, a.x, a.y, true);
    else playerFire(w, a.x, a.y);
  } finally {
    W.ctx = saved;
  }
}

/** До катастрофы: кольцо видов для массового вымирания (через год — сколько исчезло), медиана размера травоядных. */
function before(w: World): void {
  const g = w.geo!;
  if (!g.extRing.length || w.tick - g.extT > YEAR) {
    // виды до катастрофы — через год посмотрим, сколько их исчезло; медиана размера травоядных — «эффект лилипута»
    g.extRing = w.species.living().filter((s) => s.announced && s.count > 0).map((s) => s.id);
    g.extT = w.tick;
    g.med0 = herbMedian(w);
    g.n0 = w.creatures.length;
  }
}

/** Запомнить катастрофу: причина для «бутылочного горлышка», история. */
function remember(w: World, kind: 'volcano' | 'impact' | 'tsunami' | 'fire', x: number, y: number, text: string): void {
  const g = w.geo!;
  g.lastCause = w.tick;
  g.cats = [...g.cats, { t: w.tick, kind, x: Math.round(x), y: Math.round(y), text }].slice(-CAT.HIST);
}

/** Медиана размера травоядных (0 — нет ни одного). */
export function herbMedian(w: World): number {
  const s: number[] = [];
  for (const c of w.creatures) if (c.alive && c.g.swim <= 0.6 && c.g.diet < 0.3) s.push(c.g.size);
  if (!s.length) return 0;
  s.sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Погибли все звери в круге r (без туш — как у метеорита). */
function killCircle(w: World, x: number, y: number, r: number, cause: string): number {
  let n = 0;
  const r2 = r * r;
  for (const c of w.creatures) {
    if (!c.alive || (c.x - x) ** 2 + (c.y - y) ** 2 >= r2) continue;
    X(w).die(c, cause, false);
    n++;
  }
  w.creatures = w.creatures.filter((c) => c.alive);
  return n;
}

/** Правка рельефа кругом в очередь: dz(r) — в 1e-4 единицы (пересчёт — в начале следующего шага). */
function bump(w: World, x: number, y: number, R: number, dz: (d: number) => number): void {
  const g = w.geo!, t = w.terrain, cell = w.cell;
  for (let cy = Math.max(0, Math.floor((y - R) / cell)); cy <= Math.min(t.rows - 1, Math.floor((y + R) / cell)); cy++)
    for (let cx = Math.max(0, Math.floor((x - R) / cell)); cx <= Math.min(t.cols - 1, Math.floor((x + R) / cell)); cx++) {
      const d = Math.hypot((cx + 0.5) * cell - x, (cy + 0.5) * cell - y) / R;
      if (d >= 1) continue;
      const v = Math.round(dz(d));
      if (v) g.pend.push(cy * t.cols + cx, v);
    }
}

// ---------------- 🌋 извержение ----------------

/** Жерло: ближайшая клетка гор или источник на суше в 40 клетках, иначе ближайшая суша (−1 — суши нет). */
function vent(w: World, x: number, y: number): number {
  const t = w.terrain, cx = Math.floor(x / w.cell), cy = Math.floor(y / w.cell);
  const springs = new Set(t.springs);
  let best = -1, bd = Infinity, land = -1, ld = Infinity;
  for (let dy = -40; dy <= 40; dy++)
    for (let dx = -40; dx <= 40; dx++) {
      const xx = cx + dx, yy = cy + dy;
      if (xx < 0 || yy < 0 || xx >= t.cols || yy >= t.rows) continue;
      const i = yy * t.cols + xx, d = dx * dx + dy * dy;
      if (!isLand(w, i)) continue;
      if (d < ld) { ld = d; land = i; }
      if ((t.biome[i] === B.Mountain || springs.has(i)) && d < bd) { bd = d; best = i; }
    }
  // гора дальше 12 клеток, а суша рядом — извергается там, где показали
  if (best >= 0 && bd > 144 && ld <= 4) return land;
  return best >= 0 ? best : land;
}

function volcano(w: World, x0: number, y0: number, vei: 6 | 7 | 8): void {
  const g = w.geo!, t = w.terrain, F = w.fx8!;
  const v = GEO.VEI[vei];
  const vc = vent(w, x0, y0);
  if (vc < 0) {
    w.log('🌋 Здесь нет суши — вулкану негде проснуться', 'info');
    return;
  }
  const [x, y] = cellXY(w, vc);
  before(w);
  const killed = killCircle(w, x, y, v.kill, 'извержение');
  w.scorch(x, y, v.kill * 1.2);
  // конус и (VEI 8) кальдера — правками в очередь; кальдера — затравка озера
  const Rc = v.kill + 4 * w.cell;
  bump(w, x, y, Rc, (d) => CAT.CONE * (1 - d));
  if (vei === 8) {
    bump(w, x, y, 2.5 * w.cell, (d) => -CAT.CALDERA * (1 - d * d));
    if (g.lakeSeeds.length < GEO.LAKE_SEEDS) {
      g.lakeSeeds = [...g.lakeSeeds, vc];
      g.lakes = true;
    }
  }
  // пепел: эллипс по ветру (на восток) и круг у жерла
  const L = v.ash, a = L / 2, b = Math.max(3 * w.cell, L * CAT.ASH_W), ex = x + a * 0.85;
  const cell = w.cell;
  for (let cy = Math.max(0, Math.floor((y - b) / cell)); cy <= Math.min(t.rows - 1, Math.floor((y + b) / cell)); cy++)
    for (let cx = Math.max(0, Math.floor((x - v.kill) / cell)); cx <= Math.min(t.cols - 1, Math.floor((ex + a) / cell)); cx++) {
      const px = (cx + 0.5) * cell, py = (cy + 0.5) * cell;
      const de = Math.hypot((px - ex) / a, (py - y) / b), dv = Math.hypot(px - x, py - y) / (v.kill * 1.5);
      const d = Math.min(de, dv);
      if (d >= 1) continue;
      const i = cy * t.cols + cx;
      const q = Math.round(255 * (1 - d));
      if (q > F[i]) F[i] = q;
    }
  g.fxOn = true;
  g.aer = Math.min(CAT.AER_MAX, g.aer + v.aer);
  g.stats.eruptions++;
  const where = region(w, x, y);
  const text = `🌋 Извержение у «${where}» (VEI ${vei}): пепел на ${Math.round(L)} км к востоку${killed ? `, погибло ${killed}` : ''}`;
  remember(w, 'volcano', x, y, text);
  w.fx.push({ kind: 'meteor', x, y, hue: 8 });
  w.log(text, 'disaster', x, y, vei === 8 ? 'geo_supervolcano' : 'geo_volcwinter');
  const dC = GEO.AER_K * g.aer * CLIMATE_C;
  w.log(`🌫 Вулканическая зима: дымка в небе — остров остынет на ${dC.toFixed(1).replace('.', ',')} °C, солнца траве меньше на ${Math.round(100 * CAT.AER_GROW * Math.min(1, g.aer))}% (дымка оседает за год-два)`, 'info', x, y, 'geo_volcwinter');
}

/**
 * 🌍 Вулканы сами (этап 4): раз в геопроход — кость по такту (hash01, не поток мира: мир без извержения идёт
 * так же, как шёл бы без этой проверки). VEI 6 с вероятностью VOLC_P·volc за 20 тактов геологии, VEI 7 — в
 * VOLC_7 раз реже; место — случайная гора (или суша). volc — из условий планеты (нет — 1, как на Земле).
 */
export function volcPass(w: World): void {
  const g = w.geo!;
  const p = GEO.VOLC_P * g.volc * ((g.speed * GEO.EVERY) / 20);
  const u = hash01(w.tick, w.seed & 0xfffff);
  if (!(u < p)) return;
  const vei: 6 | 7 = u < p * GEO.VOLC_7 ? 7 : 6;
  const t = w.terrain, n = t.cols * t.rows;
  let at = -1;
  for (let k = 0; k < 64 && at < 0; k++) {
    const i = Math.min(n - 1, Math.floor(hash01(w.tick + k + 1, (w.seed ^ 0x7016) & 0xfffff) * n));
    if (t.biome[i] === B.Mountain || (k >= 48 && isLand(w, i))) at = i;
  }
  if (at < 0) return;
  const [x, y] = cellXY(w, at);
  w.log(`🌋 Вулкан проснулся сам: ${g.iceAge === null ? 'недра острова живут' : `вулканизм этой планеты — ${g.volc >= 0.9 ? 'как на Земле' : 'слабее земного'}`}`, 'info', x, y, 'geo_volcwinter');
  const W = X(w);
  const saved = W.ctx;
  W.ctx = null;
  try {
    volcano(w, x, y, vei);
  } finally {
    W.ctx = saved;
  }
}

// ---------------- ☄️ удар ----------------

function impact(w: World, x: number, y: number, size: 1 | 2 | 3): void {
  if (size === 1) {
    w.meteor(x, y); // ≡ метеорит (ворота C0)
    w.geo!.lastCause = w.tick;
    return;
  }
  const g = w.geo!, t = w.terrain, n = t.cols * t.rows;
  const p = GEO.IMPACT[size];
  before(w);
  const killed = killCircle(w, x, y, p.kill, 'удар астероида');
  w.scorch(x, y, p.kill * CAT.SCORCH);
  // кратер: чаша и вал — в очередь (на суше — котловина, затравка озера)
  const R = p.kill / CAT.CRATER_R;
  bump(w, x, y, R * 1.35, (d) => (d < 1 / 1.35 ? -CAT.CRATER * (1 - (d * 1.35) ** 2) : CAT.RIM * (1 - (d * 1.35 - 1) / 0.35)));
  const ci = t.index(x, y);
  if (isLand(w, ci) && g.lakeSeeds.length < GEO.LAKE_SEEDS) {
    g.lakeSeeds = [...g.lakeSeeds, ci];
    g.lakes = true;
  }
  g.dark = Math.max(g.dark, size === 3 ? 1 : 0.5);
  g.aer = Math.min(CAT.AER_MAX, g.aer + p.aer);
  g.stats.impacts++;
  // пожары: случайные клетки суши (кости мира) и всё, где много опада, в 600 px
  let lit = 0;
  for (let k = 0, tries = 0; k < p.fires && tries < 40 * p.fires; tries++) {
    const i = Math.floor(w.r() * n);
    if (!isLand(w, i)) continue;
    k++;
    if (ignite(w, i)) lit++;
  }
  const cell = w.cell, Rr = CAT.IGNITE_R;
  for (let cy = Math.max(0, Math.floor((y - Rr) / cell)); cy <= Math.min(t.rows - 1, Math.floor((y + Rr) / cell)); cy++)
    for (let cx = Math.max(0, Math.floor((x - Rr) / cell)); cx <= Math.min(t.cols - 1, Math.floor((x + Rr) / cell)); cx++) {
      const i = cy * t.cols + cx;
      if (X(w).litter[i] > CAT.LITTER && Math.hypot((cx + 0.5) * cell - x, (cy + 0.5) * cell - y) < Rr && ignite(w, i)) lit++;
    }
  const where = region(w, x, y);
  const text = `☄️ Удар астероида у «${where}»! Небо потемнело, начались пожары. Погибло: ${killed}`;
  remember(w, 'impact', x, y, text);
  w.fx.push({ kind: 'meteor', x, y, hue: 30 });
  w.log(text, 'disaster', x, y, 'geo_impactwinter');
  if (size === 3) cutOff(w, 'после удара');
  // у моря — цунами
  if (!isLand(w, ci) || coastDist(w, ci) <= CAT.TSU_D) tsunami(w, x, y, false);
}

/** ⛵ Остров отрезан на GEO.ISOLATE: с большой земли приплывают только морские. */
function cutOff(w: World, why: string): void {
  const g = w.geo!;
  if (w.tick < g.isolatedUntil) {
    g.isolatedUntil = Math.max(g.isolatedUntil, w.tick + GEO.ISOLATE);
    return;
  }
  g.isolatedUntil = w.tick + GEO.ISOLATE;
  w.log(`⛵ Остров отрезан ${why}: ${Math.round(GEO.ISOLATE / YEAR)} года с большой земли никто, кроме морских, не приплывёт — посмотрим, кто заселит пустые места`, 'info', undefined, undefined, 'geo_islandiso');
}

/** Расстояние в клетках от клетки суши до ближайшей воды (до TSU_D + 1). */
function coastDist(w: World, i: number): number {
  const t = w.terrain, cols = t.cols, cx = i % cols, cy = Math.floor(i / cols);
  const D = CAT.TSU_D;
  for (let r = 0; r <= D; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const xx = cx + dx, yy = cy + dy;
        if (xx < 0 || yy < 0 || xx >= cols || yy >= t.rows) continue;
        if (!isLand(w, yy * cols + xx)) return r;
      }
  return D + 1;
}

// ---------------- 🌊 цунами ----------------

let tsuQ: Int32Array | null = null;
let tsuD: Uint8Array | null = null;

/** Одна волна: низкая суша (ниже моря + 30 м) не дальше TSU_D клеток от воды у источника затоплена; соль в почве. */
function tsunami(w: World, x: number, y: number, own: boolean): number {
  if (own) before(w);
  const g = w.geo!, t = w.terrain, cols = t.cols, n = cols * t.rows, F = w.fx8!, cell = w.cell;
  const q = (tsuQ && tsuQ.length === n ? tsuQ : (tsuQ = new Int32Array(n)));
  const dist = (tsuD && tsuD.length === n ? tsuD : (tsuD = new Uint8Array(n)));
  dist.fill(255);
  const bi = t.biome, el = t.elev, top = t.seaLevel + CAT.TSU_H, R2 = CAT.TSU_R * CAT.TSU_R;
  let qt = 0;
  for (let cy = Math.max(0, Math.floor((y - CAT.TSU_R) / cell)); cy <= Math.min(t.rows - 1, Math.floor((y + CAT.TSU_R) / cell)); cy++)
    for (let cx = Math.max(0, Math.floor((x - CAT.TSU_R) / cell)); cx <= Math.min(cols - 1, Math.floor((x + CAT.TSU_R) / cell)); cx++) {
      const i = cy * cols + cx;
      if (bi[i] > B.Shallow || ((cx + 0.5) * cell - x) ** 2 + ((cy + 0.5) * cell - y) ** 2 > R2) continue;
      dist[i] = 0;
      q[qt++] = i;
    }
  let flooded = 0;
  for (let qh = 0; qh < qt; qh++) {
    const i = q[qh], d = dist[i] + 1;
    if (d > CAT.TSU_D) continue;
    const xx = i % cols;
    const nb = [xx > 0 ? i - 1 : -1, xx < cols - 1 ? i + 1 : -1, i - cols, i + cols];
    for (const j of nb) {
      if (j < 0 || j >= n || dist[j] !== 255 || bi[j] <= B.Shallow || el[j] >= top) continue;
      dist[j] = d;
      q[qt++] = j;
      flooded++;
    }
  }
  // последствия: трава и ягоды смыты, листва побита, соль; пешие в волне погибли
  const so = 2 * n;
  for (let k = 0; k < qt; k++) {
    const i = q[k];
    if (dist[i] === 0) continue;
    w.grass[i] = 0;
    w.forage[i] = 0;
    w.browse[i] *= 0.3;
    X(w).litter[i] = Math.min(6, X(w).litter[i] + 0.2);
    F[so + i] = 255;
  }
  let killed = 0;
  for (const c of w.creatures) {
    if (!c.alive) continue;
    const i = t.index(c.x, c.y);
    if (dist[i] === 0 || dist[i] === 255 || c.g.swim >= 0.5 || flyer(w, c.g)) continue;
    X(w).die(c, 'цунами');
    killed++;
  }
  if (killed) w.creatures = w.creatures.filter((c) => c.alive);
  if (flooded) g.fxOn = true;
  // где волна вышла на берег (первая затопленная клетка) — туда и подпись
  let lx = x, ly = y;
  for (let k = 0; k < qt; k++) if (dist[q[k]] === 1) { [lx, ly] = cellXY(w, q[k]); break; }
  const where = region(w, lx, ly);
  const text = flooded
    ? `🌊 Цунами затопило побережье «${where}»: ${flooded} ${plural(flooded, 'клетка', 'клетки', 'клеток')} суши под солёной водой, погибло ${killed}`
    : '🌊 Цунами ушло в открытое море — низких берегов рядом нет';
  if (own) remember(w, 'tsunami', lx, ly, text);
  else g.cats = [...g.cats.slice(0, -1), { ...g.cats[g.cats.length - 1], text: g.cats[g.cats.length - 1].text + ' · ' + text.slice(3) }];
  w.log(text, 'disaster', lx, ly, 'geo_tsunami');
  return flooded;
}

// ---------------- 🔥 пожар ----------------

/** Поджечь клетку суши (не горит и не гарь): в конец фронта. */
function ignite(w: World, i: number): boolean {
  const g = w.geo!, F = w.fx8!, n = F.length >> 2;
  if (!isLand(w, i) || F[n + i] !== 0 || g.fire.length >= 2 * GEO.FIRE_MAX) return false;
  F[n + i] = 255;
  g.fire.push(i, 0);
  if (!g.fireEp) g.fireEp = { n: 0, x: Math.round(cellXY(w, i)[0]), y: Math.round(cellXY(w, i)[1]), mega: false, t: w.tick };
  g.fxOn = true;
  return true;
}

function playerFire(w: World, x: number, y: number): void {
  const t = w.terrain;
  const c0 = t.index(x, y);
  let lit = 0;
  const cols = t.cols, cx = c0 % cols, cy = Math.floor(c0 / cols);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const xx = cx + dx, yy = cy + dy;
      if (xx >= 0 && yy >= 0 && xx < cols && yy < t.rows && ignite(w, yy * cols + xx)) lit++;
    }
  const where = region(w, x, y);
  if (!lit) {
    w.log(`🔥 У «${where}» гореть нечему`, 'player', x, y, 'geo_fire');
    return;
  }
  remember(w, 'fire', x, y, `🔥 Пожар у «${where}»`);
  w.log(`🔥 Вы подожгли траву у «${where}»: огонь пойдёт по сухому, ветер с запада гонит его на восток`, 'player', x, y, 'geo_fire');
}

/** Горючесть клетки 0..1: трава, листва, опад (в мороз почти не горит). */
function fuel(w: World, i: number): number {
  const t = w.terrain;
  const f = 0.6 * w.grass[i] + 0.3 * w.browse[i] + 0.1 * (X(w)).litter[i];
  const k = t.baseTemp[i] + w.tempShift < 0.03 ? 0.2 : 1;
  return Math.min(1, f) * k;
}

/**
 * Шаг пожара (раз в FIRE_EVERY тактов, до buildHash, кости мира): каждая горящая клетка по порядку поджигает соседей
 * с вероятностью FIRE_P·горючесть·сухость·ветер (на восток ×1,6, на запад ×0,6), через FIRE_BURN проходов выгорает:
 * трава и опад сгорели, листвы — пятая часть, зола удобрила почву, на клетке гарь. Звери в огне теряют запас и бегут.
 */
export function fireStep(w: World): void {
  if (!CAT_PERF.on) return fireStep0(w);
  const t0 = performance.now();
  fireStep0(w);
  CAT_PERF.ms.push(performance.now() - t0);
}

/** Стенд: время каждого шага пожара (мс), только при on. */
export const CAT_PERF = { on: false, ms: [] as number[] };

function fireStep0(w: World): void {
  const W = X(w);
  const g = w.geo!, t = w.terrain, cols = t.cols, F = w.fx8!, n = F.length >> 2;
  const saved = W.ctx;
  W.ctx = null;
  const old = g.fire, next: number[] = [];
  const mo = t.moist, dryAll = w.drought > 0;
  let burnt = 0;
  g.fire = next;
  for (let k = 0; k + 1 < old.length; k += 2) {
    const i = old[k], age = old[k + 1] + 1;
    const x = i % cols;
    // соседи: восток, запад, север, юг (ветер западный)
    for (let s = 0; s < 4; s++) {
      const j = s === 0 ? (x < cols - 1 ? i + 1 : -1) : s === 1 ? (x > 0 ? i - 1 : -1) : s === 2 ? i - cols : i + cols;
      if (j < 0 || j >= n || F[n + j] !== 0 || !isLand(w, j)) continue;
      const fu = fuel(w, j);
      if (fu < 0.05) continue;
      const dry = dryAll ? 1 : 0.12 + 0.6 * (1 - mo[j]);
      const p = GEO.FIRE_P * fu * dry * (s === 0 ? 1.6 : s === 1 ? 0.6 : 1);
      if (w.r() < p) ignite(w, j);
    }
    if (age >= CAT.FIRE_BURN) {
      // выгорела
      w.grass[i] = 0;
      w.browse[i] *= 0.2;
      w.forage[i] = 0;
      W.litter[i] = 0;
      if (w.settings.soil) W.soil[i] = Math.min(2.5, W.soil[i] + CAT.FIRE_ASH);
      F[n + i] = CAT.SCAR;
      burnt++;
    } else next.push(i, age);
  }
  // звери в огне: запас тает, тревога — бегут; кто выдохся — погиб
  for (const c of w.creatures) {
    if (!c.alive || F[n + t.index(c.x, c.y)] !== 255 || flyer(w, c.g)) continue;
    c.energy -= CAT.FIRE_DMG * w.maxEnergy(c.g);
    c.alarm = Math.max(c.alarm, 40);
    if (c.energy <= 0) {
      W.die(c, 'пожар');
    }
  }
  W.ctx = saved;
  const ep = g.fireEp;
  if (ep) {
    ep.n += burnt;
    if (!ep.mega && ep.n >= CAT.MEGA) {
      ep.mega = true;
      g.lastCause = w.tick;
      w.log(`🔥 Мегапожар у «${region(w, ep.x, ep.y)}»: выгорело ${km2(ep.n)} км² и огонь идёт дальше`, 'disaster', ep.x, ep.y, 'geo_fire');
    }
    if (!g.fire.length) {
      g.stats.fires++;
      if (ep.n >= 20) w.log(`🌱 Пожар погас: выгорело ${km2(ep.n)} км². Гарь зарастает — зола удобрила почву`, 'info', ep.x, ep.y, 'geo_fire');
      g.fireEp = null;
    }
  }
}

// ---------------- геопроход: дымка, темнота, следы, молнии ----------------

/** Раз в геопроход: дымка и темнота оседают (по времени острова), пепел/гарь/соль убывают; молнии в засуху. */
export function catPass(w: World): void {
  const g = w.geo!;
  const k = GEO.EVERY;
  if (g.aer > 0) g.aer = g.aer < 1e-3 ? 0 : g.aer * Math.exp(-k / CAT.AER_T);
  if (g.dark > 0) g.dark = g.dark < 1e-3 ? 0 : g.dark * Math.exp(-k / CAT.DARK_T);
  if (g.fxOn) fxDecay(w);
  // ⚡ молния в засуху (поток мира; ctx в начале шага — null)
  if (w.drought > 0 && w.r() < GEO.LIGHTNING * GEO.EVERY) {
    const t = w.terrain, n = t.cols * t.rows;
    for (let tries = 0; tries < 20; tries++) {
      const i = Math.floor(w.r() * n);
      if (!isLand(w, i) || fuel(w, i) < 0.3) continue;
      if (ignite(w, i)) {
        const [x, y] = cellXY(w, i);
        w.log(`⚡ Молния в засуху подожгла траву у «${region(w, x, y)}»`, 'info', x, y, 'geo_fire');
      }
      break;
    }
  }
  massSweep(w);
}

/** Пепел, гарь и соль убывают; уходящий пепел удобряет почву (андосоли). fxOn гаснет, когда следов нет. */
function fxDecay(w: World): void {
  const W = X(w);
  const F = w.fx8!, n = F.length >> 2, S = W.soil, soilOn = w.settings.soil;
  const { ASH_DEC, SALT_DEC, BURN_DEC, ASH_SOIL } = CAT;
  let any = w.geo!.fire.length > 0;
  for (let i = 0; i < n; i++) {
    const a = F[i];
    if (a) {
      const d = a < ASH_DEC ? a : ASH_DEC;
      F[i] = a - d;
      if (soilOn && w.terrain.biome[i] > B.Shallow) {
        const v = S[i] + (ASH_SOIL * d) / 255;
        S[i] = v > 2.5 ? 2.5 : v;
      }
      any = true;
    }
    const b = F[n + i];
    if (b && b !== 255) {
      F[n + i] = b < BURN_DEC ? 0 : b - BURN_DEC;
      any = true;
    }
    const s = F[2 * n + i];
    if (s) {
      F[2 * n + i] = s < SALT_DEC ? 0 : s - SALT_DEC;
      any = true;
    }
  }
  w.geo!.fxOn = any;
}

/** Множитель роста травы, листвы и ягод от темноты и дымки (1 — как обычно). */
export function growK(g: GeoState): number {
  const k = (1 - CAT.DARK_GROW * g.dark) * (1 - CAT.AER_GROW * Math.min(1, g.aer));
  return k > 0 ? k : 0;
}

/** Охлаждение дымкой (единицы температуры, ≤ 0). */
export const aerShift = (g: GeoState): number => -GEO.AER_K * g.aer;

/**
 * Следы катастроф на клетках этой четверти (как growGrass: tick & 3): пепел — потолок корма ×(1 − ASH_GROW·ash),
 * соль — трава ×(1 − 0,5·соль); в куске почвы этого такта (как soilPass) соль режет плодородие.
 */
export function catHabitat(w: World): void {
  const g = w.geo!;
  const W = X(w);
  const F = w.fx8!, n = F.length >> 2, bi = w.terrain.biome, gr = w.grass, br = w.browse, fo = w.forage;
  const so = 2 * n;
  if (g.dark > 0.02) {
    // ударная зима: без света растения не успевают дышать — вянут (сушa и море)
    const k = 1 - CAT.DARK_WILT * g.dark, fl = CAT.DARK_FLOOR;
    for (let i = w.tick & 3; i < n; i += 4) {
      const info = BIOMES[bi[i]];
      const a = info.fert * fl, b = info.browse * fl, c = info.forage * fl;
      if (gr[i] > a) gr[i] = Math.max(a, gr[i] * k);
      if (br[i] > b) br[i] = Math.max(b, br[i] * k);
      if (fo[i] > c) fo[i] = Math.max(c, fo[i] * k);
    }
  }
  if (!g.fxOn) return;
  for (let i = w.tick & 3; i < n; i += 4) {
    const a = F[i], s = F[so + i];
    if (!a && !s) continue;
    const info = BIOMES[bi[i]];
    const K = (1 - (CAT.ASH_GROW * a) / 255) * (1 - (0.5 * s) / 255);
    if (gr[i] > info.fert * K) gr[i] = info.fert * K;
    if (br[i] > info.browse * K) br[i] = info.browse * K;
    if (fo[i] > info.forage * K) fo[i] = info.forage * K;
  }
  if (w.settings.soil) {
    const NU = W.nut, blk = Math.ceil(n / 16);
    const i0 = (w.tick & 15) * blk, i1 = Math.min(n, i0 + blk);
    for (let i = i0; i < i1; i++) if (F[so + i]) NU[i] *= 1 - (0.5 * F[so + i]) / 255;
  }
}

// ---------------- 💀 массовое вымирание и «эффект лилипута» ----------------

/** Через год после катастрофы: сколько видов исчезло (≥ EXT_SHARE и ≥ EXT_MIN — массовое вымирание), медиана размера. */
function massSweep(w: World): void {
  const g = w.geo!;
  if (!g.extRing.length || w.tick % 600 !== 0) return;
  const all = w.species.all;
  let k = 0;
  for (const id of g.extRing) if (all.get(id)?.extinct !== null) k++;
  const N = g.extRing.length, share = N ? k / N : 0;
  if (g.lastMass < g.extT && k >= GEO.EXT_MIN && share >= GEO.EXT_SHARE) {
    g.lastMass = w.tick;
    g.stats.massExt++;
    w.log(`💀 Массовое вымирание: после катастрофы исчезло ${k} из ${N} видов (${Math.round(100 * share)}%)`, 'disaster', undefined, undefined, 'geo_bigfive');
    cutOff(w, 'после вымирания');
  }
  if (w.tick - g.extT >= YEAR) {
    const m1 = herbMedian(w), m0 = g.med0;
    const sz = (v: number) => v.toFixed(1).replace('.', ',');
    const tail = m0 > 0 && m1 > 0 ? `; медиана размера травоядных ${sz(m0)} → ${sz(m1)}${m1 < m0 ? ' — мелкие пережили беду лучше' : ''}` : m1 === 0 && m0 > 0 ? '; травоядных суши не осталось' : '';
    g.lastSum = { t: w.tick, k, N, m0, m1, n0: g.n0, n1: w.creatures.length };
    w.log(`🐭 Год после катастрофы: исчезло ${k} из ${N} видов${tail}`, 'info', undefined, undefined, m1 > 0 && m1 < m0 ? 'lilliput' : 'geo_bigfive');
    g.extRing = [];
  }
}
