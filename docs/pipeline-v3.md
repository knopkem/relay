# Pipeline v3 — plugin-driven orchestrator

Blueprint for replacing the model-driven orchestrator state machine with a
deterministic plugin driver. Branch v3 from v2 (keeps `supervise.js` and the
`node --test` harness). V1 fixes carry over: no step caps, `TASK.md` brief,
loop-breaker unchanged.

## Goal

`/pipeline` runs plan → implement → verify → audit (plus fix/polish rounds)
with all routing decisions made by code. The orchestrator model only calls one
tool and summarizes its result. No model ever parses a protocol line, tracks a
round counter, saves a session id, sleeps or waits.

Non-goals:

- No Jeff/Jev integration (revisit later, only for genuinely uncertain
  decisions).
- No changes to planner/implementer/verifier prompts or the mailbox protocol.
- No new model roles: the orchestrator reuses the planner model with thinking
  off.

## Constraints

- Base branch: v2. Do not regress `plugins/supervise.js`,
  `plugins/loop-breaker.js`, `plugins/serialize-task.js`,
  `plugins/compaction-ledger.js`.
- The orchestrator keeps `read` and `bash` allowed (OpenCode Zen free-tier
  requirement) but its prompt forbids using any tool except the three pipeline
  tools.
- `task` is denied for the orchestrator: the plugin spawns child sessions
  directly via `client.session.create` / `client.session.prompt`.
- Plugin-created sessions bypass `serialize-task` (it only guards the `task`
  tool). The driver's own lock covers pipeline runs; concurrent manual sessions
  on one provider stay the user's responsibility.

## Architecture

### `plugins/pipeline.js` (new)

Plugin factory:

```js
export const Pipeline = async ({ client, directory }) => ({ tool: { ... } })
export const __test = {
  extractProtocol, buildBrief, initialState, advance, drive,
  statePath, readState, writeState, formatSummary, countLines, describeError,
}
```

Constants:

```js
const ORCHESTRATOR_AGENT = "orchestrator"
const PLANNER_AGENT = "planner"
const IMPLEMENTER_AGENT = "implementer"
const VERIFIER_AGENT = "verifier"
const ROUND_CAP = 5
const QUICK_MAX_LINES = 5
const LOCK_STALE_MS = 2 * 60 * 60 * 1000
const STATE_DIR = ".ocodesa"
const STATE_FILE = "pipeline.json"
const CONTINUATION_LIMIT = 1
const VERDICT_MAX = 200
```

Module state:

```js
const activeRuns = new Map()   // directory -> { startedAt }
```

#### Protocol parsing

```js
// Returns null when no expected line is present.
// Scans assistant text lines from last to first; first match wins.
// { status, reason?, changed?, line }
function extractProtocol(text, phase)
```

Patterns per phase (match with `RegExp`, trim each line first):

| phase | lines accepted | parsed |
|---|---|---|
| `plan` | `^PLAN: ok\b`, `^PLAN-FAIL:\s*(.+)$` | `{status:"ok"}` / `{status:"fail", reason}` |
| `implement`, `fix` | `^IMPL: ok\b`, `^BLOCKED:\s*(.+)$` | `ok` / `blocked` |
| `verify`, `recheck` | `^VERIFY: pass changed=(app\|tests\|none)\b`, `^VERIFY: fail\b` | `pass` + `changed` / `fail` |
| `audit` | `^AUDIT: pass\b`, `^AUDIT: fail\b` | `pass` / `fail` |
| `polish` | `^FIXED: ok\b`, `^BLOCKED:\s*(.+)$` | `ok` / `blocked` |

`VERIFY: pass` without `changed=` is malformed. If `text` is empty or has no
match, return `null`.

#### Brief builders — copy verbatim, fill `<T>`

```js
// key is one of the brief keys in the table below
function buildBrief(key, { directory, task })
```

| key | text |
|---|---|
| `planFile` | `## Target: <T>\n## Brief: <T>/TASK.md\nWrite PLAN.md.` |
| `planQuick` | `## Target: <T>\n## Goal: <task>\nWrite PLAN.md.` |
| `implement` | `## Target: <T>\n## Plan: <T>/PLAN.md\nRead AGENTS.md too. Implement the entire plan in one go.` |
| `implementResume` | same header plus `\nYou were interrupted. Read HANDOFF.md if it exists, continue the plan, keep HANDOFF.md updated, run the plan's build/test commands.` |
| `verify` | `## Target: <T>\n## Plan: <T>/PLAN.md\n## Handoff: <T>/HANDOFF.md\nFull verification.` |
| `recheck` | verify header plus `\nRe-check mode: only the findings in the latest section of ISSUES.md.` |
| `fix` | `## Target: <T>\n## Plan: <T>/PLAN.md\n## Fix: <T>/ISSUES.md\nFix only the findings still open in the latest section.` |
| `audit` | `## Target: <T>\n## Plan: <T>/PLAN.md\nMODE: audit — read the latest section of ISSUES.md.` |
| `polish` | `## Target: <T>\n## Fix: <T>/ISSUES.md\nFix only the audit findings in the latest section; keep test changes justified.` |

