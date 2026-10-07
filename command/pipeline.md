---
description: Plan → implement → verify mailbox pipeline
agent: orchestrator
---

Run the mailbox pipeline on: $ARGUMENTS

If the task above is empty or whitespace, use planner brief form P2 with the
brief file `<cwd>/TASK.md`. If `TASK.md` does not exist, stop and ask the
user for a task — dispatch nothing.

Target = the current working directory. Follow your state machine: planner
(P) → implementer (I) → verifier (V), then audit/fix/polish rounds per your
instructions. Never read PLAN.md, HANDOFF.md or ISSUES.md; route on the
one-line protocol replies only. End with a short user-facing summary: what
shipped, the last verdict, fixes made, and residual risk.
