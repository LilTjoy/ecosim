// Балансный стенд: node-прогон мира без браузера.
// npm run bench -- <seed> <ticks> [rules|neural] [--soil=0|1] [--disease=0|1] [--rescue=0|1] [--rng=k] [--UN=..] [--BETA=..]
// --tool=1 — инструмент «эпидемия» на такте 10000 (или --toolAt=N), отчёт через 3000 тактов
// --trap=1 — Math.random внутри симуляции бросает исключение (по умолчанию для --tm=*)
// --tm=det|fly|load|thin — проверки машины времени (снимки, точная перемотка, эффект бабочки, ветки и память),
//   см. scripts/tmBench.ts и scripts/tmTimeline.ts
// ♾️ открытая эволюция: --oe=0|1 (= --openEvo), любая ручка EVO из src/sim/modules.ts (--P_DUP=0 --BENTHIC=1 …,
//   логические — «!== '0'»), --benthic=0|1, --her=cold|dark|lowO2|bottle|young|murky (условия планеты).
//   Строки OE:/modfreq/… печатаются только при включённой открытой эволюции; без неё вывод прежний (ворота O0,
//   см. scripts/oe-o0.sh).
import * as WM from '../src/sim/world';
const { World, guildOf } = WM;
import { runTm } from './tmBench';
import { BIOMES } from '../src/sim/terrain';
import * as MM from '../src/sim/modules';
import * as BM from '../src/sim/bestiary';
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags: Record<string, string> = {};
for (const a of process.argv.slice(2)) if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? '1'; }
const seed = Number(pos[0] ?? 42);
const T = Number(pos[1] ?? 30000);
const mode = (pos[2] ?? 'rules') as any;
// --every=N — шаг строк отчёта (по умолчанию T/5)
const EV = Number(flags.every ?? T / 5);
// детерминированный Math.random (LCG) — для кода вне симуляции (симуляция берёт кости из своего зерна)
// --rng=k — «соль» зерна: та же карта, другие основатели, трава и кости — для оценки шума
let rs = (seed * 7 + 1 + Number(flags.rng ?? 0)) >>> 0;
const lcg = () => (rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296;
Math.random = lcg;
const salt = Number(flags.rng ?? 0);
const trap = () => { throw new Error('Math.random в симуляции'); };
const trapOn = flags.trap !== undefined ? flags.trap !== '0' : !!flags.tm;
// флаги пишем в settings, только если такое поле уже есть
const applyFlags = (w: InstanceType<typeof World>) => {
  const W = w as any;
  for (const k in flags) if (k in w.settings) W.settings[k] = typeof W.settings[k] === 'boolean' ? flags[k] !== '0' : Number(flags[k]);
  if (flags.oe !== undefined && 'openEvo' in w.settings) W.settings.openEvo = flags.oe !== '0';
};
// ручки открытой эволюции (и будущих таблиц: открытия, наследство) — по имени, в том же духе, что SOIL/DIS
const KNOBS: Record<string, unknown>[] = [MM.EVO, BM.BEST, BM.CONV] as unknown as Record<string, unknown>[];
for (const mod of KNOBS) for (const k in flags) if (k in mod) mod[k] = typeof mod[k] === 'boolean' ? flags[k] !== '0' : Number(flags[k]);
if (flags.convdiag) BM.CONV_DIAG.on = true;
if (flags.benthic !== undefined) MM.EVO.BENTHIC = flags.benthic !== '0';
// --her=… — условия планеты (поля, которых мир пока не знает, он просто не читает)
const HER: Record<string, Record<string, unknown>> = {
  cold: { heritage: { cold: 0.8 } },
  dark: { light: 0.4, heritage: { dark: 0.8, light: 0.4 } },
  lowO2: { o2: 0.12, heritage: { lowO2: 0.8 } },
  bottle: { heritage: { bottleneck: 0.9, crisis: { id: 'impact10', label: 'Удар астероида', agoMyr: 10, setback: true } } },
  young: { heritage: { animalAge: 0.05 } },
  murky: { murk: 0.6 },
};
if (flags.her && !HER[flags.her]) throw new Error(`--her=${flags.her}: есть ${Object.keys(HER).join(', ')}`);
const herEnv = flags.her ? ({ ...WM.EARTH_ENV, light: 1, murk: 0, pressure: 1, magField: true, ...HER[flags.her] } as WM.SurfaceEnv) : undefined;
/** Новый мир (конструктор вызывает reset() со случайным зерном — ловушку ставим только после него). */
const mkWorld = () => {
  Math.random = lcg;
  const w = new World(3200, 2000);
  if (trapOn) Math.random = trap;
  applyFlags(w);
  return w;
};
const w = mkWorld();
const W = w as any;
// ручки баланса почвы: --UN=0.15 --DUNG=0.5 --TAU=1500 --clampL=0.75,1.2 --clampW=0.7,1.25
const SO = (WM as any).SOIL, NC = (WM as any).NUT_CLAMP, DI = (WM as any).DIS;
for (const k in flags) {
  if (SO && k in SO) SO[k] = Number(flags[k]);
  if (DI && k in DI) DI[k] = Number(flags[k]);
  if (NC && k === 'clampL') NC.land = flags[k].split(',').map(Number);
  if (NC && k === 'clampW') NC.water = flags[k].split(',').map(Number);
  if (NC && k === 'clampC') NC.corpse = flags[k].split(',').map(Number);
}
if (flags.tm) {
  runTm(flags.tm, { seed, T, mode, salt, flags, mk: () => { const x = mkWorld(); x.reset(mode, seed, herEnv, salt); return x; } });
  process.exit();
}
w.reset(mode, seed, herEnv, salt);
// ♾️ только при открытой эволюции: счётчики строк журнала, первые такты событий, смерти хищников
const OE = !!W.oe;
const oe = { evoLines: 0, bottle: 0, first: {} as Record<string, number>, carnD: 0, poisonD: 0, creSum: 0, msSum: 0, cre0: 0 };
if (OE) {
  const log0 = W.log;
  W.log = function (this: any, text: string, kind: string, ...rest: unknown[]) {
    if (kind === 'evo') oe.evoLines++;
    if (/бутылочн/i.test(text)) oe.bottle++;
    for (const m of ['🧪', '🌱', '🌟', '💨', '🌳', '🪞']) if (text.startsWith(m) && oe.first[m] === undefined) oe.first[m] = this.tick;
    return log0.call(this, text, kind, ...rest);
  };
  const die0 = W.die;
  W.die = function (this: any, c: any, cause: string, ...rest: unknown[]) {
    if (c.alive && guildOf(c.g) === 2) { oe.carnD++; if (cause === 'отравился') oe.poisonD++; }
    return die0.call(this, c, cause, ...rest);
  };
}// время soilPass отдельно (если он есть)
let soilMs = 0;
const sp0 = W.soilPass;
if (typeof sp0 === 'function') W.soilPass = function (this: any) { const t = performance.now(); sp0.call(this); soilMs += performance.now() - t; };
// плодородие, взвешенное по росту, — суммируем за весь интервал (снимок в один момент сезонно смещён)
let gN = 0, gW = 0, gNw = 0, gWw = 0, clSum = 0, clN = 0;
const nr0 = W.updateNutRef;
if (typeof nr0 === 'function') W.updateNutRef = function (this: any) { const a = this.nutAcc; gN += a.nl; gW += a.wl; gNw += a.nw; gWw += a.ww; nr0.call(this); };
// баланс питания почвы: навоз (dungIn) против усвоения растениями (uptake) — суммы за весь прогон
let dungS = 0, uptS = 0, carrS = 0;
const rec0 = W.record;
if (typeof rec0 === 'function') W.record = function (this: any) { if (this.flux) { dungS += this.flux.dungIn; uptS += this.flux.uptake; carrS += this.flux.carrionIn; } rec0.call(this); };
const [clo, chi] = ((WM as any).NUT_CLAMP?.land ?? [0.6, 1.3]) as number[];
// доля суши у границ множителя; и доля, у которой «сырой» множитель вышел бы за исходные 0.6/1.3 (§11.3 G4)
let rawSum = 0;
const clampShare = () => { let c = 0, r = 0, n = 0; const nu = W.nut as Float32Array, S = W.soil as Float32Array, ref = W.nutRef.land; for (let i = 0; i < nu.length; i++) { if (BIOMES[t1b[i]].water) continue; n++; if (nu[i] <= clo + 1e-4 || nu[i] >= chi - 1e-4) c++; const raw = 1.5 * S[i] / (S[i] + 0.5) / ref; if (raw <= 0.6 || raw >= 1.3) r++; } rawSum += r / Math.max(1, n); return c / Math.max(1, n); };
// гильдии — ровно как в migrantsFromAfar
const GUILDS = ['herb', 'omni', 'carn', 'swim'] as const;
const guild = (c: any) => GUILDS[guildOf(c.g)];
const extinct: Record<string, number> = {};
const zero: Record<string, number> = { herb: 0, omni: 0, carn: 0, swim: 0 };
const lastZero: Record<string, number> = {};
// средняя «жизнь» туши: ловим исчезнувшие из списка
let prevC = new Set<any>(); let cLife = 0, cN = 0;
let t0 = performance.now(); let soil0 = 0; const lines: string[] = [];
// резкие падения: вид (≥50 особей) потерял больше половины за 1000 тактов; отдельно — те, где шла вспышка болезни
const hist = new Map<number, Map<number, number>>(); let drops = 0, dropsDis = 0; const dropList: string[] = [];
const pathOn = (sp: number, a: number, b: number) => (W.pathogens?.has(sp) && W.pathogens.get(sp).born <= b) || (W.outbreaks ?? []).some((P: any) => P.host === sp && P.born <= b && (P.ended ?? 1e9) >= a);
// инструмент «эпидемия»
const toolAt = flags.tool && flags.tool !== '0' ? Number(flags.toolAt ?? 10000) : -1;
let tool: any = null; let toolRep = '';
const pDeaths = (sp: number) => { let d = W.pathogens?.get(sp)?.deaths ?? 0; for (const P of W.outbreaks ?? []) if (P.host === sp) d += P.deaths; return d; };
const pdHist = new Map<string, number>();
const f2 = (v: number | undefined, d = 2) => v === undefined || Number.isNaN(v) ? '-' : v.toFixed(d);
const t1 = W.terrain;
const t1b = t1.biome as Uint8Array;
const tLand = () => { let n = 0; for (let i = 0; i < t1.biome.length; i++) if (!BIOMES[t1.biome[i]].water) n++; return n; };
const landN = tLand();
// бюджет тесноты: ожидаемые смерти Σ n·crowding (по тактам) — с ним сверяем смерти «болезнь»
let budget = 0;
for (let t = 1; t <= T; t++) {
  w.step();
  if (OE) oe.creSum += w.creatures.length;
  for (const sp of w.species.all.values()) if (sp.extinct === null && sp.count > 400) budget += sp.count * w.crowding(sp.id);
  if (t % 10 === 0) {
    const cur = new Set<any>(w.corpses);
    for (const k of prevC) if (!cur.has(k)) { cLife += k.age; cN++; }
    prevC = cur;
  }
  if (t === toolAt) {
    const top = w.species.living()[0];
    const before = new Set(W.pathogens ? W.pathogens.values() : []);
    w.epidemic();
    const P = W.pathogens?.get(top.id);
    tool = { sp: top, n0: top.count, P: P && !before.has(P) ? P : null, inf0: P?.cases ?? 0, minN: top.count, dis0: [...w.deaths].filter(([k]) => k === `${top.name}:болезнь`).reduce((a, [, v]) => a + v, 0) };
  }
  if (tool && t > toolAt && t <= toolAt + 3000) {
    if (t % 20 === 0) tool.minN = Math.min(tool.minN, tool.sp.count);
    if (t === toolAt + 3000) {
      const P = tool.P; const dis = [...w.deaths].filter(([k]) => k === `${tool.sp.name}:болезнь`).reduce((a, [, v]) => a + v, 0) - tool.dis0;
      const vEnd = P ? (P.ended === null ? P.virMean : P.virCurve[P.virCurve.length - 1]) : NaN;
      toolRep = `\n tool@${toolAt}: «${tool.sp.name}» n0=${tool.n0} infected0=${tool.inf0} pathDeaths=${P?.deaths} kill%=${P ? (100 * P.deaths / tool.n0).toFixed(1) : '-'} disDeathsSp=${dis} (${(100 * dis / tool.n0).toFixed(1)}%) cases=${P?.cases} recovered=${P?.recovered} peak=${P?.peak} ended=${P?.ended ?? 'active'} vir0=${P?.vir0} vir+3000=${f2(vEnd)} virCurve=${P ? [0, 0.1, 0.25, 0.5, 0.75, 1].map((q) => f2(P.virCurve[Math.min(P.virCurve.length - 1, Math.floor(q * (P.virCurve.length - 1)))])).join('/') : '-'} n+3000=${tool.sp.count} min=${tool.minN} alive+3000=${tool.sp.extinct === null}`;
    }
  }
  if (t % 500 === 0) {
    for (const sp of w.species.all.values()) if (sp.extinct === null) pdHist.set(`${sp.id}:${t}`, pDeaths(sp.id));
    for (const sp of w.species.all.values()) {
      let h = hist.get(sp.id); if (!h) hist.set(sp.id, (h = new Map()));
      h.set(t, sp.extinct === null ? sp.count : 0);
      const old = h.get(t - 1000); h.delete(t - 1500);
      if (old !== undefined && old >= 50 && h.get(t)! < old * 0.5 && !(toolAt > 0 && t - 1000 <= toolAt + 3000 && t >= toolAt && sp.id === tool?.sp.id)) {
        // «из-за болезни» — шла вспышка и смерти от неё дали ≥ половины потерь
        drops++; const pd = pathOn(sp.id, t - 1000, t); const dd = pd ? pDeaths(sp.id) - (pdHist.get(`${sp.id}:${t - 1000}`) ?? 0) : 0;
        if (pd && dd >= 0.5 * (old - h.get(t)!)) dropsDis++;
        if (dropList.length < 12 || pd) dropList.push(`${t}:${sp.name}${old}→${h.get(t)}${pd ? `🦠${dd}` : ''}`);
      }
    }
    const g: Record<string, number> = { herb: 0, omni: 0, carn: 0, swim: 0 };
    for (const c of w.creatures) g[guild(c)]++;
    for (const k in g) if (g[k] === 0) { if (extinct[k] === undefined) extinct[k] = t; zero[k]++; lastZero[k] = t; }
    if (W.nut && W.soil) { clSum += clampShare(); clN++; }
  }
  if (t % EV === 0) {
    const g: Record<string, number> = { herb: 0, omni: 0, carn: 0, swim: 0 };
    let scav = 0;
    for (const c of w.creatures) { g[guild(c)]++; if (c.g.diet >= 0.5 && c.g.diet <= 0.7) scav++; }
    const herbs = w.creatures.filter(c => guild(c) === 'herb').map(c => c.g.size).sort((a, b) => a - b);
    const carn = w.creatures.filter(c => guild(c) === 'carn').map(c => c.g.size).sort((a, b) => a - b);
    const q = (a: number[], p: number) => a.length ? a[Math.floor(p * (a.length - 1))].toFixed(1) : '-';
    const ms = (performance.now() - t0) / EV;
    let extra = ` | corpseLife=${cN ? (cLife / cN).toFixed(0) : '-'} scav=${scav}`;
    // почва (если уже есть)
    if (W.nut && W.soil) {
      const nu = W.nut as Float32Array, S = W.soil as Float32Array, L = W.litter, M = W.mic, F = W.fix;
      let wn = 0, ws = 0, clampN = 0, sS = 0, sL = 0, sM = 0, sF = 0, nl = 0, pl = 0, nw = 0;
      for (let i = 0; i < nu.length; i++) {
        const b = BIOMES[t1.biome[i]];
        if (b.water) { pl += (w.grass[i] / b.fert) * nu[i]; nw++; continue; }
        nl++; sS += S[i]; sL += L?.[i] ?? 0; sM += M?.[i] ?? 0; sF += F?.[i] ?? 0;
        if (nu[i] <= clo + 1e-4 || nu[i] >= chi - 1e-4) clampN++;
        if (w.grass[i] < b.fert) { wn += b.fert * nu[i]; ws += b.fert; }
      }
      let my = 0, nm = 0;
      if (W.myc) for (let i = 0; i < nu.length; i++) if (t1.biome[i] === 5 || t1.biome[i] === 6) { my += W.myc[i]; nm++; }
      extra += ` | nutRef=${f2(W.nutRef?.land)}/${f2(W.nutRef?.water)} nutG=${f2(gW ? gN / gW : undefined, 3)}/${f2(gWw ? gNw / gWw : undefined, 3)} clAvg%=${f2(clN ? 100 * clSum / clN : undefined, 1)} raw%=${f2(clN ? 100 * rawSum / clN : undefined, 1)} nutW=${f2(ws ? wn / ws : undefined, 3)} clamp%=${f2(100 * clampN / Math.max(1, nl), 1)} S=${f2(sS / nl)} L=${f2(sL / nl)} mic=${f2(sM / nl)} fix=${f2(sF / nl)} myc=${f2(nm ? my / nm : undefined)} plank=${f2(pl / Math.max(1, nw))}`;
      if (W.micro?.corpsesRecycled !== undefined) extra += ` recyc=${W.micro.corpsesRecycled} bones=${W.boneMarks?.length ?? '-'}`;
      if (uptS > 0) extra += ` dung/upt=${f2(dungS / uptS, 3)} carr/upt=${f2(carrS / uptS, 3)}`;
    }
    // болезни (если уже есть)
    let disD = 0;
    for (const [k, v] of w.deaths) if (k.endsWith(':болезнь')) disD += v;
    extra += ` | disDeaths=${disD} budget=${budget.toFixed(0)}`;
    if (W.micro?.sick !== undefined) {
      const act = W.pathogens ? [...W.pathogens.values()] : [];
      let pd = 0; for (const P of [...act, ...(W.outbreaks ?? [])]) pd += P.deaths;
      extra += ` sick=${W.micro.sick} outbreaks=${W.micro.outbreaksTotal ?? '-'} spills=${(W.nextPath ?? 1) - 1} pathD=${pd} active=${act.length} vir=${act.length ? f2(act.reduce((s: number, p: any) => s + p.virMean, 0) / act.length) : '-'}`;
    }
    const msK = OE ? ` msK=${((performance.now() - t0) / Math.max(1, (oe.creSum - oe.cre0) / 1000)).toFixed(3)}` : '';
    if (OE) { oe.msSum += performance.now() - t0; oe.cre0 = oe.creSum; }
    lines.push(`t=${t} n=${w.creatures.length} H${g.herb} O${g.omni} C${g.carn} S${g.swim} | herbSize p10/50/90=${q(herbs, .1)}/${q(herbs, .5)}/${q(herbs, .9)} carnSize=${q(carn, .1)}/${q(carn, .5)}/${q(carn, .9)} | sp=${w.species.living().length}/${w.species.all.size} ms=${ms.toFixed(2)}${sp0 ? ` soilMs=${((soilMs - soil0) / EV).toFixed(3)}` : ''}${msK}${extra}`);
    t0 = performance.now(); soil0 = soilMs; gN = gW = gNw = gWw = clSum = clN = rawSum = 0;
  }
}
// ♾️ итог открытой эволюции (только при --oe=1)
let oeRep = '';
if (OE) {
  const S = W.evoStats ?? {}, B = W.bestiary;
  const K = MM.KIND_NAMES.length, NG = 4;
  // modfreq: % особей (не слотов), у которых накопленный уровень вида ≥ 0.3; в целом и по гильдиям (LIMB — пары ног / 2)
  const cnt = Array.from({ length: NG + 1 }, () => new Float64Array(K)), gN = new Float64Array(NG + 1);
  for (const c of w.creatures) {
    const gi = guildOf(c.g), ph = c.g.ph as Float32Array;
    gN[gi]++; gN[NG]++;
    for (let k = 1; k < K; k++) {
      const v = k === MM.M.LIMB ? ph[MM.P.LEGS] / 2 : ph[k - 1];
      if (v >= 0.3) { cnt[gi][k]++; cnt[NG][k]++; }
    }
  }
  // O7: средние по виду EYE и ENDO (видов ≥ 5 особей) — минимум по видам в каждой гильдии; летуны и планеры среди сухопутных
  const spAcc = new Map<number, { n: number; eye: number; endo: number; g: number }>();
  let land = 0, fly = 0, glide = 0, torp = 0, hid = 0;
  for (const c of w.creatures) {
    const ph = c.g.ph as Float32Array;
    const e = spAcc.get(c.sp) ?? { n: 0, eye: 0, endo: 0, g: guildOf(c.g) };
    e.n++; e.eye += ph[MM.P.EYE]; e.endo += ph[MM.P.ENDO]; spAcc.set(c.sp, e);
    if (c.g.swim <= 0.6) { land++; if (ph[MM.P.FLY] >= 1) fly++; else if (ph[MM.P.FLY] >= 0.45) glide++; }
    if ((c as any).torpor > 0) torp++;
    if (w.hidden(c)) hid++;
  }
  // по гильдии: среднее по особям (= средних по видам, взвешенных численностью) и худший вид
  const kitMin = [1, 1, 1, 1].map((_, gi) => {
    let eye = 9, endo = 9, se = 0, sn = 0, N = 0;
    for (const e of spAcc.values()) {
      if (e.g !== gi) continue;
      se += e.eye; sn += e.endo; N += e.n;
      if (e.n >= 5) { eye = Math.min(eye, e.eye / e.n); endo = Math.min(endo, e.endo / e.n); }
    }
    return N ? `${(se / N).toFixed(2)}/${(sn / N).toFixed(2)}(min ${eye === 9 ? '-' : eye.toFixed(2)}/${endo === 9 ? '-' : endo.toFixed(2)})` : '-';
  });
  const pc = (a: number, n: number) => (n ? (100 * a) / n : 0).toFixed(0);
  const mf = (gi: number) => MM.KIND_NAMES.slice(1).map((nm, j) => `${nm}${pc(cnt[gi][j + 1], gN[gi])}`).join(' ');
  const ft = (m: string) => oe.first[m] ?? '-';
  const f = (v: unknown) => (v === undefined ? '-' : String(v));
  oeRep =
    `\n OE: found=${f(B ? [...B.found.values()].filter((d: any) => !d.inherited).length : undefined)} inherited=${f(B ? [...B.found.values()].filter((d: any) => d.inherited).map((d: any) => d.id).join(',') || 0 : undefined)} origins=${f(B?.independent)} parallel=${f(B?.parallel)} plans=${f(B?.plans?.size)} conv=${f(B?.conv?.length)}(logged ${f(B?.conv?.filter((c: any) => c.logged).length)}) apo=${f(B?.apoSp?.length)} mim=${f(B?.mimPairs?.length)}` +
    ` 🧪=${f(B?.beats?.['🧪'])} 🌱=${f(B?.beats?.['🌱'])} 💨=${f(B?.beats?.['💨'])} births=${S.births} dup=${S.dup} neo=${S.neo} new=${S.nu} nextOrigin=${W.nextOrigin} metRef=${f2(W.metRef, 4)} upRef=${f2(W.upRef, 4)}` +
    `\n OE disc: ${B ? [...B.found.values()].filter((d: any) => !d.inherited).map((d: any) => `${d.id}@${d.tick}${d.times > 1 ? '×' + d.times : ''}${d.parallel ? '∥' + d.parallel : ''}${d.lost !== null ? '⚰' : ''}`).join(' ') || '-' : '-'}` +
    ` | prog ${B ? [...B.prog].filter(([, p]: [string, number]) => p >= 0.3).map(([id, p]: [string, number]) => `${id}:${p.toFixed(2)}`).join(' ') || '-' : '-'}` +
    `\n OE convdiag: tried=${B?.convDiag?.tried} young=${B?.convDiag?.young} bestDmax=${B?.convDiag?.best?.toFixed(2)} ${B ? B.conv.map((c: any) => `${c.a}~${c.b}@${c.tick}:${c.fact}${c.logged ? '' : '(silent)'}`).join(' ') || '-' : '-'} | plans ${B ? [...B.plans.values()].map((p: any) => `${p.ru}@${p.tick}`).join('; ') || '-' : '-'}` +
    `\n OE first: 🧪@${ft('🧪')} 🌱@${ft('🌱')} 🌟@${ft('🌟')} 💨@${ft('💨')} 🌳@${ft('🌳')} 🪞@${ft('🪞')} evoLines=${oe.evoLines} bottleneckLogs=${oe.bottle}` +
    `\n OE death: poisoned=${S.poisoned} poisonDeaths=${S.poisonDeaths} zaps=${S.zaps} carnDeaths=${oe.carnD} carnPoisoned=${oe.poisonD}` +
    `\n OE perf: msK=${(oe.msSum / Math.max(1, oe.creSum / 1000)).toFixed(3)} (мс на 1000 особей·такт) heapMB=${(process.memoryUsage().heapUsed / 1048576).toFixed(1)}` +
    `\n OE body: EYE/ENDO herb=${kitMin[0]} omni=${kitMin[1]} carn=${kitMin[2]} swim=${kitMin[3]} fliers=${pc(fly, land)}% gliders=${pc(glide, land)}% of land(n=${land}) torpid=${torp}` +
    `\n OE senses: hidden=${hid} avoided=${(B?.avoidTot ?? 0) + [...(W.avoided as Map<number, number>).values()].reduce((x, y) => x + y, 0)} chan=${[...W.chan].map((x: number) => x.toFixed(2)).join('/')} airSnd=${f2(W.airSnd, 2)} | ${w.passport()}` +
    (BM.CONV_DIAG.on ? `\n CONVROWS ${JSON.stringify(BM.CONV_DIAG.rows.map((r) => r.map((x) => +x.toFixed(3))))}` : '') +
    `\n modfreq all(n=${gN[NG]}): ${mf(NG)}` +
    ['herb', 'omni', 'carn', 'swim'].map((nm, gi) => `\n modfreq ${nm}(n=${gN[gi]}): ${mf(gi)}`).join('');
}
const rivers = t1.river ? (() => { let r2 = 0, r1 = 0; for (let i = 0; i < t1.river.length; i++) { if (t1.river[i] >= 2) r2++; else if (t1.river[i] === 1) r1++; } return ` rivers: ${t1.rivers?.length} named, river>=2 ${(100 * r2 / landN).toFixed(2)}% land, stream ${(100 * r1 / landN).toFixed(2)}%`; })() : '';
console.log(`seed ${seed} ${mode} ${JSON.stringify(flags)}\n` + lines.join('\n') +
  `\n drops50%/1000t: ${drops} (disease-driven ${dropsDis}) ${dropList.join(' ')}` +
  (W.outbreaks ? `\n outbreaks: ` + [...W.outbreaks, ...W.pathogens.values()].filter((P: any) => P.announced).slice(-10).map((P: any) => `${P.born}-${P.ended ?? '…'} «${P.name}»@${w.species.all.get(P.host)?.name} cases${P.cases} d${P.deaths} pk${P.peak} v${P.vir0.toFixed(2)}→${P.virMean.toFixed(2)}`).join(' | ') : '') + toolRep +
  (tool ? `\n toolSpecies at end: n=${tool.sp.count} extinct=${tool.sp.extinct}` : '') +
  `\n extinct(guild first hit 0): ${JSON.stringify(extinct)} zeroSamples(of ${T / 500}): ${JSON.stringify(zero)} lastZero: ${JSON.stringify(lastZero)}${rivers}\n top: ` +
  w.species.living().slice(0, 8).map(s => `${s.name}[${s.count}] sz${s.mean.size.toFixed(1)} d${s.mean.diet.toFixed(2)} sw${s.mean.swim.toFixed(1)}`).join(' | ') + oeRep);
