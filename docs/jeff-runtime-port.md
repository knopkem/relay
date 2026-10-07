# Jeff runtime port — ocodesa on jeff-code

Plan and implementation notes for moving the ocodesa pipeline from OpenCode to
[jeff-code](https://github.com/firelex/jeff-code) (the Pi fork with the Jeff
0.8B decision model inside the agent loop).

Status: implemented; `node --test jeff/tests` covers the protocol, state
machine, RPC framing, guards and role config against a fake RPC child. The
live checks (Jeff server on this Mac, both Qwen endpoints, a real pipeline run)
still need the model hosts; see "Verification".

## Goal

Run the same ticket-free mailbox pipeline — planner → implementer → verifier →
audit, with fix/polish rounds — on jeff-code, so both local models get Jeff's
two decisions around every turn:

- the scout takes routine information steps (read, list, grep, run the
  checks) before the model's turn;
- the thinking router decides per turn whether the model thinks
  (`jeff-off-unless:jeff-router:0.6`: xhigh only when Jeff is confident).

The planner and verifier use Qwen 3.8-27B Splash (`splash`), exactly Jeff's
trained driver. The implementer uses `qwen3.8-flash-next-coder` (`strata`);
its transfer is approximate and must be validated (see Risks).

Non-goals:

- No changes to the mailbox contract: `TASK.md` in, `PLAN.md`, `HANDOFF.md`,
  `ISSUES.md` on disk, one protocol line out.
- No model-driven router. The state machine is code (the goal of
  `docs/pipeline-v3.md`, now realized as a jeff-code extension).
- The OpenCode tree (`agent/`, `command/`, `plugins/`) stays as legacy until
  the jeff-code runtime reaches parity.

## Topology

```
Mac (Apple M4, 16 GB)                         LAN
┌────────────────────────────────┐    ┌──────────────────────────────┐
│ jeff (host) + ocodesa extension│    │ splash  192.168.10.112:8000  │ planner/verifier
│  └─ spawns jeff --mode rpc     │───▶│ strata  192.168.10.136:8080  │ implementer
│      one child per role session│    └──────────────────────────────┘
│ jeff-serve (MLX, 127.0.0.1:8920)│
└────────────────────────────────┘
```

The host process runs `/pipeline`; the extension spawns RPC child processes as
role sessions. Jeff runs locally on the Mac through MLX (~28 ms per decision
on M4-class hardware; the base plus both adapters is about 2 GB).

## Architecture

### Deterministic driver, one child per role session

`jeff/ocodesa/index.ts` registers four commands in the host session:

| Command | Does |
|---|---|
| `/pipeline` | Full pipeline; brief is `TASK.md` in the cwd. |
| `/pipeline-quick <task>` | Same pipeline for an inline brief (≤ 5 lines). |
| `/pipeline-status` | Reads `.ocodesa/pipeline.json` and reports phase, round, verdicts, artifacts. |
| `/pipeline-resume` | Continues a stopped run from the saved state. |

The handler (`jeff/ocodesa/driver.mjs`) implements the state machine from
`docs/pipeline-v3.md` with no model in the loop. Every dispatch is one
`jeff --mode rpc` child process speaking JSONL on stdin/stdout
(`jeff/ocodesa/rpc.mjs`):

- send `prompt`, wait for the matching `response`, then for `agent_settled`;
  reconstruct the final assistant text from `message_update` text deltas;
- run `extractProtocol` on that text; a malformed reply gets exactly one
  continuation to the same session, then the run stops blocked;
- fresh roles are new sessions; fix/polish resume the saved session id
  (`--session-id`, sessions stored in `<target>/.ocodesa/sessions`);
- every transition writes `.ocodesa/pipeline.json` atomically.

### Per-role models, tools, and guards

Role configuration is rendered by `scripts/set-models.py` into
`jeff/config.local.json` from `models.local.json` (gitignored, like the
OpenCode agents):

| Role | Model | Thinking | Tools | Guard |
|---|---|---|---|---|
| planner | splash 27B | low | read, grep, find, ls, write | writes only `PLAN.md`/`AGENTS.md`, no edit |
| implementer | strata flash-next | off | read, bash, edit, write, grep, find, ls | never writes test files |
| verifier | splash 27B | off | read, bash, edit, write, grep, find, ls | none |
| audit | splash 27B | off | read, grep, find, ls | read-only, run approval `never` |

The thinking levels are only the fallback: in `jeff` mode the router overrides
them per turn. Tool allowlists also restrain the scout — with `audit` limited
to read/grep/find/ls its menu has no run/repeat options, so read-only is
enforced without forking jeff-code.

`jeff/role-guard/index.ts` is loaded into every child with
`--no-extensions --extension jeff/role-guard`; it enforces the path rules
above in `tool_call` and appends the durable-artifact ledger on
`before_agent_start` (the `plugins/compaction-ledger.js` idea).

Children are launched as:

```
jeff --mode rpc
     --session-dir <target>/.ocodesa/sessions
     --session-id <oc-<run>-<role>>
     --name ocodesa-<role>
     --model <provider/model>
     --thinking <off|low|...>
     --tools <allowlist>
     --no-extensions --extension <repo>/jeff/role-guard
     --no-skills --no-prompt-templates
     --append-system-prompt <repo>/jeff/roles/<role>.md
```

