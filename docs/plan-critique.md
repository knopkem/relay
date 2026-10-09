# Plan critique (design draft)

Status: **design draft**. Phase 0 (planner prompt rules) shipped 2026-10-09;
the critic tool and everything below it is shelved pending a benchmark (see
Rollout). Companion to [adaptive-planning.md](adaptive-planning.md).

## Why

The pipeline validates the implementation against the plan; nothing validates
the plan against the request. Every existing role — implementer, watcher,
milestone reviewer, verifier — treats `PLAN.md` as the standard, so a wrong
plan ships a wrong product that passes every gate.

The Boulder Dash case: "build a boulder dash game with classic rules" produced
a game where the player moved and rocks and diamonds existed, but the physics
were wrong (a rock kills only while falling). The failure chain:

1. an established domain was referenced but never inventoried or sourced;
2. acceptance criteria were structural ("player can move") instead of
   behavioral ("a falling rock kills; a resting rock does not"), so a broken
   implementation passes them;
3. no role maps request phrases to plan sections and criteria.

This is a **diligence and requirements-traceability gap**, not unknown
unknowns. A model is bad at "find what's missing" in the abstract, but good at
enumerating a known rule set when asked directly. The critic converts planner
laziness into explicit questions before code exists — the cheapest point to
fix a product defect.

## Knowledge variance and grounding

The critic is not an oracle. Two local models asked for the original Boulder
Dash rules disagreed on a load-bearing fact: one claimed the C64 original has
no exit door and completes on the last diamond; the other described the
quota-opens-an-exit model. An authoritative description of the 1984 game
confirms the quota-and-exit model; the first model was confidently wrong, and
had "self-corrected" from right to wrong. Both mixed releases — the 1984
original, Super Boulder Dash, later ports — and neither is trustworthy on the
mechanics that matter most (when a falling boulder kills, what can be stood
on).

Design consequences:

- model knowledge is a stochastic, version-entangled prior; agreement between
  critics is not truth, and majority vote is not either;
- **disagreement is the signal**: a rule one critic raises and another does
  not names exactly what the plan must pin and ground;
- resolutions come from grounding (a cited source, a manual, an executable
  oracle) or from the user — never from model memory;
- the plan must name its target (edition, port, version) and cite where the
  rules come from; an unpinned reference to an established domain is a
  blocker.

The resolution mechanism — when and how sources are fetched — is specified in
[research-grounding.md](research-grounding.md): critique detects, research
grounds, planner pins.

## Non-goals

- Catching what nobody knows: novel domains, true unknown unknowns,
  requirements discoverable only by building.
- Re-planning, redesigning or adding scope. The critic finds; the planner
  decides and owns `PLAN.md`.
- Style review of the plan, generic "consider edge cases" advice, or a second
  planner voice.
- Replacing human proofreading of the request. It narrows what a human must
  check; it does not remove the need.

## Capability boundaries

Can catch, with the right prompt:

- **domain rule inventory**: a request sentence referencing an existing domain
  ("classic rules", an RFC, a standard) with no enumerated rules in the plan;
- **weak acceptance criteria**: any criterion a superficially working
  implementation would pass;
- **internal contradictions**: milestones, interfaces or ACs that conflict;
- **request coverage gaps**: a noun or verb in the request with no plan
  section, milestone or AC;
- **infeasible technical claims** that can be named as research questions.

Cannot catch:

- rules the domain does not have or the model does not know;
- taste calls ("this architecture is nicer");
- defects that only appear when code runs against reality.

## Placement

```
planner → critique → implementer → verifier → …
```

Two enforcement levels, shipped in order:

1. **Nested tool (recommended first).** `critique_plan()` is available to the
   planner only, like `ask_supervisor` for the implementer. The planner calls
   it before replying `PLAN: ok`; the plugin runs a read-only `critic` in a
   child session, synchronously. Zero orchestrator change; the planner's own
   request has finished, so the provider is free even on a one-model setup.
2. **Orchestrator gate (hardening, only if needed).** A `critique` state
   between plan and implement: fresh `critic`, `CRITIQUE: pass` / `CRITIQUE: fail`,
   a capped planner fix pass, then one re-check. Mechanically enforced but adds
   states and protocol lines; adopt only if the tool version shows the planner
   ignoring findings.

## The critic agent

`agent/critic.md`, read-only:

- `read`, `glob`, `grep` allow; `edit`, `bash`, `task` deny;
- `webfetch` deny: grounding belongs to the `research` tool
  ([research-grounding.md](research-grounding.md)); the critic raises
  questions, research resolves them. Findings built on recalled knowledge say
  so and read as questions;
