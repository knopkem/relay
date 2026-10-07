// Loop breaker: aborts tool calls that repeat with no progress.
//
// The built-in doom_loop guard only catches byte-identical repeats. This
// plugin normalizes arguments (pipes, redirects, `cd ... &&` prefixes) and
// also catches:
//   - the same action run 3x consecutively,
//   - the same action producing identical output 3x, even when interleaved
//     with other calls,
//   - 5 consecutive edits to one file with no command run in between.
// Each abort surfaces as a tool error telling the model to change approach
// or report the blocker, which breaks variation loops that doom_loop misses.
//
// A tool error alone does not stop a weak model: it retries or evades the
// fingerprint with tiny variations. So aborts also accumulate per session.
// After TRIP_LIMIT aborts the session is locked: every further tool call is
// rejected, and the first locked attempt aborts the session via the client
// so an ignoring model cannot spin forever.

const SAME_ACTION_LIMIT = 3
const RESULT_REPEAT_LIMIT = 3
const EDIT_RUN_LIMIT = 5
const TRIP_LIMIT = 5
const MAX_SESSIONS = 64
const MAX_RESULTS = 32

const sessions = new Map()

function stateFor(sessionID) {
  let state = sessions.get(sessionID)
  if (!state) {
    state = {
      lastFp: "",
      sameRun: 0,
      results: new Map(),
      lastFile: "",
      editRun: 0,
      trips: 0,
      locked: false,
      aborted: false,
    }
    sessions.set(sessionID, state)
    if (sessions.size > MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value)
    }
  }
  return state
}

