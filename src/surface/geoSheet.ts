// 🌋 «🛠 Стихии» живой планеты: на компьютере — всплывающая панель у инструментов, на телефоне — шторка снизу.
// Этап 1a — вкладка «Климат»: CO₂, ледниковья, уровень моря, скорость геологии. Всё — действиями мира (их пишет
// машина времени), сама панель мир не меняет и ссылку на w.geo не держит (loadWorld заменяет его целиком).
import { co2Shift, geoKyr, metres } from '../sim/geo';
import type { ActionInput } from '../sim/timeline';
import { CLIMATE_C, type World } from '../sim/world';

export interface GeoSheetHost {
  world: World;
  act(a: ActionInput): void;
  showFact(id: string): void;
}

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
  return `<span class="s-chip s-geo" title="${tip}"><i class="g-full">${dT < 0 ? '❄️' : '🌡'} ${dT === 0 ? '0' : signC(dT)} °C · 🌊 ${seaTxt} м · 🧊 ${ice}% · CO₂ ${Math.round(g.co2)} · ≈ ${kyr.toLocaleString('ru-RU')} тыс. лет${g.speed === 4 ? ' · ⏩×4' : ''}</i><i class="g-short">🧊${ice}% 🌊${seaTxt}м</i></span>`;
}

export class GeoSheet {
  /** Ползунки, которые игрок сейчас тянет (не перерисовывать их значение). */
  private dragging = new Set<string>();

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
    this.el.innerHTML = `<div class="gs-head"><nav class="gs-tabs"><button class="active" data-gt="climate">🌡 Климат</button></nav><button class="x" data-g="close" title="Закрыть">✕</button></div>
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
    const b = t.closest('button[data-g]') as HTMLElement | null;
    if (!b) return;
    const k = b.dataset.g, v = b.dataset.v ?? '';
    if (k === 'close') return this.close();
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

/** Шкала CO₂ 150…1500 ppm — логарифмическая (как и парниковый эффект): ползунок в тысячных долях ln(ppm). */
const LO = Math.round(1000 * Math.log(150)), HI = Math.round(1000 * Math.log(1500));
const toSlider = (ppm: number) => Math.min(HI, Math.max(LO, Math.round(1000 * Math.log(ppm))));
const fromSlider = (v: number) => Math.round(Math.exp(v / 1000) / 10) * 10;
/** Где на шкале CO₂ метка, %. */
const tickPos = (ppm: number) => ((1000 * Math.log(ppm) - LO) / (HI - LO)) * 100;
