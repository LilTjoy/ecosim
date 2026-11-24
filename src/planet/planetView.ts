import { clamp } from '../lib/random';
import { drawGases, drawTemperature, drawTimeline, STAGE_COLORS, xToTime } from './charts';
import type { SurfaceEnv } from '../sim/world';
import { FACTS, FIELD_ICON, WORLD_FACTS, type Fact } from './facts';
import { Globe } from './globe';
import {
  EARTH,
  luminosity0,
  PRESETS,
  randomPlanet,
  simulate,
  STAGE_NAMES,
  STAR_INFO,
  STEP_INFO,
  type Assumptions,
  type PlanetParams,
  type SimResult,
} from './model';

const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;

export const fmtAge = (t: number) => (t < 1 ? `${Math.round(t * 1000)} млн лет` : `${t.toFixed(2).replace('.', ',')} млрд лет`);

const TEMPLATE = /* html */ `
<div class="p-layout">
  <section class="p-stage">
    <div class="p-globe"></div>
    <div class="p-hud">
      <div class="p-age"></div>
      <div class="p-stagename"></div>
      <div class="p-metrics"></div>
    </div>
    <div class="p-star"></div>
    <button class="p-descend primary" hidden>🦊 Спуститься на поверхность</button>
    <div class="p-fact" hidden></div>
    <div class="p-controls">
      <button class="p-play" title="Пробел">▶</button>
      <select class="p-speed" title="Скорость проигрывания">
        <option value="0.1">0,1 млрд/с</option>
        <option value="0.3" selected>0,3 млрд/с</option>
        <option value="1">1 млрд/с</option>
      </select>
      <canvas class="p-timeline" title="Перетащите, чтобы перемотать историю"></canvas>
      <label class="p-explain" title="Показывать научные карточки и ставить паузу"><input type="checkbox" checked> 💡</label>
    </div>
  </section>
  <aside class="p-panel">
    <div class="p-buttons">
      <button data-act="earth">🌍 Земля</button>
      <button data-act="random">🎲 Случайный мир</button>
      <button data-act="replay" title="Те же условия, другой ход случайностей">🔁 Переиграть историю</button>
      <button data-act="compare" title="Показать этот мир рядом с Землёй, Марсом и Венерой">🌍 Сравнить с соседями</button>
    </div>
    <details class="p-params" open>
      <summary>Параметры мира <span class="p-seed"></span></summary>
      <label>Звезда <output data-out="star"></output><input type="range" data-p="starMass" min="0.1" max="1.5" step="0.01"></label>
      <label>Тепло от звезды (Земля = 1) <output data-out="flux"></output><input type="range" data-p="flux" min="0.2" max="2.5" step="0.01"></label>
      <label>Масса планеты (Земля = 1) <output data-out="mass"></output><input type="range" data-p="mass" min="0.1" max="5" step="0.05"></label>
      <label>Вода (земных океанов) <output data-out="water"></output><input type="range" data-p="water" min="-2" max="1.5" step="0.05"></label>
      <label>Спутник (Луна = 1) <output data-out="moon"></output><input type="range" data-p="moon" min="0" max="2" step="0.05"></label>
      <div class="p-row">
        <label class="check"><input type="checkbox" data-p="giant"> Гигант-щит (как Юпитер)</label>
        <select data-p="tectonics">
          <option value="auto">Тектоника: как повезёт</option>
          <option value="on">Тектоника: есть</option>
          <option value="off">Тектоника: нет</option>
        </select>
      </div>
      <label>Допущения о жизни
        <select data-p="preset">
          <option value="pessimist">${PRESETS.pessimist.name}</option>
          <option value="realist" selected>${PRESETS.realist.name}</option>
          <option value="optimist">${PRESETS.optimist.name}</option>
        </select>
      </label>
      <div class="p-facts"></div>
    </details>
    <h3>Лестница жизни</h3>
    <ol class="p-ladder"></ol>
    <h3>Температура</h3>
    <canvas class="p-chart p-temp"></canvas>
    <h3>Атмосфера <small><span style="color:#64b5f6">● O₂</span> <span style="color:#d4a373">● CO₂</span> <span style="color:#5b8fd6">■ океаны</span></small></h3>
    <canvas class="p-chart p-gas"></canvas>
    <h3>Летопись планеты</h3>
    <ol class="p-events"></ol>
  </aside>
</div>`;

