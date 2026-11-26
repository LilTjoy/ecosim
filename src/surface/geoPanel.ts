// 🌋 Вкладка панели «🌋 Планета»: ледниковые циклы (море и лёд по истории), проливы и мосты, половины видов
// (поколений врозь, гены разошлись, утечки), рефугиумы последнего пика, великий обмен, озёра и морены.
// Только чтение мира: ссылку на w.geo не держит (loadWorld заменяет его целиком).
import { GEO, geoKyr, metres, sideWords } from '../sim/geo';
import type { World } from '../sim/world';
import { plateText } from './geoSheet';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const plural = (n: number, a: string, b: string, c: string) => {
  const m = n % 100, k = n % 10;
  return m >= 11 && m <= 14 ? c : k === 1 ? a : k >= 2 && k <= 4 ? b : c;
};
const sea = (m: number) => `${m > 0 ? '+' : m < 0 ? '−' : ''}${Math.abs(m)} м`;

/** Шкала половин вида: «🌊 поколений врозь 7/10 · гены разошлись 31%» (null — за видом не следим). */
export function isoGauge(w: World, sp: number): string | null {
  const g = w.geo;
  if (!w.lp || !g) return null;
  const r = g.isolates.find((x) => x.sp === sp);
  if (!r) return null;
  const s = g.sills[r.sill];
  const k = Math.min(1, r.ga / GEO.ISO_GEN);
  return `<div class="gp-gauge" title="Половины по разные стороны пролива ${esc(s?.name ?? '')}: ${r.parts[0]} и ${r.parts[1]} особей"><div class="gp-bar"><i style="width:${Math.round(100 * k)}%"></i></div><span>🌊 поколений врозь ${r.ga}/${GEO.ISO_GEN} · гены разошлись ${Math.round(100 * r.d)}%${r.leak ? ` · 🔀 смешивались ${r.leak} ${plural(r.leak, 'раз', 'раза', 'раз')}` : ''}</span> <a data-fact="geo_subspecies">?</a></div>`;
}

/** Ход моря и льда по истории мира (SVG, без холста). */
function cycleChart(w: World): string {
  const h = w.history.filter((s) => s.sea !== undefined);
  if (h.length < 2) return '<p class="muted small">График появится через минуту.</p>';
  const W = 300, H = 70, t0 = h[0].tick, t1 = h[h.length - 1].tick || 1;
  const X = (t: number) => (((t - t0) / Math.max(1, t1 - t0)) * W).toFixed(1);
  const Ys = (m: number) => (H * 0.5 - (m / 150) * H * 0.45).toFixed(1);
  const Yi = (v: number) => (H - v * H * 1.6).toFixed(1);
  const step = Math.max(1, Math.floor(h.length / 150));
  let ps = '', pi = '';
  for (let k = 0; k < h.length; k += step) {
    ps += `${X(h[k].tick)},${Ys(h[k].sea!)} `;
    pi += `${X(h[k].tick)},${Yi(h[k].ice ?? 0)} `;
  }
  return `<svg class="gp-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Море и лёд"><line x1="0" x2="${W}" y1="${Ys(0)}" y2="${Ys(0)}" class="gp-zero"/><polyline points="${pi}" class="gp-ice"/><polyline points="${ps}" class="gp-sea"/></svg>
    <div class="s-legend small"><span><b class="gp-k sea"></b>море (0 — нынешний берег)</span><span><b class="gp-k ice"></b>лёд на суше</span></div>`;
}

