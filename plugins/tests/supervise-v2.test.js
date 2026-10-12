import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import Supervisor from "../supervise.js"
import { createV2Context } from "./v2-context.js"

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

async function withEnvironment(values, fn) {
  const previous = new Map()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("V2 supervisor registers a structured tool and injects fresh advisories", async () => {
  await withEnvironment(
    { RELAY_SUPERVISE: "pull", RELAY_SUPERVISE_DEBUG: "1" },
    async () => {
      const pluginDirectory = tempDir("relay-v2-supervisor-plugin-")
      const projectDirectory = tempDir("relay-v2-supervisor-project-")
      fs.writeFileSync(path.join(projectDirectory, "PLAN.md"), "# source plan")
      const { ctx, tools, toolHooks, sessionHooks, stream, calls } =
        createV2Context({
          directory: pluginDirectory,
          sessionInfo: (sessionID) => ({
            id: sessionID,
            location: { directory: projectDirectory },
          }),
          agents: [
            {
              id: "implementer",
              model: { providerID: "local", id: "fast" },
            },
            {
              id: "watcher",
              model: { providerID: "remote", id: "strong" },
            },
          ],
        })
      try {
        const cleanup = await Supervisor.setup(ctx)
        const askTool = tools.get("ask_supervisor")
        assert.ok(askTool)
        assert.equal(askTool.input.type, "object")
        assert.deepEqual(askTool.input.required, ["question"])

        stream.push({
          type: "session.created",
          location: { directory: projectDirectory },
          data: {
            sessionID: "v2_implementer",
            parentID: "v2_orchestrator",
            agent: "implementer",
          },
        })
        await new Promise((resolve) => setImmediate(resolve))
        await sessionHooks.get("context")({
          sessionID: "v2_implementer",
          agent: "implementer",
          system: [],
          messages: [{ role: "user", content: [{ type: "text", text: "next" }] }],
          options: {},
          tools: {},
        })

        const after = toolHooks.get("execute.after")
        for (let index = 0; index < 15; index += 1) {
          await after({
            tool: "edit",
            sessionID: "v2_implementer",
            agent: "implementer",
            id: `edit-${index}`,
            input: { filePath: `src/file-${index}.js` },
            status: "completed",
            result: { content: "changed" },
          })
        }

        const modelContext = {
          sessionID: "v2_implementer",
          agent: "implementer",
          system: [],
          messages: [{ role: "user", content: [{ type: "text", text: "next" }] }],
          options: {},
          tools: {},
        }
        await sessionHooks.get("context")(modelContext)
        assert.match(
          modelContext.messages[0].content[1].text,
          /^\[supervisor\].*15\+ edits/,
        )

        const controller = new AbortController()
        const result = await askTool.execute(
          { question: "Which file should I inspect?" },
          {
            sessionID: "v2_implementer",
            agent: "implementer",
            signal: controller.signal,
          },
        )
        assert.deepEqual(result, { content: "Watcher direction" })
        assert.equal(calls.switches[0].agent, "watcher")
        assert.equal(calls.prompts.length, 1)
        assert.equal(calls.prompts[0].options.signal, controller.signal)
        assert.match(calls.prompts[0].input.text, /Which file should I inspect/)

        const log = fs.readFileSync(
          path.join(projectDirectory, ".relay", "supervise.jsonl"),
          "utf8",
        )
        assert.match(log, /"kind":"inject"/)
        assert.match(log, /"kind":"ask"/)
        await cleanup()
        assert.equal(stream.closed, true)
      } finally {
        fs.rmSync(pluginDirectory, { recursive: true, force: true })
        fs.rmSync(projectDirectory, { recursive: true, force: true })
      }
    },
  )
})

test("V2 ask_supervisor remains gated to the implementer", async () => {
  await withEnvironment({ RELAY_SUPERVISE: "pull" }, async () => {
    const { ctx, tools } = createV2Context()
    const cleanup = await Supervisor.setup(ctx)
    const result = await tools.get("ask_supervisor").execute(
      { question: "q" },
      {
        sessionID: "v2_non_implementer",
        agent: "orchestrator",
        signal: new AbortController().signal,
      },
    )
    assert.deepEqual(result, {
      content: "ask_supervisor is only available to the implementer agent.",
    })
    await cleanup()
  })
})
