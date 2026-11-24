// Балансный стенд: node-прогон мира без браузера.
// npm run bench -- <seed> <ticks> [rules|neural] [--soil=0|1] [--disease=0|1] [--rescue=0|1]
import { World } from '../src/sim/world';
import { BIOMES } from '../src/sim/terrain';
const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags: Record<string, string> = {};
for (const a of process.argv.slice(2)) if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? '1'; }
const seed = Number(pos[0] ?? 42);
const T = Number(pos[1] ?? 30000);
const mode = (pos[2] ?? 'rules') as any;
// детерминированный Math.random (LCG) — прогоны воспроизводимы
let rs = (seed * 7 + 1) >>> 0;
Math.random = () => (rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296;
const w = new World(3200, 2000);
const W = w as any;
// флаги пишем в settings, только если такое поле уже есть
for (const k in flags) if (k in w.settings) W.settings[k] = typeof W.settings[k] === 'boolean' ? flags[k] !== '0' : Number(flags[k]);
w.reset(mode, seed);
// время soilPass отдельно (если он есть)
let soilMs = 0;
const sp0 = W.soilPass;
if (typeof sp0 === 'function') W.soilPass = function (this: any) { const t = performance.now(); sp0.call(this); soilMs += performance.now() - t; };
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
  }
  if (t % (T / 5) === 0) {
    const g: Record<string, number> = { herb: 0, omni: 0, carn: 0, swim: 0 };
    let scav = 0;
    for (const c of w.creatures) { g[guild(c)]++; if (c.g.diet >= 0.5 && c.g.diet <= 0.7) scav++; }
    const herbs = w.creatures.filter(c => guild(c) === 'herb').map(c => c.g.size).sort((a, b) => a - b);
    const carn = w.creatures.filter(c => guild(c) === 'carn').map(c => c.g.size).sort((a, b) => a - b);
    const q = (a: number[], p: number) => a.length ? a[Math.floor(p * (a.length - 1))].toFixed(1) : '-';
    const ms = (performance.now() - t0) / (T / 5);
    let extra = ` | corpseLife=${cN ? (cLife / cN).toFixed(0) : '-'} scav=${scav}`;
    // почва (если уже есть)
    if (W.nut && W.soil) {
      const nu = W.nut as Float32Array, S = W.soil as Float32Array, L = W.litter, M = W.mic, F = W.fix;
      let wn = 0, ws = 0, clampN = 0, sS = 0, sL = 0, sM = 0, sF = 0, nl = 0, pl = 0, nw = 0;
      for (let i = 0; i < nu.length; i++) {
        const b = BIOMES[t1.biome[i]];
        if (b.water) { pl += (w.grass[i] / b.fert) * nu[i]; nw++; continue; }
        nl++; sS += S[i]; sL += L?.[i] ?? 0; sM += M?.[i] ?? 0; sF += F?.[i] ?? 0;
        if (nu[i] <= 0.6001 || nu[i] >= 1.2999) clampN++;
        if (w.grass[i] < b.fert) { wn += b.fert * nu[i]; ws += b.fert; }
      }
      extra += ` | nutRef=${f2(W.nutRef?.land)}/${f2(W.nutRef?.water)} nutW=${f2(ws ? wn / ws : undefined, 3)} clamp%=${f2(100 * clampN / Math.max(1, nl), 1)} S=${f2(sS / nl)} L=${f2(sL / nl)} mic=${f2(sM / nl)} fix=${f2(sF / nl)} plank=${f2(pl / Math.max(1, nw))}`;
    }
    // болезни (если уже есть)
    let disD = 0;
    for (const [k, v] of w.deaths) if (k.endsWith(':болезнь')) disD += v;
    extra += ` | disDeaths=${disD}`;
    if (W.micro?.sick !== undefined) {
      const act = W.pathogens ? [...W.pathogens.values()] : [];
      extra += ` sick=${W.micro.sick} outbreaks=${W.micro.outbreaksTotal ?? '-'} vir=${act.length ? f2(act.reduce((s: number, p: any) => s + p.virMean, 0) / act.length) : '-'}`;
    }
    lines.push(`t=${t} n=${w.creatures.length} H${g.herb} O${g.omni} C${g.carn} S${g.swim} | herbSize p10/50/90=${q(herbs, .1)}/${q(herbs, .5)}/${q(herbs, .9)} carnSize=${q(carn, .1)}/${q(carn, .5)}/${q(carn, .9)} | sp=${w.species.living().length}/${w.species.all.size} ms=${ms.toFixed(2)}${sp0 ? ` soilMs=${((soilMs - soil0) / (T / 5)).toFixed(3)}` : ''}${extra}`);
    t0 = performance.now(); soil0 = soilMs;
  }
}
const rivers = t1.river ? (() => { let r2 = 0, r1 = 0; for (let i = 0; i < t1.river.length; i++) { if (t1.river[i] >= 2) r2++; else if (t1.river[i] === 1) r1++; } return ` rivers: ${t1.rivers?.length} named, river>=2 ${(100 * r2 / landN).toFixed(2)}% land, stream ${(100 * r1 / landN).toFixed(2)}%`; })() : '';
console.log(`seed ${seed} ${mode} ${JSON.stringify(flags)}\n` + lines.join('\n') +
  `\n extinct(guild first hit 0): ${JSON.stringify(extinct)} zeroSamples(of ${T / 500}): ${JSON.stringify(zero)} lastZero: ${JSON.stringify(lastZero)}${rivers}\n top: ` +
  w.species.living().slice(0, 8).map(s => `${s.name}[${s.count}] sz${s.mean.size.toFixed(1)} d${s.mean.diet.toFixed(2)} sw${s.mean.swim.toFixed(1)}`).join(' | '));
