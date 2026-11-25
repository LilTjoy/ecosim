// ⏪ Стенд машины времени, этапы 6–7: --tm=bg — фоновые прогоны (воркер) тем же кодом, что в браузере.
// JobRunner гоняется здесь же; сообщения в обе стороны проходят structuredClone (страница → воркер — копия,
// воркер → страница — с передачей буферов), как postMessage. Проверки (G8):
//  a) «что если бы не было метеорита»: ветка досчитана в фоне = та же ветка, досчитанная вживую;
//  b) «параллельная вселенная»: предок идёт в фоне кусками, пока живёт потомок, = мир без машины времени;
//  c) «🔁 Точно так же»: пересчёт ветки с развилки её же записью — до бита та же голова;
//  d) «🦋 Эффект бабочки»: два мира шаг в шаг; мир без бабочки = отдельный прогон; когда видна разница;
//  e) мир с бабочкой → ветка: переход на неё и «Точно так же» с развилки;
//  f) «🎲 Плёнка жизни» с сотворения: «Ваш мир» = запись линии; миры с другими костями — другие; один → ветка.
import { World, guildOf, type BrainMode } from '../src/sim/world';
import { Timeline, TM, inputArrays, type Action, type Branch, type ExpStart, type InputLog } from '../src/sim/timeline';
import { JobRunner, type DoneMsg, type FrameMsg, type FromWorker, type ProgressMsg, type ToWorker } from '../src/sim/tmJob';
import { recycleSnap } from '../src/sim/snapshot';
import { mulberry32 } from '../src/lib/random';
import { blountJobs, blountKind, blountPlan, blountRepeated, blountVerdict, type BlountKind, type BlountRow } from '../src/sim/tmBlount';

interface Ctx { seed: number; T: number; mode: BrainMode; salt: number; mk: () => World; flags: Record<string, string> }

const now = () => performance.now();
const hex = (d: number) => (d >>> 0).toString(16);

/** «Воркер» в этом же процессе: копии сообщений, буферы снимков передаются (у отправителя отсоединяются). */
function inproc(mk: () => World) {
  const inbox: FromWorker[] = [];
  let detached = 0;
  const R = new JobRunner(
    (m, tr) => {
      const c = structuredClone(m, { transfer: tr ?? [] });
      if (tr?.length && (tr[0] as ArrayBuffer).byteLength === 0) detached++;
      inbox.push(c);
    },
    () => mk(),
  );
  let seq = 0;
  return {
    get detached() {
      return detached;
    },
    job: () => ++seq,
    /** Отправить и досчитать; вернуть все ответы. */
    run(m: ToWorker): FromWorker[] {
      R.handle(structuredClone(m));
      R.drain();
      return inbox.splice(0);
    },
  };
}
type Proc = ReturnType<typeof inproc>;

/** Продолжить ветку в фоне до until (как TmRunner.continueBranch). */
function bg(P: Proc, tl: Timeline, b: Branch, until: number): DoneMsg | null {
  const spec = tl.bgSpec(b, until);
  if (!spec) return null;
  const job = P.job();
  tl.bgBegin(b, job, until);
  let done: DoneMsg | null = null;
  for (const m of P.run({ type: 'run', job, run: 0, snap: spec.snap, acts: spec.acts, actBase: spec.actBase, input: inputArrays(spec.input), inBase: spec.inBase, until, snapEvery: TM.BG_SNAP, rows: true, samples: true, marks: true, final: true })) {
    if (m.type === 'progress') tl.bgProgress(b, job, m);
    else if (m.type === 'snap') tl.bgSnap(b, job, m.snap);
    else if (m.type === 'done') done = m;
  }
  tl.bgEnd(b, job);
  return done;
}

/** «Точно так же»: digest пересчёта и ожидаемый. */
function verify(P: Proc, tl: Timeline, w: World, b: Branch): { ok: boolean; got: number; want: number; ticks: number } {
  const v = tl.verifySpec(w, b);
  if (!v) return { ok: false, got: 0, want: 0, ticks: 0 };
  const s = v.spec;
  const out = P.run({ type: 'run', job: P.job(), run: 0, snap: s.snap, acts: s.acts, actBase: s.actBase, input: inputArrays(s.input), inBase: s.inBase, until: s.until, snapEvery: 0, rows: false, samples: false, marks: false, final: false });
  const d = out.find((m): m is DoneMsg => m.type === 'done')!;
  return { ok: d.digest[0] === v.digest, got: d.digest[0], want: v.digest, ticks: s.until - s.snap.tick };
}

