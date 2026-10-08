import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CompactionLedger } from "../compaction-ledger.js"
import { rememberAgent } from "../lib/agent-gate.js"

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocodesa-ledger-"))
}

test("compaction ledger: injects only the artifacts that exist", async () => {
  const dir = tempDir()
  try {
    fs.writeFileSync(path.join(dir, "TASK.md"), "# task")
    fs.writeFileSync(path.join(dir, "PLAN.md"), "# plan")
    fs.writeFileSync(path.join(dir, "ISSUES.md"), "# issues")
    const plugin = await CompactionLedger({ directory: dir })
    rememberAgent("ses_ledger", "implementer")
    const output = { context: [] }
    await plugin["experimental.session.compacting"]({ sessionID: "ses_ledger" }, output)
    assert.equal(output.context.length, 1)
    assert.match(output.context[0], /TASK\.md/)
    assert.match(output.context[0], /PLAN\.md/)
    assert.match(output.context[0], /ISSUES\.md/)
    assert.doesNotMatch(output.context[0], /HANDOFF\.md/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("compaction ledger: no artifacts means no injection", async () => {
  const dir = tempDir()
  try {
    const plugin = await CompactionLedger({ directory: dir })
    rememberAgent("ses_ledger", "implementer")
    const output = { context: [] }
    await plugin["experimental.session.compacting"]({ sessionID: "ses_ledger" }, output)
    assert.deepEqual(output.context, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("compaction ledger: non-ocodesa sessions get no injection", async () => {
  const dir = tempDir()
  try {
    fs.writeFileSync(path.join(dir, "PLAN.md"), "# plan")
    const plugin = await CompactionLedger({ directory: dir })
    rememberAgent("ses_ledger_build", "build")
    const output = { context: [] }
    await plugin["experimental.session.compacting"]({ sessionID: "ses_ledger_build" }, output)
    assert.deepEqual(output.context, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
