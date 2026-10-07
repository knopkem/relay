# ocodesa

A ticket-free subagent pipeline: a strong planner designs a detailed
implementation blueprint, a fast implementer fills it in in one session, and
the same strong model verifies — authoring tests from the plan, reviewing, and
polishing. No work items, no commits, no process gate. Reports live in files;
the orchestrator is code.

The primary runtime is [jeff-code](https://github.com/firelex/jeff-code), the
Pi fork with [Jeff](https://github.com/firelex/jeff), a 0.8B decision model,
inside the agent loop: before every turn a scout takes routine information
steps (read, list, grep, run the checks) and a router decides whether the
model should think hard. The original OpenCode version of the pipeline is kept
in `agent/`, `command/` and `plugins/` as legacy.

## Flow

```
echo "<what you want built>" > TASK.md   # or write the brief in your editor
/pipeline                                # short task: /pipeline-quick <task>

planner     → PLAN.md     → PLAN: ok / PLAN-FAIL
implementer → HANDOFF.md  → IMPL: ok / BLOCKED
verifier    → ISSUES.md   → VERIFY: pass changed=app|tests|none / VERIFY: fail
audit       → ISSUES.md   → AUDIT: pass / AUDIT: fail
polisher    → ISSUES.md   → FIXED: ok / BLOCKED
```

**Mailbox protocol.** The brief is `TASK.md`, written by the user before the
run; the driver passes its path to the planner and never reads it, so a large
pasted plan can never flood a router. Full reports live at fixed paths in the
target root (`PLAN.md`, `HANDOFF.md`, `ISSUES.md`); every role replies with a
single protocol line. The pipeline is code: plan → implement → verify → audit,
with fix/polish rounds (resuming the implementer or the polishing verifier)
capped at 5. An audit runs only when the verifier changed application code
(`changed=app`).

## Runtime

`jeff/ocodesa/` is a jeff-code extension. The `/pipeline` handler implements
the state machine deterministically and spawns one `jeff --mode rpc` child per
role session:

| Role | Model | Thinking | Tools | Guard |
|---|---|---|---|---|
| planner | splash (Qwen 3.8-27B) | low | read, grep, find, ls, write | writes only PLAN.md/AGENTS.md, never edits or runs shell |
| implementer | strata (qwen3.8-flash-next) | off | all | never writes test files |
| verifier | splash | off | all | none |
| audit | splash | off | read-only | cannot mutate, run approval `never` |

Thinking levels are the fallback: in Jeff mode the router overrides them per
turn (`jeff-off-unless:jeff-router:0.6`), and the tool allowlists also restrain
Jeff's scout — the planner and audit scouts can read, never run anything.

Role sessions are saved under `<target>/.ocodesa/sessions/`, and every
transition is written atomically to `<target>/.ocodesa/pipeline.json`, so
`/pipeline-resume` can reopen the implementer or polisher session after the
host exits.

## Commands

| Command | Does |
|---|---|
| `/pipeline` | Plan → implement → verify → audit, brief from `TASK.md`. |
| `/pipeline-quick <task>` | Same pipeline for a one-liner inline brief (≤ 5 lines). |
| `/pipeline-status` | Phase, round, verdicts, sessions, artifacts of the last run. |
| `/pipeline-resume` | Continue a stopped run from `.ocodesa/pipeline.json`. |

## Setup

1. **Jeff server** on this Mac (MLX; ~28 ms per decision):

   ```bash
   git clone https://github.com/firelex/jeff ~/projects/jeff
   cd ~/projects/jeff
   uv sync --no-default-groups --extra lora --extra mac
   uv run --no-default-groups hf download mstrasser/jeff-base --revision v1.3 --local-dir jeff-base-v1.3
   uv run --no-default-groups hf download mstrasser/jeff-adapter-code --revision v1.3 --local-dir adapters/jeff-step
   uv run --no-default-groups hf download mstrasser/jeff-adapter-code-router --revision v1.3 --local-dir adapters/jeff-router
   ./scripts/start-jeff.sh
   ```

2. **jeff-code** (the fork; build from source) and both Qwen endpoints in
   `~/.jeff/agent/models.json` as OpenAI-compatible models with
   `"reasoning": true`, `"compat": {"thinkingFormat": "qwen-chat-template"}`
   and `"maxTokens": 32768`.

3. **ocodesa**:

   ```bash
   python3 scripts/set-models.py    # renders jeff/config.local.json from models.local.json
   ./scripts/run-ocodesa.sh         # exports JEFF_FIRST_* and starts jeff with the extension
   ```

Then in any project write the brief and run `/pipeline` (or
`/pipeline-quick <task>`). `JEFF_FIRST_MODE=off ./scripts/run-ocodesa.sh`
runs the same pipeline as a plain baseline, without the scout and router.

Full details: [docs/jeff-runtime-port.md](docs/jeff-runtime-port.md), and
[INSTALL.md](INSTALL.md).

## Models

Model IDs stay out of the repo: `models.local.json` (gitignored) selects
`planner`, `implementer`, `orchestrator` and `verifier`; `scripts/set-models.py`
renders both the OpenCode agents (`agent.local/`) and the jeff-code runtime
config (`jeff/config.local.json`). The planner keeps thinking at
`--planner-effort low` by default; the implementer and verifier run with
thinking off, and Jeff's router turns thinking on only for the turns it
believes need it.

## Plugins and guards

Jeff-code provides the loop guard, runaway cut-off and thinking limit, so the
OpenCode plugins are not needed in this runtime. What remains:

- `jeff/role-guard/` — path rules per role (`tool_call` guard) and the durable
  artifact ledger appended before each run.
- `plugins/loop-breaker.js`, `plugins/serialize-task.js`,
  `plugins/compaction-ledger.js` — legacy OpenCode plugins, still used by the
  OpenCode pipeline.

## Verifying this repo

```bash
python3 -m py_compile scripts/set-models.py
python3 scripts/set-models.py --render          # re-render agents + jeff config
node --test jeff/tests                          # pipeline logic, RPC, guards
grep -R "__.*_MODEL__\|__IF" agent.local        # must print nothing (legacy agents)
```

The RPC tests spawn a fake `jeff --mode rpc` child (`jeff/tests/fixtures/`), so
the state machine is covered without models or the network. Live checks (Jeff
server, Qwen endpoints, a real pipeline run) need the model hosts; see the
"Verification" section of the port doc.

`agent.local/` is the live OpenCode agent directory: once
`~/.config/opencode/agent` points at it, never delete it or `models.local.json`
while linked — deleting them removes every agent from OpenCode. Only remove
both when you are uninstalling.

## Legacy: OpenCode pipeline

The original runtime lives in `agent/` (orchestrator, planner, implementer,
verifier), `command/pipeline.md`, `command/pipeline-quick.md` and `plugins/`.
Its orchestrator was a model router reading one-line protocol replies; the
jeff-code runtime replaces it with code. Setup for the legacy runtime is in
[INSTALL.md](INSTALL.md#legacy-opencode-runtime).

**V2 sketch:** parallel good-model supervision via an `ask_supervisor` tool —
see [docs/supervision-v2.md](docs/supervision-v2.md).