const rowSig = (b: Branch, from: number) => b.rows.filter((r) => r.t > from).map((r) => `${r.t}:${r.n}:${r.g.join(',')}:${[...r.ids].join(',')}`).join('|');
const markSig = (b: Branch, from: number) => b.marks.filter((m) => m.t > from).map((m) => `${m.t}:${m.text}`).sort().join('|');

export function bgGate({ seed, T, mode, mk, flags }: Ctx): void {
  const P = inproc(mk);
  const w = mk();
  const tl = new Timeline();
  tl.trap = true;
  const toasts: string[] = [];
  tl.onToast = (s) => toasts.push(s);
  tl.reset(w);
  const R = mulberry32(seed * 131 + 9);
  const T1 = Math.round(T / 2 / 300) * 300;
  // запись: вселение, ввод мышью (fround), три метеорита, засуха
  const ops = new Map<number, () => void>();
  const at = (q: number) => Math.round(q * T1);
  ops.set(at(0.1), () => { const l = w.creatures.filter((c) => c.alive && c.g.swim < 0.6); const c = l[l.length >> 2]; if (c) tl.record(w, { k: 'possess', id: c.id, t: w.tick }); });
  for (const q of [0.3, 0.55, 0.8]) ops.set(at(q), () => tl.record(w, { k: 'meteor', x: 300 + R() * 2600, y: 300 + R() * 1400, t: w.tick }));
  ops.set(at(0.45), () => tl.record(w, { k: 'drought', t: w.tick }));
  const steer = (t: number) => {
    if (t > at(0.1) && t % 29 === 0) Object.assign(w.input, { dx: Math.fround(R() * 2 - 1), dy: Math.fround(R() * 2 - 1), run: R() < 0.3 });
  };
  /** rec — поступки и ввод «страницы» (у ветки «без метеорита» их повторяет сама запись). */
  const live = (until: number, rec = true) => {
    while (w.tick < until) {
      if (rec) {
        ops.get(w.tick)?.();
        steer(w.tick);
      }
      tl.step(w);
    }
  };
  let t0 = now();
  live(T1);
  const main = tl.active;
  const dMain = tl.digestNow(w);
  console.log(`seed ${seed} ${mode} tm=bg T1=${T1} acts=${main.actions.length} input=${main.input.n} ${((now() - t0) / T1).toFixed(2)} ms/tick`);

  // a) «что если бы не было метеорита» — в фоне до головы предка, против той же ветки вживую
  const ref = main.actions.findIndex((a) => a.k === 'meteor' && a.t === at(0.55));
  const tm = main.actions[ref].t;
  let b: Branch | null = null;
  tl.forkWithout(w, ref, true, (x) => (b = x));
  tl.finish(w);
  const nb = b as Branch | null;
  const back = !!nb && tl.switchTo(w, main.id) && tl.digestNow(w) === dMain;
  t0 = now();
  const dn = nb ? bg(P, tl, nb, main.headTick) : null;
  const msBg = now() - t0;
  const dBg = nb?.head?.snap.digest ?? 0;
  let c: Branch | null = null;
  tl.forkWithout(w, ref, true, (x) => (c = x));
  tl.finish(w);
  const nc = c as Branch | null;
  live(T1, false);
  const dLive = tl.digestNow(w);
  const rowsSame = !!nb && !!nc && rowSig(nb, tm) === rowSig(nc, tm) && rowSig(nb, tm).length > 0;
  const marksSame = !!nb && !!nc && markSig(nb, tm) === markSig(nc, tm);
  const swB = !!nb && tl.switchTo(w, nb.id) && tl.digestNow(w) === dBg;
  const g8a = back && !!dn && !dn.error && nb!.headTick === T1 && dBg === dLive && dBg !== dMain && rowsSame && marksSame && swB && nb!.scheduled === null && nb!.actions.length === nc!.actions.length && nb!.input.n === nc!.input.n && P.detached > 0;
  console.log(`TM G8a: ${g8a ? 'ok' : 'FAIL'} forkWithout meteor@${tm} → bg ${nb?.letter} to ${nb?.headTick} in ${(msBg / 1000).toFixed(1)}s (${(msBg / (T1 - tm)).toFixed(2)} ms/tick) digest ${hex(dBg)} vs live ${hex(dLive)} (main ${hex(dMain)}) rows=${+rowsSame} marks=${+marksSame} switch=${+swB} acts ${nb?.actions.length}/${nc?.actions.length} input ${nb?.input.n}/${nc?.input.n} transfers=${P.detached}${dn?.error ? ' ERR ' + dn.error : ''}`);

  // b) «параллельная вселенная»: развилка в настоящем — предок идёт в фоне кусками (не дальше +600 от живой ветки)
  tl.switchTo(w, main.id);
  const fork = tl.forkHere(w, { k: 'reseed', salt: 4242, t: w.tick })!;
  const followOk = tl.follow === main.id;
  const ref0 = mk();
  ref0.loadState(main.head!.snap);
  const T2 = T1 + Number(flags.ahead ?? 2400);
  let chunks = 0, maxAhead = 0;
  while (w.tick < T2) {
    live(Math.min(T2, w.tick + 300));
    if (tl.follow !== null) {
      const F = tl.branch(tl.follow);
      if (!F.bg && F.headTick < w.tick + TM.FOLLOW_AHEAD) {
        bg(P, tl, F, Math.ceil((w.tick + TM.FOLLOW_CHUNK) / 300) * 300);
        chunks++;
      }
      maxAhead = Math.max(maxAhead, F.headTick - w.tick);
    }
  }
  const refRows: string[] = [];
  while (ref0.tick < main.headTick) {
    ref0.step();
    if (ref0.tick % TM.ROW_EVERY === 0) {
      const g = [0, 0, 0, 0];
      for (const x of ref0.creatures) g[guildOf(x.g)]++;
      refRows.push(`${ref0.tick}:${ref0.creatures.length}:${g.join(',')}`);
    }
  }
  const dRef = ref0.captureState().digest;
  const fRows = main.rows.filter((r) => r.t > T1).map((r) => `${r.t}:${r.n}:${r.g.join(',')}`);
  const g8b = followOk && dRef === main.head!.snap.digest && fRows.join('|') === refRows.join('|') && maxAhead <= TM.FOLLOW_CHUNK + 300 && chunks > 1;
  console.log(`TM G8b: ${g8b ? 'ok' : 'FAIL'} parallel universe ${main.letter} → ${main.headTick} in ${chunks} chunks (max ahead ${maxAhead}) while ${fork.letter} lives to ${w.tick}: digest ${hex(main.head!.snap.digest)} vs plain ${hex(dRef)} rows ${fRows.length}/${refRows.length} ${fRows.join('|') === refRows.join('|') ? 'same' : 'DIFF'} snaps ${main.snaps.filter((s) => s.tick > T1).map((s) => s.tick).join(',')}`);

  // c) «Точно так же»: активная ветка (до «сейчас») и неактивная (до головы)
  t0 = now();
  const v1 = verify(P, tl, w, fork);
  const v2 = nb ? verify(P, tl, w, nb) : { ok: false, got: 0, want: 0, ticks: 0 };
  const g8c = v1.ok && v2.ok;
  console.log(`TM G8c: ${g8c ? 'ok' : 'FAIL'} same-again ${fork.letter} ${hex(v1.got)}/${hex(v1.want)} (${v1.ticks} ticks) · ${nb?.letter} ${hex(v2.got)}/${hex(v2.want)} (${v2.ticks} ticks) ${((now() - t0) / 1000).toFixed(1)}s`);

  // d) эффект бабочки от «сейчас» живой ветки: два мира шаг в шаг
  const st = tl.expStart(w);
  const target = w.creatures[w.creatures.length >> 1];
  const lin = { acts: tl.lineageActsFrom(tl.active, st.cur[0]), input: tl.lineageInputFrom(tl.active, st.cur[1]) };
  const nudge: Action = { k: 'nudge', id: target.id, dx: 1e-6, t: st.tick };
  const fj = P.job();
  t0 = now();
  const fly = P.run({ type: 'multi', job: fj, snap: st.snap, runs: [{ pre: [] }, { pre: [nudge] }], acts: lin.acts, actBase: st.cur[0], input: inputArrays(lin.input), inBase: st.cur[1], until: st.tick + 2400, extend: { max: st.tick + 6000, share: 0.5 }, every: 25, keep: 1 });
  const msFly = now() - t0;
  const frames = fly.filter((m): m is FrameMsg => m.type === 'frame');
  const fdone = fly.find((m): m is DoneMsg => m.type === 'done')!;
  const fsnap = fly.find((m) => m.type === 'snap');
  const first = frames.find((f) => f.cells > 0);
  const half = frames.find((f) => f.share >= 0.5);
  const solo = mk();
  solo.loadState(st.snap);
  while (solo.tick < fdone.tick) solo.step();
  const dSolo = solo.captureState().digest;
  const g8d = !fdone.error && frames[0].cells === 0 && dSolo === fdone.digest[0] && fdone.digest[0] !== fdone.digest[1] && !!fsnap;
  const day = (t?: number) => (t === undefined ? '—' : String(Math.floor((t - st.tick) / 150)));
  console.log(`TM G8d: ${g8d ? 'ok' : 'FAIL'} butterfly #${target.id} from ${st.tick} → ${fdone.tick} (${frames.length} frames, ${(msFly / 1000).toFixed(1)}s): no-fly ${hex(fdone.digest[0])} vs solo ${hex(dSolo)}, fly ${hex(fdone.digest[1])}; first diff +${first ? first.tick - st.tick : '—'} (day ${day(first?.tick)}), half +${half ? half.tick - st.tick : '—'} (day ${day(half?.tick)}), final share ${(100 * frames.at(-1)!.share).toFixed(0)}%${fdone.error ? ' ERR ' + fdone.error : ''}`);

  // e) мир с бабочкой → ветка
  const fRowsP = fly.filter((m): m is ProgressMsg => m.type === 'progress');
  const adoptFly = fsnap && fsnap.type === 'snap' ? tl.adopt(st, {
    acts: [nudge, ...lin.acts], applied: fdone.applied, input: lin.input, inApplied: fdone.inApplied, head: fsnap.snap,
    rows: fRowsP.flatMap((m) => m.rows), marks: fRowsP.flatMap((m) => m.marks), names: fRowsP.flatMap((m) => m.names),
    name: 'Взмах бабочки', icon: '🦋', intervention: nudge,
  }) : null;
  const flyHead = adoptFly?.head?.snap.digest;
  const swF = !!adoptFly && tl.switchTo(w, adoptFly.id) && tl.digestNow(w) === flyHead;
  live(w.tick + 300);
  const v3 = adoptFly ? verify(P, tl, w, adoptFly) : { ok: false, got: 0, want: 0, ticks: 0 };
  const g8e = swF && v3.ok && adoptFly!.forkTick === st.tick && adoptFly!.parent === fork.id;
  console.log(`TM G8e: ${g8e ? 'ok' : 'FAIL'} butterfly → branch ${adoptFly?.letter} (from ${adoptFly?.forkTick}, parent ${adoptFly ? tl.branch(adoptFly.parent!).letter : '—'}) switch=${+swF} +300 live, same-again ${hex(v3.got)}/${hex(v3.want)} rows=${adoptFly?.rows.length}`);

  // f) плёнка жизни с сотворения мира: «Ваш мир» и два мира с другими костями (с моими вмешательствами)
  const H = Number(flags.tape ?? 6000);
  const root = tl.expRoot()!;
  tl.switchTo(w, main.id);
  const L = { acts: tl.lineageActsFrom(main, 0), input: tl.lineageInputFrom(main, 0) };
  type Run = { acts: Action[]; input: InputLog; done?: DoneMsg; snap?: import('../src/sim/snapshot').WorldSnap; prog: ProgressMsg[] };
  const runs: Run[] = [0, 1, 2].map((k) => ({ acts: k === 0 ? L.acts : [{ k: 'reseed', salt: 1000 + k, t: 0 } as Action, ...L.acts], input: L.input, prog: [] }));
  t0 = now();
  for (const [k, r] of runs.entries()) {
    for (const m of P.run({ type: 'run', job: P.job(), run: k, snap: root.snap, acts: r.acts, actBase: 0, input: inputArrays(r.input), inBase: 0, until: root.tick + H, snapEvery: 0, rows: true, samples: false, marks: true, final: true, summary: root.nx })) {
      if (m.type === 'done') r.done = m;
      else if (m.type === 'snap') r.snap = m.snap;
      else if (m.type === 'progress') r.prog.push(m);
    }
  }
  const msTape = now() - t0;
  const atH = tl.lineageSnaps(main).find((s) => s.tick === H);
  const yours = atH ? runs[0].done!.digest[0] === atH.snap.digest : true;
  const yRows = runs[0].prog.flatMap((m) => m.rows).map((r) => `${r.t}:${r.n}`).join('|');
  const lRows = tl.lineageRows(main).filter((r) => r.t > 0 && r.t <= H).map((r) => `${r.t}:${r.n}`).join('|');
  const differ = runs[1].done!.digest[0] !== runs[0].done!.digest[0] && runs[2].done!.digest[0] !== runs[1].done!.digest[0];
  const sum = runs.map((r) => r.done!.summary!);
  const r1 = runs[1];
  const adoptT = tl.adopt(root as ExpStart, {
    acts: r1.acts, applied: r1.done!.applied, input: r1.input, inApplied: r1.done!.inApplied, head: r1.snap!,
    rows: r1.prog.flatMap((m) => m.rows), marks: r1.prog.flatMap((m) => m.marks), names: r1.prog.flatMap((m) => m.names),
    name: 'Плёнка жизни: мир 1', icon: '🎲', intervention: r1.acts[0],
  });
  const schedOk = !!adoptT && !!adoptT.scheduled === r1.done!.applied < r1.acts.length;
  const swT = !!adoptT && tl.switchTo(w, adoptT.id) && tl.digestNow(w) === r1.done!.digest[0];
  live(w.tick + 300, false);
  const v4 = adoptT ? verify(P, tl, w, adoptT) : { ok: false, got: 0, want: 0, ticks: 0 };
  const g8f = !!atH && yours && yRows === lRows && differ && swT && v4.ok && adoptT!.forkTick === 0 && schedOk;
  console.log(`TM G8f: ${g8f ? 'ok' : 'FAIL'} tape from root ×3 to ${H} in ${(msTape / 1000).toFixed(1)}s: yours=${atH ? +yours : 'no snap'} rows=${+(yRows === lRows)} differ=${+differ} → branch ${adoptT?.letter} switch=${+swT} same-again=${+v4.ok} scheduled=${adoptT?.scheduled?.length ?? 0}`);
  for (const [k, s] of sum.entries()) console.log(`  мир ${k}: n=${s.n} g=${s.g.join('/')} видов ${s.live} (новых ${s.fresh}) лидер «${s.top[0]?.name}» ${s.top[0]?.count} · новых с пиком ≥20: ${s.born.length}`);

  const all = g8a && g8b && g8c && g8d && g8e && g8f;
  console.log(`TM bg: ${all ? 'ok' : 'FAIL'} branches=${tl.branches.length} bytes=${(tl.bytes() / 1048576).toFixed(1)}MB snaps=${tl.snapCount()} toasts=${toasts.length}${toasts.length ? ' ' + toasts.slice(0, 4).join(' | ') : ''}`);
  for (const r of runs) if (r.snap) recycleSnap(r.snap);
  if (!all) process.exitCode = 1;
}


