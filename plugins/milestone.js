// Milestone review: a frozen snapshot per milestone, reviewed by a good model
// while a fast implementer keeps working.
//
// At every milestone boundary the implementer calls the `milestone_done` tool.
// The plugin freezes the files it changed into `.ocodesa/review/M<k>/` with a
// sha256 manifest, and reviews that snapshot — never the live tree, which the
// implementer keeps changing. Findings land in REVIEW.md; blockers are pushed
// into the implementer's next model step, the rest are summarized at the next
// boundary and re-checked by the final verifier.
//
// Modes (OCODESA_MILESTONE=auto|off|review|serial, default auto):
//   - auto/review on different providers: reviews run as background nested
//     reviewer sessions; the provider is free while the implementer works.
//   - same provider (one LLM): backgrounds would only thrash the builder, so
//     auto downgrades to serial — the review runs inline in the boundary tool
//     call, where the implementer is paused anyway.
//   - off: the plugin is inert.
// The guard compares providers, not model ids: one provider serves one session
// at a time (see serialize-task.js), so two models behind one server contend
// just as much.
//
// JIT planning (OCODESA_PLAN=auto|full|jit, default full): opt-in. `full`
// writes the complete plan in one pass. `auto`/`jit` switch to contracts-only
// PLAN.md plus on-demand `MILESTONES/<id>.md` detail docs — measured on a slow
// thinking model, this does not reduce planning latency (the chain of thought
// dominates) and its detail jobs compete with reviews for the same provider,
// so it stays behind a flag. `jit` forces it when detection is unavailable.

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { agentFor, withAgentTracking } from "./lib/agent-gate.js"

const REVIEWER_AGENT = "reviewer"
const PLANNER_AGENT = "planner"
const SNAPSHOT_ROOT = path.join(".ocodesa", "review")
const MILESTONES_DIR = "MILESTONES"
const REVIEW_FILE = "REVIEW.md"

// Injected into the planner's system prompt (and, as a fallback, as the first
// part of its brief) so the contracts-only instruction cannot be lost at the
// end of a long goal.
const JIT_NOTE = [
  "[milestone] JIT mode: format the implementation order as `### M<id> — <title>`",
  "blocks under a `## Milestones` heading. PLAN.md is contracts only: per",
  "milestone list files, exported symbols with exact signatures, dependencies,",
  "and acceptance criteria — no step-by-step bodies or per-file logic. Write",
  "only PLAN.md, AGENTS.md and PLAN-NOTES.md; never write MILESTONES/*.md — a",
  "background session owns those and writes them on demand, starting with M1.",
  "Keep PLAN.md compact; PLAN.md stays authoritative.",
].join(" ")

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".ocodesa",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
])

const LIMITS = {
  snapshotFiles: 300,
  snapshotFileBytes: 2 * 1024 * 1024,
  snapshotTotalBytes: 40 * 1024 * 1024,
  sweepEntries: 5000,
  reviewChars: 12000,
  nudgeAfterEdits: 60,
  nudgeMax: 2,
}

const TIMINGS = {
  boundaryWaitMs: 120_000,
  finalWaitMs: 300_000,
  detailWaitMs: 120_000,
  serialWaitMs: 600_000,
}

const MILESTONE_ID_RE = /^###\s+(M[0-9A-Za-z][A-Za-z0-9._-]*)\b.*$/gm
const VERDICT_RE = /MILESTONE-REVIEW:\s*(.+?)\s*$/gm

function resolveMode(value) {
  const raw = String(value ?? "auto").toLowerCase()
  if (raw === "off" || raw === "review" || raw === "serial" || raw === "auto") return raw
  return "auto"
}

function sanitizeMilestone(value) {
  const raw = String(value ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 24)
  return raw || "unknown"
}

function parseMilestoneIds(text) {
  const ids = []
  for (const match of String(text ?? "").matchAll(MILESTONE_ID_RE)) {
    if (!ids.includes(match[1])) ids.push(match[1])
  }
  return ids
}

function countLines(text, re) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => re.test(line)).length
}

function parseVerdict(text) {
  const raw = String(text ?? "")
  const matches = [...raw.matchAll(VERDICT_RE)]
  const tail = matches.length ? matches[matches.length - 1][1].trim() : null
  const blockerLines = countLines(raw, /\|\s*blocker\b/i)
  if (!tail) {
    const shouldFix = countLines(raw, /\|\s*should-fix\b/i)
    return { clean: false, blockers: blockerLines, shouldFix, text: "malformed verdict" }
  }
  if (/^clean\b/i.test(tail)) return { clean: true, blockers: 0, shouldFix: 0, text: "clean" }
  const b = tail.match(/(\d+)\s*blocker/i)
  const s = tail.match(/(\d+)\s*should-fix/i)
  const blockers = b ? Number(b[1]) : blockerLines
  const shouldFix = s ? Number(s[1]) : countLines(raw, /\|\s*should-fix\b/i)
  return { clean: blockers === 0 && shouldFix === 0, blockers, shouldFix, text: tail }
}

