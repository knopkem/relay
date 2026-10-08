import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import { Supervisor } from "../supervise.js"

const {
  resolveMode,
  normalizeCommand,
  summarizeTool,
  firstLine,
  outputFailed,
  recorderLines,
  pickAdvisory,
  failureSignals,
  agentModels,
  modelsDiffer,
  withAskReminder,
  shouldPrereview,
  planExcerpt,
} = Supervisor.__test

test("resolveMode defaults to full and rejects unknown values", () => {
  assert.equal(resolveMode(undefined), "full")
  assert.equal(resolveMode("off"), "off")
  assert.equal(resolveMode("advisory"), "advisory")
  assert.equal(resolveMode("pull"), "pull")
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

test("outputFailed flags common failure markers", () => {
  assert.equal(outputFailed("test result: ok. 3 passed; 0 failed"), false)
  assert.equal(outputFailed("error[E0599]: no method named `tile` found"), true)
  assert.equal(outputFailed("thread 'x' (1) panicked at src/a.rs:1"), true)
  assert.equal(outputFailed("npm ERR! code ELIFECYCLE"), true)
  assert.equal(outputFailed("src/a.rs:12: some error: text"), false)
})

test("modelsDiffer compares the implementer and watcher models", () => {
  const same = agentModels([
    { name: "implementer", model: { providerID: "p", modelID: "m" } },
    { name: "watcher", model: { providerID: "p", modelID: "m" } },
  ])
  assert.deepEqual(same, { implementer: "p/m", watcher: "p/m" })
  assert.equal(modelsDiffer(same), false)
  assert.equal(
    modelsDiffer(
      agentModels([
        { name: "implementer", model: { providerID: "p", modelID: "m" } },
        { name: "watcher", model: { providerID: "p", modelID: "other" } },
      ]),
    ),
    true,
  )
  assert.equal(modelsDiffer(agentModels([])), null)
  assert.equal(
    modelsDiffer(agentModels([{ name: "watcher", model: { providerID: "p", modelID: "m" } }])),
    null,
  )
})

test("withAskReminder nudges when the previous advisory was ignored", () => {
  const base = { supervisorEnabled: true, advisories: 1, asks: 0, asksAtLastAdvisory: 0 }
  assert.match(withAskReminder("stop", base), /did not use ask_supervisor/)
  assert.equal(withAskReminder("stop", { ...base, asks: 1 }), "stop")
  assert.equal(withAskReminder("stop", { ...base, supervisorEnabled: false }), "stop")
  assert.equal(withAskReminder("stop", { ...base, advisories: 0 }), "stop")
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
  assert.match(pickAdvisory({ edits: 0, explore: 0, repeatedFail: true }), /failed 3 times/)
  assert.match(pickAdvisory({ edits: 0, explore: 0, repeatedFail: true }, true), /ask_supervisor/)
  assert.doesNotMatch(pickAdvisory({ edits: 0, explore: 0, repeatedFail: true }, false), /ask_supervisor/)
  assert.match(
    pickAdvisory({ edits: 0, explore: 0, repeatedFail: false, editsSincePass: 15 }),
    /since the last passing command/,
  )
  assert.equal(pickAdvisory({ edits: 1, explore: 1, repeatedFail: false }), null)
})

test("failureSignals summarizes runs, edits and recent failures", () => {
  const lines = failureSignals({
    failedRuns: 2,
    editsSincePass: 4,
    entries: [{ ok: false, summary: "bash: cargo test", error: "exit 1" }],
  })
  const text = lines.join("\n")
  assert.match(text, /2 failed command run/)
  assert.match(text, /4 edit/)
  assert.match(text, /bash: cargo test — exit 1/)
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

function mockClient({ agents } = {}) {
  const gets = []
  const prompts = []
  const client = {
    ...(agents ? { app: { agents: async () => ({ data: agents }) } } : {}),
    session: {
      get: async ({ path }) => {
        gets.push(path.id)
        return { data: { id: path.id, agent: "implementer" } }
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

function toolEvent(sessionID, { tool = "edit", status = "completed", input, output, metadata, error } = {}) {
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
            output,
            metadata,
            error,
          },
        },
      },
    },
  }
}

function userTurn(sessionID) {
  return { messages: [{ info: { sessionID, role: "user" }, parts: [] }] }
}

async function classifyChild(plugin, sessionID) {
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
            metadata: { sessionID },
          },
        },
      },
    },
  })
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

