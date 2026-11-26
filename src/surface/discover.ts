// ♾️ Открытая эволюция в интерфейсе: вкладка «🌟 Открытия», «Тело» в инспекторе, умения и органы вида.
// Только чтение мира — здесь ничего не меняется и нет случайностей. Разметка — строками, как в view.ts.
import { plural } from '../lib/text';
import { RECIPES, foundCount, planSig, type Disc, type Recipe } from '../sim/bestiary';
import { heritageOf } from '../sim/heritage';
import { kindOf, kitList, M, MOD_INFO, NSLOT, ORIGIN, originOf, P } from '../sim/modules';
import type { Species } from '../sim/species';
import { DAY, type Creature, type World } from '../sim/world';

export const RECIPE_N = RECIPES.length;
const R_BY_ID = new Map(RECIPES.map((r) => [r.id, r]));
export const recipeOf = (id: string): Recipe | undefined => R_BY_ID.get(id);

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
const day = (t: number) => Math.floor(t / DAY);
const pc = (v: number) => `${Math.round(v * 100)}%`;
/** Виды модулей «нейтрального набора» (у всех основателей): в списке видов их не показываем. */
const KIT = new Set<M>([M.EYE, M.EAR, M.NOSE, M.ENDO, M.LIMB]);
const PAT = ['пятнистых', 'однотонных', 'полосатых'];

/** Сколько открытий (без 🏛 унаследованных) — для HUD. */
export const discoveries = (w: World): number => (w.oe ? foundCount(w.bestiary) : 0);

/** Откуда модуль — подсказка у чипа «Тело». */
function originText(w: World, o: number): string {
  if (o < ORIGIN.INTRODUCED) return 'унаследовано от предков планеты';
  if (o === ORIGIN.INTRODUCED) return 'завезён игроком';
  if (o < ORIGIN.FRESH) return 'из зачатка палитры этого мира';
  const info = w.bestiary.originInfo.get(o);
  if (!info) return 'ещё не прижилось';
  return `изобретено на д.${day(info.tick)} у «${w.species.all.get(info.sp)?.name ?? '?'}»`;
}

/** «Тело» особи: чипы органов (от сильнейшей копии — происхождение), ноги — парами. */
export function bodyChips(w: World, c: Creature): string {
  const b = c.g.body, ph = c.g.ph;
  const best = new Map<M, [number, number]>(); // вид → [уровень сильнейшей копии, происхождение]
  for (let i = 0; i < NSLOT; i++) {
    const km = b.km[i];
    if (km === 0) continue;
    const k = kindOf(km), v = b.lvl[i];
    const cur = best.get(k);
    if (!cur || v > cur[0]) best.set(k, [v, originOf(km)]);
  }
  const out: string[] = [];
  const kinds = [...best.keys()].sort((a, b2) => a - b2);
  for (const k of kinds) {
    const [, o] = best.get(k)!;
    const info = MOD_INFO[k];
    let txt: string, lvl: number;
    if (k === M.LIMB) {
      const n = ph[P.LEGS];
      lvl = n > 0 ? 1 : 0;
      txt = n ? `${n} ${plural(n, 'пара', 'пары', 'пар')} ног` : 'ноги — зачатки';
    } else {
      lvl = ph[k - 1];
      txt = `${info.label} ${pc(lvl)}`;
    }
    const weak = lvl < 0.2;
    const fact = k === M.LIMB ? (ph[P.LEGS] >= 3 ? 'manylegs' : ph[P.LEGS] < 1 ? 'legless' : 'legs') : info.fact;
    out.push(`<span class="b-chip${weak ? ' weak' : ''}" data-fact="${fact}" title="${esc(originText(w, o))}">${info.emoji} ${txt}${weak ? ' (зачаток)' : ''}</span>`);
  }
  if (!best.has(M.EYE)) out.push('<span class="b-chip blind" data-fact="eyeloss" title="глаз нет">🕳 без глаз</span>');
  if (ph[P.FLY] >= 0.45) out.push(`<span class="b-chip" data-fact="${ph[P.FLY] >= 1 ? 'flight' : 'gliding'}">${ph[P.FLY] >= 1 ? '🕊 летает' : '🪂 планирует'}</span>`);
  return out.join('');
}