Continuation brief, used once when a reply is malformed (agent-family
specific, `<line>` = the expected protocol line(s) for the phase):

```
## Target: <T>
Your previous reply was interrupted or contained no protocol line.
Read <report file> and bring it up to date, then reply with exactly one line:
<line>
```

Report file per family: planner `PLAN.md`, implementer `HANDOFF.md`, verifier
`ISSUES.md`.

#### Session helpers

```js
async function createChild(client, parentID, title)
// client.session.create({ body: { parentID, title } })
// {error} -> throw Error(describeError(error)); returns data.id

async function promptChild(client, { id, agent, text, signal })
// client.session.prompt({ path:{id}, body:{agent, parts:[{type:"text", text}]}, signal })
// returns { error, text }: text = non-empty text parts joined "\n",
// contiguous duplicates dropped (same as supervise.js)

function describeError(error)
// string | error.data.message | error.message | JSON.stringify
```

`promptChild` is wrapped by the driver:

```js
async function promptParse(ctx, { id, agent, phase, brief })
// 1. reply = await promptChild(...)
//    - reply.error and ctx.signal.aborted -> { kind: "aborted" }
//    - reply.error otherwise               -> { kind: "error", reason }
// 2. parsed = extractProtocol(reply.text, phase)
// 3. if parsed return { kind: "reply", parsed, line: parsed.line }
// 4. if continuation budget remains: send the continuation brief to the SAME
//    session id, parse again, one attempt only
// 5. otherwise { kind: "malformed", reason: `malformed reply from <agent>` }
```

#### State file

Path `<T>/.ocodesa/pipeline.json`, created with `fs.mkdirSync(dir,{recursive:true})`,
written atomically (`writeFileSync(tmp)` then `renameSync(tmp, file)`).

```json
{
  "version": 1,
  "directory": "/abs/target",
  "status": "running",
  "phase": "plan",
  "round": 0,
  "sessions": { "planner": null, "implementer": null, "polisher": null },
  "verdicts": [],
  "reason": null,
  "startedAt": "2026-10-06T00:00:00.000Z",
  "updatedAt": "2026-10-06T00:00:00.000Z"
}
```

`status` ∈ `running | done | failed | blocked | aborted`. Write after every
transition; append `parsed.line` (truncated to `VERDICT_MAX`) to `verdicts`.

#### State machine

`drive(ctx, state)` where
`ctx = { client, directory, parentID, task, signal, onPhase }` and `state` is
the state-file object. Loop until a terminal status, then return `state`.

| phase | dispatch | reply | next |
|---|---|---|---|
| `plan` | planner, fresh unless `sessions.planner` exists, brief `planFile` or `planQuick` | `PLAN: ok` | `implement` |
| | | `PLAN-FAIL` | stop `failed` |
| `implement` | implementer, fresh; `sessions.implementer = id`; brief `implement`, or `implementResume` when resuming | `IMPL: ok` | `verify` |
| | | `BLOCKED` | stop `blocked` |
| `verify` | verifier, fresh; `sessions.polisher = id`; brief `verify` | `pass changed=app` | `audit` |
| | | `pass changed=tests\|none` | stop `done` |
| | | `fail` | `fix` |
| `audit` | verifier, fresh (never overwrites polisher); brief `audit` | `AUDIT: pass` | stop `done` |
| | | `AUDIT: fail` | `polish` |
| `fix` | `round += 1`; if `round > ROUND_CAP` stop `blocked`; resume `sessions.implementer`; brief `fix` | `IMPL: ok` | `recheck` |
| | | `BLOCKED` | stop `blocked` |
| `recheck` | verifier, fresh; `sessions.polisher = id`; brief `recheck` | same transitions as `verify` | |
| `polish` | `round += 1`; if `round > ROUND_CAP` stop `blocked`; resume `sessions.polisher`; brief `polish` | `FIXED: ok` | `audit` |
| | | `BLOCKED` | stop `blocked` |

Stop sets `status`, `reason` (when present), writes state and returns.
Malformed/error/aborted replies stop with `blocked` / `failed` / `aborted`
respectively, reason included. On abort, call
`client.session.abort({ path: { id: activeSessionID } })` before stopping so
the child turn does not keep running. `onPhase(state)` is called before every
dispatch with the title `pipeline: <phase>` plus ` r<round>` when
`round > 0`.

#### Tools