function reviewLine(review) {
  if (!review) return null
  const body = review.clean
    ? "clean"
    : `${review.blockers} blocker(s), ${review.shouldFix} should-fix`
  return `review of ${review.k}: ${body}`
}

function truncate(text, max = 100) {
  const s = String(text ?? "")
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function firstLine(text, max = 120) {
  return truncate(String(text ?? "").split("\n")[0], max)
}

function describeError(error) {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (typeof error.data?.message === "string") return error.data.message
  if (typeof error.message === "string") return error.message
  return JSON.stringify(error)
}

function collectText(parts) {
  const texts = []
  for (const part of Array.isArray(parts) ? parts : []) {
    if (part?.type !== "text") continue
    const text = String(part.text ?? "").trim()
    if (!text || text === texts[texts.length - 1]) continue
    texts.push(text)
  }
  return texts.join("\n")
}

function timeout(ms) {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms)
    if (handle.unref) handle.unref()
  })
}

// Resolves true when the promise settles first, false on timeout. The pending
// promise keeps running; callers only use this for reporting.
async function withTimeout(promise, ms) {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    timeout(ms).then(() => false),
  ])
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

function toRel(directory, filePath) {
  const raw = String(filePath ?? "").trim()
  if (!raw) return null
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(directory, raw)
  if (abs !== directory && !abs.startsWith(directory + path.sep)) return null
  const rel = path.relative(directory, abs)
  if (!rel || rel.split(path.sep)[0] === ".ocodesa") return null
  if (rel === REVIEW_FILE) return null
  return rel
}

function excluded(rel) {
  const first = rel.split(path.sep)[0]
  return EXCLUDED_DIRS.has(first)
}

// Files whose mtime moved since the last boundary. The edit recorder catches
// normal edit/write calls; this backstops writes the guard rerouted through
// bash and files created by build steps.
function sweepChanged(directory, since) {
  const out = []
  let seen = 0
  let truncated = false
  const stack = [directory]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen += 1
      if (seen > LIMITS.sweepEntries) {
        truncated = true
        break
      }
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      try {
        if (fs.statSync(abs).mtimeMs > since) out.push(path.relative(directory, abs))
      } catch {
        // raced with a delete; ignore
      }
    }
    if (truncated) break
  }
  return out
}

function snapshotBase(k) {
  return /^M[A-Za-z0-9._-]/.test(k) ? k : `M${k}`
}

// A detail doc is worth writing only while its milestone is current; once the
// builder reported that milestone's boundary the doc can never arrive in time,
// and the good model is better spent on reviews.
function detailStale(ids, lastBoundaryMilestone, id) {
  const target = ids.indexOf(id)
  const last = lastBoundaryMilestone ? ids.indexOf(lastBoundaryMilestone) : -1
  return target >= 0 && last >= target
}