const SENSE_ICONS: [keyof ReturnType<World['senses']>, string, string][] = [
  ['vision', '👁', 'зрение'], ['hearing', '👂', 'слух'], ['echo', '🦇', 'эхо'], ['smell', '👃', 'нюх'], ['heat', '🌡', 'тепло'], ['electric', '⚡', 'ток'],
];

/** «Чувства сейчас: 👁 85 · 👂 33 · 👃 27 — лучше всего: зрение». */
export function sensesLine(w: World, c: Creature): string {
  const s = w.senses(c);
  let bestV = 0, bestL = '';
  const parts: string[] = [];
  for (const [k, ic, label] of SENSE_ICONS) {
    const v = s[k];
    if (v < 2) continue;
    parts.push(`${ic} ${Math.round(v)}`);
    if (v > bestV) [bestV, bestL] = [v, label];
  }
  if (!parts.length) return '<div class="muted small">Чувства сейчас: почти ничего не замечает <a data-fact="senses">?</a></div>';
  return `<div class="muted small">Чувства сейчас: ${parts.join(' · ')} — лучше всего: ${bestL} <a data-fact="senses">?</a></div>`;
}

/** Умения особи — рецепты, которые проходит её тело. */
export function abilBadges(w: World, c: Creature): string {
  const sp = w.species.all.get(c.sp);
  const root = sp ? w.species.all.get(sp.root) : undefined;
  const x = { mag: w.env.magField !== false, rootEye: root ? root.founder.ph[P.EYE] : 1 };
  const out: string[] = [];
  for (const r of RECIPES) if (r.test(c.g.ph, c.g, x) || (r.id === 'aposematism' && sp?.abil.has(r.id))) out.push(`<span class="a-badge" data-fact="${r.id}" title="${esc(r.name)}">${r.icon} ${r.name}</span>`);
  return out.length ? `<div class="a-badges">${out.join('')}</div>` : '';
}

/** Строка памяти о ядовитой добыче. */
export function aversionLine(w: World, c: Creature): string {
  if (!w.oe || c.avoidT <= w.tick) return '';
  return `<div class="muted small">🤢 помнит: <i class="dot" style="background:hsl(${Math.round(c.avoidHue)},65%,55%)"></i> ${PAT[c.avoidPat] ?? ''} такие ядовиты (до д.${day(c.avoidT)}) <a data-fact="aposematism">?</a></div>`;
}

/** Уровень набора (основатель без палитры) для вида модуля. */
function kitLevel(sp: Species, k: M): number {
  if (k === M.LIMB) return 0;
  let v = 0;
  for (const [kk, l] of kitList(sp.mean.swim, sp.mean.tempPref)) if (kk === k) v = 1 - (1 - v) * (1 - l);
  return v;
}

/** Иконки в строке списка видов: до 3 органов вне набора со средним ≥ 0.3; слепой вид — 🕳. */
export function listIcons(sp: Species): string {
  const m = sp.mph;
  if (!m) return '';
  const ic: [number, string][] = [];
  for (let k = M.EYE; k < M.LIMB; k++) if (!KIT.has(k) && m[k - 1] >= 0.3) ic.push([m[k - 1], MOD_INFO[k].emoji]);
  ic.sort((a, b) => b[0] - a[0]);
  let s = ic.slice(0, 3).map((x) => x[1]).join('');
  if (m[P.EYE] < 0.05) s = '🕳' + s;
  if (m[P.FLY] >= 1) s += '🕊';
  return s ? ` <span class="sp-ic">${s}</span>` : '';
}

