import { test } from "node:test"
import assert from "node:assert/strict"

import CompactionLedger from "../compaction-ledger.js"
import LoopBreaker from "../loop-breaker.js"
import OneTaskPerModel from "../serialize-task.js"
import Supervisor from "../supervise.js"
import WriteGuard from "../write-guard.js"
import { createV2Context } from "./v2-context.js"

const definitions = [
  [CompactionLedger, "relay.compaction-ledger"],
  [LoopBreaker, "relay.loop-breaker"],
  [OneTaskPerModel, "relay.serialize-task"],
  [Supervisor, "relay.supervise"],
  [WriteGuard, "relay.write-guard"],
]

test("V1/V2 plugin entrypoints expose stable IDs and both runtimes", async () => {
  for (const [definition, id] of definitions) {
    assert.equal(definition.id, id)
    assert.equal(typeof definition.setup, "function")
    assert.equal(typeof definition.server, "function")
    assert.deepEqual(Object.keys(definition), ["id", "setup", "server"])
  }

  const legacy = await WriteGuard.server({ directory: process.cwd() })
  assert.equal(typeof legacy["tool.execute.before"], "function")

  const { ctx } = createV2Context()
  const cleanup = await WriteGuard.setup(ctx)
  assert.equal(typeof ctx.session.hook, "function")
  assert.equal(typeof ctx.tool.hook, "function")
  assert.equal(typeof cleanup, "function")
  await cleanup()
})

test("plugin modules expose one default export for the V1 loader", async () => {
  const modules = await Promise.all([
    import("../compaction-ledger.js"),
    import("../loop-breaker.js"),
    import("../serialize-task.js"),
    import("../supervise.js"),
    import("../write-guard.js"),
  ])
  for (const pluginModule of modules) {
    assert.deepEqual(Object.keys(pluginModule), ["default"])
  }
})
