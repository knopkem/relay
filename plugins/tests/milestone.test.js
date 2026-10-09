import { test } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Milestone } from "../milestone.js"

const {
  resolveMode,
  sanitizeMilestone,
  parseMilestoneIds,
  parseVerdict,
  reviewLine,
  toRel,
  excluded,
  sweepChanged,
  buildSnapshot,
  agentModels,
  frontmatterModel,
  taskChildID,
  detailStale,
  setTimings,
  setLimits,
  resetSessions,
} = Milestone.__test

setTimings({ boundaryWaitMs: 100, finalWaitMs: 300, detailWaitMs: 300, serialWaitMs: 500 })

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocodesa-milestone-"))
}

function write(root, rel, body) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  return file
}

function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex")
}

const CLEAN = "src/a.ts:3 @ abc123 | nit | tidy\nMILESTONE-REVIEW: clean"
const BLOCKED = "src/a.ts:3 @ abc123 | blocker | wrong return type\nMILESTONE-REVIEW: 1 blocker(s), 0 should-fix"

function mockClient({ agents, reviewerText = CLEAN, onPrompt, sessionAgent } = {}) {
  const prompts = []
  const gets = []
  let seq = 0
  const client = {
    ...(agents ? { app: { agents: async () => ({ data: agents }) } } : {}),
    session: {
      create: async ({ body }) => {
        seq += 1
        return { data: { id: `ses_${seq}`, ...body } }
      },
      get: async ({ path: p }) => {
        gets.push(p.id)
        return { data: { id: p.id, agent: sessionAgent ?? null } }
      },
      prompt: async ({ path: p, body }) => {
        const entry = { id: p.id, agent: body.agent, text: body.parts[0].text }
        prompts.push(entry)
        const text = onPrompt ? await onPrompt(entry) : reviewerText
        if (text === undefined) return { data: { parts: [] } }
        return { data: { parts: [{ type: "text", text }] } }
      },
    },
  }
  return { client, prompts, gets }
}

function taskEvent(parent, subagent, child, { key = "sessionId" } = {}) {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "task",
          sessionID: parent,
          state: {
            status: "completed",
            input: { subagent_type: subagent },
            metadata: { [key]: child },
          },
        },
      },
    },
  }
}

function editEvent(sessionID, filePath = "src/a.ts") {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "edit",
          sessionID,
          state: { status: "completed", input: { filePath } },
        },
      },
    },
  }
}

function userTurn(sessionID) {
  return { messages: [{ info: { sessionID, role: "user" }, parts: [] }] }
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setImmediate(resolve))
}

