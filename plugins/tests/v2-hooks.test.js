import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import CompactionLedger from "../compaction-ledger.js"
import LoopBreaker from "../loop-breaker.js"
import OneTaskPerModel from "../serialize-task.js"
import WriteGuard from "../write-guard.js"
import { createV2Context } from "./v2-context.js"

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

test("V2 loop breaker normalizes shell IDs and blocks repeated actions", async () => {
  const { ctx, toolHooks, sessionHooks, stream } = createV2Context()
  const cleanup = await LoopBreaker.setup(ctx)

  await sessionHooks.get("context")({
    sessionID: "v2_loop",
    agent: "implementer",
    system: [],
    messages: [],
    options: {},
    tools: {},
  })
  const before = toolHooks.get("execute.before")
  for (let index = 0; index < 2; index += 1) {
    await before({
      tool: "shell",
      sessionID: "v2_loop",
      agent: "implementer",
      id: `call-${index}`,
      input: { command: "npm test" },
    })
  }
  await assert.rejects(
    () =>
      before({
        tool: "shell",
        sessionID: "v2_loop",
        agent: "implementer",
        id: "call-3",
        input: { command: "npm test" },
      }),
    /ran 3 times in a row/,
  )
  assert.equal(stream.closed, false)
  await cleanup()
  assert.equal(stream.closed, true)
})

test("V2 loop breaker interrupts the session after the lock trips", async () => {
  const { ctx, toolHooks, sessionHooks, calls } = createV2Context()
  const cleanup = await LoopBreaker.setup(ctx)
  await sessionHooks.get("context")({
    sessionID: "v2_locked",
    agent: "implementer",
    system: [],
    messages: [],
    options: {},
    tools: {},
  })
  const before = toolHooks.get("execute.before")
  const run = async (command, id) =>
    before({
      tool: "shell",
      sessionID: "v2_locked",
      agent: "implementer",
      id,
      input: { command },
    })

  for (let index = 0; index < LoopBreaker.server.__test.TRIP_LIMIT; index += 1) {
    const command = `npm test --case ${index}`
    await run(command, `first-${index}`)
    await run(command, `second-${index}`)
    const expected =
      index === LoopBreaker.server.__test.TRIP_LIMIT - 1
        ? /aborted calls/
        : /ran 3 times/
    await assert.rejects(() => run(command, `third-${index}`), expected)
  }
  await assert.rejects(() => run("fresh command", "locked"), /session locked/)
  assert.deepEqual(calls.interrupted, [
    { sessionID: "v2_locked", resume: false },
  ])
  await cleanup()
})

test("V2 write guard resolves the session project and reroutes shell writes", async () => {
  const directory = tempDir("relay-v2-write-")
  const { ctx, sessionHooks, toolHooks } = createV2Context({ directory })
  try {
    const cleanup = await WriteGuard.setup(ctx)
    await sessionHooks.get("context")({
      sessionID: "v2_write",
      agent: "implementer",
      system: [],
      messages: [],
      options: {},
      tools: {},
    })

    const input = { command: "cat > nested/file.txt <<'EOF'\nbody\nEOF" }
    await toolHooks.get("execute.before")({
      tool: "shell",
      sessionID: "v2_write",
      agent: "implementer",
      id: "write-1",
      input,
    })
    assert.equal(
      fs.readFileSync(path.join(directory, "nested/file.txt"), "utf8"),
      "body\n",
    )
    assert.match(input.command, /wrote nested\/file\.txt/)

    await cleanup()
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("V2 task completion events release subagent locks", async () => {
  const config = tempDir("relay-v2-config-")
  fs.mkdirSync(path.join(config, "agent"))
  fs.writeFileSync(
    path.join(config, "agent", "builder.md"),
    "model: provider/model-x\n",
  )
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = config
  const { ctx, toolHooks, stream } = createV2Context()
  try {
    const cleanup = await OneTaskPerModel.setup(ctx)
    const before = toolHooks.get("execute.before")
    await before({
      tool: "subagent",
      sessionID: "v2_serial",
      agent: "orchestrator",
      id: "subagent-1",
      input: { agent: "builder" },
    })
    await assert.rejects(
      () =>
        before({
          tool: "subagent",
          sessionID: "v2_serial",
          agent: "orchestrator",
          id: "subagent-2",
          input: { agent: "builder" },
        }),
      /already running a task/,
    )

    stream.push({
      type: "session.tool.success",
      data: { sessionID: "v2_serial", id: "subagent-1" },
    })
    await new Promise((resolve) => setImmediate(resolve))
    await before({
      tool: "subagent",
      sessionID: "v2_serial",
      agent: "orchestrator",
      id: "subagent-3",
      input: { agent: "builder" },
    })
    await cleanup()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
    fs.rmSync(config, { recursive: true, force: true })
  }
})

test("V2 compaction ledger uses the session's project directory", async () => {
  const pluginDirectory = tempDir("relay-v2-plugin-")
  const projectDirectory = tempDir("relay-v2-project-")
  fs.writeFileSync(path.join(projectDirectory, "PLAN.md"), "# plan")
  const { ctx, sessionHooks } = createV2Context({
    directory: pluginDirectory,
    sessionInfo: (sessionID) => ({
      id: sessionID,
      location: { directory: projectDirectory },
    }),
  })
  try {
    const cleanup = await CompactionLedger.setup(ctx)
    const event = {
      sessionID: "v2_compaction",
      agent: "implementer",
      system: [],
      messages: [],
      options: {},
      tools: {},
    }
    await sessionHooks.get("compaction")(event)
    assert.equal(event.system.length, 1)
    assert.match(event.system[0].text, /PLAN\.md/)
    assert.doesNotMatch(event.system[0].text, /HANDOFF\.md/)
    await cleanup()
  } finally {
    fs.rmSync(pluginDirectory, { recursive: true, force: true })
    fs.rmSync(projectDirectory, { recursive: true, force: true })
  }
})
