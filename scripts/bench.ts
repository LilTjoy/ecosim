// Балансный стенд: node-прогон мира без браузера.
// npm run bench -- <seed> <ticks> [rules|neural]
import { World } from '../src/sim/world';
const seed = Number(process.argv[2] ?? 42);
const T = Number(process.argv[3] ?? 30000);
const w = new World(3200, 2000);
w.reset((process.argv[4] ?? 'rules') as any, seed);
const guild = (c: any) => c.g.swim > 0.6 ? 'swim' : c.g.diet < 0.3 ? 'herb' : c.g.diet < 0.65 ? 'omni' : 'carn';
const extinct: Record<string, number> = {};
let t0 = Date.now(); let lines: string[] = [];
for (let t = 1; t <= T; t++) {
  w.step();
  if (t % 500 === 0) {
    const g: Record<string, number> = { herb: 0, omni: 0, carn: 0, swim: 0 };
    for (const c of w.creatures) g[guild(c)]++;
    for (const k in g) if (g[k] === 0 && extinct[k] === undefined) extinct[k] = t;
  }
  if (t % (T / 5) === 0) {
    const g: Record<string, number> = { herb: 0, omni: 0, carn: 0, swim: 0 };
    for (const c of w.creatures) g[guild(c)]++;
    const herbs = w.creatures.filter(c => guild(c) === 'herb').map(c => c.g.size).sort((a, b) => a - b);
    const carn = w.creatures.filter(c => guild(c) === 'carn').map(c => c.g.size).sort((a, b) => a - b);
    const q = (a: number[], p: number) => a.length ? a[Math.floor(p * (a.length - 1))].toFixed(1) : '-';
    lines.push(`t=${t} n=${w.creatures.length} H${g.herb} O${g.omni} C${g.carn} S${g.swim} | herbSize p10/50/90=${q(herbs, .1)}/${q(herbs, .5)}/${q(herbs, .9)} carnSize=${q(carn, .1)}/${q(carn, .5)}/${q(carn, .9)} | sp=${w.species.living().length}/${w.species.all.size} ms=${((Date.now() - t0) / (T / 5)).toFixed(2)}`);
    t0 = Date.now();
  }
}
console.log(`seed ${seed}\n` + lines.join('\n') + `\n extinct(guild first hit 0): ${JSON.stringify(extinct)}\n top: ` + w.species.living().slice(0, 8).map(s => `${s.name}[${s.count}] sz${s.mean.size.toFixed(1)} d${s.mean.diet.toFixed(2)} sw${s.mean.swim.toFixed(1)}`).join(' | '));