async function withEnv(vars, fn) {
  const previous = {}
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("resolveMode defaults to auto and rejects unknown values", () => {
  assert.equal(resolveMode(undefined), "auto")
  assert.equal(resolveMode("off"), "off")
  assert.equal(resolveMode("serial"), "serial")
  assert.equal(resolveMode("review"), "review")
  assert.equal(resolveMode("AUTO"), "auto")
  assert.equal(resolveMode("nonsense"), "auto")
})

test("taskChildID accepts the renamed and legacy metadata keys", () => {
  assert.equal(taskChildID({ state: { metadata: { sessionId: "a" } } }), "a")
  assert.equal(taskChildID({ state: { metadata: { sessionID: "b" } } }), "b")
  assert.equal(taskChildID({ state: { metadata: { sessionId: "a", sessionID: "b" } } }), "a")
  assert.equal(taskChildID({ state: { metadata: {} } }), null)
  assert.equal(taskChildID({}), null)
})

test("frontmatterModel reads the rendered agent model", () => {
  const previous = process.env.OPENCODE_CONFIG_DIR
  const dir = scratch()
  write(dir, path.join("agent", "reviewer.md"), "---\nmodel: splash/Vendor/Big-27B\n---\n")
  process.env.OPENCODE_CONFIG_DIR = dir
  try {
    assert.deepEqual(frontmatterModel("reviewer"), { provider: "splash", model: "Vendor/Big-27B" })
    assert.equal(frontmatterModel("missing"), null)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
  }
})

test("sanitizeMilestone keeps safe ids and caps length", () => {
  assert.equal(sanitizeMilestone("M2"), "M2")
  assert.equal(sanitizeMilestone("M 3/x"), "M-3-x")
  assert.equal(sanitizeMilestone(""), "unknown")
  assert.equal(sanitizeMilestone(undefined), "unknown")
  assert.equal(sanitizeMilestone("x".repeat(50)).length, 24)
})

test("parseMilestoneIds reads machine-readable plan headings", () => {
  const plan = [
    "# Plan",
    "## Milestones",
    "### M1 — CLI skeleton",
    "detail",
    "### M2 — storage",
    "### M1 — duplicate",
    "### NotAMilestone — nope",
  ].join("\n")
  assert.deepEqual(parseMilestoneIds(plan), ["M1", "M2"])
  assert.deepEqual(parseMilestoneIds(""), [])
})

test("parseVerdict handles clean, counted and malformed verdicts", () => {
  assert.deepEqual(parseVerdict(CLEAN), { clean: true, blockers: 0, shouldFix: 0, text: "clean" })
  const blocked = parseVerdict(BLOCKED)
  assert.equal(blocked.blockers, 1)
  assert.equal(blocked.shouldFix, 0)
  assert.equal(blocked.clean, false)
  const malformed = parseVerdict("src/a.ts:1 @ aa | blocker | boom")
  assert.equal(malformed.blockers, 1)
  assert.equal(malformed.text, "malformed verdict")
  assert.equal(reviewLine({ k: "M1", ...blocked }), "review of M1: 1 blocker(s), 0 should-fix")
  assert.equal(reviewLine({ k: "M1", ...parseVerdict(CLEAN) }), "review of M1: clean")
})

test("toRel rejects paths outside the project and internal files", () => {
  const root = scratch()
  assert.equal(toRel(root, "src/a.ts"), path.join("src", "a.ts"))
  assert.equal(toRel(root, path.join(root, "src", "a.ts")), path.join("src", "a.ts"))
  assert.equal(toRel(root, "../outside.ts"), null)
  assert.equal(toRel(root, ""), null)
  assert.equal(toRel(root, ".ocodesa/review/M1/manifest.json"), null)
  assert.equal(toRel(root, "REVIEW.md"), null)
  assert.equal(excluded(path.join("node_modules", "x")), true)
  assert.equal(excluded(path.join("src", "a.ts")), false)
})

test("sweepChanged finds recent files and skips excluded dirs", () => {
  const root = scratch()
  write(root, "src/a.ts", "a")
  write(root, "node_modules/pkg/index.js", "x")
  write(root, ".ocodesa/log.jsonl", "x")
  const rels = sweepChanged(root, 0)
  assert.ok(rels.includes(path.join("src", "a.ts")))
  assert.ok(!rels.some((rel) => rel.startsWith("node_modules")))
  assert.ok(!rels.some((rel) => rel.startsWith(".ocodesa")))
  assert.deepEqual(sweepChanged(root, Date.now() + 1000), [])
})

test("buildSnapshot freezes hashed copies and never overwrites", () => {
  const root = scratch()
  write(root, "src/a.ts", "export const a = 1\n")
  write(root, "HANDOFF.md", "done M1\n")
  const state = { editsSinceBoundary: new Set([path.join("src", "a.ts")]), lastBoundaryAt: 0 }
  const first = buildSnapshot(root, state, "M1")
  assert.equal(first.name, "M1")
  assert.equal(first.files, 2)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".ocodesa", "review", "M1", "manifest.json"), "utf8"))
  const entry = manifest.files.find((file) => file.path === path.join("src", "a.ts"))
  assert.equal(entry.sha256, sha("export const a = 1\n"))
  assert.equal(
    fs.readFileSync(path.join(root, ".ocodesa", "review", "M1", "files", "src", "a.ts"), "utf8"),
    "export const a = 1\n",
  )
  const second = buildSnapshot(root, { editsSinceBoundary: new Set(), lastBoundaryAt: 0 }, "M1")
  assert.equal(second.name, "M1-2")
})