- model placeholder `__CRITIC_MODEL__`, default → verifier (so
  `scripts/set-models.py` gains a role, like watcher/reviewer); pick a
  different provider than the planner when two exist;
- independence: the nested call works on the same provider, but the same
  model shares the planner's blind spots; a different provider avoids quality
  correlation, not contention;
- free-tier caveat: it denies `bash`, so do not assign free-tier models.

The critic sees the **verbatim request** (passed by the planner), `PLAN.md`,
`ASSUMPTIONS.md`. Not `HANDOFF.md` (does not exist yet) and no earlier
conversation — fresh, adversarial.

### Disagreement mode (benchmark first, flag later)

Two critics on different models/providers read the same plan; the plugin
diffs their findings. A rule raised by one and not the other becomes an open
question in `PLAN-CRITIQUE.md`, never a silent verdict — the planner must
resolve it by citing a source or record it as an assumption; it may not pick a
side from memory. Needs two providers; falls back to one critic otherwise.
This is how the Boulder Dash split is harvested: the plan is forced to pin the
disputed rule and name its source. Unsettled disagreements route to the
`research` tool ([research-grounding.md](research-grounding.md)).

## Findings artifact

`PLAN-CRITIQUE.md` in the target root, written by the plugin (single writer,
like `REVIEW.md`), one section per critique:

```
## critique 1
C1 | blocker    | request: "classic rules" | classic rules include falling-rock
   lethality; plan and ACs do not define it | scenario: rock falls onto player
C2 | should-fix | AC4 "player can move" passes without push mechanics
   | scenario: push a rock into a wall
CRITIQUE: 1 blocker(s), 1 should-fix
```

- A finding without a named scenario, rule or request phrase is invalid and
  dropped. Cap ~8 findings; severities `blocker | should-fix | nit`.
- The planner appends one disposition line per finding —
  `C1 -> resolved: rule added to M2 and AC7` or
  `C2 -> rejected: push mechanics excluded by request 3; recorded in non-goals`.
  A rejection must cite the request or a non-goal.
- The final verifier re-checks open blocker findings during full verification,
  exactly like open `REVIEW.md` findings. The traceability chain becomes
  request → plan/milestone → AC → test.
- Every new planning pass (including a replan) appends a new section; earlier
  sections stay readable.

## Critic prompt contract

The prompt is the product:

- findings must be falsifiable: a named scenario, rule or request phrase;
- **domain inventory**: every request phrase referencing an existing domain
  yields rules the plan covers and rules it explicitly excludes; an uncited
  domain reference is a blocker;
- **pin the target**: an established but versioned domain (edition, port, spec
  revision) must be pinned in the plan, with a source for its rules;
- findings that rest on recalled model knowledge rather than a source cited
  in the plan say so explicitly, and read as questions, not verdicts;
- **weak-AC detector**: test every criterion with "would a superficially
  working implementation pass this?" — if yes, report it;
- adversarial stance: "assume this plan yields a demo that passes review but
  violates the request; name the violations";
- no style, no restated plan, no invented requirements; findings as payload;
- end with the `CRITIQUE:` summary line and nothing after it.

## Plugin mechanics

`plugins/plan-critic.js` (not a growth of `milestone.js`):

- registers tool `critique_plan` only when `OCODESA_CRITIQUE=on`; gated to
  `context.agent === "planner"`;
- tool input: `goal` (the verbatim request, required); the plugin attaches
  target paths and pre-fills the child session with the critic agent;
- one call per planner session (tracked by `sessionID`); timeout and budget
  constants at the top of the file, like `supervise.js`;
- writes `PLAN-CRITIQUE.md` and returns the findings text to the planner;
- critic missing, timeout or error → the tool returns "plan critique
  unavailable"; the planner continues and records it. The run never depends
  on the critic;
- `OCODESA_CRITIQUE_DEBUG=1` appends JSONL events to `.ocodesa/critique.jsonl`.

Planner prompt additions: call `critique_plan` before replying `PLAN: ok` when
the tool exists; resolve or reject every finding; never reply ok with an
unaddressed blocker. Add `PLAN-CRITIQUE.md` to the planner edit allowlist for
dispositions.

## Configuration

| Flag | Values | Default | Controls |
|---|---|---|---|
| `OCODESA_CRITIQUE` | `off\|on` | `off` | registers `critique_plan` for the planner |
| `OCODESA_CRITIQUE_DEBUG` | `1` | unset | `.ocodesa/critique.jsonl` |

## Interactions