/** Карточка вида: умения, органы, заметно отличающиеся от набора, сходство (🪞) и подражание (🎭). */
export function speciesOE(w: World, sp: Species, color: string): string {
  const out: string[] = [];
  if (sp.abil.size) {
    out.push(`<div class="a-badges">${[...sp.abil].map((id) => {
      const r = recipeOf(id);
      return r ? `<span class="a-badge" data-fact="${id}" title="${esc(r.hint)}">${r.icon} ${r.name}</span>` : '';
    }).join('')}</div>`);
  }
  const m = sp.mph;
  if (m) {
    const rows: [number, M, number][] = [];
    for (let k = M.EYE; k < M.LIMB; k++) {
      const d = Math.abs(m[k - 1] - kitLevel(sp, k));
      if (d >= 0.1) rows.push([d, k, m[k - 1]]);
    }
    rows.sort((a, b) => b[0] - a[0]);
    const bars = rows.slice(0, 6).map(([, k, v]) => `<div class="gene" data-fact="${MOD_INFO[k].fact}"><span>${MOD_INFO[k].emoji} ${MOD_INFO[k].label}</span><div class="gbar"><div style="width:${Math.min(100, v * 100)}%;background:${color}"></div></div><b>?</b></div>`);
    const legs = m[P.LEGS];
    if (Math.abs(legs - 2) >= 0.5) bars.push(`<div class="muted small">🦵 ног в среднем: ${legs.toFixed(1)} пары <a data-fact="${legs < 0.5 ? 'legless' : 'manylegs'}">?</a></div>`);
    if (bars.length) out.push(`<div class="muted small">Тело — чем отличается от предков-основателей:</div><div class="genes">${bars.join('')}</div>`);
  }
  const B = w.bestiary, S = w.species.all;
  for (const cv of B.conv) {
    const other = cv.a === sp.id ? cv.b : cv.b === sp.id ? cv.a : -1;
    if (other >= 0) out.push(`<div class="muted small">🪞 похож на «${esc(S.get(other)?.name ?? '?')}» — конвергенция <a data-fact="${cv.fact}">?</a></div>`);
  }
  for (const key of B.mimPairs) {
    const [n, t] = key.split(':').map(Number);
    if (n === sp.id) out.push(`<div class="muted small">🎭 подражает «${esc(S.get(t)?.name ?? '?')}» <a data-fact="mimicry">?</a></div>`);
    else if (t === sp.id) out.push(`<div class="muted small">🎭 ему подражают «${esc(S.get(n)?.name ?? '?')}» <a data-fact="mimicry">?</a></div>`);
  }
  if (sp.introduced) out.push('<div class="muted small">➕ Завезён игроком — его изобретения не считаются открытиями эволюции</div>');
  return out.join('');
}

/** Особи вида с умением id (или первооткрыватель) — для 💡 и «показать на карте». */
function holders(w: World, d: Disc): Creature[] {
  const out: Creature[] = [];
  for (const c of w.creatures) {
    const sp = w.species.all.get(c.sp);
    if (sp && (c.sp === d.sp || sp.abil.has(d.id))) out.push(c);
  }
  return out;
}

/** Куда смотреть на карте: центр носителей открытия (или место открытия). */
export function discCentroid(w: World, id: string): [number, number, number] | null {
  const d = w.bestiary.found.get(id);
  if (!d) return null;
  const hs = holders(w, d);
  if (!hs.length) return [d.x, d.y, d.sp];
  let x = 0, y = 0;
  for (const c of hs) {
    x += c.x;
    y += c.y;
  }
  return [x / hs.length, y / hs.length, hs[0].sp];
}

/** 💡 честная строка: полезно ли это в этом мире. */
function utility(w: World, d: Disc): string {
  const id = d.id;
  if (id === 'magneto' && w.env.magField === false) return 'бесполезен: у планеты нет магнитного поля';
  if ((id === 'glow' || id === 'lure') && (w.env.light ?? 1) >= 1) return 'днём на яркой планете почти бесполезно';
  const hs = holders(w, d);
  if (!hs.length) return '';
  if (id === 'echolocation') {
    const c = hs[0], s = w.senses(c);
    return `эхо слышит на ${Math.round(s.echo)} ед., глаза сейчас видят на ${Math.round(s.vision)}`;
  }
  if (id === 'electroloc' || id === 'electrorecept' || id === 'eshock') {
    let sw = 0;
    for (const c of hs) sw += c.g.swim;
    if (sw / hs.length < 0.4) return 'на суше почти не работает';
  }
  return '';
}

