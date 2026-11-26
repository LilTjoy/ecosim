// 🌋 «Живая планета», этап 1b–1c: следопыты (без DOM, без случайностей — только счёт по зверям и рельефу).
//
// • Species.home — материк (метка lm), где больше всего особей вида: пришельцы и «сёстры» — только с того же материка.
// • IsoRec — половины вида по разные стороны закрытого барьера (порог в межледниковье, пролив Уоллеса, пролив игрока):
//   метка стороны у каждой особи (детёныш — материнскую), «поколений врозь» и расхождение генов; переход или скрещивание
//   через барьер — утечка генов: счёт поколений заново. Разделение — только при ≥ ISO_GEN поколений без утечек и
//   расхождении ≥ ISO_D: меньшая половина — новый вид (единственное «назначенное» видообразование, карточка geo_subspecies).
// • BridgeRec — сухопутный мост: переходы в обе стороны, прижившиеся пришельцы, вымершие местные, сводка обмена.
// • Рефугиумы на пике ледниковья и сдвиг ареалов; морены на пике.
import { DIS, type Creature, type World } from './world';
import { GEO, sideWords, sillSide, type BridgeRec, type GeoState, type IsoRec, type RefRec, type SillRec } from './geo';
import { distance, GENE_KEYS, SPECIES_LIMIT, type Genome } from './genome';
import { P } from './modules';
import { B } from './terrain';

const YEAR = 6000;

/** Текущая особь мира (private в классе): следопыты считают из костей мира — ctx = null. */
type TrackWorld = World;
const C = (w: World) => w as unknown as { ctx: Creature | null };

const plural = (n: number, a: string, b: string, c: string) => {
  const m = n % 100, k = n % 10;
  return m >= 11 && m <= 14 ? c : k === 1 ? a : k >= 2 && k <= 4 ? b : c;
};

/** Пеший: не плавает через мелководье (swim ≤ 0.15), не летает, не донный. */
export function walker(w: World, c: Creature): boolean {
  if (c.g.swim > 0.15) return false;
  if (!w.oe) return true;
  const ph = c.g.ph;
  return ph[P.FLY] < 1 && ph[P.BENTH] <= 0;
}

/** Летун (только при открытой эволюции). */
const flyer = (w: World, c: Creature) => w.oe && c.g.ph[P.FLY] >= 1;

/** Сторона закрытого барьера для клетки суши: по оси пролива (0 — север/запад, 1 — юг/восток), −1 — вода или сам пролив. */
function isoSide(w: World, s: SillRec, cell: number): -1 | 0 | 1 {
  const t = w.terrain;
  if (t.biome[cell] <= B.Shallow) return -1;
  return sillSide(s, ((cell % t.cols) + 0.5) * w.cell, (Math.floor(cell / t.cols) + 0.5) * w.cell);
}

/** Барьер закрыт — моста нет (s.open считает живой пересчёт: якоря берегов на одном материке). */
const closed = (_lm: Int16Array, s: SillRec) => !s.open;

const median = (a: number[]) => {
  if (!a.length) return 0;
  a.sort((x, y) => x - y);
  return a[a.length >> 1];
};

/** Не чаще раза в LOG_GAP тактов (необязательные строки). */
function quiet(g: GeoState, w: World): boolean {
  if (w.tick - g.lastLogT < GEO.LOG_GAP) return true;
  g.lastLogT = w.tick;
  return false;
}

// ---------------- материк вида ----------------

/** Species.home — материк с наибольшим числом особей (после каждого живого пересчёта и раз в 200 тактов). */
export function updateHomes(w: World): void {
  const lm = w.lm;
  if (!lm) return;
  const t = w.terrain;
  const cnt = new Map<number, Map<number, number>>();
  for (const c of w.creatures) {
    if (!c.alive) continue;
    const L = lm[t.index(c.x, c.y)];
    let m = cnt.get(c.sp);
    if (!m) cnt.set(c.sp, (m = new Map()));
    m.set(L, (m.get(L) ?? 0) + 1);
  }
  for (const [id, m] of cnt) {
    const sp = w.species.all.get(id);
    if (!sp) continue;
    let best = -1, bn = -1;
    for (const [L, n] of m) if (n > bn || (n === bn && L < best)) { bn = n; best = L; }
    sp.home = best;
  }
}