function buildSnapshot(directory, state, k) {
  const root = path.join(directory, SNAPSHOT_ROOT)
  fs.mkdirSync(root, { recursive: true })
  const base = snapshotBase(k)
  let name = base
  for (let n = 2; fs.existsSync(path.join(root, name)); n += 1) name = `${base}-${n}`
  const tmp = path.join(root, `${name}.tmp`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(path.join(tmp, "files"), { recursive: true })

  const candidates = new Set(state.editsSinceBoundary)
  candidates.add("HANDOFF.md")
  for (const rel of sweepChanged(directory, state.lastBoundaryAt)) candidates.add(rel)

  const files = []
  const skipped = []
  let total = 0
  for (const rel of [...candidates].filter((item) => !excluded(item)).sort()) {
    const src = path.join(directory, rel)
    let stat
    try {
      stat = fs.statSync(src)
    } catch {
      if (rel !== "HANDOFF.md") skipped.push({ path: rel, reason: "missing" })
      continue
    }
    if (!stat.isFile()) {
      skipped.push({ path: rel, reason: "not a file" })
      continue
    }
    if (files.length >= LIMITS.snapshotFiles) {
      skipped.push({ path: rel, reason: "file cap" })
      continue
    }
    if (stat.size > LIMITS.snapshotFileBytes) {
      skipped.push({ path: rel, reason: `larger than ${LIMITS.snapshotFileBytes} bytes` })
      continue
    }
    if (total + stat.size > LIMITS.snapshotTotalBytes) {
      skipped.push({ path: rel, reason: "total cap" })
      continue
    }
    const buffer = fs.readFileSync(src)
    const dest = path.join(tmp, "files", rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, buffer)
    files.push({ path: rel, sha256: sha256(buffer), bytes: stat.size })
    total += stat.size
  }

  const manifest = { milestone: k, at: new Date().toISOString(), files, skipped }
  fs.writeFileSync(path.join(tmp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(
    path.join(tmp, "report.md"),
    fs.existsSync(path.join(directory, "HANDOFF.md"))
      ? fs.readFileSync(path.join(directory, "HANDOFF.md"))
      : "(no HANDOFF.md at boundary)\n",
  )
  fs.renameSync(tmp, path.join(root, name))
  return { name, files: files.length, skipped: skipped.length }
}

const sessions = new Map()
const plannerSessions = new Set()
const detailSessions = new Set()
const jitAnnounced = new Set()

function stateFor(sessionID) {
  let state = sessions.get(sessionID)
  if (!state) {
    state = {
      implementer: false,
      editsSinceBoundary: new Set(),
      editCount: 0,
      nudged: 0,
      lastBoundaryAt: 0,
      lastBoundaryMilestone: null,
      snapshots: 0,
      reviews: 0,
      lastReview: null,
      notes: [],
      jobs: [],
      jobBusy: false,
      jobSeq: 0,
      inFlight: null,
      detailJobs: new Map(),
      detailAttempts: new Map(),
      plannerSessionID: null,
      milestoneIds: null,
      planAt: 0,
    }
    sessions.set(sessionID, state)
    if (sessions.size > 64) sessions.delete(sessions.keys().next().value)
  }
  return state
}

function agentModels(agents) {
  const list = Array.isArray(agents) ? agents : []
  const out = {}
  for (const name of ["implementer", "planner", "reviewer", "verifier"]) {
    const model = list.find((agent) => agent?.name === name)?.model
    out[name] =
      model && model.providerID && model.modelID
        ? { provider: model.providerID, model: model.modelID }
        : null
  }
  return out
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

// Fallback when the agents API returns nothing usable: the rendered agent
// frontmatter is the exact config (serialize-task.js reads it the same way).
function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode")
}

function frontmatterModel(agent) {
  try {
    const text = fs.readFileSync(path.join(configDir(), "agent", `${agent}.md`), "utf8")
    const match = text.match(/^model:\s*(\S+)/m)
    if (!match) return null
    const [provider, ...rest] = match[1].split("/")
    if (!provider || !rest.length) return null
    return { provider, model: rest.join("/") }
  } catch {
    return null
  }
}

// The task tool part metadata moved from `sessionID` to `sessionId`; accept
// both so task-based classification survives opencode updates.
function taskChildID(part) {
  const metadata = part?.state?.metadata ?? {}
  return metadata.sessionId ?? metadata.sessionID ?? null
}

export const Milestone = async ({ client, directory }) => {
  const configured = resolveMode(process.env.OCODESA_MILESTONE)
  if (configured === "off") return {}
  const planMode = (() => {
    const raw = String(process.env.OCODESA_PLAN ?? "full").toLowerCase()
    return raw === "full" || raw === "jit" ? raw : "auto"
  })()

  function writeLog(entry) {
    if (!process.env.OCODESA_MILESTONE_DEBUG) return
    try {
      const dir = path.join(directory, ".ocodesa")
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(
        path.join(dir, "milestone.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      )
    } catch {
      // logging must never take the run down
    }
  }

  writeLog({ kind: "load", mode: configured, planMode })

  // Provider-level gate, resolved lazily: this factory runs inside opencode's
  // bootstrap, so an API call from here would deadlock startup (see
  // supervise.js for the full story). "same" means background jobs would
  // contend with the builder; JIT needs the planner on a different provider.
  let gate = "unknown"
  let plannerSplit = null
  // Models of the sessions actually dispatched through the task tool; the
  // part metadata carries them, so it is the strongest source for the
  // implementer and planner.
  const taskModels = new Map()
  // agent/model for sessions we did not classify through a task part, resolved
  // once per session via session.get. Works around task metadata arriving late
  // or being renamed between opencode versions.
  const sessionMetaCache = new Map()

  function rememberTaskModel(agent, model) {
    if (!agent || !model?.providerID) return
    taskModels.set(agent, {
      provider: model.providerID,
      model: model.modelID ?? "",
    })
  }

  async function sessionMeta(sessionID) {
    if (!sessionID) return null
    if (sessionMetaCache.has(sessionID)) return sessionMetaCache.get(sessionID)
    let meta = null
    try {
      const res = await client.session.get({ path: { id: sessionID } })
      if (res?.data) meta = { agent: res.data.agent ?? null, model: res.data.model ?? null }
    } catch {
      meta = null
    }
    if (sessionMetaCache.size >= 256) {
      sessionMetaCache.delete(sessionMetaCache.keys().next().value)
    }
    sessionMetaCache.set(sessionID, meta)
    return meta
  }

  async function resolveGate(reason) {
    if (gate !== "unknown") return gate
    const api = await detectModels(client, directory)
    const models = {}
    for (const name of ["implementer", "planner", "reviewer", "verifier"]) {
      models[name] = api?.[name] ?? frontmatterModel(name) ?? null
    }
    if (taskModels.has("implementer")) models.implementer = taskModels.get("implementer")
    if (taskModels.has("planner")) models.planner = taskModels.get("planner")
    if (models.reviewer && models.implementer) {
      gate = models.reviewer.provider === models.implementer.provider ? "same" : "split"
    } else {
      gate = "split"
    }
    plannerSplit =
      models.planner && models.implementer
        ? models.planner.provider !== models.implementer.provider
        : null
    if (gate === "same" && configured !== "serial") {
      writeLog({ kind: "downgrade", reason, to: "serial" })
    }
    return gate
  }

  function mode() {
    if (configured === "serial") return "serial"
    return gate === "same" ? "serial" : "review"
  }

  function jitEnabled() {
    if (planMode === "full") return false
    if (plannerSplit === false) return false
    if (plannerSplit === true) return true
    // Detection unavailable: only an explicit `jit` overrides.
    return planMode === "jit"
  }

  function readMilestoneIds(state) {
    try {
      const file = path.join(directory, "PLAN.md")
      const stat = fs.statSync(file)
      if (state.milestoneIds && state.planAt === stat.mtimeMs) return state.milestoneIds
      state.milestoneIds = parseMilestoneIds(fs.readFileSync(file, "utf8"))
      state.planAt = stat.mtimeMs
      return state.milestoneIds
    } catch {
      return null
    }
  }

  function canonicalId(state, k) {
    const ids = readMilestoneIds(state) ?? []
    if (ids.includes(k)) return k
    const m = `M${k}`
    if (ids.includes(m)) return m
    const found = ids.find(
      (id) => id.toLowerCase() === String(k).toLowerCase() || id.toLowerCase() === m.toLowerCase(),
    )
    return found ?? k
  }

  function queueNote(state, text) {
    if (!text || state.notes.length >= 8) return
    state.notes.push({ text, at: Date.now() })
  }

  function enqueue(state, job) {
    let finish
    job.done = new Promise((resolve) => {
      finish = resolve
    })
    job.finish = finish
    job.seq = state.jobSeq++
    state.jobs.push(job)
    pump(state)
    return job
  }

  async function pump(state) {
    if (state.jobBusy) return
    state.jobBusy = true
    try {
      while (state.jobs.length) {
        state.jobs.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
        const job = state.jobs.shift()
        try {
          job.result = await job.run()
        } catch (error) {
          job.error = error
          writeLog({ kind: `${job.kind}-error`, error: describeError(error) })
          if (job.onError) job.onError(error)
        } finally {
          job.finish()
        }
      }
    } finally {
      state.jobBusy = false
    }
  }

  function appendReview(k, snapshotName, text) {
    const body = String(text ?? "").trim()
    const capped =
      body.length > LIMITS.reviewChars
        ? `${body.slice(0, LIMITS.reviewChars)}\n[…review truncated at ${LIMITS.reviewChars} chars…]`
        : body
    const section = [
      "",
      `## milestone ${k} — ${new Date().toISOString()}`,
      `snapshot: .ocodesa/review/${snapshotName}/manifest.json`,
      "",
      capped || "(reviewer returned no text)",
      "",
    ].join("\n")
    fs.appendFileSync(path.join(directory, REVIEW_FILE), `${section}\n`)
  }

  async function runReview(state, ownerSessionID, k, snapshotName, signal) {
    const snapshotDir = path.join(directory, SNAPSHOT_ROOT, snapshotName)
    const prompt = [
      `## Target: ${directory}`,
      `## Milestone: ${k}`,
      `## Snapshot: ${snapshotDir}`,
      `## Manifest: ${path.join(snapshotDir, "manifest.json")}`,
      `## Report: ${path.join(snapshotDir, "report.md")}`,
      "",
      "Read PLAN.md for the spec. Review only files under the snapshot directory —",
      "the live project may already have changed them. Report findings in your",
      "instruction format and end with the MILESTONE-REVIEW line.",
    ].join("\n")
    const created = await client.session.create({
      body: { title: `milestone ${k} reviewer for ${ownerSessionID}`, parentID: ownerSessionID },
    })
    if (created?.error) throw new Error(describeError(created.error))
    const reviewerSessionID = created?.data?.id
    if (!reviewerSessionID) throw new Error("could not create reviewer session")
    const options = {
      path: { id: reviewerSessionID },
      body: { agent: REVIEWER_AGENT, parts: [{ type: "text", text: prompt }] },
    }
    if (signal) options.signal = signal
    const res = await client.session.prompt(options)
    if (res?.error) throw new Error(describeError(res.error))
    const text = collectText(res?.data?.parts ?? []).slice(0, 200_000)
    const verdict = parseVerdict(text)
    appendReview(k, snapshotName, text)
    state.reviews += 1
    state.lastReview = { k, ...verdict }
    writeLog({ kind: "review", k, snapshot: snapshotName, blockers: verdict.blockers, shouldFix: verdict.shouldFix })
    if (verdict.blockers > 0) {
      queueNote(
        state,
        `[reviewer] milestone ${k} review found ${verdict.blockers} blocker(s); read REVIEW.md and fix them before the next milestone.`,
      )
    }
    return verdict
  }

  function queueReviewJob(state, ownerSessionID, k, snapshotName) {
    return enqueue(state, {
      kind: "review",
      priority: 1,
      k,
      run: () => runReview(state, ownerSessionID, k, snapshotName),
    })
  }

  async function runDetail(state, ownerSessionID, id) {
    const file = path.join(directory, MILESTONES_DIR, `${id}.md`)
    if (fs.existsSync(file)) return file
    if (detailStale(readMilestoneIds(state) ?? [], state.lastBoundaryMilestone, id)) {
      writeLog({ kind: "detail-stale", id, last: state.lastBoundaryMilestone })
      return null
    }
    if (!state.plannerSessionID) {
      const created = await client.session.create({
        body: { title: `milestone planner for ${ownerSessionID}`, parentID: ownerSessionID },
      })
      if (created?.error) throw new Error(describeError(created.error))
      const id2 = created?.data?.id
      if (!id2) throw new Error("could not create planner session")
      state.plannerSessionID = id2
      if (detailSessions.size >= 64) detailSessions.delete(detailSessions.values().next().value)
      detailSessions.add(id2)
    }
    const prompt = [
      `## Target: ${directory}`,
      `## Plan: ${path.join(directory, "PLAN.md")}`,
      `## Milestone: ${id}`,
      `Write ${path.join(directory, MILESTONES_DIR, `${id}.md`)}: the concrete`,
      "step-by-step implementation detail for this milestone only. Read PLAN.md",
      "(authoritative), HANDOFF.md and the code built so far. Refine the frozen",
      "contracts; never change signatures, wiring, or files owned by another",
      "milestone, and write no application code. Keep the doc compact — exact",
      "paths, symbols and ordered steps, no prose and no restating PLAN.md. If a",
      'contract must change, write the line "CONTRACT-ISSUE: <what>" at the top',
      "and nothing else.",
      "Reply with exactly one line: MILESTONE-DETAIL: ok",
    ].join("\n")
    try {
      const res = await client.session.prompt({
        path: { id: state.plannerSessionID },
        body: { agent: PLANNER_AGENT, parts: [{ type: "text", text: prompt }] },
      })
      if (res?.error) throw new Error(describeError(res.error))
    } catch (error) {
      state.plannerSessionID = null
      throw error
    }
    if (!fs.existsSync(file)) throw new Error(`planner did not write ${MILESTONES_DIR}/${id}.md`)
    const text = fs.readFileSync(file, "utf8")
    writeLog({ kind: "detail", id, contractIssue: /CONTRACT-ISSUE:/i.test(text) })
    if (/CONTRACT-ISSUE:/i.test(text)) {
      queueNote(
        state,
        `[milestone] planner flagged a contract issue for ${id}; read ${MILESTONES_DIR}/${id}.md and, if it blocks you, record it in HANDOFF.md and reply BLOCKED.`,
      )
    } else {
      queueNote(
        state,
        `[milestone] ${MILESTONES_DIR}/${id}.md is ready — read it before starting ${id}; PLAN.md wins on conflict.`,
      )
    }
    return file
  }

  function queueDetailJob(state, ownerSessionID, id) {
    const existing = state.detailJobs.get(id)
    if (existing) return existing
    const attempts = state.detailAttempts.get(id) ?? 0
    if (attempts >= 2) return null
    state.detailAttempts.set(id, attempts + 1)
    const job = enqueue(state, {
      kind: "detail",
      priority: 2,
      id,
      run: () => runDetail(state, ownerSessionID, id),
    })
    job.onError = () => state.detailJobs.delete(id)
    state.detailJobs.set(id, job)
    return job
  }

  function nextMilestone(state, k) {
    const ids = readMilestoneIds(state) ?? []
    const index = ids.indexOf(k)
    return index >= 0 ? ids[index + 1] ?? null : null
  }

  function maybeQueueDetail(state, ownerSessionID) {
    if (!jitEnabled()) return
    const ids = readMilestoneIds(state)
    if (!ids || !ids.length) return
    const last = state.lastBoundaryMilestone
    // Before the first boundary the current milestone itself gets a detail
    // doc; afterwards the doc for the milestone after the current one.
    const next = last ? ids[ids.indexOf(last) + 2] : ids[0]
    if (!next) return
    if (fs.existsSync(path.join(directory, MILESTONES_DIR, `${next}.md`))) return
    queueDetailJob(state, ownerSessionID, next)
  }

  function maybeNudge(state) {
    if (state.nudged >= LIMITS.nudgeMax) return
    if (state.editCount < (state.nudged + 1) * LIMITS.nudgeAfterEdits) return
    state.nudged += 1
    queueNote(
      state,
      `[milestone] ${LIMITS.nudgeAfterEdits}+ edits without a milestone boundary; finish the milestone's build/test, update HANDOFF.md, then call milestone_done.`,
    )
  }

  async function boundaryReview(state, ownerSessionID, id, snapshotName, final, signal) {
    // Await the previous milestone's review at the natural pause, then queue
    // this one. A slow review never blocks longer than the boundary cap.
    let previous = null
    if (state.inFlight) {
      await withTimeout(state.inFlight.done, TIMINGS.boundaryWaitMs)
      if (state.inFlight.error) {
        previous = `review of ${state.inFlight.k} failed: ${describeError(state.inFlight.error)}`
      } else if (state.lastReview?.k === state.inFlight.k) {
        previous = reviewLine(state.lastReview)
      } else {
        previous = `review of ${state.inFlight.k} still running — see REVIEW.md`
      }
      state.inFlight = null
    }

    const job = queueReviewJob(state, ownerSessionID, id, snapshotName)
    state.inFlight = job
    let current = null
    if (final) {
      await withTimeout(job.done, TIMINGS.finalWaitMs)
      if (job.error) current = `review of ${id} failed: ${describeError(job.error)}`
      else if (state.lastReview?.k === id) current = reviewLine(state.lastReview)
      else current = `review of ${id} still running — see REVIEW.md`
      state.inFlight = null
    }
    return { previous, current }
  }

  async function serialReview(state, ownerSessionID, id, snapshotName, signal) {
    try {
      const verdict = await Promise.race([
        runReview(state, ownerSessionID, id, snapshotName, signal).then((value) => ({ value })),
        timeout(TIMINGS.serialWaitMs).then(() => ({ timedOut: true })),
      ])
      if (verdict.timedOut) return `review of ${id} still running — see REVIEW.md`
      return reviewLine({ k: id, ...verdict.value })
    } catch (error) {
      return `review of ${id} failed: ${describeError(error)}`
    }
  }

  function maybeDetailAtBoundary(state, ownerSessionID, id) {
    if (!jitEnabled()) return { ready: null, pending: null }
    const next = nextMilestone(state, id)
    if (!next) return { ready: null, pending: null }
    const file = path.join(directory, MILESTONES_DIR, `${next}.md`)
    if (!fs.existsSync(file)) {
      const job = queueDetailJob(state, ownerSessionID, next)
      return { ready: null, pending: next, job }
    }
    return { ready: next, pending: null }
  }

  const hooks = {
    tool: {
      milestone_done: {
        description:
          "Milestone boundary: freeze a snapshot of the files changed since the last boundary and queue a review. Call it after each milestone's build/test passes, with the milestone id from PLAN.md; set final=true on the last milestone.",
        args: {
          milestone: {
            type: "string",
            description: "Milestone id exactly as in PLAN.md, e.g. M2.",
          },
          summary: {
            type: "string",
            description: "One line: what this milestone completed.",
          },
          final: {
            type: "boolean",
            description: "True on the last milestone; the review is awaited before you reply.",
          },
        },
        execute: async (args, context) => {
          try {
            if (context.agent !== "implementer") {
              return "milestone_done is only available to the implementer agent."
            }
            await resolveGate("milestone_done")
            const state = stateFor(context.sessionID)
            state.implementer = true
            if (!state.lastBoundaryAt) state.lastBoundaryAt = Date.now()
            const raw = sanitizeMilestone(args?.milestone)
            const id = canonicalId(state, raw)
            const ids = readMilestoneIds(state) ?? []
            const final =
              args?.final === true ||
              (ids.length > 0 && ids.indexOf(id) === ids.length - 1)
            const snapshot = buildSnapshot(directory, state, raw)
            state.snapshots += 1
            state.editsSinceBoundary = new Set()
            state.editCount = 0
            state.lastBoundaryAt = Date.now()
            state.lastBoundaryMilestone = id
            writeLog({ kind: "boundary", id, snapshot: snapshot.name, files: snapshot.files, mode: mode() })

            let previous = null
            let current = null
            if (mode() === "serial") {
              current = await serialReview(state, context.sessionID, id, snapshot.name, context.abort)
            } else {
              const result = await boundaryReview(state, context.sessionID, id, snapshot.name, final, context.abort)
              previous = result.previous
              current = result.current
            }

            const detail = maybeDetailAtBoundary(state, context.sessionID, id)
            let ready = detail.ready
            if (detail.pending) {
              if (detail.job) await withTimeout(detail.job.done, TIMINGS.detailWaitMs)
              if (fs.existsSync(path.join(directory, MILESTONES_DIR, `${detail.pending}.md`))) {
                ready = detail.pending
              }
            }

            const parts = [
              `${id} snapshot: ${SNAPSHOT_ROOT}/${snapshot.name}/ (${snapshot.files} file(s)${
                snapshot.skipped ? `, ${snapshot.skipped} skipped` : ""
              })`,
            ]
            if (previous) parts.push(previous)
            if (current) parts.push(current)
            if (ready) parts.push(`${MILESTONES_DIR}/${ready}.md ready — read it before starting ${ready}; PLAN.md wins.`)
            else if (detail.pending) {
              parts.push(
                `${MILESTONES_DIR}/${detail.pending}.md ${detail.job ? "is being written" : "is unavailable"}; continue with PLAN.md.`,
              )
            }
            return parts.join(" · ")
          } catch (error) {
            writeLog({ kind: "boundary-error", error: describeError(error) })
            return `milestone_done failed: ${describeError(error)}. Continue with PLAN.md.`
          }
        },
      },
    },

    event: async ({ event } = {}) => {
      if (event?.type === "session.deleted") {
        const id = event.properties?.info?.id ?? event.properties?.sessionID
        if (!id) return
        const state = sessions.get(id)
        if (state?.implementer) {
          writeLog({
            kind: "session-summary",
            sessionID: id,
            snapshots: state.snapshots,
            reviews: state.reviews,
            edits: state.editCount,
          })
        }
        sessions.delete(id)
        plannerSessions.delete(id)
        return
      }
      if (event?.type !== "message.part.updated") return
      const part = event.properties?.part
      if (!part || part.type !== "tool" || !part.sessionID) return
      if (part.tool === "task") {
        const child = taskChildID(part)
        const subagent = part.state?.input?.subagent_type
        const model = part.state?.metadata?.model
        rememberTaskModel(subagent, model)
        if (child && subagent === "implementer") {
          const state = stateFor(child)
          state.implementer = true
          if (!state.lastBoundaryAt) state.lastBoundaryAt = Date.now()
          await resolveGate("implementer-start")
          maybeQueueDetail(state, child)
        }
        if (child && subagent === "planner") {
          if (plannerSessions.size >= 64) {
            plannerSessions.delete(plannerSessions.values().next().value)
          }
          plannerSessions.add(child)
        }
        return
      }

      let state = sessions.get(part.sessionID)
      if (!state?.implementer) {
        const meta = await sessionMeta(part.sessionID)
        if (meta?.agent === PLANNER_AGENT) plannerSessions.add(part.sessionID)
        if (meta?.agent !== "implementer") return
        state = stateFor(part.sessionID)
        state.implementer = true
        if (!state.lastBoundaryAt) state.lastBoundaryAt = Date.now()
        await resolveGate("implementer-start")
        maybeQueueDetail(state, part.sessionID)
      }
      if (part.state?.status !== "completed") return

      if (part.tool !== "edit" && part.tool !== "write" && part.tool !== "apply_patch") return
      const input = part.state?.input ?? {}
      const rel = toRel(directory, input.filePath ?? input.filepath)
      if (rel) state.editsSinceBoundary.add(rel)
      state.editCount += 1
      maybeNudge(state)
      await resolveGate("milestone-edit")
      maybeQueueDetail(state, part.sessionID)
    },

    // The system prompt is the reliable channel for the JIT directive: it sits
    // next to the planner instructions instead of at the end of a possibly
    // enormous goal text, and it needs no session bookkeeping to detect the
    // role — the planner's own prompt says "You are the **planner**".
    "experimental.chat.system.transform": async (input, output) => {
      if (planMode === "full") return
      const sessionID = input?.sessionID
      const system = output?.system
      if (!sessionID || !Array.isArray(system)) return
      if (jitAnnounced.has(sessionID) || detailSessions.has(sessionID)) return
      const isPlanner =
        agentFor(sessionID) === PLANNER_AGENT ||
        plannerSessions.has(sessionID) ||
        system.some((text) => String(text ?? "").includes("You are the **planner**"))
      writeLog({
        kind: "system-transform",
        sessionID,
        isPlanner,
        agent: agentFor(sessionID) ?? null,
        taskPlanner: plannerSessions.has(sessionID),
      })
      if (!isPlanner) return
      await resolveGate("jit-system")
      jitAnnounced.add(sessionID)
      writeLog({ kind: "jit-announce", channel: "system", sessionID, planMode, plannerSplit })
      if (plannerSplit === true) system.push(JIT_NOTE)
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output?.messages ?? []
      const sessionID = messages[0]?.info?.sessionID
      if (!sessionID) return
      const lastUser = [...messages].reverse().find((msg) => msg.info?.role === "user")
      if (!lastUser) return

      if (planMode === "full" || jitAnnounced.has(sessionID) || detailSessions.has(sessionID)) {
        // fall through to note injection
      } else {
        // The message payload carries the agent for its own session; the other
        // sources cover builds where it is missing. The brief text is the last
        // resort: the orchestrator's P/P2 brief always says "Write PLAN.md".
        const messageAgent = lastUser.info?.agent ?? messages[0]?.info?.agent ?? null
        const brief = lastUser.parts
          .map((part) => (part?.type === "text" ? String(part.text ?? "") : ""))
          .join("\n")
        const briefPlanner = /Write PLAN\.md/.test(brief)
        const meta = await sessionMeta(sessionID)
        const known =
          messageAgent === PLANNER_AGENT ||
          agentFor(sessionID) === PLANNER_AGENT ||
          plannerSessions.has(sessionID) ||
          meta?.agent === PLANNER_AGENT ||
          briefPlanner
        writeLog({
          kind: "transform",
          sessionID,
          messageAgent,
          agent: agentFor(sessionID) ?? null,
          taskPlanner: plannerSessions.has(sessionID),
          metaAgent: meta?.agent ?? null,
          briefPlanner,
          known,
        })
        if (known) {
          await resolveGate("jit-announce")
          jitAnnounced.add(sessionID)
          writeLog({ kind: "jit-announce", channel: "messages", sessionID, planMode, plannerSplit })
          if (plannerSplit === true) {
            lastUser.parts.unshift({ type: "text", synthetic: true, text: JIT_NOTE })
          }
        }
      }

      const state = sessions.get(sessionID)
      if (!state?.notes.length) return
      for (const note of state.notes) {
        lastUser.parts.push({ type: "text", text: note.text, synthetic: true })
      }
      writeLog({ kind: "inject", sessionID, count: state.notes.length })
      state.notes = []
    },
  }
  return withAgentTracking(hooks)
}

Milestone.__test = {
  resolveMode,
  sanitizeMilestone,
  parseMilestoneIds,
  parseVerdict,
  reviewLine,
  toRel,
  excluded,
  sweepChanged,
  buildSnapshot,
  collectText,
  firstLine,
  describeError,
  agentModels,
  frontmatterModel,
  taskChildID,
  detailStale,
  setTimings: (values) => Object.assign(TIMINGS, values),
  setLimits: (values) => Object.assign(LIMITS, values),
  resetSessions: () => {
    sessions.clear()
    plannerSessions.clear()
    detailSessions.clear()
    jitAnnounced.clear()
  },
}
