import type { PlanetEvent, SimResult } from './model';

export const STAGE_COLORS = ['#3a3f4a', '#3f8f86', '#4fae5b', '#9ccc65', '#4fc3f7', '#8bc34a', '#ffca28', '#ff7043'];

export function prep(canvas: HTMLCanvasElement): [CanvasRenderingContext2D, number, number] {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return [ctx, w, h];
}

const PAD_L = 34;
const PAD_R = 34;

export function timeToX(t: number, end: number, w: number): number {
  return PAD_L + (t / end) * (w - PAD_L - PAD_R);
}
export function xToTime(x: number, end: number, w: number): number {
  return ((x - PAD_L) / (w - PAD_L - PAD_R)) * end;
}

function cursor(ctx: CanvasRenderingContext2D, x: number, h: number): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0);
  ctx.lineTo(x + 0.5, h);
  ctx.stroke();
}

function line(ctx: CanvasRenderingContext2D, r: SimResult, w: number, get: (i: number) => number, color: string, width = 1.8): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  r.samples.forEach((s, i) => {
    const x = timeToX(s.t, r.end, w);
    const y = get(i);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

/** Температура с «коридором жизни» 0–50 °C. */
export function drawTemperature(canvas: HTMLCanvasElement, r: SimResult, now: number): void {
  const [ctx, w, h] = prep(canvas);
  const lo = -60;
  const hi = 120;
  const y = (c: number) => h - 14 - ((c - lo) / (hi - lo)) * (h - 22);
  ctx.fillStyle = 'rgba(90, 180, 120, 0.12)';
  ctx.fillRect(PAD_L, y(50), w - PAD_L - PAD_R, y(0) - y(50));
  ctx.fillStyle = 'rgba(230,232,223,0.5)';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'right';
  for (const c of [-50, 0, 50, 100]) {
    ctx.fillText(`${c}°`, PAD_L - 5, y(c) + 3);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(PAD_L, y(c), w - PAD_L - PAD_R, 1);
    ctx.fillStyle = 'rgba(230,232,223,0.5)';
  }
  line(ctx, r, w, (i) => y(Math.max(lo, Math.min(hi, r.samples[i].T - 273))), '#ffb74d');
  // ось времени
  ctx.textAlign = 'center';
  const step = r.end > 6 ? 2 : 1;
  for (let t = 0; t <= r.end; t += step) ctx.fillText(`${t}`, timeToX(t, r.end, w), h - 2);
  cursor(ctx, timeToX(now, r.end, w), h - 12);
}

/** Кислород (%), CO₂ (логарифм) и океаны. */
export function drawGases(canvas: HTMLCanvasElement, r: SimResult, now: number): void {
  const [ctx, w, h] = prep(canvas);
  const yO2 = (o: number) => h - 6 - (o / 0.35) * (h - 14);
  const yCO2 = (c: number) => h - 6 - ((Math.log10(c) + 6) / 8) * (h - 14);
  ctx.font = '10px system-ui';
  ctx.fillStyle = 'rgba(100,170,255,0.5)';
  ctx.textAlign = 'right';
  for (const o of [0, 0.1, 0.2, 0.3]) ctx.fillText(`${o * 100}%`, PAD_L - 5, yO2(o) + 3);
  ctx.fillStyle = 'rgba(200,160,120,0.6)';
  ctx.textAlign = 'left';
  for (const e of [-4, -2, 0, 2]) ctx.fillText(e === 0 ? '1 бар' : `10${e < 0 ? '⁻' : ''}${Math.abs(e) === 2 ? '²' : '⁴'}`, w - PAD_R + 4, yCO2(Math.pow(10, e)) + 3);
  // океаны — заливка
  ctx.fillStyle = 'rgba(60,120,200,0.14)';
  ctx.beginPath();
  ctx.moveTo(PAD_L, h - 6);
  r.samples.forEach((s) => ctx.lineTo(timeToX(s.t, r.end, w), h - 6 - s.ocean * (h - 14)));
  ctx.lineTo(timeToX(r.samples[r.samples.length - 1]?.t ?? 0, r.end, w), h - 6);
  ctx.fill();
  line(ctx, r, w, (i) => yCO2(Math.max(1e-6, Math.min(100, r.samples[i].co2))), '#d4a373');
  line(ctx, r, w, (i) => yO2(r.samples[i].o2), '#64b5f6', 2);
  cursor(ctx, timeToX(now, r.end, w), h);
}

/** Полоса «эпох жизни» + метки событий — одновременно и ползунок времени. */
export function drawTimeline(canvas: HTMLCanvasElement, r: SimResult, now: number): void {
  const [ctx, w, h] = prep(canvas);
  const barY = 8;
  const barH = h - 22;
  for (let i = 0; i < r.samples.length; i++) {
    const s = r.samples[i];
    const x0 = timeToX(s.t, r.end, w);
    const x1 = timeToX(r.samples[i + 1]?.t ?? r.end, r.end, w);
    ctx.fillStyle = s.habitable || s.stage > 0 ? STAGE_COLORS[s.stage] : '#22252c';
    ctx.fillRect(x0, barY, x1 - x0 + 0.5, barH);
  }
  const mark = (e: PlanetEvent, color: string, size: number) => {
    const x = timeToX(e.t, r.end, w);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, barY + barH + 2);
    ctx.lineTo(x - size, barY + barH + 2 + size * 1.6);
    ctx.lineTo(x + size, barY + barH + 2 + size * 1.6);
    ctx.fill();
  };
  for (const e of r.events) {
    if (e.kind === 'extinction') mark(e, '#ff5252', 3);
    else if (e.kind === 'life') mark(e, '#ffffff', 3.5);
    else if (e.kind === 'impact' && e.text.includes('100') ) mark(e, '#ffab40', 2.5);
  }
  // курсор
  const x = timeToX(now, r.end, w);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - 1, 2, 2, barH + 12);
  ctx.beginPath();
  ctx.arc(x, 4, 4, 0, Math.PI * 2);
  ctx.fill();
}
