/**
 * Модель истории планеты за миллиарды лет.
 *
 * Физика — упрощённая, но настоящая: светимость звезды растёт со временем,
 * температура считается из энергетического баланса и парникового эффекта,
 * углеродно-силикатный цикл работает как термостат (если есть тектоника),
 * без магнитного поля атмосфера сдувается, кислород копится только когда
 * фотосинтез перевешивает «стоки», озон закрывает сушу от ультрафиолета.
 *
 * Биология — модель «трудных шагов»: каждый следующий шаг жизни случаен,
 * его частота зависит от условий и от допущений (их задаёт пользователь),
 * а катастрофы отбрасывают жизнь назад.
 */
import { clamp, gauss, mulberry32 } from '../lib/random';

// ---------------- допущения ----------------

/** Частоты «трудных шагов», раз в миллиард лет при подходящих условиях. */
export interface Assumptions {
  abiogenesis: number;
  photosynthesis: number;
  eukaryotes: number;
  multicellular: number;
  land: number;
  intelligence: number;
  technology: number;
}

export const PRESETS: Record<'pessimist' | 'realist' | 'optimist', { name: string; a: Assumptions }> = {
  pessimist: {
    name: 'Пессимист («редкая Земля»)',
    a: { abiogenesis: 0.03, photosynthesis: 0.3, eukaryotes: 0.08, multicellular: 0.2, land: 1, intelligence: 0.04, technology: 0.3 },
  },
  realist: {
    name: 'Умеренный',
    a: { abiogenesis: 1, photosynthesis: 1, eukaryotes: 0.35, multicellular: 0.6, land: 3, intelligence: 0.25, technology: 2 },
  },
  optimist: {
    name: 'Оптимист',
    a: { abiogenesis: 10, photosynthesis: 3, eukaryotes: 1.5, multicellular: 2, land: 6, intelligence: 1.5, technology: 6 },
  },
};

export const STEP_INFO: { key: keyof Assumptions; label: string; icon: string; hint: string }[] = [
  { key: 'abiogenesis', label: 'Зарождение жизни', icon: '🧪', hint: 'Химия → первые клетки. Нужна жидкая вода.' },
  { key: 'photosynthesis', label: 'Фотосинтез', icon: '🌿', hint: 'Клетки учатся есть свет и выделять кислород.' },
  { key: 'eukaryotes', label: 'Сложные клетки', icon: '🦠', hint: 'Ядро и митохондрии. Нужен хоть немного кислорода.' },
  { key: 'multicellular', label: 'Животные', icon: '🪼', hint: 'Многоклеточные. Нужно ≥2% кислорода.' },
  { key: 'land', label: 'Выход на сушу', icon: '🦎', hint: 'Нужны суша и озоновый слой.' },
  { key: 'intelligence', label: 'Разум', icon: '🧠', hint: 'Большой мозг: нужен кислород и стабильный климат.' },
  { key: 'technology', label: 'Технологии', icon: '📡', hint: 'Огонь и металл: суша и O₂ ≥ 16%.' },
];

// ---------------- параметры планеты ----------------

export interface PlanetParams {
  seed: number;
  /** Масса звезды в массах Солнца. */
  starMass: number;
  /** Большая полуось орбиты, а.е. */
  orbit: number;
  ecc: number;
  /** Масса планеты в массах Земли. */
  mass: number;
  /** Вода в «земных океанах». */
  water: number;
  /** Масса крупного спутника относительно Луны (0 — нет). */
  moon: number;
  /** Газовый гигант-«щит» на внешней орбите. */
  giant: boolean;
  /** Начальное давление азота, бар. */
  nitrogen: number;
  /** Тектоника плит: null — решить случайно по массе и воде. */
  tectonics: boolean | null;
}

/** seed подобран так, чтобы история шла похоже на настоящую Землю. «Переиграть» покажет другие варианты. */
export const EARTH: PlanetParams = {
  seed: 4946,
  starMass: 1,
  orbit: 1,
  ecc: 0.017,
  mass: 1,
  water: 1,
  moon: 1,
  giant: true,
  nitrogen: 0.8,
  tectonics: true,
};

export type StarClass = 'M' | 'K' | 'G' | 'F';

export function starClass(m: number): StarClass {
  return m < 0.6 ? 'M' : m < 0.85 ? 'K' : m < 1.1 ? 'G' : 'F';
}

