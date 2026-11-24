import { mulberry32 } from '../lib/random';
import { PRESETS } from './model';
import type { McStats } from './stats';

const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;

interface Term {
  key: string;
  sym: string;
  name: string;
  min: number;
  max: number;
  log: boolean;
  value: number;
  fmt: (v: number) => string;
  hint: string;
  fromSim?: boolean;
}

const num = (v: number) => {
  if (v === 0) return '0';
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)} млн`;
  if (v >= 1000) return Math.round(v).toLocaleString('ru');
  if (v >= 10) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2).replace('.', ',');
  if (v >= 0.001) return v.toFixed(Math.max(2, -Math.floor(Math.log10(v)) + 1)).replace('.', ',');
  return v.toExponential(1).replace('.', ',').replace('e-', '·10⁻');
};

const TERMS: Term[] = [
  { key: 'R', sym: 'R*', name: 'Новых звёзд в год', min: 0.5, max: 10, log: false, value: 2, fmt: num, hint: 'В Млечном Пути рождается ~1,5–3 звезды в год — это измеряют по газу и молодым звёздам.' },
  { key: 'fp', sym: 'fₚ', name: 'Доля звёзд с планетами', min: 0.1, max: 1, log: false, value: 1, fmt: (v) => `${Math.round(v * 100)}%`, hint: 'Телескоп «Кеплер» показал: планеты есть почти у всех звёзд. 30 лет назад этого не знал никто.' },
  { key: 'ne', sym: 'nₑ', name: 'Скалистых планет у зоны обитаемости', min: 0.01, max: 2, log: true, value: 0.5, fmt: num, hint: 'Сколько каменных планет приходится на одну звезду в том диапазоне орбит, который мы моделируем. Оценки «Кеплера» — от 0,1 до 1.' },
  { key: 'fl', sym: 'fₗ', name: 'Доля, где зародилась жизнь', min: 1e-6, max: 1, log: true, value: 0.3, fmt: (v) => `${num(v * 100)}%`, hint: 'Из симуляции: доля миров, где хоть раз появились клетки.', fromSim: true },
  { key: 'fi', sym: 'fᵢ', name: 'Из них дошли до разума', min: 1e-6, max: 1, log: true, value: 0.01, fmt: (v) => `${num(v * 100)}%`, hint: 'Из симуляции: доля миров с жизнью, где появился разум.', fromSim: true },
  { key: 'fc', sym: 'f꜀', name: 'Из них построили технологии', min: 1e-4, max: 1, log: true, value: 0.2, fmt: (v) => `${num(v * 100)}%`, hint: 'Из симуляции: разум на суше и кислород ≥16% — огонь, металл, радио.', fromSim: true },
  { key: 'L', sym: 'L', name: 'Сколько лет цивилизация «шумит»', min: 50, max: 1e9, log: true, value: 10000, fmt: (v) => `${num(v)} лет`, hint: 'Самый загадочный множитель. Мы шумим в радио ~100 лет. Сколько протянет цивилизация — тысячу лет? миллион? — не знает никто.' },
];

const TEMPLATE = /* html */ `
<div class="drake">
  <section class="drake-left">
    <h2>🌌 Уравнение Дрейка</h2>
    <p class="muted">В 1961 году астроном Фрэнк Дрейк записал, как оценить число цивилизаций в нашей Галактике, с которыми можно было бы связаться. Каждый множитель — отдельный научный вопрос. Три из них мы <b>посчитали симуляцией</b>.</p>
    <div class="eq"></div>
    <div class="terms"></div>
    <div class="drake-sim"></div>
  </section>
  <section class="drake-right">
    <canvas class="galaxy"></canvas>
    <div class="result"></div>
    <div class="card fermi">
      <div class="tag">🔭 Астрономия</div>
      <h3>Парадокс Ферми: «Где все?»</h3>
      <p>В 1950 году физик Энрико Ферми спросил за обедом: если цивилизаций много, а Галактике 13 млрд лет, почему мы никого не видим? Даже медленный звездолёт облетел бы всю Галактику за несколько миллионов лет.</p>
      <p>Возможные ответы: жизнь редка (какой-то шаг очень трудный — «Великий фильтр»); цивилизации живут недолго (маленькое L); или мы просто плохо слушаем — земное радио пролетело лишь ~100 световых лет, а Галактика — 100 000.</p>
    </div>
  </section>
