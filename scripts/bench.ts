// Балансный стенд: node-прогон мира без браузера.
// npm run bench -- <seed> <ticks> [rules|neural] [--soil=0|1] [--disease=0|1] [--rescue=0|1] [--rng=k] [--UN=..]
import * as WM from '../src/sim/world';
const { World } = WM;
import { BIOMES } from '../src/sim/terrain';
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags: Record<string, string> = {};
for (const a of process.argv.slice(2)) if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? '1'; }
const seed = Number(pos[0] ?? 42);
const T = Number(pos[1] ?? 30000);
const mode = (pos[2] ?? 'rules') as any;
// --every=N — шаг строк отчёта (по умолчанию T/5)
const EV = Number(flags.every ?? T / 5);
// детерминированный Math.random (LCG) — прогоны воспроизводимы
// --rng=k сдвигает поток случайных чисел (та же карта, другие основатели) — для оценки шума
let rs = (seed * 7 + 1 + Number(flags.rng ?? 0)) >>> 0;
Math.random = () => (rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296;
const w = new World(3200, 2000);
const W = w as any;
// флаги пишем в settings, только если такое поле уже есть
for (const k in flags) if (k in w.settings) W.settings[k] = typeof W.settings[k] === 'boolean' ? flags[k] !== '0' : Number(flags[k]);
// ручки баланса почвы: --UN=0.15 --DUNG=0.5 --TAU=1500 --clampL=0.75,1.2 --clampW=0.7,1.25
const SO = (WM as any).SOIL, NC = (WM as any).NUT_CLAMP;
for (const k in flags) {
  if (SO && k in SO) SO[k] = Number(flags[k]);
  if (NC && k === 'clampL') NC.land = flags[k].split(',').map(Number);
  if (NC && k === 'clampW') NC.water = flags[k].split(',').map(Number);
  if (NC && k === 'clampC') NC.corpse = flags[k].split(',').map(Number);
}
w.reset(mode, seed);
// время soilPass отдельно (если он есть)
let soilMs = 0;
const sp0 = W.soilPass;
if (typeof sp0 === 'function') W.soilPass = function (this: any) { const t = performance.now(); sp0.call(this); soilMs += performance.now() - t; };
// плодородие, взвешенное по росту, — суммируем за весь интервал (снимок в один момент сезонно смещён)
let gN = 0, gW = 0, gNw = 0, gWw = 0, clSum = 0, clN = 0;
const nr0 = W.updateNutRef;
if (typeof nr0 === 'function') W.updateNutRef = function (this: any) { const a = this.nutAcc; gN += a.nl; gW += a.wl; gNw += a.nw; gWw += a.ww; nr0.call(this); };
const [clo, chi] = ((WM as any).NUT_CLAMP?.land ?? [0.6, 1.3]) as number[];
// доля суши у границ множителя; и доля, у которой «сырой» множитель вышел бы за исходные 0.6/1.3 (§11.3 G4)
let rawSum = 0;
const clampShare = () => { let c = 0, r = 0, n = 0; const nu = W.nut as Float32Array, S = W.soil as Float32Array, ref = W.nutRef.land; for (let i = 0; i < nu.length; i++) { if (BIOMES[t1b[i]].water) continue; n++; if (nu[i] <= clo + 1e-4 || nu[i] >= chi - 1e-4) c++; const raw = 1.5 * S[i] / (S[i] + 0.5) / ref; if (raw <= 0.6 || raw >= 1.3) r++; } rawSum += r / Math.max(1, n); return c / Math.max(1, n); };
// гильдии — ровно как в migrantsFromAfar
const guild = (c: any) => c.g.swim > 0.6 ? 'swim' : c.g.diet < 0.3 ? 'herb' : c.g.diet <= 0.65 ? 'omni' : 'carn';
const extinct: Record<string, number> = {};
const zero: Record<string, number> = { herb: 0, omni: 0, carn: 0, swim: 0 };
const lastZero: Record<string, number> = {};
// средняя «жизнь» туши: ловим исчезнувшие из списка
let prevC = new Set<any>(); let cLife = 0, cN = 0;
let t0 = performance.now(); let soil0 = 0; const lines: string[] = [];
const f2 = (v: number | undefined, d = 2) => v === undefined || Number.isNaN(v) ? '-' : v.toFixed(d);
const t1 = W.terrain;
const t1b = t1.biome as Uint8Array;
const tLand = () => { let n = 0; for (let i = 0; i < t1.biome.length; i++) if (!BIOMES[t1.biome[i]].water) n++; return n; };
const landN = tLand();
for (let t = 1; t <= T; t++) {
  w.step();
  if (t % 10 === 0) {
    const cur = new Set<any>(w.corpses);
    for (const k of prevC) if (!cur.has(k)) { cLife += k.age; cN++; }
    prevC = cur;
  }
  if (t % 500 === 0) {
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
    }
    // болезни (если уже есть)
    let disD = 0;
    for (const [k, v] of w.deaths) if (k.endsWith(':болезнь')) disD += v;
    extra += ` | disDeaths=${disD}`;
    if (W.micro?.sick !== undefined) {
      const act = W.pathogens ? [...W.pathogens.values()] : [];
      extra += ` sick=${W.micro.sick} outbreaks=${W.micro.outbreaksTotal ?? '-'} vir=${act.length ? f2(act.reduce((s: number, p: any) => s + p.virMean, 0) / act.length) : '-'}`;
    }
    lines.push(`t=${t} n=${w.creatures.length} H${g.herb} O${g.omni} C${g.carn} S${g.swim} | herbSize p10/50/90=${q(herbs, .1)}/${q(herbs, .5)}/${q(herbs, .9)} carnSize=${q(carn, .1)}/${q(carn, .5)}/${q(carn, .9)} | sp=${w.species.living().length}/${w.species.all.size} ms=${ms.toFixed(2)}${sp0 ? ` soilMs=${((soilMs - soil0) / EV).toFixed(3)}` : ''}${extra}`);
    t0 = performance.now(); soil0 = soilMs; gN = gW = gNw = gWw = clSum = clN = rawSum = 0;
  }
}
const rivers = t1.river ? (() => { let r2 = 0, r1 = 0; for (let i = 0; i < t1.river.length; i++) { if (t1.river[i] >= 2) r2++; else if (t1.river[i] === 1) r1++; } return ` rivers: ${t1.rivers?.length} named, river>=2 ${(100 * r2 / landN).toFixed(2)}% land, stream ${(100 * r1 / landN).toFixed(2)}%`; })() : '';
console.log(`seed ${seed} ${mode} ${JSON.stringify(flags)}\n` + lines.join('\n') +
  `\n extinct(guild first hit 0): ${JSON.stringify(extinct)} zeroSamples(of ${T / 500}): ${JSON.stringify(zero)} lastZero: ${JSON.stringify(lastZero)}${rivers}\n top: ` +
  w.species.living().slice(0, 8).map(s => `${s.name}[${s.count}] sz${s.mean.size.toFixed(1)} d${s.mean.diet.toFixed(2)} sw${s.mean.swim.toFixed(1)}`).join(' | '));
