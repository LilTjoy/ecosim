// ⏪ Машина времени: точный снимок мира и восстановление из него (без DOM — общий для страницы, стенда и воркера).
// Снимок — это колонки типизированных массивов (особи, геномы, предки, туши, клетки) плюс ОДИН structuredClone
// всех прочих значений (Map, Set, −0, NaN и общие ссылки сохраняются). Колонки хранятся по именам — новые гены
// и поля особи (открытая эволюция) добавляются в списки ниже, а старые снимки получают значения по умолчанию.
import type { Ancestor, BrainMode, Corpse, Creature, CreatureInit, Sample, State, SurfaceEnv, World } from './world';
import { GENE_KEYS, genome, type Genome } from './genome';
import { WEIGHTS } from './brain';
import { mix32 } from '../lib/random';
import type { SpeciesSave } from './species';
import type { Terrain } from './terrain';

export const SNAP_VERSION = 1;

export interface WorldSnap {
  v: number;
  tick: number;
  seed: number;
  salt: number;
  mode: BrainMode;
  env: SurfaceEnv;
  dims: [number, number, number];
  /** ОДИН structuredClone ключей SNAP_CLONE + { species: реестр видов }. */
  scal: Record<string, unknown>;
  /** Копии клеточных полей SNAP_CELLS. */
  cells: Record<string, Float32Array>;
  /** Только записи с claimTick ≥ tick − 1 (остальные симуляция не читает — кодирование точное). */
  claim: { idx: Int32Array; val: Float32Array; t: Int32Array };
  cre: { n: number; f64cols: string[]; i32cols: string[]; f64: Float64Array; i32: Int32Array; cause: (string | null)[]; ghost: 0 | 1 };
  /** Геномы (cols по имени); brain — номер мозга или −1; brains — веса подряд по blen. */
  gen: { cols: string[]; f64: Float64Array; brain: Int32Array; brains: Float32Array; blen: number };
  /** 7 чисел на предка: id, mother|NaN, sp, номер генома, generation, born, died|NaN — в порядке Map. */
  anc: Float64Array;
  /** CORPSE_F.length чисел на тушу (sick → 0/1). */
  corpses: Float64Array;
  /** Особые значения, закодированные числами (ссылки на рельеф — флагами). */
  ext: Record<string, number>;
  /** Курсоры записи действий и ввода ветки (заполняет Timeline). */
  actN: number;
  inN: number;
  digest: number;
  bytes: number;
}

// ---------------- списки полей (проверяются при компиляции и при запуске) ----------------

export const STATES = ['wander', 'graze', 'flee', 'hunt', 'mate', 'scavenge', 'migrate', 'herd', 'swim', 'rest'] as const satisfies readonly State[];
export const _stateCheck: [Exclude<State, (typeof STATES)[number]>] extends [never] ? true : never = true;

export const CRE_F64 = ['x', 'y', 'heading', 'v', 'energy', 'pv', 'reachK', 'fe', 'gx', 'gy', 'dung', 'vir', 'beta'] as const satisfies readonly (keyof Creature)[];
export const CRE_I32 = ['id', 'sp', 'age', 'generation', 'mother', 'father', 'children', 'kills', 'cooldown', 'cooldownHunt',
  'gt', 'lonely', 'pack', 'alarm', 'sick', 'immune', 'rs', 'dph', 'state', 'gi', 'flags'] as const;
//  state = номер в STATES; gi = номер генома; flags = 1 жив | 2 игрок; mother/father null → −1
export const _creI32Check: [Exclude<(typeof CRE_I32)[number], keyof Creature | 'gi' | 'flags'>] extends [never] ? true : never = true;
type CreDone = (typeof CRE_F64)[number] | (typeof CRE_I32)[number] | 'g' | 'alive' | 'player' | 'cause' | 'activations';
export const _creCheck: [Exclude<keyof Creature, CreDone>] extends [never] ? true : ['Поля особи не попали в снимок', Exclude<keyof Creature, CreDone>] = true;

export const CORPSE_F = ['x', 'y', 'energy', 'size', 'hue', 'age', 'idx', 'e0', 'sp', 'sick'] as const satisfies readonly (keyof Corpse)[];
export const _corpseCheck: [Exclude<keyof Corpse, (typeof CORPSE_F)[number]>] extends [never] ? true : never = true;

