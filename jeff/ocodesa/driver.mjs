// The ocodesa pipeline state machine for the jeff-code runtime.
//
// No model routes anything: every transition comes from the protocol line a
// role session returned (extractProtocol) and from the fixed table in
// docs/pipeline-v3.md. State is persisted after every transition, so a stopped
// run can be resumed with pipeline-resume.
//
// The dispatcher is injected: production uses one `jeff --mode rpc` child per
// session (dispatcher.mjs); tests use a scripted mock.

import fs from "node:fs"
import path from "node:path"
import { buildBrief, continuationBrief, QUICK_MAX_LINES } from "./briefs.mjs"
import { countLines, expectedLine, extractProtocol } from "./protocol.mjs"
import { addVerdict, initialState, sessionIdFor, writeState } from "./state.mjs"

const REPORT_FILE = {
  planner: "PLAN.md",
  implementer: "HANDOFF.md",
  verifier: "ISSUES.md",
  audit: "ISSUES.md",
}

export function describeError(error) {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Validates the brief requirement before anything is dispatched.
 * @returns {string|null} the exact PLAN-FAIL line, or null when the run may start.
 */
export function validateRun({ directory, quick = false, task = null, quickMaxLines = QUICK_MAX_LINES, exists = fs.existsSync }) {
  if (quick) {
    if (task === undefined || task === null || String(task).trim() === "") {
      return "PLAN-FAIL: brief empty or too large; write it to TASK.md and run /pipeline"
    }
    if (countLines(task) > quickMaxLines) {
      return "PLAN-FAIL: brief empty or too large; write it to TASK.md and run /pipeline"
    }
    return null
  }
  if (!exists(path.join(directory, "TASK.md"))) return "PLAN-FAIL: no TASK.md brief"
  return null
}

function allocateSession(state, key) {
  state.sessionCounter = (state.sessionCounter ?? 0) + 1
  return sessionIdFor(state, `${key}-${state.sessionCounter}`)
}

/**
 * Runs or resumes the pipeline.
 *
 * @param {{
 *   directory: string,
 *   quick?: boolean,
 *   task?: string|null,
 *   config: object,
 *   dispatcher: {dispatch: Function, close?: Function},
 *   state?: object,
 *   signal?: AbortSignal,
 *   onPhase?: (state: object) => void|Promise<void>,
 * }} ctx
 * @returns {Promise<object>} the final state
 */
export async function drive(ctx) {
  const { directory, config, dispatcher, signal, onPhase } = ctx
  const roundCap = config.round_cap ?? 5
  const timeoutMs = config.dispatch_timeout_ms ?? undefined
  const state = ctx.state ?? initialState({ directory, quick: Boolean(ctx.quick), task: ctx.task ?? null })
  if (state.status !== "running") state.status = "running"
  if (!state.sessionCounter) state.sessionCounter = 0

  const stop = (status, reason = null) => {
    state.status = status
    state.reason = reason
    writeState(state)
  }

  const closeQuiet = async (sessionId) => {
    if (!sessionId || !dispatcher.close) return
    try {
      await dispatcher.close(sessionId)
    } catch {}
  }

  const ask = async ({ roleKey, phase, brief, sessionId, closeAfter = false }) => {
    if (signal?.aborted) {
      stop("aborted", "aborted by the user")
      return null
    }
    await onPhase?.(state)
    writeState(state)
    let result
    try {
      result = await dispatcher.dispatch(roleKey, { brief, sessionId, timeoutMs })
    } catch (error) {
      stop("failed", describeError(error))
      return null
    }
    let parsed = extractProtocol(result.text, phase)
    if (!parsed) {
      if (signal?.aborted) {
        stop("aborted", "aborted by the user")
        return null
      }
      const brief2 = continuationBrief({
        directory,
        reportFile: REPORT_FILE[roleKey] ?? "ISSUES.md",
        line: expectedLine(phase),
      })
      try {
        result = await dispatcher.dispatch(roleKey, { brief: brief2, sessionId, timeoutMs })
      } catch (error) {
        stop("failed", describeError(error))
        return null
      }
      parsed = extractProtocol(result.text, phase)
    }
    if (closeAfter) await closeQuiet(sessionId)
    if (parsed) addVerdict(state, parsed.line)
    return parsed
  }

  while (state.status === "running") {
    if (signal?.aborted) {
      stop("aborted", "aborted by the user")
      break
    }

    if (state.phase === "plan") {
      const resumed = Boolean(state.sessions.planner)
      if (!resumed) state.sessions.planner = allocateSession(state, "planner")
      const sessionId = state.sessions.planner
      const brief = resumed
        ? continuationBrief({ directory, reportFile: "PLAN.md", line: expectedLine("plan") })
        : state.quick
          ? buildBrief("planQuick", { directory, task: state.task })
          : buildBrief("planFile", { directory })
      const parsed = await ask({ roleKey: "planner", phase: "plan", brief, sessionId, closeAfter: true })
      if (state.status !== "running") break
      if (parsed?.status === "ok") {
        state.phase = "implement"
        writeState(state)
        continue
      }
      if (parsed?.status === "fail") {
        stop("failed", parsed.reason)
        break
      }
      stop("blocked", `malformed reply from planner`)
      break
    }

    if (state.phase === "implement") {
      const fresh = !state.sessions.implementer
      if (fresh) state.sessions.implementer = allocateSession(state, "implementer")
      const sessionId = state.sessions.implementer
      const brief = fresh ? buildBrief("implement", { directory }) : buildBrief("implementResume", { directory })
      const parsed = await ask({ roleKey: "implementer", phase: "implement", brief, sessionId })
      if (state.status !== "running") break
      if (parsed?.status === "ok") {
        state.phase = "verify"
        writeState(state)
        continue
      }
      if (parsed?.status === "blocked") {
        stop("blocked", parsed.reason)
        break
      }
      stop("blocked", `malformed reply from implementer`)
      break
    }

    if (state.phase === "verify" || state.phase === "recheck") {
      const oldPolisher = state.sessions.polisher
      const sessionId = allocateSession(state, state.phase)
      state.sessions.polisher = sessionId
      if (oldPolisher) await closeQuiet(oldPolisher)
      const parsed = await ask({
        roleKey: "verifier",
        phase: state.phase,
        brief: buildBrief(state.phase, { directory }),
        sessionId,
      })
      if (state.status !== "running") break
      if (parsed?.status === "pass") {
        if (parsed.changed === "app") {
          state.phase = "audit"
          writeState(state)
          continue
        }
        stop("done")
        break
      }
      if (parsed?.status === "fail") {
        state.phase = "fix"
        writeState(state)
        continue
      }
      stop("blocked", `malformed reply from verifier`)
      break
    }

    if (state.phase === "audit") {
      const sessionId = allocateSession(state, "audit")
      const parsed = await ask({
        roleKey: "audit",
        phase: "audit",
        brief: buildBrief("audit", { directory }),
        sessionId,
        closeAfter: true,
      })
      if (state.status !== "running") break
      if (parsed?.status === "pass") {
        stop("done")
        break
      }
      if (parsed?.status === "fail") {
        state.phase = "polish"
        writeState(state)
        continue
      }
      stop("blocked", `malformed reply from audit`)
      break
    }

    if (state.phase === "fix") {
      state.round += 1
      if (state.round > roundCap) {
        stop("blocked", `round cap reached (${roundCap})`)
        break
      }
      if (!state.sessions.implementer) {
        stop("failed", "no implementer session to resume")
        break
      }
      const parsed = await ask({
        roleKey: "implementer",
        phase: "implement",
        brief: buildBrief("fix", { directory }),
        sessionId: state.sessions.implementer,
      })
      if (state.status !== "running") break
      if (parsed?.status === "ok") {
        state.phase = "recheck"
        writeState(state)
        continue
      }
      if (parsed?.status === "blocked") {
        stop("blocked", parsed.reason)
        break
      }
      stop("blocked", `malformed reply from implementer`)
      break
    }

    if (state.phase === "polish") {
      state.round += 1
      if (state.round > roundCap) {
        stop("blocked", `round cap reached (${roundCap})`)
        break
      }
      if (!state.sessions.polisher) {
        stop("failed", "no verifier session to resume")
        break
      }
      const parsed = await ask({
        roleKey: "verifier",
        phase: "polish",
        brief: buildBrief("polish", { directory }),
        sessionId: state.sessions.polisher,
      })
      if (state.status !== "running") break
      if (parsed?.status === "ok") {
        state.phase = "audit"
        writeState(state)
        continue
      }
      if (parsed?.status === "blocked") {
        stop("blocked", parsed.reason)
        break
      }
      stop("blocked", `malformed reply from verifier`)
      break
    }

    stop("failed", `unknown phase "${state.phase}"`)
  }

  writeState(state)
  return state
}
