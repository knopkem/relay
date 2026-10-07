---
description: Plugin-driven plan → implement → verify pipeline (short inline brief)
agent: orchestrator
---

Call the `run_pipeline` tool exactly once with `task` set to: $ARGUMENTS
Then report its output to the user. The tool rejects briefs over 5 lines;
write longer briefs to `TASK.md` and use `/pipeline`.
