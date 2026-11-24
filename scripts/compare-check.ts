// Проверка «Сравнения миров»: Марс, Венера и Земля в модели похожи на настоящие,
// а история Земли до 7 млрд лет не изменилась (хэши образцов старой модели — earth-fixture.json).
// npm run check:worlds            — быстрые проверки
// npm run check:worlds -- --mc    — плюс Монте-Карло на 20 000 миров
import { createHash } from 'node:crypto';
import fixture from './earth-fixture.json';
import { EARTH, PRESETS, randomPlanet, simulate, type PlanetParams, type SimResult } from '../src/planet/model';
import { MARS, VENUS, TODAY, WHATIFS, applyWhatIf, sampleAt, outcomeText } from '../src/compare/worlds';

let fails = 0;
const ok = (cond: boolean, what: string) => {
  if (!cond) {
    fails++;
    console.log('  ✗', what);
  }
};
const A = PRESETS.realist.a;
const P = (r: SimResult, t = TODAY) => sampleAt(r, t).pressure + sampleAt(r, t).co2;
const C = (r: SimResult, t = TODAY) => sampleAt(r, t).T - 273;
const evAt = (r: SimResult, id: string) => r.events.find((e) => e.id === id)?.t ?? Infinity;

const seeds = Array.from({ length: 20 }, (_, i) => (i === 0 ? 4946 : i * 97));
for (const seed of seeds) {
  const m = simulate({ ...MARS, seed }, A, true);
  const ms = sampleAt(m, TODAY);
  ok(P(m) < 0.02 && C(m) < -40 && ms.ice <= 0.2 && ms.ocean * m.params.water > 0.03 && m.maxStage === 0, `Марс #${seed}: P=${P(m)} T=${C(m)} ice=${ms.ice}`);
  ok(evAt(m, 'dynamo') < 0.5 && evAt(m, 'atmoloss') < 1.5, `Марс #${seed}: dynamo ${evAt(m, 'dynamo')}, atmoloss ${evAt(m, 'atmoloss')}`);

  const v = simulate({ ...VENUS, seed }, A, true);
  const tr = evAt(v, 'runaway');
  ok(tr < 2.5 && evAt(v, 'carbonates') < Infinity, `Венера #${seed}: runaway ${tr}`);
  ok(sampleAt(v, TODAY).ocean === 0 && C(v) > 350 && C(v) < 500 && P(v) > 50 && P(v) < 120, `Венера #${seed}: T=${C(v)} P=${P(v)}`);
  let drop = 0;
  for (let i = 1; i < v.samples.length; i++) if (v.samples[i].t > tr && v.samples[i].t < 9) drop = Math.max(drop, v.samples[i - 1].T - v.samples[i].T);
  ok(drop <= 10, `Венера #${seed}: после выкипания остыла на ${drop.toFixed(1)} K за шаг`);

  const e = simulate({ ...EARTH, seed }, A, true);
  const hash = createHash('sha1').update(JSON.stringify(e.samples.filter((s) => s.t <= 7))).digest('hex');
  ok(hash === (fixture as Record<string, string>)[seed], `Земля #${seed}: история до 7 млрд лет изменилась`);
}
const e = simulate(EARTH, A, true);
ok(C(e) > 0 && C(e) < 30 && P(e) > 0.7 && P(e) < 1.1 && sampleAt(e, TODAY).ocean > 0.5 && e.habitableTime > 8, `Земля: T=${C(e)} P=${P(e)} hab=${e.habitableTime}`);
ok(e.maxStage === 7, `Земля: maxStage ${e.maxStage}`);
ok(evAt(e, 'runaway') < 10, `Земля: runaway ${evAt(e, 'runaway')}`);

const wi = (key: string) => simulate(applyWhatIf(WHATIFS.find((w) => w.key === key)!).params, A, true);
ok(sampleAt(wi('venus1'), TODAY).ocean > 0.5, 'Венера на 1 а.е.: должен остаться океан');
ok(P(wi('mars1')) < 0.02, 'Марс на 1 а.е.: воздух должен улететь');
ok(P(wi('marsbig')) > 0.5, 'Большой Марс: воздух должен удержаться');

console.log('Итоги «Что если…» (к 4,57 млрд лет):');
for (const w of WHATIFS) {
  const o = outcomeText(wi(w.key));
  console.log(`  ${w.label}: ${o.now}${o.story ? ' — ' + o.story : ''}`);
}

if (process.argv.includes('--mc')) {
  const N = 20000;
  const reached = new Array(8).fill(0);
  let hab = 0;
  for (let i = 0; i < N; i++) {
    const r = simulate(randomPlanet(12345 + i) as PlanetParams, A, false);
    for (let k = 1; k <= r.maxStage; k++) reached[k]++;
    if (r.habitableTime >= 0.1) hab++;
  }
  const pct = (v: number) => (v / N) * 100;
  console.log(`Монте-Карло (умеренный, ${N}): жизнь ${pct(reached[1]).toFixed(2)}%, разум ${pct(reached[6]).toFixed(2)}%, технологии ${pct(reached[7]).toFixed(2)}%, вода ${pct(hab).toFixed(1)}%`);
  ok(Math.abs(pct(reached[1]) - 37) <= 2, 'MC: жизнь вне 37 ± 2%');
  ok(Math.abs(pct(reached[6]) - 0.43) <= 0.1, 'MC: разум вне 0,43 ± 0,1%');
  ok(Math.abs(pct(reached[7]) - 0.1) <= 0.1, 'MC: технологии вне 0,10 ± 0,1%');
  ok(Math.abs(pct(hab) - 48.6) <= 2, 'MC: вода вне 48,6 ± 2%');
}

console.log(fails ? `❌ Провалено проверок: ${fails}` : '✅ Все проверки пройдены');
process.exit(fails ? 1 : 0);