- **Adaptive planning.** After a `PLAN-ISSUE` replan, run one fresh critique
  scoped to the changed milestones (same tool, same planner session,
  re-enabled). A replan is itself evidence the plan was wrong; skipping the
  re-check would trust the most suspect artifact.
- **Research.** Disagreements and unpinned domains route to the `research`
  tool; critique detects, research resolves. See
  [research-grounding.md](research-grounding.md).
- **Verifier.** Full verification re-checks unresolved `PLAN-CRITIQUE.md`
  blockers before its own findings.
- **Compaction ledger.** Add `PLAN-CRITIQUE.md` so long sessions re-read open
  findings.
- **Guards.** The critic never edits or runs bash, so loop-breaker and
  write-guard do not need a new role; `agent-gate.js` still gets `critic`
  added for consistency.

## Writer map

| Artifact | Writer |
|---|---|
| `PLAN.md`, `ASSUMPTIONS.md`, dispositions | planner |
| `PLAN-CRITIQUE.md` (findings) | plan-critic plugin |
| `HANDOFF.md` | implementer |
| `ISSUES.md` | verifier |
| `REVIEW.md` | milestone plugin |

## Failure modes

- Critic unavailable or times out → planner continues; the run is exactly as
  today, minus the critique. Recorded in `PLAN-CRITIQUE.md`.
- Planner never calls the tool (weak model) → no critique; unchanged run.
  Phase 2 measures call rate.
- Planner rejects all findings → allowed when each rejection cites the
  request; the verifier judges.
- Same-model critic misses the same thing the planner missed → residual risk;
  the benchmark below is the only honest measure.
- Plan bloat to satisfy the critic → findings are capped and must be
  decision-relevant; rejections cost one line, so padding is not forced.
- Critic finds nothing on a bad plan → silently useless; benchmark detects it.

## Verification plan (when implemented)

Plugin tests in `plugins/tests/plan-critic.test.js`, mock clients only:

- tool registered only when the flag is on; rejected for non-planner agents;
- one call per session, second call refused;
- findings file written in the exact format; `CRITIQUE:` summary present;
- unavailable critic → graceful text, file still written or explicitly noted;
- debug JSONL parses; plugin inert when off.

Benchmark (manual, needs models, not `node --test`): a small trap suite of
plans with seeded defects — the Boulder Dash version trap (a plan mixing the
1984 quota/exit model with Super Boulder Dash physics), pagination semantics,
token-refresh races, CSV quoting, DST handling — plus clean plans. Run one
critic, then two critics on different models, and check that their
disagreements surface as open questions rather than false consensus. Measure
detection rate of seeded blockers and false blockers on clean plans. The
suite lives in `evals/plan-critique/`; whoever edits the critic prompt reruns
it. Ship the critic enabled-by-default only if it clears the bar: ≥70% of
seeded blockers found, ≤1 false blocker per clean plan.

## Rollout

- **Phase 0 — shipped 2026-10-09** (no critic): the planner prompt requires
  the `## Interpretation` section with sourced domain rules and 2-3 concrete
  input→output examples per core AC. See `agent/planner.md`.
- **Phase 1 — shelved** until the Phase-0 rules demonstrably miss defects:
  tool behind `OCODESA_CRITIQUE=on`, benchmark harness, plugin tests.
- **Phase 2 — enable by default** if the benchmark clears the bar; measure
  call rate, findings per plan, disposition mix (resolved vs rejected).
- **Phase 3 — orchestrator gate** only if findings are routinely ignored.

## Decisions (2026-10-09)

- The nested tool is the v1 enforcement; the orchestrator `critique` state is
  a graduation path, adopted only if telemetry shows findings routinely
  ignored.
- `critic` is a dedicated role, default → verifier model, ideally on a
  different provider than the planner.
- One fresh re-critique per replan, scoped to the changed milestones.
- Grounding belongs to the `research` tool; the critic does not fetch.
- The plugin writes `PLAN-CRITIQUE.md` (single writer), never the critic.
- Benchmark bar: ≥70% of seeded blockers caught, ≤1 false blocker per clean
  plan; suite in `evals/plan-critique/`, rerun by whoever edits the prompt.
- Disagreement mode stays a manual/benchmark option for now; it becomes a
  `panel` flag only if it demonstrably adds signal.
- Unresolved findings reach the user through a fixed pointer line in the
  orchestrator's closing summary ("open items: PLAN-CRITIQUE.md,
  RESEARCH.md"); the orchestrator still reads no artifacts.
- A recalled rule that neither grounding nor disagreement can settle stays an
  assumption, never an accepted fact.
