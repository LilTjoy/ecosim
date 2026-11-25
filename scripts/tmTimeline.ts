// ⏪ Стенд машины времени, этап 3: --tm=load (G6, G7) и --tm=thin (прореживание на 200 000 тактов).
// load: один и тот же сценарий без машины времени и с ней — мир обязан совпасть до бита (G6a), накладные расходы
// ≤ 2% (G6b); затем на записи: память и снимки, «Как было» от снимка у такта 15000, «что если бы не было метеорита»
// (forkWithout) против прогона без него, переходы между ветками, отмена последнего метеорита (G7).
import { World, type BrainMode } from '../src/sim/world';
import type { WorldSnap } from '../src/sim/snapshot';
import { Timeline, TM, TIERS, keepAuto, type Action, type ActionInput, type SnapMeta } from '../src/sim/timeline';
import { mulberry32 } from '../src/lib/random';
import { comparePair } from '../src/sim/tmCompare';
import { cpus, loadavg } from 'node:os';

interface Ctx { seed: number; T: number; mode: BrainMode; salt: number; mk: () => World; flags: Record<string, string> }

const now = () => performance.now();
const evJson = (w: World) => JSON.stringify(w.events);
const MB = (b: number) => (b / 1048576).toFixed(1);

// ---------------- сценарий ----------------

/** Поступок, который выбирается по состоянию мира в свой такт (id особи, вид) — потом повторяется записью. */
type Op = { t: number; name: string; act: (w: World) => ActionInput | null };
/** Прямые записи «страницы»: ввод игрока и ручки (их машина времени ловит сама, по разнице). */
type Write = { t: number; f: (w: World) => void };

function scenario(T: number, seed: number): { ops: Op[]; writes: Write[]; meteors: number[] } {
  const R = mulberry32(seed * 977 + 3);
  const at = (q: number) => Math.round(q * T);
  const ops: Op[] = [];
  const living = (w: World) => w.creatures.filter((c) => c.alive);
  const others = new Set<number>();
  const op = (t: number, name: string, act: Op['act']) => {
    ops.push({ t, name, act });
    others.add(t);
  };
  op(at(0.1), 'possess', (w) => { const l = living(w).filter((c) => c.g.swim < 0.6); const c = l[Math.floor(l.length / 3)]; return c ? { k: 'possess', id: c.id } : null; });
  op(at(0.15), 'drought', () => ({ k: 'drought' }));
  op(at(0.2), 'meteor@player', (w) => (w.player ? { k: 'meteor', x: w.player.x, y: w.player.y } : null));
  op(at(0.22), 'possess heir', (w) => { const l = living(w); const c = l[Math.floor(l.length / 2)]; return c ? { k: 'possess', id: c.id } : null; });
  op(at(0.25), 'spawn', () => ({ k: 'spawn', g: { size: 4, diet: 0.1, tempPref: 0.5, social: 0.5 }, n: 8, x: 1500, y: 900, icon: '🐇', label: 'Травоядное' }));
  // трава: несколько точек в один такт (сливаются) и в соседний
  for (let k = 0; k < 5; k++) op(at(0.35), 'grass', () => ({ k: 'grass', pts: [700 + 40 * k, 800 + 30 * k], r: 50 }));
  op(at(0.35) + 1, 'grass', () => ({ k: 'grass', pts: [900, 1000], r: 50 }));
  op(at(0.4), 'epidemic', () => ({ k: 'epidemic' }));
  op(at(0.45), 'rescue', (w) => { const l = w.species.living(); const s = l[Math.min(l.length - 1, 3)]; return s ? { k: 'rescue', sp: s.id, n: 6 } : null; });
  op(at(0.5), 'remove', (w) => { const l = w.species.living(); const s = l[Math.min(l.length - 1, 5)]; return s ? { k: 'remove', sp: s.id } : null; });
  op(at(0.55), 'resource', () => ({ k: 'resource', kind: 'browse', ticks: 4000 }));
  op(at(0.6), 'restoreRes', () => ({ k: 'restoreRes', kind: 'browse' }));
  op(at(0.62), 'experiment', () => ({ k: 'experiment', e: { noDecomposers: true } }));
  op(at(0.66), 'reseed', () => ({ k: 'reseed', salt: 777 }));
  op(at(0.67), 'nudge', (w) => { const c = w.creatures[Math.floor(w.creatures.length / 2)]; return c ? { k: 'nudge', id: c.id, dx: 1e-6 } : null; });
  op(at(0.8), 'possess null', () => ({ k: 'possess', id: null }));
  // 30 метеоритов в случайные такты; последний — за 700 тактов до конца (его отменим)
  const meteors = new Set<number>();
  while (meteors.size < 29) {
    const t = 500 + Math.floor(R() * (T - 2000));
    if (!others.has(t) && !others.has(t - 1)) meteors.add(t);
  }
  meteors.add(T - 700);
  const mt = [...meteors].sort((a, b) => a - b);
  for (const t of mt) {
    const x = 200 + R() * 2800, y = 200 + R() * 1600;
    ops.push({ t, name: 'meteor', act: () => ({ k: 'meteor', x, y }) });
  }
  ops.sort((a, b) => a.t - b.t);
  // ввод игрока (Math.fround, как пишет страница) — от вселения почти до конца; ручки — прямой записью
  const writes: Write[] = [];
  for (let t = at(0.1) + 1; t < T - 100; t += 29) {
    const dx = Math.fround(R() * 2 - 1), dy = Math.fround(R() * 2 - 1), run = R() < 0.3;
    writes.push({ t, f: (w) => Object.assign(w.input, { dx, dy, run }) });
  }
  writes.push({ t: at(0.5) + 3, f: (w) => { w.settings.mutationRate = 0.16; } });
  writes.push({ t: at(0.7), f: (w) => { w.experiment.noDecomposers = false; } });
  writes.push({ t: at(0.75), f: (w) => { w.settings.mutationRate = 0.08; } });
  writes.sort((a, b) => a.t - b.t);
  return { ops, writes, meteors: mt };
}

