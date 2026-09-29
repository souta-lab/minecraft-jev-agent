#!/usr/bin/env bash
# start-local-mercury.sh - run the resident with Qwen3.5-9B as local Mercury System 2.
#
# Steps:
#   1. make sure the local endpoint is running (systemd user unit, else start it)
#   2. refuse to continue unless tools/mercury-local-preflight.mjs passes
#   3. exec the resident with the local Mercury environment
#
# Usage: tools/start-local-mercury.sh [--base URL] [--model ID] [--no-preflight]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

BASE="${BUDDY_MERCURY_BASE_URL:-http://127.0.0.1:8081/v1}"
MODEL="${BUDDY_MERCURY_MODEL:-qwen3.5-9b-local}"
UNIT="mercury-local-9b.service"
SKIP_PREFLIGHT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --no-preflight) SKIP_PREFLIGHT=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! curl -s -m 2 "${BASE}/models" >/dev/null 2>&1; then
  echo "endpoint ${BASE} is down; trying systemctl --user start ${UNIT}"
  systemctl --user start "$UNIT" || true
  if ! curl -s -m 2 "${BASE}/models" >/dev/null 2>&1; then
    echo "endpoint ${BASE} is not ready yet; rerun after the service reports ready" >&2
    exit 1
  fi
fi

if [ "$SKIP_PREFLIGHT" -eq 0 ]; then
  BUDDY_MERCURY_BASE_URL="$BASE" BUDDY_MERCURY_MODEL="$MODEL" bun tools/mercury-local-preflight.mjs --base "$BASE" --model "$MODEL"
fi

echo "starting resident with local Mercury: base=${BASE} model=${MODEL}"
exec env \
  BUDDY_MERCURY_BASE_URL="$BASE" \
  BUDDY_MERCURY_MODEL="$MODEL" \
  BUDDY_MERCURY_LOCAL_NO_THINK="${BUDDY_MERCURY_LOCAL_NO_THINK:-1}" \
  BUDDY_SYSTEM2_TIMEOUT_MS="${BUDDY_SYSTEM2_TIMEOUT_MS:-240000}" \
  BUDDY_POLICY="${BUDDY_POLICY:-fallback}" \
  BUDDY_PLANNER="local-mercury" \
  BUDDY_SYSTEM2="mercury" \
  bun packages/buddy-driver/agent-runner.mts
