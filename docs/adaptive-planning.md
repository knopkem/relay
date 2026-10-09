# Adaptive planning (design draft)

Status: **design draft**. Shelved until plan-level failure telemetry justifies
it; see Rollout. Nothing below changes current runs.

## Why

Agile steering without a stakeholder degrades into moving goalposts, so the
pipeline keeps a frozen plan. The cost: a plan-level error (impossible
contract, refuted assumption, contradictory acceptance criterion) is terminal —
`CONTRACT-ISSUE` / `BLOCKED` stop the run. The system can detect a wrong
decision but never correct it.

This design adds the smallest adaptive loop that stays verifiable:

- the **ends** — goal, non-goals, acceptance criteria — never move;
- the **means** — files, architecture, milestone order, milestone detail — may
  be revised once, from recorded evidence, under a cap.

Three pieces, independently shippable and separately gated:

1. **Assumptions ledger** — the planner states the unknowns the design rests on.
2. **Spike milestones** — cheap evidence that settles an unknown before
   dependent work is committed or detailed.
3. **Replan-on-blocker** — a capped, evidence-triggered plan revision state in
   the orchestrator.

## Non-goals

- Rolling-wave revision of the whole tail. Deferred detail (JIT) was measured
  as no-win and removed; this design does not re-ship it.
- Continuous agent steering, goal changes, scope changes while running.
- Moving test authorship to the implementer, or a verifier pass per milestone.
- Commits, branches or worktrees — the no-git rule stands.

## Invariants

- Goal, non-goals and acceptance criteria are immutable for a run. A revise
  planner that cannot resolve the issue without touching them replies
  `PLAN-FAIL: AC conflict` and the run stops for the user.
- Every revision is caused by recorded evidence (a command output, a spike
  result), never by preference. The revised plan is still the contract.
- One writer per artifact at any time (see table below).
- A revision that affects already-built milestones must say so explicitly
  (`rework:` list); the implementer revisits them, the final verifier re-checks
  all criteria regardless.
- The orchestrator stays a tiny router: one new counter (`replans`), one new
  state, one new brief template; no artifact reads.
- All new behavior is behind env flags, default off, per repo convention.

## 1. Assumptions ledger

**Artifact:** `ASSUMPTIONS.md` in the target root. Planner-owned, written in the
same pass as `PLAN.md`.

**Format:** at most ~10 lines, one per assumption, stable ids:

```
A3 | high | The auth crate exposes refresh with a rotating token | validate: spike M2 | fallback: implement rotation wrapper
A4 | med  | Existing sessions tolerate a 5-minute grace window            | validate: AC3 edge test  | fallback: drop grace, note in AC
A5 | high | Target is the 1984 C64 ruleset, not later ports               | validate: research R2    | fallback: pin the documented fan ruleset
```

Rules:

- Only **load-bearing** assumptions: if false, the design, the scope or the
  feasibility of an AC changes.
- The ledger records **recognized** uncertainty only. It cannot list what
  nobody thought of; it makes known unknowns explicit instead of implicit.
- Version-dependent domains are pinned: when the request names an established
  but versioned domain (edition, port, spec revision), the plan states which
  target it implements and where the rules come from — two models can
  disagree on the facts ([plan-critique.md](plan-critique.md)); research
  grounds them ([research-grounding.md](research-grounding.md)).
- Planner permissions gain `ASSUMPTIONS.md` and `**/ASSUMPTIONS.md` in
  `agent/planner.md`; `plugins/compaction-ledger.js` adds the file so long
  sessions re-read it.

**Who updates what:** the ledger is write-once per planning pass (like
`PLAN.md`); status is never edited there. The implementer records outcomes in
`HANDOFF.md` under `## Assumption checks` (`A3 refuted — evidence: <command,
output>`); the verifier cross-checks every high-risk assumption during full
verification and reports any left unverified; the milestone reviewer may cite
assumption ids in findings.

**Implementer decision rule:** when a milestone proves an assumption false:

- a workable fallback exists → execute the fallback, record the deviation;
- no fallback works → `PLAN-ISSUE` (replan on) or `BLOCKED` (off) as today.

## 2. Spike milestones

The planner may schedule a spike as a normal milestone heading with a marker:

```
### M2 — SPIKE: does the vendor SDK support rotating refresh tokens?
```

The heading shape is unchanged, so `plugins/milestone.js` parsing, snapshots
and boundary review keep working.

