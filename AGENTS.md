# AGENTS.md

Guidance for coding agents working on this repo.

## What this is

ocodesa is a ticket-free subagent pipeline for OpenCode: `planner` writes
`PLAN.md`, `implementer` fills it in and writes `HANDOFF.md`, `verifier`
tests/reviews and appends `ISSUES.md`. The orchestrator model is the router: it
dispatches subagents through the `task` tool and follows a fixed state machine
on their one-line protocol replies. The mailbox spec lives in
`agent/orchestrator.md`, the watcher spec in `docs/supervision-v2.md` — read
the relevant one before changing behavior.

## Layout

- `agent/*.md` — agent templates. They carry `__*_MODEL__` placeholders and
  `# __IMPLEMENTER_OPTIONS__` / `# __PLANNER_OPTIONS__` markers; never hardcode
  model ids.
- `command/*.md` — slash commands (`/pipeline`).
- `plugins/supervise.js` — `ask_supervisor`, canned advisories, prereview.
- `plugins/loop-breaker.js`, `plugins/write-guard.js`,
  `plugins/serialize-task.js`, `plugins/compaction-ledger.js` — guards; keep
  their behavior intact.
- `plugins/tests/*.test.js` — `node --test`, mock clients only, no models or
  network, no sleeping on real processes.
- `scripts/set-models.py` — renders `agent/` into gitignored `agent.local/`
  and links it; `scripts/install.sh` wires commands and plugins into
  `~/.config/opencode`.
- `models.local.json` and `agent.local/` are local-only; never commit,
  delete or hand-edit them while linked (deleting both uninstalls every
  agent from OpenCode).

## Invariants

- Routing, round counting and task ids are model-driven by design: the
  orchestrator follows the state machine in `agent/orchestrator.md` and parses
  exactly one protocol line per reply. Keep its context tiny — no artifact
  reads, no report summaries.
- Child replies are exactly one protocol line; `VERIFY: pass` always carries
  `changed=app|tests|none`. A malformed reply is an interrupted child: resume
  it once with the K brief, then stop if it repeats — never guess a status.
- OpenCode treats every module export as a plugin factory. Attach test helpers
  as properties (`Supervisor.__test`); never add a non-function export or the
  whole plugin silently fails to load.
- `ask_supervisor` is gated to `context.agent === "implementer"`; keep it that
  way.
- Plain ESM `.js`, no build step, no new npm dependencies.
- Preserve the agents' terse voice contract when editing prompts.

## Verify before you finish

```bash
node --check plugins/*.js
node --test plugins/tests/*.test.js
python3 scripts/set-models.py --render --no-link   # needs models.local.json
grep -R "__.*_MODEL__\|__IF" agent.local           # must print nothing
```

New behavior needs a test in `plugins/tests/` that fails without the change.
Mock the OpenCode client; do not require a running model or server.

Manual end-to-end: in a scratch dir, open opencode and run `/pipeline <task>`;
inspect `PLAN.md`, `HANDOFF.md` and `ISSUES.md`. Supervision logs to
`.ocodesa/supervise.jsonl` with `OCODESA_SUPERVISE_DEBUG=1`.