/** Разметка вкладки «🌋 Планета». */
export function geoPanelHtml(w: World): string {
  const g = w.geo;
  if (!w.lp || !g) return '<p class="muted">Этот мир — без живой планеты. Включите «🌋 Живая планета» в меню ▾ у «↻ Новый мир».</p>';
  const t = w.terrain, sp = (id: number) => esc(w.species.all.get(id)?.name ?? `вид ${id}`);
  const out: string[] = [];
  out.push(`<h4>Ледниковые циклы <a data-fact="geo_iceage">?</a></h4>${cycleChart(w)}
    <p class="small">Море ${sea(metres(g.seaQ))} · лёд на ${Math.round(100 * g.iceLand)}% суши · CO₂ ${Math.round(g.co2)} ppm · ледниковий: ${g.stats.glacials} · ≈ ${Math.round(geoKyr(g)).toLocaleString('ru-RU')} тыс. лет <a data-fact="geo_timescale">?</a></p>`);
  // 🌍 остров спустился с планеты: её эпоха, CO₂ и луна задают ритм
  if (g.iceAge !== null) {
    const ep = g.iceAge === 0 ? '🌴 тёплая эпоха — ледниковий нет, море выше' : g.iceAge === 1 ? '❄️ ледниковая эпоха — циклы идут' : '🧊 эпоха вечного льда — лёд не уходит';
    const moon = g.amps[1] > 0.6 ? ' · 🌑 без большой луны: наклон оси качается сильнее' : '';
    out.push(`<p class="small">🌍 Планета: ${ep} · естественный CO₂ ${g.co2Base} ppm${moon} <a data-fact="geo_icehouse">?</a>${moon ? ' <a data-fact="geo_moonclimate">?</a>' : ''}</p>`);
  }
  // проливы и мосты
  const rows = g.sills.map((s, si) => {
    const kind = s.kind === 'sill' ? 'мелкий порог (сохнет в ледниковье)' : s.kind === 'wallace' ? 'пролив Уоллеса (глубокий всегда)' : 'пролив игрока';
    const br = [...g.bridges].reverse().find((b) => b.sill === si && b.close === null);
    const [a, b] = sideWords(s, true);
    const cross = br ? ` · с ${a} ⟶ ${br.cross[0]}, с ${b} ⟵ ${br.cross[1]}${br.fly ? `, летунов ${br.fly}` : ''}` : '';
    return `<li><b>${s.open ? '🌉 перешеек' : '🌊 пролив'} ${esc(s.name)}</b> <span class="muted small">— ${kind}${cross}</span></li>`;
  });
  out.push(`<h4>Проливы и мосты <a data-fact="geo_landbridge">?</a> <a data-fact="geo_wallace">?</a></h4><ul class="gp-list">${rows.join('') || '<li class="muted">Проливов нет (стенд без порогов)</li>'}</ul>`);
  // половины видов
  const iso = [...g.isolates].sort((x, y) => y.ga - x.ga).slice(0, 8);
  out.push(`<h4>Половины видов <a data-fact="geo_vicariance">?</a></h4>${iso.length ? `<ul class="gp-list">${iso.map((r) => {
    const s = g.sills[r.sill];
    const k = Math.min(1, r.ga / GEO.ISO_GEN);
    return `<li><b>${sp(r.sp)}</b> <span class="muted small">— пролив ${esc(s?.name ?? '?')}: ${r.parts[0]} и ${r.parts[1]} особей</span><div class="gp-gauge"><div class="gp-bar"><i style="width:${Math.round(100 * k)}%"></i></div><span>поколений врозь ${r.ga}/${GEO.ISO_GEN} · гены разошлись ${Math.round(100 * r.d)}% (нужно ${Math.round(100 * GEO.ISO_D)}%)${r.leak ? ` · 🔀 смешивались ${r.leak}` : ''}</span></div></li>`;
  }).join('')}</ul>` : '<p class="muted small">Сейчас ни один вид не живёт по обе стороны закрытого пролива.</p>'}
    <p class="muted small">Видов от викарианса: ${g.stats.vicariance} · утечек генов через проливы: ${g.stats.leaks} <a data-fact="geo_hybrid">?</a></p>`);
  // рефугиумы
  if (g.refugia && g.refugia.length)
    out.push(`<h4>Рефугиумы последнего пика <a data-fact="geo_refugia">?</a></h4><ul class="gp-list">${g.refugia.map((r) => `<li><b>${esc(t.regions[r.region]?.name ?? 'безымянный край')}</b> <span class="muted small">— ${r.n} зверей, ${r.species.length} ${plural(r.species.length, 'вид', 'вида', 'видов')}: ${r.species.slice(0, 4).map(sp).join(', ')}${r.species.length > 4 ? '…' : ''}</span></li>`).join('')}</ul><button data-glens="refugia">🔬 Линза «🏔 Рефугиумы»</button>`);
  // великий обмен
  const rep = g.bridges.filter((b) => b.invaders.some((v) => v.t >= 0) || b.lost.length || b.reported).slice(-3).reverse();
  if (rep.length)
    out.push(`<h4>Обмен через мосты <a data-fact="geo_gabi">?</a></h4><ul class="gp-list">${rep.map((b) => {
      const s = g.sills[b.sill];
      const est = b.invaders.filter((v) => v.t >= 0);
      const [a, bb] = s ? sideWords(s, true) : ['одной стороны', 'другой'];
      return `<li><b>${esc(s?.name ?? '?')}</b> <span class="muted small">(с такта ${b.open}${b.close !== null ? ` по ${b.close}` : ''})</span>: прижились с ${a} ${est.filter((v) => v.from === 0).length}, с ${bb} ${est.filter((v) => v.from === 1).length}${est.length ? ` — ${est.slice(0, 3).map((v) => sp(v.sp)).join(', ')}` : ''}; вымерли местных: ${b.lost.length}</li>`;
    }).join('')}</ul>`);
  // ☄️🌋 катастрофы: что сейчас в небе, история, итог «год спустя»
  {
    const now: string[] = [];
    if (g.dark > 0.02) now.push(`🌑 темно — света ${Math.round(100 * (1 - g.dark))}% <a data-fact="geo_impactwinter">?</a>`);
    if (g.aer > 0.02) now.push(`🌫 дымка: ${(-0.12 * g.aer * 100 / 3).toFixed(1).replace('.', ',')} °C <a data-fact="geo_volcwinter">?</a>`);
    if (g.fire.length) now.push(`🔥 горит ${g.fire.length / 2} клеток${g.fireEp ? `, выгорело ${g.fireEp.n}` : ''} <a data-fact="geo_fire">?</a>`);
    if (w.tick < g.isolatedUntil) now.push(`⛵ остров отрезан ещё ${((g.isolatedUntil - w.tick) / 6000).toFixed(1).replace('.', ',')} г. <a data-fact="geo_islandiso">?</a>`);
    const S = g.stats, ls = g.lastSum;
    const sum = ls ? `<p class="small">Год после катастрофы: исчезло ${ls.k} из ${ls.N} ${plural(ls.N, 'вида', 'видов', 'видов')}${ls.m0 > 0 ? ` · медиана размера травоядных ${ls.m0.toFixed(1).replace('.', ',')} → ${ls.m1 > 0 ? ls.m1.toFixed(1).replace('.', ',') : 'нет травоядных'}` : ''} · зверей ${ls.n0} → ${ls.n1} <a data-fact="lilliput">?</a></p>` : '';
    if (g.cats.length || now.length)
      out.push(`<h4>Катастрофы <a data-fact="geo_bigfive">?</a></h4>${now.length ? `<p class="small">${now.join(' · ')}</p>` : ''}<ul class="gp-list">${[...g.cats].reverse().slice(0, 6).map((c) => `<li class="small">${esc(c.text)} <span class="muted">(год ${Math.floor(c.t / 6000) + 1})</span></li>`).join('')}</ul>${sum}<p class="muted small">Извержений: ${S.eruptions} · ударов: ${S.impacts} · пожаров: ${S.fires} · массовых вымираний: ${S.massExt}</p>`);
  }
  // 🧭 плиты и дождевая тень
  if (g.plate || g.shadow) {
    let dry = 0, land = 0;
    const K = t.moistK;
    if (K) for (let i = 0; i < K.length; i++) if (t.biome[i] > 1) { land++; if (K[i] < 0.85) dry++; }
    out.push(`<h4>Плиты и горы <a data-fact="geo_plates">?</a> <a data-fact="geo_orogeny">?</a> <a data-fact="geo_rainshadow">?</a></h4><p class="small">${plateText(w)}${K && land ? ` · суши в дождевой тени (влажность −15% и больше): ${Math.round((100 * dry) / land)}%` : ''}</p>`);
  }
  // следы льда
  const lakes = t.lakes;
  out.push(`<h4>Следы ледников <a data-fact="geo_moraine">?</a> <a data-fact="geo_kettle">?</a></h4><p class="small">Морен: ${g.stats.moraines} клеток · котловин: ${g.stats.kettles} · озёр сейчас: ${lakes.length}${lakes.length ? ` (${lakes.slice(0, 4).map((l) => esc(l.name)).join(', ')}${lakes.length > 4 ? '…' : ''})` : ''}</p>`);
  return out.join('');
}