test("buildSnapshot lists oversized files as skipped", () => {
  const root = scratch()
  write(root, "big.bin", "x".repeat(64))
  const previous = { fileBytes: 2 * 1024 * 1024 }
  setLimits({ snapshotFileBytes: 16 })
  try {
    const snap = buildSnapshot(root, { editsSinceBoundary: new Set(["big.bin"]), lastBoundaryAt: 0 }, "M2")
    assert.equal(snap.files, 0)
    assert.equal(snap.skipped, 1)
  } finally {
    setLimits({ snapshotFileBytes: previous.fileBytes })
  }
})

test("milestone: off mode returns no hooks", async () => {
  await withEnv({ OCODESA_MILESTONE: "off" }, async () => {
    const { client } = mockClient()
    const plugin = await Milestone({ client, directory: scratch() })
    assert.deepEqual(plugin, {})
  })
})

test("milestone: non-implementer calls are refused", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto" }, async () => {
    const { client } = mockClient()
    const plugin = await Milestone({ client, directory: scratch() })
    const reply = await plugin.tool.milestone_done.execute(
      { milestone: "M1", summary: "s" },
      { agent: "orchestrator", sessionID: "ses_o" },
    )
    assert.equal(reply, "milestone_done is only available to the implementer agent.")
  })
})

test("milestone: same provider downgrades to a serial review at the boundary", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto" }, async () => {
    const root = scratch()
    write(root, "src/a.ts", "a\n")
    const agents = [
      { name: "implementer", model: { providerID: "p", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "p", modelID: "big" } },
    ]
    const { client, prompts } = mockClient({ agents, reviewerText: BLOCKED })
    const plugin = await Milestone({ client, directory: root })
    const reply = await plugin.tool.milestone_done.execute(
      { milestone: "M1", summary: "did it", final: true },
      { agent: "implementer", sessionID: "ses_i" },
    )
    assert.match(reply, /review of M1: 1 blocker\(s\), 0 should-fix/)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].agent, "reviewer")
    assert.match(prompts[0].text, /\.ocodesa\/review\/M1/)
    const review = fs.readFileSync(path.join(root, "REVIEW.md"), "utf8")
    assert.match(review, /## milestone M1/)
    assert.match(review, /1 blocker/)
  })
})

test("milestone: split providers run the review in the background and inject blockers", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "full" }, async () => {
    const root = scratch()
    write(root, "src/a.ts", "a\n")
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
    ]
    const { client, prompts } = mockClient({ agents, reviewerText: BLOCKED })
    const plugin = await Milestone({ client, directory: root })
    await plugin.event(taskEvent("ses_parent", "implementer", "ses_i"))
    await plugin.event(editEvent("ses_i"))
    const reply = await plugin.tool.milestone_done.execute(
      { milestone: "M1", summary: "done" },
      { agent: "implementer", sessionID: "ses_i" },
    )
    assert.match(reply, /M1 snapshot/)
    await flush()
    assert.equal(prompts.filter((p) => p.agent === "reviewer").length, 1)
    const output = userTurn("ses_i")
    await plugin["experimental.chat.messages.transform"]({}, output)
    const injected = output.messages[0].parts.map((part) => part.text).join("\n")
    assert.match(injected, /\[reviewer\] milestone M1 review found 1 blocker/)
  })
})

test("milestone: the next boundary reports the previous review", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "full" }, async () => {
    const root = scratch()
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
    ]
    const { client } = mockClient({ agents, reviewerText: CLEAN })
    const plugin = await Milestone({ client, directory: root })
    await plugin.event(taskEvent("ses_parent", "implementer", "ses_i"))
    await plugin.tool.milestone_done.execute(
      { milestone: "M1", summary: "one" },
      { agent: "implementer", sessionID: "ses_i" },
    )
    await flush()
    const reply = await plugin.tool.milestone_done.execute(
      { milestone: "M2", summary: "two", final: true },
      { agent: "implementer", sessionID: "ses_i" },
    )
    assert.match(reply, /review of M1: clean/)
    assert.match(reply, /review of M2: clean/)
    const review = fs.readFileSync(path.join(root, "REVIEW.md"), "utf8")
    assert.match(review, /## milestone M1/)
    assert.match(review, /## milestone M2/)
  })
})