export const GEN_F = [...GENE_KEYS, 'hue', 'pattern'] as const satisfies readonly (keyof Genome)[];
export const _genCheck: [Exclude<keyof Genome, (typeof GEN_F)[number] | 'brain'>] extends [never] ? true : never = true;

export const ANC_F = 7;
export const _ancCheck: [Exclude<keyof Ancestor, 'id' | 'mother' | 'sp' | 'g' | 'generation' | 'born' | 'died'>] extends [never] ? true : never = true;

export const SNAP_CELLS = ['grass', 'browse', 'forage', 'soil', 'litter', 'mic', 'fix', 'myc', 'act', 'nut'] as const;
export const SNAP_CLONE = ['tick', 'drought', 'seed', 'salt', 'rng', 'nextId', 'shiftNow', 'birch', 'corpseRef', 'nutRef', 'nutAcc', 'nutGrow',
  'flux', 'fluxEma', 'micro', 'boneMarks', 'playerStats', 'settings', 'brainMode', 'input', 'web', 'deaths', 'crowdRisk', 'events',
  'pathogens', 'outbreaks', 'sickRisk', 'healthyRisk', 'meanV2', 'boost', 'nextPath', 'fizzleLogged', 'bloomMin', 'bloomYear',
  'experiment', 'blocked', 'climate'] as const; // уроки: experiment (без разложителей), blocked (опыт Гаузе); climate — «Что если» климата
export const SNAP_SPECIAL = ['creatures', 'corpses', 'ancestors', 'species', 'claim', 'claimTick', 'player', 'history', 'blockedTerrain'] as const;
/** Статичное (из seed, env и размеров), временное или служебное для уроков. */
export const SNAP_SKIP = ['terrain', 'width', 'height', 'cell', 'env', 'grid', 'corpseGrid', 'gw', 'gh', 'nin', 'nout',
  'microBase', 'leachK', 's0', 'isWater', 'fx', 'ctx', 'lessonTerrain', 'lessonGen'] as const;

/** Поля World, о которых снимок не знает (методы и подмены функций стенда пропускаются). */
export function uncoveredKeys(w: World): string[] {
  const all = new Set<string>([...SNAP_CELLS, ...SNAP_CLONE, ...SNAP_SPECIAL, ...SNAP_SKIP]);
  const W = w as unknown as Record<string, unknown>;
  return Object.keys(w).filter((k) => !all.has(k) && typeof W[k] !== 'function');
}

/** Внутренности World, которые снимку нужны (в классе они private). */
export type WorldInternals = { [K in keyof World]: World[K] } & {
  claim: Float32Array;
  claimTick: Int32Array;
  ctx: Creature | null;
  nextId: number;
  blockedTerrain?: Terrain | null;
  makeCreature(o: CreatureInit): Creature;
  buildHash(): void;
};

// ---------------- режим проверок и замечания ----------------

/** strict: стенд и dev-сборка — бросать исключение при непокрытом поле или дробном значении целой колонки. */
export const SNAP_DEV = { strict: false };
const problems = new Set<string>();
/** Что пошло не так со снимками (в проде машина времени по этому списку выключается). */
export function snapshotProblems(): string[] {
  return [...problems];
}
function problem(msg: string): void {
  if (SNAP_DEV.strict) throw new Error(msg);
  problems.add(msg);
}
const checked = new WeakSet<object>();

// ---------------- пул буферов клеток ----------------

const pool: Float32Array[] = [];
/** Отдать буферы клеток вытесненного снимка — следующий снимок их переиспользует (меньше мусора и пауз). */
export function recycleSnap(s: WorldSnap): void {
  for (const k in s.cells) if (pool.length < 24) pool.push(s.cells[k]);
  s.cells = {};
}
function copyCells(src: Float32Array): Float32Array {
  for (let i = pool.length - 1; i >= 0; i--) {
    if (pool[i].length === src.length) {
      const b = pool[i];
      pool[i] = pool[pool.length - 1];
      pool.pop();
      b.set(src);
      return b;
    }
  }
  return src.slice();
}

/** Буферы снимка — передать в postMessage без копирования (воркер → страница). */
export function snapBuffers(s: WorldSnap): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (a: ArrayBufferView) => out.add(a.buffer as ArrayBuffer);
  for (const k in s.cells) add(s.cells[k]);
  for (const a of [s.claim.idx, s.claim.val, s.claim.t, s.cre.f64, s.cre.i32, s.gen.f64, s.gen.brain, s.gen.brains, s.anc, s.corpses]) add(a);
  return [...out];
}