/** Материк в точке (−1 — вода или маленький остров). */
export function landAt(w: World, x: number, y: number): number {
  return w.lm ? w.lm[w.terrain.index(x, y)] : -1;
}

// ---------------- половины вида (IsoRec) ----------------

/** Записи по виду (производное от массива isolates; кэш по самому массиву — меняем массив целиком). */
const bySpCache = new WeakMap<IsoRec[], Map<number, IsoRec[]>>();
function recsOf(g: GeoState, sp: number): IsoRec[] | undefined {
  let m = bySpCache.get(g.isolates);
  if (!m) {
    m = new Map();
    for (const r of g.isolates) {
      const l = m.get(r.sp);
      if (l) l.push(r);
      else m.set(r.sp, [r]);
    }
    bySpCache.set(g.isolates, m);
  }
  return m.get(sp);
}

/**
 * Рождение (из breed, только при lp) — здесь и измеряется поток генов: детёныш, у которого мать или отец «с той
 * стороны» (переплыли барьер), — утечка генов, счёт поколений врозь заново. Метка детёныша — сторона, где он родился.
 */
export function isoBirth(w: World, a: Creature, b: Creature | null, child: Creature): void {
  const g = w.geo;
  if (!g || !g.isolates.length || child.sp !== a.sp) return;
  const L = recsOf(g, a.sp);
  if (!L) return;
  const cell = w.terrain.index(child.x, child.y);
  for (const r of L) {
    const s = g.sills[r.sill];
    const ta = r.tag.get(a.id);
    const tb = b ? r.tag.get(b.id) : undefined;
    const here = s ? isoSide(w, s, cell) : -1;
    const side = here >= 0 ? (here as 0 | 1) : ta;
    if (side === undefined) continue;
    r.tag.set(child.id, side);
    if ((ta !== undefined && ta !== side) || (tb !== undefined && tb !== side)) leak(g, r);
  }
}

function leak(g: GeoState, r: IsoRec): void {
  r.leak++;
  r.dirty = true;
  g.stats.leaks++;
}

/** Средний геном группы (гены — среднее, окраска — круговое среднее; остальное — от первого). */
function meanGenome(list: Creature[]): Genome {
  const g: Genome = { ...list[0].g, brain: null };
  const G = g as unknown as Record<string, number>;
  for (const k of GENE_KEYS) {
    let s = 0;
    for (const c of list) s += c.g[k];
    G[k] = s / list.length;
  }
  let sx = 0, sy = 0, pat = 0;
  for (const c of list) {
    sx += Math.cos((c.g.hue * Math.PI) / 180);
    sy += Math.sin((c.g.hue * Math.PI) / 180);
    pat += c.g.pattern;
  }
  g.hue = (((Math.atan2(sy, sx) * 180) / Math.PI) % 360 + 360) % 360;
  g.pattern = pat / list.length;
  return g;
}

