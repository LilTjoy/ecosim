// 🌋 Стенд живой планеты, этап 0: --tm=geo — ворота D1 (кисть рельефа), D2, D3 и P1 (накладные расходы).
//  D1: мир с живой планетой, сценарий мазков кисти 🏔/🌊 (точки одного такта приходят по одной — как со страницы,
//      а в записи сливаются в одно действие, если между ними нет снимка); снимки в 10 случайных точках, в том числе
//      посреди мазка (очередь pend не пуста) — каждый восстанавливается (по очереди в тот же и в свежий мир) и
//      доигрывается до следующей точки по слитой записи: отпечаток обязан совпасть; последний — до конца, с летописью.
//      Плюс «воркер»: JobRunner (сообщения через structuredClone) от снимка посреди мазка до конца = живой прогон.
//  D2: в мир с затопленным и перекопанным рельефом встаёт снимок мира без живой планеты (и «старый» снимок без её
//      ключей) → rev = 0 и все поля рельефа и почвы — как у свежего new Terrain / свежего мира.
//  D3: две ветки с разными мазками, но равными суммами elevD → восстановление меняет рельеф правильно (туда и обратно).
//  P1: шаг с lp против без lp (один мир-снимок, попеременно кусками) и время пересчёта при шаге моря.
import { World, type BrainMode } from '../src/sim/world';
import { SNAP_DEV, uncoveredKeys, type WorldSnap } from '../src/sim/snapshot';
import { Terrain } from '../src/sim/terrain';
import { deriveTerrain, GEO } from '../src/sim/geo';
import { InputLog, inputArrays, type Action } from '../src/sim/timeline';
import { JobRunner, type DoneMsg, type FromWorker } from '../src/sim/tmJob';
import { mulberry32 } from '../src/lib/random';

interface Ctx { seed: number; T: number; mode: BrainMode; salt: number; mk: () => World; flags: Record<string, string> }

const now = () => performance.now();
const hex = (d: number) => (d >>> 0).toString(16);
const evJson = (w: World) => JSON.stringify(w.events);

type Op = { t: number; pts: [number, number]; r: number; dz: number };

/** Мазки: подъём суши в море и опускание суши под воду; точки одного такта идут подряд. */
function strokes(T: number, seed: number, w: World): Op[] {
  const R = mulberry32(seed * 613 + 5);
  const ops: Op[] = [];
  const n = 14;
  // у берега: пляж и мелководье — мазки там топят сушу (звери уходят) и поднимают новую (новые регионы)
  const t0 = w.terrain, coast: number[] = [];
  for (let i = 0; i < t0.biome.length; i++) if (t0.biome[i] === 1 || t0.biome[i] === 2) coast.push(i);
  for (let k = 0; k < n; k++) {
    const t = Math.round(((k + 0.5) / n) * (T - 400)) + 100 + Math.floor(R() * 50);
    const ci = coast[Math.floor(R() * coast.length)];
    const x = ((ci % t0.cols) + 0.5) * w.cell, y = (Math.floor(ci / t0.cols) + 0.5) * w.cell;
    const r = 60 + R() * 120, dz = (R() < 0.6 ? -1 : 1) * Math.round(300 + R() * 900);
    const pts = 3 + Math.floor(R() * 6);
    // мазок тянется по нескольким тактам: каждые 2 такта — несколько точек подряд
    for (let p = 0; p < pts; p++) {
      const tt = t + 2 * Math.floor(p / 3);
      ops.push({ t: tt, pts: [x + p * r * 0.4, y + p * r * 0.15], r, dz });
    }
  }
  ops.sort((a, b) => a.t - b.t);
  return ops;
}

/** Точка снимка: перед операцией j такта t (j = ops.length — перед шагом). */
type Cap = { t: number; j: number; snap: WorldSnap; cursor: number; pend: number };

const geoWorld = (mk: () => World, mode: BrainMode, seed: number, salt: number, on = true) => {
  const w = mk();
  if (on) w.settings.livePlanet = true;
  else delete w.settings.livePlanet;
  w.reset(mode, seed, w.env, salt);
  return w;
};