/** Прогон мира по сценарию: run(until) продолжает с места, где остановился (A и B можно вести по очереди). */
function driver(w: World, ops: Op[], writes: Write[], rec: (a: Action) => void, step: () => void, tap?: (t: number) => void) {
  let i = 0, j = 0;
  const done: Action[] = [];
  while (i < ops.length && ops[i].t < w.tick) i++;
  while (j < writes.length && writes[j].t < w.tick) j++;
  const run = (T: number) => {
    while (w.tick < T) {
      tap?.(w.tick);
      while (i < ops.length && ops[i].t === w.tick) {
        const a = ops[i++].act(w);
        if (!a) continue;
        const full = { ...a, t: w.tick } as Action;
        done.push(structuredClone(full));
        rec(full);
      }
      while (j < writes.length && writes[j].t === w.tick) writes[j++].f(w);
      step();
    }
    return done;
  };
  return { run, done };
}
const drive = (w: World, T: number, ops: Op[], writes: Write[], rec: (a: Action) => void, step: () => void): Action[] => driver(w, ops, writes, rec, step).run(T);

/** Повтор по записанным поступкам (те же объекты), без одного. */
const replayOps = (acts: Action[], skip: Action | null): Op[] =>
  acts.filter((a) => a !== skip).map((a) => ({ t: a.t, name: a.k, act: () => structuredClone(a) as ActionInput }));

// ---------------- load ----------------