Project `AGENTS.md` still loads (context files are not disabled). Project
trust is not auto-granted, so a target's `.jeff/` resources stay inert.

### Role prompts

`jeff/roles/{planner,implementer,verifier}.md` are the ported bodies of
`agent/*.md` (frontmatter and OpenCode permission notes removed), appended to
jeff-code's default system prompt with `--append-system-prompt`. The audit and
re-check phases reuse `verifier.md`; the brief selects the mode, exactly as in
the OpenCode pipeline. The return protocol and voice rules are unchanged.

### What replaces the OpenCode plugins

| OpenCode | jeff-code |
|---|---|
| `plugins/loop-breaker.js` | Built in: jeff-code's loop guard, runaway cut-off, thinking limit. |
| `plugins/serialize-task.js` | Obsolete: the driver runs one child at a time by construction. |
| `plugins/compaction-ledger.js` | `role-guard` artifact ledger + role prompts to re-read the files. |
| orchestrator agent (qwable 9b) | Gone; routing is code. |
| `task` tool + `task_id` | RPC child per role session + `--session-id` resume. |

## Setup

### 1. Jeff decision server (this Mac, MLX)

```bash
git clone https://github.com/firelex/jeff ~/projects/jeff
cd ~/projects/jeff
uv sync --no-default-groups --extra lora --extra mac
uv run --no-default-groups hf download mstrasser/jeff-base --revision v1.3 --local-dir jeff-base-v1.3
uv run --no-default-groups hf download mstrasser/jeff-adapter-code --revision v1.3 --local-dir adapters/jeff-step
uv run --no-default-groups hf download mstrasser/jeff-adapter-code-router --revision v1.3 --local-dir adapters/jeff-router

# ocodesa/scripts/start-jeff.sh wraps this:
JEFF_HOME=~/projects/jeff JEFF_CODE_HOME=~/projects/jeff-code ./scripts/start-jeff.sh
```

`start-jeff.sh` runs jeff-code's `tools/jeff-first/jeff_serve.py` (it adds the
`/v1/fit` endpoint the scout needs) with `JEFF_BACKEND=mlx`,
`JEFF_CHECKPOINT=jeff-base-v1.3`, `JEFF_ADAPTERS=adapters`,
`JEFF_CPU_THREADS`, `JEFF_HOST=127.0.0.1`, `PORT=8920`.

Run the router on the Q8_0 base if you use llama.cpp instead: about 6% of its
decisions change at Q4_K_M. PyTorch CPU (`JEFF_DEVICE=cpu`) is the last
resort, at seconds per decision.

### 2. jeff-code

```bash
git clone https://github.com/firelex/jeff-code ~/projects/jeff-code
cd ~/projects/jeff-code && npm install && npm run build
```

Add both Qwen endpoints to `~/.jeff/agent/models.json` (see jeff-code's
`docs/models.md`): `splash` → `http://192.168.10.112:8000/v1`, `strata` →
`http://192.168.10.136:8080/v1`, both with `"reasoning": true`,
`"compat": { "thinkingFormat": "qwen-chat-template" }`,
`"maxTokens": 32768`.

### 3. ocodesa

```bash
python3 scripts/set-models.py        # renders jeff/config.local.json + OpenCode agents
./scripts/run-ocodesa.sh             # exports JEFF_FIRST_* and starts jeff with the extension
```

Then in the target project:

```
echo "build a minesweeper clone in rust using macroquad" > TASK.md
/pipeline            # or: /pipeline-quick fix the typo in foo
```

`run-ocodesa.sh` sets the settings the Jeff-Code evaluation used:
`JEFF_FIRST_MODE=jeff`, `JEFF_FIRST_JEFF_URL=http://127.0.0.1:8920`,
`JEFF_FIRST_JEFF_STEP_ADAPTER=jeff-step`,
`JEFF_FIRST_JEFF_STEP_THRESHOLD=0.40`,
`JEFF_FIRST_THINKING_ROUTER=jeff-off-unless:jeff-router:0.6`,
`JEFF_FIRST_THINKING_LIMIT=8000`, `JEFF_FIRST_OUTPUT_TRIM=off`,
`JEFF_FIRST_RUN_APPROVAL=all`, plus `JEFF_FIRST_TRACE_FILE` and
`JEFF_FIRST_DRIVER_BUILD`. Set `JEFF_FIRST_MODE` empty for a plain baseline
(no scout, no router) with the same pipeline.

## State file

`<target>/.ocodesa/pipeline.json`:

```json
{
  "version": 1,
  "directory": "/abs/target",
  "runId": "a1b2c3d4",
  "quick": false,
  "task": null,
  "status": "running",
  "phase": "plan",
  "round": 0,
  "sessions": { "planner": "oc-a1b2c3d4-planner", "implementer": null, "polisher": null },
  "verdicts": ["PLAN: ok", "IMPL: ok"],
  "reason": null,
  "startedAt": "...",
  "updatedAt": "..."
}
```