/** Сравнить поля рельефа двух Terrain. */
function sameTerrain(a: Terrain, b: Terrain): string | null {
  const keys = ['elev', 'moist', 'baseTemp', 'biome', 'region', 'drain', 'order', 'flow', 'river', 'rivId'] as const;
  for (const k of keys) {
    const x = a[k], y = b[k];
    const ux = new Uint8Array(x.buffer, x.byteOffset, x.byteLength), uy = new Uint8Array(y.buffer, y.byteOffset, y.byteLength);
    if (ux.length !== uy.length) return `${k}: length`;
    for (let i = 0; i < ux.length; i++) if (ux[i] !== uy[i]) return `${k}: byte ${i}`;
  }
  if (JSON.stringify(a.rivers) !== JSON.stringify(b.rivers)) return 'rivers';
  if (JSON.stringify(a.springs) !== JSON.stringify(b.springs)) return 'springs';
  if (a.seaLevel !== b.seaLevel) return 'seaLevel';
  if (JSON.stringify(a.regions) !== JSON.stringify(b.regions)) return 'regions';
  if (a.rev !== b.rev) return `rev ${a.rev} ≠ ${b.rev}`;
  return null;
}
/** Статичные поля почвы двух миров. */
function sameStatics(a: World, b: World): string | null {
  for (const k of ['isWater', 'microBase', 'leachK', 's0']) {
    const x = (a as any)[k] as ArrayLike<number>, y = (b as any)[k] as ArrayLike<number>;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return `${k}[${i}] ${x[i]} ≠ ${y[i]}`;
  }
  return null;
}

