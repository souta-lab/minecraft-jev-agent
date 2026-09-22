#!/usr/bin/env bash
# Whole-corpus sweep of jev-agent/test-*.mts for the attack-position lane.
# Usage: bash tools/attack-position-corpus-sweep.sh <label>
# Writes /tmp/attack-position-sweep-<label>.txt (outside the repo tree).
set -u
LABEL="${1:-run}"
OUT="/tmp/attack-position-sweep-${LABEL}.txt"
cd "$(dirname "$0")/../jev-agent" || exit 2
: > "$OUT"
for f in test-*.mts; do
  start=$(date +%s)
  # `bun test` for bun:test files; fall back to plain `bun` for standalone scripts.
  if grep -q "from ['\"]bun:test['\"]" "$f"; then
    out=$(bun test --timeout=120000 --max-concurrency=1 "./$f" 2>&1)
  else
    out=$(bun "./$f" 2>&1)
  fi
  rc=$?
  end=$(date +%s)
  pass=$(printf '%s\n' "$out" | grep -oE '^\s*[0-9]+ pass' | tail -1 | grep -oE '[0-9]+' || true)
  fail=$(printf '%s\n' "$out" | grep -oE '^\s*[0-9]+ fail' | tail -1 | grep -oE '[0-9]+' || true)
  printf '%s\t%s\trc=%s\tpass=%s\tfail=%s\tt=%ss\n' "$LABEL" "$f" "$rc" "${pass:-0}" "${fail:-0}" "$((end-start))" >> "$OUT"
  if [ "$rc" != "0" ]; then
    {
      echo "===== FAIL $f (rc=$rc) ====="
      printf '%s\n' "$out" | tail -40
    } >> "${OUT}.detail"
  fi
done
echo "SWEEP_DONE $LABEL $(wc -l < "$OUT")" >> "$OUT"
