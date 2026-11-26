// 🌋 Климат живой планеты без зверей: только геопроход (орбита, лёд, CO₂, море, пересчёты рельефа) — быстро и
// ровно тот же путь, что в World.step (геология от зверей не зависит). Ворота G1a, G1, G2 (пороги), G8.
// node geoClimate.cjs [--seeds=42,7,…] [--years=48] [--cool=-0.18] [--co2=1200] [--orbit=0] [--geoSpeed=4] [--KNOB=v]
import { World } from '../src/sim/world';
import * as GM from '../src/sim/geo';
import { B } from '../src/sim/terrain';

const flags: Record<string, string> = {};
for (const a of process.argv.slice(2)) if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v ?? '1'; }
for (const k in flags) if (k in GM.GEO) (GM.GEO as any)[k] = Number(flags[k]);
const seeds = (flags.seeds ?? '42,7,123,2024,9,77,1,555').split(',').map(Number);
const years = Number(flags.years ?? 48);
const YEAR = 6000;
let rs = 12345;
Math.random = () => (rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296;
const sumOk: string[] = [];
for (const seed of seeds) {
  const w = new World(3200, 2000);
  (w.settings as any).livePlanet = true;
  w.reset('rules', seed);
  const W = w as any, g = W.geo as GM.GeoState;
  const at = (k: string, a: any) => w.apply({ t: w.tick, k, ...a } as any);
  if (flags.cool !== undefined) { at('iceAge', { mode: 'off' }); at('co2', { ppm: 280 }); g.fPin = Number(flags.cool); }
  if (flags.orbit === '0') at('iceAge', { mode: 'off' });
  if (flags.co2 !== undefined) at('co2', { ppm: Number(flags.co2) });
  if (flags.geoSpeed !== undefined) at('geoSpeed', { v: Number(flags.geoSpeed) });
  const T = years * YEAR;
  const cyc = new Map<number, { min: number; max: number; open: boolean; vmax: number }>();
  let sMax = -9, seaMin = 9, seaMax = -9, vMin = 9, vMax = -9, wDeep = true, wSplit = true, below = 0, N = 0;
  let s2min = 9, s2max = -9, v2max = -9;
  let iceLate = 0, seaLate = 0, kLate = 0, iceLmin = 9, iceLmax = -9, iceSeen = 0;
  const t0 = performance.now();
  for (let t = 1; t <= T; t++) {
    w.tick++;
    if (g.pend.length) GM.deriveTerrain(w, true);
    if (w.tick % GM.GEO.EVERY !== 0) continue;
    GM.geoPass(w);
    const sh = g.geoShift + w.climate.shift;
    const c = Math.floor((g.orbT - g.orb0) / GM.GEO.P);
    const r = cyc.get(c) ?? { min: 9, max: -9, open: false, vmax: -9 };
    r.min = Math.min(r.min, sh); r.max = Math.max(r.max, sh); r.vmax = Math.max(r.vmax, g.Vg);
    const sill = g.sills.find((s) => s.kind === 'sill');
    if (sill?.open) r.open = true;
    cyc.set(c, r);
    sMax = Math.max(sMax, sh);
    if (sh < -0.18) below++;
    N++;
    seaMin = Math.min(seaMin, g.seaQ); seaMax = Math.max(seaMax, g.seaQ);
    vMin = Math.min(vMin, g.Vg); vMax = Math.max(vMax, g.Vg);
    iceSeen = Math.max(iceSeen, g.iceLand);
    if (t > 2 * YEAR) { s2min = Math.min(s2min, g.seaQ); s2max = Math.max(s2max, g.seaQ); v2max = Math.max(v2max, g.Vg); }
    const wal = g.sills.find((s) => s.kind === 'wallace');
    if (wal) { if (wal.open) wSplit = false; for (const i of wal.cells) if (w.terrain.biome[i] !== B.Deep) { wDeep = false; break; } }
    if (t > T - 2 * YEAR) { iceLate += g.iceLand; seaLate += g.seaQ; kLate++; iceLmin = Math.min(iceLmin, g.iceLand); iceLmax = Math.max(iceLmax, g.iceLand); }
  }
  const ms = performance.now() - t0;
  const full = [...cyc.entries()].filter(([c]) => (c + 1) * GM.GEO.P <= g.orbT - g.orb0);
  const C = 100 / 3;
  console.log(`seed ${seed}: cycles ${full.length} minima ${full.map(([, r]) => r.min.toFixed(3)).join(' ')} | max ${sMax.toFixed(3)} | <-0.18 ${(100 * below / N).toFixed(1)}% | sill dry per cycle ${full.map(([, r]) => (r.open ? 1 : 0)).join('')} | Vg ${vMin.toFixed(2)}..${vMax.toFixed(2)} | sea ${GM.metres(seaMin)}..${GM.metres(seaMax)} м | after2y sea ${GM.metres(s2min)}..${GM.metres(s2max)} Vgmax ${v2max.toFixed(3)} | wallaceDeep ${wDeep ? 1 : 0} split ${wSplit ? 1 : 0} | iceMax ${(100 * iceSeen).toFixed(1)}% | last2y ice ${(100 * iceLate / kLate).toFixed(1)}% (${(100 * iceLmin).toFixed(1)}..${(100 * iceLmax).toFixed(1)}) sea ${GM.metres(seaLate / kLate)} м | co2 ${g.co2.toFixed(0)} dT ${((g.geoShift) * C).toFixed(1)} °C | derives ${g.stats.derives} glacials ${g.stats.glacials} bridges ${g.stats.bridges} | ${(ms / 1000).toFixed(1)} s`);
  sumOk.push(String(seed));
}
