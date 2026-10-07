import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decide, isTestPath, ledgerNote } from "../role-guard/guard.mjs"

const CWD = "/tmp/project"

test("planner: write PLAN.md and AGENTS.md anywhere under the target", () => {
  assert.equal(decide({ role: "planner", toolName: "write", input: { path: "PLAN.md" }, cwd: CWD }).block, false)
  assert.equal(decide({ role: "planner", toolName: "write", input: { path: "/tmp/project/sub/PLAN.md" }, cwd: CWD }).block, false)
  assert.equal(decide({ role: "planner", toolName: "write", input: { path: "AGENTS.md" }, cwd: CWD }).block, false)
})

test("planner: every other write blocked", () => {
  const verdict = decide({ role: "planner", toolName: "write", input: { path: "src/main.rs" }, cwd: CWD })
  assert.equal(verdict.block, true)
  assert.match(verdict.reason, /only PLAN.md or AGENTS.md/)
  assert.equal(decide({ role: "planner", toolName: "write", input: {}, cwd: CWD }).block, true)
})

test("planner: edit and shell blocked", () => {
  assert.equal(decide({ role: "planner", toolName: "edit", input: { path: "PLAN.md" }, cwd: CWD }).block, true)
  assert.equal(decide({ role: "planner", toolName: "bash", input: { command: "ls" }, cwd: CWD }).block, true)
  assert.equal(decide({ role: "planner", toolName: "read", input: { path: "src/main.rs" }, cwd: CWD }).block, false)
})

test("test path detection", () => {
  for (const file of [
    "tests/test_foo.py",
    "test/foo.js",
    "src/foo.test.ts",
    "src/foo.spec.tsx",
    "spec/models/user_spec.rb",
    "__tests__/a.js",
    "conftest.py",
    "test_api.py",
    "pkg/thing_test.go",
  ]) {
    assert.equal(isTestPath(file, CWD), true, file)
  }
  for (const file of ["src/main.rs", "lib/parser.ts", "testament.py", "src/latest.ts"]) {
    assert.equal(isTestPath(file, CWD), false, file)
  }
  assert.equal(isTestPath("", CWD), false)
})

test("implementer: test files blocked, source allowed", () => {
  assert.equal(decide({ role: "implementer", toolName: "write", input: { path: "tests/test_a.py" }, cwd: CWD }).block, true)
  assert.equal(decide({ role: "implementer", toolName: "edit", input: { path: "src/a.test.ts" }, cwd: CWD }).block, true)
  assert.equal(decide({ role: "implementer", toolName: "write", input: { path: "src/main.rs" }, cwd: CWD }).block, false)
  assert.equal(decide({ role: "implementer", toolName: "bash", input: { command: "cargo test" }, cwd: CWD }).block, false)
})

test("verifier: everything allowed", () => {
  assert.equal(decide({ role: "verifier", toolName: "write", input: { path: "tests/a.py" }, cwd: CWD }).block, false)
  assert.equal(decide({ role: "verifier", toolName: "edit", input: { path: "src/a.rs" }, cwd: CWD }).block, false)
  assert.equal(decide({ role: "verifier", toolName: "bash", input: { command: "rm -rf build" }, cwd: CWD }).block, false)
})

test("audit: read-only", () => {
  assert.equal(decide({ role: "audit", toolName: "write", input: { path: "x" }, cwd: CWD }).block, true)
  assert.equal(decide({ role: "audit", toolName: "edit", input: { path: "x" }, cwd: CWD }).block, true)
  assert.equal(decide({ role: "audit", toolName: "bash", input: { command: "ls" }, cwd: CWD }).block, true)
  assert.equal(decide({ role: "audit", toolName: "read", input: { path: "x" }, cwd: CWD }).block, false)
  assert.equal(decide({ role: "audit", toolName: "grep", input: { pattern: "x" }, cwd: CWD }).block, false)
})

test("unknown role fails closed for mutations", () => {
  assert.equal(decide({ role: "", toolName: "write", input: { path: "x" }, cwd: CWD }).block, true)
  assert.equal(decide({ role: "", toolName: "read", input: { path: "x" }, cwd: CWD }).block, false)
})

test("ledgerNote lists only existing artifacts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocodesa-ledger-"))
  assert.equal(ledgerNote(dir), "")
  fs.writeFileSync(path.join(dir, "PLAN.md"), "x")
  fs.writeFileSync(path.join(dir, "ISSUES.md"), "x")
  const note = ledgerNote(dir)
  assert.match(note, /Project memory survives in files/)
  assert.match(note, /- PLAN.md/)
  assert.match(note, /- ISSUES.md/)
  assert.doesNotMatch(note, /HANDOFF.md/)
})
