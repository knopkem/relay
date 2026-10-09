// Loop breaker: aborts tool calls that repeat with no progress.
//
// The built-in doom_loop guard only catches byte-identical repeats. This
// plugin normalizes arguments (pipes, redirects, `cd ... &&` prefixes) and
// also catches:
//   - the same action run 3x consecutively,
//   - the same action producing identical output 3x, even when interleaved
//     with other calls,
//   - 5 consecutive edits to one file with no other call in between.
// Each abort surfaces as a tool error telling the model to change approach
// or report the blocker, which breaks variation loops that doom_loop misses.
//
// A tool error alone does not stop a weak model: it retries or evades the
// fingerprint with tiny variations. So aborts also accumulate per session.
// After TRIP_LIMIT aborts the session is locked: every further tool call is
// rejected, and the first locked attempt aborts the session via the client
// so an ignoring model cannot spin forever.
//
// The ratchet lock is blind to a model that hammers one blocked call: reads
// and the planner never ratchet, so 25 identical retries of a failed webfetch
// can spin forever. Repeating one blocked fingerprint BLOCKED_RETRY_LIMIT
// times without a different successful call in between locks the session on
// its own, whatever the tool and role.
//
// Only ocodesa-role sessions are guarded (see lib/agent-gate.js).
//
// Rules that keep the guard fair to each role:
//   - only edits/writes to one file in a row feed the edit-run limit; any
//     other call (read, search, bash, task) resets it, so investigating a
//     failed edit is never punished, and a read is never blocked by it;
//   - an aborted call is remembered: repeating it is rejected immediately,
//     until a different call succeeds; after BLOCKED_RETRY_LIMIT such
//     rejections the session is locked and aborted, so a model that ignores
//     the block cannot spin forever;
//   - the words of an abort fit the role: only roles with shell access are
//     told to run the project's checks, and only the role that owns a report
//     file is told to update it;
//   - the abort ratchet applies only to roles that can run commands
//     (RATCHET_AGENTS) and only to write-like actions; a read-only repeat
//     (read, grep, glob, cat, …) is rejected like any other repeat but never
//     ratchets, so a blocked inspection can never reach the ratchet lock by
//     itself; it reaches the blocked-retry lock only if the model ignores
//     the block;
//   - a fingerprint aborts at most once per session toward the ratchet:
//     retrying a blocked call stays blocked forever but never counts as a new
//     abort, so a stubborn model on one command cannot walk the session into
//     the ratchet lock.

import { agentFor, forgetAgent, isOcodesaSession, withAgentTracking } from "./lib/agent-gate.js"

const SAME_ACTION_LIMIT = 3
const RESULT_REPEAT_LIMIT = 3
const EDIT_RUN_LIMIT = 5
const TRIP_LIMIT = 5
const BLOCKED_RETRY_LIMIT = 3
const MAX_SESSIONS = 64
const MAX_RESULTS = 32
const MAX_COUNTED = 256

// Roles whose permission config allows bash; only they ratchet toward the lock.
const RATCHET_AGENTS = new Set(["implementer", "verifier", "orchestrator"])

// Read-only calls are blocked like any other repeat but never ratchet toward
// the lock: an inspection loop must not be able to end the run on its own —
// only by ignoring the block BLOCKED_RETRY_LIMIT times.
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "list", "webfetch"])
const READ_ONLY_COMMANDS =
  /^\s*(?:grep|rg|ag|cat|bat|head|tail|nl|tac|ls|find|file|stat|wc|diff|jq|tree|du|df|which|pwd|echo|env|printenv|realpath|readlink|basename|dirname|git\s+(?:status|log|diff|show|branch|remote|describe|rev-parse))\b/
const MUTATING_COMMAND =
  /[<>]|\|\s*tee\b|\b(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|install|dd|truncate|patch|tee)\b|\bsed\b[^\n]*\s-[a-z]*i|\bfind\b[^\n]*\s-(?:delete|exec|execdir|ok|okdir)\b|[;&]/

function isReadOnly(tool, args = {}) {
  if (READ_ONLY_TOOLS.has(tool)) return true
  if (tool !== "bash") return false
  const command = String(args.command ?? "")
  if (!READ_ONLY_COMMANDS.test(command)) return false
  return !MUTATING_COMMAND.test(command)
}

const RECOVERY = {
  implementer: 'If you are stuck, update HANDOFF.md and reply "BLOCKED: <reason>".',
  verifier: 'If you are stuck, update ISSUES.md and reply "BLOCKED: <reason>".',
  planner: 'If you are stuck, write PLAN.md in one pass and reply "PLAN-FAIL: <reason>".',
}

const GENERIC_RECOVERY = 'If you are stuck, report your blocker, e.g. "BLOCKED: <reason>".'

function recoveryHint(agent) {
  return RECOVERY[agent] ?? GENERIC_RECOVERY
}

function editRunHint(agent) {
  if (agent === "planner") {
    return "Finish the file in one whole-file write instead of many small edits."
  }
  if (RATCHET_AGENTS.has(agent)) return "Run the project's typecheck/tests now."
  return "Change the approach."
}

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
      blocked: new Set(),
      blockRetries: new Map(),
      counted: new Set(),
      trips: 0,
      locked: false,
      lockNote: "",
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