function normalizeCommand(command) {
  return String(command)
    .replace(/\s*\|\s*(?:tail|head)\s+-\d+\s*/g, " ")
    .replace(/2\s*>&\s*1/g, " ")
    .replace(/2\s*>\s*\/dev\/null/g, " ")
    .replace(/\b(grep\s+-[ABC])\s*\d+/g, "$1#")
    .replace(/\b(head|tail)\s+-\d+/g, "$1 -N")
    .replace(/;\s*echo\s+(['"])[^'"]*\1/g, " ")
    .replace(/^cd\s+[^&]+&&\s*/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function hash(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

function truncate(text, max = 80) {
  const s = String(text)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// Test runners print volatile tokens (thread ids, addresses, durations) and
// parallel output reorders lines, so byte-identical comparisons never fire.
// Compare the normalized information instead: strip volatile tokens, ignore
// blank lines and indentation, compare lines as a sorted set.
function normalizeOutput(text) {
  const lines = String(text)
    .replace(/thread '([^']*)' \(\d+\)/g, "thread '$1' (PID)")
    .replace(/\b0x[0-9a-fA-F]{6,}\b/g, "0xADDR")
    .replace(/\bfinished in [\d.]+(?:ns|µs|us|ms|s)\b/g, "finished in T")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.sort()
  return lines.join("\n")
}

function labelFor(tool, args) {
  if (tool === "bash") {
    return `bash: ${truncate(normalizeCommand(args.command ?? ""))}`
  }
  if (tool === "grep" || tool === "glob") {
    return `${tool}: ${truncate(args.pattern ?? "")}`
  }
  if (tool === "task") {
    return `task: ${truncate(args.description ?? args.subagent_type ?? "")}`
  }
  return tool
}

function fingerprintOf(tool, args) {
  if (tool === "bash") return `bash:${normalizeCommand(args.command ?? "")}`
  if (tool === "grep") return `grep:${args.pattern ?? ""}`
  if (tool === "glob") return `glob:${args.pattern ?? ""}`
  if (tool === "edit" && args.oldString) {
    return `edit:${args.filePath ?? ""}:${hash(args.oldString)}`
  }
  if (tool === "serena_replace_content") {
    return `replace:${args.relative_path ?? ""}:${hash(args.needle ?? "")}`
  }
  if (tool === "task") {
    const name = args.subagent_type ?? args.agent ?? ""
    return `task:${name}:${truncate(args.description ?? "")}`
  }
  return `${tool}:${hash(JSON.stringify(args ?? {}))}`
}

// Record an abort and return the error to throw. Once the session reaches
// TRIP_LIMIT aborts it is locked and the message tells the model how to end.
function trip(state, message) {
  state.trips += 1
  if (state.trips < TRIP_LIMIT) return new Error(message)
  state.locked = true
  return new Error(
    `${message} — ${state.trips} aborted calls in this session; it is now locked. Stop calling tools and reply with your blocker, e.g. "BLOCKED: <reason>".`,
  )
}

export const LoopBreaker = async ({ client } = {}) => {
  async function abortSession(sessionID) {
    if (!client || !sessionID) return
    try {
      await client.session.abort({ path: { id: sessionID } })
    } catch {
      // Best effort: the lock still rejects every further tool call.
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      const tool = input?.tool ?? ""
      const args = output?.args ?? {}
      const state = stateFor(input?.sessionID ?? "global")
      const fp = fingerprintOf(tool, args)

      if (state.locked) {
        if (!state.aborted) {
          state.aborted = true
          await abortSession(input?.sessionID)
        }
        throw new Error(
          `Loop breaker: session locked after ${state.trips} aborted calls — tools are disabled. Reply with your blocker now, e.g. "BLOCKED: <reason>".`,
        )
      }

      state.sameRun = fp === state.lastFp ? state.sameRun + 1 : 1
      state.lastFp = fp

      if (tool === "edit" || tool === "write") {
        const file = args.filePath ?? ""
        state.editRun = file === state.lastFile ? state.editRun + 1 : 1
        state.lastFile = file
      } else if (tool === "bash" || tool === "task") {
        state.lastFile = ""
        state.editRun = 0
      }

      if (state.sameRun >= SAME_ACTION_LIMIT) {
        throw trip(
          state,
          `Loop breaker: "${labelFor(tool, args)}" ran ${state.sameRun} times in a row with no change. Stop repeating it — read the output, change the approach. If you are stuck, update HANDOFF.md and reply "BLOCKED: <reason>".`,
        )
      }
      if (state.editRun >= EDIT_RUN_LIMIT) {
        throw trip(
          state,
          `Loop breaker: ${state.editRun} consecutive edits to ${state.lastFile || "one file"} without running a command. Run the project's typecheck/tests now. If you are stuck, update HANDOFF.md and reply "BLOCKED: <reason>".`,
        )
      }
      const seen = state.results.get(fp)
      if (seen && seen.repeats >= RESULT_REPEAT_LIMIT) {
        throw trip(
          state,
          `Loop breaker: "${labelFor(tool, args)}" produced identical output ${seen.repeats} times — retrying will not change the result. Change the approach, or update HANDOFF.md and reply "BLOCKED: <reason>".`,
        )
      }
    },
    "tool.execute.after": async (input, output) => {
      const tool = input?.tool ?? ""
      const args = output?.args ?? input?.args ?? {}
      const text = typeof output?.output === "string" ? output.output : ""
      if (!text) return
      const state = stateFor(input?.sessionID ?? "global")
      const fp = fingerprintOf(tool, args)
      const h = hash(normalizeOutput(text))
      const prev = state.results.get(fp)
      state.results.set(fp, {
        hash: h,
        repeats: prev && prev.hash === h ? prev.repeats + 1 : 1,
      })
      if (state.results.size > MAX_RESULTS) {
        state.results.delete(state.results.keys().next().value)
      }
    },
    event: async ({ event } = {}) => {
      if (event?.type !== "session.deleted" && event?.type !== "session.idle") {
        return
      }
      const id =
        event.properties?.sessionID ??
        event.properties?.info?.id ??
        event.properties?.info?.sessionID
      if (id) sessions.delete(id)
    },
  }
}

LoopBreaker.__test = {
  SAME_ACTION_LIMIT,
  RESULT_REPEAT_LIMIT,
  EDIT_RUN_LIMIT,
  TRIP_LIMIT,
  normalizeCommand,
  normalizeOutput,
  fingerprintOf,
}
