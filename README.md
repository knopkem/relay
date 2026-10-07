# ocodesa

A ticket-free subagent pipeline for [OpenCode](https://opencode.ai): a strong
planner designs a detailed implementation blueprint, a fast implementer fills
it in in one session, and the same strong model verifies — authoring tests
from the plan, reviewing, and polishing. No work items, no commits, no process
gate. Reports live in files; a plugin drives the pipeline, and the orchestrator
is a thin shim that calls one tool and summarizes.

## Quick start

```bash
cd ocodesa
./scripts/install.sh
```

Then in any project:

```bash
echo "Add OAuth token refresh to the auth module" > TASK.md
opencode
/pipeline
```

For a one-liner: `/pipeline-quick fix the typo in README.md`.

## How a run works

```
/pipeline            # brief in TASK.md
/pipeline-quick <task>

run_pipeline tool
  │
planner     → PLAN.md     → PLAN: ok / PLAN-FAIL
implementer → HANDOFF.md  → IMPL: ok / BLOCKED
verifier    → ISSUES.md   → VERIFY: pass changed=app|tests|none / VERIFY: fail
audit       → ISSUES.md   → AUDIT: pass / AUDIT: fail
polisher    → ISSUES.md   → FIXED: ok / BLOCKED
```

**Mailbox protocol.** The brief is `TASK.md`; reports are files at fixed paths
in the target root; every child replies with exactly one protocol line. The
plugin — not a model — spawns the sessions, parses the lines and routes:

1. **plan** — a fresh `planner` writes `PLAN.md` (and `AGENTS.md` if missing).
2. **implement** — a fresh `implementer` follows the plan in one go and writes
   `HANDOFF.md`.
3. **verify** — a fresh `verifier` authors tests from the plan's test plan,
   reviews, fixes small/medium findings itself and appends to `ISSUES.md`.
   `VERIFY: pass changed=app` means it touched application code.
4. **audit** — only after `changed=app`, a fresh read-only `verifier` checks
   the verifier's own application changes.
5. **fix / polish** — `VERIFY: fail` resumes the `implementer` for a fix
   round; `AUDIT: fail` resumes the polishing verifier. Both are capped at 5
   rounds and stopping at the cap is reported.

A malformed reply gets exactly one continuation brief on the same session,
then the run stops with a reason. Every transition is persisted to
`.ocodesa/pipeline.json`, so a stopped run can resume.

## Usage

| What | How |
|---|---|
| Long brief | Write it to `TASK.md` in the project root, run `/pipeline`. |
| Short brief | `/pipeline-quick <task>` (≤ 5 lines; longer is rejected). |
| Status | Ask the orchestrator for "pipeline status" → `pipeline_status`. |
| Continue after a stop | Ask it to continue → `pipeline_resume`. Refused while live or done; past plan it needs `PLAN.md`. |
| Stop | Abort the tool call; the active child session is aborted and `status: aborted` is saved. |

Final statuses: `done`, `failed` (plan failure or provider error), `blocked`
(blocker, malformed reply, round cap), `aborted`. The tool output is the
summary: status line, `rounds`, `verdicts` (every protocol line), `sessions`
and which of `PLAN.md` / `HANDOFF.md` / `ISSUES.md` exist.

## Commands

| Command | Does |
|---|---|
| `/pipeline` | Plan → implement → verify → audit, brief in `TASK.md`. |
| `/pipeline-quick <task>` | Same pipeline for a short inline brief (≤ 5 lines). |

The orchestrator also exposes `run_pipeline`, `pipeline_status` and
`pipeline_resume`; the plugin rejects calls from any other agent.

## Agents

| Agent | Mode | Model | Role |
|---|---|---|---|
| `orchestrator` | primary | own role | Thin shim over the pipeline plugin: calls `run_pipeline`/`pipeline_status`/`pipeline_resume` once per request and summarizes. Never reads artifacts, never routes. `read`/`bash` allowed for Zen free-tier compatibility. |
| `planner` | subagent | good | Writes the blueprint (`PLAN.md`) with exact signatures, step logic, wiring, edge cases, acceptance criteria and a test plan; creates `AGENTS.md` only if missing. Replies `PLAN: ok`. |
| `implementer` | subagent | fast | Fills in the entire blueprint in one session, writes `HANDOFF.md`. Never redesigns interfaces, never writes tests, never uses git. Resumed for fixes (`ISSUES.md`); replies `IMPL: ok` / `BLOCKED`. |
| `verifier` | subagent | = planner | Fresh session: tests from the plan first, then spec/quality review, then fixes small/medium findings itself, appending everything to `ISSUES.md`. Re-check, audit (read-only) and fix modes. Replies `VERIFY` / `AUDIT` / `FIXED`. |
| `watcher` | subagent | = verifier | Read-only supervisor for the running implementer. Answers `ask_supervisor` with ≤2 sentences of direction, and powers the passive advisories. Never edits. |

All prompts end with the same terse voice contract.

## Features

### Pipeline driver — `plugins/pipeline.js`

The deterministic state machine: spawns child sessions through the SDK, parses
the one-line protocol replies, counts rounds, saves session ids, holds a
per-directory lock (2 h stale) and writes the atomic
`.ocodesa/pipeline.json` after every transition. Exposes `run_pipeline`,
`pipeline_status` and `pipeline_resume` to the orchestrator. Spec:
[docs/pipeline-v3.md](docs/pipeline-v3.md).

### Parallel supervision — `plugins/supervise.js`

A read-only `watcher` on the good model steers the fast implementer mid-task:

- **`ask_supervisor`** — the implementer pulls ≤2 sentences of direction when
  stuck (budget 10, one ask per minute).
- **Canned advisories** — deterministic nudges after 15+ edits with no
  build/test run, 40+ exploration steps, or the same failing command twice.
- **Prereview** — every 25 tool calls the watcher reviews progress in the
  background; the note is injected only if still fresh.

Modes: `OCODESA_SUPERVISE=off` (disable), `advisory` (canned nudges only),
`full` (default). `OCODESA_SUPERVISE_DEBUG=1` logs every event to
`.ocodesa/supervise.jsonl`. Notes arrive in the implementer session as
`[supervisor] …` synthetic parts. Details:
[docs/supervision-v2.md](docs/supervision-v2.md).

### Loop breaker — `plugins/loop-breaker.js`

Aborts near-duplicate tool calls — same action 3× in a row, identical output
3×, or 5 consecutive edits to one file without running a command — so the fast
model cannot loop indefinitely. Thresholds are constants at the top of the
file.

### One task per model — `plugins/serialize-task.js`

A `task` may start only when both its model provider and its agent type are
free. Plugin-created pipeline sessions bypass the `task` tool; the pipeline's
own per-directory lock covers those.

### Compaction ledger — `plugins/compaction-ledger.js`

Injects the existing `PLAN.md` / `AGENTS.md` / `HANDOFF.md` / `ISSUES.md` into
compaction prompts so long sessions re-read their durable memory instead of a
lossy summary.

## Models

Agent files carry placeholders (`__ORCHESTRATOR_MODEL__`, `__PLANNER_MODEL__`,
`__VERIFIER_MODEL__`, `__IMPLEMENTER_MODEL__`, `# __IMPLEMENTER_OPTIONS__`);
`scripts/set-models.py` resolves them from gitignored `models.local.json` into
gitignored `agent.local/` and links it into `~/.config/opencode/agent`.
Defaults: verifier → planner, orchestrator → planner (thinking off), watcher →
verifier.

```bash
python3 scripts/set-models.py                   # interactive picker
python3 scripts/set-models.py --orchestrator M  # change one role, re-render
python3 scripts/set-models.py --render          # after editing models.local.json
python3 scripts/set-models.py --think           # implementer keeps reasoning
```

The orchestrator only calls one tool and writes a short summary, so any model
that can tool-call works; a small local one is enough. Sharing the planner
model is fine and is the default.

## Install and uninstall

`./scripts/install.sh` renders the agents, links `command/` and links every
`plugins/*.js` into `~/.config/opencode/plugins/`. It is idempotent, never
clobbers real files, prunes only its own dead links, and supports `--dry-run`.
Manual install and flag reference: [INSTALL.md](INSTALL.md).

To uninstall, remove the symlinks under `~/.config/opencode/{agent,command,
plugins}` that point into this repo, then restart OpenCode.

**Do not delete** `agent.local/` or `models.local.json` while
`~/.config/opencode/agent` points at `agent.local` — that removes every agent
from OpenCode. Remove both only together, when uninstalling.

## Verifying this repo

```bash
python3 -m py_compile scripts/set-models.py
node --check plugins/*.js
node --test plugins/tests/*.test.js
python3 scripts/set-models.py --render --no-link   # re-render from models.local.json
grep -R "__.*_MODEL__\|__IF" agent.local           # must print nothing
```

`node --test` covers the pipeline state machine, supervision (including
plugin-created session classification), the guards and the ledger, all with
mock clients — no models or network. Manual end-to-end: in a scratch dir with
`TASK.md`, run `opencode run --agent orchestrator --command pipeline`, then
inspect `PLAN.md`, `HANDOFF.md`, `ISSUES.md` and `.ocodesa/pipeline.json`.

## Design notes

- **Plugin-driven orchestrator.** Reports are files, replies are one-line
  statuses, briefs are templates with a `<T>` slot. The plugin — not a model —
  spawns child sessions, parses protocol lines, counts rounds and saves
  session ids, so the orchestrator's whole context is one tool call plus a
  short summary: no compaction, no prefill spiral, safe on a 9B local model.
- **Plan is the contract.** The implementer treats PLAN.md as authoritative
  and reports any deviation with the exact plan line instead of improvising.
- **Tests are independent.** The implementer never writes tests; the verifier
  authors them from the plan's test plan before fixing anything, and must
  justify any test it changes. A conditional fresh audit checks the
  verifier's own app-code changes.
- **Fix where it is cheap.** Small/medium findings are fixed by the verifier
  directly; only rewrite-scale blockers go back to the implementer, so
  ping-pong rounds stay rare.
- **Zen free-tier compatible.** OpenCode Zen free-tier models refuse requests
  where `read` or `bash`/`shell` is denied
  ([#51241](https://github.com/anomalyco/opencode/issues/51241),
  [#51315](https://github.com/anomalyco/opencode/issues/51315)), so the
  orchestrator allows both. Assign free-tier models only to roles without
  denied `read`/`bash` (the planner denies `bash`).
- **Parallel supervision.** A read-only watcher on the good model steers the
  fast implementer mid-task: pull via `ask_supervisor`, canned drift
  advisories, and an async prereview.