```js
run_pipeline({ task })      // task optional string
pipeline_status()
pipeline_resume()
```

All three first check `context.agent === ORCHESTRATOR_AGENT` and return
`"run_pipeline is only available to the orchestrator agent."` otherwise.

`run_pipeline`:

1. `const dir = context.directory`.
2. `countLines(task) > QUICK_MAX_LINES` → return
   `"PLAN-FAIL: brief too large; write it to TASK.md and run /pipeline"`.
3. No `task` and `!fs.existsSync(path.join(dir, "TASK.md"))` → return
   `"PLAN-FAIL: no TASK.md brief"`.
4. Lock: refuse `"pipeline already running in <dir>"` when `activeRuns` has
   the directory and `Date.now() - startedAt < LOCK_STALE_MS`; sweep stale
   entries first.
5. Build `initialState`, `context.metadata({ title: "pipeline: plan" })`.
6. `await drive(...)` with `signal: context.abort`; in `finally`: release lock.
7. Return `formatSummary(state, dir)`.

`pipeline_status`: if `activeRuns` has `dir`, return live phase + `stateFile`
content; else read the state file if present, list which of `PLAN.md`,
`HANDOFF.md`, `ISSUES.md` exist, return the summary. Missing state file →
`"no pipeline run recorded in <dir>"`.

`pipeline_resume`:

1. Read state file; missing → `"no pipeline run to resume in <dir>"`.
2. `status === "done"` → `"pipeline already done; start a new run"`.
3. Directory locked → refuse.
4. For phases past `plan`, `PLAN.md` missing → `"cannot resume: PLAN.md is
   missing; start a new run"`.
5. Set `status = "running"`, acquire lock, `await drive(ctx, state)` with
   `ctx.parentID = context.sessionID`, release lock in `finally`, return the
   summary.

Resume semantics inside `drive`: fresh-by-design phases (`plan` when
`sessions.planner` is missing, `verify`, `audit`, `recheck`) create new child
sessions; `implement`/`fix` resume `sessions.implementer`; `polish` resumes
`sessions.polisher`; `plan` with a saved planner session resumes it with the
continuation brief.

#### Summary

```js
function formatSummary(state, directory)
```

Lines: `pipeline <status> — <phase>[: <reason>]`; `rounds: <n>`;
`verdicts: <a → b → …>`; `artifacts: <existing of PLAN.md, HANDOFF.md,
ISSUES.md>`; `resume: call pipeline_resume` when status is not `done`.

### `plugins/supervise.js` (edit)

Plugin-created implementer sessions have no `task` part and
`session.create` cannot set an agent, so the supervisor never classifies them.
Add lazy classification:

- `stateFor` initial state gains `classified: false`.
- New helper in the closure:

```js
async function classify(state, sessionID) {
  if (state.implementer || state.classified) return
  state.classified = true
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    if (res?.data?.agent === "implementer") state.implementer = true
  } catch {}
}
```

- In the `event` handler, for `message.part.updated` tool parts, before the
  `state?.implementer` check: `await classify(state, part.sessionID)`.

`ask_supervisor` already gates on `context.agent === "implementer"`, so
plugin-created implementer sessions get it unchanged.

### `agent/orchestrator.md` (rewrite)

```markdown
---
description: Thin shim over the pipeline plugin. Calls one tool and reports.
mode: primary
model: __ORCHESTRATOR_MODEL__
reasoningEffort: none
chat_template_kwargs:
  enable_thinking: false
temperature: 0.1
permission:
  read: allow
  glob: allow
  grep: allow
  list: allow
  edit: deny
  bash: allow
  webfetch: deny
  websearch: deny
  task: deny
---

You are the **orchestrator**, a thin shim over the pipeline plugin. You never
route, read, edit or wait — a tool does the work.

- `/pipeline`: call `run_pipeline` once with no arguments.
- `/pipeline-quick <task>`: call `run_pipeline` once with `task` set to the text.
- User asks for status: call `pipeline_status` once.
- User asks to continue after an interruption: call `pipeline_resume` once.
- Never call any other tool, never retry a failed tool call.

After the tool returns, summarize its output in at most 6 lines: what shipped,
the last verdict, rounds, residual risk. No preamble, no recap.

## Voice
- Answer first: `[thing] [action] [reason]. [next step].`
- One idea per sentence, 20 words max, active voice. Code, commands, paths,
  numbers and error strings stay verbatim.
```

`set-models.py` needs no change: `orchestrator` already defaults to `planner`.

### `command/pipeline.md` / `command/pipeline-quick.md` (rewrite)

`pipeline.md`:

```markdown
---
description: Plugin-driven plan → implement → verify pipeline (brief in TASK.md)
agent: orchestrator
---

Call the `run_pipeline` tool exactly once with no arguments; it reads
`TASK.md` in the current directory. Then report its output to the user.
```

