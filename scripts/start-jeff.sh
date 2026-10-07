#!/usr/bin/env bash
# Start the Jeff decision server for the ocodesa pipeline (docs/jeff-runtime-port.md).
#
# Needs a clone of https://github.com/firelex/jeff with its uv environment
# (uv sync --no-default-groups --extra lora --extra mac) and the base and
# adapters downloaded, plus a clone of https://github.com/firelex/jeff-code,
# whose tools/jeff-first/jeff_serve.py adds the POST /v1/fit endpoint the
# scout needs. On Apple Silicon the MLX backend is the fast path (~28 ms per
# decision); use JEFF_BACKEND=cpu only as a fallback.
set -euo pipefail

JEFF_HOME=${JEFF_HOME:-$HOME/projects/jeff}
JEFF_CODE_HOME=${JEFF_CODE_HOME:-$HOME/projects/jeff-code}
JEFF_BACKEND=${JEFF_BACKEND:-mlx}
JEFF_CHECKPOINT=${JEFF_CHECKPOINT:-jeff-base-v1.3}
JEFF_ADAPTERS=${JEFF_ADAPTERS:-adapters}
JEFF_HOST=${JEFF_HOST:-127.0.0.1}
PORT=${PORT:-8920}
JEFF_CPU_THREADS=${JEFF_CPU_THREADS:-8}

python="$JEFF_HOME/.venv/bin/python"
serve="$JEFF_CODE_HOME/tools/jeff-first/jeff_serve.py"
checkpoint="$JEFF_HOME/$JEFF_CHECKPOINT"
adapters="$JEFF_HOME/$JEFF_ADAPTERS"

if [ ! -x "$python" ]; then
  echo "start-jeff: $python not found; run: cd $JEFF_HOME && uv sync --no-default-groups --extra lora --extra mac" >&2
  exit 1
fi
if [ ! -f "$serve" ]; then
  echo "start-jeff: $serve not found; set JEFF_CODE_HOME to a jeff-code clone" >&2
  exit 1
fi
if [ ! -d "$checkpoint" ]; then
  echo "start-jeff: $checkpoint not found; download jeff-base (revision v1.3) next to it" >&2
  exit 1
fi
for adapter in jeff-step jeff-router; do
  if [ ! -d "$adapters/$adapter" ]; then
    echo "start-jeff: $adapters/$adapter not found; download mstrasser/jeff-adapter-code and mstrasser/jeff-adapter-code-router (revision v1.3)" >&2
    exit 1
  fi
done

echo "start-jeff: $JEFF_BACKEND on $JEFF_HOST:$PORT, checkpoint $JEFF_CHECKPOINT, adapters $JEFF_ADAPTERS"
echo "start-jeff: smoke test: curl -s http://$JEFF_HOST:$PORT/v1/fit -H 'content-type: application/json' -d '{\"state\":\"hello\",\"question\":{\"type\":\"choice\",\"instructions\":\"q\",\"criteria\":{\"a\":\"first\",\"b\":\"second\"}}}'"
exec env \
  "JEFF_BACKEND=$JEFF_BACKEND" \
  "JEFF_CHECKPOINT=$checkpoint" \
  "JEFF_ADAPTERS=$adapters" \
  "JEFF_DEVICE=${JEFF_DEVICE:-cuda}" \
  "JEFF_CPU_THREADS=$JEFF_CPU_THREADS" \
  "JEFF_HOST=$JEFF_HOST" \
  "PORT=$PORT" \
  "$python" "$serve"
