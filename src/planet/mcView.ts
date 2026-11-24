import { PRESETS, STAGE_NAMES, STAR_INFO, STEP_INFO, type StarClass } from './model';
import { emptyStats, merge, wilson, type McStats } from './stats';

const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;

const pct = (k: number, n: number) => {
  if (!n) return '—';
  const p = (k / n) * 100;
  return p === 0 ? '0%' : p < 0.01 ? '<0,01%' : p < 1 ? `${p.toFixed(2).replace('.', ',')}%` : `${p.toFixed(1).replace('.', ',')}%`;
};
const oneIn = (k: number, n: number) => (k ? `1 из ${Math.round(n / k).toLocaleString('ru')}` : 'ни одной');

const TEMPLATE = /* html */ `
<div class="mc">
  <header class="mc-head">
    <div>
      <h2>🎲 Тысячи случайных миров</h2>
      <p class="muted">Каждый мир — случайная звезда и скалистая планета возле её зоны обитаемости, как в настоящей Галактике (красных карликов большинство). Проживаем историю каждого и считаем, где дошло до жизни и разума.</p>
    </div>
    <div class="mc-controls">
      <select class="mc-n">
        <option value="2000">2 000 миров</option>
        <option value="10000" selected>10 000 миров</option>
        <option value="50000">50 000 миров</option>
      </select>
      <select class="mc-preset">
        <option value="pessimist">${PRESETS.pessimist.name}</option>
        <option value="realist" selected>${PRESETS.realist.name}</option>
        <option value="optimist">${PRESETS.optimist.name}</option>
      </select>
      <button class="mc-run primary">▶ Запустить</button>
    </div>
    <div class="mc-progress"><div></div></div>
  </header>
  <div class="mc-grid">
    <section class="card mc-funnel"><h3>Воронка жизни</h3><div class="body"></div></section>
    <section class="card mc-factors"><h3>Что важнее всего для разума</h3><div class="body"></div></section>
    <section class="card mc-times"><h3>Когда появляется разум</h3><canvas></canvas><p class="muted small">Возраст планеты в млрд лет. Пунктир — Земля (4,54).</p></section>
    <section class="card mc-killers"><h3>Главные убийцы жизни</h3><div class="body"></div></section>
    <section class="card mc-lucky"><h3>Счастливчики — миры с разумом</h3><div class="body"></div></section>
    <section class="card mc-science">
      <div class="tag">🎲 Вероятность</div>
      <h3>Почему одной Земли мало</h3>
      <p>Подбрось монету один раз — узнаешь только, что выпало. Подбрось 10 000 раз — получишь почти ровно 50%. Это закон больших чисел, а метод «прожить тысячи случайных историй и посчитать» называется <b>Монте-Карло</b> (в честь казино).</p>
      <p>Числа в скобках — 95% доверительный интервал: где, скорее всего, лежит истинная доля при этих допущениях. Больше миров → уже интервал.</p>
      <p>⚠️ Главная неопределённость не статистическая, а научная: частоты «трудных шагов» никто не знает. Попробуйте сравнить пессимиста и оптимиста — ответ меняется в тысячи раз. Это и есть честное состояние науки.</p>
    </section>
  </div>
</div>`;

export class McView {
  stats: McStats = emptyStats();
  preset: keyof typeof PRESETS = 'realist';
  onStats: (s: McStats, preset: keyof typeof PRESETS) => void = () => {};
  onOpen: (p: McStats['lucky'][number]['params'], preset: keyof typeof PRESETS) => void = () => {};
  private workers: Worker[] = [];
  private jobId = 0;

