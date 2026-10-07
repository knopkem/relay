import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import { Supervisor } from "../supervise.js"

const {
  resolveMode,
  normalizeCommand,
  summarizeTool,
  firstLine,
  recorderLines,
  pickAdvisory,
  shouldPrereview,
  planExcerpt,
} = Supervisor.__test

test("resolveMode defaults to full and rejects unknown values", () => {
  assert.equal(resolveMode(undefined), "full")
  assert.equal(resolveMode("off"), "off")
  assert.equal(resolveMode("advisory"), "advisory")
  assert.equal(resolveMode("FULL"), "full")
  assert.equal(resolveMode("nonsense"), "full")
})

test("normalizeCommand collapses whitespace", () => {
  assert.equal(normalizeCommand("  npm   test\n"), "npm test")
  assert.equal(normalizeCommand(undefined), "")
})

test("summarizeTool names the relevant input per tool", () => {
  assert.equal(summarizeTool("bash", { command: "npm   test" }), "bash: npm test")
  assert.equal(summarizeTool("edit", { filePath: "src/a.ts" }), "edit: src/a.ts")
  assert.equal(summarizeTool("write", { filePath: "src/b.ts" }), "write: src/b.ts")
  assert.equal(summarizeTool("read", { filePath: "src/c.ts" }), "read: src/c.ts")
  assert.equal(summarizeTool("grep", { pattern: "TODO" }), "grep: TODO")
  assert.equal(summarizeTool("task", { subagent_type: "verifier" }), "task: verifier")
  assert.equal(summarizeTool("todowrite", {}), "todowrite")
})

test("summarizeTool truncates long values", () => {
  const summary = summarizeTool("bash", { command: "x".repeat(500) })
  assert.ok(summary.length <= "bash: ".length + 100)
  assert.ok(summary.endsWith("…"))
})

test("firstLine keeps one truncated line", () => {
  assert.equal(firstLine("boom\nsecond"), "boom")
  assert.equal(firstLine(""), "")
  assert.ok(firstLine("y".repeat(300), 40).length <= 40)
})

test("recorderLines marks failures and caps the window", () => {
  const entries = [
    { summary: "read: a", ok: true },
    { summary: "bash: npm test", ok: false, error: "3 failing" },
  ]
  assert.equal(
    recorderLines(entries),
    "- read: a\n- bash: npm test [FAILED: 3 failing]",
  )
  const many = Array.from({ length: 50 }, (_, i) => ({ summary: `t${i}`, ok: true }))
  const lines = recorderLines(many).split("\n")
  assert.equal(lines.length, 40)
  assert.equal(lines[0], "- t10")
})

test("pickAdvisory fires on edit runs, explore runs and repeated failures", () => {
  assert.match(pickAdvisory({ edits: 15, explore: 0, repeatedFail: false }), /edits/)
  assert.match(pickAdvisory({ edits: 0, explore: 40, repeatedFail: false }), /explored/)
  assert.match(pickAdvisory({ edits: 0, explore: 0, repeatedFail: true }), /failed 2 times/)
  assert.equal(pickAdvisory({ edits: 1, explore: 1, repeatedFail: false }), null)
})

test("shouldPrereview respects cadence, budget and busy state", () => {
  const base = {
    prereviews: 0,
    sincePrereview: 25,
    watcherBusy: false,
    lastPrereviewAt: 0,
  }
  assert.equal(shouldPrereview(base, 10 * 60_000), true)
  assert.equal(shouldPrereview({ ...base, sincePrereview: 24 }, 10 * 60_000), false)
  assert.equal(shouldPrereview({ ...base, prereviews: 4 }, 10 * 60_000), false)
  assert.equal(shouldPrereview({ ...base, watcherBusy: true }, 10 * 60_000), false)
  assert.equal(shouldPrereview({ ...base, lastPrereviewAt: 9 * 60_000 }, 10 * 60_000), false)
})

test("planExcerpt caps long plans", () => {
  assert.equal(planExcerpt("short"), "short")
  const capped = planExcerpt("p".repeat(100), 10)
  assert.ok(capped.length > 10)
  assert.match(capped, /plan truncated at 10 chars/)
})

function mockClient({ agent = "implementer" } = {}) {
  const gets = []
  const prompts = []
  const client = {
    session: {
      get: async ({ path }) => {
        gets.push(path.id)
        return { data: { id: path.id, agent } }
      },
      create: async ({ body }) => ({ data: { id: `ses_watcher_${prompts.length + 1}`, ...body } }),
      prompt: async ({ path, body }) => {
        prompts.push({ id: path.id, agent: body.agent, text: body.parts[0].text })
        return { data: { parts: [{ type: "text", text: "Check src/a.ts first." }] } }
      },
    },
  }
  return { client, gets, prompts }
}

