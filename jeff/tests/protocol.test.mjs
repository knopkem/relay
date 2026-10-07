import test from "node:test"
import assert from "node:assert/strict"
import { countLines, expectedLine, extractProtocol } from "../ocodesa/protocol.mjs"

test("plan: ok", () => {
  assert.deepEqual(extractProtocol("PLAN: ok\n", "plan"), { status: "ok", line: "PLAN: ok" })
})

test("plan: failure reason extracted", () => {
  const parsed = extractProtocol("Some prose\nPLAN-FAIL: no TASK.md brief\n", "plan")
  assert.equal(parsed.status, "fail")
  assert.equal(parsed.reason, "no TASK.md brief")
})

test("implement: blocked reason extracted", () => {
  const parsed = extractProtocol("BLOCKED: tests will not compile\n", "implement")
  assert.equal(parsed.status, "blocked")
  assert.equal(parsed.reason, "tests will not compile")
})

test("fix shares the implementer protocol", () => {
  assert.equal(extractProtocol("IMPL: ok\n", "fix").status, "ok")
  assert.equal(extractProtocol("BLOCKED: no\n", "fix").status, "blocked")
})

test("verify: pass with changed", () => {
  assert.deepEqual(extractProtocol("VERIFY: pass changed=app\n", "verify"), {
    status: "pass",
    changed: "app",
    line: "VERIFY: pass changed=app",
  })
  assert.equal(extractProtocol("VERIFY: pass changed=tests\n", "recheck").changed, "tests")
  assert.equal(extractProtocol("VERIFY: pass changed=none\n", "verify").changed, "none")
})

test("verify: pass without changed is malformed", () => {
  assert.equal(extractProtocol("VERIFY: pass\n", "verify"), null)
})

test("verify: fail", () => {
  assert.equal(extractProtocol("VERIFY: fail\n", "verify").status, "fail")
})

test("audit lines", () => {
  assert.equal(extractProtocol("AUDIT: pass\n", "audit").status, "pass")
  assert.equal(extractProtocol("AUDIT: fail\n", "audit").status, "fail")
})

test("polish uses the FIXED protocol", () => {
  assert.equal(extractProtocol("FIXED: ok\n", "polish").status, "ok")
  assert.equal(extractProtocol("BLOCKED: cannot\n", "polish").status, "blocked")
})

test("the last matching line wins", () => {
  const text = "PLAN: ok\nNo wait.\nPLAN-FAIL: revised reason\n"
  const parsed = extractProtocol(text, "plan")
  assert.equal(parsed.status, "fail")
  assert.equal(parsed.reason, "revised reason")
})

test("prose without a protocol line is null", () => {
  assert.equal(extractProtocol("I have finished the work.\nLooks good.\n", "verify"), null)
  assert.equal(extractProtocol("", "plan"), null)
})

test("quoted protocol lines inside prose still match by line", () => {
  assert.equal(extractProtocol('He answered "IMPL: ok" earlier.\nIMPL: ok\n', "implement").status, "ok")
})

test("countLines", () => {
  assert.equal(countLines(""), 0)
  assert.equal(countLines("   "), 0)
  assert.equal(countLines("one"), 1)
  assert.equal(countLines("one\ntwo\n"), 2)
  assert.equal(countLines("one\n\ntwo\r\n"), 3)
})

test("expectedLine", () => {
  assert.equal(expectedLine("plan"), "PLAN: ok")
  assert.equal(expectedLine("implement"), "IMPL: ok")
  assert.equal(expectedLine("fix"), "IMPL: ok")
  assert.equal(expectedLine("verify"), "VERIFY: pass changed=app|tests|none")
  assert.equal(expectedLine("audit"), "AUDIT: pass")
  assert.equal(expectedLine("polish"), "FIXED: ok")
})
