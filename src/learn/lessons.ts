import { pct } from '../planet/mcView';
import { EARTH, PRESETS, simulate, type PlanetParams, type Sample } from '../planet/model';
import { fmtAge } from '../planet/planetView';
import { wilson } from '../planet/stats';
import { EARTH_ENV, YEAR, type SurfaceEnv } from '../sim/world';
import type { Lesson, LessonCtx, Step } from './engine';
import { decomposerSwitch, diseaseModel, fluxOrbit, gauseGoal, guilds, landMean, MARS, MARS_RD, sickNow, soilFields } from './scenarios';

// ---------------- помощники ----------------

const S = (c: LessonCtx) => c.planet.snapshot();
const passed = (c: LessonCtx, id: string, match?: string) => {
  const s = S(c);
  return s.result.events.find((e) => e.id === id && e.t <= s.now && (!match || e.text.includes(match)));
};
const sampleNear = (c: LessonCtx, t: number): Sample => {
  const r = S(c).result;
  const i = Math.max(0, Math.min(r.samples.length - 1, Math.round((t / r.end) * (r.samples.length - 1))));
  return r.samples[i];
};
const C = (k: number) => {
  const v = Math.round(k - 273);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} °C`;
};
const bar = (p: number) => p.toFixed(p < 0.01 ? 3 : 2).replace('.', ',');
const n1 = (x: number) => x.toFixed(1).replace('.', ',');
const n2 = (x: number) => x.toFixed(2).replace('.', ',');
const num = (c: LessonCtx, k: string) => Number(c.mem[k] ?? 0);
const ocean = (s: Sample) => `${Math.round(s.ocean * 100)}%`;

const startPlanet = (c: LessonCtx, p: PlanetParams, speed: 0.1 | 0.3 | 1 = 0.3) => {
  c.planet.open(p, 'realist');
  c.planet.setSpeed(speed);
  c.mem.gen = S(c).gen;
  c.show('planet');
};
const startEco = (c: LessonCtx, env: Partial<SurfaceEnv>, name: string) => {
  c.show('eco');
  c.surface.newWorld({ ...EARTH_ENV, ...env, name }, 42);
  c.surface.changeSpeed(12);
  c.mem.rg = c.world.resetGen;
  c.mem.t0 = c.world.tick;
};
const ticks = (c: LessonCtx) => c.world.tick - num(c, 't0');

/** Живая строка планеты: HUD показывает сумму «🌫», а тут — по отдельности. */
const planetReadout = (c: LessonCtx) => {
  const s = S(c).sample;
  return `${fmtAge(S(c).now)} · Азот ${bar(s.pressure)} бар · CO₂ ${bar(s.co2)} бар · 🌡 ${C(s.T)} · 🌊 ${ocean(s)} воды`;
};
const P = (s: Step): Step => ({ view: 'planet', readout: planetReadout, ...s });

/** Опыт в «10 000 миров»: сначала запуск (иначе вкладка начнёт свой), потом показ. */
const mcRun = async (c: LessonCtx, n: number, preset: keyof typeof PRESETS, silent = false) => {
  const p = c.mc.run({ n, preset, silent });
  c.show('mc');
  return p;
};
const mcHint = (c: LessonCtx) => `Считаем… ${Math.round(c.mc.progress * 100)}%`;

/** Почва и опад (после появления микробов в почве). */
const soilNow = (c: LessonCtx) => {
  const f = soilFields(c.world);
  const h = c.world.history.at(-1);
  return {
    L: f ? landMean(c.world, f.litter) : 0,
    S: f ? landMean(c.world, f.soil) : 0,
    G: h ? h.grass : 0,
    K: c.world.corpses.length,
  };
};

const microLock = (c: LessonCtx) => (decomposerSwitch(c.world) && soilFields(c.world) ? null : '🔒 Появится вместе с микробами в почве');

// ---------------- уроки ----------------

export const LESSONS: Lesson[] = [
  {
    id: 'mars',
    icon: '🧲',
    title: 'Почему у Марса нет атмосферы',
    teaser: 'Уменьшим Землю до размеров Марса и посмотрим, куда денется воздух.',
    minutes: 5,
    cards: ['planet.dynamo', 'planet.tectonics'],
    steps: [
      P({
        checkpoint: true,
        text: 'Марс в 10 раз легче Земли. Когда-то по нему текли реки — их сухие русла видны с орбиты. Сегодня давление там в 160 раз ниже земного. Куда делся воздух? Начнём с Земли.',
        action: { label: '🌍 Открыть Землю', run: (c) => startPlanet(c, EARTH) },
        after: 'В панели справа: «🧲 Магнитное поле угаснет через 8,00 млрд лет». Жидкое железное ядро Земли вращается и работает как динамо-машина. Вокруг планеты — магнитный щит, он отклоняет звёздный ветер.',
      }),
      P({
        checkpoint: true,
        focus: ['dynamo'],
        text: 'Теперь сделаем Землю массой с Марс — 0,11 земной. Солнце, орбита и вода — те же. Меняем одну причину за раз — так работают учёные.',
        action: {
          label: '🔴 Земля массой с Марс',
          run: (c) => {
            startPlanet(c, MARS);
            c.mem.n0 = S(c).result.samples[0].pressure;
          },
        },
        watch: {
          hint: () => 'Смотрите на строку «Азот» в этой панели. Когда выскочит карточка «Магнитный щит», нажмите в ней «Дальше ▶».',
          test: (c) => !!passed(c, 'dynamo') && S(c).now >= 1.5,
          giveUp: { gyr: 3 },
          done: (c) => {
            const s = S(c).sample;
            const tDyn = passed(c, 'dynamo')?.t ?? S(c).result.derived.dynamo;
            const n0 = num(c, 'n0');
            return `Щит погас уже через ${fmtAge(tDyn)} — у Земли его хватит на 8 млрд лет. Без щита звёздный ветер сдувает азот: было ${bar(n0)} бар, сейчас ${bar(s.pressure)}. А заметили, что планета замёрзла почти сразу, ещё со щитом? Маленькая планета с самого начала держит меньше газа (${bar(n0)} бар против 0,8 у Земли), и плиты у неё не двигаются — нет углеродного термостата. Сейчас ${C(s.T)}.`;
          },
        },
      }),
      P({
        checkpoint: true,
        focus: ['dynamo'],
        text: 'Азот уходит медленно: наше Солнце спокойное. Что, если звезда буйная? Поставим ту же планету к красному карлику — в молодости они бьют вспышками и плотным звёздным ветром.',
        action: { label: '⚡ Та же планета у красного карлика', run: (c) => startPlanet(c, MARS_RD) },
        watch: {
          hint: () => 'Следим за азотом и 🌊 водой…',
          test: (c) => {
            const s = S(c).sample;
            return s.pressure < 0.01 && s.ocean <= 0.01;
          },
          onPass: (c) => c.planet.seek(S(c).now, false),
          giveUp: { gyr: 3 },
          done: (c) => {
            const { now, sample: s } = S(c);
            const tDyn = passed(c, 'dynamo')?.t ?? S(c).result.derived.dynamo;
            return `За ${fmtAge(now)} азота почти не осталось — ${bar(s.pressure)} бар, и океаны улетели вслед за ним. Щит здесь погас ещё быстрее, через ${fmtAge(tDyn)}: планета так близко к звезде, что повёрнута к ней одной стороной (приливный захват), а медленное вращение ослабляет динамо. В воздухе остался лишь тонкий слой вулканического CO₂ (${bar(s.co2)} бар) — у настоящего Марса атмосфера тоже на 95% из CO₂.`;
          },
        },
      }),
      {
        text: 'Подведём итог.',
        quiz: {
          q: 'Почему маленькой планете вдвойне труднее сохранить воздух?',
          options: [
            'Ядро быстро остывает — магнитный щит гаснет, а слабая гравитация хуже держит газ',
            'На маленьких планетах не бывает вулканов, поэтому воздуха нет с самого начала',
            'Маленькие планеты всегда дальше от звезды',
          ],
          correct: 0,
          explain: 'Маленькое тело остывает быстрее — как горошина быстрее арбуза. Ядро Марса до сих пор жидкое (это показал зонд InSight), но перестало перемешиваться, и динамо заглохло около 4 млрд лет назад. Зонд MAVEN измерил: солнечный ветер и сейчас уносит с Марса около 100 граммов газа в секунду — за миллиарды лет это почти вся атмосфера. А притяжение Марса — всего 0,38 земного.',
        },
      },
    ],
  },
  {
    id: 'moon',
    icon: '🌙',
    title: 'Без Луны',
    teaser: 'Уберём Луну и проведём опыт на 500 парах близнецов Земли.',
    minutes: 5,
    cards: ['planet.axis', 'stats.experiment'],
    steps: [
      P({
        checkpoint: true,
        focus: ['axis'],
        text: 'Луна огромна — больше четверти диаметра Земли. Её притяжение держит ось Земли: наклон 23,4° меняется лишь примерно на градус. Уберём Луну из той же самой истории.',
        action: {
          label: '🌑 Земля без Луны',
          run: (c) => {
            startPlanet(c, { ...EARTH, moon: 0 }, 1);
            c.mem.tInt = simulate(EARTH, PRESETS.realist.a, false).firstReached[6] ?? -1;
          },
        },
        watch: {
          hint: () => 'Ищем в летописи «Наклон оси скакнул»…',
          test: (c) => !!passed(c, 'axis') || S(c).now >= S(c).result.end - 0.01,
          done: (c) => {
            const e = passed(c, 'axis');
            if (!e) return 'В этот раз обошлось. Но одна история ничего не доказывает — нужен опыт посерьёзнее.';
            const tInt = num(c, 'tInt');
            const late = S(c).result.maxStage < 6 ? 'здесь так и не появился' : 'появился позже';
            return `На ${fmtAge(e.t)} ось резко наклонилась — климат сошёл с ума, и жизнь на суше откатилась назад. А разум, который в истории с Луной появился на ${fmtAge(tInt)}, ${late}.`;
          },
        },
      }),
      {
        checkpoint: true,
        text: 'Одна история — это случай, а не наука. Проведём опыт: 500 пар «близнецов» Земли. У каждой пары одно и то же зерно случайности, но у одной Луна есть, у другой — нет.',
        action: {
          label: '🧪 Запустить 2 × 500 миров',
          clear: ['ok'],
          run: async (c) => {
            const r = await c.twin(EARTH, { moon: 1 }, { moon: 0 }, 500);
            if (!r || !c.alive()) return false;
            const [A, B] = r;
            Object.assign(c.mem, {
              n: A.n, aA: A.reached[4], aB: B.reached[4], lA: A.reached[5], lB: B.reached[5],
              iA: A.reached[6], iB: B.reached[6], axA: A.events.axis ?? 0, axis: B.events.axis ?? 0, ok: true,
            });
          },
        },
        watch: {
          hint: (c) => `Считаем… ${c.live.done ?? 0} из 1000 миров`,
          test: (c) => c.mem.ok === true,
          giveUp: { ms: 60000 },
          done: (c) => {
            const m = (k: string) => num(c, k);
            const x = (a: number, b: number) => n1(a / Math.max(1, b));
            const row = (name: string, a: number, b: number) => `<tr><td>${name}</td><td>${a}</td><td>${b}</td></tr>`;
            return `<table class="l-table"><tr><th></th><th>с Луной</th><th>без Луны</th></tr>${row('🪼 Животные', m('aA'), m('aB'))}${row('🦎 Жизнь на суше', m('lA'), m('lB'))}${row('🧠 Разум', m('iA'), m('iB'))}${row('🌀 Скачки оси', m('axA'), m('axis'))}</table>
            Животные в океане появляются одинаково часто. А вот на суше без Луны жизнь закрепляется в ${x(m('lA'), m('lB'))} раза реже, разум — ${m('iB') ? `в ${x(m('iA'), m('iB'))} раза реже` : 'ни разу'}. Числа разума маленькие, так что случайность велика, — но скачков оси с Луной ${m('axA') ? `было всего ${m('axA')}` : 'не было ни одного'}, а без неё — ${m('axis')}.`;
          },
        },
      },
      {
        view: 'mc',
        text: 'А в «диких» мирах со случайными звёздами? Во вкладке «10 000 миров» посмотрим строку «Крупная луна».',
        action: {
          label: '🎲 Посчитать 10 000 миров',
          clear: ['y'],
          run: async (c) => {
            const s = await mcRun(c, 10000, 'realist');
            if (!s || !c.alive()) return false;
            const f = s.factors['Крупная луна'] ?? {};
            const y = f['Есть'] ?? { n: 0, intel: 0 };
            const no = f['Нет'] ?? { n: 0, intel: 0 };
            Object.assign(c.mem, { yk: y.intel, yn: y.n, nk: no.intel, nn: no.n, y: y.n ? y.intel / y.n : 0 });
          },
        },
        watch: {
          hint: mcHint,
          test: (c) => c.mem.y !== undefined,
          done: (c) => {
            const [yk, yn, nk, nn] = ['yk', 'yn', 'nk', 'nn'].map((k) => num(c, k));
            const ratio = nk && nn && yn ? yk / yn / (nk / nn) : 0;
            return `С крупной луной разум появился в ${pct(yk, yn)} миров, без неё — в ${pct(nk, nn)}. ${nk ? `Разница ×${n1(ratio)}.` : 'Без луны — ни разу.'} Часть разницы — от того, что в модели приливы ещё и помогают зарождению жизни; в опыте с близнецами этого не было: там жизнь зародилась во всех 1000 мирах.`;
          },
        },
      },
      {
        text: 'Что же объясняет разницу?',
        quiz: {
          q: 'Почему без Луны животные появляются так же часто, а разум — намного реже?',
          options: [
            'Разуму нужны сотни миллионов лет спокойного климата, а скачки оси раз за разом отбрасывают сложную жизнь назад',
            'Без приливов животные не могут выйти на сушу',
            'Без лунного света мозг не развивается',
          ],
          correct: 0,
          explain: 'Микробам и морским животным почти всё равно, куда смотрит ось. А крупной жизни на суше нужны долгие спокойные эпохи. Честно: учёные спорят. Расчёты 1993 года пугали наклоном до 85°, а более новые (2012) показали, что без Луны ось «гуляла» бы медленнее — в пределах 10–20° за сотни миллионов лет. Модель — это гипотеза, которую можно проверять.',
        },
      },
    ],
  },
  {
    id: 'snowball',
    icon: '❄️',
    title: 'Земля-снежок',
    teaser: 'Как планета замерзает целиком — и что её спасает.',
    minutes: 4,
    cards: ['planet.snowball', 'planet.thaw', 'planet.faintsun'],
    steps: [
      P({
        checkpoint: true,
        text: 'Около 700 млн лет назад лёд на Земле доходил до экватора. Как планета может замёрзнуть целиком — и как ей потом оттаять? Сделаем солнце на четверть тусклее.',
        action: { label: '🌑 Тусклое солнце (75%)', run: (c) => startPlanet(c, { ...EARTH, orbit: fluxOrbit(0.75) }) },
        watch: {
          hint: () => 'Ждём события «❄️ Планета замёрзла целиком»…',
          test: (c) => !!passed(c, 'snowball', 'целиком') && S(c).sample.ice >= 0.99,
          onPass: (c) => {
            const e = passed(c, 'snowball', 'целиком')!;
            c.mem.tSnow = e.t;
            c.mem.co2Snow = sampleNear(c, e.t).co2;
            c.planet.seek(e.t, false);
            c.planet.showFact('snowball');
          },
          done: (c) => `Замёрзла на ${fmtAge(num(c, 'tSnow'))}! Лёд отражает солнечный свет обратно в космос: больше льда → холоднее → ещё больше льда. Это положительная обратная связь — она сама себя разгоняет. Сейчас ${C(S(c).sample.T)}.`,
        },
      }),
      {
        text: 'Сделайте предсказание, прежде чем смотреть дальше.',
        quiz: {
          q: 'Солнце ярче не стало. Что может растопить лёд?',
          options: [
            'Ничего — планета останется ледяной навсегда',
            'Вулканы: они выбрасывают CO₂, а убрать его подо льдом некому',
            'Лёд растает сам от собственного веса',
          ],
          correct: 1,
          explain: 'Обычно CO₂ из воздуха связывают дожди и камни — это выветривание. Подо льдом дождей нет, а вулканы работают. CO₂ копится, парник крепнет — и лёд сдаётся.',
        },
      },
      P({
        text: 'Проверим предсказание — пусть история идёт дальше.',
        action: { label: '▶ Продолжить историю', run: (c) => c.planet.seek(S(c).now, true) },
        watch: {
          hint: () => 'Следим за 🌡 температурой и CO₂ в этой панели…',
          test: (c) => !!passed(c, 'thaw', 'Вулканический') && S(c).sample.ice < 0.5,
          onPass: (c) => {
            const tThaw = passed(c, 'thaw', 'Вулканический')!.t;
            c.mem.tThaw = tThaw;
            // сколько CO₂ накопилось подо льдом к оттепели
            const r = S(c).result;
            c.mem.co2Max = Math.max(...r.samples.filter((x) => x.t >= num(c, 'tSnow') && x.t <= tThaw).map((x) => x.co2), 0);
            c.planet.seek(S(c).now, false);
            c.planet.showFact('thaw');
          },
          giveUp: { gyr: 6 },
          done: (c) =>
            `Оттаяла через ${fmtAge(num(c, 'tThaw') - num(c, 'tSnow'))}! Подо льдом CO₂ вырос с ${bar(num(c, 'co2Snow'))} до ${bar(num(c, 'co2Max'))} бар — это его парник растопил лёд. А после оттепели дожди и камни снова убрали лишний CO₂: сейчас ${bar(S(c).sample.co2)} бар. После оттепели эволюция в модели ускоряется — так было и на Земле: вскоре после последнего «снежка» появились первые крупные животные. На настоящей Земле снежки длились 15–60 млн лет — здесь дольше, потому что солнце тусклее.`,
        },
      }),
      {
        text: 'Итак, две обратные связи. «Лёд ↔ холод» усиливает любое похолодание. «Вулканы ↔ CO₂ ↔ выветривание» гасит отклонения — это термостат. Планета с работающим углеродным циклом может замёрзнуть, но умеет оттаять.',
      },
    ],
  },
  {
    id: 'venus',
    icon: '🔥',
    title: 'Как становятся Венерой',
    teaser: 'Найдём предел, после которого термостат планеты ломается.',
    minutes: 4,
    cards: ['planet.runaway', 'planet.co2starve', 'planet.tectonics'],
    steps: [
      P({
        checkpoint: true,
        focus: ['co2starve'],
        text: 'Венера почти как Земля по размеру, но на ней +465 °C и давление 92 бара. Она всего на 28% ближе к Солнцу. Где у Земли «запас прочности»? Добавим 25% солнечного тепла.',
        action: { label: '☀️ Солнце ярче на 25%', run: (c) => startPlanet(c, { ...EARTH, orbit: fluxOrbit(1.25) }, 1) },
        watch: {
          hint: () => 'Когда выскочит карточка «Голод растений», нажмите в ней «Дальше ▶».',
          test: (c) => S(c).now >= 4.5,
          onPass: (c) => c.planet.seek(4.5, false),
          done: (c) => {
            const { now, sample: s } = S(c);
            const starve = passed(c, 'co2starve') ? ' В летописи — «CO₂ кончился»: растениям нечем дышать — убирать больше нечего.' : '';
            return `Сначала термостат справлялся: CO₂ уходил в камни, и на 2 млрд лет было около ${C(sampleNear(c, 2).T)}. Но звёзды с возрастом ярчают, и к ${fmtAge(now)} уже ${C(s.T)}, а океаны начали выкипать (${ocean(s)} воды).${starve}`;
          },
        },
      }),
      P({
        checkpoint: true,
        focus: ['runaway'],
        text: 'Ещё жарче: солнце на 40% ярче.',
        action: { label: '🔥 Солнце ярче на 40%', run: (c) => startPlanet(c, { ...EARTH, orbit: fluxOrbit(1.4) }, 1) },
        watch: {
          hint: () => 'Следим за 🌊 водой…',
          test: (c) => S(c).sample.ocean <= 0.01,
          done: (c) =>
            `К ${fmtAge(S(c).now)} океаны выкипели. Водяной пар — тоже парниковый газ: теплее → больше пара → ещё теплее. Это «влажная парниковая катастрофа». Пар поднимается высоко, ультрафиолет разбивает молекулы, лёгкий водород улетает в космос — вода уже не вернётся.`,
        },
      }),
      {
        text: 'Последний вопрос.',
        quiz: {
          q: 'Почему углеродный термостат не спас эту планету?',
          options: [
            'CO₂ почти не осталось, а главным парниковым газом стал водяной пар, которым термостат не управляет',
            'Вулканы перестали работать',
            'Тектоника плит остановилась от жары',
          ],
          correct: 0,
          explain: 'Термостат умеет только убирать CO₂. Когда убирать нечего, а нагрев продолжается, рулит водяной пар. Через ~1 млрд лет Солнце станет на 10% ярче — и Земле грозит та же судьба.',
        },
      },
    ],
  },
  {
    id: 'lln',
    icon: '🎲',
    title: 'Сколько нужно миров?',
    teaser: 'Закон больших чисел и честная неопределённость науки.',
    minutes: 5,
    cards: ['stats.montecarlo', 'stats.confidence'],
    steps: [
      {
        view: 'mc',
        checkpoint: true,
        text: 'Насколько редки животные во Вселенной? Посчитаем 2 000 случайных миров и посмотрим на строку «🪼 Животные» в воронке. В скобках — 95% доверительный интервал: где, скорее всего, лежит настоящая доля.',
        action: {
          label: '🎲 2 000 миров',
          clear: ['w1'],
          run: async (c) => {
            const s = await mcRun(c, 2000, 'realist');
            if (!s || !c.alive()) return false;
            const [lo, hi] = wilson(s.reached[4], s.n);
            Object.assign(c.mem, { k1: s.reached[4], n1: s.n, lo1: lo, hi1: hi, w1: (hi - lo) * 100 });
          },
        },
        watch: {
          hint: mcHint,
          test: (c) => c.mem.w1 !== undefined,
          done: (c) => {
            const n = num(c, 'n1');
            return `Животные: ${pct(num(c, 'k1'), n)} (от ${pct(num(c, 'lo1') * n, n)} до ${pct(num(c, 'hi1') * n, n)}). Ширина интервала — ${n2(num(c, 'w1'))} п.п. (процентного пункта).`;
          },
        },
      },
      {
        text: 'Сделайте предсказание.',
        quiz: {
          q: 'Во сколько раз сузится интервал, если миров станет в 10 раз больше?',
          options: ['В 10 раз', 'Примерно в 3 раза', 'Не изменится'],
          correct: 1,
          explain: 'Погрешность падает как 1/√N, а √10 ≈ 3,2. Чтобы стать точнее в 10 раз, нужно в 100 раз больше опытов — поэтому точные измерения так дороги.',
        },
      },
      {
        view: 'mc',
        text: 'Проверим: в 10 раз больше миров — 20 000.',
        action: {
          label: '🎲 20 000 миров',
          clear: ['w2'],
          run: async (c) => {
            const s = await mcRun(c, 20000, 'realist');
            if (!s || !c.alive()) return false;
            const [lo, hi] = wilson(s.reached[4], s.n);
            c.mem.w2 = (hi - lo) * 100;
          },
        },
        watch: {
          hint: (c) => `${mcHint(c)} (это займёт до полуминуты)`,
          test: (c) => c.mem.w2 !== undefined,
          done: (c) => `Ширина: ${n2(num(c, 'w2'))} п.п. — в ${n1(num(c, 'w1') / Math.max(1e-9, num(c, 'w2')))} раза уже. Закон больших чисел работает.`,
        },
      },
      {
        view: 'mc',
        text: 'Но главная неопределённость — не в числе миров. Никто не знает, как часто случаются «трудные шаги»: зарождение жизни, сложная клетка, разум. Сравним пессимиста и оптимиста.',
        action: {
          label: '😟 Пессимист, потом 😊 оптимист (по 10 000)',
          clear: ['pI', 'oI'],
          run: async (c) => {
            const a = await mcRun(c, 10000, 'pessimist', true);
            if (!a || !c.alive()) return false;
            c.mem.pI = a.reached[6];
            const b = await mcRun(c, 10000, 'optimist', true);
            if (!b || !c.alive()) return false;
            c.mem.oI = b.reached[6];
          },
        },
        watch: {
          hint: (c) => `${c.mem.pI === undefined ? '😟 Пессимист' : '😊 Оптимист'}: ${Math.round(c.mc.progress * 100)}%`,
          test: (c) => c.mem.oI !== undefined,
          done: (c) =>
            `Разум: у пессимиста ${num(c, 'pI')} из 10 000 миров, у оптимиста — ${num(c, 'oI')}. Разница огромная, и никакие миллионы миров её не уберут: это незнание науки, а не случайность. Сузить её могут только наблюдения — поиск жизни на Марсе, Европе, Энцеладе и у других звёзд.`,
        },
      },
    ],
    onExit: () => {
      const sel = document.querySelector<HTMLSelectElement>('#view-mc .mc-preset');
      if (sel && sel.value !== 'realist') sel.value = 'realist';
    },
  },
  {
    id: 'oxygen',
    icon: '🫧',
    title: 'Кислород и размер',
    teaser: 'Почему в древнем воздухе не бывает гигантов.',
    minutes: 5,
    cards: ['surface.oxygen', 'surface.size', 'planet.o2modern'],
    steps: [
      {
        view: 'eco',
        checkpoint: true,
        text: 'Большому телу нужно много кислорода. Проверим, как воздух ограничивает размер. Сначала обычная Земля — 21% кислорода. Запустим на 12× и подождём полтора года.',
        action: { label: '🌍 Земля, O₂ 21%', run: (c) => startEco(c, {}, 'Опыт: O₂ 21%') },
        watch: {
          hint: (c) => `Идёт время… ${ticks(c)}/9000 тактов`,
          test: (c) => ticks(c) >= 9000,
          giveUp: { ticks: 20000 },
          onPass: (c) => {
            const g = guilds(c.world);
            c.mem.max21 = g.maxBorn;
            c.mem.g21 = g.giants;
          },
          done: (c) => `Самое крупное животное — размер ${n1(num(c, 'max21'))}. Гигантов крупнее 8 — ${num(c, 'g21')}. Потолок роста в этом воздухе — ${n1(c.world.maxSize)}.`,
        },
      },
      {
        view: 'eco',
        checkpoint: true,
        text: 'Теперь древний воздух: 8% кислорода, примерно как 550 млн лет назад, когда появлялись первые животные. Тот же ландшафт, те же основатели.',
        action: { label: '🫧 O₂ 8%', run: (c) => startEco(c, { o2: 0.08 }, 'Опыт: O₂ 8%') },
        watch: {
          hint: (c) => `Идёт время… ${ticks(c)}/9000 тактов`,
          test: (c) => ticks(c) >= 9000,
          giveUp: { ticks: 20000 },
          done: (c) => {
            const g = guilds(c.world);
            const was = c.mem.max21 !== undefined ? ` (при 21% было ${n1(num(c, 'max21'))})` : '';
            const wasG = c.mem.g21 !== undefined ? ` (было ${num(c, 'g21')})` : '';
            return `Самое крупное — ${n1(g.maxBorn)}${was}. Гигантов — ${g.giants}${wasG}. Потолок упал до ${n1(c.world.maxSize)}: детёныши уже не вырастают крупнее, а старые гиганты постепенно уходят.`;
          },
        },
      },
      {
        view: 'eco',
        text: 'А если кислорода 35%, как в каменноугольном периоде? Потолок поднимется до 18. Сначала предскажите.',
        quizFirst: true,
        quiz: {
          q: 'Что покажет опыт?',
          options: [
            'Звери быстро станут вдвое крупнее',
            'Почти ничего: потолок выше, но большому телу нужно больше еды, а травы не прибавилось',
            'Все вымрут от избытка кислорода',
          ],
          correct: 1,
          explain: 'Кислород — это разрешение, а не приказ. Эволюция делает зверей крупнее, только если это выгодно. Проверьте сами: подождите полтора года на 12×.',
        },
        action: { label: '🐉 O₂ 35%', run: (c) => startEco(c, { o2: 0.35 }, 'Опыт: O₂ 35%') },
        watch: {
          hint: (c) => `Идёт время… ${ticks(c)}/9000 тактов`,
          test: (c) => ticks(c) >= 9000,
          giveUp: { ticks: 20000 },
          done: (c) => {
            const max = guilds(c.world).maxBorn;
            const max21 = c.mem.max21 !== undefined ? num(c, 'max21') : 10.5;
            const was = c.mem.max21 !== undefined ? ` (при 21% было ${n1(max21)})` : '';
            return `Самое крупное — ${n1(max)}${was}, хотя потолок теперь 18. ${max <= max21 + 0.5 ? 'Как и предсказали: кислород разрешает, но не заставляет.' : 'Звери чуть подросли — но далеко не до потолка: большому телу нужно больше еды.'}`;
          },
        },
      },
      {
        text: '🌍 300 млн лет назад, при 30–35% кислорода, жила стрекоза меганевра с размахом крыльев 70 см. Насекомые дышат трубочками-трахеями без насоса, поэтому особенно зависят от доли кислорода. Недостаток кислорода ограничивает строго, а избыток лишь разрешает — вместе с другими причинами.',
      },
    ],
  },
  {
    id: 'gause',
    icon: '⚖️',
    title: 'Принцип Гаузе',
    teaser: 'Уберём одну нишу и посмотрим, кто исчезнет.',
    minutes: 6,
    cards: ['surface.niche', 'surface.browse', 'surface.size', 'surface.diet'],
    steps: [
      {
        view: 'eco',
        checkpoint: true,
        text: 'В 1934 году биолог Георгий Гаузе посадил в пробирку два вида инфузорий-туфелек с одной едой. Через пару недель остался один вид. Вывод: два вида не могут долго делить одну нишу. В нашем мире у каждой гильдии своя еда: мелкие травоядные едят траву, гиганты — листву, всеядные — ягоды и насекомых, хищники — других. Создадим мир и дадим ему устояться.',
        action: { label: '🌍 Новый мир', run: (c) => startEco(c, {}, 'Опыт Гаузе') },
        watch: {
          hint: (c) => `Ждём, пока сложится сообщество… ${Math.min(ticks(c), 4000)}/4000 · гигантов ${guilds(c.world).giants}`,
          test: (c) => ticks(c) >= 4000 && guilds(c.world).giants >= 10,
          giveUp: { ticks: 8000, text: 'Гигантов в этом мире мало — нажмите «↻ Ещё раз».' },
          onPass: (c) => {
            const g = guilds(c.world);
            Object.assign(c.mem, { g0: g.giants, h0: g.smallHerb, c0: g.carn });
          },
          done: (c) => {
            const g = guilds(c.world);
            return `Гигантов-листоедов: ${g.giants}. Мелких травоядных: ${g.smallHerb}. Всеядных: ${g.omni}. Хищников: ${g.carn}.`;
          },
        },
      },
      {
        text: 'Сначала предсказание.',
        quiz: {
          q: 'Уберём всю листву на 2 года. Гиганты умеют есть и траву. Что будет?',
          options: [
            'Гиганты перейдут на траву и выживут',
            'Гиганты исчезнут: на траве их обгонят мелкие травоядные, которым нужно меньше еды',
            'Ничего не изменится',
          ],
          correct: 1,
          explain: 'Большому телу нужно много энергии. На траве мелкие травоядные эффективнее — ниша «трава» уже занята. Проверим!',
        },
      },
      {
        view: 'eco',
        text: 'Проверим предсказание: уберём листву на 2 года и посмотрим, что станет с гигантами.',
        action: {
          label: '🍂 Убрать листву на 2 года',
          run: (c) => {
            c.show('eco');
            c.world.removeResource('browse', 2 * YEAR);
            c.surface.changeSpeed(12);
            c.mem.tRm = c.world.tick;
            c.mem.t0 = c.world.tick;
          },
        },
        watch: {
          hint: (c) => `Следим за гигантами: ${guilds(c.world).giants} (было ${num(c, 'g0')}) — ждём, пока их станет хотя бы втрое меньше`,
          test: (c) => guilds(c.world).giants <= gauseGoal(num(c, 'g0')),
          giveUp: { ticks: 16000 },
          done: (c) => {
            const g = guilds(c.world);
            const carn = g.carn < num(c, 'c0') * 0.6 ? ` Хищники тоже пострадали: ${g.carn} (было ${num(c, 'c0')}) — им стало некого ловить.` : '';
            const g0 = num(c, 'g0');
            const gone = g.giants <= Math.max(2, g0 * 0.1)
              ? 'Ниша исчезла — и её хозяева вместе с ней.'
              : `Гигантов стало в ${n1(g0 / Math.max(1, g.giants))} раза меньше: без своей ниши они проигрывают мелким травоядным на траве, а уцелевшие держатся на остатках.`;
            return `Гигантов осталось ${g.giants} из ${g0}, а мелких травоядных стало ${g.smallHerb} (было ${num(c, 'h0')}). ${gone}${carn}`;
          },
        },
      },
      {
        view: 'eco',
        text: 'Листва вернётся — но вернутся ли гиганты? Если вид исчез целиком, ниша может долго пустовать, пока её не займут потомки других видов или пришельцы. Можете поселить «🦣 Снежного гиганта» инструментом ➕.',
        action: { label: '🌿 Вернуть листву сейчас', run: (c) => c.world.restoreResource('browse') },
        after: (c) => {
          const g = guilds(c.world);
          return `🌿 Листва снова растёт.${g.giants > 0 ? ' Гиганты могут вернуться только с большой земли — посмотрите летопись.' : ''}`;
        },
      },
      {
        text: 'И главный вопрос.',
        quiz: {
          q: 'Как принцип Гаузе объясняет, почему на Земле так много видов?',
          options: [
            'Каждый вид занимает свою нишу — свою еду, место или время, поэтому они не мешают друг другу',
            'Виды всё время воюют, и побеждают все',
            'Чем больше видов, тем больше еды',
          ],
          correct: 0,
          explain: 'Пять видов лесных певчих птиц в ельниках Америки кормятся на разных ярусах одной ели (Макартур, 1958). Похожие виды расходятся по нишам — и уживаются.',
        },
      },
    ],
    onExit: (c) => c.world.restoreResource('browse'),
  },
  {
    id: 'microbes',
    icon: '🦠',
    title: 'Невидимые дворники',
    teaser: 'Выключим невидимых уборщиков планеты.',
    minutes: 6,
    cards: ['microbes.decomposers', 'microbes.carcass', 'microbes.liebig', 'microbes.nitrogen'],
    locked: microLock,
    readout: (c) => {
      const s = soilNow(c);
      return `🍂 Опад ${n2(s.L)} · 🟫 Почва ${n2(s.S)} · 🌿 Трава ${n2(s.G)} · 💀 Туш ${s.K}`;
    },
    steps: [
      {
        view: 'eco',
        checkpoint: true,
        text: 'Кто убирает мёртвых? Падальщики съедают часть, но основную работу делают невидимки — бактерии и грибы-разложители. Они разбирают туши, опавшие листья и помёт и возвращают азот и фосфор в почву, растениям. В горсти почвы их больше, чем людей на Земле.',
        action: {
          label: '🌍 Новый мир',
          run: (c) => {
            startEco(c, {}, 'Опыт: почва');
            c.surface.showTab('micro');
          },
        },
        watch: {
          hint: (c) => `Ждём равновесия… ${Math.min(ticks(c), 3000)}/3000 тактов`,
          test: (c) => ticks(c) >= 3000,
          onPass: (c) => {
            const s = soilNow(c);
            Object.assign(c.mem, { L0: s.L, S0: s.S, G0: s.G, K0: s.K });
          },
          done: (c) => `Опад: ${n2(num(c, 'L0'))}. Почва: ${n2(num(c, 'S0'))}. Трава: ${n2(num(c, 'G0'))}. Туш на карте: ${num(c, 'K0')}. Это равновесие: сколько падает, столько и разлагается.`,
        },
      },
      {
        text: 'Сначала предсказание.',
        quiz: {
          q: 'Выключим разложителей. Что случится первым?',
          options: ['Опад и туши начнут копиться, а почва — беднеть', 'Животные станут здоровее', 'Трава станет гуще — её никто не ест'],
          correct: 0,
          explain: 'Без разложения питательные вещества остаются запертыми в мёртвом.',
        },
      },
      {
        view: 'eco',
        text: 'Выключим бактерии и грибы почвы — только их. Азотфиксаторы и выветривание камней продолжат работать.',
        action: {
          label: '🧫 Выключить разложителей',
          run: (c) => {
            const sw = decomposerSwitch(c.world);
            if (!sw) throw new Error('в этом мире нет микробов почвы');
            sw.noDecomposers = true;
            c.world.log('🧫 Опыт: бактерии и грибы почвы выключены', 'disaster');
            c.mem.tOff = c.world.tick;
            c.mem.t0 = c.world.tick;
          },
        },
        watch: {
          hint: (c) => {
            const s = soilNow(c);
            return `Опад ${n2(s.L)} / было ${n2(num(c, 'L0'))}, почва ${n2(s.S)} / было ${n2(num(c, 'S0'))}…`;
          },
          test: (c) => {
            const s = soilNow(c);
            return s.L >= num(c, 'L0') * 1.5 && s.S <= num(c, 'S0') * 0.85;
          },
          giveUp: { ticks: 12000 },
          done: (c) => {
            const s = soilNow(c);
            const k = s.K > num(c, 'K0') * 1.2 ? ` Туш стало ${s.K}: их разлагают только жуки и солнце.` : '';
            return `Опад вырос в ${n1(s.L / Math.max(1e-9, num(c, 'L0')))} раза — лежит и не гниёт. Почва обеднела: ${n2(s.S)} (было ${n2(num(c, 'S0'))}), трава — ${n2(s.G)} (было ${n2(num(c, 'G0'))}).${k} Падальщики пируют, а травоядным всё труднее.`;
          },
        },
      },
      {
        view: 'eco',
        text: 'Вернём разложителей и посмотрим, восстановится ли круговорот.',
        action: {
          label: '🧫 Вернуть разложителей',
          run: (c) => {
            const sw = decomposerSwitch(c.world);
            if (sw) sw.noDecomposers = false;
            c.mem.t0 = c.world.tick;
          },
        },
        watch: {
          hint: (c) => {
            const s = soilNow(c);
            return `Опад ${n2(s.L)}, почва ${n2(s.S)} — ждём, когда вернутся к прежним…`;
          },
          test: (c) => {
            const s = soilNow(c);
            return s.L <= num(c, 'L0') * 1.2 && s.S >= num(c, 'S0') * 0.95;
          },
          giveUp: { ticks: 12000 },
          done: () => 'Круговорот снова замкнулся: опад разлагается, почва богатеет, трава возвращается. Заметьте: азотфиксаторы весь опыт работали — без них почва обеднела бы ещё сильнее.',
        },
      },
      {
        text: 'Итог.',
        quiz: {
          q: 'Почему без микробов жизнь на планете быстро остановилась бы?',
          options: [
            'Азот, фосфор и углерод остались бы запертыми в мёртвых телах — новым растениям не из чего было бы расти',
            'Без микробов в воздухе не было бы кислорода',
            'Животные не могут дышать без бактерий в лёгких',
          ],
          correct: 0,
          explain: 'Жизнь — это круговорот: одни и те же атомы переходят из растения в зверя, из зверя в почву и снова в растение. Разложители замыкают круг. (Второй вариант наполовину верен: кислород в воздухе когда-то накопили микробы-цианобактерии — см. «Великое кислородное событие».)',
        },
      },
    ],
    onExit: (c) => {
      const sw = decomposerSwitch(c.world);
      if (sw) sw.noDecomposers = false;
    },
  },
  {
    id: 'epidemic',
    icon: '🤒',
    title: 'Как растёт эпидемия',
    teaser: 'Почему волна болезни сначала растёт, а потом сама спадает.',
    minutes: 5,
    cards: ['microbes.sir', 'microbes.r0', 'microbes.virulence'],
    locked: (c) => (diseaseModel(c.world) && sickNow(c.world) !== null ? null : '🔒 Появится вместе с микробами-возбудителями'),
    readout: (c) => `🤒 Больных сейчас: ${sickNow(c.world) ?? 0}`,
    steps: [
      {
        view: 'eco',
        checkpoint: true,
        text: 'Болезни тоже живые: это микробы и вирусы, которые переходят от хозяина к хозяину. Создадим мир и дадим ему устояться.',
        action: { label: '🌍 Новый мир', run: (c) => startEco(c, {}, 'Опыт: эпидемия') },
        watch: {
          hint: (c) => `Ждём… ${Math.min(ticks(c), 3000)}/3000 тактов`,
          test: (c) => ticks(c) >= 3000,
          onPass: (c) => {
            const top = c.world.species.living()[0];
            if (top) Object.assign(c.mem, { top: top.id, topName: top.name, n0: top.count });
          },
          done: (c) => `Самый многочисленный вид — «${String(c.mem.topName ?? '?')}», ${num(c, 'n0')} особей.`,
        },
      },
      {
        text: 'Предскажите.',
        quiz: {
          q: 'Заразим 12% самого многочисленного вида новой болезнью. Как будет меняться число больных?',
          options: ['Расти без конца, пока все не вымрут', 'Сначала быстро расти, потом спадать — когда переболевших станет много', 'Сразу пойдёт на спад'],
          correct: 1,
          explain: 'Сначала каждый больной заражает нескольких здоровых, и волна растёт. Но переболевшие получают иммунитет, и заражать становится некого.',
        },
      },
      {
        view: 'eco',
        text: 'Запускаем болезнь. Смотрите на число больных.',
        action: {
          label: '🦠 Запустить болезнь',
          clear: ['peak'],
          run: (c) => {
            const top = c.world.species.living()[0];
            c.mem.n0 = top?.count ?? 0;
            c.mem.top = top?.id ?? -1;
            c.mem.topName = top?.name ?? '?';
            c.world.epidemic();
            c.mem.tStart = c.world.tick;
            c.mem.t0 = c.world.tick;
            c.mem.peak = 0;
          },
        },
        watch: {
          hint: (c) => {
            const now = sickNow(c.world) ?? 0;
            c.mem.peak = Math.max(num(c, 'peak'), now);
            return `Больных: ${now} · пик пока ${num(c, 'peak')}`;
          },
          test: (c) => {
            const now = sickNow(c.world) ?? 0;
            const peak = Math.max(num(c, 'peak'), now);
            c.mem.peak = peak;
            return peak > 0 && now <= 0.2 * peak && c.world.tick > num(c, 'tStart') + 1500;
          },
          giveUp: { ticks: 15000 },
          done: (c) => {
            const sp = c.world.species.all.get(num(c, 'top'));
            const n = sp?.count ?? 0;
            const n0 = num(c, 'n0');
            const lost = n0 ? Math.max(0, Math.round((1 - n / n0) * 100)) : 0;
            return `Пик — ${num(c, 'peak')} больных, потом волна спала: у переболевших появился иммунитет, и болезни стало некого заражать. Вид потерял ${lost}%.`;
          },
        },
      },
      {
        text: 'Итог.',
        quiz: {
          q: 'Почему волна спадает, хотя переболели не все?',
          options: [
            'Когда переболевших с иммунитетом много, каждый больной успевает заразить меньше одного здорового',
            'Микробы устают и перестают размножаться',
            'Больные сами уходят подальше от здоровых',
          ],
          correct: 0,
          explain: 'Пока каждый больной заражает в среднем больше одного (R больше 1), эпидемия растёт. Когда восприимчивых мало, R падает ниже 1 — и волна гаснет. Это коллективный иммунитет. На нём основана вакцинация: если привиты 95% людей, корь не может разгореться.',
        },
      },
    ],
  },
];
