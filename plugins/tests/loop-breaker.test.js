import { test } from "node:test"
import assert from "node:assert/strict"
import { LoopBreaker } from "../loop-breaker.js"
import { rememberAgent } from "../lib/agent-gate.js"

const prime = (sessionID) => rememberAgent(sessionID, "implementer")

const before = (plugin, input, args = {}) => {
  prime(input.sessionID)
  return plugin["tool.execute.before"](input, { args })
}

const after = (plugin, input, output) => {
  prime(input.sessionID)
  return plugin["tool.execute.after"](input, output)
}

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

test("loop breaker: a read resets the edit run and is never blocked by it", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "edit", sessionID: "lb_edit_read" }
  for (let i = 0; i < 4; i += 1) {
    await before(plugin, input, { filePath: "src/a.ts", content: `v${i}` })
  }
  await assert.rejects(
    () => before(plugin, input, { filePath: "src/a.ts", content: "v5" }),
    /5 consecutive edits/,
  )
  await before(
    plugin,
    { tool: "read", sessionID: "lb_edit_read" },
    { filePath: "src/a.ts" },
  )
  await before(plugin, input, { filePath: "src/a.ts", content: "v6" })
})

test("loop breaker: reads between edits keep the edit run from tripping", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "edit", sessionID: "lb_edit_interleave" }
  for (let i = 0; i < 12; i += 1) {
    await before(plugin, input, { filePath: "PLAN.md", content: `v${i}` })
    await before(
      plugin,
      { tool: "read", sessionID: "lb_edit_interleave" },
      { filePath: "PLAN.md" },
    )
  }
})

test("loop breaker: a blocked call is rejected immediately when repeated", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "bash", sessionID: "lb_blocked_repeat" }
  const args = { command: "npm test" }
  await before(plugin, input, args)
  await before(plugin, input, args)
  await assert.rejects(() => before(plugin, input, args), /ran 3 times/)
  await assert.rejects(() => before(plugin, input, args), /was just blocked/)
  await before(plugin, { tool: "bash", sessionID: "lb_blocked_repeat" }, { command: "fresh" })
  await before(plugin, input, args)
})

test("loop breaker: retrying one blocked fingerprint never locks the session", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "bash", sessionID: "lb_reblock" }
  const args = { command: "npm test" }
  await before(plugin, input, args)
  await before(plugin, input, args)
  await assert.rejects(() => before(plugin, input, args), /ran 3 times/)
  for (let i = 0; i < LoopBreaker.__test.TRIP_LIMIT + 3; i += 1) {
    await assert.rejects(() => before(plugin, input, args), /was just blocked/)
  }
  await before(plugin, { tool: "bash", sessionID: "lb_reblock" }, { command: "fresh-idea" })
})

test("loop breaker: read-only commands are blocked but never ratchet toward the lock", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "bash", sessionID: "lb_readonly" }
  for (let i = 0; i < LoopBreaker.__test.TRIP_LIMIT + 2; i += 1) {
    const args = { command: `grep -n "pub fn from_config${i}" src/lib.rs` }
    await before(plugin, input, args)
    await before(plugin, input, args)
    await assert.rejects(() => before(plugin, input, args), /ran 3 times/)
  }
  await before(plugin, { tool: "bash", sessionID: "lb_readonly" }, { command: "fresh-idea" })
})

test("loop breaker: the implementer edit-run abort asks for checks and HANDOFF.md", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "edit", sessionID: "lb_impl_edit" }
  for (let i = 0; i < 4; i += 1) {
    await before(plugin, input, { filePath: "src/a.ts", content: `v${i}` })
  }
  await assert.rejects(
    () => before(plugin, input, { filePath: "src/a.ts", content: "v5" }),
    (error) => {
      assert.match(error.message, /typecheck/)
      assert.match(error.message, /HANDOFF\.md/)
      return true
    },
  )
})

test("loop breaker: the planner edit-run abort asks for one whole-file write", async () => {
  const plugin = await LoopBreaker()
  rememberAgent("lb_planner_edit", "planner")
  const input = { tool: "edit", sessionID: "lb_planner_edit" }
  for (let i = 0; i < 4; i += 1) {
    await plugin["tool.execute.before"](input, {
      args: { filePath: "PLAN.md", oldString: `s${i}`, newString: `t${i}` },
    })
  }
  await assert.rejects(
    () =>
      plugin["tool.execute.before"](input, {
        args: { filePath: "PLAN.md", oldString: "s5", newString: "t5" },
      }),
    (error) => {
      assert.match(error.message, /whole-file write/)
      assert.match(error.message, /PLAN-FAIL/)
      assert.doesNotMatch(error.message, /typecheck/)
      return true
    },
  )
})

test("loop breaker: the planner is never locked and never aborts the session", async () => {
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
  rememberAgent("lb_planner", "planner")
  const input = { tool: "bash", sessionID: "lb_planner" }
  for (let i = 0; i < LoopBreaker.__test.TRIP_LIMIT + 2; i += 1) {
    const args = { command: `distinct-action-${i}` }
    await plugin["tool.execute.before"](input, { args })
    await plugin["tool.execute.before"](input, { args })
    await assert.rejects(
      () => plugin["tool.execute.before"](input, { args }),
      (error) => {
        assert.match(error.message, /PLAN-FAIL/)
        assert.doesNotMatch(error.message, /locked/)
        return true
      },
    )
  }
  await plugin["tool.execute.before"](input, { args: { command: "fresh-idea" } })
  assert.equal(aborts.length, 0)
})

test("loop breaker: identical output three times aborts the next retry", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "bash", sessionID: "lb_result" }
  const args = { command: "cat missing.txt" }
  const output = { args, output: "ENOENT\n" }
  await after(plugin, input, output)
  await after(plugin, input, output)
  await after(plugin, input, output)
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
    await after(plugin, input, { args, output })
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
    await after(plugin, input, { args: { ...base, repl }, output: "OK" })
  }
  await assert.rejects(
    () => before(plugin, input, { ...base, repl: "four" }),
    /identical output 3 times/,
  )
})

test("loop breaker: non-ocodesa sessions are never guarded", async () => {
  const plugin = await LoopBreaker()
  const input = { tool: "bash", sessionID: "lb_build" }
  rememberAgent("lb_build", "build")
  const args = { command: "npm test" }
  await plugin["tool.execute.before"](input, { args })
  await plugin["tool.execute.before"](input, { args })
  await plugin["tool.execute.before"](input, { args })
  await plugin["tool.execute.before"](input, { args })
})
