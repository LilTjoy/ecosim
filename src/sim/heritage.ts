// ♾️ Наследство планеты: что пережили предки животных на этой планете (оледенение, тусклая звезда, мало кислорода,
// недавняя катастрофа, молодость животного мира) — и каким из этого выходят основатели поверхности.
// Плюс «палитра мира»: три модуля, которые у части основателей уже есть в зачатке.
// Чистые функции. Случайность — только из переданного потока (mulberry32 от зерна мира), никогда Math.random.
import type { SimResult } from '../planet/model';
import { clamp, mulberry32, type Rand } from '../lib/random';
import type { Genome } from './genome';
import { bodyFrom, jitterKit, kitList, M, MOD_INFO, ORIGIN } from './modules';

export interface Crisis {
  id: string;
  /** Короткая подпись: «Массовое вымирание», «Удар астероида»… */
  label: string;
  agoMyr: number;
  /** Отбросила ли катастрофа жизнь назад (строка 💀 в истории планеты). */
  setback: boolean;
}

export interface Heritage {
  /** Млрд лет с появления животных. */
  animalAge: number;
  cold: number;
  hot: number;
  lowO2: number;
  dark: number;
  /** Яркость звезды для зрения (1 — Земля). */
  light: number;
  pressure: number;
  magField: boolean;
  crisis: Crisis | null;
  bottleneck: number;
}

export const ZERO_H: Readonly<Heritage> = Object.freeze({
  animalAge: 1, cold: 0, hot: 0, lowO2: 0, dark: 0, light: 1, pressure: 1, magField: true, crisis: null, bottleneck: 0,
});

/** Палитра: доля основателей с зачатком и его уровень U(lo, hi). Ручки стенда (--p=… --lo=…). */
export const PAL = { p: 0.5, lo: 0.3, hi: 0.39 };
/** herC — сила наследства (множитель компонентов); kitRandom — стенд --kit=random (уровни набора ×0.6…1.4). */
export const HER = { herC: 1, kitRandom: false };

const CRISIS_LABEL: Record<string, string> = {
  impact10: 'Удар астероида',
  impact100: 'Удар 100-километрового астероида',
  volcano: 'Извержение супервулкана',
};

/** Наследство по истории планеты к моменту `now` (млрд лет). */
export function computeHeritage(res: SimResult, now: number): Heritage {
  const S = res.samples;
  const t4 = res.firstReached[4] ?? now;
  const from = Math.max(Math.min(t4, now) - 0.3, now - 1);
  const W = S.filter((s) => s.t >= from && s.t <= now);
  const n = Math.max(1, W.length);
  const s = W[W.length - 1] ?? S.filter((x) => x.t <= now).pop() ?? S[0];
  const iceFrac = W.filter((x) => x.ice >= 0.6).length / n;
  let lastThaw = -1;
  for (const e of res.events) if (e.t <= now && e.t >= from && e.id === 'thaw') lastThaw = e.t;
  const cold = clamp(2 * iceFrac + (lastThaw >= 0 ? Math.exp(-(now - lastThaw) / 0.3) : 0), 0, 1);
  const meanT = W.length ? W.reduce((a, x) => a + x.T, 0) / n : s.T;
  const hot = clamp((meanT - 300) / 25, 0, 1);
  const minO2 = W.length ? W.reduce((a, x) => Math.min(a, x.o2), 1) : s.o2;
  const lowO2 = clamp((0.16 - (0.5 * minO2 + 0.5 * s.o2)) / 0.12, 0, 1);
  const teff = res.derived.teff;
  const light = clamp(Math.sqrt(s.flux) * (teff < 3500 ? 0.45 : teff < 4500 ? 0.75 : 1), 0.25, 1.2);
  const dark = clamp((0.8 - light) / 0.5, 0, 1);
  let crisis: Crisis | null = null;
  for (const e of res.events) {
    if (e.t > now || e.t < from) continue;
    const setback = e.text.startsWith('💀');
    if (!setback && !(e.id in CRISIS_LABEL)) continue;
    const label = setback ? e.text.slice(2).split(':')[0].trim() : CRISIS_LABEL[e.id];
    crisis = { id: e.id, label, agoMyr: Math.max(0, Math.round((now - e.t) * 1000)), setback };
  }
  const bottleneck = crisis ? clamp(1 - crisis.agoMyr / 100, 0, 1) * (crisis.setback ? 1 : 0.5) : 0;
  return {
    animalAge: Math.max(0, now - t4), cold, hot, lowO2, dark, light, pressure: s.pressure + s.co2,
    magField: now < res.derived.dynamo, crisis, bottleneck,
  };
}

