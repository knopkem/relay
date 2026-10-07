// Durable pipeline state for the jeff-code runtime.
//
// Written atomically after every transition to <target>/.ocodesa/pipeline.json,
// so pipeline-status and pipeline-resume work after the host process exits.
// Session ids point at jeff-code sessions under <target>/.ocodesa/sessions/.

import fs from "node:fs"
import crypto from "node:crypto"
import path from "node:path"

export const STATE_DIR = ".ocodesa"
export const STATE_FILE = "pipeline.json"
export const STATE_VERSION = 1
export const VERDICT_MAX = 200
export const ARTIFACTS = ["PLAN.md", "HANDOFF.md", "ISSUES.md"]

export function statePath(directory) {
  return path.join(directory, STATE_DIR, STATE_FILE)
}

export function sessionsDir(directory) {
  return path.join(directory, STATE_DIR, "sessions")
}

export function initialState({ directory, quick = false, task = null, runId = crypto.randomBytes(4).toString("hex") }) {
  const now = new Date().toISOString()
  return {
    version: STATE_VERSION,
    directory,
    runId,
    quick,
    task,
    status: "running",
    phase: "plan",
    round: 0,
    sessionCounter: 0,
    sessions: { planner: null, implementer: null, polisher: null },
    verdicts: [],
    reason: null,
    startedAt: now,
    updatedAt: now,
  }
}

export function readState(directory) {
  const file = statePath(directory)
  if (!fs.existsSync(file)) return null
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  if (parsed.version !== STATE_VERSION) return null
  return parsed
}

export function writeState(state) {
  const dir = path.join(state.directory, STATE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  state.updatedAt = new Date().toISOString()
  const file = path.join(dir, STATE_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

export function addVerdict(state, line) {
  if (typeof line !== "string" || line === "") return
  state.verdicts.push(line.length > VERDICT_MAX ? line.slice(0, VERDICT_MAX) : line)
}

export function listArtifacts(directory) {
  return ARTIFACTS.filter((name) => fs.existsSync(path.join(directory, name)))
}

export function formatSummary(state, directory) {
  const reason = state.reason ? `: ${state.reason}` : ""
  const lines = [`pipeline ${state.status} — ${state.phase}${reason}`, `rounds: ${state.round}`]
  lines.push(`verdicts: ${state.verdicts.length ? state.verdicts.join(" → ") : "(none)"}`)
  const sessions = Object.entries(state.sessions ?? {})
    .filter(([, id]) => id)
    .map(([role, id]) => `${role}=${id}`)
  lines.push(`sessions: ${sessions.length ? sessions.join(", ") : "(none)"}`)
  const artifacts = listArtifacts(directory)
  lines.push(`artifacts: ${artifacts.length ? artifacts.join(", ") : "(none)"}`)
  if (state.status !== "done") lines.push("resume: call pipeline-resume")
  return lines.join("\n")
}

/** A session id for one role instance; jeff-code ids allow [A-Za-z0-9._-]. */
export function sessionIdFor(state, key, counter) {
  const suffix = counter === undefined ? key : `${key}-${counter}`
  return `oc-${state.runId}-${suffix}`
}
