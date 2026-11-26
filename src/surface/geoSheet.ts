// 🌋 «🛠 Стихии» живой планеты: на компьютере — всплывающая панель у инструментов, на телефоне — шторка снизу.
// Этап 1a — вкладка «Климат»: CO₂, ледниковья, уровень моря, скорость геологии. Всё — действиями мира (их пишет
// машина времени), сама панель мир не меняет и ссылку на w.geo не держит (loadWorld заменяет его целиком).
import { beringiaLine, co2Shift, geoKyr, metres, panamaLine } from '../sim/geo';
import type { ActionInput } from '../sim/timeline';
import { CLIMATE_C, type World } from '../sim/world';

/** Инструменты «Земли»: кисть ⬆/⬇, ✂️ глубокий и мелкий пролив, 🌉 перешеек (рисуются на карте). */
export type GeoTool = 'terraUp' | 'terraDown' | 'strait' | 'straitS' | 'isthmus' | 'volcano' | 'impact' | 'tsunami' | 'fire';

export interface GeoSheetHost {
  world: World;
  act(a: ActionInput): void;
  showFact(id: string): void;
  /** Текущий инструмент карты и выбор инструмента «Земли» (null — обратно 🔍). */
  tool(): string;
  setTool(t: GeoTool | null): void;
  toast(text: string): void;
}

const TOOL_HINT: Record<GeoTool, string> = {
  terraUp: '⬆ Водите по карте — суша поднимается (до +900 м)',
  terraDown: '⬇ Водите по карте — суша опускается; ниже моря — вода',
  strait: '✂️ Проведите линию поперёк суши — глубокий пролив, как у Уоллеса: пешком не перейти никогда',
  straitS: '✂️ Проведите линию поперёк суши — мелкий пролив: в ледниковье он осохнет и станет мостом',
  isthmus: '🌉 Проведите линию поперёк пролива — от берега до берега',
  volcano: '🌋 Нажмите на карту — проснётся ближайший вулкан (горы или горячий источник)',
  impact: '☄️ Нажмите на карту — туда упадёт астероид',
  tsunami: '🌊 Нажмите на море у берега — оттуда придёт волна',
  fire: '🔥 Нажмите на траву или лес — огонь пойдёт по ветру на восток',
};

const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;

/** Силы «Неба»: выбранные в шторке (их читает карта при нажатии). */
export const SKY = { vei: 8 as 6 | 7 | 8, size: 3 as 1 | 2 | 3 };
const VEI_TIP: Record<number, string> = { 6: 'VEI 6 — как Пинатубо 1991: дымка на год, −0,5 °C', 7: 'VEI 7 — как Тамбора 1815: «год без лета»', 8: 'VEI 8 — супервулкан, как Тоба: пепел на 1600 км' };
const SIZE_TIP: Record<number, string> = { 1: 'Метеорит — выжженный круг', 2: 'Большой астероид — тёмное небо, пожары', 3: 'Как Чиксулуб 66 млн лет назад: ударная зима, мировые пожары, массовое вымирание' };