/** Обход половин (раз в 200 тактов): метки, утечки, поколения врозь, расхождение; разделение; новые записи. */
function isoSweep(w: TrackWorld): void {
  const g = w.geo!, lm = w.lm!, t = w.terrain;
  const bySp = new Map<number, Creature[]>();
  for (const c of w.creatures) {
    if (!c.alive) continue;
    const l = bySp.get(c.sp);
    if (l) l.push(c);
    else bySp.set(c.sp, [c]);
  }
  const keep: IsoRec[] = [];
  let changed = false;
  for (const r of g.isolates) {
    const s = g.sills[r.sill];
    const sp = w.species.all.get(r.sp);
    const mem = bySp.get(r.sp);
    if (!s || !sp || sp.extinct !== null || !mem || !closed(lm, s)) {
      changed = true;
      continue;
    }
    const side: Creature[][] = [[], []];
    const gens: number[][] = [[], []];
    const alive = new Set<number>();
    for (const c of mem) {
      alive.add(c.id);
      const sd = isoSide(w, s, t.index(c.x, c.y));
      let tg = r.tag.get(c.id);
      if (tg === undefined) {
        if (sd < 0) continue;
        r.tag.set(c.id, (tg = sd as 0 | 1));
      }
      // переплывший барьер остаётся со своей меткой: утечка — когда (и если) он оставит потомство на чужой стороне
      if (sd !== tg) continue;
      side[tg].push(c);
      if (walker(w, c)) gens[tg].push(c.generation);
    }
    for (const id of r.tag.keys()) if (!alive.has(id)) r.tag.delete(id);
    r.parts = [side[0].length, side[1].length];
    if (gens[0].length < GEO.ISO_KEEP || gens[1].length < GEO.ISO_KEEP) {
      changed = true; // одна из половин почти исчезла — следить не за чем
      continue;
    }
    const m0 = median(gens[0]), m1 = median(gens[1]);
    if (r.dirty) {
      r.dirty = false;
      r.gen0 = [m0, m1];
      r.half = false;
      if (!r.mixLogged && !quiet(g, w)) {
        r.mixLogged = true;
        w.log(`🔀 Половины «${sp.name}» снова встретились — гены смешались, счёт поколений врозь начат заново`, 'species', undefined, undefined, 'geo_hybrid');
      }
    }
    r.ga = Math.max(0, Math.min(m0 - r.gen0[0], m1 - r.gen0[1]));
    r.d = distance(meanGenome(side[0]), meanGenome(side[1]), w.species.bodyW) / SPECIES_LIMIT;
    // подвиды — не только время врозь, но и заметная разница (половина нужного для нового вида)
    if (!r.half && r.ga >= GEO.ISO_GEN / 2 && r.d >= GEO.ISO_D / 2) {
      r.half = true;
      if (!r.founder && !quiet(g, w)) w.log(`🧬 Половины «${sp.name}» живут врозь уже ${r.ga} ${plural(r.ga, 'поколение', 'поколения', 'поколений')}, и гены разошлись на ${Math.round(100 * r.d)}% — это уже подвиды`, 'species', undefined, undefined, 'geo_subspecies');
    }
    if (r.ga >= GEO.ISO_GEN && r.d >= GEO.ISO_D) {
      split(w, r, s, side);
      changed = true;
      continue;
    }
    keep.push(r);
  }
  // новые записи: вид с ≥ ISO_MIN пешими на каждой стороне закрытого барьера, за которым ещё не следим
  const fresh: { s: SillRec; names: string[] }[] = [];
  g.sills.forEach((s, si) => {
    if (!closed(lm, s)) return;
    const cnt = new Map<number, [number, number]>();
    for (const c of w.creatures) {
      if (!c.alive || !walker(w, c)) continue;
      const sd = isoSide(w, s, t.index(c.x, c.y));
      if (sd < 0) continue;
      let v = cnt.get(c.sp);
      if (!v) cnt.set(c.sp, (v = [0, 0]));
      v[sd as 0 | 1]++;
    }
    const names: string[] = [];
    for (const [id, v] of [...cnt].sort((x, y) => x[0] - y[0])) {
      if (v[0] < GEO.ISO_MIN || v[1] < GEO.ISO_MIN) continue;
      if (keep.some((r) => r.sp === id && r.sill === si)) continue;
      const sp = w.species.all.get(id);
      if (!sp || sp.extinct !== null) continue;
      const tag = new Map<number, 0 | 1>();
      const gens: number[][] = [[], []];
      for (const c of bySp.get(id) ?? []) {
        const sd = isoSide(w, s, t.index(c.x, c.y));
        if (sd < 0) continue;
        tag.set(c.id, sd as 0 | 1);
        if (walker(w, c)) gens[sd].push(c.generation);
      }
      keep.push({ sp: id, t: w.tick, sill: si, parts: [v[0], v[1]], gen0: [median(gens[0]), median(gens[1])], ga: 0, d: 0, half: false, tag, leak: 0, dirty: false, mixLogged: false, founder: s.kind === 'wallace' && w.tick <= 1000 });
      names.push(sp.name);
      changed = true;
    }
    if (names.length) fresh.push({ s, names });
  });
  if (changed) g.isolates = keep;
  for (const { s, names } of fresh) {
    if (s.kind === 'wallace' && w.tick <= 1000) continue; // основатели за проливом Уоллеса — без строки на каждый вид
    const [a, b] = sideWords(s);
    w.log(`🌊 Пролив ${s.name} разделил ${names.length === 1 ? `«${names[0]}»` : `${names.length} ${plural(names.length, 'вид', 'вида', 'видов')}`}: у половин на ${a}е и на ${b}е теперь своя судьба`, 'species', undefined, undefined, 'geo_vicariance');
  }
  // сводка разделений основателей за Уоллесом — не чаще раза в полгода
  if (g.wsplit.length && w.tick - g.wLogT >= YEAR / 2) {
    const s = g.sills.find((x) => x.kind === 'wallace');
    const k = g.wsplit.length;
    w.log(`🌿 За проливом ${s?.name ?? 'Уоллеса'} обособились ${k} ${plural(k, 'вид', 'вида', 'видов')}: ${g.wsplit.slice(0, 3).map((n) => `«${n}»`).join(', ')}${k > 3 ? ` и ещё ${k - 3}` : ''}`, 'species', undefined, undefined, 'geo_vicariance');
    g.wsplit = [];
    g.wLogT = w.tick;
  }
}

