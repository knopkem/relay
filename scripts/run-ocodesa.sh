#!/usr/bin/env bash
# Launch jeff-code with the ocodesa pipeline extension and the Jeff settings
# from the Jeff-Code evaluation (docs/jeff-runtime-port.md).
#
#   ./scripts/run-ocodesa.sh                  # Jeff on (default)
#   JEFF_FIRST_MODE=off ./scripts/run-ocodesa.sh   # baseline: plain pipeline
#
# The trace file's directory is created here; jeff-code stops at startup when a
# required JEFF_FIRST_* setting is missing, so mode=jeff exports them all.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JEFF_BIN=${JEFF_BIN:-jeff}
JEFF_FIRST_MODE=${JEFF_FIRST_MODE:-jeff}
JEFF_FIRST_TRACE_FILE=${JEFF_FIRST_TRACE_FILE:-$HOME/.local/state/ocodesa/jeff-trace.jsonl}

if ! command -v "$JEFF_BIN" >/dev/null 2>&1; then
  echo "run-ocodesa: '$JEFF_BIN' not found; build jeff-code from source or set JEFF_BIN" >&2
  exit 1
fi
if [ ! -f "$ROOT/jeff/config.local.json" ]; then
  echo "run-ocodesa: $ROOT/jeff/config.local.json is missing; run python3 scripts/set-models.py" >&2
  exit 1
fi

mkdir -p "$(dirname "$JEFF_FIRST_TRACE_FILE")"

export JEFF_FIRST_MODE
export JEFF_FIRST_JEFF_URL=${JEFF_FIRST_JEFF_URL:-http://127.0.0.1:8920}
export JEFF_FIRST_JEFF_STEP_ADAPTER=${JEFF_FIRST_JEFF_STEP_ADAPTER:-jeff-step}
export JEFF_FIRST_JEFF_STEP_THRESHOLD=${JEFF_FIRST_JEFF_STEP_THRESHOLD:-0.40}
export JEFF_FIRST_THINKING_ROUTER=${JEFF_FIRST_THINKING_ROUTER:-jeff-off-unless:jeff-router:0.6}
export JEFF_FIRST_THINKING_LIMIT=${JEFF_FIRST_THINKING_LIMIT:-8000}
export JEFF_FIRST_OUTPUT_TRIM=${JEFF_FIRST_OUTPUT_TRIM:-off}
export JEFF_FIRST_RUN_APPROVAL=${JEFF_FIRST_RUN_APPROVAL:-all}
export JEFF_FIRST_DRIVER_BUILD=${JEFF_FIRST_DRIVER_BUILD:-splash-27b+strata-flash-next}
export JEFF_FIRST_TASK_ID=${JEFF_FIRST_TASK_ID:-ocodesa}
export JEFF_FIRST_TRACE_FILE

exec "$JEFF_BIN" --extension "$ROOT/jeff/ocodesa" "$@"