test("milestone: snapshots only cover files changed since the last boundary", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "serial" }, async () => {
    const root = scratch()
    write(root, "HANDOFF.md", "state\n")
    write(root, "src/one.ts", "one\n")
    const { client } = mockClient({ reviewerText: CLEAN })
    const plugin = await Milestone({ client, directory: root })
    await plugin.event(taskEvent("ses_parent", "implementer", "ses_i"))
    await plugin.event(editEvent("ses_i", "src/one.ts"))
    await plugin.tool.milestone_done.execute(
      { milestone: "M1", summary: "one", final: true },
      { agent: "implementer", sessionID: "ses_i" },
    )
    write(root, "src/two.ts", "two\n")
    await plugin.event(editEvent("ses_i", "src/two.ts"))
    await plugin.tool.milestone_done.execute(
      { milestone: "M2", summary: "two", final: true },
      { agent: "implementer", sessionID: "ses_i" },
    )
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".ocodesa", "review", "M2", "manifest.json"), "utf8"),
    )
    const paths = manifest.files.map((file) => file.path)
    assert.ok(paths.includes(path.join("src", "two.ts")))
    assert.ok(!paths.includes(path.join("src", "one.ts")))
  })
})

test("milestone: classifies implementer sessions via session.get without task metadata", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "serial" }, async () => {
    const root = scratch()
    write(root, "HANDOFF.md", "state\n")
    write(root, "src/fallback.ts", "x\n")
    const { client, gets } = mockClient({ reviewerText: CLEAN, sessionAgent: "implementer" })
    const plugin = await Milestone({ client, directory: root })
    await plugin.event(editEvent("ses_fallback", "src/fallback.ts"))
    assert.ok(gets.includes("ses_fallback"))
    await plugin.tool.milestone_done.execute(
      { milestone: "M1", summary: "s", final: true },
      { agent: "implementer", sessionID: "ses_fallback" },
    )
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".ocodesa", "review", "M1", "manifest.json"), "utf8"),
    )
    assert.ok(manifest.files.some((file) => file.path === path.join("src", "fallback.ts")))
  })
})

test("milestone: task events with the renamed sessionId key classify without session.get", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "serial" }, async () => {
    const root = scratch()
    write(root, "HANDOFF.md", "state\n")
    const { client, gets } = mockClient({ reviewerText: CLEAN })
    const plugin = await Milestone({ client, directory: root })
    await plugin.event(taskEvent("ses_parent", "implementer", "ses_renamed"))
    await plugin.event(editEvent("ses_renamed", "src/a.ts"))
    assert.deepEqual(gets, [])
  })
})

test("detailStale skips docs for milestones the builder already passed", () => {
  const ids = ["M1", "M2", "M3"]
  assert.equal(detailStale(ids, null, "M1"), false)
  assert.equal(detailStale(ids, "M1", "M1"), true)
  assert.equal(detailStale(ids, "M1", "M2"), false)
  assert.equal(detailStale(ids, "M2", "M3"), false)
  assert.equal(detailStale(ids, "M3", "M3"), true)
  assert.equal(detailStale(ids, "MX", "M1"), false)
  assert.equal(detailStale(ids, "M1", "MX"), false)
})

test("milestone: JIT announces via the message agent when no hook classified the session", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "auto" }, async () => {
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
      { name: "planner", model: { providerID: "a", modelID: "big" } },
    ]
    const { client } = mockClient({ agents })
    const plugin = await Milestone({ client, directory: scratch() })
    const output = {
      messages: [
        {
          info: { sessionID: "ses_planner_msg", role: "user", agent: "planner" },
          parts: [{ type: "text", text: "## Target: x\n## Goal: y" }],
        },
      ],
    }
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.match(output.messages[0].parts[0].text, /\[milestone\] JIT mode/)
  })
})

