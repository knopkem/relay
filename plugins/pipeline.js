// Plugin-driven orchestrator for the ocodesa pipeline.
//
// The orchestrator model calls one tool; this plugin spawns child sessions for
// the planner/implementer/verifier, parses their one-line protocol replies and
// follows the fixed state machine from docs/pipeline-v3.md. State is saved to
// <target>/.ocodesa/pipeline.json after every transition.

import fs from "node:fs"
import path from "node:path"

const ORCHESTRATOR_AGENT = "orchestrator"
const PLANNER_AGENT = "planner"
const IMPLEMENTER_AGENT = "implementer"
const VERIFIER_AGENT = "verifier"
const ROUND_CAP = 5
const QUICK_MAX_LINES = 5
const LOCK_STALE_MS = 2 * 60 * 60 * 1000
const STATE_DIR = ".ocodesa"
const STATE_FILE = "pipeline.json"
const CONTINUATION_LIMIT = 1
const VERDICT_MAX = 200

const ARTIFACTS = ["PLAN.md", "HANDOFF.md", "ISSUES.md"]
const REPORT_FILE = {
  planner: "PLAN.md",
  implementer: "HANDOFF.md",
  verifier: "ISSUES.md",
}

const PATTERNS = {
  plan: [
    { re: /^PLAN: ok\b/, parse: () => ({ status: "ok" }) },
    { re: /^PLAN-FAIL:\s*(.+)$/, parse: (m) => ({ status: "fail", reason: m[1].trim() }) },
  ],
  implement: [
    { re: /^IMPL: ok\b/, parse: () => ({ status: "ok" }) },
    { re: /^BLOCKED:\s*(.+)$/, parse: (m) => ({ status: "blocked", reason: m[1].trim() }) },
  ],
  verify: [
    {
      re: /^VERIFY: pass changed=(app|tests|none)\b/,
      parse: (m) => ({ status: "pass", changed: m[1] }),
    },
    { re: /^VERIFY: fail\b/, parse: () => ({ status: "fail" }) },
  ],
  audit: [
    { re: /^AUDIT: pass\b/, parse: () => ({ status: "pass" }) },
    { re: /^AUDIT: fail\b/, parse: () => ({ status: "fail" }) },
  ],
  polish: [
    { re: /^FIXED: ok\b/, parse: () => ({ status: "ok" }) },
    { re: /^BLOCKED:\s*(.+)$/, parse: (m) => ({ status: "blocked", reason: m[1].trim() }) },
  ],
}

// fix shares the implementer protocol, recheck shares the verifier protocol.
const ALIASES = { fix: "implement", recheck: "verify" }

const activeRuns = new Map() // directory -> { startedAt }

// Returns null when no expected line is present. Scans assistant text lines
// from last to first; the first match wins, so prose and quoted examples are
// ignored unless they sit on their own line after the real reply.
function extractProtocol(text, phase) {
  const patterns = PATTERNS[ALIASES[phase] ?? phase]
  if (!patterns) throw new Error(`unknown phase "${phase}"`)
  const lines = String(text ?? "").split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line) continue
    for (const pattern of patterns) {
      const match = pattern.re.exec(line)
      if (match) return { ...pattern.parse(match), line }
    }
  }
  return null
}

function expectedLine(phase) {
  switch (ALIASES[phase] ?? phase) {
    case "plan":
      return "PLAN: ok"
    case "implement":
      return "IMPL: ok"
    case "verify":
      return "VERIFY: pass changed=app|tests|none"
    case "audit":
      return "AUDIT: pass"
    case "polish":
      return "FIXED: ok"
    default:
      throw new Error(`unknown phase "${phase}"`)
  }
}

function buildBrief(key, { directory, task } = {}) {
  const T = directory
  switch (key) {
    case "planFile":
      return `## Target: ${T}\n## Brief: ${T}/TASK.md\nWrite PLAN.md.`
    case "planQuick":
      return `## Target: ${T}\n## Goal: ${task}\nWrite PLAN.md.`
    case "implement":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\nRead AGENTS.md too. Implement the entire plan in one go.`
    case "implementResume":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\nRead AGENTS.md too. Implement the entire plan in one go.\nYou were interrupted. Read HANDOFF.md if it exists, continue the plan, keep HANDOFF.md updated, run the plan's build/test commands.`
    case "verify":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\n## Handoff: ${T}/HANDOFF.md\nFull verification.`
    case "recheck":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\n## Handoff: ${T}/HANDOFF.md\nFull verification.\nRe-check mode: only the findings in the latest section of ISSUES.md.`
    case "fix":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\n## Fix: ${T}/ISSUES.md\nFix only the findings still open in the latest section.`
    case "audit":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\nMODE: audit — read the latest section of ISSUES.md.`
    case "polish":
      return `## Target: ${T}\n## Fix: ${T}/ISSUES.md\nFix only the audit findings in the latest section; keep test changes justified.`
    default:
      throw new Error(`unknown brief "${key}"`)
  }
}