export function load({ seed, T, mode, mk }: Ctx): void {
  const { ops, writes, meteors } = scenario(T, seed);
  const tk = meteors.filter((t) => t <= T - 2000).at(-1)!; // метеорит для «что если бы его не было»
  const tm = meteors.at(-1)!; // последний — его отменим
  // A — без машины времени (снимки в такты tk и tm — до действий этого такта), B — тот же сценарий через неё;
  // ведём их по очереди кусками по 300 тактов, чтобы сравнение скорости не зависело от порядка и нагрузки машины
  const A = mk();
  const capA = new Map<number, WorldSnap>();
  const dvA = driver(A, ops, writes, (a) => A.apply(a), () => A.step(), (t) => { if (t === tk || t === tm) capA.set(t, A.captureState()); });
  const B = mk();
  const tl = new Timeline();
  tl.trap = true;
  const toasts: string[] = [];
  tl.onToast = (s) => toasts.push(`${B.tick}:${s}`);
  let maxBytes = 0, maxCount = 0;
  tl.reset(B);
  const dvB = driver(B, ops, writes, (a) => tl.record(B, a), () => {
    tl.step(B);
    if (B.tick % TM.SNAP_EVERY === 0) {
      maxBytes = Math.max(maxBytes, tl.bytes());
      maxCount = Math.max(maxCount, tl.snapCount());
    }
  });
  let msA = 0, msB = 0;
  for (let u = 300; u <= T; u += 300) {
    let t0 = now();
    dvA.run(Math.min(u, T));
    msA += now() - t0;
    t0 = now();
    dvB.run(Math.min(u, T));
    msB += now() - t0;
  }
  const actsA = dvA.done;
  const dA = A.captureState().digest, eA = evJson(A);
  let t0 = now();
  const dB = tl.digestNow(B), eB = evJson(B);
  const g6a = dA === dB && eA === eB;
  const slack = loadavg()[0] > cpus().length ? 2 : 1;
  const over = msB / msA - 1;
  const cap = [...tl.stats.captureMs].sort((x, y) => x - y);
  console.log(`seed ${seed} ${mode} tm=load T=${T} actions=${actsA.length} meteors=${meteors.length} tk=${tk} tm=${tm} load=${loadavg()[0].toFixed(1)}`);
  console.log(`TM G6a: ${g6a ? 'ok' : 'FAIL'} digest ${dA.toString(16)}/${dB.toString(16)} events ${eA === eB ? 'same' : 'DIFF'} | G6b: overhead ${(100 * over).toFixed(1)}%${over > 0.02 * slack ? ' WARN' : ' ok'} (${(msA / T).toFixed(3)} → ${(msB / T).toFixed(3)} ms/tick) captures=${tl.stats.captures} p50=${cap[cap.length >> 1]?.toFixed(1)} max=${cap.at(-1)?.toFixed(1)} ms`);

  // G7a: память, число снимков, корень, якоря 'pre' последних поступков
  const main = tl.active;
  const snaps = tl.lineageSnaps(main);
  const kinds: Record<string, number> = {};
  for (const s of snaps) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
  const player = main.actions.map((a, i) => ({ a, i })).filter(({ a }) => a.k !== 'settings' && !(a.k === 'experiment' && a.quiet));
  const lastP = player.slice(-TM.PRE_KEEP);
  const anchored = lastP.filter(({ a, i }) => snaps.some((s) => s.kind === 'pre' && s.tick <= a.t && a.t - s.tick <= TM.PRE_REUSE && s.snap.actN <= i)).length;
  const bytes = tl.bytes(), count = tl.snapCount();
  const g7a = bytes <= TM.MAX_BYTES && maxBytes <= TM.MAX_BYTES && count <= 40 && maxCount <= 40 && snaps[0]?.kind === 'root' && anchored === lastP.length;
  console.log(` snaps: ${snaps.map((s) => `${s.tick}${s.kind[0]}`).join(' ')}`);
  console.log(`TM G7a: ${g7a ? 'ok' : 'FAIL'} bytes=${MB(bytes)}MB (max ${MB(maxBytes)}) snaps=${count} (max ${maxCount}) ${JSON.stringify(kinds)} root=${+(snaps[0]?.kind === 'root')} preAnchors=${anchored}/${lastP.length} dropped=${JSON.stringify(tl.stats.dropped)} samples=${main.samples.length} rows=${main.rows.length} marks=${main.marks.length} (major ${main.marks.filter((m) => m.major).length}) input=${main.input.n} acts=${main.actions.length} exact=${+main.exact}`);

  // G7b: «Как было» от снимка у такта 15000 до головы (с записанным вводом и действиями)
  const s15 = tl.nearestSnap(main, Math.min(15000, T >> 1))!;
  tl.visit(B, s15);
  const gc0 = tl.stats.guardChecks;
  t0 = now();
  const okWas = tl.asWas(B);
  tl.finish(B);
  const msWas = now() - t0;
  const dWas = tl.digestNow(B);
  const g7b = okWas && tl.stats.lastReplay === 'same' && dWas === dB && evJson(B) === eB && tl.stats.desyncs === 0 && !tl.visiting;
  console.log(`TM G7b: ${g7b ? 'ok' : 'FAIL'} asWas from ${s15.tick} (${s15.kind}) → ${B.tick} replay=${tl.stats.lastReplay} guards=${tl.stats.guardChecks - gc0} desyncs=${tl.stats.desyncs} ${(msWas / 1000).toFixed(1)}s`);

  // G7d: «что если бы не было метеорита дня tk» — ветка Б догоняет до T сама (остальные действия и ввод), против
  // прогона из снимка A в такте tk по той же записи без этого метеорита
  const refK = main.actions.findIndex((a) => a.k === 'meteor' && a.t === tk);
  let fb: ReturnType<Timeline['forkWithout']> = false;
  t0 = now();
  let nb: typeof main | null = null;
  fb = tl.forkWithout(B, refK, true, (b) => (nb = b));
  tl.finish(B);
  const seekMs = now() - t0;
  const nbB = nb as typeof main | null;
  const atFork = B.tick;
  while (nbB && B.tick < T) tl.step(B);
  const dFork = tl.digestNow(B), eFork = evJson(B);
  const C2 = mk();
  C2.loadState(capA.get(tk)!);
  const skipK = actsA.find((a) => a.k === 'meteor' && a.t === tk)!;
  drive(C2, T, replayOps(actsA, skipK), writes, (a) => C2.apply(a), () => C2.step());
  const dC2 = C2.captureState().digest, eC2 = evJson(C2);
  const g7d = fb && !!nbB && atFork === tk && dFork === dC2 && eFork === eC2 && dFork !== dB;
  console.log(`TM G7d: ${g7d ? 'ok' : 'FAIL'} forkWithout meteor@${tk} (#${refK}) → ветка ${nbB?.letter} «${nbB?.name}» from ${atFork} seek ${seekMs.toFixed(0)}ms acts=${nbB?.actions.length} input=${nbB?.input.n} | digest ${dFork.toString(16)} vs ref ${dC2.toString(16)} events ${eFork === eC2 ? 'same' : 'DIFF'} (main ${dB.toString(16)})`);

  // переходы: назад на А — снова голова А; снова на Б — голова Б
  t0 = now();
  const sw1 = tl.switchTo(B, main.id) && tl.digestNow(B) === dB && evJson(B) === eB;
  const sw2 = tl.switchTo(B, nbB!.id) && tl.digestNow(B) === dFork;
  const sw3 = tl.switchTo(B, main.id) && tl.digestNow(B) === dB;
  const swMs = (now() - t0) / 3;
  console.log(`TM switch: ${sw1 && sw2 && sw3 ? 'ok' : 'FAIL'} А→Б→А digests ${+sw1}${+sw2}${+sw3} ${swMs.toFixed(0)} ms/switch (incl. digest)`);

  // G7c: отмена последнего метеорита и повтор до T — как прогон, где его не было
  const ref = tl.lastUndoable();
  t0 = now();
  const undone = tl.undoLast(B);
  const undoMs = now() - t0;
  const atUndo = B.tick;
  const skipM = actsA.find((a) => a.k === 'meteor' && a.t === tm)!;
  drive(B, T, replayOps(actsA, skipM), writes, (a) => tl.record(B, a), () => tl.step(B));
  const dU = tl.digestNow(B), eU = evJson(B);
  const C = mk();
  C.loadState(capA.get(tm)!);
  drive(C, T, replayOps(actsA, skipM), writes, (a) => C.apply(a), () => C.step());
  const dC = C.captureState().digest, eC = evJson(C);
  const g7c = undone && atUndo === tm && dU === dC && eU === eC && dU !== dB && main.actions.every((a) => !(a.k === 'meteor' && a.t === tm));
  console.log(`TM G7c: ${g7c ? 'ok' : 'FAIL'} undoLast #${ref} meteor@${tm} → at ${atUndo} in ${undoMs.toFixed(0)}ms, rerun digest ${dU.toString(16)} vs no-meteor ${dC.toString(16)} events ${eU === eC ? 'same' : 'DIFF'}`);
  const fin = tl.bytes(), finN = tl.snapCount();
  const g7 = g7a && g7b && g7c && g7d && sw1 && sw2 && sw3 && fin <= TM.MAX_BYTES && finN <= 40;
  console.log(`TM load: ${g6a && g7 ? 'ok' : 'FAIL'} G6a=${+g6a} G7=${+g7} final bytes=${MB(fin)}MB snaps=${finN} branches=${tl.branches.length} toasts=${toasts.length}${toasts.length ? ' ' + toasts.slice(0, 6).join(' | ') : ''}`);
  if (!(g6a && g7)) process.exitCode = 1;
}