test("milestone: JIT announces from the planner brief text as a last resort", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "auto" }, async () => {
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
      { name: "planner", model: { providerID: "a", modelID: "big" } },
    ]
    const { client } = mockClient({ agents })
    const plugin = await Milestone({ client, directory: scratch() })
    const output = {
      messages: [
        {
          info: { sessionID: "ses_planner_brief", role: "user" },
          parts: [
            {
              type: "text",
              text: "## Target: x\n## Goal: y\nWrite PLAN.md and, if the project has no AGENTS.md, a short AGENTS.md.",
            },
          ],
        },
      ],
    }
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.match(output.messages[0].parts[0].text, /\[milestone\] JIT mode/)
  })
})

test("milestone: JIT announces through the system prompt", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "auto" }, async () => {
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
      { name: "planner", model: { providerID: "a", modelID: "big" } },
    ]
    const { client } = mockClient({ agents })
    const plugin = await Milestone({ client, directory: scratch() })
    const output = {
      system: ["You are the **planner**. You design; a fast implementer fills in your blueprint."],
    }
    await plugin["experimental.chat.system.transform"]({ sessionID: "ses_planner_sys" }, output)
    assert.equal(output.system.length, 2)
    assert.match(output.system[1], /\[milestone\] JIT mode/)
  })
})

test("milestone: the system channel never touches non-planner or detail sessions", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "auto" }, async () => {
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
      { name: "planner", model: { providerID: "a", modelID: "big" } },
    ]
    const root = scratch()
    write(root, "PLAN.md", ["### M1 — a", "### M2 — b"].join("\n"))
    const { client, prompts } = mockClient({
      agents,
      onPrompt: async (entry) => {
        if (entry.agent !== "planner") return CLEAN
        const match = entry.text.match(/MILESTONES\/(M\d+)\.md/)
        if (match) write(root, `MILESTONES/${match[1]}.md`, `# ${match[1]}\n`)
        return "MILESTONE-DETAIL: ok"
      },
    })
    const plugin = await Milestone({ client, directory: root })
    const implementerSystem = {
      system: ["You are the **implementer**. You receive the project's PLAN.md."],
    }
    await plugin["experimental.chat.system.transform"]({ sessionID: "ses_i" }, implementerSystem)
    assert.equal(implementerSystem.system.length, 1)

    await plugin.event(taskEvent("ses_parent", "implementer", "ses_i"))
    await flush()
    const detailSession = prompts.find((p) => p.agent === "planner").id
    const detailSystem = {
      system: ["You are the **planner**. You design; a fast implementer fills in your blueprint."],
    }
    await plugin["experimental.chat.system.transform"]({ sessionID: detailSession }, detailSystem)
    assert.equal(detailSystem.system.length, 1)
  })
})

test("milestone: JIT queues first-milestone detail at implementer start", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "auto" }, async () => {
    const root = scratch()
    write(root, "PLAN.md", ["## Milestones", "### M1 — a", "### M2 — b"].join("\n"))
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
      { name: "planner", model: { providerID: "a", modelID: "big" } },
    ]
    const { client, prompts } = mockClient({
      agents,
      onPrompt: async (entry) => {
        if (entry.agent === "planner") {
          write(root, "MILESTONES/M1.md", "# M1 detail\n")
          return "MILESTONE-DETAIL: ok"
        }
        return CLEAN
      },
    })
    const plugin = await Milestone({ client, directory: root })
    await plugin.event(taskEvent("ses_parent", "implementer", "ses_i"))
    await flush()
    const plannerPrompts = prompts.filter((p) => p.agent === "planner")
    assert.equal(plannerPrompts.length, 1)
    assert.match(plannerPrompts[0].text, /MILESTONES\/M1\.md/)
  })
})

