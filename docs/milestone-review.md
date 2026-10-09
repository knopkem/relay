# Milestone review

The pipeline keeps one implementer session for the whole plan (identity across
files matters), so the good model sits idle between planning and final
verification. Milestone review fills that idle time without letting a second
writer into the tree: the implementer freezes a snapshot at each milestone
boundary, and a read-only reviewer inspects the frozen copy while the
implementer continues with the next milestone.

Two problems shape the design:

1. **Staleness.** Reviewing the live worktree races the implementer: torn
   reads, findings against moved lines, feedback applied to code that already
   changed. The answer is to review a frozen artifact, not a moment: the
   plugin copies the milestone's files (sha256 manifest) and the reviewer only
   reads that copy. Findings cite the snapshot hash; the implementer compares
   the live file before applying, and the final verifier re-checks what is
   left.
2. **Contention.** One provider serves one session at a time
   (`serialize-task.js`). Background reviews only pay off when the reviewer
   runs on a different provider; otherwise they just interleave with the
   builder. On a same-provider (one-LLM) setup `auto` downgrades to a serial
   inline review at the boundary, where the implementer is paused anyway.

## The boundary tool

`milestone_done({ milestone, summary, final? })`, available to the
implementer only. The implementer calls it after each milestone's build/test
pass and HANDOFF update, with the id from PLAN.md. The call:

1. snapshots the files changed since the last boundary;
2. awaits the previous milestone's review up to `BOUNDARY_WAIT_MS` (120s) and
   reports its summary in the tool result;
3. queues this milestone's review in the background (review mode) or runs it
   inline (serial mode);
4. on the last milestone (`final: true`, or inferred from PLAN.md) awaits the
   review up to `FINAL_WAIT_MS` (5 min) before the implementer replies.

The tool never throws: snapshot or reviewer failures come back as text and the
run continues.

## Snapshot

`.ocodesa/review/M<id>/` — atomic (tmp dir + rename), write-once (a repeat
boundary creates `M<id>-2`), with:

- `files/<path>` — the frozen copies;
- `manifest.json` — `{ milestone, at, files: [{path, sha256, bytes}], skipped: [...] }`;
- `report.md` — the HANDOFF.md copy at the boundary.

The file set is the edit recorder (every `edit`/`write`/`apply_patch` since the
last boundary, which also catches writes rerouted by `write-guard`) plus an
mtime sweep of the project as a backstop. Caps: 300 files, 2 MB per file,
40 MB total, 5000 sweep entries; anything skipped is listed with a reason.
`.git`, dependency and build directories, `.ocodesa` itself and `REVIEW.md` are
never included.

## Findings

The reviewer appends findings to `REVIEW.md` as `## milestone <id>` sections
(plugin-written, so there is never a second writer). Format:
`path:line @ sha256 | blocker|should-fix|nit | rationale`, ending with
`MILESTONE-REVIEW: clean` or `MILESTONE-REVIEW: <n> blocker(s), <m> should-fix`.

- **Blockers** are injected into the implementer's next model step as
  `[reviewer] …` synthetic parts; the implementer fixes them immediately.
- **Everything else** is batched: the next boundary's tool result summarizes
  the previous review, and the final verifier re-checks every open finding
  (a finding whose snapshot hash no longer matches is re-derived, not
  repeated).
- The reviewer is **read-only on code** — unlike the verifier it never fixes,
  or its writes would collide with the running implementer. The implementer is
  nudged once if 60 edits pass without a boundary call.

## Modes

`OCODESA_MILESTONE=auto|off|review|serial` (default `auto`) and
`OCODESA_PLAN=auto|full|jit` (default `full`).

| Setup | Resolved behavior |
|---|---|
| reviewer provider ≠ implementer provider | background reviews; JIT enabled when the planner is also on another provider |
| reviewer provider = implementer provider | serial inline reviews; JIT stays off |
| `OCODESA_MILESTONE=review` on the same provider | downgraded to serial, logged |
| `off` | plugin inert |
| detection fails | configured mode kept, logged |

The gate compares **providers**, not model ids, and is resolved lazily on the
first edit or `milestone_done` call — never in the plugin factory, which runs
during opencode's bootstrap and must not call the API (see
`supervision-v2.md`).

`OCODESA_MILESTONE_DEBUG=1` appends JSONL events (boundaries, reviews, detail
jobs, downgrades, injections) to `.ocodesa/milestone.jsonl`.

## JIT planning (`OCODESA_PLAN=auto|full|jit`, default `full`)

Opt-in, off by default. `auto` (and `jit`) switch PLAN.md to contracts only —
machine-readable blocks (`### M<id> — <title>` under `## Milestones`) listing
files, exact signatures, dependencies and acceptance criteria per milestone —
and a persistent nested planner session writes `MILESTONES/<id>.md` detail docs
on demand. The docs are **advisory — PLAN.md wins**, and a contract that must
change is flagged with `CONTRACT-ISSUE:` instead of silently drifting. A
`PLAN-NOTES.md` ledger (one line per design decision) seeds the planner if its
session ever restarts.

Measured with a slow, thinking-heavy planner, the split **does not reduce
planning latency** — the chain of thought dominates, not the output size — and
the detail jobs compete with milestone reviews for the same provider. It stays
behind a flag: `full` writes the complete plan in one pass and frees the good
model for reviews during the build; `jit` forces the split even when provider
detection is unavailable.

## Watcher interplay

`watcher` (pull supervision) and `reviewer` both consume the good model. On a
two-model setup put the watcher on the flash model — `supervise` then
downgrades to `pull` by design — or accept that provider-level queuing
serializes them.

## Failure modes and fallbacks

- Reviewer agent missing or prompt fails → the boundary reports
  `review of <id> failed: …`; the run continues, the final verifier still
  gates.
- Snapshot fails → the tool returns the error as text; nothing is queued.
- Plugin never loaded or `milestone_done` missing → the implementer continues
  normally and records nothing; the pipeline is exactly as before.
- No boundary calls (weak model) → at most two nudges, then no reviews; final
  verification is unchanged.
- Findings applied late → hash comparison at application time; unresolved or
  moot findings are re-checked by the final verifier.