/** Меньшая половина — новый вид (метки особей и предков, больных — вылечить: болезни привязаны к виду). */
function split(w: TrackWorld, r: IsoRec, s: SillRec, side: Creature[][]): void {
  const g = w.geo!;
  const parent = w.species.all.get(r.sp)!;
  const k = side[0].length <= side[1].length ? 0 : 1;
  const part = side[k], other = side[1 - k];
  let px = 0, py = 0, ox = 0, oy = 0;
  for (const c of part) { px += c.x; py += c.y; }
  for (const c of other) { ox += c.x; oy += c.y; }
  px /= part.length; py /= part.length; ox /= other.length; oy /= other.length;
  const dir = Math.abs(py - oy) >= Math.abs(px - ox) ? (py < oy ? 'северный' : 'южный') : px < ox ? 'западный' : 'восточный';
  const origin = w.terrain.regionAt(px, py)?.name ?? 'остров';
  const saved = C(w).ctx;
  C(w).ctx = null; // имя — из костей мира
  const sp = w.species.create(meanGenome(part), parent.id, w.tick, origin);
  C(w).ctx = saved;
  sp.name = `${parent.name} (${dir})`;
  sp.announced = true;
  sp.x = px;
  sp.y = py;
  sp.home = w.lm![w.terrain.index(px, py)];
  for (const c of part) {
    c.sp = sp.id;
    const a = w.ancestors.get(c.id);
    if (a) a.sp = sp.id;
    if (c.sick > 0) {
      c.sick = 0;
      c.immune = DIS.IMM;
    }
  }
  sp.count = part.length;
  g.stats.splits++;
  g.stats.vicariance++;
  if (s.kind === 'sill') g.stats.sSill++;
  else if (s.kind === 'wallace') g.stats.sWall++;
  else g.stats.sPlay++;
  if (r.founder) g.wsplit.push(sp.name);
  else w.log(`🌿 Викарианс: «${parent.name}» и «${sp.name}» — теперь два вида (пролив ${s.name}, ${r.ga} ${plural(r.ga, 'поколение', 'поколения', 'поколений')} врозь, гены разошлись на ${Math.round(100 * r.d)}%)`, 'species', px, py, 'geo_vicariance');
}