// ---------------- отпечаток ----------------

/** FNV-1a по 32-битным словам. */
function fnv(h: number, a: ArrayBufferView): number {
  const u = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
  return h;
}

/** Отпечаток снимка — только по колонкам снимка (не по «сырым» массивам мира). */
export function snapDigest(s: WorldSnap): number {
  let h = 0x811c9dc5 | 0;
  h = fnv(h, s.cre.f64);
  h = fnv(h, s.cre.i32);
  h = fnv(h, s.gen.f64);
  h = fnv(h, s.gen.brains);
  h = fnv(h, s.anc);
  h = fnv(h, s.corpses);
  for (const k of SNAP_CELLS) if (s.cells[k]) h = fnv(h, s.cells[k]);
  h = fnv(h, s.claim.idx);
  h = fnv(h, s.claim.val);
  h = fnv(h, s.claim.t);
  h = fnv(h, new Float64Array([s.tick, (s.scal.rng as number) ?? 0]));
  return h >>> 0;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

/** Условия, от которых зависят рельеф и статичные поля почвы: снимок встаёт только в такой же мир. */
export function sameWorld(w: World, s: WorldSnap): boolean {
  return w.seed === s.seed && w.width === s.dims[0] && w.height === s.dims[1] && w.cell === s.dims[2] && JSON.stringify(w.env) === JSON.stringify(s.env);
}

// ---------------- снимок ----------------

export function captureWorld(w: WorldInternals): WorldSnap {
  const W = w as unknown as Record<string, unknown>;
  if (!checked.has(w)) {
    checked.add(w);
    const miss = uncoveredKeys(w as unknown as World);
    if (miss.length) problem(`Новое поле World.${miss.join(', World.')} не попало в снимок`);
  }
  // геномы: сначала особей, потом предков (живые особи — тоже предки и делят с ними геном)
  const gIdx = new Map<Genome, number>();
  const genomes: Genome[] = [];
  const gi = (g: Genome): number => {
    let k = gIdx.get(g);
    if (k === undefined) {
      k = genomes.length;
      gIdx.set(g, k);
      genomes.push(g);
    }
    return k;
  };
  // особи в порядке обработки; мёртвый игрок (для экрана династии) — лишней строкой в конце
  const rows: Creature[] = w.creatures.slice();
  const ghost: 0 | 1 = w.player && !w.player.alive ? 1 : 0;
  if (ghost) rows.push(w.player!);
  const n = rows.length;
  const NF = CRE_F64.length, NI = CRE_I32.length;
  const f64 = new Float64Array(n * NF);
  const i32 = new Int32Array(n * NI);
  const cause: (string | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = rows[i];
    const C = c as unknown as Record<string, number>;
    for (let k = 0; k < NF; k++) f64[i * NF + k] = C[CRE_F64[k]];
    for (let k = 0; k < NI; k++) {
      const key = CRE_I32[k];
      let v: number;
      if (key === 'state') v = STATES.indexOf(c.state);
      else if (key === 'gi') v = gi(c.g);
      else if (key === 'flags') v = (c.alive ? 1 : 0) | (c.player ? 2 : 0);
      else if (key === 'mother' || key === 'father') v = c[key] ?? -1;
      else v = C[key];
      if ((v | 0) !== v) problem(`Снимок: поле особи «${key}» = ${v} не целое`);
      i32[i * NI + k] = v;
    }
    cause[i] = c.cause;
  }
  const ancs = [...w.ancestors.values()];
  const anc = new Float64Array(ancs.length * ANC_F);
  for (let i = 0; i < ancs.length; i++) {
    const a = ancs[i], o = i * ANC_F;
    anc[o] = a.id;
    anc[o + 1] = a.mother ?? NaN;
    anc[o + 2] = a.sp;
    anc[o + 3] = gi(a.g);
    anc[o + 4] = a.generation;
    anc[o + 5] = a.born;
    anc[o + 6] = a.died ?? NaN;
  }
  const NG = GEN_F.length;
  const gf = new Float64Array(genomes.length * NG);
  const gb = new Int32Array(genomes.length);
  const bIdx = new Map<Float32Array, number>();
  const brainList: Float32Array[] = [];
  for (let i = 0; i < genomes.length; i++) {
    const g = genomes[i] as unknown as Record<string, number>;
    for (let k = 0; k < NG; k++) gf[i * NG + k] = g[GEN_F[k]];
    const b = genomes[i].brain;
    if (b) {
      let j = bIdx.get(b);
      if (j === undefined) {
        j = brainList.length;
        bIdx.set(b, j);
        brainList.push(b);
      }
      gb[i] = j;
    } else gb[i] = -1;
  }
  const blen = brainList.length ? brainList[0].length : WEIGHTS;
  const brains = new Float32Array(brainList.length * blen);
  for (let j = 0; j < brainList.length; j++) {
    if (brainList[j].length !== blen) problem('Снимок: мозги разной длины');
    brains.set(brainList[j], j * blen);
  }
  const ks = w.corpses;
  const NC = CORPSE_F.length;
  const corpses = new Float64Array(ks.length * NC);
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i] as unknown as Record<string, number | boolean>;
    for (let f = 0; f < NC; f++) corpses[i * NC + f] = +k[CORPSE_F[f]];
  }
  // захват клеток: только свежие записи (симуляция читает лишь claimTick ≥ tick − 1)
  const ct = w.claimTick, cv = w.claim, t1 = w.tick - 1;
  let m = 0;
  for (let i = 0; i < ct.length; i++) if (ct[i] >= t1) m++;
  const claim = { idx: new Int32Array(m), val: new Float32Array(m), t: new Int32Array(m) };
  for (let i = 0, j = 0; i < ct.length; i++) {
    if (ct[i] < t1) continue;
    claim.idx[j] = i;
    claim.val[j] = cv[i];
    claim.t[j++] = ct[i];
  }
  const cells: Record<string, Float32Array> = {};
  for (const k of SNAP_CELLS) cells[k] = copyCells(W[k] as Float32Array);
  // всё прочее — одним клоном (общие ссылки между полями сохраняются)
  const src: Record<string, unknown> = {};
  for (const k of SNAP_CLONE) if (k in w) src[k] = W[k];
  src.species = w.species.save();
  const scal = structuredClone(src);
  const ext: Record<string, number> = { blockedHere: 'blockedTerrain' in w ? +(w.blockedTerrain === w.terrain) : 0 };
  const s: WorldSnap = {
    v: SNAP_VERSION, tick: w.tick, seed: w.seed, salt: w.salt, mode: w.brainMode, env: w.env, dims: [w.width, w.height, w.cell],
    scal, cells, claim,
    cre: { n, f64cols: [...CRE_F64], i32cols: [...CRE_I32], f64, i32, cause, ghost },
    gen: { cols: [...GEN_F], f64: gf, brain: gb, brains, blen },
    anc, corpses, ext, actN: 0, inN: 0, digest: 0, bytes: 0,
  };
  s.digest = snapDigest(s);
  let bytes = 30_000 + 600 * w.species.all.size;
  for (const a of [f64, i32, gf, gb, brains, anc, corpses, claim.idx, claim.val, claim.t]) bytes += a.byteLength;
  for (const k in cells) bytes += cells[k].byteLength;
  s.bytes = bytes;
  return s;
}

