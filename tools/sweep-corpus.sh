#!/usr/bin/env bash
# Whole-corpus sweep: run every test-*.mts / test-*.mjs in a tree and emit
# "<path> <PASS|FAIL> <last-line>" for pass/fail comparison across trees.
# Usage: sweep.sh <tree-root> <outfile>
set -u
ROOT="$1"
OUT="$2"
: > "$OUT"
run_one() {
  local rel="$1" dir="$2" file="$3"
  local last code
  last="$(cd "$ROOT/$dir" && timeout 600 bun "./$file" 2>&1 | tail -1)"
  code=$?
  if [ "$code" -eq 0 ]; then
    printf '%s PASS %s\n' "$rel" "$last" >> "$OUT"
  else
    printf '%s FAIL(%s) %s\n' "$rel" "$code" "$last" >> "$OUT"
  fi
}
for f in "$ROOT"/jev-agent/test-*.mts; do
  [ -e "$f" ] || continue
  run_one "jev-agent/$(basename "$f")" "jev-agent" "$(basename "$f")"
done
for f in "$ROOT"/buddy-driver/test-*.mts "$ROOT"/buddy-driver/test-*.mjs; do
  [ -e "$f" ] || continue
  run_one "buddy-driver/$(basename "$f")" "buddy-driver" "$(basename "$f")"
done
for f in "$ROOT"/tools/test-*.mjs; do
  [ -e "$f" ] || continue
  run_one "tools/$(basename "$f")" "tools" "$(basename "$f")"
done
echo "swept $(wc -l < "$OUT") files"
