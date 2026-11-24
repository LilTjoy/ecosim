/// <reference lib="webworker" />
import type { PlanetParams, PRESETS } from '../planet/model';
import { addTwin, emptyTwin, twinWorld } from './scenarios';

interface Job {
  id: number;
  base: PlanetParams;
  variant: Partial<PlanetParams>;
  seed0: number;
  n: number;
  preset: keyof typeof PRESETS;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const j = e.data;
  const s = emptyTwin();
  for (let i = 0; i < j.n; i++) {
    addTwin(s, twinWorld(j.base, j.variant, j.seed0 + i, j.preset));
    if ((i + 1) % 25 === 0 && i + 1 < j.n) self.postMessage({ id: j.id, done: i + 1 });
  }
  self.postMessage({ id: j.id, done: j.n, stats: s });
};