/** Барьер открылся (мост): половины снова вместе — записи забыты. */
function dropIsolates(w: World, si: number): void {
  const g = w.geo!;
  const gone = g.isolates.filter((r) => r.sill === si);
  if (!gone.length) return;
  g.isolates = g.isolates.filter((r) => r.sill !== si);
  const names = gone.map((r) => w.species.all.get(r.sp)?.name).filter((n): n is string => !!n);
  if (names.length)
    w.log(`🔀 Мост вернулся раньше: ${names.length === 1 ? `«${names[0]}» снова один вид` : `${names.length} ${plural(names.length, 'вид', 'вида', 'видов')} снова едины — половины не успели разойтись`}`, 'species', undefined, undefined, 'geo_hybrid');
}

// ---------------- мосты (BridgeRec) ----------------

/** Порог si стал перешейком (из живого пересчёта): новая запись моста, половины — забыты. */
export function bridgeOpened(w: World, si: number): void {
  const g = w.geo!;
  dropIsolates(w, si);
  const s = g.sills[si];
  const nat = new Map<number, 0 | 1>();
  const cnt = new Map<number, [number, number]>();
  for (const c of w.creatures) {
    if (!c.alive || c.g.swim > 0.6) continue;
    const sd = sillSide(s, c.x, c.y);
    if (sd < 0) continue;
    let v = cnt.get(c.sp);
    if (!v) cnt.set(c.sp, (v = [0, 0]));
    v[sd as 0 | 1]++;
  }
  let a = 0, b = 0;
  for (const [id, v] of [...cnt].sort((x, y) => x[0] - y[0])) {
    const sd = v[0] >= v[1] ? 0 : 1;
    nat.set(id, sd);
    if (sd === 0) a++;
    else b++;
  }
  g.bridges = [...g.bridges.filter((r) => r.reported || r.sill !== si), { sill: si, open: w.tick, close: null, a, b, cross: [0, 0], fly: 0, seen: new Set(), nat, invaders: [], lost: [], reported: false }];
  if (g.bridges.length > 12) g.bridges = g.bridges.slice(-12);
}

/** Перешеек ушёл под воду: запись закрыта, сводка (если ещё не было). */
export function bridgeClosed(w: World, si: number): void {
  const g = w.geo!;
  for (const r of g.bridges) {
    if (r.sill !== si || r.close !== null) continue;
    r.close = w.tick;
    if (!r.reported) report(w, r);
  }
}