// ---------------- восстановление ----------------

/** Геном по умолчанию — значения для генов, которых нет в старом снимке. */
let genTpl: Genome | null = null;

/**
 * Вернуть мир в снимок. Мир должен быть «тем же» (seed, env, размеры — см. sameWorld); иначе вызывающий
 * сначала делает w.reset(s.mode, s.seed, s.env, s.salt). Снимок не меняется и не разделяется с миром.
 */
export function loadWorld(w: WorldInternals, s: WorldSnap, history: Sample[] = []): void {
  if (s.v !== SNAP_VERSION) throw new Error(`Снимок версии ${s.v}, а нужна ${SNAP_VERSION}`);
  if (!sameWorld(w as unknown as World, s)) throw new Error('Снимок из другого мира (seed, условия или размеры): сначала reset');
  const W = w as unknown as Record<string, unknown>;
  // 1. скаляры: простые объекты — на месте (ссылки settings/input у страницы и уроков остаются верными)
  const c = structuredClone(s.scal);
  for (const k of Object.keys(c)) {
    if (k === 'species' || !(k in w)) continue;
    const live = W[k], v = c[k];
    if (isPlain(live) && isPlain(v)) Object.assign(live, v);
    else W[k] = v;
  }
  w.species.load(c.species as SpeciesSave);
  w.species.rand = w.r;
  // 2. клетки — в те же массивы (рендер держит на них ссылки)
  for (const k of SNAP_CELLS) {
    const a = s.cells[k];
    if (a) (W[k] as Float32Array).set(a);
  }
  // 3. захват клеток
  w.claim.fill(0);
  w.claimTick.fill(-10);
  for (let j = 0; j < s.claim.idx.length; j++) {
    w.claim[s.claim.idx[j]] = s.claim.val[j];
    w.claimTick[s.claim.idx[j]] = s.claim.t[j];
  }
  // 4. геномы (по именам колонок; недостающие гены — по умолчанию)
  const tpl = (genTpl ??= genome({}, false, () => 0.5));
  const gcols = s.gen.cols, NG = gcols.length, ng = s.gen.brain.length, blen = s.gen.blen;
  const brainObj = new Map<number, Float32Array>();
  const genomes: Genome[] = new Array(ng);
  for (let i = 0; i < ng; i++) {
    const g: Genome = { ...tpl };
    const G = g as unknown as Record<string, number>;
    for (let k = 0; k < NG; k++) G[gcols[k]] = s.gen.f64[i * NG + k];
    const b = s.gen.brain[i];
    if (b >= 0) {
      let arr = brainObj.get(b);
      if (!arr) brainObj.set(b, (arr = s.gen.brains.slice(b * blen, (b + 1) * blen)));
      g.brain = arr;
    } else g.brain = null;
    genomes[i] = g;
  }
  // 5. особи — через makeCreature (один скрытый класс с рождёнными)
  const { n, f64cols, i32cols, f64, i32, cause } = s.cre;
  const NF = f64cols.length, NI = i32cols.length;
  const rows: Creature[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o: Record<string, unknown> = { sick: 0, immune: 0, vir: 0, beta: 0, dung: 0, heading: 0, dph: 0 };
    for (let k = 0; k < NF; k++) o[f64cols[k]] = f64[i * NF + k];
    let gIndex = 0, flags = 1;
    for (let k = 0; k < NI; k++) {
      const key = i32cols[k], v = i32[i * NI + k];
      if (key === 'state') o.state = STATES[v] ?? 'wander';
      else if (key === 'gi') gIndex = v;
      else if (key === 'flags') flags = v;
      else if (key === 'mother' || key === 'father') o[key] = v === -1 ? null : v;
      else o[key] = v;
    }
    o.g = genomes[gIndex];
    o.alive = (flags & 1) !== 0;
    o.player = (flags & 2) !== 0;
    o.cause = cause[i];
    if (o.rs === undefined) o.rs = mix32((o.id as number) ^ s.seed);
    rows[i] = w.makeCreature(o as CreatureInit);
  }
  // 6. игрок: мёртвый — строкой-призраком в конце
  if (s.cre.ghost) {
    w.player = rows.pop()!;
    w.creatures = rows;
  } else {
    w.creatures = rows;
    w.player = rows.find((r) => r.player) ?? null;
  }
  // 7. туши и предки
  const NC = CORPSE_F.length, K = s.corpses;
  const corpses: Corpse[] = new Array(K.length / NC);
  for (let i = 0, o = 0; o < K.length; i++, o += NC)
    corpses[i] = { x: K[o], y: K[o + 1], energy: K[o + 2], size: K[o + 3], hue: K[o + 4], age: K[o + 5], idx: K[o + 6], e0: K[o + 7], sp: K[o + 8], sick: K[o + 9] === 1 };
  w.corpses = corpses;
  const A = s.anc;
  const ancestors = new Map<number, Ancestor>();
  for (let o = 0; o < A.length; o += ANC_F)
    ancestors.set(A[o], { id: A[o], mother: Number.isNaN(A[o + 1]) ? null : A[o + 1], sp: A[o + 2], g: genomes[A[o + 3]], generation: A[o + 4], born: A[o + 5], died: Number.isNaN(A[o + 6]) ? null : A[o + 6] });
  w.ancestors = ancestors;
  // 8. ссылки на рельеф — из флагов
  if ('blockedTerrain' in w) w.blockedTerrain = s.ext.blockedHere ? w.terrain : null;
  // 9. временное
  w.history = history.slice();
  w.fx = [];
  w.ctx = null;
  w.buildHash();
}