`pipeline-quick.md`: same, with `task: $ARGUMENTS` and the note that the tool
rejects briefs over 5 lines.

### Docs

- README: flow diagram shows the plugin driving; orchestrator row becomes the
  shim; plugin list adds `pipeline.js`; Models note stays (orchestrator →
  planner default, thinking off); Verifying adds `node --test`.
- INSTALL: usage unchanged except no mention of the orchestrator parsing
  protocol lines.

## Implementation order

1. Parser + briefs + state file I/O (`extractProtocol`, `buildBrief`,
   `initialState`, `readState`, `writeState`, `countLines`,
   `formatSummary`, `describeError`).
2. Session helpers + mock client test harness.
3. `drive` fresh-run state machine + recovery.
4. `pipeline_resume` + `pipeline_status`.
5. Custom tools, lock, orchestrator agent and commands.
6. `supervise.js` classification edit.
7. README/INSTALL and end-to-end manual run.

## Acceptance criteria

- AC1: `/pipeline` with `TASK.md` produces `PLAN.md`, `HANDOFF.md` and
  `ISSUES.md` through plugin-created sessions; the orchestrator session
  contains exactly one tool call plus one short summary.
- AC2: every transition comes from `extractProtocol`; no model decision is
  involved in routing, round counting or session ids.
- AC3: audit runs only after `VERIFY: pass changed=app`; fix/polish never
  exceed 5 rounds; stopping after the cap reports it.
- AC4: a malformed child reply triggers exactly one continuation to the same
  session, then a stop with a reason.
- AC5: aborting the tool call aborts the active child session and persists
  `status: "aborted"`.
- AC6: `pipeline_status` reports phase, round, sessions and artifacts;
  `pipeline_resume` continues from `implement` and `polish`, and refuses when
  live or done.
- AC7: unit tests pass via `node --test plugins/tests/*.test.js`.
- AC8: supervision still engages for plugin-created implementer sessions
  (`ask_supervisor` works, advisories record).
- AC9: no `steps`/step caps anywhere; loop-breaker and compaction-ledger
  untouched.

## Test plan

`plugins/tests/pipeline.test.js`, plain `node --test` with a mock client:

```js
function mockClient(replies)  // replies: { planner: [...], implementer: [...], verifier: [...] }
// session.create -> { data: { id: "ses_" + n } }, ids recorded in creation order
// session.prompt -> pops the next reply for body.agent, returns
//   { data: { parts: [{ type: "text", text }] } }
// session.get -> { data: { agent } }; session.abort -> records the id
```

Tests:

1. parser: last matching line wins; prose and other protocol lines ignored.
2. parser: `VERIFY: pass` without `changed=` is malformed.
3. parser: `PLAN-FAIL` and `BLOCKED` reasons extracted.
4. happy path `changed=none`: 3 child sessions, no audit, status done.
5. `changed=app` audit pass: 4 sessions, status done.
6. audit fail → polish resumes the same verifier id → audit pass; round 1.
7. verify fail → fix resumes the implementer id → recheck fresh verifier →
   pass `changed=app` → audit.
8. round cap: persistent `VERIFY: fail` stops after 5 fix dispatches.
9. `PLAN-FAIL` stops immediately with status failed and the reason.
10. `BLOCKED` stops with status blocked and the reason.
11. malformed reply → one continuation to the same session, then continues.
12. malformed twice → stop, reason mentions malformed.
13. prompt `{error}` → stop failed; state keeps session ids.
14. abort signal → `session.abort` called on the active child; status aborted.
15. `run_pipeline` without `TASK.md` → error string, no sessions created.
16. quick task over 5 lines → error string, no sessions created.
17. `task` present wins over `TASK.md` (quick mode).
18. non-orchestrator agent → refused string.
19. concurrent run in the same directory → refused.
20. state file written after each transition; phase/round match.
21. `pipeline_status` reports phase, round and existing artifacts.
22. resume with status done → refused.
23. resume from implement → same implementer id is prompted again.
24. resume from polish → same polisher id is prompted again.
25. resume without `PLAN.md` → refused with reason.
26. resume while locked → refused.

Commands:

```bash
node --check plugins/pipeline.js plugins/supervise.js plugins/loop-breaker.js \
  plugins/serialize-task.js plugins/compaction-ledger.js
node --test plugins/tests/*.test.js
python3 scripts/set-models.py --render
grep -R "__.*_MODEL__\|__IF" agent.local     # must print nothing
```

Manual end-to-end: create a scratch dir with `TASK.md`, run `/pipeline`, watch
the tool title progress, interrupt mid-implement, then `pipeline_resume` and
confirm it continues from the saved phase.
