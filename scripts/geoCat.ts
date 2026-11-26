// 🌋 Катастрофы живой планеты (этап 2): ворота C1 (K–Pg), C2 (супервулкан VEI 8), C3 (пожар и цунами) и цена пожара.
// Один мир (rules) на зерно: до --at тактов как обычно, затем катастрофа, отчёт до --until. --ctl=1 — пара без катастрофы
// (тот же мир и такты: естественная убыль видов за год, «медиана размера» без удара).
// esbuild scripts/geoCat.ts --bundle --platform=node --outfile=… && node … <seed> --scen=kpg|volc|fire|drought|tsu [--at=12000] [--until=36000] [--ctl=1] [--KNOB=v]
import { World, YEAR, guildOf } from '../src/sim/world';
import * as GM from '../src/sim/geo';
import { CAT, CAT_PERF, herbMedian } from '../src/sim/geoCat';
import { B } from '../src/sim/terrain';

const flags: Record<string, string> = {};
const pos: string[] = [];
for (const a of process.argv.slice(2)) if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? '1'; } else pos.push(a);
for (const k in flags) {
  if (k in GM.GEO) (GM.GEO as any)[k] = Number(flags[k]);
  if (k in CAT) (CAT as any)[k] = Number(flags[k]);
}
const seed = Number(pos[0] ?? 42);
const scen = flags.scen ?? 'kpg';
const at = Number(flags.at ?? 12000), until = Number(flags.until ?? at + 4 * YEAR);
const ctl = flags.ctl === '1';
CAT_PERF.on = true;

