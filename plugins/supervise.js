// Parallel good-model supervision for the running implementer.
//
// Three channels:
//   1. ask_supervisor(question) — the implementer pulls direction when stuck.
//      While the tool executes the implementer's LLM request has finished, so
//      the provider is free and the watcher can answer synchronously.
//   2. Canned advisories — deterministic nudges on drift signals, injected
//      into the next model step as a synthetic text part.
//   3. Async prereview — every PREREVIEW_EVERY tool calls the plugin asks the
//      watcher in the background for one direction and injects it when ready;
//      stale notes are dropped.
//
// The watcher runs as the `watcher` agent (read-only, good model) in a child
// session that persists for the implementer session, so the plan is prefilled
// once. Everything is gated by OCODESA_SUPERVISE=off|advisory|pull|full
// (default full) and becomes a no-op when no watcher agent is configured.
//
// The same-model downgrade is resolved LAZILY (first completed tool event, the
// first ask_supervisor call, or the first watcher prompt) — never in this
// factory: the factory runs inside opencode's instance bootstrap, and an
// opencode API call from there deadlocks startup into a blank TUI. A same-model
// pair downgrades full to pull, not to advisory: an explicit ask still helps
// (fresh context, summarized problem), while the push channels would only add
// correlated noise and provider contention.

import fs from "node:fs"
import path from "node:path"

const ASK_BUDGET = 10
const ASK_MIN_INTERVAL_MS = 60_000
const ADVISORY_MAX = 3
const ADVISORY_MIN_INTERVAL_MS = 5 * 60_000
const EDIT_RUN_LIMIT = 15
const EDITS_SINCE_PASS_LIMIT = 15
const FAIL_REPEAT_LIMIT = 3
const EXPLORE_RUN_LIMIT = 40
const PREREVIEW_EVERY = 25
const PREREVIEW_MIN_INTERVAL_MS = 5 * 60_000
const PREREVIEW_MAX = 4
const PREREVIEW_STALE_MS = 2 * 60_000
const RECORDER_MAX = 60
const RECORDER_SEND = 40
const PLAN_CHAR_CAP = 30_000
const ANSWER_CHAR_CAP = 1500
const WATCHER_AGENT = "watcher"
const HANDOFF_NUDGE =
  "you are stuck in a loop; tools may lock soon. Update HANDOFF.md now — files changed, exact failing command, what remains — then stop and reply BLOCKED: <reason>."

function resolveMode(value) {
  const raw = String(value ?? "full").toLowerCase()
  if (raw === "off" || raw === "advisory" || raw === "pull" || raw === "full") return raw
  return "full"
}

function normalizeCommand(command) {
  return String(command ?? "").replace(/\s+/g, " ").trim()
}

function truncate(text, max = 100) {
  const s = String(text ?? "")
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function summarizeTool(tool, input = {}) {
  if (tool === "bash") return `bash: ${truncate(normalizeCommand(input.command))}`
  if (tool === "edit" || tool === "write" || tool === "apply_patch") {
    return `${tool}: ${truncate(input.filePath ?? input.filepath ?? "", 120)}`
  }
  if (tool === "read") return `read: ${truncate(input.filePath ?? "", 120)}`
  if (tool === "grep" || tool === "glob") return `${tool}: ${truncate(input.pattern ?? "", 80)}`
  if (tool === "task") return `task: ${truncate(input.subagent_type ?? input.description ?? "", 80)}`
  return tool
}

function firstLine(text, max = 120) {
  return truncate(String(text ?? "").split("\n")[0], max)
}

// This opencode build reports metadata.exit = 0 even for failing commands, so
// command success is inferred from common failure markers in the output.
const FAIL_LINE_RE =
  /^\s*(?:error(?:\[[A-Z0-9]+\])?:|FAILED\b|failures?:|panicked at|thread .* panicked|Traceback \(most recent call last\)|npm ERR!|AssertionError|[\w.$]*(?:Exception|Error):)/

function failureLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => FAIL_LINE_RE.test(line))
}

function outputFailed(text) {
  return failureLines(text).length > 0
}

function firstFailureLine(text) {
  return firstLine(failureLines(text)[0] ?? "")
}

function recorderLines(entries, limit = RECORDER_SEND) {
  return entries
    .slice(-limit)
    .map((entry) => `- ${entry.summary}${entry.ok ? "" : ` [FAILED${entry.error ? `: ${entry.error}` : ""}]`}`)
    .join("\n")
}

