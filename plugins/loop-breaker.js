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

const SAME_ACTION_LIMIT = 3
const RESULT_REPEAT_LIMIT = 3
const EDIT_RUN_LIMIT = 5
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
  if (tool === "task") {
    const name = args.subagent_type ?? args.agent ?? ""
    return `task:${name}:${truncate(args.description ?? "")}`
  }
  return `${tool}:${hash(JSON.stringify(args ?? {}))}`
}

export const LoopBreaker = async () => ({
  "tool.execute.before": async (input, output) => {
    const tool = input?.tool ?? ""
    const args = output?.args ?? {}
    const state = stateFor(input?.sessionID ?? "global")
    const fp = fingerprintOf(tool, args)

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
      throw new Error(
        `Loop breaker: "${labelFor(tool, args)}" ran ${state.sameRun} times in a row with no change. Stop repeating it — read the output, change the approach, or report the blocker to the caller.`,
      )
    }
    if (state.editRun >= EDIT_RUN_LIMIT) {
      throw new Error(
        `Loop breaker: ${state.editRun} consecutive edits to ${state.lastFile || "one file"} without running a command. Run the project's typecheck/tests now, or stop and report what is still broken.`,
      )
    }
    const seen = state.results.get(fp)
    if (seen && seen.repeats >= RESULT_REPEAT_LIMIT) {
      throw new Error(
        `Loop breaker: "${labelFor(tool, args)}" produced identical output ${seen.repeats} times — retrying will not change the result. Change the approach or report the blocker.`,
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
    const h = hash(text)
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
})
