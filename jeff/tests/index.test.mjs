import test from "node:test"
import assert from "node:assert/strict"
import ocodesa from "../ocodesa/index.ts"
import roleGuard from "../role-guard/index.ts"

test("ocodesa extension registers four commands and a shutdown hook", () => {
  const commands = new Map()
  const events = []
  const pi = {
    registerCommand(name, options) {
      commands.set(name, options)
    },
    on(event) {
      events.push(event)
    },
    appendEntry() {},
  }
  ocodesa(pi)
  assert.deepEqual([...commands.keys()].sort(), [
    "pipeline",
    "pipeline-quick",
    "pipeline-resume",
    "pipeline-status",
  ])
  for (const options of commands.values()) assert.equal(typeof options.handler, "function")
  assert.deepEqual(events, ["session_shutdown"])
})

test("role guard blocks according to OCODESA_ROLE", async () => {
  const previous = process.env.OCODESA_ROLE
  const handlers = new Map()
  const pi = {
    on(event, handler) {
      handlers.set(event, handler)
    },
  }
  try {
    process.env.OCODESA_ROLE = "audit"
    roleGuard(pi)
    const blocked = await handlers.get("tool_call")({
      type: "tool_call",
      toolName: "write",
      input: { path: "src/a.ts" },
    })
    assert.equal(blocked.block, true)
    const read = await handlers.get("tool_call")({
      type: "tool_call",
      toolName: "read",
      input: { path: "src/a.ts" },
    })
    assert.equal(read, undefined)
  } finally {
    if (previous === undefined) delete process.env.OCODESA_ROLE
    else process.env.OCODESA_ROLE = previous
  }
})
