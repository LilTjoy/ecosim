#!/bin/bash
# ♾️ Ворота O0: с выключенной открытой эволюцией (--oe=0) мир до бита тот же, что на коммите B0 (до неё).
#   scripts/oe-o0.sh [B0-ref] [доп. флаги обоим прогонам…]
# B0-ref по умолчанию — eaa3ae0 (main перед открытой эволюцией, см. scripts/BENCH.md).
# JOBS="seed:ticks:mode …" — набор прогонов (по умолчанию 3 зерна × 6000 правил + 1 нейросеть, как в спецификации);
# OUT — куда класть выводы. Не больше 4 node-процессов одновременно. Сравнивается вывод без строки флагов и без
# полей времени (ms=, soilMs=). Код выхода 1 — если хоть один прогон разошёлся.
set -u
cd "$(dirname "$0")/.."
REF=${1:-eaa3ae0}
shift || true
JOBS=${JOBS:-"42:6000:rules 7:6000:rules 123:6000:rules 9:6000:neural"}
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"
SRC=$(mktemp -d)
trap 'rm -rf "$SRC"' EXIT
git archive "$REF" src scripts package.json | tar -x -C "$SRC" || exit 2
ln -s "$PWD/node_modules" "$SRC/node_modules"
npx esbuild "$SRC/scripts/bench.ts" --bundle --platform=node --outfile="$OUT/b0.cjs" --log-level=error || exit 2
npx esbuild scripts/bench.ts --bundle --platform=node --outfile="$OUT/cur.cjs" --log-level=error || exit 2
for j in $JOBS; do
  IFS=: read -r s t m <<< "$j"
  for v in b0 cur; do
    while [ "$(jobs -r | wc -l)" -ge 4 ]; do sleep 1; done
    node "$OUT/$v.cjs" "$s" "$t" "$m" --oe=0 "$@" > "$OUT/$v-$s-$m-$t.txt" 2>&1 &
  done
done
wait
norm() { tail -n +2 "$1" | sed -E 's/ (soilMs|ms)=[0-9.]+//g'; }
bad=0
for j in $JOBS; do
  IFS=: read -r s t m <<< "$j"
  if cmp -s <(norm "$OUT/b0-$s-$m-$t.txt") <(norm "$OUT/cur-$s-$m-$t.txt"); then
    echo "O0 $s $m $t: identical"
  else
    echo "O0 $s $m $t: DIFF"
    diff <(norm "$OUT/b0-$s-$m-$t.txt") <(norm "$OUT/cur-$s-$m-$t.txt") | head -6
    bad=1
  fi
done
echo "O0 $([ $bad = 0 ] && echo ok || echo FAIL) (B0=$REF, выводы в $OUT)"
exit $bad