export function geo({ seed, T, mode, salt, mk }: Ctx): void {
  SNAP_DEV.strict = true;
  console.log(`seed ${seed} ${mode} tm=geo T=${T}`);
  // ---------------- D1 ----------------
  const A = geoWorld(mk, mode, seed, salt);
  const ops = strokes(T, seed, A);
  const R = mulberry32(seed * 7 + 99);
  // 10 точек: 4 посреди мазка (перед второй/третьей точкой такта), остальные — случайные такты перед шагом
  const capAt = new Map<string, boolean>();
  const mids = ops.map((o, j) => ({ o, j })).filter(({ o, j }) => j > 0 && ops[j - 1].t === o.t && ops[j - 1].r === o.r);
  for (let k = 0; k < 4 && mids.length; k++) {
    const m = mids[Math.floor(((k + 0.5) / 4) * mids.length)];
    capAt.set(`${m.o.t}:${m.j}`, true);
  }
  while (capAt.size < 10) capAt.set(`${200 + Math.floor(R() * (T - 400))}:-1`, true);
  const merged: Action[] = [];
  const caps: Cap[] = [];
  let open: Action | null = null;
  let j = 0;
  const t0 = now();
  let evac = 0;
  while (A.tick < T) {
    if (capAt.has(`${A.tick}:-1`)) {
      caps.push({ t: A.tick, j: -1, snap: A.captureState(), cursor: merged.length, pend: A.geo!.pend.length });
      open = null;
    }
    while (j < ops.length && ops[j].t === A.tick) {
      if (capAt.has(`${A.tick}:${j}`)) {
        caps.push({ t: A.tick, j, snap: A.captureState(), cursor: merged.length, pend: A.geo!.pend.length });
        open = null; // конец мазка вошёл в снимок — дальше новое действие (как Timeline.grassOpen)
      }
      const o = ops[j++];
      const a: Action = { k: 'terra', t: A.tick, pts: [...o.pts], r: o.r, dz: o.dz };
      A.apply(a);
      if (open && open.k === 'terra' && open.t === a.t && open.r === a.r && open.dz === a.dz) open.pts.push(...a.pts);
      else merged.push((open = structuredClone(a)));
    }
    const ev0 = A.events.length;
    A.step();
    for (let e = ev0; e < A.events.length; e++) if (A.events[e].text.startsWith('🌊 Море наступило')) evac++;
    open = null;
  }
  const liveMs = now() - t0;
  const dEnd = A.captureState().digest, eEnd = evJson(A);
  const cover = uncoveredKeys(A);
  const fails: string[] = [];
  let okN = 0;
  const G = geoWorld(mk, mode, seed, salt, false); // половина — в тот же мир (без живой планеты!), половина — в свежий
  caps.sort((a, b) => a.t - b.t || a.j - b.j);
  for (let k = 0; k < caps.length; k++) {
    const c = caps[k];
    const X = k % 2 ? geoWorld(mk, mode, seed, salt, false) : G;
    X.loadState(c.snap);
    const again = X.captureState();
    const until = k + 1 < caps.length ? caps[k + 1] : null;
    const stopT = until ? until.t : T;
    let ai = c.cursor;
    let got: number | null = null;
    while (X.tick <= stopT) {
      // в такте следующей точки — действия до её курсора, затем снимок
      while (ai < merged.length && merged[ai].t === X.tick && (!until || X.tick < until.t || ai < until.cursor)) X.apply(merged[ai++]);
      if (until && X.tick === until.t) {
        got = X.captureState().digest;
        break;
      }
      if (!until && X.tick === T) break;
      X.step();
    }
    const want = until ? until.snap.digest : dEnd;
    if (!until) got = X.captureState().digest;
    const evOk = until ? true : evJson(X) === eEnd;
    if (again.digest === c.snap.digest && got === want && evOk) okN++;
    else fails.push(`@${c.t}/${c.j}${again.digest !== c.snap.digest ? ' roundtrip' : ''}${got !== want ? ` digest ${hex(got ?? 0)}≠${hex(want)}` : ''}${evOk ? '' : ' events'}`);
  }
  // «воркер»: от первого снимка посреди мазка до конца
  const midCap = caps.find((c) => c.pend > 0) ?? caps[0];
  const inbox: FromWorker[] = [];
  const JR = new JobRunner((m, tr) => inbox.push(structuredClone(m, { transfer: tr ?? [] })), () => geoWorld(mk, mode, seed, salt, false));
  JR.handle(structuredClone({ type: 'run', job: 1, run: 0, snap: midCap.snap, acts: merged.slice(midCap.cursor), actBase: midCap.cursor, input: inputArrays(new InputLog()), inBase: 0, until: T, snapEvery: 0, rows: false, samples: false, marks: false, final: false }));
  JR.drain();
  const done = inbox.find((m): m is DoneMsg => m.type === 'done');
  const workerOk = !!done && done.digest[0] === dEnd;
  const midN = caps.filter((c) => c.pend > 0).length;
  const d1 = okN === caps.length && workerOk && cover.length === 0 && midN >= 3 && A.terrain.rev !== 0;
  console.log(`TM D1: ${d1 ? 'ok' : 'FAIL'} restores=${okN}/${caps.length} midStroke(pend>0)=${midN} worker=${workerOk ? 'same' : `DIFF ${hex(done?.digest[0] ?? 0)}≠${hex(dEnd)}${done?.error ? ' ' + done.error : ''}`} cover=${cover.length}${cover.length ? `(${cover.join(',')})` : ''} ops=${ops.length} acts=${merged.length} derives=${A.geo!.stats.derives} evacLogs=${evac} rev=${hex(A.terrain.rev)} elevD≠0=${A.elevD!.reduce((s, v) => s + (v !== 0 ? 1 : 0), 0)} end=${hex(dEnd)} ${(liveMs / T).toFixed(2)} ms/tick${fails.length ? ' | fails: ' + fails.join(' ') : ''}`);
  console.log(` caps: ${caps.map((c) => `${c.t}${c.j >= 0 ? `/${c.j}` : ''}(pend ${c.pend})`).join(' ')}`);

  // ---------------- D2 ----------------
  const F = geoWorld(mk, mode, seed, salt); // будет затоплен и перекопан
  for (let i = 0; i < 400; i++) F.step();
  const sNo = (() => { const N = geoWorld(mk, mode, seed, salt, false); for (let i = 0; i < 300; i++) N.step(); return N.captureState(); })();
  const sOld: WorldSnap = structuredClone(sNo);
  delete (sOld.scal.settings as Record<string, unknown>).livePlanet;
  const sLpBase = F.captureState(); // свой снимок с живой планетой до правок (рельеф — исходный)
  const flood = (w: World) => {
    w.geo!.seaQ = 0.02;
    w.apply({ k: 'terra', t: w.tick, pts: [1600, 1000, 900, 600], r: 220, dz: -1500 });
    w.step();
    if (w.terrain.rev === 0) throw new Error('D2: рельеф не изменился');
  };
  const fresh = new Terrain(F.width, F.height, F.cell, seed, F.env.sea, F.env.tempOffset, F.env.volcanism ?? 1);
  const freshW = geoWorld(mk, mode, seed, salt, false);
  const d2: string[] = [];
  for (const [name, s] of [['!lp', sNo], ['old', sOld], ['lp@base', sLpBase]] as const) {
    flood(F);
    const before = F.terrain;
    F.loadState(s);
    const e = (F.terrain !== before ? 'identity ' : '') + (sameTerrain(F.terrain, fresh) ?? '') + ' ' + (sameStatics(F, freshW) ?? '');
    d2.push(`${name}:${e.trim() || 'same'}${F.lp ? '(lp)' : ''}`);
    if (!F.lp) {
      // вернуть миру живую планету для следующей проверки
      F.loadState(sLpBase);
    }
  }
  const d2ok = d2.every((x) => /:same/.test(x));
  console.log(`TM D2: ${d2ok ? 'ok' : 'FAIL'} ${d2.join(' ')}`);

  // ---------------- D3 ----------------
  // ветка 1: +a, −b; ветка 2: −a, +b — суммы elevD равны, рельеф разный
  const P = geoWorld(mk, mode, seed, salt);
  for (let i = 0; i < 200; i++) P.step();
  const s0 = P.captureState();
  const br = (sign: number) => {
    const w = geoWorld(mk, mode, seed, salt, false);
    w.loadState(s0);
    w.apply({ k: 'terra', t: w.tick, pts: [900, 700], r: 150, dz: 1000 * sign });
    w.apply({ k: 'terra', t: w.tick, pts: [2300, 1300], r: 150, dz: -1000 * sign });
    for (let i = 0; i < 50; i++) w.step();
    return w;
  };
  const B1 = br(1), B2 = br(-1);
  let sum1 = 0, sum2 = 0;
  for (let i = 0; i < B1.elevD!.length; i++) { sum1 += B1.elevD![i]; sum2 += B2.elevD![i]; }
  const S1 = B1.captureState(), S2 = B2.captureState();
  const X = geoWorld(mk, mode, seed, salt, false);
  const d3: string[] = [];
  X.loadState(S1);
  d3.push('1:' + (sameTerrain(X.terrain, B1.terrain) ?? 'same'));
  X.loadState(S2);
  d3.push('1→2:' + (sameTerrain(X.terrain, B2.terrain) ?? 'same') + '/' + (sameStatics(X, B2) ?? 'same'));
  X.loadState(S1);
  d3.push('2→1:' + (sameTerrain(X.terrain, B1.terrain) ?? 'same') + '/' + (sameStatics(X, B1) ?? 'same'));
  X.loadState(s0);
  d3.push('→base:' + (sameTerrain(X.terrain, fresh) ?? 'same'));
  const d3ok = sum1 === sum2 && B1.terrain.rev !== B2.terrain.rev && d3.every((x) => !/byte|rev|length|rivers|springs|sea|regions|\[/.test(x));
  console.log(`TM D3: ${d3ok ? 'ok' : 'FAIL'} sums ${sum1}/${sum2} rev ${hex(B1.terrain.rev)}/${hex(B2.terrain.rev)} ${d3.join(' ')}`);

  // ---------------- P1 ----------------
  // тот же мир с lp и без (поведение на этапе 0 одинаково): попеременно 12 × 200 тактов
  const L = geoWorld(mk, mode, seed, salt);
  const N = geoWorld(mk, mode, seed, salt, false);
  for (let i = 0; i < 2000; i++) { L.step(); N.step(); }
  let msL = 0, msN = 0;
  for (let k = 0; k < 12; k++) {
    let t1 = now(); for (let i = 0; i < 200; i++) N.step(); msN += now() - t1;
    t1 = now(); for (let i = 0; i < 200; i++) L.step(); msL += now() - t1;
  }
  // пересчёт при шаге моря: лесенка 0…−0.04…0, 3 прохода (первые 3 — разогрев JIT, отдельно)
  const dms: number[] = [];
  for (let k = 0; k < 63; k++) {
    const q = k % 20 <= 10 ? k % 20 : 20 - (k % 20);
    L.geo!.seaQ = -GEO.SEA_STEP * q;
    const t1 = now();
    deriveTerrain(L, true);
    dms.push(now() - t1);
    for (let i = 0; i < 20; i++) L.step();
  }
  const cold = dms.slice(0, 3), warm = dms.slice(3).sort((a, b) => a - b);
  const p = (q: number) => warm[Math.min(warm.length - 1, Math.floor(q * warm.length))];
  const over = msL / msN - 1;
  const p1 = over <= 0.05 && p(0.5) <= 7 && p(0.99) <= 10;
  console.log(`TM P1: ${p1 ? 'ok' : 'FAIL'} steady ${(msN / 2400).toFixed(3)} → ${(msL / 2400).toFixed(3)} ms/tick (${(100 * over).toFixed(1)}%) derive p50=${p(0.5).toFixed(2)} p99=${p(0.99).toFixed(2)} max=${warm.at(-1)!.toFixed(2)} ms (n=${warm.length}; cold first 3: ${cold.map((x) => x.toFixed(1)).join('/')})`);
  if (!(d1 && d2ok && d3ok)) process.exitCode = 1;
}