test("supervise: task-tool implementer children classify and get advisories", async () => {
  await withMode("full", async () => {
    const { client, gets } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    await classifyChild(plugin, "sup_task_child")
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

    await classifyChild(plugin, "sup_advisory_mode")
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
    await classifyChild(plugin, "sup_prereview")
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

test("supervise: failing output counts as a failure and advises", async () => {
  await withMode("full", async () => {
    const { client } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    await classifyChild(plugin, "sup_exit")
    const failing = {
      tool: "bash",
      input: { command: "cargo test" },
      output: "error[E0599]: no method named `tile` found\n",
    }
    for (let i = 0; i < 3; i += 1) await plugin.event(toolEvent("sup_exit", failing))
    const output = userTurn("sup_exit")
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.match(output.messages[0].parts[0].text, /same command has failed 3 times/)
  })
})

test("supervise: a passing command resets failure counters", async () => {
  await withMode("full", async () => {
    const { client } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    await classifyChild(plugin, "sup_reset")
    const failing = {
      tool: "bash",
      input: { command: "cargo test" },
      output: "failures:\n    game::tests::test_rock_falls\n",
    }
    for (let i = 0; i < 2; i += 1) await plugin.event(toolEvent("sup_reset", failing))
    await plugin.event(
      toolEvent("sup_reset", {
        tool: "bash",
        input: { command: "cargo test" },
        output: "test result: ok. 12 passed; 0 failed\n",
      }),
    )
    for (let i = 0; i < 2; i += 1) await plugin.event(toolEvent("sup_reset", failing))
    const output = userTurn("sup_reset")
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.equal(output.messages[0].parts.length, 0)
  })
})

test("supervise: edits since the last passing command advise", async () => {
  await withMode("full", async () => {
    const { client } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    await classifyChild(plugin, "sup_since")
    await plugin.event(
      toolEvent("sup_since", { tool: "bash", input: { command: "cargo build" }, metadata: { exit: 1 } }),
    )
    for (let i = 0; i < 15; i += 1) await plugin.event(toolEvent("sup_since"))
    const output = userTurn("sup_since")
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.match(output.messages[0].parts[0].text, /since the last passing command/)
  })
})

test("supervise: loop-breaker errors queue the handoff nudge", async () => {
  await withMode("full", async () => {
    const { client } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    await classifyChild(plugin, "sup_handoff")
    await plugin.event(
      toolEvent("sup_handoff", {
        tool: "bash",
        status: "error",
        input: { command: "npm test" },
        error: "Loop breaker: 5 consecutive edits to src/a.ts without running a command.",
      }),
    )
    const output = userTurn("sup_handoff")
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.match(output.messages[0].parts[0].text, /HANDOFF\.md/)
    assert.match(output.messages[0].parts[0].text, /BLOCKED/)
  })
})

test("supervise: escalation asks the watcher with failure signals", async () => {
  await withMode("full", async () => {
    const { client, prompts } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    await classifyChild(plugin, "sup_escalate")
    const failing = {
      tool: "bash",
      input: { command: "cargo test" },
      output: "error[E0599]: no method named `tile` found\n",
    }
    for (let i = 0; i < 3; i += 1) await plugin.event(toolEvent("sup_escalate", failing))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(prompts.length, 1)
    assert.match(prompts[0].text, /## Failure signals/)
    assert.match(prompts[0].text, /cargo test/)
  })
})

test("supervise: same-model watcher downgrades to pull lazily, with no API call in the factory", async () => {
  await withMode("full", async () => {
    const agents = [
      { name: "implementer", model: { providerID: "p", modelID: "same" } },
      { name: "watcher", model: { providerID: "p", modelID: "same" } },
    ]
    const { client, prompts } = mockClient({ agents })
    let agentCalls = 0
    const counted = {
      ...client,
      app: {
        agents: async (input) => {
          agentCalls += 1
          return client.app.agents(input)
        },
      },
    }
    const plugin = await Supervisor({ client: counted, directory: os.tmpdir() })
    // Regression guard: an opencode API call inside the factory runs while the
    // server is still bootstrapping and deadlocks startup into a blank TUI.
    assert.equal(agentCalls, 0)
    assert.ok(plugin.tool?.ask_supervisor)
    await classifyChild(plugin, "sup_same")
    const failing = {
      tool: "bash",
      input: { command: "cargo test" },
      output: "error[E0599]: no method named `tile` found\n",
    }
    for (let i = 0; i < 3; i += 1) await plugin.event(toolEvent("sup_same", failing))
    assert.equal(agentCalls, 1) // resolved once, on the first completed tool event
    const output = userTurn("sup_same")
    await plugin["experimental.chat.messages.transform"]({}, output)
    const text = output.messages[0].parts[0].text
    assert.match(text, /same command has failed 3 times/)
    assert.match(text, /ask_supervisor/)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(prompts.length, 0) // the push channels stay off
  })
})

test("supervise: a same-model ask reaches the watcher and carries a same-model note", async () => {
  await withMode("full", async () => {
    const agents = [
      { name: "implementer", model: { providerID: "p", modelID: "same" } },
      { name: "watcher", model: { providerID: "p", modelID: "same" } },
    ]
    const { client, prompts } = mockClient({ agents })
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    const reply = await plugin.tool.ask_supervisor.execute(
      { question: "q" },
      { agent: "implementer", sessionID: "sup_same_ask" },
    )
    assert.match(reply, /Check src\/a\.ts first\./)
    assert.match(reply, /same-model supervisor/)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].agent, "watcher")
  })
})

test("supervise: pull mode keeps ask_supervisor and skips the push channels", async () => {
  await withMode("pull", async () => {
    const { client, prompts } = mockClient()
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    await classifyChild(plugin, "sup_pull")
    for (let i = 0; i < 25; i += 1) {
      await plugin.event(toolEvent("sup_pull", { tool: "read", input: { filePath: "src/a.ts" } }))
    }
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(prompts.length, 0)
    const answer = await plugin.tool.ask_supervisor.execute(
      { question: "q" },
      { agent: "implementer", sessionID: "sup_pull" },
    )
    assert.equal(answer, "Check src/a.ts first.")
    assert.equal(prompts.length, 1)
  })
})

test("supervise: different models keep the ask tool and full behavior", async () => {
  await withMode("full", async () => {
    const agents = [
      { name: "implementer", model: { providerID: "p", modelID: "small" } },
      { name: "watcher", model: { providerID: "p", modelID: "big" } },
    ]
    const { client, prompts } = mockClient({ agents })
    const plugin = await Supervisor({ client, directory: os.tmpdir() })
    assert.ok(plugin.tool?.ask_supervisor)
    await classifyChild(plugin, "sup_diff")
    const failing = {
      tool: "bash",
      input: { command: "cargo test" },
      output: "error[E0599]: no method named `tile` found\n",
    }
    for (let i = 0; i < 3; i += 1) await plugin.event(toolEvent("sup_diff", failing))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(prompts.length, 1)
  })
})