/** Чипы наследства планеты и паспорт мира. */
export function heritageHtml(w: World): string {
  const h = heritageOf(w.env.heritage);
  const chips: string[] = [];
  if (h.cold > 0.3) chips.push(`❄️ холодное прошлое ${pc(h.cold)}`);
  if (h.hot > 0.3) chips.push(`🔥 жаркое прошлое ${pc(h.hot)}`);
  if (h.dark > 0.3 || (w.env.light ?? 1) < 0.6) chips.push('🌑 тусклая звезда');
  if (h.lowO2 > 0.3) chips.push('🌫 мало O₂');
  if (h.crisis && h.bottleneck > 0.3) chips.push(`☄️ недавнее вымирание`);
  if (h.animalAge < 0.3) chips.push('🐣 молодая жизнь');
  if (!h.magField || w.env.magField === false) chips.push('🧲 нет поля');
  if (w.palette.length) chips.push(`🎨 палитра: ${w.palette.map((k) => `<span title="${MOD_INFO[k].label}">${MOD_INFO[k].emoji}</span>`).join(' ')}`);
  return `<div class="s-heritage">${chips.map((c) => `<span>${c}</span>`).join('')}<a data-fact="heritage">?</a></div><div class="muted small">${esc(w.passport())}</div>`;
}

