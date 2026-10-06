# V2 sketch — parallel good-model supervision

V1 runs one implementer to completion and only verifies afterwards; its
durable state already lives in `PLAN.md`, `HANDOFF.md` and `ISSUES.md`, and
every role reports a single protocol line. The waste this design targets: the
good model sits idle while the fast implementer explores dead ends. V2 keeps
both models busy by letting them talk mid-task, reusing those artifacts as the
watcher's read surface.

## Why it can work

While a tool call executes, the implementer's LLM request has already
finished, so the model provider is free — even when both roles use the same
model. A tool result is therefore a safe, synchronous channel back to a good
model.

## Components

1. `plugins/supervise.js`
   - tracks the implementer's child session from the task part metadata
     (`sessionID`) and keeps a small flight recorder of recent tool calls,
     failures and edited files; reads `PLAN.md`/`HANDOFF.md`/`ISSUES.md` for
     state instead of replaying transcripts where possible;
   - exposes a custom tool `ask_supervisor(question, context?)` to the
     implementer only. `execute` starts a watcher session on the good model
     with PLAN.md plus the flight recorder, asks for at most two sentences of
     direction, and returns the answer as the tool result. The implementer
     blocks only while genuinely stuck;
   - optionally queues advisory notes into the implementer session
     (`client.session.prompt`) when hard drift signals appear: repeated
     identical failures, a long edit run with no green command, edits outside
     the plan's file list. Advisory only, rate-limited, never more than one per
     N steps.
2. `watcher` agent (good model, read-only): answers with direction only —
   never code, never plan rewrites; if the plan itself is wrong it says
   "report a blocker" instead.

## Why pull beats push

A watcher guessing from events needs trigger heuristics and can deliver stale
advice mid-step. The implementer asking at the exact moment of uncertainty
needs no heuristics, the answer is never stale, and the cost is proportional
to real uncertainty. Passive drift notes stay a safety net, not the main
channel.

## Open questions for V2

- One persistent watcher session per run vs a fresh one per question: fresh
  has no drift, persistent reuses context.
- How the implementer prompt should phrase the ask trigger ("before your
  second attempt at the same failure", "before deviating from the plan").
- Whether to expose the same channel over MCP for use outside opencode.
- Rate/cost limits and an off switch
  (`OCODESA_SUPERVISE=off|advisory|full`).
