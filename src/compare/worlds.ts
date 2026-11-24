/**
 * Настоящие соседи Земли — Марс и Венера — в той же модели, что и любая планета.
 * Параметры взяты из науки (см. комментарии), а не подогнаны под ответ.
 */
import { EARTH, STAGE_NAMES, SAMPLE_DT, type PlanetParams, type Sample, type SimResult } from '../planet/model';
import { clamp } from '../lib/random';

/** Что измерено на самом деле сегодня. */
export interface RealRef {
  /** Средняя температура поверхности, °C. */
  T: number;
  /** Давление у поверхности, бар. */
  P: number;
  /** Доля кислорода (0,21 = 21%). */
  o2: number;
  water: string;
  /** Свет Солнца, Земля = 1. */
  flux: number;
  /** Сила тяжести, Земля = 1. */
  g: number;
  day: string;
  /** Скорость убегания, км/с. */
  vesc: number;
}

export interface CompareWorld {
  id: string;
  name: string;
  icon: string;
  color: string;
  params: PlanetParams;
  real?: RealRef;
  rock?: [number, number, number];
  /** Мир изменён в «Что если…» — настоящие данные к нему не относятся. */
  modified?: boolean;
  /** Ключ сценария «Что если…», если он применён. */
  whatif?: string;
}

/**
 * Марс: воды на старте 0,1 океана (оценки древнего океана — 100–500 м слоя против 2,7 км у Земли),
 * азота 1 бар (даёт ~0,4 бар в начале), динамо по намагниченной коре угасло ~4,1 млрд лет назад.
 */
export const MARS: PlanetParams = { ...EARTH, seed: 1976, orbit: 1.524, ecc: 0.093, mass: 0.107, water: 0.1, moon: 0, giant: true, nitrogen: 1, tectonics: false, rotation: 1.03, dynamoGyr: 0.45 };
/** Венера: столько же воды, сколько у Земли; азота 4,5 бар (сегодня ~3 бар N₂); сутки 243 земных. */
export const VENUS: PlanetParams = { ...EARTH, seed: 1970, orbit: 0.723, ecc: 0.007, mass: 0.815, water: 1, moon: 0, giant: true, nitrogen: 4.5, tectonics: false, rotation: 243 };

export const SOLAR: CompareWorld[] = [
  {
    id: 'earth',
    name: 'Земля',
    icon: '🌍',
    color: '#64b5f6',
    params: EARTH,
    real: { T: 15, P: 1.01, o2: 0.21, water: 'океаны, 71% поверхности', flux: 1, g: 1, day: '24 ч', vesc: 11.2 },
  },
  {
    id: 'mars',
    name: 'Марс',
    icon: '🔴',
    color: '#ff8a65',
    params: MARS,
    rock: [176, 96, 60],
    real: { T: -63, P: 0.006, o2: 0.0013, water: 'лёд: полярные шапки и грунт', flux: 0.43, g: 0.38, day: '24 ч 37 мин', vesc: 5.0 },
  },
  {
    id: 'venus',
    name: 'Венера',
    icon: '🟡',
    color: '#ffd54f',
    params: VENUS,
    real: { T: 464, P: 92, o2: 0, water: 'почти нет (следы пара)', flux: 1.91, g: 0.9, day: '243 сут, обратное', vesc: 10.4 },
  },
];

export const EXTRA_COLOR = '#b39ddb';
/** Возраст Солнечной системы сегодня, млрд лет. */
export const TODAY = 4.57;

/** Мир «из природы»? (тогда есть смысл показывать настоящие данные) */
export const isNatural = (p: PlanetParams) => [EARTH, MARS, VENUS].some((q) => JSON.stringify(q) === JSON.stringify(p));

// ---------------- что если ----------------

export interface WhatIf {
  key: string;
  label: string;
  /** Какой мир меняем (индекс в SOLAR). */
  base: number;
  /** Новое имя колонки. */
  name: string;
  /** Что проверяем — вопрос, а не ответ (ответ считает модель). */
  question: string;
  change: Partial<PlanetParams>;
}

export const WHATIFS: WhatIf[] = [
  { key: 'venus1', label: '🔄 Венера на орбите Земли', base: 2, name: 'Венера на месте Земли', question: 'Венера погибла из-за того, что она ближе к Солнцу?', change: { orbit: 1 } },
  { key: 'earth07', label: '🔄 Земля на орбите Венеры', base: 0, name: 'Земля на месте Венеры', question: 'Спас бы Землю её термостат, будь она ближе к Солнцу?', change: { orbit: 0.723 } },
  { key: 'earth15', label: '🔄 Земля на орбите Марса', base: 0, name: 'Земля на месте Марса', question: 'Хватит ли Земле тепла вдали от Солнца?', change: { orbit: 1.524 } },
  { key: 'mars1', label: '🔄 Марс на орбите Земли', base: 1, name: 'Марс на месте Земли', question: 'Если Марсу дать больше тепла — оживёт ли он?', change: { orbit: 1 } },
  { key: 'marsbig', label: '🏋 Марс размером с Землю', base: 1, name: 'Большой Марс', question: 'Марс погубил его маленький размер?', change: { mass: 1, dynamoGyr: undefined } },
  { key: 'nomoon', label: '🌙 Земля без Луны', base: 0, name: 'Земля без Луны', question: 'Нужна ли жизни большая Луна?', change: { moon: 0 } },
];

export function applyWhatIf(w: WhatIf): CompareWorld {
  const src = SOLAR[w.base];
  const params: PlanetParams = { ...src.params, ...w.change };
  if ('dynamoGyr' in w.change && w.change.dynamoGyr === undefined) delete params.dynamoGyr;
  return { ...src, params, name: w.name, modified: true, whatif: w.key, real: undefined };
}

