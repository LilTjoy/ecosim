// Проверка уроков «📚 Справочник» без браузера: npm run learn:check [-- --planet] [-- --full]
// Планета детерминирована (зерно в параметрах), поверхность — с зерном для Math.random.
import { EARTH, PRESETS, simulate, type PlanetParams, type SimResult } from '../src/planet/model';
import { EARTH_ENV, World, YEAR, type SurfaceEnv } from '../src/sim/world';
import { mulberry32 } from '../src/lib/random';
import { FACTS, WORLD_FACTS } from '../src/planet/facts';
import {
  addTwin, CAP8, decomposerSwitch, diseaseModel, emptyTwin, fluxOrbit, gauseGoal, guilds, herbsOver, landMean, MARS, MARS_RD,
  outbreakById, outbreakSick, PLANET_LINKS, soilFields, startLessonEpidemic, twinWorld, iceNow, iceBridgeOk, iceMeltOk, icePeakOk,
  vicNow, wallaceFaunas, panamaNow, VIC_SEED, PANAMA_SEED, KPG_SEED, kpgNow, kpgSpot, SHADOW_SEED, shadowLine, shadowNow,
} from '../src/learn/scenarios';
import { GEO, panamaLine } from '../src/sim/geo';
import { LESSONS } from '../src/learn/lessons';
import { allCards } from '../src/learn/catalog';

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
  ok(s45.ocean > 0.3, `Марс у Солнца: воздух улетел (${ev(r, 'atmoloss')?.t}), а вода осталась (${s45.ocean.toFixed(2)} на 4,5)`);
  const rd = run(MARS_RD);
  const s = rd.samples.find((x) => x.pressure < 0.01 && x.ocean <= 0.01);
  ok(!!s && s.t < 1.5, `Марс у красного карлика: нет азота и воды до 1,5 (${s?.t.toFixed(2)}, CO₂ ${s ? f2(s.co2) : '-'})`);
  const al = ev(rd, 'atmoloss');
  ok(!!al && al.t < 0.2, `Марс у красного карлика: воздух улетел почти сразу (${al?.t})`);
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
  // шаг 3 урока: после выкипания карбонаты отдают CO₂ — ждём ≥ 40 бар (giveUp на 7 млрд лет)
  const cb = ev(r, 'carbonates');
  const s40 = cb ? r.samples.find((x) => x.t >= cb.t && x.co2 >= 40) : undefined;
  ok(!!cb && !!e && cb.t >= e.t && !!s40 && s40.t < 7, `Венера (×1,4): карбонаты ${cb?.t}, CO₂ ≥ 40 бар на ${s40?.t.toFixed(2)} (T ${s40 ? Math.round(s40.T - 273) : '-'} °C), максимум ${Math.max(...r.samples.map((x) => x.co2)).toFixed(0)} бар`);
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
{
  // у каждой карточки планеты есть сценарий (иначе «▶ Посмотреть» откроет Землю на t = 0)
  const keys = [...Object.keys(FACTS), ...Object.keys(WORLD_FACTS)];
  const miss = keys.filter((k) => !PLANET_LINKS[k]);
  ok(miss.length === 0, `Карточки планеты со ссылками: ${keys.length - miss.length}/${keys.length}${miss.length ? ` (нет: ${miss.join(', ')})` : ''}`);
}

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
    ok(max <= CAP8 + 0.01, `O₂ 8%, зерно ${seed}: самое крупное потомство ${max.toFixed(2)} ≤ ${CAP8.toFixed(2)} (потолок ${w.maxSize.toFixed(2)}, гигантов > 8: ${guilds(w).giants}, крупнее потолка: ${herbsOver(w, CAP8)} — только основатели и пришельцы)`);
    let bornOver = 0;
    for (const c of w.creatures) if (c.alive && c.generation > 0 && c.g.size > CAP8 + 0.01) bornOver++;
    ok(bornOver === 0, `O₂ 8%, зерно ${seed}: родившихся крупнее потолка нет (${bornOver})`);
    lap('O₂ 8%', t);
  }
  if (args.includes('--full')) {
    for (const o2 of [0.21, 0.35]) {
      const w = make(42, { o2 });
      steps(w, 9000);
      const g = guilds(w);
      console.log(`    O₂ ${o2}: max ${g.max.toFixed(1)}, гигантов ${g.giants}, крупнее ${CAP8.toFixed(2)}: ${herbsOver(w, CAP8)}, потолок ${w.maxSize.toFixed(1)}`);
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
  // «Невидимые дворники»: как в уроке — 3000 тактов, год без разложителей, потом возвращаем
  for (const seed of seeds) {
    const t = Date.now();
    const w = make(seed);
    const sw = decomposerSwitch(w);
    const sf = soilFields(w);
    if (!sw || !sf) {
      ok(false, 'Невидимые дворники: в мире нет почвы или опыта noDecomposers');
      continue;
    }
    steps(w, 3000);
    const L0 = landMean(w, sf.litter), S0 = landMean(w, sf.soil), K0 = w.corpses.length, G0 = w.history.at(-1)?.grass ?? 0;
    const rec0 = w.micro.corpsesRecycled;
    let rotLogs = 0;
    const log0 = w.log.bind(w);
    w.log = (text, kind, x, y) => {
      if (text.includes('разложились')) rotLogs++;
      log0(text, kind, x, y);
    };
    sw.noDecomposers = true;
    let tk = 0, L = L0, S = S0;
    while (tk < 2 * YEAR && !(tk >= YEAR && L >= L0 * 2 && S <= S0 * 0.85)) {
      steps(w, 250);
      tk += 250;
      L = landMean(w, sf.litter);
      S = landMean(w, sf.soil);
    }
    const K = w.corpses.length;
    ok(tk >= YEAR && L >= L0 * 2 && S <= S0 * 0.85, `Без разложителей, зерно ${seed}: опад ${L0.toFixed(3)} → ${L.toFixed(3)} (×${(L / L0).toFixed(2)}), почва ${S0.toFixed(3)} → ${S.toFixed(3)} (×${(S / S0).toFixed(2)}), туш ${K0} → ${K} за ${tk}`);
    ok(K > K0, `Без разложителей, зерно ${seed}: туши копятся (${K0} → ${K})`);
    const G = w.history.at(-1)?.grass ?? 0;
    console.log(`    трава ${G0.toFixed(3)} → ${G.toFixed(3)} (×${(G / Math.max(1e-9, G0)).toFixed(2)}; в уроке «поредела» при < 0,85)`);
    ok(w.micro.corpsesRecycled === rec0 && rotLogs === 0, `Без разложителей, зерно ${seed}: туши не «перерабатываются» (${w.micro.corpsesRecycled - rec0}) и летопись молчит о гниении (${rotLogs})`);
    w.log = log0;
    const Loff = L;
    sw.noDecomposers = false;
    tk = 0;
    while (tk < 2 * YEAR && !(L <= Loff * 0.8 && S >= S0 * 0.95)) {
      steps(w, 250);
      tk += 250;
      L = landMean(w, sf.litter);
      S = landMean(w, sf.soil);
    }
    ok(L <= Loff * 0.8 && S >= S0 * 0.95, `Разложители вернулись, зерно ${seed}: опад ${Loff.toFixed(3)} → ${L.toFixed(3)}, почва ${S.toFixed(3)} (до опыта ${S0.toFixed(3)}) за ${tk}`);
    lap('дворники', t);
  }
  // «Как растёт эпидемия»: заражаем самый многочисленный вид, следим за этой вспышкой (а не за всеми больными мира)
  for (const seed of seeds) {
    const t = Date.now();
    const w = make(seed);
    if (!diseaseModel(w)) {
      ok(false, 'Эпидемия: модель болезней выключена');
      continue;
    }
    steps(w, 3000);
    const e = startLessonEpidemic(w);
    if (!e) {
      ok(false, `Эпидемия, зерно ${seed}: заразить некого`);
      continue;
    }
    const i0 = e.P.cases, t0e = w.tick;
    let tk = 0, passed = false;
    while (tk < 15000) {
      steps(w, 20);
      tk += 20;
      const P = outbreakById(w, e.P.id);
      if (P && P.peak > 0 && outbreakSick(P) <= 0.2 * P.peak && w.tick > t0e + 1500) {
        passed = true;
        break;
      }
    }
    const P = outbreakById(w, e.P.id);
    if (P) console.log(`    переболели ${((P.cases / e.n0) * 100).toFixed(0)}% вида — в уроке ${P.cases >= e.n0 * 0.5 ? 'коллективный иммунитет' : 'R < 1 без коллективного иммунитета'}`);
    ok(passed && !!P, `Эпидемия, зерно ${seed}: «${e.hostName}» (${e.n0}), заразили ${i0}, пик ${P?.peak}, всего ${P?.cases}, погибли ${P?.deaths}, выздоровели ${P?.recovered}, вирулентность ${P?.vir0} → ${P?.virMean.toFixed(2)}, спала за ${tk}`);
    lap('эпидемия', t);
  }
  // «❄️ Ледниковый период»: живая планета, 3000 тактов, «❄️ сейчас» + геология ×4 → перешеек, потом пик (как в уроке)
  {
    const L = LESSONS.find((x) => x.id === 'ice');
    const ids = new Set(allCards().map((c) => c.id));
    ok(!!L && L.cards.every((id) => ids.has(id)), `Ледниковый период: урок есть, карточки на месте (${L?.cards.filter((id) => !ids.has(id)).join(', ') || 'все'})`);
  }
  for (const seed of seeds) {
    const t = Date.now();
    Math.random = mulberry32(seed * 7919 + 1);
    const w = new World(3200, 2000);
    w.settings.livePlanet = true;
    w.reset('rules', seed, { ...EARTH_ENV });
    steps(w, 3000);
    const s0 = iceNow(w);
    const sp0 = w.species.living().length;
    w.apply({ t: w.tick, k: 'iceAge', mode: 'now' });
    w.apply({ t: w.tick, k: 'geoSpeed', v: 4 });
    let tk = 0, tb = -1;
    while (tk < 30000 && !icePeakOk(iceNow(w))) {
      steps(w, 60);
      tk += 60;
      if (tb < 0 && iceBridgeOk(iceNow(w))) tb = tk;
    }
    const s = iceNow(w);
    ok(!!s0 && s0.ice < 0.06 && Math.abs(s0.sea) <= 12, `Ледниковый период, зерно ${seed}: в начале межледниковье (море ${s0?.sea} м, лёд ${s0 ? (s0.ice * 100).toFixed(1) : '-'}%)`);
    ok(tb > 0 && tb < 30000, `Ледниковый период, зерно ${seed}: перешеек открылся за ${tb} тактов`);
    ok(!!s && icePeakOk(s) && s.wallace, `Ледниковый период, зерно ${seed}: пик за ${tk} тактов — море ${s?.sea} м, лёд ${s ? (s.ice * 100).toFixed(0) : '-'}%, ${s?.dT.toFixed(1)} °C, CO₂ ${s?.co2.toFixed(0)}, южный пролив глубок: ${s?.wallace}; видов ${sp0} → ${w.species.living().length}, зверей ${w.creatures.length}`);
    // шаг 6: «💧 Конец ледниковья» → межледниковье, морены
    w.apply({ t: w.tick, k: 'iceAge', mode: 'end' });
    let tm = 0;
    while (tm < 30000 && !iceMeltOk(iceNow(w))) {
      steps(w, 60);
      tm += 60;
    }
    const m = iceNow(w);
    ok(!!m && iceMeltOk(m) && m.moraines > 0 && !m.bridge, `Ледниковый период, зерно ${seed}: межледниковье через ${tm} тактов — море ${m?.sea} м, лёд ${m ? (m.ice * 100).toFixed(0) : '-'}%, морен ${m?.moraines}, котловин ${m?.kettles}, озёр ${m?.lakes}, перешеек ${m?.bridge ? 'открыт' : 'под водой'}`);
    lap('ледниковый период', t);
  }
  // «🌊 Пролив рождает виды» (×1, зерно урока): вид по обе стороны пролива → 5 поколений врозь → разделение
  {
    const t = Date.now();
    const L = LESSONS.find((x) => x.id === 'vic');
    const ids = new Set(allCards().map((c) => c.id));
    ok(!!L && L.cards.every((id) => ids.has(id)), `Пролив рождает виды: урок есть, карточки на месте`);
    Math.random = mulberry32(VIC_SEED * 7919 + 1);
    const w = new World(3200, 2000);
    w.settings.livePlanet = true;
    w.reset('rules', VIC_SEED, { ...EARTH_ENV });
    let t1 = -1, t2 = -1, t3 = -1, tk = 0;
    while (tk < 90000 && t3 < 0) {
      steps(w, 200);
      tk += 200;
      const v = vicNow(w)!;
      if (t1 < 0 && v.best) t1 = tk;
      if (t2 < 0 && ((v.best?.ga ?? 0) >= GEO.ISO_GEN / 2 || v.splits > 0)) t2 = tk;
      if (t3 < 0 && v.splits > 0) t3 = tk;
    }
    const f = wallaceFaunas(w);
    ok(t1 >= 0 && t1 <= 30000 && t2 >= 0 && t2 - t1 <= 30000 && t3 >= 0 && t3 - t2 <= 30000, `Пролив рождает виды, зерно ${VIC_SEED}: вид по обе стороны — ${t1}, подвиды — ${t2}, новый вид — ${t3} тактов; утечек ${vicNow(w)!.leaks}; фауны за Уоллесом: ${f?.north}/${f?.south}, общих ${f?.shared}`);
    lap('пролив рождает виды', t);
  }
  // «🌉 Опыт „Панама“»: 3 года врозь → перешеек через Уоллеса → мост открылся → сводка обмена за 2 года
  {
    const t = Date.now();
    const L = LESSONS.find((x) => x.id === 'panama');
    const ids = new Set(allCards().map((c) => c.id));
    ok(!!L && L.cards.every((id) => ids.has(id)), `Опыт «Панама»: урок есть, карточки на месте`);
    Math.random = mulberry32(PANAMA_SEED * 7919 + 1);
    const w = new World(3200, 2000);
    w.settings.livePlanet = true;
    w.reset('rules', PANAMA_SEED, { ...EARTH_ENV });
    steps(w, 3 * YEAR);
    const f = wallaceFaunas(w);
    const pts = panamaLine(w);
    if (pts) w.apply({ t: w.tick, k: 'isthmus', pts });
    let to = -1, tk = 0;
    while (tk < 3000 && to < 0) { steps(w, 20); tk += 20; if (panamaNow(w)?.open) to = tk; }
    tk = 0;
    while (tk < 3 * YEAR && !panamaNow(w)?.reported) { steps(w, 200); tk += 200; }
    const p = panamaNow(w);
    ok(!!pts && to >= 0 && !!p?.reported, `Опыт «Панама», зерно ${PANAMA_SEED}: фауны ${f?.north}/${f?.south} (общих ${f?.shared}); перешеек открылся за ${to} тактов; сводка через ${tk}: перешли ${p?.cross.join('/')}, прижились с севера ${p?.fromN}, с юга ${p?.fromS}, вымерли ${p?.lost}`);
    lap('опыт панама', t);
  }
  // «☄️ После астероида»: 2 года → удар K–Pg → итог через год (вымирание, медиана размера) → радиация за 4 года
  {
    const t = Date.now();
    const L = LESSONS.find((x) => x.id === 'kpg');
    const ids = new Set(allCards().map((c) => c.id));
    ok(!!L && L.cards.every((id) => ids.has(id)), `После астероида: урок есть, карточки на месте`);
    Math.random = mulberry32(KPG_SEED * 7919 + 1);
    const w = new World(3200, 2000);
    w.settings.livePlanet = true;
    w.reset('rules', KPG_SEED, { ...EARTH_ENV });
    steps(w, 2 * YEAR);
    const [x, y] = kpgSpot(w);
    const t0 = w.tick;
    w.apply({ t: w.tick, k: 'impact', x, y, size: 3 });
    let tk = 0;
    while (tk < 2 * YEAR && !kpgNow(w, t0)?.sum) { steps(w, 200); tk += 200; }
    const s = kpgNow(w, t0)?.sum;
    let tr = 0;
    while (tr < 4 * YEAR && !kpgNow(w, t0)?.rad) { steps(w, 600); tr += 600; }
    const k = kpgNow(w, t0);
    ok(!!s && s.k * 2 >= s.N, `После астероида, зерно ${KPG_SEED}: итог через ${tk} тактов — исчезло ${s?.k}/${s?.N} видов, медиана травоядных ${s?.m0.toFixed(2)} → ${s?.m1.toFixed(2)}; массовое вымирание ${k?.mass ? 'да' : 'нет'}; радиация ${k?.rad ? `через ${tr}` : 'нет'} (не обязательна: шаг урока с giveUp)`);
    lap('после астероида', t);
  }
  // «🏜 Дождевая тень»: год → хребет на западе → за ним суше (≥ 30 %) → плита на север (×4) → горы на шве и мост через Уоллеса
  {
    const t = Date.now();
    const L = LESSONS.find((x) => x.id === 'shadow');
    const ids = new Set(allCards().map((c) => c.id));
    ok(!!L && L.cards.every((id) => ids.has(id)), `Дождевая тень: урок есть, карточки на месте`);
    Math.random = mulberry32(SHADOW_SEED * 7919 + 3);
    const w = new World(3200, 2000);
    w.settings.livePlanet = true;
    w.reset('rules', SHADOW_SEED, { ...EARTH_ENV });
    steps(w, YEAR);
    const R = shadowLine(w);
    w.apply({ t: w.tick, k: 'ridge', pts: R.pts });
    steps(w, YEAR / 2);
    const s1 = shadowNow(w, R.x, R.y0, R.y1)!;
    w.apply({ t: w.tick, k: 'geoSpeed', v: 4 });
    w.apply({ t: w.tick, k: 'drift', vx: 0, vy: -1 });
    let tk = 0;
    while (tk < 3 * YEAR && !(shadowNow(w, R.x, R.y0, R.y1)?.plate?.mtn && shadowNow(w, R.x, R.y0, R.y1)?.wallOpen)) { steps(w, 200); tk += 200; }
    const s2 = shadowNow(w, R.x, R.y0, R.y1)!;
    ok(s1.lee >= 0.3 && !!s2.plate?.mtn && s2.wallOpen, `Дождевая тень, зерно ${SHADOW_SEED}: хребет x=${R.x}, за ним суше на ${Math.round(100 * s1.lee)}% (${s1.n} клеток, леса ${s1.forest}); плита на север: горы ${s2.plate?.mtn ? 'да' : 'нет'}, пролив Уоллеса закрыт ${s2.wallOpen ? 'да' : 'нет'} через ${tk} тактов (сдвиг ${s2.plate?.oy})`);
    lap('дождевая тень', t);
  }
}
console.log(`\n${failed ? `✗ Провалено проверок: ${failed}` : '✓ Все проверки пройдены'} · ${((Date.now() - t0) / 1000).toFixed(0)} с`);
process.exit(failed ? 1 : 0);
