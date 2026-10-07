import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  addVerdict,
  ARTIFACTS,
  formatSummary,
  initialState,
  listArtifacts,
  readState,
  sessionIdFor,
  statePath,
  VERDICT_MAX,
  writeState,
} from "../ocodesa/state.mjs"

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocodesa-state-"))
}

test("initial state shape", () => {
  const state = initialState({ directory: "/tmp/x", quick: true, task: "do it" })
  assert.equal(state.version, 1)
  assert.equal(state.status, "running")
  assert.equal(state.phase, "plan")
  assert.equal(state.round, 0)
  assert.equal(state.sessionCounter, 0)
  assert.equal(state.quick, true)
  assert.equal(state.task, "do it")
  assert.deepEqual(state.sessions, { planner: null, implementer: null, polisher: null })
  assert.deepEqual(state.verdicts, [])
})

test("write/read roundtrip and atomic file", () => {
  const dir = tempDir()
  const state = initialState({ directory: dir })
  state.sessions.implementer = "oc-abc-implementer-1"
  writeState(state)
  assert.ok(fs.existsSync(statePath(dir)))
  const read = readState(dir)
  assert.equal(read.sessions.implementer, "oc-abc-implementer-1")
  assert.equal(read.updatedAt, state.updatedAt)
})

test("readState returns null for a missing or foreign file", () => {
  const dir = tempDir()
  assert.equal(readState(dir), null)
  fs.mkdirSync(path.join(dir, ".ocodesa"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".ocodesa", "pipeline.json"), JSON.stringify({ version: 99 }))
  assert.equal(readState(dir), null)
})

test("addVerdict truncates", () => {
  const state = initialState({ directory: "/tmp/x" })
  addVerdict(state, "a".repeat(VERDICT_MAX + 50))
  assert.equal(state.verdicts[0].length, VERDICT_MAX)
  addVerdict(state, "")
  assert.equal(state.verdicts.length, 1)
})

test("listArtifacts only reports files that exist", () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, "PLAN.md"), "x")
  fs.writeFileSync(path.join(dir, "ISSUES.md"), "x")
  assert.deepEqual(listArtifacts(dir), ["PLAN.md", "ISSUES.md"])
  assert.deepEqual(ARTIFACTS, ["PLAN.md", "HANDOFF.md", "ISSUES.md"])
})

test("formatSummary", () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, "PLAN.md"), "x")
  const state = initialState({ directory: dir })
  state.phase = "verify"
  state.round = 2
  state.verdicts = ["PLAN: ok", "IMPL: ok"]
  state.status = "blocked"
  state.reason = "malformed reply from verifier"
  const summary = formatSummary(state, dir)
  assert.match(summary, /pipeline blocked — verify: malformed reply from verifier/)
  assert.match(summary, /rounds: 2/)
  assert.match(summary, /verdicts: PLAN: ok → IMPL: ok/)
  assert.match(summary, /artifacts: PLAN.md/)
  assert.match(summary, /resume: call pipeline-resume/)

  state.status = "done"
  assert.doesNotMatch(formatSummary(state, dir), /resume:/)
})

test("sessionIdFor", () => {
  const state = initialState({ directory: "/tmp/x", runId: "abcd1234" })
  assert.equal(sessionIdFor(state, "planner-1"), "oc-abcd1234-planner-1")
})