// Record an abort and return the error to throw. The aborted fingerprint is
// remembered so an immediate retry is rejected too. A fingerprint counts as
// one abort per session, and read-only calls never count, so hammering the
// same command stays blocked but cannot walk the session into the ratchet
// lock. Once a ratcheted session reaches TRIP_LIMIT aborts it is locked and
// the message tells the model how to end. Roles without shell access cannot
// satisfy the guard's remedy, so they are blocked call by call; if they keep
// ignoring the block, the blocked-retry limit locks the session anyway.
function trip(state, fingerprint, message, agent, { ratchet = true } = {}) {
  state.blocked.add(fingerprint)
  if (!ratchet || !RATCHET_AGENTS.has(agent)) return new Error(message)
  if (state.counted.has(fingerprint)) return new Error(message)
  state.counted.add(fingerprint)
  if (state.counted.size > MAX_COUNTED) {
    state.counted.delete(state.counted.keys().next().value)
  }
  state.trips += 1
  if (state.trips < TRIP_LIMIT) return new Error(message)
  state.locked = true
  state.lockNote = `${state.trips} aborted calls`
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

  return withAgentTracking({
    "tool.execute.before": async (input, output) => {
      if (!isOcodesaSession(input?.sessionID)) return
      const sessionID = input?.sessionID ?? "global"
      const tool = input?.tool ?? ""
      const args = output?.args ?? {}
      const agent = agentFor(sessionID)
      const state = stateFor(sessionID)
      const fp = fingerprintOf(tool, args)
      const isEdit = tool === "edit" || tool === "write"
      const ratchet = !isReadOnly(tool, args)

      if (state.locked) {
        if (!state.aborted) {
          state.aborted = true
          await abortSession(sessionID)
        }
        throw new Error(
          `Loop breaker: session locked after ${state.lockNote || `${state.trips} aborted calls`} — tools are disabled. Reply with your blocker now, e.g. "BLOCKED: <reason>".`,
        )
      }

      if (state.blocked.has(fp)) {
        const retries = (state.blockRetries.get(fp) ?? 0) + 1
        state.blockRetries.set(fp, retries)
        if (retries >= BLOCKED_RETRY_LIMIT) {
          state.locked = true
          state.lockNote = `${retries} repeated attempts to call blocked "${labelFor(tool, args)}"`
          if (!state.aborted) {
            state.aborted = true
            await abortSession(sessionID)
          }
          throw new Error(
            `Loop breaker: "${labelFor(tool, args)}" was blocked and has now been retried ${retries} times — the session is locked. Stop calling tools and reply with your blocker, e.g. "BLOCKED: <reason>".`,
          )
        }
        throw trip(
          state,
          fp,
          `Loop breaker: "${labelFor(tool, args)}" was just blocked and is being repeated. Take a different step. ${recoveryHint(agent)}`,
          agent,
          { ratchet },
        )
      }

      state.sameRun = fp === state.lastFp ? state.sameRun + 1 : 1
      state.lastFp = fp

      if (isEdit) {
        const file = args.filePath ?? ""
        state.editRun = file === state.lastFile ? state.editRun + 1 : 1
        state.lastFile = file
      } else {
        state.lastFile = ""
        state.editRun = 0
      }

      if (state.sameRun >= SAME_ACTION_LIMIT) {
        throw trip(
          state,
          fp,
          `Loop breaker: "${labelFor(tool, args)}" ran ${state.sameRun} times in a row with no change. Stop repeating it — read the output, change the approach. ${recoveryHint(agent)}`,
          agent,
          { ratchet },
        )
      }
      if (isEdit && state.editRun >= EDIT_RUN_LIMIT) {
        throw trip(
          state,
          fp,
          `Loop breaker: ${state.editRun} consecutive edits to ${state.lastFile || "one file"} without another action in between. ${editRunHint(agent)} ${recoveryHint(agent)}`,
          agent,
          { ratchet },
        )
      }
      const seen = state.results.get(fp)
      if (seen && seen.repeats >= RESULT_REPEAT_LIMIT) {
        throw trip(
          state,
          fp,
          `Loop breaker: "${labelFor(tool, args)}" produced identical output ${seen.repeats} times — retrying will not change the result. Change the approach. ${recoveryHint(agent)}`,
          agent,
          { ratchet },
        )
      }

      state.blocked.clear()
      state.blockRetries.clear()
    },
    "tool.execute.after": async (input, output) => {
      if (!isOcodesaSession(input?.sessionID)) return
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
      if (id) forgetAgent(id)
    },
  })
}

LoopBreaker.__test = {
  SAME_ACTION_LIMIT,
  RESULT_REPEAT_LIMIT,
  EDIT_RUN_LIMIT,
  TRIP_LIMIT,
  BLOCKED_RETRY_LIMIT,
  normalizeCommand,
  normalizeOutput,
  fingerprintOf,
}