test("milestone: JIT queues the next-milestone detail on the planner and injects it", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "auto" }, async () => {
    const root = scratch()
    write(
      root,
      "PLAN.md",
      ["## Milestones", "### M1 — a", "### M2 — b", "### M3 — c"].join("\n"),
    )
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
      { name: "planner", model: { providerID: "a", modelID: "big" } },
    ]
    const { client, prompts } = mockClient({
      agents,
      onPrompt: async (entry) => {
        if (entry.agent === "planner") {
          write(root, "MILESTONES/M1.md", "# M1 detail\n")
          return "MILESTONE-DETAIL: ok"
        }
        return CLEAN
      },
    })
    const plugin = await Milestone({ client, directory: root })
    await plugin.event(taskEvent("ses_parent", "implementer", "ses_i"))
    await plugin.event(editEvent("ses_i"))
    await flush()
    const plannerPrompts = prompts.filter((p) => p.agent === "planner")
    assert.equal(plannerPrompts.length, 1)
    assert.match(plannerPrompts[0].text, /MILESTONES\/M1\.md/)
    assert.ok(fs.existsSync(path.join(root, "MILESTONES", "M1.md")))
    const detailTurn = userTurn(plannerPrompts[0].id)
    await plugin["chat.params"]({ sessionID: plannerPrompts[0].id, agent: "planner" })
    await plugin["experimental.chat.messages.transform"]({}, detailTurn)
    assert.equal(detailTurn.messages[0].parts.length, 0)
    const output = userTurn("ses_i")
    await plugin["experimental.chat.messages.transform"]({}, output)
    const injected = output.messages[0].parts.map((part) => part.text).join("\n")
    assert.match(injected, /\[milestone\] MILESTONES\/M1\.md is ready/)
  })
})

test("milestone: the boundary requests and waits for the next detail doc", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "auto" }, async () => {
    const root = scratch()
    write(root, "PLAN.md", ["### M1 — a", "### M2 — b"].join("\n"))
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
      { name: "planner", model: { providerID: "a", modelID: "big" } },
    ]
    const { client, prompts } = mockClient({
      agents,
      onPrompt: async (entry) => {
        if (entry.agent !== "planner") return CLEAN
        const match = entry.text.match(/MILESTONES\/(M\d+)\.md/)
        if (match) write(root, `MILESTONES/${match[1]}.md`, `# ${match[1]}\n`)
        return "MILESTONE-DETAIL: ok"
      },
    })
    const plugin = await Milestone({ client, directory: root })
    await plugin.event(taskEvent("ses_parent", "implementer", "ses_i"))
    const reply = await plugin.tool.milestone_done.execute(
      { milestone: "M1", summary: "one" },
      { agent: "implementer", sessionID: "ses_i" },
    )
    assert.match(reply, /MILESTONES\/M2\.md ready/)
    assert.ok(
      prompts.some((p) => p.agent === "planner" && p.text.includes("MILESTONES/M2.md")),
    )
  })
})

test("milestone: JIT stays off when planner shares the implementer provider", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "auto" }, async () => {
    const root = scratch()
    write(root, "PLAN.md", ["### M1 — a", "### M2 — b"].join("\n"))
    const agents = [
      { name: "implementer", model: { providerID: "p", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "p", modelID: "big" } },
      { name: "planner", model: { providerID: "p", modelID: "big" } },
    ]
    const { client, prompts } = mockClient({ agents })
    const plugin = await Milestone({ client, directory: root })
    await plugin.event(taskEvent("ses_parent", "implementer", "ses_i"))
    await plugin.event(editEvent("ses_i"))
    await flush()
    assert.equal(prompts.filter((p) => p.agent === "planner").length, 0)
  })
})

test("milestone: explicit full disables JIT even with split providers", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "full" }, async () => {
    const root = scratch()
    write(root, "PLAN.md", ["### M1 — a", "### M2 — b"].join("\n"))
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
      { name: "planner", model: { providerID: "a", modelID: "big" } },
    ]
    const { client, prompts } = mockClient({ agents })
    const plugin = await Milestone({ client, directory: root })
    await plugin.event(taskEvent("ses_parent", "implementer", "ses_i"))
    await plugin.event(editEvent("ses_i"))
    await flush()
    assert.equal(prompts.filter((p) => p.agent === "planner").length, 0)
  })
})