function toolEvent(sessionID, { tool = "edit", status = "completed", input } = {}) {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool,
          sessionID,
          state: {
            status,
            input: input ?? { filePath: "src/a.ts", content: `v${Math.random()}` },
          },
        },
      },
    },
  }
}

function userTurn(sessionID) {
  return { messages: [{ info: { sessionID, role: "user" }, parts: [] }] }
}

async function withMode(mode, fn) {
  const previous = process.env.OCODESA_SUPERVISE
  process.env.OCODESA_SUPERVISE = mode
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.OCODESA_SUPERVISE
    else process.env.OCODESA_SUPERVISE = previous
  }
}

test("supervise: plugin-created implementer sessions classify and get canned advisories", async () => {
  await withMode("full", async () => {
    const { client, gets } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    for (let i = 0; i < 15; i += 1) await plugin.event(toolEvent("sup_advisory_child"))

    assert.deepEqual(gets, ["sup_advisory_child"])
    const output = userTurn("sup_advisory_child")
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.equal(output.messages[0].parts.length, 1)
    assert.match(output.messages[0].parts[0].text, /^\[supervisor\] you have made 15\+ edits/)
    assert.equal(output.messages[0].parts[0].synthetic, true)
  })
})

test("supervise: non-implementer sessions classify once and are never recorded", async () => {
  await withMode("full", async () => {
    const { client, gets } = mockClient({ agent: "build" })
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    for (let i = 0; i < 20; i += 1) await plugin.event(toolEvent("ses_other"))

    assert.deepEqual(gets, ["ses_other"])
    const output = userTurn("ses_other")
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.equal(output.messages[0].parts.length, 0)
  })
})

test("supervise: task-tool implementer children classify without session.get", async () => {
  await withMode("full", async () => {
    const { client, gets } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            sessionID: "ses_parent",
            state: {
              status: "completed",
              input: { subagent_type: "implementer" },
              metadata: { sessionID: "sup_task_child" },
            },
          },
        },
      },
    })
    for (let i = 0; i < 15; i += 1) await plugin.event(toolEvent("sup_task_child"))

    assert.deepEqual(gets, [])
    const output = userTurn("sup_task_child")
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.match(output.messages[0].parts[0].text, /15\+ edits/)
  })
})

test("supervise: ask_supervisor gates on agent and reaches the watcher", async () => {
  await withMode("full", async () => {
    const { client, prompts } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })

    const refused = await plugin.tool.ask_supervisor.execute(
      { question: "q" },
      { agent: "orchestrator", sessionID: "ses_o" },
    )
    assert.equal(refused, "ask_supervisor is only available to the implementer agent.")

    const answer = await plugin.tool.ask_supervisor.execute(
      { question: "where do I start?" },
      { agent: "implementer", sessionID: "sup_ask" },
    )
    assert.equal(answer, "Check src/a.ts first.")
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].agent, "watcher")
    assert.match(prompts[0].text, /where do I start\?/)
  })
})

test("supervise: advisory mode disables ask_supervisor but keeps canned advisories", async () => {
  await withMode("advisory", async () => {
    const { client } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    const reply = await plugin.tool.ask_supervisor.execute(
      { question: "q" },
      { agent: "implementer", sessionID: "sup_advisory_mode" },
    )
    assert.match(reply, /advisory mode; ask_supervisor is disabled/)

    for (let i = 0; i < 15; i += 1) await plugin.event(toolEvent("sup_advisory_mode"))
    const output = userTurn("sup_advisory_mode")
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.match(output.messages[0].parts[0].text, /15\+ edits/)
  })
})

test("supervise: off mode returns no hooks", async () => {
  await withMode("off", async () => {
    const { client } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    assert.deepEqual(plugin, {})
  })
})

test("supervise: prereview asks the watcher after 25 tool calls and injects the note", async () => {
  await withMode("full", async () => {
    const { client, prompts } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    for (let i = 0; i < 25; i += 1) {
      await plugin.event(toolEvent("sup_prereview", { tool: "read", input: { filePath: "src/a.ts" } }))
    }
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].agent, "watcher")
    assert.match(prompts[0].text, /Reply exactly `continue`/)
    const output = userTurn("sup_prereview")
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.match(output.messages[0].parts[0].text, /^\[supervisor\] Check src\/a\.ts first\./)
  })
})