// ---------------- thin ----------------

/** Ненастоящий мир для прореживания: такты, записи истории каждые 20, «снимки» по 1.6 МБ. */
function fakeWorld() {
  const counts = new Map<number, number>();
  for (let k = 1; k <= 10; k++) counts.set(k, 50);
  const w = {
    tick: 0,
    history: [] as World['history'],
    events: [] as World['events'],
    creatures: [] as World['creatures'],
    species: { peekNextId: 1, living: () => [], all: new Map() },
    input: { dx: 0, dy: 0, run: false },
    settings: { mutationRate: 0.08 },
    experiment: { noDecomposers: false },
    step() {
      this.tick++;
      if (this.tick % 20 === 0) {
        this.history.push({ tick: this.tick, counts, means: new Map() } as unknown as World['history'][number]);
        if (this.history.length > 900) this.history.shift();
      }
    },
    captureState(): WorldSnap {
      return { tick: this.tick, bytes: 1.6 * 1048576, digest: this.tick, cells: {}, actN: 0, inN: 0 } as unknown as WorldSnap;
    },
    loadState(s: WorldSnap, h: World['history'] = []) {
      this.tick = s.tick;
      this.history = h.slice();
    },
    apply(a: Action) {
      if (a.k === 'meteor') this.events.push({ tick: this.tick, text: '☄️ Метеорит упал', kind: 'disaster' });
    },
  };
  return w;
}