Rules:

- Files under `spikes/<id>/` only. Deliverable is **evidence, not code**.
- Acceptance criterion: the question is answered, and the exact command, its
  output and the conclusion are recorded in `HANDOFF.md` under
  `## Spike results`. The build/test command must stay green.
- Spike code is never imported by production milestones; the production
  implementation always happens later, in a normal milestone. Spike files
  stay under `spikes/` — no cleanup milestone; the final verifier checks that
  nothing production imports them.
- Dependent milestones come after the spike: the planner must not detail
  dependent work before the spike's result exists.
- Budget: at most 3 spikes per plan, at most 1 flagged high-cost. Each spike
  ends on a definitive answer or after 2 failed probes; "inconclusive" is
  recorded honestly and treated as refuted for replan purposes.
- Reviewing a spike: the reviewer judges the evidence (real command, real
  output, honest conclusion), not code quality; the only blocker is missing or
  contradicted evidence.

## 3. Replan-on-blocker

### Protocol

The implementer may reply `PLAN-ISSUE: <one line reason>` instead of `BLOCKED`
only when all three hold:

1. the full evidence is already recorded in `HANDOFF.md` (exact command and
   output, or spike result);
2. the contradiction is with `PLAN.md` or `ASSUMPTIONS.md`, not with the code,
   the environment or a missing tool;
3. no pre-specified fallback works.

Everything else is `BLOCKED`, unchanged. Only the implementer emits
`PLAN-ISSUE`; a plan-level discovery in verification stays `VERIFY: fail`, and
the implementer relays it from fix mode with the ISSUES evidence.

### Orchestrator state machine

New state `replan`, reachable from `implement` (2) and `fix` (5). The
orchestrator keeps one extra counter, `replans`, independent of `round`.

1. On `PLAN-ISSUE:` — `replans += 1`; if `replans > REPLAN_CAP` (default 2),
   stop and report.
2. Dispatch a **fresh** planner in revise mode (PR brief below). The
   orchestrator passes only the one-line reason it parsed, plus paths — the
   evidence is `HANDOFF.md`, which the planner reads itself.
3. `PLAN: ok` → resume the implementer with the revised-plan brief (same saved
   `task_id`; identity across files matters). `PLAN-FAIL` → stop and report.
4. The step after the resume is a fresh verifier, exactly as state 3. A
   replan resets `round` to 0: failures counted against a plan now known
   wrong are obsolete. `REPLAN_CAP` is 2, so the run stays bounded.

The orchestrator's context grows by one integer and one template. It still
never reads artifacts.

### Revise brief (PR, new template)

