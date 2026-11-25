// ⏳ Сравнение веток машины времени (без DOM): общий предок, индекс Брея — Кёртиса, короткие выводы (§7).
import { DAY } from './world';
import { GUILD, type Branch, type SeriesRow, type Timeline } from './timeline';

/** Глубочайшая общая точка двух веток: такт развилки td и nxShared — виды с меньшим id общие. */
export function commonPoint(tl: Timeline, A: Branch, B: Branch): { td: number; nx: number } {
  const LA = tl.lineage(A), LB = tl.lineage(B);
  let k = 0;
  while (k < LA.length && k < LB.length && LA[k] === LB[k]) k++;
  const cands = [LA[k], LB[k]].filter((x): x is Branch => !!x);
  if (!cands.length) return { td: A.headTick, nx: Infinity };
  let best = cands[0];
  for (const c of cands) if (c.forkTick < best.forkTick) best = c;
  return { td: best.forkTick, nx: best.nxFork };
}

/** Последний ряд не позже t (ряды по возрастанию t). */
export function rowAt(rows: SeriesRow[], t: number): SeriesRow | null {
  let lo = 0, hi = rows.length - 1, out: SeriesRow | null = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (rows[m].t <= t) (out = rows[m]), (lo = m + 1);
    else hi = m - 1;
  }
  return out;
}

/** Индекс Брея — Кёртиса по видам (виды, родившиеся после развилки, у каждой ветки свои). */
export function brayCurtis(a: SeriesRow, b: SeriesRow, nx: number, ida: number, idb: number): number {
  const m = new Map<string | number, [number, number]>();
  const add = (r: SeriesRow, bid: number, j: 0 | 1) => {
    for (let i = 0; i < r.ids.length; i++) {
      const id = r.ids[i];
      const key = id < nx ? id : `${bid}:${id}`;
      const v = m.get(key) ?? [0, 0];
      v[j] += r.cnt[i];
      m.set(key, v);
    }
  };
  add(a, ida, 0);
  add(b, idb, 1);
  let d = 0, s = 0;
  for (const [x, y] of m.values()) {
    d += Math.abs(x - y);
    s += x + y;
  }
  return s ? d / s : 0;
}

export interface Leader { id: number; name: string; hue: number; n: number; fresh: boolean }
export interface PairCmp {
  A: Branch;
  B: Branch;
  td: number;
  nx: number;
  /** Такт сравнения: меньший из «настоящих» веток. */
  tc: number;
  pct: number;
  leaders: [Leader[], Leader[]];
  bullets: { text: string; fact?: string }[];
}

const dec = (x: number) => x.toFixed(1).replace('.', ',');
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Сравнить две ветки (§7.1–7.2). */
export function comparePair(tl: Timeline, A: Branch, B: Branch): PairCmp | null {
  const { td, nx } = commonPoint(tl, A, B);
  const tc = Math.min(A.headTick, B.headTick);
  const RA = tl.lineageRows(A), RB = tl.lineageRows(B);
  const a = rowAt(RA, tc), b = rowAt(RB, tc);
  if (!a || !b) return null;
  const pct = Math.round(100 * brayCurtis(a, b, nx, A.id, B.id));
  const lead = (br: Branch, r: SeriesRow): Leader[] => {
    const out: Leader[] = [];
    for (let i = 0; i < Math.min(3, r.ids.length); i++) {
      const id = r.ids[i], nm = tl.spName(br, id);
      out.push({ id, name: nm?.name ?? `вид #${id}`, hue: nm?.hue ?? 0, n: r.cnt[i], fresh: id >= nx });
    }
    return out;
  };
  const leaders: [Leader[], Leader[]] = [lead(A, a), lead(B, b)];
  const X = A.letter, Y = B.letter;
  const bullets: { text: string; fact?: string }[] = [];
  // 1. одни и те же ряды после развилки
  // (все ряды после развилки, не меньше 6: у «бабочки» первые ряды тоже совпадают, но потом миры расходятся)
  let same = 0, seen = 0;
  const mapB = new Map(RB.filter((r) => r.t > td && r.t <= tc).map((r) => [r.t, r]));
  for (const r of RA) {
    if (r.t <= td || r.t > tc) continue;
    const q = mapB.get(r.t);
    if (!q) continue;
    seen++;
    if (q.n === r.n && q.g.every((v, i) => v === r.g[i]) && q.ids.length === r.ids.length && q.ids.every((v, i) => v === r.ids[i] && q.cnt[i] === r.cnt[i])) same++;
  }
  if (seen >= 6 && same === seen) bullets.push({ text: '🔁 История повторилась в точности: те же кости — то же будущее.', fact: 'tm_seed' });
  // 2–3. гильдии
  for (let g = 0; g < 4; g++) {
    const G = GUILD[g];
    const [lo, hi, L, H] = a.g[g] <= b.g[g] ? [a.g[g], b.g[g], X, Y] : [b.g[g], a.g[g], Y, X];
    if (lo === 0 && hi >= 5) bullets.push({ text: `${G.icon} В ветке ${L} ${G.name} вымерли, а в ветке ${H} — нет (${hi}).` });
    else if (lo > 0 && hi / lo >= 1.5 && hi >= 20) bullets.push({ text: `${G.icon} ${cap(G.gen)} в ветке ${H} в ${dec(hi / lo)} раза больше.` });
  }
  // 4. общий вид вымер в одной ветке, а в другой живёт
  const extinctIn = (br: Branch, name: string) =>
    tl.lineageMarks(br).some((m) => m.kind === 'extinct' && m.t > td && m.t <= tc && m.text.includes(`«${name}»`));
  const ia = new Set(a.ids), ib = new Set(b.ids);
  for (const [r, other, br, L, H] of [[b, ia, A, X, Y], [a, ib, B, Y, X]] as const) {
    for (const id of r.ids) {
      if (id >= nx || other.has(id)) continue;
      const nm = tl.spName(br, id) ?? tl.spName(br === A ? B : A, id);
      if (nm && extinctIn(br, nm.name)) {
        bullets.push({ text: `💀 «${nm.name}» вымер в ветке ${L}, но живёт в ветке ${H}.` });
        break;
      }
    }
  }
  // 5. разные лидеры
  if (leaders[0].length && leaders[1].length && leaders[0][0].name !== leaders[1][0].name) {
    bullets.push({ text: `👑 Самый многочисленный: в ${X} — «${leaders[0][0].name}», в ${Y} — «${leaders[1][0].name}».` });
  }
  // 6. новые виды
  const fresh = (r: SeriesRow) => [...r.ids].filter((id) => id >= nx).length;
  if (nx !== Infinity && tc > td) bullets.push({ text: `🧬 Новых видов после развилки: ${X} — ${fresh(a)}, ${Y} — ${fresh(b)}.` });
  // 7. почти одинаковы
  if (pct < 5 && !bullets.some((x) => x.fact === 'tm_seed')) bullets.push({ text: '≈ Миры пока почти не различаются — подождите или посмотрите «Эффект бабочки».' });
  return { A, B, td, nx, tc, pct, leaders, bullets: bullets.slice(0, 4) };
}

export const dayOf = (t: number) => Math.floor(t / DAY);