// ---------------- чтение результата ----------------

export function sampleAt(r: SimResult, t: number): Sample {
  const s = r.samples;
  return s[clamp(Math.round(t / SAMPLE_DT), 0, s.length - 1)];
}

const num = (v: number, digits: number) => v.toFixed(digits).replace('.', ',');

export function fmtT(s: Sample): string {
  const c = Math.round(s.T - 273);
  return `${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(c)} °C`;
}

export function fmtP(P: number): string {
  if (P >= 99.5) return '≈100 бар';
  if (P >= 10) return `${Math.round(P)} бар`;
  if (P >= 0.1) return `${num(P, 2)} бар`;
  if (P >= 0.001) return `${num(P, 4).replace(/0+$/, '')} бар`;
  return 'почти 0';
}

export const pressureOf = (s: Sample) => s.pressure + s.co2;
/** Вода в земных океанах. */
export const waterOf = (s: Sample, r: SimResult) => s.ocean * r.params.water;

function fmtOceans(w: number): string {
  if (w >= 0.995) return num(w, w >= 10 ? 0 : 1);
  if (w >= 0.1) return num(w, 2);
  return num(w, 3).replace(/0+$/, '');
}

/** Вода: океан, лёд, пар или ничего. kind — для подсветки. */
export function waterChip(s: Sample, r: SimResult): { text: string; kind: 'none' | 'steam' | 'ice' | 'ocean' } {
  const w = waterOf(s, r);
  if (w <= 0.001) return { text: 'нет', kind: 'none' };
  if (s.T > 373) return { text: `пар ${fmtOceans(w)}`, kind: 'steam' };
  if (s.T < 273 || s.ice > 0.9) return { text: `лёд ${fmtOceans(w)}`, kind: 'ice' };
  return { text: `океан ${fmtOceans(w)}`, kind: 'ocean' };
}

/** Где на этой планете могли бы жить микробы — эвристика, не модель. */
export function microbeChip(s: Sample, r: SimResult): string {
  const w = waterOf(s, r);
  if (s.stage >= 1) return '🦠 есть жизнь';
  if (s.ocean > 0.01 && s.pressure > 0.01 && s.T > 235 && s.T < 370) return '🦠 океан пригоден';
  if (w > 0.001 && s.T < 273) return '🦠 подо льдом/в грунте — возможно';
  if (s.ocean <= 0.01 && pressureOf(s) > 30 && s.T > 500) return '🦠 облака на 50–60 км — спорно';
  return '🦠 негде';
}

export function stageLabel(s: Sample, r: SimResult): string {
  const w = waterOf(s, r);
  if (s.stage > 0) return STAGE_NAMES[s.stage];
  if (s.ocean > 0.01 && s.T > 373) return 'Паровой мир';
  if (pressureOf(s) < 0.03 && w > 0.001) return 'Ледяная пустыня';
  if (w <= 0.001) return s.T > 400 ? 'Раскалённая пустыня' : 'Безводная пустыня';
  if (s.ice > 0.9 || s.T < 255) return 'Мёртвый ледяной мир';
  return 'Безжизненный мир';
}

/** Высшая ступень жизни, достигнутая к моменту t. */
export function maxStageBy(r: SimResult, t: number): number {
  for (let k = 7; k > 0; k--) if (r.firstReached[k] !== null && r.firstReached[k]! <= t) return k;
  return 0;
}

/** Сколько раз жизнь отбрасывало назад к моменту t. */
export const setbacksBy = (r: SimResult, t: number) => r.events.filter((e) => e.kind === 'extinction' && e.text.startsWith('💀') && e.t <= t).length;

export const STAGE_SHORT = ['☠ нет жизни', '🦠 микробы', '🌿 фотосинтез', '🧫 сложные клетки', '🪼 животные в океане', '🦎 жизнь на суше', '🧠 разум', '📡 технологии'];

export const fmtGyr = (t: number) => (t < 1 ? `${Math.round(t * 1000)} млн лет` : `${num(t, 2)} млрд лет`);

/** Итог сценария «Что если…» — целиком из результата симуляции. */
export function outcomeText(r: SimResult, t = TODAY): { now: string; story: string } {
  const s = sampleAt(r, t);
  const w = waterChip(s, r);
  const amount = w.text.split(' ')[1];
  const water = { none: 'воды нет', steam: `пар (${amount} океана)`, ice: `лёд ${amount} от земного океана`, ocean: `океан ${amount} от земного` }[w.kind];
  const parts = [fmtT(s), water, fmtP(pressureOf(s)), STAGE_SHORT[s.stage]];
  const story: string[] = [];
  const max = maxStageBy(r, t);
  if (max > s.stage) story.push(`жизнь доходила до ступени «${STAGE_NAMES[max].toLowerCase()}», но откатилась`);
  const sb = setbacksBy(r, t);
  if (sb > 0) story.push(`откатов жизни: ${sb}`);
  const ev = (id: string) => r.events.find((e) => e.id === id && e.t <= t);
  const boil = ev('runaway');
  if (boil) story.push(`океаны выкипели через ${fmtGyr(boil.t)}`);
  const air = ev('atmoloss');
  if (air) story.push(`воздух улетучился к ${fmtGyr(air.t)}`);
  const dyn = ev('dynamo');
  if (dyn) story.push(`магнитное поле угасло в ${fmtGyr(dyn.t)}`);
  const dry = r.samples.find((x) => x.t <= t && x.t > 0 && waterOf(x, r) <= 0.001);
  if (dry && !boil && r.params.water > 0.01) story.push(`вода исчезла к ${fmtGyr(dry.t)}`);
  return { now: parts.join(' · '), story: story.join('; ') };
}
