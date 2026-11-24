/// <reference lib="webworker" />
import type { Assumptions } from './model';
import { emptyStats, merge, runBatch } from './stats';

interface Job {
  id: number;
  seed: number;
  count: number;
  assumptions: Assumptions;
}

let current = 0;

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  current = job.id;
  let stats = emptyStats();
  const CHUNK = 250;
  let done = 0;
  const step = () => {
    if (current !== job.id) return; // новый запуск отменяет старый
    const n = Math.min(CHUNK, job.count - done);
    stats = merge(stats, runBatch(job.seed + done, n, job.assumptions));
    done += n;
    self.postMessage({ id: job.id, done, total: job.count, stats, finished: done >= job.count });
    if (done < job.count) setTimeout(step, 0);
  };
  step();
};
