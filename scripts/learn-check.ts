// Проверка уроков «📚 Справочник» без браузера: npm run learn:check [-- --planet] [-- --full]
// Планета детерминирована (зерно в параметрах), поверхность — с зерном для Math.random.
import { EARTH, PRESETS, simulate, type PlanetParams, type SimResult } from '../src/planet/model';
import { EARTH_ENV, World, YEAR, type SurfaceEnv } from '../src/sim/world';
import { mulberry32 } from '../src/lib/random';
import {
  addTwin, decomposerSwitch, diseaseModel, emptyTwin, fluxOrbit, gauseGoal, guilds, landMean, MARS, MARS_RD,
  PLANET_LINKS, sickNow, soilFields, twinWorld,
} from '../src/learn/scenarios';

const args = process.argv.slice(2);
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`);
  if (!cond) failed++;
};
const t0 = Date.now();
const lap = (name: string, t: number) => console.log(`  ⏱ ${name}: ${((Date.now() - t) / 1000).toFixed(1)} с`);
const run = (p: PlanetParams): SimResult => simulate(p, PRESETS.realist.a, true);
const at = (r: SimResult, t: number) => r.samples[Math.max(0, Math.min(r.samples.length - 1, Math.round((t / r.end) * (r.samples.length - 1))))];
const ev = (r: SimResult, id: string, match?: string) => r.events.find((e) => e.id === id && (!match || e.text.includes(match)));
const f2 = (x: number) => x.toFixed(3);

console.log('🪐 Планета');
{
  const r = run(MARS);
  const d = ev(r, 'dynamo');
  ok(!!d && d.t < 0.2, `Марс: щит гаснет до 0,2 млрд лет (${d?.t})`);
  const s15 = at(r, 1.5), s45 = at(r, 4.5);
  console.log(`    N₂ ${f2(r.samples[0].pressure)} → ${f2(s15.pressure)} (1,5) → ${f2(s45.pressure)} (4,5); CO₂ ${f2(s15.co2)}/${f2(s45.co2)}; T ${Math.round(s15.T - 273)}/${Math.round(s45.T - 273)} °C; max stage ${r.maxStage}`);
  const rd = run(MARS_RD);
  const s = rd.samples.find((x) => x.pressure < 0.01 && x.ocean <= 0.01);
  ok(!!s && s.t < 1.2, `Марс у красного карлика: нет азота и воды до 1,2 (${s?.t.toFixed(2)}, CO₂ ${s ? f2(s.co2) : '-'})`);
  console.log(`    щит гаснет: ${ev(rd, 'dynamo')?.t}; приливный захват: ${rd.derived.tidalLock}`);
}
{
  const r = run({ ...EARTH, moon: 0 });
  const a = ev(r, 'axis');
  ok(!!a && r.maxStage < 6, `Без Луны: скачок оси (${a?.t}) и нет разума (max ${r.maxStage})`);
  console.log(`    с Луной разум на ${run(EARTH).firstReached[6]}`);
}
{
  const t = Date.now();
  const A = emptyTwin(), B = emptyTwin();
  for (let i = 0; i < 500; i++) {
    addTwin(A, twinWorld(EARTH, { moon: 1 }, 1 + i, 'realist'));
    addTwin(B, twinWorld(EARTH, { moon: 0 }, 1 + i, 'realist'));
  }
  console.log(`    близнецы 500: животные ${A.reached[4]}/${B.reached[4]}, суша ${A.reached[5]}/${B.reached[5]}, разум ${A.reached[6]}/${B.reached[6]}, оси ${A.events.axis ?? 0}/${B.events.axis ?? 0}, микробы ${A.reached[1]}/${B.reached[1]}`);
  ok(A.reached[6] > 2 * B.reached[6], 'Близнецы: с Луной разум более чем вдвое чаще');
  ok((A.events.axis ?? 0) === 0 && (B.events.axis ?? 0) > 100, 'Близнецы: скачки оси только без Луны');
  lap('близнецы', t);
}
{
  const r = run({ ...EARTH, orbit: fluxOrbit(0.75) });
  const sn = ev(r, 'snowball', 'целиком'), th = ev(r, 'thaw', 'Вулканический');
  ok(!!sn && !!th && sn.t < th.t, `Снежок: замёрзла ${sn?.t}, оттаяла ${th?.t}`);
  ok(!!th && at(r, th.t + 0.05).ice < 0.5, 'Снежок: после оттепели льда < 50%');
  if (sn && th) console.log(`    CO₂ ${f2(at(r, sn.t).co2)} → ${f2(at(r, th.t).co2)}; ice@snow ${at(r, sn.t).ice.toFixed(2)}`);
}
{
  const r = run({ ...EARTH, orbit: fluxOrbit(1.4) });
  const e = ev(r, 'runaway');
  ok(!!e && e.t < 4.5, `Венера (×1,4): океаны выкипели на ${e?.t}`);
  const r2 = run({ ...EARTH, orbit: fluxOrbit(1.25) });
  console.log(`    ×1,25: T(2)=${Math.round(at(r2, 2).T - 273)} °C, T(4,5)=${Math.round(at(r2, 4.5).T - 273)} °C, океан ${at(r2, 4.5).ocean.toFixed(2)}, co2starve ${ev(r2, 'co2starve')?.t}, runaway ${ev(r2, 'runaway')?.t}`);
}
for (const [key, l] of Object.entries(PLANET_LINKS)) {
  if (l.noEvent) continue;
  const r = run({ ...EARTH, ...l.params });
  const e = ev(r, l.event ?? key, l.match);
  if (!e) ok(false, `Ссылка «${key}»: событие не найдено`);
}
console.log(`  ✓ ссылки проверены (${Object.keys(PLANET_LINKS).length})`);

if (!args.includes('--planet')) {
  console.log('🦊 Поверхность');
  const seeds = [42, 7];
  const make = (seed: number, env: Partial<SurfaceEnv> = {}) => {
    Math.random = mulberry32(seed * 7919 + 1);
    const w = new World(3200, 2000);
    w.reset('rules', seed, { ...EARTH_ENV, ...env });
    return w;
  };
  const steps = (w: World, n: number) => {
    for (let i = 0; i < n; i++) w.step();
  };
  for (const seed of seeds) {
    const t = Date.now();
    const w = make(seed, { o2: 0.08 });
    steps(w, 9000);
    let max = 0;
    for (const c of w.creatures) if (c.generation > 0) max = Math.max(max, c.g.size);
    ok(max <= 8.65, `O₂ 8%, зерно ${seed}: самое крупное потомство ${max.toFixed(2)} ≤ 8,65 (потолок ${w.maxSize.toFixed(2)}, гигантов ${guilds(w).giants})`);
    lap('O₂ 8%', t);
  }
  if (args.includes('--full')) {
    for (const o2 of [0.21, 0.35]) {
      const w = make(42, { o2 });
      steps(w, 9000);
      const g = guilds(w);
      console.log(`    O₂ ${o2}: max ${g.max.toFixed(1)}, гигантов ${g.giants}, потолок ${w.maxSize.toFixed(1)}`);
    }
  }
  for (const seed of seeds) {
    const t = Date.now();
    const w = make(seed);
    steps(w, 4000);
    const g0 = guilds(w);
    w.removeResource('browse', 2 * YEAR);
    let tk = 0;
    while (tk < 12000 && guilds(w).giants > gauseGoal(g0.giants)) {
      steps(w, 250);
      tk += 250;
    }
    const g1 = guilds(w);
    ok(g1.giants <= gauseGoal(g0.giants), `Гаузе, зерно ${seed}: гигантов ${g0.giants} → ${g1.giants} за ${tk} тактов (мелких травоядных ${g0.smallHerb} → ${g1.smallHerb}, хищников ${g0.carn} → ${g1.carn})`);
    lap('Гаузе', t);
  }
  {
    const w = make(42);
    const sw = decomposerSwitch(w);
    const sf = soilFields(w);
    if (!sw || !sf) console.log('  – урок «Невидимые дворники» пропущен: в мире ещё нет микробов почвы');
    else {
      steps(w, 3000);
      const L0 = landMean(w, sf.litter), S0 = landMean(w, sf.soil);
      sw.noDecomposers = true;
      let tk = 0, L = L0, S = S0;
      while (tk < 12000 && !(L >= L0 * 1.5 && S <= S0 * 0.85)) {
        steps(w, 250);
        tk += 250;
        const f = soilFields(w)!;
        L = landMean(w, f.litter);
        S = landMean(w, f.soil);
      }
      ok(L >= L0 * 1.5 && S <= S0 * 0.85, `Без разложителей: опад ${L0.toFixed(3)} → ${L.toFixed(3)}, почва ${S0.toFixed(3)} → ${S.toFixed(3)} за ${tk}`);
    }
  }
  {
    const w = make(42);
    if (!diseaseModel(w) || sickNow(w) === null) console.log('  – урок «Как растёт эпидемия» пропущен: в мире ещё нет новой модели болезней');
    else {
      steps(w, 3000);
      w.epidemic();
      let peak = 0, now = 0;
      for (let tk = 0; tk < 15000; tk += 100) {
        steps(w, 100);
        now = sickNow(w) ?? 0;
        peak = Math.max(peak, now);
        if (tk > 1500 && peak > 0 && now <= 0.2 * peak) break;
      }
      ok(peak > 0 && now <= 0.2 * peak, `Эпидемия: пик ${peak}, сейчас ${now}`);
    }
  }
}
console.log(`\n${failed ? `✗ Провалено проверок: ${failed}` : '✓ Все проверки пройдены'} · ${((Date.now() - t0) / 1000).toFixed(0)} с`);
process.exit(failed ? 1 : 0);