/** Обход мостов (раз в 200 тактов): переходы, пришельцы, вымершие местные; сводка через 2 года. */
function bridgeSweep(w: World): void {
  const g = w.geo!;
  for (const r of g.bridges) {
    if (r.close !== null || r.reported) continue;
    const s = g.sills[r.sill];
    if (!s) continue;
    const foreign = new Map<number, number>();
    const cnt = new Map<number, [number, number]>();
    for (const c of w.creatures) {
      if (!c.alive || c.g.swim > 0.6) continue;
      const sd = sillSide(s, c.x, c.y);
      if (sd < 0) continue;
      let v = cnt.get(c.sp);
      if (!v) cnt.set(c.sp, (v = [0, 0]));
      v[sd as 0 | 1]++;
    }
    // новые виды у моста — родом с той стороны, где их больше
    for (const [id, v] of [...cnt].sort((x, y) => x[0] - y[0])) if (!r.nat.has(id)) r.nat.set(id, v[0] >= v[1] ? 0 : 1);
    for (const c of w.creatures) {
      if (!c.alive || c.g.swim > 0.6) continue;
      const sd = sillSide(s, c.x, c.y), nat = r.nat.get(c.sp);
      if (sd < 0 || nat === undefined || sd === nat) continue;
      // ♾️ летуны пролив перелетают и без моста: пришельцами через мост не считаются (только в счёт «и N летунов»)
      const fl = flyer(w, c);
      if (!fl) foreign.set(c.sp, (foreign.get(c.sp) ?? 0) + 1);
      if (!r.seen.has(c.id) && r.seen.size < 2000) {
        r.seen.add(c.id);
        if (fl) r.fly++;
        else r.cross[nat]++;
      }
    }
    // пришельцы: ≥ INVADE_N особей за мостом не меньше INVADE_T тактов
    const inv: BridgeRec['invaders'] = [];
    for (const v of r.invaders) {
      const n = foreign.get(v.sp) ?? 0;
      if (v.t >= 0 || n >= GEO.INVADE_N) inv.push(v);
    }
    for (const [id, n] of [...foreign].sort((x, y) => x[0] - y[0])) {
      if (n < GEO.INVADE_N || inv.some((v) => v.sp === id)) continue;
      inv.push({ sp: id, from: r.nat.get(id)!, t: -1, since: w.tick });
    }
    for (const v of inv) {
      if (v.t >= 0 || w.tick - v.since < GEO.INVADE_T) continue;
      v.t = w.tick;
      g.stats.invaders++;
      const sp = w.species.all.get(v.sp);
      const from = sideWords(s, true)[v.from];
      if (sp && !quiet(g, w)) w.log(`🌉 «${sp.name}» с ${from} прижились по ту сторону перешейка ${s.name}`, 'migration', undefined, undefined, 'geo_gabi');
    }
    r.invaders = inv;
    // вымершие местные: вид вымер, когда на его сторону уже прижился пришелец
    for (const [id, sd] of r.nat) {
      const sp = w.species.all.get(id);
      if (!sp || sp.extinct === null || sp.extinct < r.open || r.lost.includes(id)) continue;
      if (r.invaders.some((v) => v.t >= 0 && v.from !== sd)) r.lost.push(id);
    }
    if (w.tick - r.open >= 2 * YEAR) report(w, r);
  }
}

function report(w: World, r: BridgeRec): void {
  const g = w.geo!, s = g.sills[r.sill];
  r.reported = true;
  const est = r.invaders.filter((v) => v.t >= 0);
  const k0 = est.filter((v) => v.from === 0).length, k1 = est.length - k0;
  const [a, b] = sideWords(s, true);
  const L = r.lost.length;
  w.log(`🌎 Великий обмен через перешеек ${s.name}: с ${a} ${plural(k0, 'прижился', 'прижились', 'прижились')} ${k0} ${plural(k0, 'вид', 'вида', 'видов')}, с ${b} — ${k1}; перешли ${r.cross[0]} и ${r.cross[1]} ${plural(r.cross[1], 'зверь', 'зверя', 'зверей')}${r.fly ? ` (и ${r.fly} ${plural(r.fly, 'летун', 'летуна', 'летунов')})` : ''}; ${L ? `${plural(L, 'вымер', 'вымерли', 'вымерли')} ${L} ${plural(L, 'местный вид', 'местных вида', 'местных видов')}` : 'местные устояли'}`, 'milestone', undefined, undefined, 'geo_gabi');
}

// ---------------- рефугиумы, ареалы, морены ----------------

let refBuf: { lab: Int32Array; q: Int32Array } | null = null;

