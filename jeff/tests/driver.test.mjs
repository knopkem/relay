import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { drive, validateRun } from "../ocodesa/driver.mjs"
import { initialState, readState } from "../ocodesa/state.mjs"

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocodesa-drive-"))
}

function mock(script) {
  const calls = []
  return {
    calls,
    async dispatch(roleKey, request) {
      calls.push({ roleKey, ...request })
      const index = calls.length - 1
      let entry
      if (script.byRole) entry = script.byRole[roleKey]
      else entry = script[index]
      if (entry === undefined) throw new Error(`no scripted reply #${index + 1} for ${roleKey}`)
      const text = typeof entry === "function" ? entry(roleKey, request, index) : entry
      return { text, sessionId: request.sessionId, roleKey }
    },
    async close() {},
  }
}

function ctxFor(directory, dispatcher, extra = {}) {
  return {
    directory,
    config: { round_cap: 5, quick_max_lines: 5, dispatch_timeout_ms: 1000 },
    dispatcher,
    onPhase: () => {},
    ...extra,
  }
}

test("validateRun", () => {
  const dir = tempDir()
  assert.equal(validateRun({ directory: dir, quick: false }), "PLAN-FAIL: no TASK.md brief")
  fs.writeFileSync(path.join(dir, "TASK.md"), "brief")
  assert.equal(validateRun({ directory: dir, quick: false }), null)
  assert.match(validateRun({ directory: dir, quick: true, task: "" }), /PLAN-FAIL/)
  assert.match(validateRun({ directory: dir, quick: true, task: "a\nb\nc\nd\ne\nf" }), /PLAN-FAIL/)
  assert.equal(validateRun({ directory: dir, quick: true, task: "fix it" }), null)
})

test("happy path with changed=none never audits", async () => {
  const dir = tempDir()
  const dispatcher = mock(["PLAN: ok", "IMPL: ok", "VERIFY: pass changed=none"])
  const state = await drive(ctxFor(dir, dispatcher))
  assert.equal(state.status, "done")
  assert.equal(state.phase, "verify")
  assert.deepEqual(
    dispatcher.calls.map((call) => call.roleKey),
    ["planner", "implementer", "verifier"],
  )
  assert.deepEqual(state.verdicts, ["PLAN: ok", "IMPL: ok", "VERIFY: pass changed=none"])
  assert.deepEqual(readState(dir).verdicts, state.verdicts)
})

test("changed=app goes through audit", async () => {
  const dir = tempDir()
  const dispatcher = mock(["PLAN: ok", "IMPL: ok", "VERIFY: pass changed=app", "AUDIT: pass"])
  const state = await drive(ctxFor(dir, dispatcher))
  assert.equal(state.status, "done")
  assert.equal(dispatcher.calls.length, 4)
})

test("audit fail resumes the verifier as polisher, then audits fresh", async () => {
  const dir = tempDir()
  const dispatcher = mock(["PLAN: ok", "IMPL: ok", "VERIFY: pass changed=app", "AUDIT: fail", "FIXED: ok", "AUDIT: pass"])
  const state = await drive(ctxFor(dir, dispatcher))
  assert.equal(state.status, "done")
  assert.equal(state.round, 1)
  const [, , verify, audit1, polish, audit2] = dispatcher.calls
  assert.equal(polish.sessionId, verify.sessionId)
  assert.notEqual(audit2.sessionId, audit1.sessionId)
})

test("verify fail resumes the implementer, then a fresh verifier", async () => {
  const dir = tempDir()
  const dispatcher = mock(["PLAN: ok", "IMPL: ok", "VERIFY: fail", "IMPL: ok", "VERIFY: pass changed=app", "AUDIT: pass"])
  const state = await drive(ctxFor(dir, dispatcher))
  assert.equal(state.status, "done")
  assert.equal(state.round, 1)
  const [, implement, verify, fix, recheck] = dispatcher.calls
  assert.equal(fix.sessionId, implement.sessionId)
  assert.notEqual(recheck.sessionId, verify.sessionId)
})

