import type { PlanetParams } from '../planet/model';
import type { TwinStats } from './scenarios';

let jobs = 0;
let abortCurrent: (() => void) | null = null;

/** Опыт с близнецами: два набора миров с одинаковыми зёрнами на двух потоках. null — опыт прервали. */
export function runTwin(
  base: PlanetParams,
  a: Partial<PlanetParams>,
  b: Partial<PlanetParams>,
  n: number,
  onProgress: (done: number, total: number) => void,
): Promise<[TwinStats, TwinStats] | null> {
  abortTwin();
  const id = ++jobs;
  return new Promise((resolve) => {
    const workers = [a, b].map(() => new Worker(new URL('./twin.worker.ts', import.meta.url), { type: 'module' }));
    const done = [0, 0];
    const out: (TwinStats | null)[] = [null, null];
    const finish = (r: [TwinStats, TwinStats] | null) => {
      workers.forEach((w) => w.terminate());
      if (abortCurrent === abort) abortCurrent = null;
      resolve(r);
    };
    const abort = () => finish(null);
    abortCurrent = abort;
    workers.forEach((w, i) => {
      w.onmessage = (e: MessageEvent<{ id: number; done: number; stats?: TwinStats }>) => {
        if (e.data.id !== id) return;
        done[i] = e.data.done;
        onProgress(done[0] + done[1], 2 * n);
        if (e.data.stats) out[i] = e.data.stats;
        if (out[0] && out[1]) finish([out[0], out[1]]);
      };
      w.onerror = () => finish(null);
      w.postMessage({ id, base, variant: i === 0 ? a : b, seed0: 1, n, preset: 'realist' });
    });
  });
}

/** Прервать идущий опыт (например, урок закрыли). */
export function abortTwin(): void {
  abortCurrent?.();
}
