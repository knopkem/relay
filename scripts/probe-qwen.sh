#!/usr/bin/env bash
# Probe one OpenAI-compatible Qwen endpoint for the thinking fields Jeff-Code
# sends (docs/jeff-runtime-port.md, "Live checks"):
#
#   scripts/probe-qwen.sh http://192.168.10.112:8000/v1 splash/SiliconSpecies/Swift-1.5-Qwen3.8-27B-Splash
#
# A good answer shows either reasoning content or extra output tokens; an
# HTTP 4xx/5xx body means the server rejects chat_template_kwargs or
# reasoning_effort and the router levels need a different spelling.
set -euo pipefail

BASE=${1:?usage: probe-qwen.sh <base_url ending in /v1> <model_id>}
MODEL=${2:?usage: probe-qwen.sh <base_url ending in /v1> <model_id>}

echo "probe: $BASE/chat/completions model=$MODEL"
curl -sS "$BASE/chat/completions" \
  -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: ready\"}],\"max_tokens\":256,\"chat_template_kwargs\":{\"enable_thinking\":true,\"reasoning_effort\":\"xhigh\"}}"
echo