/** На пике ледниковья: связные клочки обитаемой суши (лёд < 0.25, тепло), где живут ≥ 20 зверей суши. */
export function refugiaAtMax(w: World): void {
  const g = w.geo!, t = w.terrain, H = w.ice!;
  const n = t.cols * t.rows, cols = t.cols;
  if (!refBuf || refBuf.lab.length !== n) refBuf = { lab: new Int32Array(n), q: new Int32Array(n) };
  const { lab, q } = refBuf;
  const sh = g.geoShift + w.climate.shift;
  const ok = (i: number) => t.biome[i] > B.Shallow && H[i] < 0.25 && t.baseTemp[i] + sh > 0.03;
  lab.fill(-1);
  const comps: { cells: number[] }[] = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (lab[s0] !== -1 || !ok(s0)) continue;
    const id = comps.length;
    let qt = 0;
    q[qt++] = s0;
    lab[s0] = id;
    for (let qh = 0; qh < qt; qh++) {
      const i = q[qh], x = i % cols;
      for (const j of [x > 0 ? i - 1 : -1, x < cols - 1 ? i + 1 : -1, i - cols, i + cols]) {
        if (j < 0 || j >= n || lab[j] !== -1 || !ok(j)) continue;
        lab[j] = id;
        q[qt++] = j;
      }
    }
    comps.push({ cells: Array.from(q.subarray(0, qt)) });
  }
  const crit = comps.map(() => 0), spc = comps.map(() => new Map<number, number>());
  for (const c of w.creatures) {
    if (!c.alive || c.g.swim > 0.6) continue;
    const L = lab[t.index(c.x, c.y)];
    if (L < 0) continue;
    crit[L]++;
    spc[L].set(c.sp, (spc[L].get(c.sp) ?? 0) + 1);
  }
  const out: RefRec[] = [];
  comps.forEach((cp, k) => {
    if (crit[k] < 20) return;
    const rc = new Map<number, number>();
    for (const i of cp.cells) {
      const r = t.region[i];
      if (r >= 0) rc.set(r, (rc.get(r) ?? 0) + 1);
    }
    let best = -1, bn = 0;
    for (const [r, m] of rc) if (m > bn || (m === bn && r < best)) { bn = m; best = r; }
    const regions = [...rc].filter(([, m]) => m >= 0.05 * cp.cells.length).map(([r]) => r).sort((a, b) => a - b);
    const species = [...spc[k]].filter(([, m]) => m >= 3).map(([id]) => id).sort((a, b) => a - b);
    out.push({ region: best, lm: cp.cells[0], species, n: crit[k], regions });
  });
  out.sort((a, b) => b.n - a.n);
  g.refugia = out.slice(0, 8);
  g.refT = w.tick;
  g.stats.refugia += g.refugia.length;
  if (!g.refugia.length) return;
  const names = g.refugia.slice(0, 4).map((r) => `«${t.regions[r.region]?.name ?? 'безымянный край'}» (${r.species.length} ${plural(r.species.length, 'вид', 'вида', 'видов')})`);
  w.log(`🏔 ${g.refugia.length === 1 ? 'Рефугиум' : 'Рефугиумы'} ледниковья: ${names.join(', ')}${g.refugia.length > 4 ? ` и ещё ${g.refugia.length - 4}` : ''}`, 'info', undefined, undefined, 'geo_refugia');
}

/** Северная граница ареала: 10-й процентиль y особей суши вида (null — меньше 30 особей). */
function northEdge(w: World, sp: number): number | null {
  const ys: number[] = [];
  for (const c of w.creatures) if (c.alive && c.sp === sp && c.g.swim <= 0.6) ys.push(c.y);
  if (ys.length < 30) return null;
  ys.sort((a, b) => a - b);
  return ys[Math.floor(0.1 * ys.length)];
}

/** Начало ледниковья: запомнить северные границы видов с ≥ 30 особями суши. */
export function rangeOnGlacial(w: World): void {
  const g = w.geo!;
  const ref: [number, number][] = [];
  for (const sp of w.species.all.values()) {
    if (sp.extinct !== null) continue;
    const e = northEdge(w, sp.id);
    if (e !== null) ref.push([sp.id, e]);
  }
  g.rangeRef = ref;
  g.wide = [];
}

