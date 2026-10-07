---
description: Plan → implement → verify pipeline with a short inline task
agent: orchestrator
---

Run the mailbox pipeline. Target = the current working directory.

The brief is this short task, quoted verbatim: $ARGUMENTS

If that brief is empty or longer than 5 lines, reply exactly
`PLAN-FAIL: brief empty or too large; write it to TASK.md and run /pipeline`
and stop.

Subagents run only through the `task` tool, which blocks until the reply
arrives — never dispatch or wait with bash, echo or sleep. Never read
PLAN.md, HANDOFF.md or ISSUES.md; route on the one-line protocol replies
only. Follow your state machine: planner (P) → implementer (I) →
verifier (V), then audit/fix/polish rounds per your instructions. End with a
short user-facing summary: what shipped, the last verdict, fixes made, and
residual risk.