export const STAR_INFO: Record<StarClass, { name: string; color: string }> = {
  M: { name: 'Красный карлик', color: '#ff8a5c' },
  K: { name: 'Оранжевый карлик', color: '#ffc27a' },
  G: { name: 'Жёлтый карлик (как Солнце)', color: '#fff1c4' },
  F: { name: 'Жёлто-белая звезда', color: '#f4f6ff' },
};

/** Случайная скалистая планета у случайной звезды — примерно как в реальной Галактике. */
export function randomPlanet(seed: number): PlanetParams {
  const r = mulberry32(seed);
  // звёзд малой массы гораздо больше (функция масс Крупы)
  const u = r();
  const starMass = u < 0.7 ? 0.1 + r() * 0.5 : u < 0.86 ? 0.6 + r() * 0.25 : u < 0.95 ? 0.85 + r() * 0.25 : 1.1 + r() * 0.4;
  const L0 = luminosity0(starMass);
  const logU = (a: number, b: number) => Math.exp(Math.log(a) + r() * (Math.log(b) - Math.log(a)));
  return {
    seed,
    starMass,
    // орбиты вокруг зоны обитаемости: поток от ¼ до 4 земных
    orbit: Math.sqrt(L0 / 0.75) * logU(0.55, 1.9),
    ecc: Math.min(0.6, Math.abs(gauss(r)) * 0.1),
    mass: logU(0.1, 5),
    water: logU(0.01, 30),
    moon: r() < 0.2 ? 0.4 + r() * 1.6 : 0,
    giant: r() < 0.4,
    nitrogen: logU(0.2, 3),
    tectonics: null,
  };
}

// ---------------- физика звезды и планеты ----------------

/** Светимость звезды в начале жизни (в солнечных). Солнце было на ~28% тусклее. */
export function luminosity0(m: number): number {
  return 0.72 * (m < 0.43 ? 0.23 * Math.pow(m, 2.3) : Math.pow(m, 4));
}

/** Время жизни на главной последовательности, млрд лет. */
export function starLifetime(m: number): number {
  return 10 * Math.pow(m, -2.5);
}

export function starTemp(m: number): number {
  return 5778 * Math.pow(m, 0.54);
}

export interface Derived {
  radius: number;
  gravity: number;
  tectonics: boolean;
  /** Сколько млрд лет работает магнитное динамо. */
  dynamo: number;
  tidalLock: boolean;
  land: number;
  starClass: StarClass;
  lifetime: number;
  teff: number;
}

export function derive(p: PlanetParams): Derived {
  const r = mulberry32(p.seed ^ 0x5bd1e995);
  const radius = Math.pow(p.mass, 0.27);
  const gravity = p.mass / (radius * radius);
  // тектоника: нужна вода (смазка) и подходящая масса — малые планеты быстро остывают
  const tectChance = p.water < 0.03 ? 0.05 : p.mass < 0.3 ? 0.1 : p.mass < 0.5 ? 0.4 : p.mass <= 3 ? 0.85 : 0.5;
  const tectonics = p.tectonics ?? r() < tectChance;
  // приливный захват: у красных карликов зона обитаемости очень близко
  const tidalLock = p.orbit < 0.45 * Math.cbrt(p.starMass) && p.starMass < 0.8;
  // динамо: большим планетам дольше, медленное вращение (захват) — слабее
  const dynamo = 8 * Math.pow(p.mass, 1.5) * (tidalLock ? 0.3 : 1) * (tectonics ? 1 : 0.5);
  // суша: при большом количестве воды — океанический мир
  let land = clamp(1 - 0.71 * Math.sqrt(p.water), 0, 1);
  if (!tectonics) land = clamp(land + 0.1, 0, 1);
  return {
    radius,
    gravity,
    tectonics,
    dynamo,
    tidalLock,
    land,
    starClass: starClass(p.starMass),
    lifetime: starLifetime(p.starMass),
    teff: starTemp(p.starMass),
  };
}

// ---------------- симуляция ----------------

export interface Sample {
  t: number;
  /** Температура поверхности, K. */
  T: number;
  co2: number;
  o2: number;
  pressure: number;
  ocean: number;
  ice: number;
  flux: number;
  stage: number;
  ozone: number;
  habitable: boolean;
}