  constructor(private root: HTMLElement) {
    root.innerHTML = TEMPLATE;
    $(root, '.mc-run').onclick = () => this.run();
    $(root, '.mc-lucky').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
      if (b) this.onOpen(this.stats.lucky[Number(b.dataset.i)].params, this.preset);
    });
    new ResizeObserver(() => this.render()).observe(root);
    this.render();
  }

  run(): void {
    const n = Number($<HTMLSelectElement>(this.root, '.mc-n').value);
    this.preset = $<HTMLSelectElement>(this.root, '.mc-preset').value as keyof typeof PRESETS;
    const k = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    while (this.workers.length < k) this.workers.push(new Worker(new URL('./mc.worker.ts', import.meta.url), { type: 'module' }));
    const id = ++this.jobId;
    const parts: McStats[] = new Array(k).fill(null).map(() => emptyStats());
    const done = new Array(k).fill(0);
    const finished = new Array(k).fill(false);
    const seed = (Math.random() * 1e8) | 0;
    const per = Math.ceil(n / k);
    const bar = $(this.root, '.mc-progress div');
    $(this.root, '.mc-run').textContent = '⏳ Считаю…';
    this.workers.forEach((w, i) => {
      w.onmessage = (e) => {
        if (e.data.id !== id) return;
        parts[i] = e.data.stats;
        done[i] = e.data.done;
        finished[i] = e.data.finished;
        const total = done.reduce((a, b) => a + b, 0);
        bar.style.width = `${(total / n) * 100}%`;
        this.stats = parts.reduce((a, b) => merge(a, b), emptyStats());
        this.render();
        if (finished.every(Boolean)) {
          $(this.root, '.mc-run').textContent = '▶ Запустить ещё';
          this.onStats(this.stats, this.preset);
        }
      };
      w.postMessage({ id, seed: seed + i * per, count: Math.max(0, Math.min(per, n - per * i)), assumptions: PRESETS[this.preset].a });
    });
  }

  render(): void {
    const s = this.stats;
    const r = this.root;
    if (!s.n) {
      $(r, '.mc-funnel .body').innerHTML = '<p class="muted">Нажмите «Запустить» — посчитаем.</p>';
      for (const sel of ['.mc-factors', '.mc-killers', '.mc-lucky']) $(r, `${sel} .body`).innerHTML = '';
      return;
    }
    // воронка: логарифмическая шкала, иначе редкие шаги не видны
    const rows: [string, string, number][] = [
      ['💧', 'Жидкая вода ≥ 100 млн лет', s.habitable],
      ...STEP_INFO.map((st, i) => [st.icon, st.label, s.reached[i + 1]] as [string, string, number]),
    ];
    $(r, '.mc-funnel .body').innerHTML =
      `<p class="big">Из <b>${s.n.toLocaleString('ru')}</b> миров технологии появились в <b>${s.reached[7]}</b> — это ${oneIn(s.reached[7], s.n)}.</p>` +
      rows
        .map(([icon, label, k]) => {
          const w = k ? Math.max(2, (1 + Math.log10(k / s.n) / 5) * 100) : 0;
          const [lo, hi] = wilson(k, s.n);
          return `<div class="frow"><span class="fl">${icon} ${label}</span><div class="fbar"><div style="width:${w}%"></div></div><span class="fv">${pct(k, s.n)}<small> (${pct(lo * s.n, s.n)}–${pct(hi * s.n, s.n)})</small></span></div>`;
        })
        .join('') +
      '<p class="muted small">Шкала полос логарифмическая: каждое деление — в 10 раз меньше.</p>';

    // факторы: во сколько раз шанс разума выше/ниже среднего
    const base = s.reached[6] / s.n;
    const order = ['Тип звезды', 'Крупная луна', 'Тектоника плит', 'Гигант-щит', 'Вода', 'Масса планеты', 'Приливный захват'];
    $(r, '.mc-factors .body').innerHTML =
      `<table><tr><th></th><th>миров</th><th>жизнь</th><th>разум</th><th></th></tr>` +
      order
        .filter((f) => s.factors[f])
        .map((f) => {
          const g = s.factors[f];
          return `<tr class="grp"><td colspan="5">${f}</td></tr>` +
            Object.entries(g)
              .sort((a, b) => b[1].n - a[1].n)
              .map(([v, b]) => {
                const rate = b.n ? b.intel / b.n : 0;
                const x = base ? rate / base : 0;
                const tag = b.intel === 0 ? '<span class="x down">0</span>' : `<span class="x ${x >= 1 ? 'up' : 'down'}">×${x >= 10 ? x.toFixed(0) : x.toFixed(1)}</span>`;
                return `<tr><td>${v}</td><td>${b.n.toLocaleString('ru')}</td><td>${pct(b.life, b.n)}</td><td>${pct(b.intel, b.n)}</td><td>${tag}</td></tr>`;
              })
              .join('');
        })
        .join('') +
      '</table><p class="muted small">×N — во сколько раз шанс разума выше среднего по всем мирам.</p>';

    // убийцы
    const kill = Object.entries(s.killers).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const kmax = kill[0]?.[1] ?? 1;
    $(r, '.mc-killers .body').innerHTML = kill
      .map(([k, v]) => `<div class="frow"><span class="fl">${k}</span><div class="fbar red"><div style="width:${(v / kmax) * 100}%"></div></div><span class="fv">${v.toLocaleString('ru')}</span></div>`)
      .join('') || '<p class="muted">Пока никого не убили.</p>';

    // счастливчики
    $(r, '.mc-lucky .body').innerHTML = s.lucky.length
      ? `<div class="lucky">${s.lucky
          .slice(0, 24)
          .map(
            (l, i) =>
              `<button data-i="${i}" title="Открыть историю этого мира"><i style="background:${STAR_INFO[l.star as StarClass].color}"></i>#${l.params.seed} · ${STAGE_NAMES[l.maxStage]}${l.intelAt !== null ? ` · ${l.intelAt.toFixed(1)} млрд` : ''}</button>`,
          )
          .join('')}</div>`
      : '<p class="muted">Ни одного мира с разумом. Попробуйте больше миров или сценарий «Оптимист».</p>';

    this.drawTimes();
  }

  private drawTimes(): void {
    const c = $<HTMLCanvasElement>(this.root, '.mc-times canvas');
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w) return;
    c.width = w * dpr;
    c.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bins = this.stats.intelTimes;
    const max = Math.max(1, ...bins);
    const bw = (w - 20) / bins.length;
    ctx.fillStyle = '#ffca28';
    bins.forEach((v, i) => {
      const bh = (v / max) * (h - 24);
      ctx.fillRect(10 + i * bw + 1, h - 16 - bh, bw - 2, bh);
    });
    ctx.fillStyle = 'rgba(230,232,223,0.6)';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    for (let t = 0; t <= 12; t += 2) ctx.fillText(String(t), 10 + (t / 0.5) * bw, h - 3);
    const ex = 10 + (4.54 / 0.5) * bw;
    ctx.strokeStyle = '#7fd3ff';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(ex, 4);
    ctx.lineTo(ex, h - 16);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