// ---------------- «🔬 Повторится ли?» (Блаунт, этап 9) ----------------
//  a) точный повтор с последней точки старта («ваша история») снова приводит к событию;
//  b) миры с новыми костями — другие (digest), а тот же опыт с тем же зерном — до бита тот же (детерминизм);
//  c) таблица «с дня a: k из 2» и вывод — для нового вида, вымирания и исчезновения гильдии (что нашлось в линии).
export function blountGate({ seed, T, mode, mk }: Ctx): void {
  const P = inproc(mk);
  const w = mk();
  const tl = new Timeline();
  tl.trap = true;
  tl.reset(w);
  const R = mulberry32(seed * 977 + 3);
  const meteors = new Set([Math.round(T * 0.35), Math.round(T * 0.6), Math.round(T * 0.62)]);
  let t0 = now();
  while (w.tick < T) {
    if (meteors.has(w.tick)) tl.record(w, { k: 'meteor', x: 300 + R() * 2600, y: 300 + R() * 1400, t: w.tick });
    tl.step(w);
  }
  console.log(`seed ${seed} ${mode} tm=blount T=${T} ${((now() - t0) / T).toFixed(2)} ms/tick marks=${tl.lineageMarks().length}`);
  const marks = tl.lineageMarks().filter((m) => m.t >= 3000 && m.t <= T - 1300);
  const kinds: Record<string, number[]> = {};
  for (const m of tl.lineageMarks()) {
    const k = blountKind(m);
    if (k) (kinds[k] ??= []).push(m.t);
  }
  console.log(`  события для опыта: ${Object.entries(kinds).map(([k, ts]) => `${k} @${ts.join(',')}`).join(' · ') || 'нет'}`);
  const pick = (k: BlountKind) => [...marks].reverse().find((m) => blountKind(m) === k && blountPlan(tl, m));
  const chosen = (['birth', 'extinct', 'guild'] as BlountKind[]).map((k) => [k, pick(k)] as const).filter(([, m]) => m);
  let all = chosen.length > 0;
  for (const [kind, m] of chosen) {
    const plan = blountPlan(tl, m!)!;
    t0 = now();
    const jobs = blountJobs(tl, plan, seed);
    const res = jobs.map((j) => {
      const out = P.run({ ...j.job, job: P.job() } as ToWorker);
      const done = out.find((x): x is DoneMsg => x.type === 'done')!;
      const rows = out.filter((x): x is ProgressMsg => x.type === 'progress').flatMap((x) => x.rows);
      return { j, done, rows };
    });
    const ms = now() - t0;
    const ref = res.find((r) => !r.j.reseed)!;
    const Xmean = plan.kind === 'birth' ? ref.done.summary?.watch?.mean ?? null : null;
    const refOk = plan.kind === 'birth' ? !!ref.done.summary?.watch?.found : blountRepeated(plan, ref.done.summary!, ref.rows, Xmean) === true;
    const table: BlountRow[] = plan.starts.map((s) => ({ tick: s.tick, yes: 0, of: 0 }));
    for (const r of res) {
      if (!r.j.reseed) continue;
      const rep = blountRepeated(plan, r.done.summary!, r.rows, Xmean);
      if (rep === null) continue;
      table[r.j.start].of++;
      if (rep) table[r.j.start].yes++;
    }
    const last = res.filter((r) => r.j.start === plan.starts.length - 1);
    const differ = last.filter((r) => r.j.reseed).every((r) => r.done.digest[0] !== ref.done.digest[0]);
    // тот же опыт с тем же зерном — те же миры
    const again = P.run({ ...res[0].j.job, job: P.job() } as ToWorker).find((x): x is DoneMsg => x.type === 'done')!;
    const det = again.digest[0] === res[0].done.digest[0];
    const errs = res.filter((r) => r.done.error).length;
    const ok = refOk && differ && det && errs === 0;
    all &&= ok;
    console.log(`TM G9 ${kind}: ${ok ? 'ok' : 'FAIL'} «${plan.text}» @${plan.t} starts ${plan.starts.map((s) => s.tick).join('/')} → ${plan.until}: ${jobs.length} runs in ${(ms / 1000).toFixed(1)}s ref=${+refOk} differ=${+differ} det=${+det}${errs ? ' errors=' + errs : ''}`);
    console.log(`  ${table.map((r) => `с ${r.tick}: ${r.of ? `${r.yes} из ${r.of}` : '—'}`).join(' · ')} → ${blountVerdict(table, plan.kind)}`);
  }
  if (!chosen.length) console.log('TM G9: FAIL — в линии нет подходящих событий');
  console.log(`TM blount: ${all ? 'ok' : 'FAIL'} kinds=${chosen.map(([k]) => k).join(',')}`);
  if (!all) process.exitCode = 1;
}
