#!/bin/bash
# 🌋 Ворота G0: с выключенной живой планетой (--geo=0) мир до бита тот же, что на коммите B0 (до неё),
# и с открытой эволюцией (--oe=1) тоже.
#   scripts/geo-g0.sh [B0-ref] [доп. флаги обоим прогонам…]
# B0-ref по умолчанию — b45b90c (main перед живой планетой, см. scripts/BENCH.md).
# JOBS="seed:ticks:mode …" — набор прогонов (по умолчанию полный: 8 зёрен × 30 000 правил + 42, 9 × 15 000 нейросетей);
# OES="0 1" — с какими --oe гонять; OUT — куда класть выводы. Не больше MAXJ (4) node-процессов одновременно.
# Сравнивается вывод без строки флагов и без полей времени (ms=, soilMs=, msK=, heapMB=). Код выхода 1 — если хоть один
# прогон разошёлся.
set -u
cd "$(dirname "$0")/.."
REF=${1:-b45b90c}
shift || true
JOBS=${JOBS:-"42:30000:rules 7:30000:rules 123:30000:rules 2024:30000:rules 9:30000:rules 77:30000:rules 1:30000:rules 555:30000:rules 42:15000:neural 9:15000:neural"}
OES=${OES:-"0 1"}
OUT=${OUT:-$(mktemp -d)}
mkdir -p "$OUT"
SRC=$(mktemp -d)
trap 'rm -rf "$SRC"' EXIT
git archive "$REF" src scripts package.json | tar -x -C "$SRC" || exit 2
ln -s "$PWD/node_modules" "$SRC/node_modules"
npx esbuild "$SRC/scripts/bench.ts" --bundle --platform=node --outfile="$OUT/b0.cjs" --log-level=error || exit 2
npx esbuild scripts/bench.ts --bundle --platform=node --outfile="$OUT/cur.cjs" --log-level=error || exit 2
for oe in $OES; do
  for j in $JOBS; do
    IFS=: read -r s t m <<< "$j"
    for v in b0 cur; do
      while [ "$(jobs -r | wc -l)" -ge "${MAXJ:-4}" ]; do sleep 1; done
      node "$OUT/$v.cjs" "$s" "$t" "$m" --geo=0 --oe="$oe" "$@" > "$OUT/$v-$s-$m-$t-oe$oe.txt" 2>&1 &
    done
  done
done
wait
norm() { tail -n +2 "$1" | sed -E 's/ (soilMs|ms|msK|heapMB)=[0-9.]+//g; s/msK=[0-9.]+//g; s/heapMB=[0-9.]+//g'; }
bad=0
for oe in $OES; do
  for j in $JOBS; do
    IFS=: read -r s t m <<< "$j"
    f="$s-$m-$t-oe$oe.txt"
    if cmp -s <(norm "$OUT/b0-$f") <(norm "$OUT/cur-$f"); then
      echo "G0 $s $m $t oe=$oe: identical"
    else
      echo "G0 $s $m $t oe=$oe: DIFF"
      diff <(norm "$OUT/b0-$f") <(norm "$OUT/cur-$f") | head -6
      bad=1
    fi
  done
done
echo "G0 $([ $bad = 0 ] && echo ok || echo FAIL) (B0=$REF, выводы в $OUT)"
exit $bad
