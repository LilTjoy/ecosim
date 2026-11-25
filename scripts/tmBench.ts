// ⏪ Проверки машины времени для стенда: npm run bench -- <seed> <ticks> [rules|neural] --tm=det|fly
// det — точность снимков (G1), ловушка Math.random (G2), размер и скорость (G3);
// fly — эффект бабочки (G4): сдвиг одной особи на 1e-6 расходится волной, а не сразу по всему миру.
import { World, type BrainMode } from '../src/sim/world';
import { SNAP_CELLS, SNAP_DEV, uncoveredKeys, type WorldSnap } from '../src/sim/snapshot';
import { mulberry32 } from '../src/lib/random';
import { cpus, loadavg } from 'node:os';
import { cmp, load, thin } from './tmTimeline';
import { bgGate, blountGate } from './tmWorker';

interface Ctx { seed: number; T: number; mode: BrainMode; salt: number; mk: () => World; flags: Record<string, string> }

const now = () => performance.now();
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];
const steps = (w: World, n: number) => { for (let i = 0; i < n; i++) w.step(); };

/** Глубокое сравнение значений structuredClone (Map, Set, массивы, объекты, NaN, −0). */
function same(a: unknown, b: unknown, path = ''): string | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${path}: ${String(a)} ≠ ${String(b)}`;
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return `${path}: Map size`;
    const ka = [...a.keys()], kb = [...b.keys()];
    for (let i = 0; i < ka.length; i++) {
      if (!Object.is(ka[i], kb[i])) return `${path}: Map key order ${ka[i]} ≠ ${kb[i]}`;
      const d = same(a.get(ka[i]), b.get(kb[i]), `${path}.${String(ka[i])}`);
      if (d) return d;
    }
    return null;
  }
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return `${path}: Set size`;
    const va = [...a], vb = [...b];
    for (let i = 0; i < va.length; i++) if (!Object.is(va[i], vb[i])) return `${path}: Set order`;
    return null;
  }
  if (ArrayBuffer.isView(a)) {
    if (!ArrayBuffer.isView(b) || a.byteLength !== b.byteLength || a.constructor !== b.constructor) return `${path}: typed array kind/length`;
    const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return `${path}: byte ${i}`;
    return null;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const A = a as Record<string, unknown>, B = b as Record<string, unknown>;
  const ka = Object.keys(A), kb = Object.keys(B);
  if (ka.length !== kb.length) return `${path}: keys ${ka.join(',')} ≠ ${kb.join(',')}`;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return `${path}: key order ${ka[i]} ≠ ${kb[i]}`;
    const d = same(A[ka[i]], B[kb[i]], `${path}.${ka[i]}`);
    if (d) return d;
  }
  return null;
}

/** Снимок ↔ снимок: все колонки и скаляры совпадают (кроме курсоров и размера). */
function sameSnap(a: WorldSnap, b: WorldSnap): string | null {
  const strip = (s: WorldSnap) => ({ ...s, actN: 0, inN: 0, env: JSON.stringify(s.env) });
  return same(strip(a), strip(b), 'snap');
}

const evJson = (w: World) => JSON.stringify(w.events);

export function runTm(kind: string, ctx: Ctx): void {
  SNAP_DEV.strict = true; // непокрытое поле или дробное значение в целой колонке — исключение
  if (kind === 'det') return det(ctx);
  if (kind === 'fly') return fly(ctx);
  if (kind === 'load') return load(ctx);
  if (kind === 'thin') return thin(ctx);
  if (kind === 'cmp') return cmp(ctx);
  if (kind === 'bg') return bgGate(ctx);
  if (kind === 'blount') return blountGate(ctx);
  throw new Error(`--tm=${kind}: есть det, fly, load, thin, cmp, bg и blount`);
}

// ---------------- det ----------------

type Act = { t: number; f: (w: World) => void; name: string };

/** Сценарий вмешательств на отрезке [H, T]: вселение и управление, гибель игрока (призрак), стихии, опыты уроков. */
function script(H: number, T: number, seed: number): Act[] {
  const L = T - H;
  const at = (q: number) => H + Math.round(q * L);
  const R = mulberry32(seed * 31 + 7);
  const acts: Act[] = [];
  const living = (w: World, pred: (c: World['creatures'][number]) => boolean) => w.creatures.filter((c) => c.alive && pred(c));
  acts.push({ t: H + 50, name: 'possess', f: (w) => { const l = living(w, (c) => c.g.swim < 0.6); w.possess(l[Math.floor(l.length / 3)] ?? null); } });
  // ввод игрока: значения Math.fround, как будет писать страница
  for (let t = H + 51; t < T; t += 29) {
    const dx = Math.fround(R() * 2 - 1), dy = Math.fround(R() * 2 - 1), run = R() < 0.3;
    acts.push({ t, name: 'input', f: (w) => { w.input.dx = dx; w.input.dy = dy; w.input.run = run; } });
  }
  acts.push({ t: at(0.12), name: 'drought', f: (w) => w.startDrought() });
  // метеорит прямо в игрока: игрок погибает, остаётся «призраком» в world.player
  acts.push({ t: at(0.2), name: 'meteor@player', f: (w) => { const p = w.player; if (p) w.meteor(p.x, p.y); } });
  acts.push({ t: at(0.3), name: 'possess heir', f: (w) => { const l = living(w, () => true); w.possess(l[Math.floor(l.length / 2)] ?? null); } });
  acts.push({ t: at(0.35), name: 'grass', f: (w) => { for (let k = 0; k < 6; k++) w.paintGrass(800 + 60 * k, 900 + 25 * k, 50); } });
  acts.push({ t: at(0.4), name: 'epidemic', f: (w) => w.epidemic() });
  acts.push({ t: at(0.45), name: 'removeResource', f: (w) => w.removeResource('browse', Math.round(0.3 * L)) });
  acts.push({ t: at(0.5), name: 'mutation×1.5', f: (w) => { w.settings.mutationRate = 0.12; } });
  acts.push({ t: at(0.55), name: 'noDecomposers', f: (w) => { w.experiment.noDecomposers = true; } });
  acts.push({ t: at(0.6), name: 'restoreResource', f: (w) => w.restoreResource('browse') });
  acts.push({ t: at(0.7), name: 'decomposers', f: (w) => { w.experiment.noDecomposers = false; } });
  acts.push({ t: at(0.75), name: 'removeForage', f: (w) => w.removeResource('forage', 10 * L) });
  acts.push({ t: at(0.8), name: 'reseed', f: (w) => w.reseed(12345) });
  // действия этапа 2 (World.apply): поселить, спасти, убрать вид, бабочка
  acts.push({ t: at(0.25), name: 'spawn', f: (w) => w.apply({ k: 'spawn', t: w.tick, g: { size: 6, diet: 0.9, social: 0.6 }, n: 8, x: 1600, y: 1000, icon: '🦊', label: 'Хищник' }) });
  acts.push({ t: at(0.42), name: 'rescue', f: (w) => { const s = w.species.living()[2]; if (s) w.apply({ k: 'rescue', t: w.tick, sp: s.id, n: 5 }); } });
  acts.push({ t: at(0.47), name: 'remove', f: (w) => { const s = w.species.living()[4]; if (s) w.apply({ k: 'remove', t: w.tick, sp: s.id }); } });
  acts.push({ t: at(0.83), name: 'nudge', f: (w) => { const c = w.creatures[w.creatures.length >> 1]; if (c) w.apply({ k: 'nudge', t: w.tick, id: c.id, dx: 1e-6 }); } });
  acts.push({ t: at(0.85), name: 'meteor', f: (w) => w.meteor(1700, 1100) });
  acts.push({ t: at(0.88), name: 'possess null', f: (w) => w.possess(null) });
  acts.sort((a, b) => a.t - b.t);
  return acts;
}

/** Прогнать мир до T по сценарию; снимки — в начале тактов из `cap` (до действий этого такта). */
function play(w: World, acts: Act[], T: number, cap: Set<number> = new Set()): Map<number, WorldSnap> {
  const out = new Map<number, WorldSnap>();
  let i = 0;
  while (i < acts.length && acts[i].t < w.tick) i++;
  while (w.tick < T) {
    if (cap.has(w.tick)) out.set(w.tick, w.captureState());
    while (i < acts.length && acts[i].t === w.tick) acts[i++].f(w);
    w.step();
  }
  return out;
}

function det({ seed, T, mode, mk }: Ctx): void {
  const H = Math.floor(T / 2);
  const A = mk();
  steps(A, H);
  const S = A.captureState();
  const caps: number[] = [];
  for (let k = 0; k < 7; k++) {
    const t0 = now();
    A.captureState();
    caps.push(now() - t0);
  }
  const cover = uncoveredKeys(A);
  // 1) снимок → свежий мир → снимок: те же колонки и скаляры
  const B = mk();
  let t0 = now();
  B.loadState(S);
  const resFresh = now() - t0;
  const S2 = B.captureState();
  const rt = sameSnap(S, S2);
  // 2) скорость шага до и после восстановления (те же состояния — разница только в объектах): чередуем кусками
  let msA = 0, msB = 0;
  for (let k = 0; k < 6; k++) {
    t0 = now(); steps(A, 100); msA += now() - t0;
    t0 = now(); steps(B, 100); msB += now() - t0;
  }
  steps(A, T - H - 600);
  steps(B, T - H - 600);
  const dA = A.captureState().digest, eA = evJson(A);
  const dB = B.captureState().digest, eB = evJson(B);
  // 3) перемотка того же мира
  t0 = now();
  A.loadState(S);
  const resSame = now() - t0;
  steps(A, T - H);
  const SC = A.captureState();
  const dC = SC.digest, eC = evJson(A);
  const fresh = dA === dB && eA === eB, rewind = dA === dC && eA === eC;
  // 4) сценарий с вмешательствами: 6 точек восстановления, каждая доигрывается до конца так же
  const acts = script(H, T, seed);
  const L = T - H;
  const points = [0.1, 0.21, 0.33, 0.5, 0.66, 0.9].map((q) => H + Math.round(q * L));
  const F = mk();
  F.loadState(S);
  const snaps = play(F, acts, T, new Set(points));
  const dF = F.captureState().digest, eF = evJson(F);
  const ghostAt = [...snaps.values()].filter((s) => s.cre.ghost).length;
  const blockedAt = [...snaps.values()].filter((s) => s.ext.blockedHere).length;
  let fuzz = 0;
  const fails: string[] = [];
  const G = mk(); // половина точек — в тот же мир по очереди, половина — в свежий
  points.forEach((p, k) => {
    const s = snaps.get(p)!;
    const X = k % 2 ? mk() : G;
    X.loadState(s);
    const again = X.captureState();
    const d0 = sameSnap(s, again);
    play(X, acts, T);
    const d = X.captureState().digest, e = evJson(X);
    if (!d0 && d === dF && e === eF) fuzz++;
    else fails.push(`@${p}${d0 ? ` roundtrip ${d0}` : ''}${d !== dF ? ' digest' : ''}${e !== eF ? ' events' : ''}`);
  });
  // G3: размер и время (WARN; пороги ×2, когда машина перегружена)
  const n = S.cre.n;
  const snapKB = S.bytes / 1024;
  const slack = loadavg()[0] > cpus().length ? 2 : 1;
  const kbLim = 1150 + (mode === 'neural' ? 1.3 : 0.45) * n;
  const capP50 = med(caps), resMs = Math.max(resFresh, resSame), stepRatio = msB / msA;
  const warn: string[] = [];
  if (snapKB > kbLim) warn.push(`snapKB ${snapKB.toFixed(0)} > ${kbLim.toFixed(0)}`);
  if (capP50 > 8 * slack) warn.push(`capture p50 ${capP50.toFixed(1)} > ${8 * slack} ms`);
  if (resMs > 15 * slack) warn.push(`restore ${resMs.toFixed(1)} > ${15 * slack} ms`);
  if (stepRatio > 1.05 * (slack > 1 ? 1.05 : 1)) warn.push(`step after restore ×${stepRatio.toFixed(3)}`);
  const ok = fresh && rewind && fuzz === 6 && cover.length === 0 && !rt;
  const genN = S.gen.brain.length, ancN = S.anc.length / 7;
  console.log(`seed ${seed} ${mode} tm=det T=${T} restoreAt=${H}`);
  console.log(`TM det: ${ok ? 'ok' : 'FAIL'} fresh=${+fresh} rewind=${+rewind} fuzz=${fuzz}/6 cover=${cover.length}${cover.length ? `(${cover.join(',')})` : ''} roundtrip=${rt ? rt : 'same'} capMs p50=${capP50.toFixed(2)} max=${Math.max(...caps).toFixed(2)} resMs=${resFresh.toFixed(2)}/${resSame.toFixed(2)} snapKB=${snapKB.toFixed(0)} (lim ${kbLim.toFixed(0)}) n=${n} anc=${ancN} genomes=${genN} brains=${S.gen.brains.length / Math.max(1, S.gen.blen)} corpses=${S.corpses.length / 10} claim=${S.claim.idx.length} species=${(S.scal.species as { all: unknown[] }).all.length}`);
  console.log(` step ms/tick before=${(msA / 600).toFixed(3)} after-restore=${(msB / 600).toFixed(3)} ratio=${stepRatio.toFixed(3)} | digests A=${dA.toString(16)} B=${dB.toString(16)} C=${dC.toString(16)} fuzzEnd=${dF.toString(16)} ghostSnaps=${ghostAt} blockedSnaps=${blockedAt} cells=${SNAP_CELLS.length} load=${loadavg()[0].toFixed(1)}`);
  console.log(` G3: ${warn.length ? 'WARN ' + warn.join('; ') : 'ok'}${fails.length ? ` | fuzz fails: ${fails.join(' ')}` : ''}`);
  console.log(` acts: ${acts.filter((a) => a.name !== 'input').map((a) => `${a.t}:${a.name}`).join(' ')} (+${acts.filter((a) => a.name === 'input').length} input)`);
  if (!ok) process.exitCode = 1;
}

// ---------------- fly ----------------

function fly({ seed, mode, mk, flags }: Ctx): void {
  // --dx= — величина толчка (по умолчанию 1e-6 px), --at= — когда
  const T0 = Number(flags.at ?? 3000), Hz = 2000, GX = 32, GY = 20, DX = Number(flags.dx ?? 1e-6);
  const A = mk();
  steps(A, T0);
  const S = A.captureState();
  const B = mk();
  B.loadState(S);
  const same0 = B.captureState().digest === S.digest;
  const victim = B.creatures[Math.floor(B.creatures.length / 2)];
  victim.x += DX;
  const vx = victim.x, vy = victim.y;
  const grid = (w: World) => {
    const m = new Map<number, number>();
    for (const c of w.creatures) {
      const cell = Math.min(GY - 1, Math.floor((c.y / w.height) * GY)) * GX + Math.min(GX - 1, Math.floor((c.x / w.width) * GX));
      const k = cell * 100000 + c.sp;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const rows: string[] = [];
  const at: Record<number, { diff: number; occ: number; maxR: number }> = {};
  let first = -1;
  for (let t = 1; t <= Hz; t++) {
    A.step();
    B.step();
    if (first < 0 && t % 10 === 0 && A.captureState().digest !== B.captureState().digest) first = t;
    if (t % 100 !== 0) continue;
    const ga = grid(A), gb = grid(B);
    const occ = new Set<number>(), diff = new Set<number>();
    for (const k of new Set([...ga.keys(), ...gb.keys()])) {
      const cell = Math.floor(k / 100000);
      occ.add(cell);
      if ((ga.get(k) ?? 0) !== (gb.get(k) ?? 0)) diff.add(cell);
    }
    let maxR = 0;
    const cw = A.width / GX, ch = A.height / GY;
    for (const cell of diff) maxR = Math.max(maxR, Math.hypot(((cell % GX) + 0.5) * cw - vx, (Math.floor(cell / GX) + 0.5) * ch - vy));
    at[t] = { diff: diff.size, occ: occ.size, maxR };
    rows.push(`+${t}: ${diff.size}/${occ.size} R${maxR.toFixed(0)}`);
  }
  const d300 = at[300].diff, r500 = at[500].maxR, share = at[2000].diff / Math.max(1, at[2000].occ);
  const hard = d300 <= 3 && r500 <= 1200;
  console.log(`seed ${seed} ${mode} tm=fly nudge #${victim.id} by ${DX} at t=${T0} (${vx.toFixed(0)},${vy.toFixed(0)}) restoredSame=${+same0} firstDigestDiff=+${first}`);
  console.log(`TM fly: ${hard ? 'ok' : 'FAIL'} diff+300=${d300} maxR+500=${r500.toFixed(0)} share+2000=${(100 * share).toFixed(0)}%${share < 0.3 ? ' WARN(<30%)' : ''} n=${A.creatures.length}/${B.creatures.length}`);
  console.log(' ' + rows.join(' | '));
}
