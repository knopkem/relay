# Parallel supervision

The `supervise` plugin and read-only `watcher` agent give direction while a
fast implementer works. Relay ships dual plugin entrypoints: OpenCode V1
1.18.29+ calls each plugin's `server()` function; V2 loads its stable-ID
default definition and registers hooks through `setup(ctx)`.

The plugin API package is a runtime dependency. Run `npm install` in the Relay
checkout before linking the plugins globally. The V2 entrypoint uses
`@opencode/plugin`; V1 behavior stays in the existing named plugin factories.

## The three channels

1. **Pull — `ask_supervisor(question)`.** The implementer calls it when stuck:
   after the same failure twice, before deviating from the plan, or after
   about 20 steps without progress. The plugin runs the watcher in a child
   session and returns at most two sentences. The implementer blocks only
   while genuinely uncertain.
2. **Canned advisories.** Deterministic nudges, no model call: 15+ edits with
   no build, 40 read/search steps with no edit, the same command failing
   three times, and 15+ edits since the last passing command. Failing
   commands are detected from failure markers in output because tool exit
   metadata is not consistently reliable. The note is injected into the next
   implementer model context.
3. **Async prereview and escalation.** Every 25 tool calls the plugin asks
   the watcher in the background to review recent actions against the plan.
   When an advisory trigger fires in `full` mode, it also pushes the failure
   signals (failed runs since the last passing command and recent failures).
   The answer is injected when ready; notes older than two minutes are
   dropped, and a plain `continue` is discarded. If the watcher is
   unavailable, the canned advisory stays.

The watcher session persists for the implementer session, so `PLAN.md` is
prefilled once. In `advisory` mode the pull tool and prereview are disabled
and only canned advisories run. In `pull` mode `ask_supervisor` stays while
escalation and prereview are off.

## V2 plugin API

- `ask_supervisor` is registered with `ctx.tool.transform` and has a JSON
  Schema input requiring `question`. Its executor returns structured tool
  content.
- V2 tool hooks use `ctx.tool.hook("execute.before"/"execute.after")`. The
  shared adapter translates V2 event IDs and input/result fields for the
  existing recorder and guards; V2 `shell` and `subagent` IDs normalize to
  Relay's legacy `bash` and `task` names.
- The plugin subscribes to `ctx.event.subscribe()` for session lifecycle
  events. Subscriptions stop when OpenCode unloads the plugin.
- Advisories are injected into the next outgoing user message through
  `ctx.session.hook("context")`. The hook resolves the session's own project
  directory before reading `PLAN.md` or writing `.relay/supervise.jsonl`.
- The watcher prompt uses V2 session APIs: create a child session, switch it
  to the `watcher` agent, admit the prompt, wait for completion, and read its
  final assistant text from session context. Missing assistant text is treated
  as an unavailable watcher response, not an empty successful answer.

The plugin uses the V1 `experimental.chat.messages.transform` hook only in its
V1 `server()` implementation. V2 does not load V1 hooks.

## Same-model guard

The plugin compares the `implementer` and `watcher` models lazily through the
agent API. When they are identical, `full` automatically downgrades to `pull`:
`ask_supervisor` still works because a fresh context on the same weights can
break a loop, while automatic push channels would add correlated noise and
provider contention. The answer carries a `(same-model supervisor —
cross-check against PLAN.md)` note. If the API cannot tell the models apart,
full supervision remains enabled.

## Configuration

- `RELAY_SUPERVISE=off|advisory|pull|full` — default `full`. `off` makes the
  plugin inert; `pull` keeps `ask_supervisor` and disables escalation and
  prereview; `advisory` keeps only canned advisories.
- `RELAY_SUPERVISE_DEBUG=1` — append JSONL events to
  `.relay/supervise.jsonl` in the implementer's project (asks, injections,
  and errors).
- Budgets (constants at the top of `plugins/supervise.js`): 10 asks per run,
  one ask per minute; 3 canned advisories, five minutes apart; 4 prereviews,
  five minutes apart.

## Watcher

`agent/watcher.md` is a read-only subagent on the verifier model by default
(`set-models.py` role `watcher`, default → verifier). It answers with
direction only, never code, and says "report a blocker" when the plan itself
is wrong. Point it at a different model than `implementer`; otherwise the
same-model guard limits supervision to `pull` (ask only).

## Failure modes and verification

- No watcher agent installed or a failed watcher call: `ask_supervisor`
  reports the failure; the implementer continues with `PLAN.md`.
- Cancelling an implementer ask propagates its V2 tool signal to the watcher
  session request. Plugin unload aborts the event subscription and any
  outstanding watcher requests owned by the plugin.
- `node --test plugins/tests/*.test.js` exercises both plugin APIs with mock
  clients/contexts and does not require a model or server. Also run `/pipeline`
  in a scratch project after updating OpenCode to confirm plugin loading,
  permissions, and end-to-end behavior.
