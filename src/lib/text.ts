/** Русское склонение по числу: 1 клетка, 2 клетки, 5 клеток. */
export function plural(n: number, one: string, few: string, many: string): string {
  const k = Math.floor(Math.abs(n)) % 100;
  const k1 = k % 10;
  if (k > 10 && k < 20) return many;
  if (k1 === 1) return one;
  if (k1 >= 2 && k1 <= 4) return few;
  return many;
}