```
## Target: <T>
## Plan: <T>/PLAN.md
## Issue: <the child's one-line reason>
## Handoff: <T>/HANDOFF.md
## Assumptions: <T>/ASSUMPTIONS.md
MODE: revise — resolve the issue by amending the means only: architecture,
files, milestone order, test-plan detail. Never change the goal, non-goals or
acceptance criteria; if that is required, reply one line:
PLAN-FAIL: AC conflict — <what>. Append one line to `## Plan history`:
`rev <n> | <issue> | changed: <sections> | rework: <milestones|none> | AC: unchanged`.
Do not touch code. Reply one line: PLAN: ok
```

### Stale artifacts after a revision

- `REVIEW.md` findings cite snapshot hashes; the existing hash-mismatch rule
  ("re-derive, do not repeat") already covers revisions.
- `HANDOFF.md` is updated by the implementer when it resumes; `ISSUES.md` only
  at the next verify.

### Acceptance-criteria anchor

A plugin snapshots `PLAN.md` into `.ocodesa/baseline/PLAN.md` at the first
implementer edit. The verifier diffs the acceptance-criteria section against
that baseline; a mismatch is a blocker. The planner instruction and the
`AC: unchanged` line in the Plan history entry stay as documentation, but the
snapshot is the machine check — the ends-frozen invariant cannot rest on a
prompt alone.

### Gating

`OCODESA_REPLAN=on|off` (default off). The orchestrator prompt carries the
replan state unconditionally. The implementer only learns it may emit
`PLAN-ISSUE` from a plugin-injected `[adaptive]` note when the flag is on —
the same injection pattern the milestone plugin uses for its `[reviewer]`
notes; prefer a new `plugins/adaptive.js` (scoped through
`plugins/lib/agent-gate.js`) over growing `milestone.js`. A stray `PLAN-ISSUE` while off stops the run and is
reported — never guessed through. The watcher's static line "if the plan itself
is wrong, report a blocker" becomes "report a plan issue"; the implementer maps
that to `PLAN-ISSUE` or `BLOCKED` depending on the flag.

## Configuration

| Flag | Values | Default | Controls |
|---|---|---|---|
| `OCODESA_ASSUMPTIONS` | `off\|on` | `off` | planner note: write the ledger and allowed spike milestones; implementer/verifier/reviewer ledger duties |
| `OCODESA_REPLAN` | `off\|on` | `off` | implementer note (`PLAN-ISSUE`) and the orchestrator replan state |
| `OCODESA_ADAPTIVE_DEBUG` | `1` | unset | append JSONL events to `.ocodesa/adaptive.jsonl` |

The flags are independent: replan works without the ledger (the issue line
plus HANDOFF evidence is enough); the ledger enriches planning and verification
but never triggers anything by itself.

## Writer map

| Artifact | Writer |
|---|---|
| `PLAN.md`, `ASSUMPTIONS.md` | planner |
| `HANDOFF.md` | implementer |
| `ISSUES.md` | verifier |
| `REVIEW.md` | milestone plugin |
| `.ocodesa/*` | plugins |

## Failure modes

- Revise planner unavailable or replies `PLAN-FAIL` → stop and report; the
  run's state is on disk.
- `replans` cap reached → stop and report; same issue raised twice should be
  visible in the Plan history and is capped anyway.
- A refuted assumption with no fallback and replan off → `BLOCKED` (today's
  behavior).
- Spike inconclusive → recorded as refuted; replan or fallback decides.
- Replan rewrites an AC despite the rule → caught by the baseline snapshot in
  the verifier pass (see Acceptance-criteria anchor).
- Provider contention: the revise planner queues behind milestone reviews on
  the same provider (`serialize-task`), so a replan can arrive a boundary late.
  Acceptable: correctness over latency.

## Verification plan (when implemented)

Plugin tests in `plugins/tests/adaptive.test.js`, mock clients only:

- the `[adaptive]` note is injected only into planner/implementer sessions,
  only when the matching flag is on, and is byte-exact about the protocol line;
- plugin inert in `build`/`plan` sessions (agent-gate) and when flags are off;
- debug log events are written atomically and parse as JSONL.

Render checks: `agent/planner.md` permission includes `ASSUMPTIONS.md`; the
existing `agent.local` grep invariant still passes.

Manual end-to-end: a scratch project with one factually impossible contract →
implementer raises `PLAN-ISSUE:` → planner amends → verify passes; an
AC-conflict scenario stops with `PLAN-FAIL`; replan off reproduces today's
`BLOCKED`.

## Rollout

Nothing here is built. Before Phase 1, instrument: count `CONTRACT-ISSUE` /
plan-level `BLOCKED` / spec deviations across runs. If plan-level failures are
a real tax, build in order: Phase 1 ledger (planner prompt + permission +
compaction entry + gate note) → Phase 2 spikes → Phase 3 replan (orchestrator
state + adaptive plugin + cap). Each phase lands separately, tests first,
default off. Enable by default only when measured: replans within cap end in
`VERIFY: pass`, refuted assumptions are rare but real, spikes conclude rather
than stall, and fix rounds do not increase.

## Decisions (2026-10-09)

- `REPLAN_CAP = 2`; a replan resets `round` to 0 — failures counted against a
  plan now known wrong are obsolete, and two replans bound the run.
- The AC anchor is the hard baseline snapshot in v1, not a prompt-level claim.
- Only the implementer emits `PLAN-ISSUE`; verifier discoveries relay through
  `VERIFY: fail` and a fix round.
- The milestone reviewer gets no `plan` severity in v1; revisit after replan
  is proven.
- Spike files are kept under `spikes/`; no cleanup milestone.
- Two independent flags (`OCODESA_ASSUMPTIONS`, `OCODESA_REPLAN`), not one
  level flag.
- The revise planner is always fresh, seeded by `HANDOFF.md` and
  `ASSUMPTIONS.md`.

## See also

- [plan-critique.md](plan-critique.md) — validating the plan against the
  request before implementation. Upstream complement to this draft: critique
  prevents plan errors, replan repairs the ones that slip through.
