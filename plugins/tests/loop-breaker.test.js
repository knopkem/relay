import { test } from "node:test"
import assert from "node:assert/strict"
import { LoopBreaker } from "../loop-breaker.js"

const before = (plugin, input, args = {}) =>
  plugin["tool.execute.before"](input, { args })

test("loop breaker: same action three times in a row throws", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "bash", sessionID: "lb_same" }
  const args = { command: "npm test" }
  await before(plugin, input, args)
  await before(plugin, input, args)
  await assert.rejects(() => before(plugin, input, args), /ran 3 times in a row/)
})

test("loop breaker: normalized commands share a fingerprint", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "bash", sessionID: "lb_norm" }
  await before(plugin, input, { command: "npm test | tail -20 2>&1" })
  await before(plugin, input, { command: "npm test" })
  await assert.rejects(
    () => before(plugin, input, { command: "npm   test | head -5" }),
    /ran 3 times/,
  )
})

test("loop breaker: five consecutive edits to one file throw until a command runs", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "edit", sessionID: "lb_edit" }
  for (let i = 0; i < 4; i += 1) {
    await before(plugin, input, { filePath: "src/a.ts", content: `v${i}` })
  }
  await assert.rejects(
    () => before(plugin, input, { filePath: "src/a.ts", content: "v5" }),
    /5 consecutive edits/,
  )
  await before(plugin, { tool: "bash", sessionID: "lb_edit" }, { command: "node --test" })
  await before(plugin, input, { filePath: "src/a.ts", content: "v6" })
})

test("loop breaker: identical output three times aborts the next retry", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "bash", sessionID: "lb_result" }
  const args = { command: "cat missing.txt" }
  const output = { args, output: "ENOENT\n" }
  await plugin["tool.execute.after"](input, output)
  await plugin["tool.execute.after"](input, output)
  await plugin["tool.execute.after"](input, output)
  await assert.rejects(() => before(plugin, input, args), /identical output 3 times/)
})

test("loop breaker: session.deleted clears the session state", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "bash", sessionID: "lb_clear" }
  const args = { command: "npm test" }
  await before(plugin, input, args)
  await before(plugin, input, args)
  await plugin.event({
    event: { type: "session.deleted", properties: { sessionID: "lb_clear" } },
  })
  await before(plugin, input, args)
  await before(plugin, input, args)
  await assert.rejects(() => before(plugin, input, args), /ran 3 times/)
})