function pickAdvisory(counters, supervisorEnabled = true) {
  const orAsk = supervisorEnabled
    ? "call ask_supervisor, or report the blocker"
    : "or report the blocker"
  if (counters.repeatedFail) {
    return `the same command has failed ${FAIL_REPEAT_LIMIT} times. Stop retrying — change the approach, ${orAsk}.`
  }
  if ((counters.editsSincePass ?? 0) >= EDITS_SINCE_PASS_LIMIT) {
    return `${EDITS_SINCE_PASS_LIMIT}+ edits since the last passing command. Stop and rethink: run the plan's build/test command, ${orAsk}.`
  }
  if (counters.edits >= EDIT_RUN_LIMIT) {
    return `you have made ${EDIT_RUN_LIMIT}+ edits with no build or test run. Run the plan's build/test command now, or report a blocker.`
  }
  if (counters.explore >= EXPLORE_RUN_LIMIT) {
    return `you have explored for ${EXPLORE_RUN_LIMIT} steps with no edit. Stop exploring and take the next concrete step from the plan.`
  }
  return null
}

function failureSignals(state) {
  const lines = []
  if (state.failedRuns > 0) {
    lines.push(`- ${state.failedRuns} failed command run(s) since the last passing command`)
  }
  if (state.editsSincePass > 0) {
    lines.push(`- ${state.editsSincePass} edit(s) since the last passing command`)
  }
  const recent = state.entries.filter((entry) => !entry.ok).slice(-3)
  for (const entry of recent) {
    lines.push(`- recent failure: ${entry.summary}${entry.error ? ` — ${entry.error}` : ""}`)
  }
  return lines
}

// Model-aware supervision: an explicit ask to the implementer's own model
// still helps (fresh context, summarized problem), but automatic push channels
// would add correlated noise on the same provider — so a same-model pair
// downgrades to "pull": ask_supervisor stays, prereview/escalation switch off.
// Unknown models keep full supervision.
function agentModels(agents) {
  const list = Array.isArray(agents) ? agents : []
  const format = (model) =>
    model && model.providerID && model.modelID ? `${model.providerID}/${model.modelID}` : null
  const find = (name) => list.find((agent) => agent?.name === name)?.model
  return { implementer: format(find("implementer")), watcher: format(find("watcher")) }
}

function modelsDiffer({ implementer, watcher }) {
  if (!implementer || !watcher) return null
  return implementer !== watcher
}

async function detectModels(client, directory) {
  try {
    const res = await client.app.agents({ query: { directory } })
    if (res?.error) return null
    return agentModels(res?.data)
  } catch {
    return null
  }
}

function withAskReminder(text, { supervisorEnabled, advisories, asks, asksAtLastAdvisory }) {
  if (!supervisorEnabled) return text
  if (advisories > 0 && asks === asksAtLastAdvisory) {
    return `${text} You did not use ask_supervisor for the previous advisory — call it now with the exact failing command.`
  }
  return text
}

function shouldPrereview(state, now) {
  if (state.prereviews >= PREREVIEW_MAX) return false
  if (state.sincePrereview < PREREVIEW_EVERY) return false
  if (state.watcherBusy) return false
  return now - state.lastPrereviewAt >= PREREVIEW_MIN_INTERVAL_MS
}

function planExcerpt(text, cap = PLAN_CHAR_CAP) {
  const s = String(text ?? "")
  if (s.length <= cap) return s
  return `${s.slice(0, cap)}\n[…plan truncated at ${cap} chars…]`
}

const sessions = new Map()

function stateFor(sessionID) {
  let state = sessions.get(sessionID)
  if (!state) {
    state = {
      implementer: false,
      entries: [],
      calls: 0,
      sincePrereview: 0,
      edits: 0,
      editsSincePass: 0,
      explore: 0,
      fails: new Map(),
      failedRuns: 0,
      advisories: 0,
      lastAdvisoryAt: 0,
      asks: 0,
      asksAtLastAdvisory: 0,
      lastAskAt: 0,
      prereviews: 0,
      lastPrereviewAt: 0,
      watcherBusy: false,
      pending: null,
      watcherSessionID: null,
      plan: null,
      planAt: 0,
    }
    sessions.set(sessionID, state)
  }
  return state
}