function continuationBrief({ directory, reportFile, line }) {
  return [
    `## Target: ${directory}`,
    "Your previous reply was interrupted or contained no protocol line.",
    `Read ${reportFile} and bring it up to date, then reply with exactly one line:`,
    line,
  ].join("\n")
}

function countLines(text) {
  if (text === undefined || text === null || String(text).trim() === "") return 0
  return String(text).replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").length
}

function describeError(error) {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (typeof error.data?.message === "string") return error.data.message
  if (typeof error.message === "string") return error.message
  return JSON.stringify(error)
}

async function createChild(client, parentID, title) {
  const res = await client.session.create({ body: { parentID, title } })
  if (res?.error) throw new Error(describeError(res.error))
  const id = res?.data?.id
  if (!id) throw new Error("could not create child session")
  return id
}

async function promptChild(client, { id, agent, text, signal }) {
  let res
  try {
    res = await client.session.prompt({
      path: { id },
      body: { agent, parts: [{ type: "text", text }] },
      signal,
    })
  } catch (error) {
    return { error, text: "" }
  }
  if (res?.error) return { error: res.error, text: "" }
  const parts = res?.data?.parts ?? []
  const texts = []
  for (const part of parts) {
    if (part.type !== "text") continue
    const value = String(part.text ?? "").trim()
    if (!value || value === texts[texts.length - 1]) continue
    texts.push(value)
  }
  return { error: null, text: texts.join("\n") }
}

async function abortChild(ctx, id) {
  if (!id) return
  try {
    await ctx.client.session.abort({ path: { id } })
  } catch {
    // aborting is best effort; the run still stops
  }
}

async function promptParse(ctx, { id, agent, phase, brief }) {
  let reply = await promptChild(ctx.client, { id, agent, text: brief, signal: ctx.signal })
  if (reply.error) {
    if (ctx.signal?.aborted) {
      await abortChild(ctx, id)
      return { kind: "aborted", reason: "aborted by the user" }
    }
    return { kind: "error", reason: describeError(reply.error) }
  }
  let parsed = extractProtocol(reply.text, phase)
  if (parsed) return { kind: "reply", parsed, line: parsed.line }

  if (CONTINUATION_LIMIT > 0) {
    const brief2 = continuationBrief({
      directory: ctx.directory,
      reportFile: REPORT_FILE[agent] ?? "ISSUES.md",
      line: expectedLine(phase),
    })
    reply = await promptChild(ctx.client, { id, agent, text: brief2, signal: ctx.signal })
    if (reply.error) {
      if (ctx.signal?.aborted) {
        await abortChild(ctx, id)
        return { kind: "aborted", reason: "aborted by the user" }
      }
      return { kind: "error", reason: describeError(reply.error) }
    }
    parsed = extractProtocol(reply.text, phase)
    if (parsed) return { kind: "reply", parsed, line: parsed.line }
  }

  return { kind: "malformed", reason: `malformed reply from ${agent}` }
}

function statePath(directory) {
  return path.join(directory, STATE_DIR, STATE_FILE)
}

function readState(directory) {
  const file = statePath(directory)
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    if (parsed?.version !== 1) return null
    return parsed
  } catch {
    return null
  }
}