export class PlanetView {
  private globe: Globe;
  private params: PlanetParams = { ...EARTH };
  private preset: keyof typeof PRESETS = 'realist';
  private result!: SimResult;
  private now = 0;
  private playing = true;
  private speed = 0.3;
  private last = performance.now();
  private panelTick = 0;
  private shownFacts = new Set<string>();
  private explain = true;
  private massSynced = '';
  active = true;
  onDescend: ((env: SurfaceEnv, seed: number) => void) | null = null;
  onCompare: ((p: PlanetParams) => void) | null = null;

  constructor(private root: HTMLElement) {
    root.innerHTML = TEMPLATE;
    this.globe = new Globe($(root, '.p-globe'));
    this.bind();
    this.load(EARTH);
    requestAnimationFrame(() => this.loop());
  }

  /** Копия параметров открытого мира. */
  get current(): PlanetParams {
    return { ...this.params };
  }

  get assumptions(): Assumptions {
    return PRESETS[this.preset].a;
  }

  /** Открыть мир (например, «счастливчика» из Монте-Карло). */
  open(p: PlanetParams, preset?: keyof typeof PRESETS): void {
    if (preset) {
      this.preset = preset;
      $<HTMLSelectElement>(this.root, '[data-p=preset]').value = preset;
    }
    this.load(p);
  }

  private load(p: PlanetParams, keepTime = false): void {
    this.params = { ...p };
    this.result = simulate(this.params, this.assumptions, true);
    this.globe.setPlanet(this.params, this.result.derived);
    if (!keepTime) {
      this.now = 0;
      this.playing = true;
      this.shownFacts.clear();
      this.hideFact();
    }
    this.now = Math.min(this.now, this.result.end);
    this.syncInputs();
    this.renderStatic();
    this.renderDynamic(true);
  }

