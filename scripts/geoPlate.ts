// 🌋 Дрейф плит и дождевая тень (этап 3): ворота T1 (хребет игрока → тень), T2 (надвиг → хребет и мост через пролив
// Уоллеса; разлом → вечная глубина; сдвиг вдоль разлома → суша цела, звери едут), T3 (баланс и цена шага плиты).
// Один мир на зерно: до --at тактов как обычно, затем действие, отчёт до --until. --ctl=1 — пара без действия.
// esbuild scripts/geoPlate.ts --bundle --platform=node --outfile=… && node … <seed> --scen=ridge|north|south|east [--at=6000] [--until=…] [--geoSpeed=4] [--KNOB=v]
import { World, YEAR, guildOf } from '../src/sim/world';
import * as GM from '../src/sim/geo';
import { B, SHADOW } from '../src/sim/terrain';

const flags: Record<string, string> = {};
const pos: string[] = [];
for (const a of process.argv.slice(2)) if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? '1'; } else pos.push(a);
for (const k in flags) {
  if (k in GM.GEO) (GM.GEO as any)[k] = Number(flags[k]);
  if (k.startsWith('SH_') && k.slice(3) in SHADOW) (SHADOW as any)[k.slice(3)] = Number(flags[k]);
}
const seed = Number(pos[0] ?? 42);
const scen = flags.scen ?? 'ridge';
const at = Number(flags.at ?? 6000);
const until = Number(flags.until ?? at + (scen === 'ridge' ? YEAR : 3 * YEAR));
const ctl = flags.ctl === '1';

const w = new World(3200, 2000);
Math.random = () => { throw new Error('Math.random в симуляции'); };
(w.settings as any).livePlanet = true;
w.reset((flags.mode as any) ?? 'rules', seed);
const W = w as any, g = W.geo as GM.GeoState, t = w.terrain, n = t.cols * t.rows, cols = t.cols, rows = t.rows;
if (flags.geoSpeed === '4') w.apply({ k: 'geoSpeed', t: 0, v: 4 });
const events: string[] = [];
const lg0 = W.log;
W.log = function (this: any, text: string, kind: string, x?: number, y?: number, fact?: string) {
  if (this.tick >= at) events.push(`${this.tick}:${text}`);
  return lg0.call(this, text, kind, x, y, fact);
};
const land = (i: number) => t.biome[i] > B.Shallow;
const guilds = () => { const gc = [0, 0, 0, 0]; for (const c of w.creatures) gc[guildOf(c.g)]++; return gc; };
const living = () => w.species.living().filter((s) => s.announced && s.count > 0).length;
const landN = () => { let k = 0; for (let i = 0; i < n; i++) if (land(i)) k++; return k; };
// цена шага плиты: driftStep + пересчёт (обёртка над deriveTerrain не нужна — меряем весь geoPass такта шага)
const stepMs = GM.GEO_PERF.drift;
GM.GEO_PERF.on = true;
const act = (a: any) => w.apply({ t: w.tick, ...a });
for (let i = 0; i < at; i++) w.step();
const n0 = w.creatures.length, sp0 = living(), g0 = guilds(), land0 = landN();
let out = `seed ${seed} scen=${scen}${ctl ? ' CTL' : ''} at=${at} until=${until} speed=${g.speed}`;