/** Сдвиг температуры острова, целые °C («0» без знака). */
const tC = (w: World) => {
  const v = Math.round((w.climate.shift + (w.geo?.geoShift ?? 0)) * CLIMATE_C);
  return v === 0 ? '0' : signC(v);
};
const signC = (v: number, d = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d).replace('.', ',')}`;

/** Что сейчас с ледниками — словами (для панели и подсказки чипа). */
export function geoPhaseText(w: World): string {
  const g = w.geo;
  if (!g) return '';
  if (g.fPin !== null) return g.fPin < 0 ? '❄️ ледниковье по вашей воле' : '💧 тепло по вашей воле';
  if (!g.orbit) return '⏹ орбита не раскачивает климат';
  if (g.phase === 1) return g.dGsign >= 0 ? '❄️ наступает ледниковье' : '🧊 пик ледниковья';
  if (g.phase === 2) return '💧 ледники тают';
  return g.dGsign > 0 && g.Vg > 0.05 ? '🌥 холодает' : '☀️ межледниковье';
}

/** Чип HUD живой планеты: сумма климата и геологии, море, лёд, CO₂, геологическое время; на телефоне — коротко. */
export function geoChip(w: World): string {
  const g = w.geo;
  if (!g) return '';
  const dT = Math.round((w.climate.shift + g.geoShift) * CLIMATE_C);
  const sea = metres(g.seaQ), ice = Math.round(g.iceLand * 100), kyr = Math.round(geoKyr(g) / 10) * 10;
  const seaTxt = `${sea > 0 ? '+' : sea < 0 ? '−' : ''}${Math.abs(sea)}`;
  const tip = `${geoPhaseText(w)} · нажмите — «🛠 Стихии → Климат»`;
  // ☄️🌋 пока действуют: темнота, дымка, пожар, закрытый остров
  const st = `${g.dark > 0.02 ? '🌑' : ''}${g.aer > 0.05 ? '🌫' : ''}${g.fire.length ? '🔥' : ''}${w.tick < g.isolatedUntil ? '⛵' : ''}`;
  return `<span class="s-chip s-geo" title="${tip}"><i class="g-full">${st ? st + ' · ' : ''}${dT < 0 ? '❄️' : '🌡'} ${dT === 0 ? '0' : signC(dT)} °C · 🌊 ${seaTxt} м · 🧊 ${ice}% · CO₂ ${Math.round(g.co2)} · ≈ ${kyr.toLocaleString('ru-RU')} тыс. лет${g.speed === 4 ? ' · ⏩×4' : ''}</i><i class="g-short">${st}🧊${ice}% 🌊${seaTxt}м</i></span>`;
}

export class GeoSheet {
  /** Ползунки, которые игрок сейчас тянет (не перерисовывать их значение). */
  private dragging = new Set<string>();
  /** Открытая вкладка шторки. */
  private tab: 'land' | 'sky' | 'climate' = 'climate';

  constructor(private el: HTMLElement, private host: GeoSheetHost) {
    el.addEventListener('click', (e) => this.click(e));
    el.addEventListener('input', (e) => this.input(e));
    el.addEventListener('change', (e) => this.change(e));
    el.addEventListener('pointerdown', (e) => {
      const r = (e.target as HTMLElement).closest('input[type=range]') as HTMLInputElement | null;
      if (r) this.dragging.add(r.dataset.g!);
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    if (!this.host.world.lp) return;
    this.el.hidden = false;
    this.render();
  }

  close(): void {
    this.el.hidden = true;
    this.dragging.clear();
  }

  /** Полная разметка (при открытии и после поступка). */
  render(): void {
    const w = this.host.world, g = w.geo;
    if (!g || !w.lp) return this.close();
    const ppm = g.co2Pin ?? Math.round(g.co2);
    const mode = g.fPin !== null ? (g.fPin < 0 ? 'now' : 'end') : g.orbit ? 'cycle' : 'off';
    const b = (k: string, v: string, label: string, on: boolean, tip: string) =>
      `<button data-g="${k}" data-v="${v}" class="${on ? 'active' : ''}" title="${tip}">${label}</button>`;
    const head = `<div class="gs-head"><nav class="gs-tabs"><button class="${this.tab === 'land' ? 'active' : ''}" data-gt="land">⛰ Земля</button><button class="${this.tab === 'sky' ? 'active' : ''}" data-gt="sky">🌋 Небо</button><button class="${this.tab === 'climate' ? 'active' : ''}" data-gt="climate">🌡 Климат</button></nav><button class="x" data-g="close" title="Закрыть">✕</button></div>`;
    if (this.tab === 'land') {
      const tb = (t: GeoTool, label: string) => `<button data-gtool="${t}" class="${this.host.tool() === t ? 'active' : ''}" title="${TOOL_HINT[t]}">${label}</button>`;
      const sills = g.sills.map((s) => `<li>${s.open ? '🌉' : '🌊'} <b>${s.name}</b> <span class="muted small">${s.kind === 'sill' ? 'мелкий порог' : s.kind === 'wallace' ? 'пролив Уоллеса' : 'пролив игрока'} — ${s.open ? 'сейчас перешеек' : 'сейчас пролив'}</span></li>`).join('');
      this.el.innerHTML = `${head}<div class="gs-body">
        <div class="gs-row"><b>🏔 Рельеф</b> <a data-fact="geo_bathymetry">?</a></div>
        <div class="gs-btns">${tb('terraUp', '⬆ Поднять')}${tb('terraDown', '⬇ Опустить')}</div>
        <div class="gs-row"><b>✂️ Проливы и мосты</b> <a data-fact="geo_wallace">?</a> <a data-fact="geo_landbridge">?</a></div>
        <div class="gs-btns">${tb('strait', '✂️ Глубокий пролив')}${tb('straitS', '✂️ Мелкий пролив')}${tb('isthmus', '🌉 Перешеек')}</div>
        <div class="gs-btns"><button data-g="beringia" title="Мелкий пролив во всю ширину на севере острова: в межледниковье — море, в ледниковье — мост, как Берингия">🗺 Берингия</button><button data-g="panama" title="Перешеек через пролив Уоллеса — две давно разделённые фауны встретятся, как в Панаме">🌉 Опыт «Панама»</button> <a data-fact="geo_gabi">?</a></div>
        <div class="gs-tip muted small">${TOOL_HINT[(this.host.tool() as GeoTool)] ?? 'Выберите инструмент и нарисуйте на карте. Рельеф меняется с началом следующего шага; всё можно отменить.'}</div>
        <ul class="gs-sills">${sills}</ul>
      </div>`;
      return;
    }
    if (this.tab === 'sky') {
      const tb = (t: GeoTool, label: string) => `<button data-gtool="${t}" class="${this.host.tool() === t ? 'active' : ''}" title="${TOOL_HINT[t]}">${label}</button>`;
      const pick = (k: 'vei' | 'size', v: number, label: string, tip: string) => `<button data-g="${k}" data-v="${v}" class="${SKY[k] === v ? 'active' : ''}" title="${tip}">${label}</button>`;
      this.el.innerHTML = `${head}<div class="gs-body">
        <div class="gs-row"><b>🌋 Вулкан</b> <a data-fact="geo_supervolcano">?</a> <a data-fact="geo_volcwinter">?</a></div>
        <div class="gs-btns">${tb('volcano', '🌋 Извержение')}${pick('vei', 6, 'VEI 6', VEI_TIP[6])}${pick('vei', 7, 'VEI 7', VEI_TIP[7])}${pick('vei', 8, 'VEI 8', VEI_TIP[8])}</div>
        <div class="gs-row"><b>☄️ Астероид</b> <a data-fact="geo_impactwinter">?</a> <a data-fact="geo_bigfive">?</a></div>
        <div class="gs-btns">${tb('impact', '☄️ Удар')}${pick('size', 1, 'малый', SIZE_TIP[1])}${pick('size', 2, 'большой', SIZE_TIP[2])}${pick('size', 3, 'K–Pg', SIZE_TIP[3])}</div>
        <div class="gs-row"><b>🌊 Цунами и 🔥 пожар</b> <a data-fact="geo_tsunami">?</a> <a data-fact="geo_fire">?</a></div>
        <div class="gs-btns">${tb('tsunami', '🌊 Цунами')}${tb('fire', '🔥 Пожар')}</div>
        <div class="gs-tip muted small">${TOOL_HINT[(this.host.tool() as GeoTool)] ?? 'Выберите силу и нажмите на карту. Всё можно отменить или перемотать назад.'}</div>
        <div class="gs-now small"></div>
      </div>`;
      this.update();
      return;
    }
    this.el.innerHTML = `${head}
      <div class="gs-body">
        <div class="gs-row"><b>🏭 CO₂</b> <span class="gs-co2v"></span> <a data-fact="geo_co2">?</a></div>
        <input type="range" data-g="co2" min="${LO}" max="${HI}" step="1" value="${toSlider(ppm)}" aria-label="CO₂, ppm">
        <div class="gs-ticks"><span style="left:${tickPos(190)}%" title="ледниковье">❄190</span><span style="left:${tickPos(280)}%" title="до заводов">280</span><span style="left:${tickPos(420)}%" title="сегодня">420</span><span style="left:${tickPos(1000)}%">1000</span></div>
        <div class="gs-legend muted small">❄190 — ледниковье · 280 — до заводов · 420 — сегодня</div>
        <div class="gs-btns">${b('co2nat', '', '🌿 Как у природы', g.co2Pin === null, 'CO₂ следует за ледниками: 190 ppm в холод, 280 в тепло')}</div>
        <div class="gs-row"><b>🧊 Ледниковья</b> <span class="gs-phase muted small"></span> <a data-fact="geo_iceage">?</a></div>
        <div class="gs-btns">${b('ice', 'now', '❄️ Сейчас', mode === 'now', 'Холод держится, пока его не отменить')}${b('ice', 'end', '💧 Конец', mode === 'end', 'Тепло держится — лёд тает')}${b('ice', 'cycle', '🔁 Циклы', mode === 'cycle', 'Ледниковья приходят и уходят по орбите: 100, 41 и 23 тыс. лет')}${b('ice', 'off', '⏹ Выкл', mode === 'off', 'Орбита больше не раскачивает климат')}</div>
        <div class="gs-row"><b>🌊 Море</b> <span class="gs-seav"></span> <a data-fact="geo_sealevel">?</a></div>
        <input type="range" data-g="sea" min="-150" max="80" step="10" value="${g.seaPin}" aria-label="Море к ледникам, м">
        <div class="gs-btns">${b('seanat', '', '🌿 Как у природы', g.seaPin === 0, 'Уровень моря — только от льда всей планеты')}</div>
        <div class="gs-row"><b>⏩ Геология</b> <a data-fact="geo_timescale">?</a></div>
        <div class="gs-btns">${b('speed', '1', '×1 · цикл ≈ 8 лет', g.speed === 1, 'Год острова ≈ 12 тыс. лет')}${b('speed', '4', '×4 · цикл ≈ 2 года', g.speed === 4, 'Орбита и ледники вчетверо быстрее, эволюция — нет')}</div>
        <div class="gs-now small"></div>
      </div>`;
    this.update();
  }

  /** Живые числа (4 раза в секунду): не трогает ползунки, пока их тянут. */
  update(): void {
    if (!this.open) return;
    const w = this.host.world, g = w.geo;
    if (!g || !w.lp) return this.close();
    if (this.tab === 'land' || this.tab === 'sky') {
      // кнопки инструментов — по выбору на карте (его меняют и кнопки 🔍 🌱 …)
      this.el.querySelectorAll<HTMLElement>('button[data-gtool]').forEach((x) => x.classList.toggle('active', x.dataset.gtool === this.host.tool()));
      const tip = this.el.querySelector<HTMLElement>('.gs-tip');
      const txt = TOOL_HINT[this.host.tool() as GeoTool] ?? (this.tab === 'sky' ? 'Выберите силу и нажмите на карту. Всё можно отменить или перемотать назад.' : 'Выберите инструмент и нарисуйте на карте. Рельеф меняется с началом следующего шага; всё можно отменить.');
      if (tip && tip.textContent !== txt) tip.textContent = txt;
      if (this.tab === 'sky') {
        const now = this.el.querySelector<HTMLElement>('.gs-now');
        const html = skyNow(w);
        if (now && now.innerHTML !== html) now.innerHTML = html;
        return;
      }
      const ul = this.el.querySelector<HTMLElement>('.gs-sills');
      const html = g.sills.map((s) => `<li>${s.open ? '🌉' : '🌊'} <b>${s.name}</b> <span class="muted small">${s.kind === 'sill' ? 'мелкий порог' : s.kind === 'wallace' ? 'пролив Уоллеса' : 'пролив игрока'} — ${s.open ? 'сейчас перешеек' : 'сейчас пролив'}</span></li>`).join('');
      if (ul && ul.innerHTML !== html) ul.innerHTML = html;
      return;
    }
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector<T>(s);
    const co2 = q<HTMLInputElement>('input[data-g=co2]');
    const sea = q<HTMLInputElement>('input[data-g=sea]');
    const ppm = co2 && this.dragging.has('co2') ? fromSlider(Number(co2.value)) : g.co2Pin ?? Math.round(g.co2);
    if (co2 && !this.dragging.has('co2')) co2.value = String(toSlider(ppm));
    const dm = sea && this.dragging.has('sea') ? Number(sea.value) : g.seaPin;
    if (sea && !this.dragging.has('sea')) sea.value = String(g.seaPin);
    const set = (s: string, html: string) => {
      const e = q(s);
      if (e && e.innerHTML !== html) e.innerHTML = html;
    };
    set('.gs-co2v', `${ppm} ppm → ${signC(co2Shift(ppm) * CLIMATE_C, 1)} °C${g.co2Pin === null && !this.dragging.has('co2') ? ' <em>(как у природы)</em>' : ''}`);
    set('.gs-seav', dm === 0 ? 'как у природы' : `${dm > 0 ? '+' : '−'}${Math.abs(dm)} м к ледникам`);
    set('.gs-phase', geoPhaseText(w));
    // кнопки — по состоянию мира (оно меняется и перемоткой, и уроками)
    const mode = g.fPin !== null ? (g.fPin < 0 ? 'now' : 'end') : g.orbit ? 'cycle' : 'off';
    this.el.querySelectorAll<HTMLElement>('button[data-g]').forEach((x) => {
      const k = x.dataset.g, v = x.dataset.v;
      const on = k === 'co2nat' ? g.co2Pin === null : k === 'seanat' ? g.seaPin === 0 : k === 'ice' ? v === mode : k === 'speed' ? Number(v) === g.speed : false;
      x.classList.toggle('active', on);
    });
    const s = metres(g.seaQ);
    set('.gs-now', `Сейчас: море ${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(s)} м · лёд на ${Math.round(g.iceLand * 100)}% суши · остров ${tC(w)} °C · ледниковий: ${g.stats.glacials} · ≈ ${Math.round(geoKyr(g)).toLocaleString('ru-RU')} тыс. лет`);
  }

  private click(e: Event): void {
    const t = e.target as HTMLElement;
    const f = t.closest('[data-fact]') as HTMLElement | null;
    if (f) return this.host.showFact(f.dataset.fact!);
    const tabB = t.closest('button[data-gt]') as HTMLElement | null;
    if (tabB) {
      this.tab = tabB.dataset.gt === 'land' ? 'land' : tabB.dataset.gt === 'sky' ? 'sky' : 'climate';
      return this.render();
    }
    const tl = t.closest('button[data-gtool]') as HTMLElement | null;
    if (tl) {
      const want = tl.dataset.gtool as GeoTool;
      this.host.setTool(this.host.tool() === want ? null : want);
      if (this.host.tool() === want) this.host.toast(TOOL_HINT[want]);
      // на телефоне шторка закрывает карту: силы «Неба» ставятся одним нажатием — шторку убираем
      if (this.tab === 'sky' && this.host.tool() === want && narrow()) return this.close();
      return this.update();
    }
    const b = t.closest('button[data-g]') as HTMLElement | null;
    if (!b) return;
    const k = b.dataset.g, v = b.dataset.v ?? '';
    if (k === 'close') return this.close();
    if (k === 'vei' || k === 'size') {
      if (k === 'vei') SKY.vei = Number(v) as 6 | 7 | 8;
      else SKY.size = Number(v) as 1 | 2 | 3;
      const want: GeoTool = k === 'vei' ? 'volcano' : 'impact';
      if (this.host.tool() !== want) this.host.setTool(want);
      this.host.toast(`${k === 'vei' ? VEI_TIP[SKY.vei] : SIZE_TIP[SKY.size]} — ${TOOL_HINT[want].slice(3).toLowerCase()}`);
      if (narrow()) return this.close();
      return this.render();
    }
    if (k === 'beringia') {
      this.host.act({ k: 'strait', pts: beringiaLine(this.host.world), deep: false });
      return this.render();
    }
    if (k === 'panama') {
      const pts = panamaLine(this.host.world);
      if (pts) this.host.act({ k: 'isthmus', pts });
      else this.host.toast('🌉 Пролив Уоллеса уже перекрыт — или его нет в этом мире');
      return this.render();
    }
    if (k === 'co2nat') this.host.act({ k: 'co2', ppm: null });
    else if (k === 'seanat') this.host.act({ k: 'sea', dm: 0 });
    else if (k === 'ice') this.host.act({ k: 'iceAge', mode: v as 'cycle' | 'now' | 'end' | 'off' });
    else if (k === 'speed') this.host.act({ k: 'geoSpeed', v: v === '4' ? 4 : 1 });
    this.render();
  }

  private input(e: Event): void {
    const r = e.target as HTMLInputElement;
    if (r.type !== 'range') return;
    this.dragging.add(r.dataset.g!);
    this.update();
  }

  /** Ползунок отпущен — один поступок. */
  private change(e: Event): void {
    const r = e.target as HTMLInputElement;
    if (r.type !== 'range') return;
    this.dragging.delete(r.dataset.g!);
    const v = Number(r.value);
    const g = this.host.world.geo;
    if (!g) return;
    if (r.dataset.g === 'co2' && fromSlider(v) !== g.co2Pin) this.host.act({ k: 'co2', ppm: fromSlider(v) });
    if (r.dataset.g === 'sea' && v !== g.seaPin) this.host.act({ k: 'sea', dm: v });
    this.render();
  }
}

/** Строка «сейчас» вкладки «Небо»: дымка, темнота, огонь, закрытый остров. */
export function skyNow(w: World): string {
  const g = w.geo;
  if (!g) return '';
  const p: string[] = [];
  if (g.dark > 0.02) p.push(`🌑 темно: света ${Math.round(100 * (1 - g.dark))}%`);
  if (g.aer > 0.02) p.push(`🌫 дымка: ${signC(-0.12 * g.aer * CLIMATE_C, 1)} °C`);
  if (g.fire.length) p.push(`🔥 горит ${g.fire.length / 2} клеток`);
  if (w.tick < g.isolatedUntil) p.push(`⛵ остров отрезан ещё ${((g.isolatedUntil - w.tick) / 6000).toFixed(1).replace('.', ',')} г.`);
  const S = g.stats;
  return `${p.length ? p.join(' · ') : 'Небо чистое'} · извержений: ${S.eruptions} · ударов: ${S.impacts} · пожаров: ${S.fires} · массовых вымираний: ${S.massExt}`;
}

/** Шкала CO₂ 150…1500 ppm — логарифмическая (как и парниковый эффект): ползунок в тысячных долях ln(ppm). */
const LO = Math.round(1000 * Math.log(150)), HI = Math.round(1000 * Math.log(1500));
const toSlider = (ppm: number) => Math.min(HI, Math.max(LO, Math.round(1000 * Math.log(ppm))));
const fromSlider = (v: number) => Math.round(Math.exp(v / 1000) / 10) * 10;
/** Где на шкале CO₂ метка, %. */
const tickPos = (ppm: number) => ((1000 * Math.log(ppm) - LO) / (HI - LO)) * 100;