test("malformed reply gets exactly one continuation", async () => {
  const dir = tempDir()
  const dispatcher = mock(["PLAN: ok", "I am still working on it", "IMPL: ok", "VERIFY: pass changed=none"])
  const state = await drive(ctxFor(dir, dispatcher))
  assert.equal(state.status, "done")
  assert.equal(dispatcher.calls.length, 4)
  assert.match(dispatcher.calls[2].brief, /no protocol line/)
  assert.equal(dispatcher.calls[2].sessionId, dispatcher.calls[1].sessionId)
})

test("malformed twice stops blocked", async () => {
  const dir = tempDir()
  const dispatcher = mock(["PLAN: ok", "working", "still working"])
  const state = await drive(ctxFor(dir, dispatcher))
  assert.equal(state.status, "blocked")
  assert.match(state.reason, /malformed reply from implementer/)
  assert.equal(dispatcher.calls.length, 3)
})

test("PLAN-FAIL stops failed with the reason", async () => {
  const dir = tempDir()
  const dispatcher = mock(["PLAN-FAIL: no TASK.md brief"])
  const state = await drive(ctxFor(dir, dispatcher))
  assert.equal(state.status, "failed")
  assert.equal(state.reason, "no TASK.md brief")
})

test("BLOCKED stops blocked", async () => {
  const dir = tempDir()
  const dispatcher = mock(["PLAN: ok", "BLOCKED: tests cannot compile"])
  const state = await drive(ctxFor(dir, dispatcher))
  assert.equal(state.status, "blocked")
  assert.equal(state.reason, "tests cannot compile")
})

test("round cap stops the fix loop", async () => {
  const dir = tempDir()
  const dispatcher = mock({ byRole: { planner: "PLAN: ok", implementer: "IMPL: ok", verifier: "VERIFY: fail" } })
  const state = await drive(ctxFor(dir, dispatcher))
  assert.equal(state.status, "blocked")
  assert.match(state.reason, /round cap reached \(5\)/)
  assert.equal(state.round, 6)
  assert.equal(dispatcher.calls.length, 13)
})

test("a dispatch error stops failed", async () => {
  const dir = tempDir()
  const dispatcher = mock([
    () => {
      throw new Error("child died")
    },
  ])
  const state = await drive(ctxFor(dir, dispatcher))
  assert.equal(state.status, "failed")
  assert.equal(state.reason, "child died")
})

test("an aborted signal stops before any dispatch", async () => {
  const dir = tempDir()
  const dispatcher = mock(["PLAN: ok"])
  const controller = new AbortController()
  controller.abort()
  const state = await drive(ctxFor(dir, dispatcher, { signal: controller.signal }))
  assert.equal(state.status, "aborted")
  assert.equal(dispatcher.calls.length, 0)
})

test("resume at implement uses the implementResume brief and the saved session", async () => {
  const dir = tempDir()
  const seeded = initialState({ directory: dir, runId: "abcd1234" })
  seeded.phase = "implement"
  seeded.sessions.implementer = "oc-abcd1234-implementer-1"
  seeded.sessionCounter = 4
  const dispatcher = mock(["IMPL: ok", "VERIFY: pass changed=none"])
  const state = await drive(ctxFor(dir, dispatcher, { state: seeded }))
  assert.equal(state.status, "done")
  assert.equal(dispatcher.calls[0].sessionId, "oc-abcd1234-implementer-1")
  assert.match(dispatcher.calls[0].brief, /You were interrupted/)
})

test("resume at plan with a saved planner session continues it", async () => {
  const dir = tempDir()
  const seeded = initialState({ directory: dir, runId: "abcd1234" })
  seeded.sessions.planner = "oc-abcd1234-planner-1"
  const dispatcher = mock(["PLAN: ok", "IMPL: ok", "VERIFY: pass changed=none"])
  const state = await drive(ctxFor(dir, dispatcher, { state: seeded }))
  assert.equal(state.status, "done")
  assert.equal(dispatcher.calls[0].sessionId, "oc-abcd1234-planner-1")
  assert.match(dispatcher.calls[0].brief, /no protocol line/)
})