const w = new World(3200, 2000);
Math.random = () => { throw new Error('Math.random в симуляции'); };
(w.settings as any).livePlanet = true;
w.reset((flags.mode as any) ?? 'rules', seed);
const W = w as any, g = W.geo as GM.GeoState, t = w.terrain, n = t.cols * t.rows;
const events: string[] = [];
const lg0 = W.log;
W.log = function (this: any, text: string, kind: string, x?: number, y?: number, fact?: string) {
  if (this.tick >= at) events.push(`${this.tick}:${text}`);
  return lg0.call(this, text, kind, x, y, fact);
};
/** Ближайшая к центру клетка, где pred. */
const nearest = (pred: (i: number) => boolean): number => {
  let best = -1, bd = Infinity;
  for (let i = 0; i < n; i++) {
    if (!pred(i)) continue;
    const d = Math.hypot((i % t.cols) - t.cols / 2, Math.floor(i / t.cols) - t.rows / 2);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};
const xy = (i: number): [number, number] => [((i % t.cols) + 0.5) * w.cell, (Math.floor(i / t.cols) + 0.5) * w.cell];
const living = () => w.species.living().filter((s) => s.announced && s.count > 0).length;
const landSoil = (mask?: Uint8Array) => {
  let s = 0, k = 0;
  for (let i = 0; i < n; i++) if (t.biome[i] > B.Shallow && (!mask || mask[i])) { s += W.soil[i]; k++; }
  return k ? s / k : 0;
};
const guilds = () => { const gc = [0, 0, 0, 0]; for (const c of w.creatures) gc[guildOf(c.g)]++; return gc.join('/'); };

for (let i = 0; i < at; i++) w.step();
const n0 = w.creatures.length, sp0 = living(), med0 = herbMedian(w), soil0 = landSoil();
const ring0 = w.species.living().filter((s) => s.announced && s.count > 0).map((s) => s.id);
let where = '';
let ashPre = NaN;
const ashMask = new Uint8Array(n);
let burnMask: Uint8Array | null = null, saltMask: Uint8Array | null = null, soilBurn0 = 0;
const act = (a: any) => w.apply({ t: w.tick, ...a });
if (!ctl) {
  if (scen === 'kpg') {
    const c = nearest((i) => t.biome[i] > B.Shallow);
    const [x, y] = xy(c);
    where = `${x},${y}`;
    act({ k: 'impact', x, y, size: Number(flags.size ?? 3) });
  } else if (scen === 'volc') {
    const c = nearest((i) => t.springs.includes(i));
    const [x, y] = xy(c);
    where = `${x},${y}`;
    act({ k: 'volcano', x, y, vei: Number(flags.vei ?? 8) });
    for (let i = 0; i < n; i++) if (W.fx8[i] > 128 && t.biome[i] > B.Shallow) ashMask[i] = 1;
    ashPre = landSoil(ashMask) / landSoil();
  } else if (scen === 'fire' || scen === 'drought') {
    if (scen === 'drought') act({ k: 'drought' });
    const c = nearest((i) => (t.biome[i] === B.Forest || t.biome[i] === B.Grass || t.biome[i] === B.Savanna) && W.grass[i] > 0.3);
    const [x, y] = xy(c);
    where = `${x},${y}`;
    act({ k: 'fire', x, y });
  } else if (scen === 'tsu') {
    const c = nearest((i) => t.biome[i] === B.Shallow);
    const [x, y] = xy(c);
    where = `${x},${y}`;
    act({ k: 'tsunami', x, y });
    saltMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (W.fx8[2 * n + i] > 0) saltMask[i] = 1;
  }
}
// ход: каждые 300 тактов — численность; пожар — сколько горит; цунами — соль
let minN = n0, minT = at, aerT = 0, maxFire = 0, fireEnd = -1, saltEnd = -1;
const rows: string[] = [];
const ashArea = ashMask.reduce((s, v) => s + v, 0);
let n3 = 0, k3 = 0, ashRatio2 = NaN, burnRatio = NaN, fireCells = 0;
for (let tick = at; tick < until; tick++) {
  w.step();
  const dt = w.tick - at;
  if (GM.GEO.AER_K * g.aer >= 0.06) aerT++;
  if (g.fire.length / 2 > maxFire) maxFire = g.fire.length / 2;
  if ((scen === 'fire' || scen === 'drought') && !ctl && fireEnd < 0 && g.fire.length === 0 && dt > 10) {
    fireEnd = dt;
    burnMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (W.fx8[n + i] > 0 && W.fx8[n + i] !== 255) { burnMask[i] = 1; fireCells++; }
    soilBurn0 = landSoil(burnMask);
  }
  if (burnMask && dt === fireEnd + YEAR / 2) burnRatio = landSoil(burnMask) / landSoil();
  if (saltMask && saltEnd < 0 && dt % 60 === 0) {
    let any = false;
    for (let i = 0; i < n && !any; i++) if (saltMask[i] && W.fx8[2 * n + i] > 0) any = true;
    if (!any) saltEnd = dt;
  }
  if (w.creatures.length < minN && dt <= 3 * YEAR) { minN = w.creatures.length; minT = dt; }
  if (dt >= 2.5 * YEAR && dt < 3 * YEAR) { n3 += w.creatures.length; k3++; }
  if (dt === 2 * YEAR && ashArea) ashRatio2 = landSoil(ashMask) / landSoil();
  if (dt % 1500 === 0) rows.push(`${(dt / YEAR).toFixed(2)}y n=${w.creatures.length} sp=${living()} g=${guilds()}${g.aer > 0.001 ? ` aer=${g.aer.toFixed(2)}` : ''}${g.dark > 0.001 ? ` dark=${g.dark.toFixed(2)}` : ''}${g.fire.length ? ` fire=${g.fire.length / 2}` : ''}`);
}
// потери видов за год (по кольцу видов на такте at — и для пары без катастрофы)
const sum = g.lastSum;
let lostYear = -1;
if (ctl) {
  // без катастрофы: те же виды через год (по летописи вымираний — вид вымер, если extinct ≤ at + YEAR)
  let k = 0;
  for (const id of ring0) { const s = w.species.all.get(id); if (s && s.extinct !== null && s.extinct <= at + YEAR) k++; }
  lostYear = ring0.length ? k / ring0.length : 0;
} else if (sum) lostYear = sum.N ? sum.k / sum.N : 0;
const rad = events.filter((e) => e.includes('🌳 Адаптивная радиация')).length;
const mass = events.filter((e) => e.includes('💀 Массовое')).length;
const bn = events.filter((e) => e.includes('⚠️ Бутылочное горлышко')).length;
const meg = events.filter((e) => e.includes('Мегапожар')).length;
const fp = [...CAT_PERF.ms].sort((a, b) => a - b), q = (p: number) => (fp.length ? fp[Math.min(fp.length - 1, Math.floor(p * fp.length))].toFixed(3) : '-');
const nEnd = w.creatures.length;
console.log(`seed ${seed} scen=${scen}${ctl ? ' CTL' : ''} at=${at} where=${where} | n0=${n0} sp0=${sp0} med0=${med0.toFixed(2)} | trough=${minN} (${(100 * (1 - minN / n0)).toFixed(0)}% @${(minT / YEAR).toFixed(2)}y) n2.5-3y=${k3 ? Math.round(n3 / k3) : '-'} (${k3 ? (100 * n3 / k3 / n0).toFixed(0) : '-'}%) nEnd=${nEnd} spEnd=${living()} | lostYear=${(100 * lostYear).toFixed(0)}% ${sum ? `(${sum.k}/${sum.N}) med ${sum.m0.toFixed(2)}→${sum.m1.toFixed(2)}` : ''} | mass=${mass} bn=${bn} rad=${rad} | aer≥0.06 for ${(aerT / YEAR).toFixed(2)}y target=${w.climate.target} | ash>128 cells=${ashArea} soil ash/island @2y=${Number.isNaN(ashRatio2) ? '-' : ashRatio2.toFixed(2)} (before ${Number.isNaN(ashPre) ? '-' : ashPre.toFixed(2)}) | fire max=${maxFire} end=${fireEnd < 0 ? '-' : (fireEnd / YEAR).toFixed(2) + 'y'} burnt=${fireCells} soil burnt/island +0.5y=${Number.isNaN(burnRatio) ? '-' : burnRatio.toFixed(2)} (at end ${soilBurn0 ? (soilBurn0 / soil0).toFixed(2) : '-'}) mega=${meg} | salt cells=${saltMask ? saltMask.reduce((s, v) => s + v, 0) : '-'} cleared=${saltEnd < 0 ? '-' : (saltEnd / YEAR).toFixed(2) + 'y'} | fireStep ms p50=${q(0.5)} p99=${q(0.99)} max=${fp.length ? fp.at(-1)!.toFixed(3) : '-'} n=${fp.length} | stats imp=${g.stats.impacts} eru=${g.stats.eruptions} fires=${g.stats.fires} massExt=${g.stats.massExt}`);
if (flags.rows) console.log(rows.join('\n'));
if (flags.ev) console.log(events.filter((e) => /[☄🌋🌫🌊🔥🌱💀⛵🐭⚠🌳⚡]/u.test(e)).slice(0, 40).join('\n'));