/** Вкладка «🌟 Открытия» целиком. collection — открытые за все миры (localStorage в view). */
export function discoverHtml(w: World, collection: ReadonlySet<string>): string {
  if (!w.oe) return '<p class="muted small">Открытая эволюция в этом мире выключена.</p>';
  const B = w.bestiary, S = w.species.all;
  const found = foundCount(B);
  const cards = RECIPES.map((r) => {
    const d = B.found.get(r.id);
    if (d && d.inherited) {
      return `<div class="d-card inh" data-fact="${r.id}"><div class="d-t">${r.icon} ${r.name}</div><div class="d-s">🏛 досталось от предков</div></div>`;
    }
    if (d && d.lost !== null) {
      return `<div class="d-card lost" data-rec="${r.id}"><div class="d-t">${r.icon} ${esc(d.title)} <a data-fact="${r.id}">?</a></div><div class="d-s">утрачено на д.${day(d.lost)} <a data-fact="dollo">?</a></div></div>`;
    }
    if (d) {
      const u = utility(w, d);
      return `<div class="d-card found" data-rec="${r.id}"><div class="d-t">${r.icon} ${esc(d.title)} <a data-fact="${r.id}">?</a></div><div class="d-s">«${esc(d.spName)}» · д.${day(d.tick)}${d.times > 1 ? ` · 🔁×${d.times}` : ''}${d.parallel ? ` · 🔀×${d.parallel}` : ''}</div>${
        d.fromPalette || d.viaMutagen ? `<div class="d-s">${d.fromPalette ? 'из зачатка' : ''}${d.viaMutagen ? ' <span class="d-mu" title="при ☢️ всплеске мутаций">☢️</span>' : ''}</div>` : ''
      }${u ? `<div class="d-u">💡 ${esc(u)}</div>` : ''}</div>`;
    }
    const p = B.prog.get(r.id) ?? 0;
    const near = B.near.get(r.id);
    return `<div class="d-card unk"><div class="d-t">❔ ??? <span class="muted">· ${esc(r.hint)}</span></div><div class="d-bar"><div style="width:${Math.round(p * 100)}%"></div></div>${
      near !== undefined && p >= 0.5 ? `<div class="d-s">🔜 близко у «${esc(S.get(near)?.name ?? '?')}»</div>` : ''
    }</div>`;
  }).join('');
  const parts: string[] = [heritageHtml(w), `<h4>Открытия этого мира ${found}/${RECIPE_N} <a data-fact="openevo">?</a></h4>`, `<div class="d-grid">${cards}</div>`];
  if (B.live.length) {
    parts.push(`<h4>🧪 Зачатки сейчас <a data-fact="duplication">?</a></h4><ul class="d-rows">${B.live.map(([o, k, n, m = 1]) => {
      const info = w.bestiary.originInfo.get(o);
      const muts = m > 1 ? ` · из ${m} независимых мутаций` : '';
      return `<li>${MOD_INFO[k].emoji} зачаток ${MOD_INFO[k].gen} · ${n} ${plural(n, 'носитель', 'носителя', 'носителей')}${muts}${info ? ' · 🌱 прижился' : ''}</li>`;
    }).join('')}</ul>`);
  }
  if (B.conv.length) {
    parts.push(`<h4>Конвергенции <a data-fact="convergence">?</a></h4><ul class="d-rows">${B.conv.slice(-8).reverse().map((c) =>
      `<li data-spg="${c.a}">🪞 «${esc(S.get(c.a)?.name ?? '?')}» ≈ «${esc(S.get(c.b)?.name ?? '?')}» · д.${day(c.tick)}</li>`).join('')}</ul>`);
  }
  if (B.mimPairs.length) {
    parts.push(`<h4>Мимикрия <a data-fact="mimicry">?</a></h4><ul class="d-rows">${B.mimPairs.map((key) => {
      const [n, t] = key.split(':').map(Number);
      return `<li data-spg="${n}">🎭 «${esc(S.get(n)?.name ?? '?')}» похожи на ядовитых «${esc(S.get(t)?.name ?? '?')}»</li>`;
    }).join('')}</ul>`);
  }
  if (B.plans.size) {
    // живые линии с тем же планом (по средним вида)
    const live = new Map<number, { n: number; r: number; c: Creature | null }>();
    const bySp = new Map<number, number>();
    for (const sp of w.species.living()) {
      if (!sp.mph) continue;
      const sig = planSig(sp.mph, sp.mean.swim, sp.mean.diet);
      if (!B.plans.has(sig)) continue;
      const e = live.get(sig) ?? { n: 0, r: 0, c: null };
      e.n += sp.count;
      e.r++;
      live.set(sig, e);
      bySp.set(sp.id, sig);
    }
    for (const c of w.creatures) {
      const sig = bySp.get(c.sp);
      if (sig === undefined) continue;
      const e = live.get(sig)!;
      if (!e.c) e.c = c;
    }
    const rows = [...B.plans.values()].sort((a, b) => (live.get(b.sig)?.n ?? 0) - (live.get(a.sig)?.n ?? 0) || b.tick - a.tick).slice(0, 12);
    parts.push(`<h4>Бестиарий <a data-fact="tinkering">?</a></h4><ul class="d-best">${rows.map((p) => {
      const e = live.get(p.sig);
      return `<li data-spg="${e?.c?.sp ?? p.sp}"><canvas class="d-pt" data-sig="${p.sig}"></canvas><span><b>${esc(p.ru)}</b> · <i>${esc(p.latin)}</i><br><span class="muted">${e ? `живых ${e.n} · ${e.r} ${plural(e.r, 'линия', 'линии', 'линий')}` : 'вымер'}</span></span></li>`;
    }).join('')}</ul>`);
  }
  parts.push(`<div class="s-collection">За все миры открыто: ${[...collection].filter((id) => R_BY_ID.has(id)).length}/${RECIPE_N}</div>`);
  return parts.join('');
}

/** Геном для портрета строки бестиария: живая особь с этим планом или основатель вида, открывшего план. */
export function planGenome(w: World, sig: number): Creature['g'] | null {
  const p = w.bestiary.plans.get(sig);
  if (!p) return null;
  for (const sp of w.species.living()) {
    if (!sp.mph || planSig(sp.mph, sp.mean.swim, sp.mean.diet) !== sig) continue;
    for (const c of w.creatures) if (c.sp === sp.id) return c.g;
  }
  return w.species.all.get(p.sp)?.founder ?? null;
}

/** Есть ли у мира заметное наследство (для карточки «Наследство планеты»). */
export function heritageNotable(w: World): boolean {
  const h = heritageOf(w.env.heritage);
  return h.cold > 0.3 || h.hot > 0.3 || h.lowO2 > 0.3 || h.dark > 0.3 || h.bottleneck > 0.3 || h.animalAge < 0.3;
}