export function thin({ flags }: Ctx): void {
  const N = Number(flags.ticks ?? 200_000);
  const small = flags.small === '1';
  const w = fakeWorld();
  const W = w as unknown as World;
  const tl = new Timeline();
  tl.small = small;
  const tierDrops: { tick: number; at: number }[] = [];
  let budget = 0;
  tl.onDrop = (s, why) => {
    if (why === 'tier' && s.branch === 0 && tl.active.id === 0) tierDrops.push({ tick: s.tick, at: W.tick });
    if (why === 'budget') budget++;
  };
  tl.reset(W);
  const R = mulberry32(5);
  let maxN = 0, maxB = 0, maxSamp = 0, fullAt = -1;
  const toasts: string[] = [];
  tl.onToast = (s) => {
    toasts.push(s);
    if (fullAt < 0) fullAt = W.tick;
  };
  const forks: number[] = [];
  for (let t = 0; t < N; t++) {
    // поступок ~ раз в 2500 тактов (иногда парами в пределах 100 тактов — общий 'pre')
    if (t > 0 && R() < 1 / 2500) {
      tl.record(W, { k: 'meteor', t: w.tick, x: 0, y: 0 });
      if (R() < 0.3) for (let k = 0; k < 40; k++) tl.step(W), t++;
    }
    if (t === 50_000 || t === 120_000) {
      // развилка в настоящем и сразу назад: у ветки остаются голова и снимок развилки
      const b = tl.forkHere(W, { k: 'reseed', t: w.tick, salt: t });
      for (let k = 0; k < 900; k++) tl.step(W), t++;
      if (b) forks.push(b.id);
      tl.switchTo(W, 0);
    }
    tl.step(W);
    if (w.tick % TM.SNAP_EVERY === 0) {
      maxN = Math.max(maxN, tl.snapCount());
      maxB = Math.max(maxB, tl.bytes());
      maxSamp = Math.max(maxSamp, tl.branches.reduce((n, b) => n + b.sampleBytes, 0));
    }
  }
  // вложенность ярусов: снимок, выброшенный по ярусу в момент at, не нужен ни в какой более поздний момент
  const end = W.tick;
  let needed = 0;
  const tiers = small ? undefined : TIERS;
  for (const d of tierDrops) {
    for (let now2 = d.at + TM.SNAP_EVERY; now2 <= end; now2 += TM.SNAP_EVERY) {
      if (tiers ? keepAuto(d.tick, now2, tiers) : keepAuto(d.tick, now2, [{ age: 1200, every: 300 }, { age: 12000, every: 3000 }, { age: Infinity, every: 24000 }])) {
        needed++;
        break;
      }
    }
  }
  const main = tl.branch(0);
  const snaps = main.snaps;
  const kinds: Record<string, number> = {};
  for (const s of snaps) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
  const autos = snaps.filter((s: SnapMeta) => s.kind === 'auto').map((s) => s.tick);
  const root = snaps[0]?.kind === 'root';
  const sampMB = maxSamp / 1048576;
  const lim = small ? TM.MAX_BYTES_SMALL : TM.MAX_BYTES;
  const ok = needed === 0 && maxN <= 40 && sampMB <= 12 && root && maxB <= lim + 2 * 1.6 * 1048576;
  console.log(`tm=thin ticks=${end}${small ? ' small' : ''} actions=${main.actions.length} branches=${tl.branches.length}`);
  console.log(`TM thin: ${ok ? 'ok' : 'FAIL'} tierDrops=${tierDrops.length} neededAgain=${needed} budgetDrops=${budget} maxSnaps=${maxN} final=${tl.snapCount()} ${JSON.stringify(kinds)} maxBytes=${MB(maxB)}MB (lim ${MB(lim)}) samples=${main.samples.length} archive max ${sampMB.toFixed(1)}MB root=${+root} full@${fullAt}`);
  console.log(` autos kept: ${autos.join(' ')}`);
  if (!ok) process.exitCode = 1;
}

