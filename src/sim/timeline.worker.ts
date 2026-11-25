/// <reference lib="webworker" />
// ⏪ Воркер машины времени: ветки в фоне, плёнка жизни, эффект бабочки (вся работа — в tmJob.ts).
import { World } from './world';
import { JobRunner, type FromWorker, type ToWorker } from './tmJob';

// через M: в src/sim имя системного генератора встречается ровно один раз (зерно нового мира, G2)
const M: { random: () => number } = Math;
const sys = M.random;
const thrower = () => {
  throw new Error('Системная случайность в симуляции (нужно this.r())');
};

const runner = new JobRunner(
  (m: FromWorker, transfer?: Transferable[]) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer ?? []),
  (w, h, cell) => {
    // конструктор вызывает reset() со случайным зерном — ловушку ставим после него
    M.random = sys;
    const x = new World(w, h, cell);
    M.random = thrower;
    return x;
  },
  (f) => setTimeout(f, 0),
);

self.onmessage = (e: MessageEvent<ToWorker>) => runner.handle(e.data);
