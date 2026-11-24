/** Графики «Сравнения миров»: все планеты на одной оси времени. */
import { clamp } from '../lib/random';
import { prep, STAGE_COLORS, timeToX } from '../planet/charts';
import type { Sample, SimResult } from '../planet/model';
import { sampleAt, TODAY } from './worlds';

export interface Row {
  res: SimResult;
  color: string;
  label: string;
}

export interface Metric {
  key: 'T' | 'P' | 'water' | 'o2';
  label: string;
  get(s: Sample, r: SimResult): number;
  /** Значение → высота 0…1. */
  y(v: number): number;
  ticks: number[];
  fmt(v: number): string;
  band?: [number, number];
}

const log01 = (v: number, lo: number, hi: number) => (Math.log10(clamp(v, lo, hi)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
const sup = (e: number) => String(e).replace('-', '⁻').replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]);

export const METRICS: Metric[] = [
  {
    key: 'T',
    label: 'Температура, °C',
    get: (s) => s.T - 273,
    // кусочная шкала: −150…+60 °C — нижние 55% высоты, +60…+500 °C — верхние 45%
    y: (v) => (v <= 60 ? (0.55 * (clamp(v, -150, 60) + 150)) / 210 : 0.55 + (0.45 * (Math.min(v, 500) - 60)) / 440),
    ticks: [-100, 0, 50, 200, 450],
    fmt: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}°`,
    band: [0, 50],
  },
  {
    key: 'P',
    label: 'Давление, бар',
    get: (s) => s.pressure + s.co2,
    y: (v) => log01(v, 1e-3, 100),
    ticks: [1e-3, 1e-2, 0.1, 1, 10, 100],
    fmt: (v) => (v === 1 ? '1' : v === 10 ? '10' : v === 100 ? '100' : `10${sup(Math.round(Math.log10(v)))}`),
  },
  {
    key: 'water',
    label: 'Вода, земных океанов',
    get: (s, r) => s.ocean * r.params.water,
    y: (v) => log01(v, 1e-3, 3),
    ticks: [0.001, 0.01, 0.1, 1],
    fmt: (v) => String(v).replace('.', ','),
  },
  {
    key: 'o2',
    label: 'Кислород, %',
    get: (s) => s.o2 * 100,
    y: (v) => clamp(v / 35, 0, 1),
    ticks: [0, 10, 20, 30],
    fmt: (v) => `${v}%`,
  },
];

const PAD_T = 8;
const PAD_B = 16;

function todayLine(ctx: CanvasRenderingContext2D, end: number, w: number, y0: number, y1: number): void {
  const x = Math.round(timeToX(TODAY, end, w)) + 0.5;
  ctx.save();
  ctx.strokeStyle = 'rgba(201,232,107,0.55)';
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
  ctx.restore();
}

function cursor(ctx: CanvasRenderingContext2D, x: number, h: number): void {
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(Math.round(x) - 0.5, 0, 1.5, h);
}

/** Одна величина для всех миров. Вода: пунктир — лёд, точки — пар, бледная — воды нет. */
export function drawCompareMetric(canvas: HTMLCanvasElement, rows: Row[], now: number, end: number, m: Metric): void {
  const [ctx, w, h] = prep(canvas);
  if (!w || !h) return;
  const Y = (v: number) => h - PAD_B - m.y(v) * (h - PAD_T - PAD_B);
  const x0 = timeToX(0, end, w);
  const x1 = timeToX(end, end, w);
  if (m.band) {
    ctx.fillStyle = 'rgba(90, 180, 120, 0.13)';
    ctx.fillRect(x0, Y(m.band[1]), x1 - x0, Y(m.band[0]) - Y(m.band[1]));
  }
  ctx.font = '10px system-ui';
  ctx.textAlign = 'right';
  for (const t of m.ticks) {
    const y = Math.round(Y(t));
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x0, y, x1 - x0, 1);
    ctx.fillStyle = 'rgba(230,232,223,0.55)';
    ctx.fillText(m.fmt(t), x0 - 4, y + 3);
  }
  // ось времени
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(230,232,223,0.45)';
  for (let t = 0; t <= end + 1e-6; t += 2) ctx.fillText(String(t), timeToX(t, end, w), h - 3);
  todayLine(ctx, end, w, PAD_T - 4, h - PAD_B);

  for (const row of rows) {
    const r = row.res;
    // 0 — сплошная, 1 — лёд (штрих), 2 — пар (точки), 3 — воды нет (бледная сплошная по «полу»)
    const style = (s: Sample) =>
      m.key !== 'water' ? 0 : m.get(s, r) <= 0.001 ? 3 : s.T > 373 ? 2 : s.ice > 0.5 || s.T < 273 ? 1 : 0;
    ctx.strokeStyle = row.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    let i = 0;
    const n = r.samples.length;
    while (i < n - 1) {
      const st = style(r.samples[i]);
      ctx.setLineDash(st === 1 ? [5, 3] : st === 2 ? [1.5, 3] : []);
      ctx.globalAlpha = st === 3 ? 0.3 : 1;
      ctx.beginPath();
      ctx.moveTo(timeToX(r.samples[i].t, end, w), Y(m.get(r.samples[i], r)));
      let j = i + 1;
      for (; j < n; j++) {
        const s = r.samples[j];
        ctx.lineTo(timeToX(s.t, end, w), Y(m.get(s, r)));
        if (style(s) !== st) break;
      }
      ctx.stroke();
      i = j;
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // точка «сейчас»
    if (now <= r.end) {
      const s = sampleAt(r, now);
      ctx.fillStyle = row.color;
      ctx.beginPath();
      ctx.arc(timeToX(s.t, end, w), Y(m.get(s, r)), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  cursor(ctx, timeToX(now, end, w), h - PAD_B);
}

const MARKS: Record<string, string> = { runaway: '☀️', dynamo: '🧲', atmoloss: '🌫' };

/** Полосы эпох жизни — по одной на мир; заодно ползунок времени. */
export function drawCompareTimeline(canvas: HTMLCanvasElement, rows: Row[], now: number, end: number): void {
  const [ctx, w, h] = prep(canvas);
  if (!w || !h) return;
  const top = 4;
  rows.forEach((row, k) => {
    const r = row.res;
    const y = top + k * 14;
    // цвет мира — точка слева
    ctx.fillStyle = row.color;
    ctx.beginPath();
    ctx.arc(14, y + 6, 4.5, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < r.samples.length; i++) {
      const s = r.samples[i];
      const xa = timeToX(s.t, end, w);
      const xb = timeToX(r.samples[i + 1]?.t ?? r.end, end, w);
      ctx.fillStyle = s.habitable || s.stage > 0 ? STAGE_COLORS[s.stage] : '#22252c';
      ctx.fillRect(xa, y, xb - xa + 0.5, 12);
    }
    // после конца истории (звезда погибла) — штриховка
    if (r.end < end - 1e-6) {
      const xa = timeToX(r.end, end, w);
      const xb = timeToX(end, end, w);
      ctx.save();
      ctx.beginPath();
      ctx.rect(xa, y, xb - xa, 12);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      for (let x = xa - 12; x < xb; x += 5) {
        ctx.beginPath();
        ctx.moveTo(x, y + 12);
        ctx.lineTo(x + 12, y);
        ctx.stroke();
      }
      ctx.restore();
    }
    for (const e of r.events) {
      const x = timeToX(e.t, end, w);
      if (e.kind === 'extinction' && e.text.startsWith('💀')) tri(ctx, x, y + 12, '#ff5252');
      else if (e.kind === 'life') tri(ctx, x, y + 12, '#ffffff');
    }
    ctx.font = '9px system-ui';
    ctx.textAlign = 'center';
    for (const e of r.events) {
      const mk = MARKS[e.id];
      if (!mk) continue;
      const x = timeToX(e.t, end, w);
      ctx.fillStyle = row.color;
      ctx.fillRect(x - 0.5, y, 1.5, 12);
      ctx.fillText(mk, x, y + 9.5);
    }
  });
  const bottom = top + rows.length * 14;
  todayLine(ctx, end, w, 0, bottom);
  ctx.font = '9px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(201,232,107,0.8)';
  ctx.fillText('сегодня', timeToX(TODAY, end, w), Math.min(h - 1, bottom + 9));
  // курсор
  const x = timeToX(now, end, w);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - 1, 0, 2, bottom);
  ctx.beginPath();
  ctx.arc(x, bottom + 3, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function tri(ctx: CanvasRenderingContext2D, x: number, yb: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, yb - 4.5);
  ctx.lineTo(x - 2.5, yb);
  ctx.lineTo(x + 2.5, yb);
  ctx.fill();
}