function writeState(state) {
  const dir = path.join(state.directory, STATE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  state.updatedAt = new Date().toISOString()
  const file = path.join(dir, STATE_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

function initialState(directory) {
  const now = new Date().toISOString()
  return {
    version: 1,
    directory,
    status: "running",
    phase: "plan",
    round: 0,
    sessions: { planner: null, implementer: null, polisher: null },
    verdicts: [],
    reason: null,
    startedAt: now,
    updatedAt: now,
  }
}

function titleFor(state) {
  return `pipeline: ${state.phase}${state.round > 0 ? ` r${state.round}` : ""}`
}

function truncateVerdict(line) {
  const value = String(line ?? "")
  return value.length > VERDICT_MAX ? value.slice(0, VERDICT_MAX) : value
}

function listArtifacts(directory) {
  return ARTIFACTS.filter((name) => fs.existsSync(path.join(directory, name)))
}

function formatSummary(state, directory) {
  const reason = state.reason ? `: ${state.reason}` : ""
  const sessions = Object.entries(state.sessions ?? {})
    .filter(([, id]) => id)
    .map(([role, id]) => `${role}=${id}`)
  const lines = [
    `pipeline ${state.status} — ${state.phase}${reason}`,
    `rounds: ${state.round}`,
    `verdicts: ${state.verdicts?.length ? state.verdicts.join(" → ") : "(none)"}`,
    `sessions: ${sessions.length ? sessions.join(", ") : "(none)"}`,
    `artifacts: ${listArtifacts(directory).join(", ") || "(none)"}`,
  ]
  if (state.status !== "done") lines.push("resume: call pipeline_resume")
  return lines.join("\n")
}

function stopState(state, status, reason = null) {
  state.status = status
  state.reason = reason
  return state
}

// Applies one child outcome to the state machine. Reply transitions come from
// the table in docs/pipeline-v3.md; malformed/error/aborted replies stop the
// run. Round counting and the cap live in drive(), at fix/polish dispatch.
function advance(state, outcome) {
  if (!outcome || outcome.kind !== "reply") {
    const kind = outcome?.kind ?? "malformed"
    if (kind === "aborted") return stopState(state, "aborted", outcome.reason ?? "aborted by the user")
    if (kind === "error") return stopState(state, "failed", outcome.reason ?? "unknown error")
    return stopState(state, "blocked", outcome.reason ?? "malformed reply")
  }

  const { parsed } = outcome
  const line = truncateVerdict(parsed.line)
  if (line) state.verdicts.push(line)

  switch (state.phase) {
    case "plan":
      if (parsed.status === "ok") {
        state.phase = "implement"
        return state
      }
      return stopState(state, "failed", parsed.reason ?? "plan failed")
    case "implement":
      if (parsed.status === "ok") {
        state.phase = "verify"
        return state
      }
      return stopState(state, "blocked", parsed.reason ?? "blocked")
    case "verify":
    case "recheck":
      if (parsed.status === "pass") {
        if (parsed.changed === "app") {
          state.phase = "audit"
          return state
        }
        return stopState(state, "done")
      }
      state.phase = "fix"
      return state
    case "audit":
      if (parsed.status === "pass") return stopState(state, "done")
      state.phase = "polish"
      return state
    case "fix":
      if (parsed.status === "ok") {
        state.phase = "recheck"
        return state
      }
      return stopState(state, "blocked", parsed.reason ?? "blocked")
    case "polish":
      if (parsed.status === "ok") {
        state.phase = "audit"
        return state
      }
      return stopState(state, "blocked", parsed.reason ?? "blocked")
    default:
      return stopState(state, "failed", `unknown phase "${state.phase}"`)
  }
}

function dispatchSpec(state, ctx) {
  switch (state.phase) {
    case "plan": {
      if (state.sessions.planner) {
        return { agent: PLANNER_AGENT, sessionKey: "planner", resume: true, continuation: true }
      }
      return {
        agent: PLANNER_AGENT,
        sessionKey: "planner",
        resume: false,
        briefKey: ctx.task ? "planQuick" : "planFile",
      }
    }
    case "implement": {
      const resume = Boolean(state.sessions.implementer)
      return {
        agent: IMPLEMENTER_AGENT,
        sessionKey: "implementer",
        resume,
        briefKey: resume ? "implementResume" : "implement",
      }
    }
    case "verify":
      return { agent: VERIFIER_AGENT, sessionKey: "polisher", resume: false, briefKey: "verify" }
    case "recheck":
      return { agent: VERIFIER_AGENT, sessionKey: "polisher", resume: false, briefKey: "recheck" }
    case "audit":
      return { agent: VERIFIER_AGENT, sessionKey: null, resume: false, briefKey: "audit" }
    case "fix":
      return { agent: IMPLEMENTER_AGENT, sessionKey: "implementer", resume: true, briefKey: "fix" }
    case "polish":
      return { agent: VERIFIER_AGENT, sessionKey: "polisher", resume: true, briefKey: "polish" }
    default:
      return null
  }
}

async function drive(ctx, state) {
  while (state.status === "running") {
    if (ctx.signal?.aborted) {
      stopState(state, "aborted", "aborted by the user")
      break
    }

    if (state.phase === "fix" || state.phase === "polish") {
      state.round += 1
      if (state.round > ROUND_CAP) {
        stopState(state, "blocked", `round cap reached (${ROUND_CAP})`)
        break
      }
    }

    const spec = dispatchSpec(state, ctx)
    if (!spec) {
      stopState(state, "failed", `unknown phase "${state.phase}"`)
      break
    }

    let id = spec.resume ? state.sessions[spec.sessionKey] : null
    if (spec.resume && !id) {
      stopState(state, "failed", `no ${spec.sessionKey} session to resume`)
      break
    }
    if (!spec.resume) {
      try {
        id = await createChild(ctx.client, ctx.parentID, titleFor(state))
      } catch (error) {
        stopState(state, "failed", describeError(error))
        break
      }
      if (spec.sessionKey) state.sessions[spec.sessionKey] = id
    }

    ctx.onPhase?.(state)
    writeState(state)

    const brief = spec.continuation
      ? continuationBrief({
          directory: ctx.directory,
          reportFile: REPORT_FILE[spec.agent] ?? "ISSUES.md",
          line: expectedLine(state.phase),
        })
      : buildBrief(spec.briefKey, { directory: ctx.directory, task: ctx.task })

    const outcome = await promptParse(ctx, { id, agent: spec.agent, phase: state.phase, brief })
    advance(state, outcome)
    writeState(state)
  }

  writeState(state)
  return state
}

export const Pipeline = async ({ client, directory }) => {
  const locked = (dir) => activeRuns.has(dir)

  function sweepStale() {
    const now = Date.now()
    for (const [dir, run] of activeRuns) {
      if (now - run.startedAt >= LOCK_STALE_MS) activeRuns.delete(dir)
    }
  }

  function onPhase(context) {
    return (state) => {
      if (typeof context.metadata === "function") context.metadata({ title: titleFor(state) })
    }
  }

  function driveCtx(context, dir, task) {
    return {
      client,
      directory: dir,
      parentID: context.sessionID,
      task,
      signal: context.abort,
      onPhase: onPhase(context),
    }
  }

  return {
    tool: {
      run_pipeline: {
        description:
          "Run the plan → implement → verify → audit pipeline. Reads TASK.md in the current directory, or takes a short inline brief (≤ 5 lines) via task. The plugin spawns the child sessions and routes on their protocol lines.",
        args: {
          task: {
            type: "string",
            description: "Optional short inline brief (≤ 5 lines). Omit to read TASK.md.",
          },
        },
        execute: async (args, context) => {
          if (context.agent !== ORCHESTRATOR_AGENT) {
            return "run_pipeline is only available to the orchestrator agent."
          }
          const dir = context.directory
          const task = args?.task
          if (countLines(task) > QUICK_MAX_LINES) {
            return "PLAN-FAIL: brief too large; write it to TASK.md and run /pipeline"
          }
          if (!task && !fs.existsSync(path.join(dir, "TASK.md"))) {
            return "PLAN-FAIL: no TASK.md brief"
          }
          sweepStale()
          if (locked(dir)) return `pipeline already running in ${dir}`

          activeRuns.set(dir, { startedAt: Date.now() })
          const state = initialState(dir)
          if (typeof context.metadata === "function") context.metadata({ title: "pipeline: plan" })
          try {
            await drive(driveCtx(context, dir, task ?? null), state)
          } finally {
            activeRuns.delete(dir)
          }
          return formatSummary(state, dir)
        },
      },

      pipeline_status: {
        description:
          "Report the pipeline phase, round, verdicts and artifacts for the current directory.",
        args: {},
        execute: async (_args, context) => {
          if (context.agent !== ORCHESTRATOR_AGENT) {
            return "run_pipeline is only available to the orchestrator agent."
          }
          const dir = context.directory
          const state = readState(dir)
          if (locked(dir)) {
            if (!state) return `pipeline running (live) — no state file yet in ${dir}`
            return `pipeline running (live)\n${formatSummary(state, dir)}`
          }
          if (!state) return `no pipeline run recorded in ${dir}`
          return formatSummary(state, dir)
        },
      },

      pipeline_resume: {
        description:
          "Resume a stopped pipeline run from .ocodesa/pipeline.json, reopening the saved implementer or polisher session.",
        args: {},
        execute: async (_args, context) => {
          if (context.agent !== ORCHESTRATOR_AGENT) {
            return "run_pipeline is only available to the orchestrator agent."
          }
          const dir = context.directory
          const state = readState(dir)
          if (!state) return `no pipeline run to resume in ${dir}`
          if (state.status === "done") return "pipeline already done; start a new run"
          sweepStale()
          if (locked(dir)) return `pipeline already running in ${dir}`
          if (state.phase !== "plan" && !fs.existsSync(path.join(dir, "PLAN.md"))) {
            return "cannot resume: PLAN.md is missing; start a new run"
          }

          state.status = "running"
          state.reason = null
          activeRuns.set(dir, { startedAt: Date.now() })
          try {
            await drive(driveCtx(context, dir, null), state)
          } finally {
            activeRuns.delete(dir)
          }
          return formatSummary(state, dir)
        },
      },
    },
  }
}

Pipeline.__test = {
  extractProtocol,
  buildBrief,
  initialState,
  advance,
  drive,
  statePath,
  readState,
  writeState,
  formatSummary,
  countLines,
  describeError,
}
