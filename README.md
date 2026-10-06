# ocodesa

A ticket-free subagent pipeline for [OpenCode](https://opencode.ai): a strong
planner designs a detailed implementation blueprint, a fast implementer fills
it in in one session, and the same strong model verifies — authoring tests
from the plan, reviewing, and polishing. No work items, no commits, no process
gate. Reports live in files; the orchestrator is a tiny router.

## Flow

```
/pipeline <task>

planner     → PLAN.md     → PLAN: ok / PLAN-FAIL
implementer → HANDOFF.md  → IMPL: ok / BLOCKED
verifier    → ISSUES.md   → VERIFY: pass changed=app|tests|none / VERIFY: fail
audit       → ISSUES.md   → AUDIT: pass / AUDIT: fail
polisher    → ISSUES.md   → FIXED: ok / BLOCKED
```

**Mailbox protocol.** Full reports live at fixed paths in the target root
(`PLAN.md`, `HANDOFF.md`, `ISSUES.md`); every subagent replies with a single
protocol line. The orchestrator never reads the artifacts and never carries
report content, so its context stays tiny and it works even on a weak, local
model. It is a 6-state router: plan → implement → verify → audit, with
fix/polish rounds (resuming the implementer or the polishing verifier) capped
at 5. An audit runs only when the verifier changed application code
(`changed=app`).

## Agents

| Agent | Mode | Model | Role |
|---|---|---|---|
| `orchestrator` | primary | own role | Zero-read router: parses one-line protocol replies and follows the state machine. Never reads artifacts or code; never edits. `read`/`bash` allowed for Zen free-tier compatibility. |
| `planner` | subagent | good | Writes the blueprint (`PLAN.md`) with exact signatures, step logic, wiring, edge cases, acceptance criteria and a test plan; creates `AGENTS.md` only if missing. Replies `PLAN: ok`. |
| `implementer` | subagent | fast | Fills in the entire blueprint in one session, writes `HANDOFF.md`. Never redesigns interfaces, never writes tests, never uses git. Resumed for fixes (`ISSUES.md`); replies `IMPL: ok` / `BLOCKED`. |
| `verifier` | subagent | = planner | Fresh session: tests from the plan first, then spec/quality review, then fixes small/medium findings itself, appending everything to `ISSUES.md`. Re-check, audit (read-only) and fix modes. Replies `VERIFY` / `AUDIT` / `FIXED`. |

All prompts end with the same terse voice contract.

## Command

| Command | Does |
|---|---|
| `/pipeline <task>` | Plan → implement → verify → audit, with the fix loop. |

## Plugins

- `plugins/loop-breaker.js` — aborts near-duplicate tool calls (same action 3×,
  identical output 3×, 5 consecutive edits to one file) so the fast model
  cannot loop indefinitely. Thresholds are constants at the top of the file.
- `plugins/serialize-task.js` — one task per model provider/agent at a time.
- `plugins/compaction-ledger.js` — keeps `PLAN.md`, `AGENTS.md`, `HANDOFF.md`
  and `ISSUES.md` in compaction summaries so long sessions re-read their
  durable memory.

## Models

Agent files carry placeholders (`__ORCHESTRATOR_MODEL__`, `__PLANNER_MODEL__`,
`__VERIFIER_MODEL__`, `__IMPLEMENTER_MODEL__`, `# __IMPLEMENTER_OPTIONS__`);
`scripts/set-models.py` resolves them from gitignored `models.local.json` into
gitignored `agent.local/` and links it into `~/.config/opencode/agent`.
Defaults: verifier → planner, orchestrator → planner.

## Install

See [INSTALL.md](INSTALL.md). Quick form:

```bash
python3 scripts/set-models.py
ln -sfn "$PWD/command" ~/.config/opencode/command
find ~/.config/opencode/plugins -maxdepth 1 -name '*.js' -type l -delete
ln -sf "$PWD/plugins/"*.js ~/.config/opencode/plugins/
```

Then in any project run `/pipeline <task>`.

## Design notes

- **Mailbox orchestrator.** Reports are files, replies are one-line statuses,
  briefs are templates with a `<T>` slot. The router's whole context is a round
  counter and two task ids — no compaction, no prefill spiral, safe on a 9B
  local model.
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
- **V2 sketch:** parallel good-model supervision via an `ask_supervisor` tool
  — see [docs/supervision-v2.md](docs/supervision-v2.md).

## Verifying this repo

```bash
python3 -m py_compile scripts/set-models.py
node --check plugins/loop-breaker.js plugins/serialize-task.js plugins/compaction-ledger.js
python3 scripts/set-models.py --render          # re-render from models.local.json
grep -R "__.*_MODEL__\|__IF" agent.local        # must print nothing
```

`agent.local/` is the live agent directory: once
`~/.config/opencode/agent` points at it, never delete it or
`models.local.json` while linked — deleting them removes every agent from
OpenCode. Only remove both when you are uninstalling.
