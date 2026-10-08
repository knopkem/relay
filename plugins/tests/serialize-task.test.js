import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OneTaskPerModel } from "../serialize-task.js"
import { rememberAgent } from "../lib/agent-gate.js"

const asOrchestrator = () => rememberAgent("ses_serial", "orchestrator")

function configDir(agents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocodesa-serialize-"))
  fs.mkdirSync(path.join(dir, "agent"))
  for (const [name, provider] of Object.entries(agents)) {
    fs.writeFileSync(path.join(dir, "agent", `${name}.md`), `model: ${provider}/model-x\n`)
  }
  return dir
}

async function withConfig(dir, fn) {
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = dir
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const taskCall = (agent, callID) => [
  { tool: "task", sessionID: "ses_serial", callID },
  { args: { subagent_type: agent, description: "t" } },
]

test("serialize-task: the same agent and provider serve one task at a time", async () => {
  await withConfig(configDir({ builder: "provA" }), async () => {
    const plugin = await OneTaskPerModel()
    asOrchestrator()
    await plugin["tool.execute.before"](...taskCall("builder", "c1"))
    await assert.rejects(
      () => plugin["tool.execute.before"](...taskCall("builder", "c2")),
      /already running a task/,
    )
    await plugin["tool.execute.after"](...taskCall("builder", "c1"))
    await plugin["tool.execute.before"](...taskCall("builder", "c3"))
    await plugin["tool.execute.after"](...taskCall("builder", "c3"))
  })
})

test("serialize-task: one provider blocks different agents", async () => {
  await withConfig(configDir({ builder: "provB", planner: "provB" }), async () => {
    const plugin = await OneTaskPerModel()
    asOrchestrator()
    await plugin["tool.execute.before"](...taskCall("builder", "c4"))
    await assert.rejects(
      () => plugin["tool.execute.before"](...taskCall("planner", "c5")),
      /model "provB" already running/,
    )
    await plugin["tool.execute.after"](...taskCall("builder", "c4"))
  })
})

test("serialize-task: different providers may pipeline concurrently", async () => {
  await withConfig(configDir({ builder: "provC", planner: "provD" }), async () => {
    const plugin = await OneTaskPerModel()
    asOrchestrator()
    await plugin["tool.execute.before"](...taskCall("builder", "c6"))
    await plugin["tool.execute.before"](...taskCall("planner", "c7"))
    await plugin["tool.execute.after"](...taskCall("builder", "c6"))
    await plugin["tool.execute.after"](...taskCall("planner", "c7"))
  })
})

test("serialize-task: a terminal tool part releases the lock", async () => {
  await withConfig(configDir({ builder: "provE" }), async () => {
    const plugin = await OneTaskPerModel()
    asOrchestrator()
    await plugin["tool.execute.before"](...taskCall("builder", "c8"))
    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: { type: "tool", tool: "task", callID: "c8", state: { status: "completed" } },
        },
      },
    })
    await plugin["tool.execute.before"](...taskCall("builder", "c9"))
    await plugin["tool.execute.after"](...taskCall("builder", "c9"))
  })
})

test("serialize-task: non-ocodesa sessions are not serialized", async () => {
  await withConfig(configDir({ builder: "provF" }), async () => {
    const plugin = await OneTaskPerModel()
    rememberAgent("ses_serial", "build")
    await plugin["tool.execute.before"](...taskCall("builder", "c10"))
    await plugin["tool.execute.before"](...taskCall("builder", "c11"))
    await plugin["tool.execute.after"](...taskCall("builder", "c10"))
    await plugin["tool.execute.after"](...taskCall("builder", "c11"))
  })
})
