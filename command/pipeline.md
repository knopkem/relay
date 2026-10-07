---
description: Plan → implement → verify mailbox pipeline (brief in TASK.md)
agent: orchestrator
---

Run the mailbox pipeline. Target = the current working directory.

The brief is the file `TASK.md` in the target: check it exists with
`glob`/`ls`, pass its path to the planner, and never open it. If `TASK.md`
does not exist, reply exactly `PLAN-FAIL: no TASK.md brief` and stop.

Never treat text after this command as the brief; ignore it completely.
Subagents run only through the `task` tool, which blocks until the reply
arrives — never dispatch or wait with bash, echo or sleep.
Never read PLAN.md, HANDOFF.md or ISSUES.md; route on the one-line protocol
replies only. Follow your state machine: planner (P) → implementer (I) →
verifier (V), then audit/fix/polish rounds per your instructions. End with a
short user-facing summary: what shipped, the last verdict, fixes made, and
residual risk.