if (scen === 'ridge') {
  // хребет с севера на юг в западной половине, севернее мелкого порога: столбец, где суши больше всего и с запада, и с востока
  const sill = g.sills.find((s) => s.kind === 'sill');
  const y0 = Math.round(0.12 * rows), y1 = Math.max(y0 + 12, (sill ? sill.y0 : Math.round(0.38 * rows)) - 3);
  let bx = -1, bs = -1;
  for (let x = Math.round(0.22 * cols); x <= Math.round(0.38 * cols); x++) {
    let a = 0, b = 0, c = 0;
    for (let y = y0; y < y1; y++) {
      if (land(y * cols + x)) c++;
      for (let k = 4; k <= 16; k++) { if (land(y * cols + x + k)) b++; if (land(y * cols + x - k)) a++; }
    }
    // --pick=low: столбец, где суша с наветра ниже всего (новый хребет — настоящая преграда); иначе — где больше суши
    let up = 0;
    if (flags.pick === 'low') for (let y = y0; y < y1; y++) { let hm = t.seaLevel; for (let xx = 0; xx < x; xx++) { const e = t.elev[y * cols + xx]; if (e < t.seaLevel) hm = t.seaLevel; else if (e > hm) hm = e; } up += hm - t.seaLevel; }
    const sc = Math.min(a, b) * c * (flags.pick === 'low' ? Math.exp(-6 * up / (y1 - y0)) : 1);
    if (sc > bs) { bs = sc; bx = x; }
  }
  const X = (bx + 0.5) * w.cell;
  const moist0 = Float32Array.from(t.moist), biome0 = Uint8Array.from(t.biome);
  if (!ctl) act({ k: 'ridge', pts: [X, y0 * w.cell, X, y1 * w.cell] });
  const t1 = performance.now();
  w.step();
  const ms1 = performance.now() - t1;
  // подветренная сторона: 4…16 столбцов восточнее; наветренная — столько же западнее (суша и до, и после)
  const zone = (k0: number, k1: number) => {
    let m0 = 0, m1 = 0, k = 0, fl = 0, f0 = 0;
    for (let y = y0; y < y1; y++)
      for (let d = k0; d <= k1; d++) {
        const i = y * cols + bx + d;
        if (bx + d < 0 || bx + d >= cols || !land(i) || biome0[i] <= B.Shallow) continue;
        m0 += moist0[i]; m1 += t.moist[i]; k++;
        if (biome0[i] === B.Forest || biome0[i] === B.Swamp) { f0++; if (t.biome[i] !== B.Forest && t.biome[i] !== B.Swamp) fl++; }
      }
    return { d: k ? m1 / m0 - 1 : NaN, k, fl, f0 };
  };
  const lee = zone(4, 16), wind = zone(-16, -4);
  let mtn = 0;
  for (let y = y0; y < y1; y++) for (let d = -2; d <= 2; d++) { const b = t.biome[y * cols + bx + d]; if (b === B.Mountain || b === B.Snow) mtn++; }
  for (let i = w.tick; i < until; i++) w.step();
  const lee2 = zone(4, 16);
  out += ` | ridge x=${bx} rows ${y0}-${y1} mtn=${mtn} | lee Δmoist=${(100 * lee.d).toFixed(1)}% (n=${lee.k}, forest→drier ${lee.fl}/${lee.f0}) windward Δ=${(100 * wind.d).toFixed(1)}% (n=${wind.k}) | @end lee Δ=${(100 * lee2.d).toFixed(1)}% | derive+step ${ms1.toFixed(1)} ms | shadow=${g.shadow} log=${events.filter((e) => e.includes('🏜')).length}`;
} else {
  const v = scen === 'north' ? [0, -1] : scen === 'south' ? [0, 1] : [1, 0];
  const wall = g.sills.findIndex((s) => s.kind === 'wallace');
  if (!ctl) act({ k: 'drift', vx: v[0], vy: v[1] });
  let openT = -1, steps = 0, maxEvac = 0;
  const minG = [...g0];
  for (let i = w.tick; i < until; i++) {
    const s0 = g.plate?.steps ?? 0;
    const ev0 = w.events.length;
    const t1 = performance.now();
    w.step();
    const dt = performance.now() - t1;
    if ((g.plate?.steps ?? 0) > s0) steps++;
    void dt;
    for (let e = ev0; e < w.events.length; e++) { const m = /(\d+) зверей ушли/.exec(w.events[e].text); if (m) maxEvac = Math.max(maxEvac, Number(m[1])); }
    if (openT < 0 && wall >= 0 && g.sills[wall].open) openT = w.tick - at;
    if (w.tick % 300 === 0) { const gg = guilds(); for (let k = 0; k < 4; k++) minG[k] = Math.min(minG[k], gg[k]); }
  }
  const p = g.plate;
  // шов и разлом
  let mtn = 0, gapN = 0, gapDeep = 0;
  if (p) {
    const s = p.rift + p.oy;
    for (let y = Math.max(0, s - 2); y <= Math.min(rows - 1, s + 2); y++) for (let x = 0; x < cols; x++) { const b = t.biome[y * cols + x]; if ((b === B.Mountain || b === B.Snow) && W.elevD[y * cols + x] >= GM.GEO.UPLIFT && t.elev[y * cols + x] - W.elevD[y * cols + x] * 1e-4 <= t.mountainLevel) mtn++; }
    if (p.oy > 0) for (let y = p.rift; y < p.rift + p.oy; y++) for (let x = 0; x < cols; x++) { gapN++; if (t.biome[y * cols + x] === B.Deep) gapDeep++; }
  }
  const ms = [...stepMs].sort((a, b) => a - b), q = (f: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(f * ms.length))].toFixed(2) : '-');
  out += ` | plate ox=${p?.ox ?? 0} oy=${p?.oy ?? 0} steps=${steps} | wallace open=${wall >= 0 ? g.sills[wall].open : '-'}${openT >= 0 ? ` @${(openT / YEAR).toFixed(2)}y` : ''} bridges=${g.stats.bridges} | suture mtn=${mtn} | gap deep ${gapDeep}/${gapN} | land ${land0}→${landN()} (${(100 * (landN() / land0 - 1)).toFixed(1)}%) | riders=${GM.GEO_PERF.riders} | maxEvac=${maxEvac} | step ms p50=${q(0.5)} p99=${q(0.99)} max=${ms.length ? ms.at(-1)!.toFixed(2) : '-'} | orogeny=${events.filter((e) => e.includes('⛰ Плиты столкнулись')).length}/${events.filter((e) => e.includes('⛰ Хребет')).length} rift=${events.filter((e) => e.includes('разлом')).length} gabi=${events.filter((e) => e.includes('🌎')).length} shadowLog=${events.filter((e) => e.includes('🏜')).length} | invaders=${g.stats.invaders} | minGuild=${minG.join('/')}`;
}
const gE = guilds();
out += ` | n ${n0}→${w.creatures.length} sp ${sp0}→${living()} guilds ${g0.join('/')}→${gE.join('/')} ext=${g0.filter((v, k) => v > 0 && gE[k] === 0).length} derives=${g.stats.derives}`;
console.log(out);
if (flags.ev) console.log(events.filter((e) => /[⛰🧭🌊🏜🌉🌎]/u.test(e)).slice(0, 40).join('\n'));