export const Supervisor = async ({ client, directory }) => {
  let mode = resolveMode(process.env.OCODESA_SUPERVISE)
  if (mode === "off") return {}

  function writeLog(entry) {
    if (!process.env.OCODESA_SUPERVISE_DEBUG) return
    try {
      const dir = path.join(directory, ".ocodesa")
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(
        path.join(dir, "supervise.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      )
    } catch {
      // logging must never take the run down
    }
  }

  // "closed" = no supervision at all (off/advisory), "open" = definitely
  // different models, "same" = same-model pair (pull only), "unknown" = the
  // agents API has not answered yet (keep full supervision until it does).
  // Resolution is LAZY on purpose: this factory runs inside opencode's instance
  // bootstrap, so calling the opencode API from it (client.app.agents) waits on
  // a server that is itself waiting for this plugin to finish loading — startup
  // then hangs on a blank TUI with no error in the log. The first hook that
  // needs the gate resolves it instead.
  let watcherGate = mode === "full" || mode === "pull" ? "unknown" : "closed"

  async function resolveGate(reason) {
    if (watcherGate !== "unknown") return watcherGate
    const pair = await detectModels(client, directory)
    if (pair && modelsDiffer(pair) === false) {
      if (mode === "full") mode = "pull"
      watcherGate = "same"
      writeLog({ kind: "downgrade", reason, to: mode, model: pair.implementer })
      return watcherGate
    }
    watcherGate = "open"
    return watcherGate
  }

  async function watcherAllowed() {
    if (watcherGate === "unknown") await resolveGate("same-model-late")
    return watcherGate !== "closed"
  }

  function readPlan(state) {
    try {
      const file = path.join(directory, "PLAN.md")
      const stat = fs.statSync(file)
      if (state.plan !== null && state.planAt === stat.mtimeMs) return state.plan
      state.plan = planExcerpt(fs.readFileSync(file, "utf8"))
      state.planAt = stat.mtimeMs
      return state.plan
    } catch {
      return null
    }
  }

  async function askWatcher(state, ownerSessionID, promptText, signal) {
    if (!(await watcherAllowed())) {
      throw new Error("watcher disabled: supervision is off")
    }
    if (!state.watcherSessionID) {
      const created = await client.session.create({
        body: { title: `supervisor for ${ownerSessionID}`, parentID: ownerSessionID },
      })
      if (created?.error) throw new Error(describeError(created.error))
      const id = created?.data?.id
      if (!id) throw new Error("could not create watcher session")
      state.watcherSessionID = id
    }
    const options = {
      path: { id: state.watcherSessionID },
      body: { agent: WATCHER_AGENT, parts: [{ type: "text", text: promptText }] },
    }
    if (signal) options.signal = signal
    const res = await client.session.prompt(options)
    if (res?.error) throw new Error(describeError(res.error))
    const parts = res?.data?.parts ?? []
    const texts = []
    for (const part of parts) {
      if (part.type !== "text") continue
      const text = String(part.text ?? "").trim()
      if (!text || text === texts[texts.length - 1]) continue
      texts.push(text)
    }
    return texts.join("\n").slice(0, ANSWER_CHAR_CAP)
  }

  function watchPrompt(state, heading, body) {
    const plan = readPlan(state)
    const lines = ["You are supervising a fast implementer mid-task."]
    if (plan && !state.watcherSessionID) lines.push("", "## PLAN.md", plan)
    lines.push("## Recent actions", recorderLines(state.entries) || "- (none)")
    const signals = failureSignals(state)
    if (signals.length) lines.push("", "## Failure signals", ...signals)
    lines.push(heading, body)
    lines.push(
      "",
      "Answer with at most two sentences of concrete direction. No code, no plan rewrites.",
    )
    return lines.join("\n")
  }

  function queueCanned(state, text, urgent = false) {
    const now = Date.now()
    if (!urgent) {
      if (state.advisories >= ADVISORY_MAX) return
      if (now - state.lastAdvisoryAt < ADVISORY_MIN_INTERVAL_MS) return
    }
    if (state.pending) return
    state.advisories++
    state.lastAdvisoryAt = now
    state.pending = { text, at: now, source: "advisory" }
    writeLog({ kind: "advisory", text })
  }

  function maybePrereview(state, sessionID) {
    if (mode !== "full") return
    const now = Date.now()
    if (!shouldPrereview(state, now)) return
    state.sincePrereview = 0
    state.prereviews++
    state.lastPrereviewAt = now
    state.watcherBusy = true
    askWatcher(
      state,
      sessionID,
      watchPrompt(
        state,
        "## Task",
        "Review the recent actions against the plan. Reply exactly `continue` if it is on track, otherwise give the single most useful direction right now.",
      ),
    )
      .then((text) => {
        const value = (text ?? "").trim()
        if (!value || /^continue\.?$/i.test(value) || state.pending) return
        state.pending = { text: value, at: Date.now(), source: "prereview" }
        writeLog({ kind: "prereview", sessionID, text: value })
      })
      .catch((error) => writeLog({ kind: "prereview-error", sessionID, error: String(error) }))
      .finally(() => {
        state.watcherBusy = false
      })
  }

  // Push-based escalation: when a trigger fires, ask the watcher for direction
  // with the failure signals; the canned advisory is already queued as a
  // fallback, so a slow or unavailable watcher never stalls the run.
  function escalate(state, sessionID, signal) {
    if (mode !== "full" || state.watcherBusy) return
    state.watcherBusy = true
    askWatcher(
      state,
      sessionID,
      watchPrompt(
        state,
        "## Signals",
        `${signal}\nThe implementer looks stuck in a loop. Reply with the single most useful direction right now, at most two sentences. Do not reply continue.`,
      ),
    )
      .then((text) => {
        const value = (text ?? "").trim()
        if (!value || /^continue\.?$/i.test(value) || state.pending) return
        state.pending = { text: value, at: Date.now(), source: "escalation" }
        writeLog({ kind: "escalation", sessionID, text: value })
      })
      .catch((error) => writeLog({ kind: "escalation-error", sessionID, error: String(error) }))
      .finally(() => {
        state.watcherBusy = false
      })
  }

  function record(state, sessionID, part) {
    const tool = part.tool
    const input = part.state?.input ?? {}
    const output = part.state?.output ?? part.state?.metadata?.output ?? ""
    const exit = part.state?.metadata?.exit
    const failedExit = tool === "bash" && typeof exit === "number" && exit !== 0
    const failedOutput = tool === "bash" && outputFailed(output)
    const ok = part.state?.status === "completed" && !failedExit && !failedOutput
    const entry = { at: Date.now(), summary: summarizeTool(tool, input), ok }
    if (!ok) {
      entry.error =
        firstLine(part.state?.error) ||
        (failedExit ? `exit ${exit}` : firstFailureLine(output))
    }
    state.entries.push(entry)
    if (state.entries.length > RECORDER_MAX) state.entries.shift()
    state.calls++
    state.sincePrereview++

    if (tool === "edit" || tool === "write" || tool === "apply_patch") {
      state.edits++
      state.editsSincePass++
      state.explore = 0
    } else if (tool === "read" || tool === "glob" || tool === "grep" || tool === "list") {
      state.explore++
    } else if (tool === "bash" || tool === "task") {
      state.edits = 0
      state.explore = 0
    }

    let repeatedFail = false
    if (tool === "bash") {
      const fingerprint = normalizeCommand(input.command)
      if (ok) {
        state.fails.delete(fingerprint)
        state.failedRuns = 0
        state.editsSincePass = 0
      } else {
        state.failedRuns++
        const seen = (state.fails.get(fingerprint) ?? 0) + 1
        if (seen >= FAIL_REPEAT_LIMIT) {
          state.fails.delete(fingerprint)
          repeatedFail = true
        } else {
          state.fails.set(fingerprint, seen)
        }
      }
    }

    if (!ok && /loop breaker/i.test(entry.error ?? "")) {
      queueCanned(state, HANDOFF_NUDGE, true)
    }

    const supervisorEnabled = watcherGate !== "closed"
    const advisory = pickAdvisory(
      {
        edits: state.edits,
        explore: state.explore,
        repeatedFail,
        editsSincePass: state.editsSincePass,
      },
      supervisorEnabled,
    )
    if (advisory) {
      state.edits = 0
      state.explore = 0
      const text = withAskReminder(advisory, {
        supervisorEnabled,
        advisories: state.advisories,
        asks: state.asks,
        asksAtLastAdvisory: state.asksAtLastAdvisory,
      })
      queueCanned(state, text)
      state.asksAtLastAdvisory = state.asks
      escalate(state, sessionID, advisory)
    }

    maybePrereview(state, sessionID)
  }

  function describeError(error) {
    if (!error) return "unknown error"
    if (typeof error === "string") return error
    if (typeof error.data?.message === "string") return error.data.message
    if (typeof error.message === "string") return error.message
    return JSON.stringify(error)
  }

  const hooks = {
    tool: {
      ask_supervisor: {
        description:
          "Ask the read-only supervisor for direction when stuck: after the same failure twice, before deviating from PLAN.md, or after ~20 steps without progress. Returns at most two sentences. Advisory only — PLAN.md outranks it.",
        args: {
          question: {
            type: "string",
            description: "One sentence: what are you stuck on?",
          },
        },
        execute: async (args, context) => {
          if (context.agent !== "implementer") {
            return "ask_supervisor is only available to the implementer agent."
          }
          await resolveGate("same-model-late")
          if (mode === "off" || mode === "advisory") {
            return `Supervision is in ${mode} mode; ask_supervisor is disabled. Continue with PLAN.md.`
          }
          const state = stateFor(context.sessionID)
          state.implementer = true
          const now = Date.now()
          if (state.asks >= ASK_BUDGET) {
            return "Supervisor ask budget exhausted. Continue with PLAN.md and note open items in HANDOFF.md."
          }
          if (now - state.lastAskAt < ASK_MIN_INTERVAL_MS) {
            return "Supervisor rate limit (one ask per minute). Continue; ask again later."
          }
          if (state.watcherBusy) {
            return "Supervisor is busy. Continue; ask again after the next step."
          }
          const question = String(args?.question ?? "").trim()
          if (!question) return "ask_supervisor needs a question."
          state.asks++
          state.lastAskAt = now
          state.watcherBusy = true
          try {
            const answer = await askWatcher(
              state,
              context.sessionID,
              watchPrompt(state, "## Question", question),
              context.abort,
            )
            const sameModel = watcherGate === "same"
            writeLog({ kind: "ask", sessionID: context.sessionID, question, answer, same_model: sameModel })
            if (!answer) return "Supervisor returned nothing. Continue with PLAN.md."
            return sameModel
              ? `${answer}\n(same-model supervisor — cross-check against PLAN.md)`
              : answer
          } catch (error) {
            writeLog({ kind: "ask-error", sessionID: context.sessionID, error: String(error) })
            return `Supervisor unavailable: ${describeError(error)}. Continue; note it in HANDOFF.md.`
          } finally {
            state.watcherBusy = false
          }
        },
      },
    },

    event: async ({ event } = {}) => {
      if (event?.type === "session.deleted") {
        const id = event.properties?.info?.id ?? event.properties?.sessionID
        if (id) {
          const state = sessions.get(id)
          if (state?.implementer) {
            writeLog({
              kind: "session-summary",
              sessionID: id,
              asks: state.asks,
              advisories: state.advisories,
              calls: state.calls,
            })
          }
          sessions.delete(id)
        }
        return
      }
      if (event?.type !== "message.part.updated") return
      const part = event.properties?.part
      if (!part || part.type !== "tool" || !part.sessionID) return
      if (part.tool === "task") {
        const child = part.state?.metadata?.sessionID
        const subagent = part.state?.input?.subagent_type
        if (child && subagent === "implementer") stateFor(child).implementer = true
        return
      }
      const state = sessions.get(part.sessionID)
      if (!state?.implementer) return
      const status = part.state?.status
      if (status !== "completed" && status !== "error") return
      await resolveGate("same-model")
      record(state, part.sessionID, part)
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output?.messages ?? []
      const sessionID = messages[0]?.info?.sessionID
      if (!sessionID) return
      const state = sessions.get(sessionID)
      if (!state?.pending) return
      const note = state.pending
      state.pending = null
      const stale =
        (note.source === "prereview" || note.source === "escalation") &&
        Date.now() - note.at > PREREVIEW_STALE_MS
      if (stale) return
      const lastUser = [...messages].reverse().find((msg) => msg.info?.role === "user")
      if (!lastUser) return
      lastUser.parts.push({ type: "text", text: `[supervisor] ${note.text}`, synthetic: true })
      writeLog({ kind: "inject", sessionID, source: note.source, text: note.text })
    },
  }
  return hooks
}

Supervisor.__test = {
  resolveMode,
  normalizeCommand,
  summarizeTool,
  firstLine,
  outputFailed,
  recorderLines,
  pickAdvisory,
  failureSignals,
  agentModels,
  modelsDiffer,
  withAskReminder,
  shouldPrereview,
  planExcerpt,
}
