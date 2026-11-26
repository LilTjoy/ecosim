// Балансный стенд: node-прогон мира без браузера.
// npm run bench -- <seed> <ticks> [rules|neural] [--soil=0|1] [--disease=0|1] [--rescue=0|1] [--rng=k] [--UN=..] [--BETA=..]
// --tool=1 — инструмент «эпидемия» на такте 10000 (или --toolAt=N), отчёт через 3000 тактов
// --trap=1 — Math.random внутри симуляции бросает исключение (по умолчанию для --tm=*)
// --tm=det|fly|load|thin — проверки машины времени (снимки, точная перемотка, эффект бабочки, ветки и память),
//   см. scripts/tmBench.ts и scripts/tmTimeline.ts
// ♾️ открытая эволюция: --oe=0|1 (= --openEvo), любая ручка EVO из src/sim/modules.ts (--P_DUP=0 --BENTHIC=1 …,
//   логические — «!== '0'»), --benthic=0|1, --her=cold|dark|lowO2|bottle|young|murky (условия планеты).
//   Строки OE:/modfreq/… печатаются только при включённой открытой эволюции; без неё вывод прежний (ворота O0,
//   см. scripts/oe-o0.sh). --convdiag=1 — все пары с похожим обликом (CONVROWS), --crabdiag=1 — части рецепта краба.
// 🌋 живая планета: --geo=0|1 (settings.livePlanet; с --geo=0 ключа нет — мир до бита прежний, ворота G0, scripts/geo-g0.sh);
//   --seaStep=N — каждые N тактов море шагает на GEO.SEA_STEP (лесенка 0…−0.04 и обратно) с пересчётом рельефа (P1);
//   строка «GEO perf:» (пересчёты, мс p50/p99/max) — только при --geo=1.
//   Этап 1b–1c: строка «GEO 1b:» (половины видов, разделения по барьерам и такт первого, утечки генов, пришельцы,
//   рефугиумы и медиана y зверей суши на каждом пике, морены, котловины, озёра); --ymed=N — медиана y зверей суши
//   каждые N тактов (строка YMED, и без живой планеты — пара для G4); ручки GEO (--ISO_GEN=6 …) и --sill=0.
import * as WM from '../src/sim/world';
const { World, guildOf } = WM;
import { runTm } from './tmBench';
import { B as TB, BIOMES } from '../src/sim/terrain';
import * as MM from '../src/sim/modules';
import * as BM from '../src/sim/bestiary';
import * as HM from '../src/sim/heritage';
import * as GM from '../src/sim/geo';
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
  if (flags.geo !== undefined) {
    if (flags.geo !== '0') W.settings.livePlanet = true;
    else delete W.settings.livePlanet;
  }
};
// ручки открытой эволюции (и будущих таблиц: открытия, наследство) — по имени, в том же духе, что SOIL/DIS
const KNOBS: Record<string, unknown>[] = [MM.EVO, BM.BEST, BM.CONV, HM.PAL, HM.HER, GM.GEO] as unknown as Record<string, unknown>[];
for (const mod of KNOBS) for (const k in flags) if (k in mod) mod[k] = typeof mod[k] === 'boolean' ? flags[k] !== '0' : Number(flags[k]);
if (flags.convdiag) BM.CONV_DIAG.on = true;
// 🌋 --sill=0 — без порогов и пролива (контроль G5)
if (flags.sill !== undefined) (GM.GEO as any).SILL_ON = flags.sill !== '0' ? 1 : 0;
GM.GEO_PERF.on = flags.geo !== undefined && flags.geo !== '0';
if (flags.benthic !== undefined) MM.EVO.BENTHIC = flags.benthic !== '0';
// --kit=random — уровни нейтрального набора основателей случайно ×0.6…1.4 (ворота O9)
if (flags.kit !== undefined) HM.HER.kitRandom = flags.kit === 'random';
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
/** 🌋 Флаги климата живой планеты — действиями мира (как кнопки вкладки «Климат»), на такте 0. */
export function applyGeoFlags(w: InstanceType<typeof World>, f: Record<string, string>): void {
  const g = (w as any).geo;
  if (f.cool !== undefined) {
    w.apply({ t: w.tick, k: 'iceAge', mode: 'off' });
    w.apply({ t: w.tick, k: 'co2', ppm: 280 });
    g.fPin = Number(f.cool);
  }
  if (f.orbit === '0') w.apply({ t: w.tick, k: 'iceAge', mode: 'off' });
  if (f.co2 !== undefined) w.apply({ t: w.tick, k: 'co2', ppm: Number(f.co2) });
  if (f.geoSpeed !== undefined) w.apply({ t: w.tick, k: 'geoSpeed', v: f.geoSpeed === '4' ? 4 : 1 });
  if (f.seaPin !== undefined) w.apply({ t: w.tick, k: 'sea', dm: Number(f.seaPin) });
  if (f.iceAge !== undefined) w.apply({ t: w.tick, k: 'iceAge', mode: f.iceAge as any });
}
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
// 🌋 климат живой планеты: --cool=X (без орбиты, CO₂ 280, постоянный сдвиг X), --co2=ppm, --orbit=0, --geoSpeed=4, --seaPin=м
if (W.lp) applyGeoFlags(w, flags);
// ♾️ только при открытой эволюции: счётчики строк журнала, первые такты событий, смерти хищников
const OE = !!W.oe;
const chron0 = OE ? w.events.filter((e) => e.kind === 'evo').map((e) => e.fact).join(',') || '-' : '';
const oe = { evoLines: 0, bottle: 0, first: {} as Record<string, number>, carnD: 0, poisonD: 0, creSum: 0, msSum: 0, cre0: 0, peak: new Float64Array(MM.KIND_NAMES.length), peakT: new Float64Array(MM.KIND_NAMES.length) };
/** Носители вида модуля (накопленный уровень ≥ 0.3; ноги — пары / 2) по всем особям. */
const carriers = (out: Float64Array) => {
  out.fill(0);
  for (const c of w.creatures) {
    const ph = c.g.ph as Float32Array;
    for (let k = 1; k < out.length; k++) if ((k === MM.M.LIMB ? ph[MM.P.LEGS] / 2 : ph[k - 1]) >= 0.3) out[k]++;
  }
  return out;
};
const carrBuf = new Float64Array(MM.KIND_NAMES.length);
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
// O10: трава мелководья — печатается при --oe=1 или --shg=1 (без них вывод прежний)
const shg = { on: OE || !!flags.shg, sum: 0, k: 0, ben: 0, benSh: 0 };
const crab = OE && flags.crabdiag ? { peak: new Array(11).fill(0), last: [] as number[], full: 0, k: 0 } : null;
// 🌋 P1: лесенка моря с пересчётом рельефа (как будет делать геопроход), время каждого пересчёта
const seaStep = Number(flags.seaStep ?? 0);
const geoMs = GM.GEO_PERF.ms;
// 🌋 стражи стадии 1a: размах сдвига, моря и льда; пороги (сох ли мелкий, глубок ли Уоллес); переходы пеших через порог
const gt = { sMin: 9, sMax: -9, seaMin: 9, seaMax: -9, iceMax: 0, vMin: 9, vMax: -9, sillOpenT: 0, sillOpens: 0, wasOpen: false, wallaceDeep: true, wallaceSplit: true, side: new Map<number, number>(), cross: 0, crossers: new Set<number>(), sillY: [0, 0], lgm: [] as number[] };
// 🌋 1b: на каждом пике — рефугиумы и медиана y зверей суши; первые разделения по барьерам; --ymed=N — медиана y каждые N тактов (и без живой планеты, для пары G4)
const g1b = { atMax: [] as string[], first: { sill: -1, wallace: -1, player: -1 } as Record<string, number>, ymed: [] as string[] };
const ymedOf = () => { const ys: number[] = []; for (const c of w.creatures) if (c.alive && c.g.swim <= 0.6) ys.push(c.y); ys.sort((a, b) => a - b); return ys.length ? Math.round(ys[ys.length >> 1]) : -1; };
if (W.lp) { const lg0 = W.log; W.log = function (this: any, text: string, kind: string, x?: number, y?: number, fact?: string) { const r = lg0.call(this, text, kind, x, y, fact); if (fact === 'geo_lgm') gt.lgm.push(this.tick); if (fact === 'geo_refugia') g1b.atMax.push(`${this.tick}:ref${this.geo.refugia?.length ?? 0}:y${ymedOf()}`); return r; }; }
if (W.lp) { const s0 = W.geo.sills.find((s: any) => s.kind === 'sill'); if (s0) gt.sillY = [s0.y0 * W.cell, s0.y1 * W.cell]; }
const geoTrack = (t: number) => {
  const g = W.geo, sh = g.geoShift + w.climate.shift;
  gt.sMin = Math.min(gt.sMin, sh); gt.sMax = Math.max(gt.sMax, sh);
  gt.seaMin = Math.min(gt.seaMin, g.seaQ); gt.seaMax = Math.max(gt.seaMax, g.seaQ);
  gt.vMin = Math.min(gt.vMin, g.Vg); gt.vMax = Math.max(gt.vMax, g.Vg);
  gt.iceMax = Math.max(gt.iceMax, g.iceLand);
  for (const s of g.sills) {
    if (s.kind === 'sill') { if (s.open) gt.sillOpenT += 60; if (s.open && !gt.wasOpen) gt.sillOpens++; gt.wasOpen = s.open; }
    if (s.kind === 'wallace') { if (s.open) gt.wallaceSplit = false; for (const i of s.cells) if (t1b[i] !== TB.Deep) { gt.wallaceDeep = false; break; } }
  }
  // пешие (swim ≤ 0.15, не летуны): кого видели по обе стороны порога
  if (t % 200 === 0 && gt.sillY[1] > 0) for (const c of w.creatures) {
    if (!c.alive || c.g.swim > 0.15 || (OE && (c.g.ph as Float32Array)[MM.P.FLY] >= 1)) continue;
    const sd = c.y < gt.sillY[0] ? 0 : c.y >= gt.sillY[1] ? 1 : -1;
    if (sd < 0) continue;
    const was = gt.side.get(c.id);
    if (was === undefined) gt.side.set(c.id, sd);
    else if (was !== sd && !gt.crossers.has(c.id)) { gt.crossers.add(c.id); gt.cross++; }
  }
};
for (let t = 1; t <= T; t++) {
  if (seaStep > 0 && W.lp && t % seaStep === 0) {
    const k = (t / seaStep) % 20, q = k <= 10 ? k : 20 - k;
    W.geo.seaQ = -GM.GEO.SEA_STEP * q;
    GM.deriveTerrain(w, true);
  }
  w.step();
  if (W.lp && t % 60 === 0) geoTrack(t);
  if (flags.ymed && t % Number(flags.ymed) === 0) g1b.ymed.push(`${t}:${ymedOf()}`);
  if (W.lp && t % 200 === 0) { const S = W.geo.stats; if (S.sSill && g1b.first.sill < 0) g1b.first.sill = t; if (S.sWall && g1b.first.wallace < 0) g1b.first.wallace = t; if (S.sPlay && g1b.first.player < 0) g1b.first.player = t; }
  if (OE) {
    oe.creSum += w.creatures.length;
    // O11: наибольшее число носителей каждого модуля за прогон (раз в 500 тактов)
    if (t % 500 === 0) { carriers(carrBuf); for (let k = 1; k < carrBuf.length; k++) if (carrBuf[k] > oe.peak[k]) { oe.peak[k] = carrBuf[k]; oe.peakT[k] = t; } }
    // --crabdiag=1: части рецепта краба по особям (панцирь ≥ .5, клешни ≥ .3, ≥ 3 ног, плоское ≤ .3), полные тела, донные
    if (crab && t % 500 === 0) {
      const v = new Array(11).fill(0);
      for (const c of w.creatures) {
        const ph = c.g.ph as Float32Array, b = c.g.body;
        const s = ph[MM.P.SHELL] >= 0.5 ? 1 : 0, k = ph[MM.P.CLAW] >= 0.3 ? 1 : 0, l = ph[MM.P.LEGS] >= 3 ? 1 : 0, f = b.shape <= 0.3 ? 1 : 0;
        v[0] += s; v[1] += k; v[2] += l; v[3] += f; v[4] += s + k + l + f >= 3 ? 1 : 0; v[5] += s && k && l && f ? 1 : 0;
        let occ = 0; for (let i = 0; i < MM.NSLOT; i++) if (b.km[i] !== 0) occ++;
        v[6] += occ === MM.NSLOT ? 1 : 0; v[7] += ph[MM.P.BENTH] > 0 ? 1 : 0; v[8] += s && l ? 1 : 0; v[9] += s && l && k ? 1 : 0; v[10] += s && l && f ? 1 : 0;
      }
      for (let i = 0; i < 11; i++) crab.peak[i] = Math.max(crab.peak[i], v[i]);
      crab.full += v[6] / Math.max(1, w.creatures.length); crab.k++;
      crab.last = v;
    }
  }
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
    // O10: трава мелководья (доля от плодородия) с 6000 такта; донные с панцирем (BENTH > 0.25, не просто многоногие бродяги) — сколько их и сколько на мелководье
    if (shg.on && t >= 6000) {
      let a = 0, n = 0;
      for (let i = 0; i < t1b.length; i++) if (t1b[i] === TB.Shallow) { a += w.grass[i] / BIOMES[t1b[i]].fert; n++; }
      shg.sum += a / Math.max(1, n); shg.k++;
      if (OE) for (const c of w.creatures) if ((c.g.ph as Float32Array)[MM.P.BENTH] > 0.25) { shg.ben++; if (t1b[c.cell ?? 0] === TB.Shallow) shg.benSh++; }
    }
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
    if (W.lp) { const g = W.geo; extra += ` | Vg=${g.Vg.toFixed(3)} sea=${GM.metres(g.seaQ)} ice%=${(100 * g.iceLand).toFixed(1)} co2=${g.co2.toFixed(0)} dT=${((g.geoShift + w.climate.shift) * 100 / 3).toFixed(1)} sill=${g.sills.find((x: any) => x.kind === 'sill')?.open ? 1 : 0} lands=${g.lands.n}`; }
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
  const cnt = Array.from({ length: NG + 1 }, () => new Float64Array(K)), cntN = Array.from({ length: NG + 1 }, () => new Float64Array(K)), gN = new Float64Array(NG + 1);
  for (const c of w.creatures) {
    const gi = guildOf(c.g), ph = c.g.ph as Float32Array;
    gN[gi]++; gN[NG]++;
    for (let k = 1; k < K; k++) {
      const v = k === MM.M.LIMB ? ph[MM.P.LEGS] / 2 : ph[k - 1];
      if (v >= 0.3) { cnt[gi][k]++; cnt[NG][k]++; }
    }
    // O6 «не из набора»: сильнейшая копия вида ≥ 0.3 и происхождение не наследственное (мех набора у холодолюбивых — набор)
    const b = c.g.body, bl = new Float32Array(K), bo = new Int32Array(K);
    for (let i = 0; i < MM.NSLOT; i++) if (b.km[i] !== 0) { const k = b.km[i] & 31; if (b.lvl[i] > bl[k]) { bl[k] = b.lvl[i]; bo[k] = b.km[i] >>> 5; } }
    for (let k = 1; k < K; k++) if (k !== MM.M.LIMB && ph[k - 1] >= 0.3 && bo[k] !== k) { cntN[gi][k]++; cntN[NG][k]++; }
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
    `\n OE her: palette=${(W.palette as number[]).map((k) => MM.KIND_NAMES[k]).join(',')} founders=${W.founderPlan.length} n0=${f2(W.founderPlan.reduce((a: number, x: any) => a + x.n, 0), 0)} maxSize=${f2(Math.max(...W.founderPlan.map((x: any) => x.g.size ?? 4)), 2)} palFounders=${W.founderPlan.filter((x: any) => Array.from(x.g.body.km as Int32Array).some((km) => km >>> 5 > MM.ORIGIN.PALETTE && km >>> 5 < 100)).length} blind=${W.founderPlan.filter((x: any) => !Array.from(x.g.body.km as Int32Array).some((km) => (km & 31) === MM.M.EYE)).length} chron=${chron0}` +
    `\n OE benthic: on=${MM.EVO.BENTHIC ? 1 : 0} shallowGrass=${f2(shg.k ? shg.sum / shg.k : undefined, 3)} benthicAvg=${f2(shg.k ? shg.ben / shg.k : undefined, 1)} inShallowAvg=${f2(shg.k ? shg.benSh / shg.k : undefined, 1)} crab=${B?.found?.has('carcinization') ? B.found.get('carcinization').tick : '-'}` +
    (crab ? `\n OE crabdiag: shell/claw/legs3/flat/any3/crab/fullBody/benth/shell+legs/+claw/+flat peak=${crab.peak.join('/')} final=${crab.last.join('/')} fullShare=${(100 * crab.full / Math.max(1, crab.k)).toFixed(0)}%` : '') +
    `\n OE peak: ${MM.KIND_NAMES.slice(1).map((nm, j) => `${nm}${oe.peak[j + 1]}`).join(' ')}` +
    (BM.CONV_DIAG.on ? `\n CONVROWS ${JSON.stringify(BM.CONV_DIAG.rows.map((r) => r.map((x) => +x.toFixed(3))))}` : '') +
    `\n modfreq all(n=${gN[NG]}): ${mf(NG)}` +
    ['herb', 'omni', 'carn', 'swim'].map((nm, gi) => `\n modfreq ${nm}(n=${gN[gi]}): ${mf(gi)}`).join('') +
    `\n modfreqNew (не наследство): ${['all', 'herb', 'omni', 'carn', 'swim'].map((nm, j) => { const gi = j ? j - 1 : NG; let bk = 0, bv = 0; for (let k = 1; k < K; k++) if (k !== MM.M.LIMB && cntN[gi][k] > bv) { bv = cntN[gi][k]; bk = k; } return `${nm} max ${MM.KIND_NAMES[bk]}${Math.round(100 * bv / Math.max(1, gN[gi]))}`; }).join(' ')}`;
}
const rivers = t1.river ? (() => { let r2 = 0, r1 = 0; for (let i = 0; i < t1.river.length; i++) { if (t1.river[i] >= 2) r2++; else if (t1.river[i] === 1) r1++; } return ` rivers: ${t1.rivers?.length} named, river>=2 ${(100 * r2 / landN).toFixed(2)}% land, stream ${(100 * r1 / landN).toFixed(2)}%`; })() : '';
console.log(`seed ${seed} ${mode} ${JSON.stringify(flags)}\n` + lines.join('\n') +
  `\n drops50%/1000t: ${drops} (disease-driven ${dropsDis}) ${dropList.join(' ')}` +
  (W.outbreaks ? `\n outbreaks: ` + [...W.outbreaks, ...W.pathogens.values()].filter((P: any) => P.announced).slice(-10).map((P: any) => `${P.born}-${P.ended ?? '…'} «${P.name}»@${w.species.all.get(P.host)?.name} cases${P.cases} d${P.deaths} pk${P.peak} v${P.vir0.toFixed(2)}→${P.virMean.toFixed(2)}`).join(' | ') : '') + toolRep +
  (tool ? `\n toolSpecies at end: n=${tool.sp.count} extinct=${tool.sp.extinct}` : '') +
  `\n extinct(guild first hit 0): ${JSON.stringify(extinct)} zeroSamples(of ${T / 500}): ${JSON.stringify(zero)} lastZero: ${JSON.stringify(lastZero)}${rivers}\n top: ` +
  w.species.living().slice(0, 8).map(s => `${s.name}[${s.count}] sz${s.mean.size.toFixed(1)} d${s.mean.diet.toFixed(2)} sw${s.mean.swim.toFixed(1)}`).join(' | ') + oeRep +
  (g1b.ymed.length ? `\n YMED ${g1b.ymed.join(' ')}` : '') +
  (!OE && shg.on ? `\n shallowGrass=${f2(shg.k ? shg.sum / shg.k : undefined, 3)}` : '') +
  (W.lp ? (() => {
    const a = [...geoMs].sort((x, y) => x - y), q = (p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2) : '-');
    let land = 0; for (let i = 0; i < t1.biome.length; i++) if (!BIOMES[t1.biome[i]].water) land++;
    if (flags.geoMs) console.log(geoMs.map((x) => x.toFixed(1)).join(" "));
    const C = 100 / 3;
    const geoLine = `\n GEO: glacials=${W.geo.stats.glacials} bridges=${W.geo.stats.bridges} sillOpens=${gt.sillOpens} sillOpenYears=${(gt.sillOpenT / 6000).toFixed(2)} wallaceDeep=${gt.wallaceDeep ? 1 : 0} wallaceSplit=${gt.wallaceSplit ? 1 : 0} shift=${gt.sMin.toFixed(3)}..${gt.sMax.toFixed(3)} (${(gt.sMin * C).toFixed(1)}..${(gt.sMax * C).toFixed(1)} °C) Vg=${gt.vMin.toFixed(2)}..${gt.vMax.toFixed(2)} sea=${GM.metres(gt.seaMin)}..${GM.metres(gt.seaMax)} м iceMax%=${(100 * gt.iceMax).toFixed(1)} crossers=${gt.cross} tracked=${gt.side.size} kyr=${GM.geoKyr(W.geo).toFixed(0)} lgmAt=${gt.lgm.join(',') || '-'}`;
    const S = W.geo.stats, iso = W.geo.isolates as any[];
    const isoLine = `\n GEO 1b: iso=${iso.length} [${iso.map((r: any) => `${r.sill}:${r.sp}:ga${r.ga}:d${r.d.toFixed(2)}:L${r.leak}:${r.parts.join('/')}`).join(' ')}] splits=${S.splits} sill=${S.sSill}@${g1b.first.sill} wallace=${S.sWall}@${g1b.first.wallace} player=${S.sPlay} leaks=${S.leaks} invaders=${S.invaders} bridgesRec=${W.geo.bridges.length} refugiaTot=${S.refugia} atMax=${g1b.atMax.join(',') || '-'} moraines=${S.moraines} kettles=${S.kettles} lakes=${S.lakes}/${t1.lakes.length} seeds=${W.geo.lakeSeeds.length} minElevD=${Math.min(...(W.elevD as Int16Array))} sp=${w.species.living().length}`;
    return geoLine + isoLine + `\n GEO perf: derives=${W.geo.stats.derives} timed=${a.length} ms p50=${q(0.5)} p99=${q(0.99)} max=${a.length ? a[a.length - 1].toFixed(2) : '-'} rev=${t1.rev} seaQ=${W.geo.seaQ} land=${land}/${landN} lands=${W.geo.lands.n} pend=${W.geo.pend.length}`;
  })() : ''));
