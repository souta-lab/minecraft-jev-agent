#!/usr/bin/env bash
# Focused regression battery for the #portal-descent lane (task/portal-descent).
# Runs from the repo root of a worktree; prints one summary line per suite.
# Handles both custom reporters ('N/M x cases passed') and bun:test ('N pass / M fail').
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

run() {
  local label="$1"; shift
  local out
  out="$("$@" 2>&1)"
  local summary
  summary="$(printf '%s\n' "$out" | grep -E '[0-9]+/[0-9]+ .*(cases|checks|assertions).*passed' | tail -1)"
  if [ -z "$summary" ]; then
    summary="$(printf '%s\n' "$out" | grep -E '^(OK: [0-9]+ failing|[A-Za-z-]+: OK|ALL PASS|ALL .*: [0-9]+ failure|FAILED .*: [0-9]+ failure)' | tail -1)"
  fi
  if [ -z "$summary" ]; then
    summary="$(printf '%s\n' "$out" | grep -E '^ *[0-9]+ (pass|fail)' | tr '\n' ' ' | sed 's/  */ /g')"
  fi
  printf '%-28s %s\n' "$label" "${summary:-NO-SUMMARY}"
  if [ -n "${VERBOSE:-}" ]; then printf '%s\n' "$out"; fi
  if printf '%s' "$summary" | grep -qE '([1-9][0-9]*/[0-9]+ .*passed)|([1-9][0-9]* failing)|([1-9][0-9]* failure)|([1-9][0-9]* fail)'; then
    printf '%s\n' "$out" | grep -E '^(FAIL|not ok|✗)' | head -20
  fi
}

cd "$ROOT/packages/jev-agent"
run test-column-descent bun test ./test-column-descent.mts
run test-pit-escape bun test ./test-pit-escape.mts
run test-vertical-plan bun test ./test-vertical-plan.mts
run test-reachability bun test ./test-reachability.mts
run test-tool-recovery bun test ./test-tool-recovery.mts
run test-candidate-policy bun test ./test-candidate-policy.mts
run test-canopy-ground bun test ./test-canopy-ground.mts
run test-food-route bun test ./test-food-route.mts
run test-mob-survival bun test ./test-mob-survival.mts
run test-descend-plan bun test ./test-descend-plan.mts
run test-portal-entry-route bun test ./test-portal-entry-route.mts
run test-nether-portal bun test ./test-nether-portal.mts
cd "$ROOT/packages/buddy-driver"
run test-ladder bun test ./test-ladder.mts
cd "$ROOT"
run bun-tests bun test --timeout=120000 --max-concurrency=1 ./bun-tests
