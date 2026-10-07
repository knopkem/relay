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

const TRIP_LIMIT = LoopBreaker.__test.TRIP_LIMIT

const tripSession = async (plugin, sessionID) => {
  const input = { tool: "bash", sessionID }
  for (let i = 0; i < TRIP_LIMIT; i += 1) {
    const args = { command: `distinct-action-${i}` }
    await before(plugin, input, args)
    await before(plugin, input, args)
    await assert.rejects(() => before(plugin, input, args), /ran 3 times/)
  }
  return input
}

test("loop breaker: TRIP_LIMIT aborts lock the session", async () => {
  const plugin = await LoopBreaker()
  const input = await tripSession(plugin, "lb_lock")
  await assert.rejects(
    () => before(plugin, input, { command: "fresh-idea" }),
    /session locked .* tools are disabled/,
  )
})

test("loop breaker: first locked call aborts the session once", async () => {
  const aborts = []
  const plugin = await LoopBreaker({
    client: {
      session: {
        abort: async (options) => {
          aborts.push(options)
        },
      },
    },
  })
  const input = await tripSession(plugin, "lb_abort")
  assert.equal(aborts.length, 0)
  await assert.rejects(() => before(plugin, input, { command: "ignored" }), /tools are disabled/)
  assert.deepEqual(aborts, [{ path: { id: "lb_abort" } }])
  await assert.rejects(() => before(plugin, input, { command: "ignored again" }), /tools are disabled/)
  assert.equal(aborts.length, 1)
})

test("loop breaker: flag variations share a fingerprint", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "bash", sessionID: "lb_flags" }
  await before(plugin, input, { command: 'grep -A4 "^error"' })
  await before(plugin, input, { command: 'grep -A12 "^error"' })
  await assert.rejects(() => before(plugin, input, { command: 'grep -A5 "^error"' }), /ran 3 times/)
})

test("loop breaker: volatile tokens and reordered lines count as identical output", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "bash", sessionID: "lb_volatile" }
  const args = { command: "cargo test" }
  const outputs = [
    "thread 'a' (111) panicked at src/r.rs:1\nfailures:\n  x\n  y\nfinished in 0.01s\n",
    "  y\nfailures:\n  x\nfinished in 0.02s\nthread 'a' (222) panicked at src/r.rs:1\n",
    "finished in 0.03s\nthread 'a' (333) panicked at src/r.rs:1\n  y\nfailures:\n  x\n",
  ]
  for (const output of outputs) {
    await plugin["tool.execute.after"](input, { args, output })
  }
  await assert.rejects(() => before(plugin, input, args), /identical output 3 times/)
})

test("loop breaker: same replace target variants share a fingerprint", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "serena_replace_content", sessionID: "lb_needle" }
  const base = {
    relative_path: "src/game.rs",
    needle: "fn test_rock_falls\\(\\) \\{.*?\\n    \\}",
  }
  for (const repl of ["one", "two", "three"]) {
    await plugin["tool.execute.after"](input, { args: { ...base, repl }, output: "OK" })
  }
  await assert.rejects(
    () => before(plugin, input, { ...base, repl: "four" }),
    /identical output 3 times/,
  )
})