/** Наследство мира: недостающие поля — как на Земле (ZERO_H); сила — ×herC. */
export function heritageOf(h: Partial<Heritage> | undefined): Heritage {
  const o: Heritage = { ...ZERO_H, ...(h ?? {}) };
  const k = HER.herC;
  if (k !== 1) for (const key of ['cold', 'hot', 'lowO2', 'dark', 'bottleneck'] as const) o[key] = clamp(o[key] * k, 0, 1);
  return o;
}

const PAL_POOL: readonly M[] = [M.SHELL, M.TOXIN, M.PHOTO, M.VOICE, M.CLAW, M.MEMB, M.SCENT, M.PIT, M.AMPUL, M.EORGAN, M.FAT, M.TORPOR, M.PSYM, M.DIG, M.HORN];

/** Палитра мира: 3 разных модуля, которые у части основателей этого мира «в зачатке». Есть и у Земли. */
export function worldPalette(seed: number, h: Heritage): M[] {
  const r = mulberry32(seed ^ 0x5eed);
  const pool = h.magField ? [...PAL_POOL, M.MAG] : PAL_POOL;
  const out: M[] = [];
  while (out.length < 3) {
    const k = pool[Math.floor(r() * pool.length)];
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export interface Founder {
  n: number;
  g: Partial<Genome>;
}

/** Гильдии основателей — те же признаки, что у migrantsFromAfar. */
export const GUILD_F: readonly ((g: Partial<Genome>) => boolean)[] = [
  (g) => (g.diet ?? 0) < 0.3 && (g.swim ?? 0.1) < 0.6,
  (g) => g.diet === 0.45 || g.diet === 0.6,
  (g) => (g.diet ?? 0) > 0.65,
  (g) => (g.swim ?? 0.1) > 0.6,
];

/** Тело (и сдвиг размера) одного основателя по наследству. Порядок шагов и бросков — как в §6.3 спецификации. */
export function heritageFounder(g: Partial<Genome>, h: Heritage, r: Rand, palette: readonly M[]): Partial<Genome> {
  const o: Partial<Genome> = { ...g };
  const size = g.size ?? 4, swim = g.swim ?? 0.1, tempPref = g.tempPref ?? 0.5;
  const carn = (g.diet ?? 0) > 0.65;
  const kit = kitList(swim, tempPref);
  if (HER.kitRandom) jitterKit(kit, r);
  const lv = (k: M) => kit.find((e) => e[0] === k)?.[1] ?? 0;
  let eye = lv(M.EYE), ear = lv(M.EAR), nose = lv(M.NOSE), endo = lv(M.ENDO);
  let limbs = kit.filter((e) => e[0] === M.LIMB).map((e) => e[1]);
  let fur = lv(M.FUR);
  const extra: [M, number][] = [];
  const add = (k: M, l: number) => {
    if (k === M.FUR) fur = Math.max(fur, l);
    else if (!extra.some((e) => e[0] === k)) extra.push([k, l]);
  };
  // молодой животный мир: тела ещё просты
  if (h.animalAge < 0.15) {
    endo = 0.15 * r();
    ear *= 0.5;
    nose *= 0.5;
    if (r() < 0.5) limbs = limbs.slice(0, 1);
  }
  // тусклая звезда
  if (h.dark > 0) {
    eye *= 1 - 0.7 * h.dark;
    if (r() < 0.6 * h.dark) eye = 0;
    ear += 0.3 * h.dark;
    nose += 0.3 * h.dark;
    if (r() < 0.3 * h.dark) add(r() < 0.5 ? M.PIT : M.VOICE, 0.3);
  }
  // оледенение
  if (h.cold > 0 && r() < h.cold * (carn ? 0.5 : 1)) {
    if (!carn || tempPref <= 0.35) {
      if (endo < 0.5) add(M.AFP, 0.3 + 0.4 * h.cold);
      else add(M.FUR, 0.5);
    }
    if (!carn && r() < 0.5 * h.cold) add(M.FAT, 0.3);
  }
  // жара
  if (h.hot > 0) endo -= 0.3 * h.hot;
  // мало кислорода
  if (h.lowO2 > 0 && r() < h.lowO2) {
    add(M.ANAER, 0.2 + 0.5 * h.lowO2);
    o.size = size * (1 - 0.25 * h.lowO2);
  }
  // пережившие катастрофу: спячка, норы у мелких
  if (h.bottleneck > 0.3 && !carn) {
    if (r() < 0.5 * h.bottleneck) add(M.TORPOR, 0.35);
    if ((o.size ?? size) < 5 && r() < 0.5 * h.bottleneck) add(M.DIG, 0.3);
  }
  const list: [M, number, number?][] = [];
  if (eye > 0.05) list.push([M.EYE, Math.min(1, eye)]);
  list.push([M.EAR, Math.min(1, ear)], [M.NOSE, Math.min(1, nose)]);
  if (endo > 0.05) list.push([M.ENDO, Math.min(1, endo)]);
  for (const l of limbs) list.push([M.LIMB, l]);
  if (fur > 0) list.push([M.FUR, fur]);
  list.push(...extra);
  // палитра: зачаток, «свой» номер происхождения 32 + вид
  if (palette.length && r() < PAL.p) {
    const k = palette[Math.floor(r() * palette.length)];
    const l = PAL.lo + (PAL.hi - PAL.lo) * r();
    if (!list.some((e) => e[0] === k)) list.splice(Math.min(list.length, 7), 0, [k, l, ORIGIN.PALETTE + k]);
  }
  o.body = bodyFrom(list, swim > 0.6 ? 0.6 : 0.5);
  return o;
}

export interface Plan {
  plan: Founder[];
  /** Сколько основателей не пережили «горлышко» и сколько вернули, чтобы не пропала гильдия. */
  dropped: number;
  restored: number;
}

/** Основатели мира: горлышко (решения для всех — первыми), возврат пропавших гильдий, тела по наследству. */
export function founderPlan(base: readonly Founder[], h: Heritage, seed: number, palette: readonly M[]): Plan {
  const r = mulberry32(seed ^ 0xa11ce);
  const keep = base.map((f) => !(h.bottleneck > 0.3 && (f.g.size ?? 4) > 6 && r() < 0.75 * h.bottleneck));
  const g = base.map((f) => ({ ...f.g }));
  let restored = 0;
  for (const pred of GUILD_F) {
    const idx = base.map((_, i) => i).filter((i) => pred(base[i].g));
    if (!idx.length || idx.some((i) => keep[i])) continue;
    let s = idx[0];
    for (const i of idx) if ((base[i].g.size ?? 4) < (base[s].g.size ?? 4)) s = i;
    keep[s] = true;
    g[s].size = Math.min(g[s].size ?? 4, 5.5); // последний в гильдии выживает карликом («эффект лилипута»)
    restored++;
  }
  let all = 0, kept = 0;
  base.forEach((f, i) => {
    all += f.n;
    if (keep[i]) kept += f.n;
  });
  const k = kept > 0 ? all / kept : 1;
  const plan: Founder[] = [];
  base.forEach((f, i) => {
    if (!keep[i]) return;
    // пережившие горлышко крупные мельчают («эффект лилипута»): после катастрофы нет никого крупнее 6
    if (h.bottleneck > 0.3 && (g[i].size ?? 4) > 6) g[i].size = 6;
    plan.push({ n: f.n * k, g: heritageFounder(g[i], h, r, palette) });
  });
  return { plan, dropped: keep.filter((x) => !x).length, restored };
}

/** Строки летописи мира о наследстве: [текст, карточка]. */
export function chronicle(h: Heritage, plan: readonly Founder[], palette: readonly M[]): [string, string][] {
  const out: [string, string][] = [];
  if (h.cold > 0.3) out.push(['🏛 Наследство планеты: предки пережили оледенение — у многих основателей антифриз или мех', 'heritage']);
  if (h.lowO2 > 0.3) out.push(['🏛 Воздух древней планеты беден кислородом — некоторые основатели умеют обходиться почти без него', 'anaerobic']);
  if (h.dark > 0.3) {
    let blind = 0, n = 0;
    for (const f of plan) {
      n += f.n;
      const b = f.g.body;
      if (b && !Array.from(b.km).some((km) => (km & 31) === M.EYE)) blind += f.n;
    }
    out.push(blind >= 0.7 * n
      ? ['👁 В этом мире у предков не было глаз — зрение придётся изобретать', 'darkworld']
      : ['🏛 Звезда светит тускло — зрение у основателей слабое, у некоторых глаз нет вовсе', 'darkworld']);
  }
  if (h.bottleneck > 0.3 && h.crisis) {
    const c = h.crisis;
    out.push([`🏛 ${c.label} ${c.agoMyr > 0 ? c.agoMyr + ' млн лет назад' : 'совсем недавно'}: выжили только мелкие. Остров заселяют потомки выживших`, 'lilliput']);
  }
  if (h.animalAge < 0.15) out.push([`🏛 Животные появились всего ${Math.round(h.animalAge * 1000)} млн лет назад — тела основателей ещё просты`, 'heritage']);
  if (!h.magField) out.push(['🏛 Магнитного поля нет — компасу в теле здесь нечего чувствовать', 'magneto']);
  const icons = palette.map((k) => `${MOD_INFO[k].emoji} ${MOD_INFO[k].label}`).join(', ');
  out.push([`🎨 Палитра этого мира: ${icons} — у некоторых основателей эти органы в зачатке`, 'openevo']);
  return out;
}