/** Раз в 1000 тактов в ледниковье: ареалы, отступившие на юг на ≥ 300 км (1 ед. карты ≈ 1 км) — в летопись. */
function rangeSweep(w: World): void {
  const g = w.geo!;
  if (g.phase === 0 || !g.rangeRef.length) return;
  const moved: [string, number][] = [];
  for (const [id, e0] of g.rangeRef) {
    if (g.wide.includes(id)) continue;
    const sp = w.species.all.get(id);
    if (!sp || sp.extinct !== null) continue;
    const e = northEdge(w, id);
    if (e === null || e - e0 < 300) continue;
    g.wide = [...g.wide, id];
    moved.push([sp.name, Math.round((e - e0) / 10) * 10]);
  }
  if (!moved.length) return;
  w.log(moved.length === 1 ? `🧭 Ареал «${moved[0][0]}» отступил на юг на ${moved[0][1]} км` : `🧭 Ареалы отступают на юг: ${moved.slice(0, 3).map(([n, km]) => `«${n}» на ${km} км`).join(', ')}${moved.length > 3 ? ` и ещё ${moved.length - 3}` : ''}`, 'migration', undefined, undefined, 'geo_rangeshift');
}

/** Межледниковье вернулось: кто снова дошёл до прежней северной границы. */
export function rangeOnInterglacial(w: World): void {
  const g = w.geo!;
  const back: string[] = [];
  for (const id of g.wide) {
    const ref = g.rangeRef.find((r) => r[0] === id);
    const sp = w.species.all.get(id);
    if (!ref || !sp || sp.extinct !== null) continue;
    const e = northEdge(w, id);
    if (e !== null && e - ref[1] < 150) back.push(sp.name);
  }
  if (back.length) w.log(`🧭 Лёд ушёл — на север вернулись ${back.slice(0, 3).map((n) => `«${n}»`).join(', ')}${back.length > 3 ? ` и ещё ${back.length - 3}` : ''}`, 'migration', undefined, undefined, 'geo_rangeshift');
  g.rangeRef = [];
  g.wide = [];
}

/** На пике ледниковья: морены — суша на краю льда (толще MOR_HI внутри, тоньше MOR_LO снаружи); бит 0 плоскости морен. */
export function meltOnMax(w: World): void {
  const g = w.geo!, M = w.iceMax!, F = w.fx8!, t = w.terrain;
  const n = M.length, cols = t.cols, o = 3 * n;
  const hi = Math.round(255 * GEO.MOR_HI);
  let k = 0;
  const reg = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (M[i] < hi || t.biome[i] <= B.Shallow) continue;
    const x = i % cols;
    // край толстого льда: сосед, куда лёд толще MOR_HI не дошёл (вал — на внешней кромке)
    const edge = (x > 0 && M[i - 1] < hi) || (x < cols - 1 && M[i + 1] < hi) || (i >= cols && M[i - cols] < hi) || (i + cols < n && M[i + cols] < hi);
    if (!edge || F[o + i] & 1) continue;
    F[o + i] |= 1;
    k++;
    const r = t.region[i];
    if (r >= 0) reg.set(r, (reg.get(r) ?? 0) + 1);
  }
  g.stats.moraines += k;
  if (!k) return;
  let best = -1, bn = 0;
  for (const [r, m] of reg) if (m > bn || (m === bn && r < best)) { bn = m; best = r; }
  const name = t.regions[best]?.name;
  w.log(`🪨 Ледник оставил морену${name ? ` у «${name}»` : ''}: вал из камней там, докуда дошёл лёд`, 'info', undefined, undefined, 'geo_moraine');
}

// ---------------- раз в 200 тактов ----------------

/** Следопыты живой планеты (из record, раз в 200 тактов): материки видов, половины, мосты; раз в 1000 — ареалы. */
export function geoTrack(w: World): void {
  const saved = C(w).ctx;
  C(w).ctx = null;
  updateHomes(w);
  isoSweep(w);
  bridgeSweep(w);
  if (w.tick % 1000 === 0) rangeSweep(w);
  C(w).ctx = saved;
}

/** Причина для «бутылочного горлышка» под живой планетой: глубокое ледниковье или катастрофа недавно. */
export function geoCause(w: World): boolean {
  const g = w.geo;
  if (!g) return false;
  return g.Vg > 0.6 || g.aer > 0.3 || g.dark > 0 || w.tick - g.lastCause < 2000;
}