// ---------------- cmp (этап 5: сравнение веток) ----------------

/**
 * Ветка без вмешательства из прошлого — тот же мир (Брей — Кёртис 0%, «История повторилась в точности»);
 * ветка «новый случай» — другой; общий предок и nxShared; удаление листа.
 */
export function cmp({ T, mk }: Ctx): void {
  const w = mk();
  const tl = new Timeline();
  tl.trap = true;
  tl.reset(w);
  const half = Math.round(T / 2 / TM.SNAP_EVERY) * TM.SNAP_EVERY;
  while (w.tick < T) tl.step(w);
  const A = tl.active;
  const snap = tl.lineageSnaps(A).find((s) => s.tick === half)!;
  // Б: из прошлого без вмешательства — история та же
  tl.visit(w, snap);
  const B = tl.forkHere(w, null)!;
  while (w.tick < T) tl.step(w);
  const pAB = comparePair(tl, A, B)!;
  // В: из того же снимка — бросить кости заново
  tl.switchTo(w, A.id);
  tl.visit(w, snap);
  const C = tl.forkHere(w, { k: 'reseed', salt: 12345, t: w.tick })!;
  while (w.tick < T) tl.step(w);
  const pAC = comparePair(tl, A, C)!;
  const pBC = comparePair(tl, B, C)!;
  const exact = pAB.pct === 0 && pAB.bullets.some((b) => b.fact === 'tm_seed') && pAB.td === half && pAB.tc === T;
  const differ = pAC.td === half && pAC.nx === C.nxFork && pAC.pct > 0 && !pAC.bullets.some((b) => b.fact === 'tm_seed');
  const sib = pBC.td === half && pBC.pct === pAC.pct;
  const names = pAC.leaders.every((L) => L.every((x) => !x.name.startsWith('вид #')));
  const del = !tl.deleteBranch(A.id) && !tl.deleteBranch(C.id) && tl.deleteBranch(B.id) && tl.branches.length === 2 && !tl.lineageSnaps(A).some((s) => s.forks.has(B.id));
  const ok = exact && differ && sib && names && del;
  console.log(`TM cmp: ${ok ? 'ok' : 'FAIL'} same=${+exact} (pct ${pAB.pct}, ${pAB.bullets.length} bullets) reseed=${+differ} (pct ${pAC.pct}% at day ${Math.floor(pAC.tc / 150)}, td ${pAC.td}) siblings=${+sib} names=${+names} delete=${+del}`);
  for (const b of pAC.bullets) console.log(`  · ${b.text}`);
  console.log(`  лидеры А: ${pAC.leaders[0].map((x) => `${x.name} ${x.n}${x.fresh ? ' (новый)' : ''}`).join(', ')} | В: ${pAC.leaders[1].map((x) => `${x.name} ${x.n}${x.fresh ? ' (новый)' : ''}`).join(', ')}`);
  if (!ok) process.exitCode = 1;
}