test("milestone: explicit jit forces detail jobs when detection is unavailable", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "jit" }, async () => {
    const root = scratch()
    write(root, "PLAN.md", ["### M1 — a", "### M2 — b"].join("\n"))
    const { client, prompts } = mockClient({
      onPrompt: async (entry) => {
        if (entry.agent === "planner") {
          write(root, "MILESTONES/M1.md", "# M1\n")
          return "MILESTONE-DETAIL: ok"
        }
        return CLEAN
      },
    })
    const plugin = await Milestone({ client, directory: root })
    await plugin.event(taskEvent("ses_parent", "implementer", "ses_i"))
    await plugin.event(editEvent("ses_i"))
    await flush()
    assert.equal(prompts.filter((p) => p.agent === "planner").length, 1)
  })
})

test("milestone: JIT announcer marks planner sessions when the planner is split", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "auto" }, async () => {
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
      { name: "planner", model: { providerID: "a", modelID: "big" } },
    ]
    const { client } = mockClient({ agents })
    const plugin = await Milestone({ client, directory: scratch() })
    await plugin["chat.params"]({ sessionID: "ses_p", agent: "planner" })
    const output = userTurn("ses_p")
    await plugin["experimental.chat.messages.transform"]({}, output)
    assert.match(output.messages[0].parts[0].text, /\[milestone\] JIT mode/)
  })
})

test("milestone: detection failure keeps background reviews", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto", OCODESA_PLAN: "full" }, async () => {
    const { client, prompts } = mockClient()
    const plugin = await Milestone({ client, directory: scratch() })
    await plugin.tool.milestone_done.execute(
      { milestone: "M1", summary: "s", final: true },
      { agent: "implementer", sessionID: "ses_i" },
    )
    assert.equal(prompts.filter((p) => p.agent === "reviewer").length, 1)
  })
})

test("milestone: the factory never calls the agents API", async () => {
  resetSessions()
  let agentCalls = 0
  const client = {
    app: {
      agents: async () => {
        agentCalls += 1
        return { data: [] }
      },
    },
    session: {
      create: async () => ({ data: { id: "ses_x" } }),
      prompt: async () => ({ data: { parts: [] } }),
    },
  }
  await Milestone({ client, directory: scratch() })
  assert.equal(agentCalls, 0)
})

test("milestone: the last milestone from PLAN.md is awaited without final", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "auto" }, async () => {
    const root = scratch()
    write(root, "PLAN.md", ["## Milestones", "### M1 — only"].join("\n"))
    const agents = [
      { name: "implementer", model: { providerID: "b", modelID: "flash" } },
      { name: "reviewer", model: { providerID: "a", modelID: "big" } },
    ]
    const { client } = mockClient({ agents, reviewerText: CLEAN })
    const plugin = await Milestone({ client, directory: root })
    const reply = await plugin.tool.milestone_done.execute(
      { milestone: "M1", summary: "only" },
      { agent: "implementer", sessionID: "ses_i" },
    )
    assert.match(reply, /review of M1: clean/)
    assert.match(fs.readFileSync(path.join(root, "REVIEW.md"), "utf8"), /## milestone M1/)
  })
})

test("milestone: reviewer failure never breaks the boundary", async () => {
  resetSessions()
  await withEnv({ OCODESA_MILESTONE: "serial" }, async () => {
    const root = scratch()
    const client = {
      session: {
        create: async () => ({ error: "no reviewer" }),
        prompt: async () => ({ data: { parts: [] } }),
      },
    }
    const plugin = await Milestone({ client, directory: root })
    const reply = await plugin.tool.milestone_done.execute(
      { milestone: "M1", summary: "s", final: true },
      { agent: "implementer", sessionID: "ses_i" },
    )
    assert.match(reply, /M1 snapshot/)
    assert.match(reply, /review of M1 failed/)
  })
})
