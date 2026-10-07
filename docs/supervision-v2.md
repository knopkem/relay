# Parallel supervision (v2)

V1 runs one fast implementer through the whole plan and verifies afterwards.
V2 keeps the good model busy *while* the implementer works: the `supervise`
plugin and the read-only `watcher` agent give direction mid-task so dead ends
end early instead of becoming fix rounds.

## Why it works

While a tool call executes, the implementer's LLM request has finished, so the
model provider is free — even when both roles share a model. A plugin tool
call is therefore a safe, synchronous channel back to a good model. Both facts
were verified on opencode 1.18.34 (nested `session.prompt` from a tool
`execute` returns text without deadlock; `experimental.chat.messages.transform`
mutations reach the model; plugin tools use their bare name and receive
`context.agent`).

## The three channels

1. **Pull — `ask_supervisor(question)`.** The implementer calls it when stuck:
   after the same failure twice, before deviating from the plan, or after ~20
   steps without progress. The plugin runs the watcher in a child session and
   returns at most two sentences. The implementer blocks only while genuinely
   uncertain.
2. **Canned advisories.** Deterministic nudges, no model call: 15+ edits with
   no build, 40 read/search steps with no edit, the same command failing
   three times, and 15+ edits since the last passing command. Failing
   commands are detected from failure markers in the output (this opencode
   build reports `metadata.exit = 0` even for failing commands). The note is
   injected into the implementer's next model step as a synthetic text part
   via `experimental.chat.messages.transform`.
3. **Async prereview and escalation.** Every 25 tool calls the plugin asks the
   watcher in the background (non-blocking) to review recent actions against
   the plan; when an advisory trigger fires in `full` mode, it also pushes the
   same question with the failure signals (failed runs since the last passing
   command, recent failures). The answer is injected when ready; notes older
   than two minutes are dropped, and a plain `continue` is discarded. If the
   watcher is unavailable, the canned advisory stays.

The watcher session persists for the implementer session, so PLAN.md is
prefilled once. In advisory-only mode (`OCODESA_SUPERVISE=advisory`) the pull
tool and prereview are disabled and only canned advisories run.

**Same-model guard.** At startup the plugin compares the `implementer` and
`watcher` models via the agents API. When they are identical, supervision
auto-downgrades to advisory-only and `ask_supervisor` is not registered — a
watcher on the implementer's own model adds no information. If the API cannot
tell the models apart, full supervision is kept.

## Configuration

- `OCODESA_SUPERVISE=off|advisory|full` — default `full`. `off` makes the
  plugin inert.
- `OCODESA_SUPERVISE_DEBUG=1` — append JSONL events to
  `.ocodesa/supervise.jsonl` in the target project (asks, injections, errors).
- Budgets (constants at the top of `plugins/supervise.js`): 10 asks per run,
  one ask per minute; 3 canned advisories, five minutes apart; 4 prereviews,
  five minutes apart.

## Watcher

`agent/watcher.md` is a read-only subagent on the verifier model by default
(`set-models.py` role `watcher`, default → verifier). It answers with
direction only, never code, and says "report a blocker" when the plan itself
is wrong. Point it at a different model than `implementer`; otherwise the
same-model guard makes supervision advisory-only.

## Failure modes and fallbacks

- No watcher agent installed → `ask_supervisor` returns "supervisor
  unavailable" and the implementer continues.
- Watcher call fails or times out → same; the run never depends on the
  supervisor.
- Threaded through `context.abort`, so cancelling the implementer cancels the
  nested watcher request.