export interface PlanetEvent {
  t: number;
  kind: 'life' | 'impact' | 'climate' | 'extinction' | 'star' | 'atmo' | 'info';
  text: string;
  /** Ключ научной справки (см. facts.ts). */
  id: string;
}

export interface SimResult {
  params: PlanetParams;
  derived: Derived;
  /** Время достижения каждого шага (млрд лет) — в последний раз, когда шаг был достигнут. */
  firstReached: (number | null)[];
  maxStage: number;
  /** Сколько млрд лет на планете была жидкая вода. */
  habitableTime: number;
  end: number;
  endReason: string;
  samples: Sample[];
  events: PlanetEvent[];
  extinctions: number;
  /** Причины откатов жизни назад. */
  setbacks: string[];
}

const DT = 0.01; // 10 млн лет
export const MAX_AGE = 12;
export const STAGE_NAMES = ['Мёртвая', 'Микробы', 'Фотосинтез', 'Сложные клетки', 'Животные в океане', 'Жизнь на суше', 'Разум', 'Технологии'];

export function simulate(p: PlanetParams, a: Assumptions, record = true): SimResult {
  const rand = mulberry32(p.seed);
  const d = derive(p);
  const L0 = luminosity0(p.starMass);
  const events: PlanetEvent[] = [];
  const samples: Sample[] = [];
  const firstReached: (number | null)[] = new Array(8).fill(null);
  const ev = (t: number, kind: PlanetEvent['kind'], text: string, id = '') => events.push({ t, kind, text, id });

  // состояние
  let pressure = p.nitrogen * Math.sqrt(p.mass); // бар
  let co2 = 0.05;
  let ocean = p.water > 0.01 ? 1 : 0;
  let o2 = 0;
  let ozone = 0;
  let stage = 0;
  let snowball = 0; // тиков до конца «снежка», если запущен случайно
  let physSnowball = false;
  let T = 288;
  let ice = 0;
  let habitableTime = 0;
  let weatherFactor = 1;
  let extinctions = 0;
  const setbacks: string[] = [];
  let boost = 0; // ускорение эволюции после глобального оледенения
  let lastExtinction = -1;
  let endReason = 'Звезде ещё жить и жить — история продолжается';
  let wasHabitable = false;
  let dynamoLost = false;

  const end = Math.min(MAX_AGE, d.lifetime);
  const V0 = 20; // вулканический CO₂, бар/млрд лет (масштаб модели)
  const kW = 11.15; // калибровка: Земля сегодня — 288 K при 400 ppm

  const stageUp = (t: number, s: number) => {
    stage = s;
    if (firstReached[s] === null) firstReached[s] = t;
    const info = STEP_INFO[s - 1];
    ev(t, 'life', `${info.icon} ${info.label}`, info.key);
  };
  const setback = (t: number, to: number, why: string, id = 'extinction') => {
    if (stage <= to) return;
    const lost = STAGE_NAMES[stage];
    stage = to;
    extinctions++;
    setbacks.push(why);
    lastExtinction = t;
    ev(t, 'extinction', `💀 ${why}: ${lost.toLowerCase()} → ${STAGE_NAMES[to].toLowerCase()}`, id);
  };

  for (let step = 0; ; step++) {
    const t = step * DT;
    if (t >= end) {
      endReason = d.lifetime <= MAX_AGE ? 'Звезда превратилась в красного гиганта и поглотила планету' : 'Прошло 12 млрд лет — почти возраст Вселенной';
      if (d.lifetime <= MAX_AGE) ev(t, 'star', '🔴 Звезда раздувается в красного гиганта. Конец.', 'redgiant');
      break;
    }

    // --- звезда ---
    const L = L0 * (1 + 0.9 * Math.pow(t / d.lifetime, 1.2));
    const S = L / (p.orbit * p.orbit) / Math.sqrt(1 - p.ecc * p.ecc);
    // активность красных карликов: вспышки, жёсткий ультрафиолет, звёздный ветер
    const activity = p.starMass < 0.6 ? ((0.6 - p.starMass) / 0.5) * Math.exp(-t / 2) * 3 + 0.2 : 0.15 * Math.exp(-t / 1);

    // --- магнитное поле и потеря атмосферы ---
    const field = t < d.dynamo;
    if (!field && !dynamoLost) {
      dynamoLost = true;
      ev(t, 'atmo', '🧲 Ядро остыло — магнитное поле исчезло. Звёздный ветер сдувает атмосферу.', 'dynamo');
    }
    const strip = (field ? 0.02 : 0.6) * activity * (0.5 + S * 0.5) / d.gravity;
    pressure = Math.max(0, pressure - strip * pressure * DT * 3);
    if (!field) ocean = Math.max(0, ocean - 0.15 * DT * activity / d.gravity);
    if (pressure < 0.005 && ocean > 0) ocean = Math.max(0, ocean - 0.5 * DT);

    // --- геология ---
    if (step % 10 === 0) weatherFactor = Math.exp(gauss(rand) * 0.3);
    const outgas = V0 * Math.exp(-t / 4) * Math.sqrt(p.mass) * (d.tectonics ? 1 : 0.3);
    const landEff = Math.sqrt(d.land + 0.05);
    const plants = stage >= 5 ? 1.6 : 1;

    const climate = (pco2: number, iceFrac: number) => {
      const albedo = 0.3 + 0.32 * iceFrac;
      const teq = 255 * Math.pow((S * (1 - albedo)) / 0.7, 0.25);
      const pf = Math.pow(clamp(pressure + pco2, 0.01, 50), 0.35);
      let gh = (33 + 4.33 * Math.log(Math.max(pco2, 1e-7) / 4e-4)) * pf;
      if (stage >= 1 && o2 < 0.001) gh += 8; // метан от древних микробов грел раннюю Землю
      if (ocean <= 0.01) gh *= 0.6; // без водяного пара парник слабее
      // влажная парниковая катастрофа: при сильном нагреве водяной пар разгоняет сам себя
      else if (S > 1.06) gh += (S - 1.06) * 400;
      return teq + Math.max(0, gh);
    };
    const weathering = (temp: number, pco2: number) =>
      kW * landEff * Math.exp((temp - 288) / 13) * Math.pow(pco2 / 4e-4, 0.3) * (d.tectonics ? 1 : 0.15) * plants * weatherFactor;

    // --- климат: термостат углеродного цикла ---
    if (ocean > 0.01 && !physSnowball && snowball <= 0) {
      // ищем такой CO₂, при котором выветривание = вулканы
      let lo = -7;
      let hi = 2;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        const pc = Math.pow(10, mid);
        const temp = climate(pc, ice);
        if (weathering(temp, pc) > outgas) hi = mid;
        else lo = mid;
      }
      const target = Math.pow(10, (lo + hi) / 2);
      // без тектоники цикл медленный — CO₂ лишь подтягивается к равновесию
      co2 = d.tectonics ? target : co2 + (target - co2) * 0.05;
    } else {
      // нет воды или всё подо льдом — выветривания нет, CO₂ копится
      co2 += outgas * DT * 0.02;
    }
    co2 = clamp(co2, 1e-6, 100);
    T = climate(co2, ice);
    // лёд
    const iceTarget = clamp((278 - T) / 25, 0, 1);
    ice += (iceTarget - ice) * 0.5;
    T = climate(co2, ice);

    // глобальное оледенение (физическое): слишком холодно, лёд отражает свет
    if (!physSnowball && ocean > 0.01 && T < 255) {
      physSnowball = true;
      ice = 1;
      ev(t, 'climate', '❄️ Планета замёрзла целиком — «Земля-снежок»', 'snowball');
    }
    if (physSnowball) {
      ice = 1;
      T = climate(co2, 1);
      if (T > 275) {
        physSnowball = false;
        ice = 0.3;
        ev(t, 'climate', '🌋 Вулканический CO₂ растопил лёд — оттепель', 'thaw');
        boost = 10;
      }
    }
    // случайный «снежок» при распаде суперконтинента
    if (snowball <= 0 && d.tectonics && d.land > 0.1 && t > 0.5 && rand() < 0.25 * DT && !physSnowball && T < 300) {
      snowball = 2 + Math.floor(rand() * 5);
      ev(t, 'climate', '❄️ Распад суперконтинента — ледниковая эпоха «снежок»', 'snowball');
    }
    if (snowball > 0) {
      snowball--;
      T = Math.min(T, 240 + rand() * 10);
      ice = 0.95;
      if (snowball === 0) {
        boost = 10;
        ev(t, 'climate', '☀️ Снежок растаял — бурный рост жизни после оледенения', 'thaw');
      }
    }

    // хаотичный наклон оси без большой луны
    const wobble = gauss(rand) * (p.moon > 0.3 ? 1 : 7);
    const Tlife = T + wobble;

    // парниковая катастрофа: океаны испаряются, водород улетает в космос
    if (S > 1.1 && T > 320 && ocean > 0) {
      ocean = Math.max(0, ocean - DT * 2 * (S - 1.05));
      if (ocean < 0.01) { ocean = 0; ev(t, 'climate', '🔥 Океаны выкипели — планета стала второй Венерой', 'runaway'); }
    }
    if (ocean > 0 && ocean < 0.01) ocean = 0;

    // --- среда для жизни ---
    const liquid = ocean > 0.01 && pressure > 0.01 && T > 235 && T < 370;
    const surfaceOk = liquid && Tlife > 255 && Tlife < 330 && !physSnowball;
    const lockPenalty = d.tidalLock ? (pressure > 0.3 ? 0.3 : 0) : 1;
    const habitable = liquid && lockPenalty > 0;
    if (habitable) habitableTime += DT;
    if (habitable && !wasHabitable && stage === 0 && t < 0.2) ev(t, 'info', '💧 На планете есть жидкая вода', 'water');
    wasHabitable = habitable;

    // кислород: копится, когда фотосинтез перевешивает «стоки» (железо, вулканические газы)
    const sink = Math.exp(-t / 1.8);
    const prod = stage >= 5 ? 1 : stage >= 4 ? 0.55 : stage >= 3 ? 0.4 : stage >= 2 ? 0.35 : 0;
    const o2Target = prod > 0 ? clamp((prod - sink) / 0.5, 0, 1.5) * 0.21 : 0;
    const prevO2 = o2;
    o2 += (o2Target - o2) * 0.3;
    if (prevO2 < 0.002 && o2 >= 0.002) ev(t, 'atmo', '🫧 Великое кислородное событие — в воздухе появился кислород', 'goe');
    if (prevO2 < 0.15 && o2 >= 0.15) ev(t, 'atmo', '🌬 Кислорода стало как на современной Земле', 'o2modern');
    ozone = clamp(Math.sqrt(o2 / 0.02), 0, 1);
    const uv = (1 - ozone * 0.95) * (activity + 0.3);

    // --- лестница жизни ---
    const roll = (rate: number) => rand() < 1 - Math.exp(-rate * DT * (boost > 0 ? 2 : 1));
    if (boost > 0) boost--;
    if (stage === 0 && liquid) {
      let r = a.abiogenesis * (p.moon > 0.3 ? 1.5 : 1) * (d.land > 0.02 && d.land < 0.9 ? 1.3 : 0.7);
      if (physSnowball || !surfaceOk) r *= 0.3; // у гидротермальных источников подо льдом
      if (roll(r * Math.max(lockPenalty, 0.2))) stageUp(t, 1);
    } else if (stage === 1 && liquid) {
      const light = d.teff < 3500 ? 0.4 : 1;
      if (!physSnowball && roll(a.photosynthesis * light)) stageUp(t, 2);
    } else if (stage === 2 && liquid && o2 >= 0.002) {
      if (roll(a.eukaryotes)) stageUp(t, 3);
    } else if (stage === 3 && surfaceOk && o2 >= 0.02) {
      if (roll(a.multicellular * lockPenalty)) stageUp(t, 4);
    } else if (stage === 4 && surfaceOk && ozone > 0.6 && d.land > 0.03) {
      if (roll(a.land * (uv < 0.4 ? 1 : 0.2))) stageUp(t, 5);
    } else if (stage >= 4 && stage < 6 && surfaceOk && o2 >= 0.1) {
      // разум: нужен кислород для мозга и спокойный климат последние ~30 млн лет
      const calm = t - lastExtinction > 0.03 ? 1 : 0.2;
      const onLand = stage === 5 ? 1 : 0.3; // разумные в океане тоже бывают (осьминоги, дельфины)
      const t5 = firstReached[stage] ?? t;
      if (t - t5 > 0.1 && roll(a.intelligence * calm * onLand)) {
        stage = 6;
        if (firstReached[6] === null) firstReached[6] = t;
        if (stageAtSea(firstReached)) ev(t, 'life', '🧠 Появился разум — но в океане, без огня', 'intelligence_sea');
        else ev(t, 'life', '🧠 Появился разум', 'intelligence');
      }
    } else if (stage === 6 && surfaceOk && o2 >= 0.16 && d.land > 0.05 && firstReached[5] !== null) {
      if (roll(a.technology)) stageUp(t, 7);
    }

    // --- угрозы ---
    if (stage > 0) {
      if (!liquid && (T > 400 || ocean <= 0.01 || pressure < 0.005)) {
        setback(t, 0, T > 400 ? 'Планета раскалилась' : ocean <= 0.01 ? 'Вода исчезла' : 'Атмосфера улетучилась');
      } else if (!surfaceOk && stage >= 4) {
        setback(t, 3, physSnowball || snowball > 0 || Tlife < 255 ? 'Глобальное оледенение' : 'Невыносимая жара');
      } else if (stage >= 5 && co2 < 1.5e-5) {
        setback(t, 3, 'CO₂ кончился — растениям нечем дышать', 'co2starve');
      } else if (stage >= 4 && Math.abs(wobble) > 14) {
        setback(t, stage >= 6 ? 5 : stage - 1, 'Наклон оси скакнул — климат сошёл с ума', 'axis');
      }
    }
    // метеориты: в первые сотни миллионов лет — «тяжёлая бомбардировка»
    const shield = p.giant ? 0.5 : 1.5;
    const bomb = Math.exp(-t / 0.15);
    if (rand() < (5 * bomb * shield + 0.0005) * DT * 10) {
      ev(t, 'impact', '☄️ Удар 500-км астероида: кора расплавлена, океаны испарились', 'impact500');
      if (stage > 0) setback(t, 0, 'Стерилизующий удар');
      ocean = Math.max(0, ocean - 0.05);
    } else if (rand() < (0.02 + 300 * bomb) * shield * DT) {
      ev(t, 'impact', '☄️ Удар 100-км астероида: океаны вскипели', 'impact100');
      if (stage > 1) setback(t, rand() < 0.7 ? 1 : 0, 'Океаны вскипели');
    } else if (rand() < (8 + 200 * bomb) * shield * DT) {
      if (stage >= 4) {
        ev(t, 'impact', '☄️ Удар 10-км астероида', 'impact10');
        if (rand() < 0.6) setback(t, stage >= 6 ? 5 : 4, 'Массовое вымирание', 'impact10');
      }
    }
    if (stage >= 4 && rand() < (d.tectonics ? 1.5 : 0.5) * DT) {
      ev(t, 'extinction', '🌋 Извержение супервулкана', 'volcano');
      if (stage >= 6 && rand() < 0.4) setback(t, 5, 'Вулканическая зима', 'volcano');
    }
    if (stage >= 5 && rand() < 0.3 * DT) {
      ev(t, 'star', '💥 Рядом взорвалась сверхновая — озон разрушен', 'supernova');
      if (rand() < 0.5) setback(t, 4, 'Ультрафиолет выжег сушу');
    }
    if (stage >= 5 && p.starMass < 0.6 && rand() < activity * 2 * DT) {
      ev(t, 'star', '⚡ Супервспышка звезды', 'flare');
      if (!field || rand() < 0.3) setback(t, 4, 'Супервспышка сорвала озон');
    }

    if (record && step % 2 === 0) {
      samples.push({ t, T, co2, o2, pressure, ocean, ice, flux: S, stage, ozone, habitable });
    }
    // планета мертва навсегда — дальше считать нечего
    if (stage === 0 && ocean === 0 && t > 1 && !record) {
      endReason = 'Планета потеряла воду';
      break;
    }
  }

  let maxStage = 0;
  for (let s = 7; s > 0; s--) {
    if (firstReached[s] !== null) {
      maxStage = s;
      break;
    }
  }
  return {
    params: p,
    derived: d,
    firstReached,
    maxStage,
    habitableTime,
    end: Math.min(end, samples.length ? samples[samples.length - 1].t + DT * 2 : end),
    endReason,
    samples,
    events,
    extinctions,
    setbacks,
  };
}

function stageAtSea(first: (number | null)[]): boolean {
  return first[5] === null;
}