  private bind(): void {
    const r = this.root;
    r.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'earth') this.load(EARTH);
        if (act === 'random') this.load(randomPlanet((Math.random() * 1e9) | 0));
        if (act === 'replay') this.load({ ...this.params, seed: (Math.random() * 1e9) | 0 });
        if (act === 'compare') this.onCompare?.({ ...this.params });
      };
    });
    $(r, '.p-descend').onclick = () => this.onDescend?.(this.surfaceEnv(), this.params.seed);
    const play = $<HTMLButtonElement>(r, '.p-play');
    play.onclick = () => {
      if (this.now >= this.result.end - 0.01) this.now = 0;
      this.playing = !this.playing;
    };
    $<HTMLSelectElement>(r, '.p-speed').onchange = (e) => (this.speed = Number((e.target as HTMLSelectElement).value));

    // ползунки параметров: пересчёт истории после отпускания (и с задержкой при перетаскивании)
    let timer = 0;
    r.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-p]').forEach((el) => {
      el.addEventListener('input', () => {
        this.readInputs();
        clearTimeout(timer);
        timer = window.setTimeout(() => this.load(this.params, true), 120);
      });
    });

    // перемотка мышью по шкале и графикам
    const scrub = (canvas: HTMLCanvasElement) => {
      let down = false;
      const go = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        this.now = clamp(xToTime(e.clientX - rect.left, this.result.end, rect.width), 0, this.result.end);
        this.renderDynamic(true);
      };
      canvas.addEventListener('pointerdown', (e) => {
        down = true;
        this.playing = false;
        canvas.setPointerCapture(e.pointerId);
        go(e);
      });
      canvas.addEventListener('pointermove', (e) => down && go(e));
      canvas.addEventListener('pointerup', () => (down = false));
    };
    scrub($(r, '.p-timeline'));
    scrub($(r, '.p-temp'));
    scrub($(r, '.p-gas'));

    $(r, '.p-events').addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest('li[data-t]') as HTMLElement | null;
      if (!li) return;
      this.now = Number(li.dataset.t);
      this.playing = false;
      if (li.dataset.id) this.showFact(li.dataset.id);
      this.renderDynamic(true);
    });
    $(r, '.p-facts').addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-fact]') as HTMLElement | null;
      if (el) this.showFact(el.dataset.fact!);
    });
    $(r, '.p-ladder').addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-fact]') as HTMLElement | null;
      if (el) this.showFact(el.dataset.fact!);
    });
    $<HTMLInputElement>(r, '.p-explain input').onchange = (e) => (this.explain = (e.target as HTMLInputElement).checked);
    $(r, '.p-fact').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      this.hideFact();
      if (b.dataset.go) this.playing = true;
    });
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.code !== 'Space' || (e.target as HTMLElement).tagName === 'INPUT') return;
      e.preventDefault();
      play.click();
    });
  }

  private flux(p: PlanetParams): number {
    return luminosity0(p.starMass) / 0.72 / (p.orbit * p.orbit);
  }

  private readInputs(): void {
    const v = (k: string) => $<HTMLInputElement>(this.root, `[data-p=${k}]`);
    const p = this.params;
    p.starMass = Number(v('starMass').value);
    const flux = Number(v('flux').value);
    p.orbit = Math.sqrt(luminosity0(p.starMass) / 0.72 / flux);
    // массу меняем, только если двигали её ползунок (у Марса 0,107 — точнее шага ползунка);
    // реальная длительность динамо (Марс) не годится для планеты другой массы
    if (v('mass').value !== this.massSynced) {
      delete p.dynamoGyr;
      p.mass = Number(v('mass').value);
    }
    p.water = Math.pow(10, Number(v('water').value));
    p.moon = Number(v('moon').value);
    p.giant = v('giant').checked;
    const t = (v('tectonics') as unknown as HTMLSelectElement).value;
    p.tectonics = t === 'auto' ? null : t === 'on';
    this.preset = (v('preset') as unknown as HTMLSelectElement).value as keyof typeof PRESETS;
  }

  private syncInputs(): void {
    const v = (k: string) => $<HTMLInputElement>(this.root, `[data-p=${k}]`);
    const p = this.params;
    v('starMass').value = String(p.starMass);
    v('flux').value = String(this.flux(p));
    v('mass').value = String(p.mass);
    this.massSynced = v('mass').value;
    v('water').value = String(Math.log10(p.water));
    v('moon').value = String(p.moon);
    v('giant').checked = p.giant;
    (v('tectonics') as unknown as HTMLSelectElement).value = p.tectonics === null ? 'auto' : p.tectonics ? 'on' : 'off';
  }

  /** То, что не зависит от текущего момента времени. */
  private renderStatic(): void {
    const r = this.root;
    const p = this.params;
    const d = this.result.derived;
    const out = (k: string, text: string) => ($(r, `[data-out=${k}]`).textContent = text);
    out('star', `${STAR_INFO[d.starClass].name}, ${p.starMass.toFixed(2)} M☉`);
    out('flux', `${this.flux(p).toFixed(2)} · орбита ${p.orbit.toFixed(2)} а.е.`);
    out('mass', `${p.mass.toFixed(2)} · g = ${d.gravity.toFixed(2)}`);
    out('water', p.water < 0.1 ? `${p.water.toFixed(3)} — сухая` : p.water > 3 ? `${p.water.toFixed(1)} — океанический мир` : p.water.toFixed(2));
    out('moon', p.moon > 0 ? p.moon.toFixed(2) : 'нет');
    $(r, '.p-seed').textContent = `#${p.seed}`;

    const facts: [string, string, string?][] = [
      ['🔥', `Звезда проживёт ${d.lifetime > 12 ? 'дольше возраста Вселенной' : fmtAge(d.lifetime)}`],
      [d.tectonics ? '🌋' : '🪨', d.tectonics ? 'Тектоника плит — климат саморегулируется' : 'Нет тектоники — нет климатического термостата', 'tectonics'],
      ['☀️', 'Молодая звезда на 28% тусклее, чем в зрелости', 'faintsun'],
      ['🧲', d.dynamo >= 12 ? 'Магнитное поле на всю жизнь' : `Магнитное поле угаснет через ${fmtAge(d.dynamo)}`, 'dynamo'],
      ['🏝', `Суша: ${Math.round(d.land * 100)}% поверхности`],
    ];
    if (d.tidalLock) facts.push(['🔒', 'Приливный захват: одна сторона вечно к звезде']);
    else if (d.slowRotation) facts.push(['🐢', `Медленное вращение (сутки — ${Math.round(p.rotation ?? 1)} земных) — слабое магнитное динамо`, 'dynamo']);
    if (p.dynamoGyr !== undefined) facts.push(['📌', 'Магнитное поле задано по реальным данным, а не по формуле']);
    if (p.moon > 0.3) facts.push(['🌙', 'Крупный спутник стабилизирует наклон оси', 'axis']);
    else facts.push(['🌀', 'Нет крупного спутника — ось и климат «гуляют»', 'axis']);
    if (p.starMass < 0.6) facts.push(['⚡', 'Красный карлик: мощные вспышки в молодости', 'flare']);
    $(r, '.p-facts').innerHTML = facts.map(([i, t, f]) => `<div ${f ? `data-fact="${f}" class="link"` : ''}><span>${i}</span>${t}${f ? ' <b>?</b>' : ''}</div>`).join('');

    $(r, '.p-star').innerHTML = `<i style="background:${STAR_INFO[d.starClass].color}"></i>${STAR_INFO[d.starClass].name}`;
  }

  private sampleAt(t: number) {
    const s = this.result.samples;
    const i = clamp(Math.round((t / this.result.end) * (s.length - 1)), 0, s.length - 1);
    return s[i];
  }

  /** То, что меняется при проигрывании. */
  private renderDynamic(full = false): void {
    const r = this.root;
    const res = this.result;
    const s = this.sampleAt(this.now);
    const tech = s.stage >= 7;
    this.globe.setState(s, tech);

    $(r, '.p-age').textContent = fmtAge(this.now);
    $(r, '.p-descend').hidden = !(s.stage >= 4 && s.habitable);
    const sn = $(r, '.p-stagename');
    sn.textContent = s.stage === 0 && !s.habitable ? (s.ocean <= 0.01 ? 'Безводная пустыня' : 'Безжизненный мир') : STAGE_NAMES[s.stage];
    sn.style.color = STAGE_COLORS[s.stage] === '#3a3f4a' ? '#9aa0a6' : STAGE_COLORS[s.stage];
    const c = Math.round(s.T - 273);
    $(r, '.p-metrics').innerHTML = [
      `🌡 ${c > 0 ? '+' : ''}${c} °C`,
      `🫧 O₂ ${(s.o2 * 100).toFixed(s.o2 < 0.01 ? 2 : 0)}%`,
      `🌫 ${(s.pressure + s.co2).toFixed(2)} бар`,
      `🌊 ${Math.round(s.ocean * 100)}% воды`,
    ]
      .map((x) => `<span>${x}</span>`)
      .join('');
    $(r, '.p-play').textContent = this.playing ? '⏸' : '▶';

    drawTimeline($(r, '.p-timeline'), res, this.now);
    if (!full && this.panelTick++ % 4 !== 0) return;
    drawTemperature($(r, '.p-temp'), res, this.now);
    drawGases($(r, '.p-gas'), res, this.now);

    // лестница жизни: что уже было к этому моменту
    $(r, '.p-ladder').innerHTML = STEP_INFO.map((step, i) => {
      const k = i + 1;
      const reached = res.events.filter((e) => e.kind === 'life' && e.t <= this.now && e.text.includes(step.label.split(' ')[0])).length > 0 || (k === 6 && res.firstReached[6] !== null && res.firstReached[6]! <= this.now);
      const first = res.firstReached[k];
      const cls = s.stage >= k ? 'now' : reached || (first !== null && first <= this.now) ? 'lost' : 'no';
      const time = first !== null && first <= this.now ? fmtAge(first) : '';
      return `<li class="${cls}" title="${step.hint}" data-fact="${step.key}"><span class="ic">${step.icon}</span><span class="nm">${step.label}</span><span class="tm">${cls === 'lost' ? 'утрачено' : time}</span></li>`;
    }).join('');

    const evs = res.events.filter((e) => e.t <= this.now);
    $(r, '.p-events').innerHTML = evs
      .slice(-80)
      .reverse()
      .map((e) => `<li data-t="${e.t}" data-id="${FACTS[e.id] ? e.id : ''}" class="${e.kind}${FACTS[e.id] ? ' link' : ''}"><span>${fmtAge(e.t)}</span>${e.text}</li>`)
      .join('') + (this.now >= res.end - 0.02 ? '' : '');
    if (this.now >= res.end - 0.01) {
      $(r, '.p-events').insertAdjacentHTML('afterbegin', `<li class="info end"><span>${fmtAge(res.end)}</span>🏁 ${res.endReason}</li>`);
    }
  }

  /** Показать карточку, когда проигрывание проходит через событие (каждую тему — один раз за историю). */
  private autoFact(from: number, to: number): void {
    if (!this.explain) return;
    for (const e of this.result.events) {
      if (e.t <= from || e.t > to || !FACTS[e.id] || this.shownFacts.has(e.id)) continue;
      this.shownFacts.add(e.id);
      this.now = e.t;
      this.playing = false;
      this.showFact(e.id);
      return;
    }
  }

  private showFact(id: string): void {
    const f: Fact | undefined = FACTS[id] ?? WORLD_FACTS[id];
    if (!f) return;
    const step = STEP_INFO.find((s) => s.key === id);
    let chance = '';
    if (step) {
      const rate = this.assumptions[step.key];
      const years = 1 / rate;
      chance = `<p class="chance">🎲 В сценарии «${PRESETS[this.preset].name}» этот шаг при подходящих условиях случается в среднем раз в <b>${fmtAge(years).replace(' лет', '')} лет</b>. ${step.hint}</p>`;
    }
    const el = $(this.root, '.p-fact');
    el.innerHTML = `
      <div class="tag">${FIELD_ICON[f.field]} ${f.field}</div>
      <h4>${f.title}</h4>
      <p>${f.text}</p>
      ${f.earth ? `<p class="earth">🌍 ${f.earth}</p>` : ''}
      ${chance}
      <div class="btns"><button data-go="1">Дальше ▶</button><button>✕</button></div>`;
    el.hidden = false;
  }

  private hideFact(): void {
    $(this.root, '.p-fact').hidden = true;
  }

  /** Условия на поверхности в текущий момент истории — для уровня «Поверхность». */
  surfaceEnv(): SurfaceEnv {
    const s = this.sampleAt(this.now);
    const d = this.result.derived;
    const land = s.ocean <= 0.005 ? 1 : clamp(1 - (1 - d.land) * Math.pow(s.ocean, 0.6), 0, 1);
    const t = clamp((d.teff - 2800) / 4200, 0, 1);
    return {
      name: `Мир #${this.params.seed}, ${fmtAge(this.now)}`,
      sea: clamp(1 - land, 0.08, 0.85),
      tempOffset: clamp((s.T - 288) / 80, -0.4, 0.4),
      o2: s.o2,
      gravity: d.gravity,
      seasonAmp: this.params.moon > 0.3 ? 0.16 : 0.26,
      landLife: s.stage >= 5,
      starTint: [1, 0.82 + t * 0.18, 0.62 + t * 0.38],
    };
  }

  private loop(): void {
    const t = performance.now();
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    if (this.active) {
      if (this.playing) {
        const prev = this.now;
        this.now += dt * this.speed;
        this.autoFact(prev, this.now);
        if (this.now >= this.result.end) {
          this.now = this.result.end;
          this.playing = false;
          this.renderDynamic(true);
        } else this.renderDynamic();
      }
      this.globe.frame(dt);
    }
    requestAnimationFrame(() => this.loop());
  }
}