`status` ∈ `running | done | failed | blocked | aborted`. Sessions are
jeff-code session ids under `.ocodesa/sessions/`, so `pipeline-resume` can
reopen the implementer or polisher session after the host exits.

## Implementation order

1. Role config rendering and pure modules (protocol, briefs, state,
   role-config) with unit tests.
2. RPC client with a subprocess fixture test.
3. Dispatcher (real child lifecycle) and driver (state machine) with a mock
   dispatcher test.
4. Extension entry points (`/pipeline`, `/pipeline-quick`, status, resume) and
   the role guard.
5. Role prompt ports.
6. Scripts and docs.
7. Live verification against jeff-code + the Qwen endpoints (needs the user).

## Acceptance criteria

- AC1 `/pipeline` with `TASK.md` produces `PLAN.md`, `HANDOFF.md`,
  `ISSUES.md` through RPC child sessions; the host session sees one command
  and status notifications, no model routing.
- AC2 Every transition comes from `extractProtocol`; no model decides phase,
  round, or session ids.
- AC3 Audit runs only after `VERIFY: pass changed=app`; fix/polish never
  exceed 5 rounds and report the cap.
- AC4 A malformed reply triggers exactly one continuation to the same session,
  then the run stops blocked with a reason.
- AC5 `pipeline-status` reports phase, round, sessions, verdicts, and
  artifacts; `pipeline-resume` continues a stopped run and refuses a done one.
- AC6 Role guards: planner cannot edit or write outside `PLAN.md`/`AGENTS.md`;
  implementer cannot write test files; audit cannot mutate.
- AC7 Unit tests pass with `node --test jeff/tests`.
- AC8 The OpenCode pipeline keeps working unchanged.

## Test plan

`node --test jeff/tests` (no jeff-code, no models needed):

- `protocol.test.mjs` — last matching line wins; prose ignored;
  `VERIFY: pass` without `changed=` is malformed; reasons extracted.
- `briefs.test.mjs` — exact brief strings, quick-brief line limit.
- `state.test.mjs` — initial state, atomic write/read, summary lines.
- `role-config.test.mjs` — config merge/validation, child command lines.
- `guard.test.mjs` — path decisions per role including test-file patterns.
- `rpc.test.mjs` — spawns `tests/fixtures/fake-jeff.mjs` over the real JSONL
  protocol: prompt/response correlation, text-delta reassembly (including a
  `U+2028` inside a string), `agent_settled`, failed command, stop.
- `driver.test.mjs` — scripted mock dispatcher: happy path (no audit),
  audit pass, audit fail → polish, verify fail → fix → recheck, round cap,
  `PLAN-FAIL`, `BLOCKED`, malformed → continuation, malformed twice, dispatch
  error, state/verdicts.
- `index.test.mjs` — imports the extension factory with a fake `pi` and
  asserts the four commands register.

Live checks (need the user's hardware and endpoints):

1. `curl -s localhost:8920/v1/fit ...` smoke test for the Jeff server.
2. Probe both Qwen endpoints with `scripts/probe-qwen.sh <base_url> <model>`
   (sends `chat_template_kwargs` with `enable_thinking` and
   `reasoning_effort`) — the router levels rely on them.
3. `jeff --mode rpc` one-shot against splash, then the full pipeline on a
   scratch `TASK.md`.
4. Paired runs with `JEFF_FIRST_MODE` off vs `jeff`, comparing wall time and
   verdicts; jeff-code's trace (`JEFF_FIRST_TRACE_FILE`) has the decisions.

## Risks and spikes

- **Adapter transfer to flash-next.** The adapters were trained on Qwen
  3.8-27B sessions. Run the implementer with the router first in a small
  sample, watch the trace, and only then turn the scout on for it.
- **`reasoning_effort` support.** Jeff sends levels through
  `chat_template_kwargs`; if a vLLM build rejects `reasoning_effort`, thinking
  still works but levels collapse. Probe before trusting the router.
- **Extension API drift.** jeff-code is research code; pin a commit of the
  built CLI and the extension API used here (`registerCommand`, `on`,
  `ui.notify`, `ui.setStatus`).
- **RPC waits.** The driver waits for `agent_settled` and rebuilds text from
  `message_update` deltas; the fixture test locks the framing, but a live
  check of ordering comes first.
- **Path permissions.** Pi has no permission system; the role guard is
  load-bearing. It is unit-tested for the rules but only live-testable for
  enforcement.
- **16 GB Mac.** Jeff is ~2 GB; the Qwen servers are remote. No contention.
- **Research code + one vendor.** The ocodesa tree remains the fallback if the
  port stalls.

## Repo layout after the port

```
jeff/
  ocodesa/         extension: commands, driver, dispatcher, rpc, pure logic
  role-guard/      per-role tool_call guard + artifact ledger
  roles/           planner.md, implementer.md, verifier.md (appended prompts)
  config.local.json  rendered by scripts/set-models.py (gitignored)
  tests/           node --test suite + fake-jeff fixture
scripts/start-jeff.sh    Jeff server on the Mac (MLX)
scripts/run-ocodesa.sh   export JEFF_FIRST_* and launch jeff + extension
```
