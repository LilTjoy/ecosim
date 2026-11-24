import { gauss } from './genes';

/**
 * Крошечная нейросеть: 9 входов → 6 скрытых нейронов (tanh) → 2 выхода.
 * Веса — это гены: их никто не обучает, они только мутируют и проходят отбор.
 */

export const INPUTS = [
  'еда: sin угла',
  'еда: cos угла',
  'еда: близость',
  'угроза: sin угла',
  'угроза: cos угла',
  'угроза: близость',
  'трава тут',
  'энергия',
  'смещение',
] as const;
export const OUTPUTS = ['поворот', 'газ'] as const;

export const IN = INPUTS.length;
export const HID = 6;
export const OUT = OUTPUTS.length;
/** веса вход→скрытый, затем (скрытый+смещение)→выход */
export const WEIGHTS = IN * HID + (HID + 1) * OUT;

export function randomBrain(): Float32Array {
  const w = new Float32Array(WEIGHTS);
  for (let i = 0; i < w.length; i++) w[i] = gauss() * 0.8;
  return w;
}

export function mutateBrain(w: Float32Array, rate: number): Float32Array {
  const out = new Float32Array(w);
  for (let i = 0; i < out.length; i++) {
    if (Math.random() < 0.3) out[i] += gauss() * rate * 4;
  }
  return out;
}

const hidden = new Float32Array(HID);

/** Прогон сети. Возвращает [поворот −1..1, газ 0..1] и заполняет activations для визуализации. */
export function think(w: Float32Array, input: Float32Array, out: Float32Array, activations?: Float32Array): void {
  for (let h = 0; h < HID; h++) {
    let s = 0;
    for (let i = 0; i < IN; i++) s += input[i] * w[h * IN + i];
    hidden[h] = Math.tanh(s);
  }
  const o = IN * HID;
  for (let k = 0; k < OUT; k++) {
    let s = w[o + k * (HID + 1) + HID]; // смещение
    for (let h = 0; h < HID; h++) s += hidden[h] * w[o + k * (HID + 1) + h];
    out[k] = k === 0 ? Math.tanh(s) : 1 / (1 + Math.exp(-s));
  }
  if (activations) {
    activations.set(input, 0);
    activations.set(hidden, IN);
    activations.set(out, IN + HID);
  }
}