</div>`;

export class DrakeView {
  private terms = TERMS.map((t) => ({ ...t }));
  private stars: { r: number; a: number; b: number }[] = [];
  private civs: { r: number; a: number }[] = [];
  private angle = 0;
  active = false;

  constructor(private root: HTMLElement) {
    root.innerHTML = TEMPLATE;
    this.buildTerms();
    this.makeGalaxy();
    this.update();
    new ResizeObserver(() => this.draw()).observe(root);
    const loop = () => {
      if (this.active) {
        this.angle += 0.0006;
        this.draw();
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  /** Подставить вероятности из Монте-Карло. */
  setStats(s: McStats, preset: keyof typeof PRESETS): void {
    if (!s.n) return;
    const life = s.reached[1];
    const intel = s.reached[6];
    const tech = s.reached[7];
    const set = (k: string, v: number) => {
      const t = this.terms.find((x) => x.key === k)!;
      t.value = Math.max(t.min, Math.min(t.max, v));
    };
    set('fl', life / s.n);
    // если разум не появился ни разу — честно говорим «меньше 1 из N»
    set('fi', life ? Math.max(intel, 0.5) / life : 1e-6);
    set('fc', intel ? Math.max(tech, 0.5) / intel : 0.2);
    $(this.root, '.drake-sim').innerHTML = `<p class="muted small">🎲 fₗ, fᵢ, f꜀ взяты из симуляции ${s.n.toLocaleString('ru')} миров, сценарий «${PRESETS[preset].name}».${
      intel === 0 ? ' Разум не появился ни разу — подставлена верхняя оценка «меньше 1 из N».' : ''
    }</p>`;
    this.buildTerms();
    this.update();
  }

  private buildTerms(): void {
    $(this.root, '.terms').innerHTML = this.terms
      .map((t) => {
        const pos = t.log ? (Math.log10(t.value) - Math.log10(t.min)) / (Math.log10(t.max) - Math.log10(t.min)) : (t.value - t.min) / (t.max - t.min);
        return `<label class="term" title="${t.hint}">
          <span class="sym">${t.sym}</span>
          <span class="nm">${t.name}${t.fromSim ? ' <em>🎲 симуляция</em>' : ''}<small>${t.hint}</small></span>
          <output>${t.fmt(t.value)}</output>
          <input type="range" min="0" max="1000" value="${Math.round(pos * 1000)}" data-k="${t.key}">
        </label>`;
      })
      .join('');
    this.root.querySelectorAll<HTMLInputElement>('.terms input').forEach((inp) => {
      inp.oninput = () => {
        const t = this.terms.find((x) => x.key === inp.dataset.k)!;
        const f = Number(inp.value) / 1000;
        t.value = t.log ? Math.pow(10, Math.log10(t.min) + f * (Math.log10(t.max) - Math.log10(t.min))) : t.min + f * (t.max - t.min);
        (inp.previousElementSibling as HTMLOutputElement).textContent = t.fmt(t.value);
        this.update();
      };
    });
  }

  private get N(): number {
    return this.terms.reduce((a, t) => a * t.value, 1);
  }

  private update(): void {
    const N = this.N;
    $(this.root, '.eq').innerHTML =
      `<span class="n">N</span> = ` + this.terms.map((t) => `<span title="${t.name}">${t.sym}</span>`).join(' · ') + ` = <b>${num(N)}</b>`;
    // ближайшая цивилизация: цивилизации разбросаны по диску Галактики радиусом ~50 тыс. св. лет
    let res: string;
    if (N < 1) {
      res = `<div class="big">${N < 0.01 ? 'Мы, скорее всего, одни' : 'Скорее всего, мы одни'}</div><p>Ожидаемое число цивилизаций, кроме нас, — <b>${num(N)}</b>. При таких допущениях в Галактике сейчас, вероятнее всего, нет никого, кто мог бы ответить.</p>`;
    } else {
      const d = Math.sqrt((Math.PI * 50000 * 50000) / N);
      res = `<div class="big">${num(N)} ${plural(N, 'цивилизация', 'цивилизации', 'цивилизаций')}</div><p>Сейчас в Млечном Пути. Ближайшая — примерно в <b>${num(Math.min(d, 100000))} световых лет</b>${
        d > 200 ? `: радиосигнал туда и обратно идёт ${num(d * 2)} лет` : ' — почти соседи!'
      }.</p>`;
    }
    $(this.root, '.result').innerHTML = res;
    // точки цивилизаций (не больше 1500, чтобы не тормозило)
    const r = mulberry32(42);
    const k = Math.min(1500, Math.round(N));
    this.civs = [];
    for (let i = 0; i < k; i++) this.civs.push(this.galPoint(r));
    this.draw();
  }

  private galPoint(r: () => number): { r: number; a: number } {
    const arm = Math.floor(r() * 4);
    const rad = Math.pow(r(), 0.7);
    const a = arm * (Math.PI / 2) + rad * 5.2 + (r() - 0.5) * 0.9 * (1 - rad * 0.4);
    return { r: rad, a };
  }

  private makeGalaxy(): void {
    const r = mulberry32(7);
    for (let i = 0; i < 5000; i++) {
      const p = this.galPoint(r);
      this.stars.push({ ...p, b: 0.2 + r() * 0.6 });
    }
  }

  private draw(): void {
    const c = $<HTMLCanvasElement>(this.root, '.galaxy');
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.46;
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.35);
    grd.addColorStop(0, 'rgba(255,230,180,0.55)');
    grd.addColorStop(1, 'rgba(255,230,180,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
    const pos = (p: { r: number; a: number }) => {
      const a = p.a + this.angle;
      return [cx + Math.cos(a) * p.r * R, cy + Math.sin(a) * p.r * R * 0.62] as const;
    };
    for (const s of this.stars) {
      const [x, y] = pos(s);
      ctx.fillStyle = `rgba(190,200,255,${s.b * 0.6})`;
      ctx.fillRect(x, y, 1.2, 1.2);
    }
    for (const p of this.civs) {
      const [x, y] = pos(p);
      ctx.fillStyle = 'rgba(120,255,170,0.25)';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7dffae';
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
    // Солнце — в 26 тыс. св. лет от центра
    const [sx, sy] = pos({ r: 0.52, a: 2.4 });
    ctx.strokeStyle = '#ffd54f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffd54f';
    ctx.font = '12px system-ui';
    ctx.fillText('Мы', sx + 9, sy + 4);
  }
}

function plural(n: number, one: string, few: string, many: string): string {
  const k = Math.floor(n) % 100;
  const k1 = k % 10;
  if (k > 10 && k < 20) return many;
  if (k1 === 1) return one;
  if (k1 >= 2 && k1 <= 4) return few;
  return many;
}
