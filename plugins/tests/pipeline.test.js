import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Pipeline } from "../pipeline.js"
import * as pipelineModule from "../pipeline.js"

const {
  extractProtocol,
  buildBrief,
  initialState,
  readState,
  writeState,
  statePath,
} = Pipeline.__test

const temps = []
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir({ task = "build a thing" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocodesa-pipeline-"))
  temps.push(dir)
  if (task !== null) fs.writeFileSync(path.join(dir, "TASK.md"), `${task}\n`)
  return dir
}

function mockClient(script = {}) {
  const queues = {
    planner: [...(script.planner ?? [])],
    implementer: [...(script.implementer ?? [])],
    verifier: [...(script.verifier ?? [])],
  }
  const created = []
  const prompts = []
  const aborted = []
  let seq = 0

  const client = {
    session: {
      create: async ({ body } = {}) => {
        seq += 1
        const id = `ses_${seq}`
        created.push({ id, ...(body ?? {}) })
        return { data: { id } }
      },
      prompt: async ({ path: target, body, signal }) => {
        prompts.push({ id: target.id, agent: body.agent, text: body.parts?.[0]?.text ?? "" })
        const queue = queues[body.agent] ?? []
        if (queue.length === 0) throw new Error(`no scripted reply for ${body.agent}`)
        const reply = queue.shift()
        const value = typeof reply === "function" ? await reply({ path: target, body, signal }) : reply
        if (value && typeof value === "object" && value.error !== undefined) {
          return { error: value.error }
        }
        const text =
          value && typeof value === "object" && "text" in value ? value.text : String(value ?? "")
        return { data: { parts: [{ type: "text", text }] } }
      },
      get: async ({ path: target }) => ({ data: { id: target.id, agent: "implementer" } }),
      abort: async ({ path: target }) => {
        aborted.push(target.id)
        return { data: true }
      },
    },
  }
  return { client, created, prompts, aborted }
}

function contextFor(dir, { agent = "orchestrator", signal, sessionID = "ses_parent" } = {}) {
  return { agent, sessionID, directory: dir, abort: signal, metadata: () => {} }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("1. parser: last matching line wins; prose and other protocol lines ignored", () => {
  const text = ["I will now implement.", "IMPL: ok", "Some prose", "VERIFY: fail"].join("\n")
  assert.deepEqual(extractProtocol(text, "implement"), { status: "ok", line: "IMPL: ok" })
  assert.deepEqual(extractProtocol("IMPL: ok", "fix"), { status: "ok", line: "IMPL: ok" })
  assert.equal(extractProtocol("", "plan"), null)
  assert.equal(extractProtocol("PLAN-FAIL is not a protocol line", "plan"), null)
})

test("2. parser: VERIFY: pass without changed= is malformed", () => {
  assert.equal(extractProtocol("VERIFY: pass", "verify"), null)
  assert.equal(extractProtocol("VERIFY: pass changed=sometimes", "verify"), null)
  assert.deepEqual(extractProtocol("VERIFY: pass changed=app", "verify"), {
    status: "pass",
    changed: "app",
    line: "VERIFY: pass changed=app",
  })
})

test("3. parser: PLAN-FAIL and BLOCKED reasons are extracted", () => {
  assert.deepEqual(extractProtocol("PLAN-FAIL: no TASK.md brief", "plan"), {
    status: "fail",
    reason: "no TASK.md brief",
    line: "PLAN-FAIL: no TASK.md brief",
  })
  assert.deepEqual(extractProtocol("BLOCKED: missing API key", "implement"), {
    status: "blocked",
    reason: "missing API key",
    line: "BLOCKED: missing API key",
  })
})

test("4. happy path changed=none: three child sessions, no audit, done", async () => {
  const dir = tempDir()
  const m = mockClient({
    planner: ["PLAN: ok"],
    implementer: ["IMPL: ok"],
    verifier: ["VERIFY: pass changed=none"],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const summary = await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  const state = readState(dir)
  assert.equal(m.created.length, 3)
  assert.equal(state.status, "done")
  assert.equal(state.phase, "verify")
  assert.equal(state.sessions.polisher, "ses_3")
  assert.match(summary, /pipeline done — verify/)
})

test("5. changed=app runs the audit: four sessions, done", async () => {
  const dir = tempDir()
  const m = mockClient({
    planner: ["PLAN: ok"],
    implementer: ["IMPL: ok"],
    verifier: ["VERIFY: pass changed=app", "AUDIT: pass"],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  const state = readState(dir)
  assert.equal(m.created.length, 4)
  assert.equal(state.status, "done")
  assert.deepEqual(state.verdicts, [
    "PLAN: ok",
    "IMPL: ok",
    "VERIFY: pass changed=app",
    "AUDIT: pass",
  ])
})

test("6. audit fail polishes through the same verifier, then audit passes", async () => {
  const dir = tempDir()
  const m = mockClient({
    planner: ["PLAN: ok"],
    implementer: ["IMPL: ok"],
    verifier: ["VERIFY: pass changed=app", "AUDIT: fail", "FIXED: ok", "AUDIT: pass"],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  const state = readState(dir)
  assert.equal(state.status, "done")
  assert.equal(state.round, 1)
  assert.equal(m.created.length, 5)
  assert.equal(m.prompts[4].id, "ses_3")
  assert.match(m.prompts[4].text, /Fix only the audit findings/)
  assert.equal(m.prompts[5].id, "ses_5")
})

test("7. verify fail fixes with the implementer, rechecks fresh, audits", async () => {
  const dir = tempDir()
  const m = mockClient({
    planner: ["PLAN: ok"],
    implementer: ["IMPL: ok", "IMPL: ok"],
    verifier: ["VERIFY: fail", "VERIFY: pass changed=app", "AUDIT: pass"],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  const state = readState(dir)
  assert.equal(state.status, "done")
  assert.equal(state.round, 1)
  assert.equal(m.prompts[3].id, "ses_2")
  assert.match(m.prompts[3].text, /Fix only the findings still open/)
  assert.equal(m.prompts[4].id, "ses_4")
  assert.equal(state.sessions.polisher, "ses_4")
})

test("8. round cap: persistent VERIFY: fail stops after five fix dispatches", async () => {
  const dir = tempDir()
  const m = mockClient({
    planner: ["PLAN: ok"],
    implementer: Array.from({ length: 6 }, () => "IMPL: ok"),
    verifier: Array.from({ length: 6 }, () => "VERIFY: fail"),
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const summary = await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  const state = readState(dir)
  const fixDispatches = m.prompts.filter((p) => /Fix only the findings/.test(p.text))
  assert.equal(fixDispatches.length, 5)
  assert.equal(state.status, "blocked")
  assert.match(summary, /round cap reached \(5\)/)
})

test("9. PLAN-FAIL stops immediately with failed status and the reason", async () => {
  const dir = tempDir()
  const m = mockClient({ planner: ["PLAN-FAIL: brief too vague"] })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  const state = readState(dir)
  assert.equal(state.status, "failed")
  assert.equal(state.phase, "plan")
  assert.equal(state.reason, "brief too vague")
  assert.equal(m.created.length, 1)
})

test("10. BLOCKED stops with blocked status and the reason", async () => {
  const dir = tempDir()
  const m = mockClient({
    planner: ["PLAN: ok"],
    implementer: ["BLOCKED: missing credentials"],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  const state = readState(dir)
  assert.equal(state.status, "blocked")
  assert.equal(state.reason, "missing credentials")
})

test("11. malformed reply gets one continuation to the same session", async () => {
  const dir = tempDir()
  const m = mockClient({
    planner: ["I could not decide", "PLAN: ok"],
    implementer: ["IMPL: ok"],
    verifier: ["VERIFY: pass changed=none"],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  const state = readState(dir)
  const plannerPrompts = m.prompts.filter((p) => p.agent === "planner")
  assert.equal(state.status, "done")
  assert.equal(plannerPrompts.length, 2)
  assert.equal(plannerPrompts[1].id, plannerPrompts[0].id)
  assert.match(plannerPrompts[1].text, /PLAN\.md/)
  assert.match(plannerPrompts[1].text, /PLAN: ok/)
})

test("12. malformed twice stops with a malformed reason", async () => {
  const dir = tempDir()
  const m = mockClient({ planner: ["nope", "still no protocol line"] })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const summary = await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  const state = readState(dir)
  assert.equal(state.status, "blocked")
  assert.match(state.reason, /malformed reply from planner/)
  assert.equal(m.prompts.length, 2)
  assert.match(summary, /resume: call pipeline_resume/)
})

test("13. prompt error stops failed and keeps session ids", async () => {
  const dir = tempDir()
  const m = mockClient({ planner: [{ error: { data: { message: "provider down" } } }] })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  const state = readState(dir)
  assert.equal(state.status, "failed")
  assert.equal(state.reason, "provider down")
  assert.equal(state.sessions.planner, "ses_1")
})

test("14. abort aborts the active child session and persists aborted", async () => {
  const dir = tempDir()
  const controller = new AbortController()
  const m = mockClient({
    planner: [
      () => {
        controller.abort()
        return { error: { message: "aborted" } }
      },
    ],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  await plugin.tool.run_pipeline.execute({}, contextFor(dir, { signal: controller.signal }))
  const state = readState(dir)
  assert.equal(state.status, "aborted")
  assert.deepEqual(m.aborted, ["ses_1"])
})

test("15. run_pipeline without TASK.md returns the brief error", async () => {
  const dir = tempDir({ task: null })
  const m = mockClient({})
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const result = await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  assert.equal(result, "PLAN-FAIL: no TASK.md brief")
  assert.equal(m.created.length, 0)
  assert.equal(readState(dir), null)
})

test("16. quick brief over five lines is rejected before any session", async () => {
  const dir = tempDir()
  const m = mockClient({})
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const result = await plugin.tool.run_pipeline.execute(
    { task: "1\n2\n3\n4\n5\n6" },
    contextFor(dir),
  )
  assert.equal(result, "PLAN-FAIL: brief too large; write it to TASK.md and run /pipeline")
  assert.equal(m.created.length, 0)
})

test("17. inline task wins over TASK.md and uses the quick brief", async () => {
  const dir = tempDir({ task: "this file must be ignored" })
  const m = mockClient({
    planner: ["PLAN: ok"],
    implementer: ["IMPL: ok"],
    verifier: ["VERIFY: pass changed=none"],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  await plugin.tool.run_pipeline.execute({ task: "do the thing" }, contextFor(dir))
  assert.equal(
    m.prompts[0].text,
    buildBrief("planQuick", { directory: dir, task: "do the thing" }),
  )
})

test("18. non-orchestrator agents are refused by all three tools", async () => {
  const dir = tempDir()
  const m = mockClient({})
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const context = contextFor(dir, { agent: "build" })
  const refused = "run_pipeline is only available to the orchestrator agent."
  assert.equal(await plugin.tool.run_pipeline.execute({ task: "x" }, context), refused)
  assert.equal(await plugin.tool.pipeline_status.execute({}, context), refused)
  assert.equal(await plugin.tool.pipeline_resume.execute({}, context), refused)
  assert.equal(m.created.length, 0)
})

test("19. concurrent run in the same directory is refused", async () => {
  const dir = tempDir()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const m = mockClient({
    planner: [
      async () => {
        await gate
        return "PLAN: ok"
      },
    ],
    implementer: ["IMPL: ok"],
    verifier: ["VERIFY: pass changed=none"],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const first = plugin.tool.run_pipeline.execute({}, contextFor(dir))
  await tick()
  const second = await plugin.tool.run_pipeline.execute({}, contextFor(dir))
  assert.equal(second, `pipeline already running in ${dir}`)
  release()
  assert.match(await first, /pipeline done/)
})

test("20. state file is written after every transition", async () => {
  const dir = tempDir()
  let releaseImpl
  const implGate = new Promise((resolve) => {
    releaseImpl = resolve
  })
  let releaseVerify
  const verifyGate = new Promise((resolve) => {
    releaseVerify = resolve
  })
  const m = mockClient({
    planner: ["PLAN: ok"],
    implementer: [
      async () => {
        await implGate
        return "IMPL: ok"
      },
    ],
    verifier: [
      async () => {
        await verifyGate
        return "VERIFY: pass changed=none"
      },
    ],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const run = plugin.tool.run_pipeline.execute({}, contextFor(dir))
  await tick()
  assert.equal(readState(dir).phase, "implement")

  releaseImpl()
  await tick()
  assert.equal(readState(dir).phase, "verify")
  assert.equal(readState(dir).round, 0)

  releaseVerify()
  await run
  const state = readState(dir)
  assert.equal(state.phase, "verify")
  assert.equal(state.status, "done")
  assert.equal(statePath(dir), path.join(dir, ".ocodesa", "pipeline.json"))
})

test("21. pipeline_status reports phase, round and artifacts", async () => {
  const dir = tempDir()
  const state = initialState(dir)
  state.phase = "verify"
  state.round = 2
  state.sessions.planner = "ses_a"
  state.sessions.implementer = "ses_b"
  writeState(state)
  fs.writeFileSync(path.join(dir, "PLAN.md"), "# plan")
  fs.writeFileSync(path.join(dir, "HANDOFF.md"), "# handoff")
  const m = mockClient({})
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const status = await plugin.tool.pipeline_status.execute({}, contextFor(dir))
  assert.match(status, /pipeline running — verify/)
  assert.match(status, /rounds: 2/)
  assert.match(status, /sessions: planner=ses_a, implementer=ses_b/)
  assert.match(status, /artifacts: PLAN\.md, HANDOFF\.md/)
  assert.doesNotMatch(status, /ISSUES\.md/)
})

test("22. pipeline_resume refuses a done run", async () => {
  const dir = tempDir()
  const state = initialState(dir)
  state.status = "done"
  writeState(state)
  const m = mockClient({})
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const result = await plugin.tool.pipeline_resume.execute({}, contextFor(dir))
  assert.equal(result, "pipeline already done; start a new run")
})

test("23. pipeline_resume from implement re-prompts the saved implementer", async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, "PLAN.md"), "# plan")
  const state = initialState(dir)
  state.phase = "implement"
  state.sessions.planner = "ses_old"
  state.sessions.implementer = "ses_imp"
  writeState(state)
  const m = mockClient({
    implementer: ["IMPL: ok"],
    verifier: ["VERIFY: pass changed=none"],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const result = await plugin.tool.pipeline_resume.execute({}, contextFor(dir))
  assert.equal(m.prompts[0].id, "ses_imp")
  assert.match(m.prompts[0].text, /You were interrupted/)
  assert.equal(m.created.length, 1)
  assert.match(result, /pipeline done/)
})

test("24. pipeline_resume from polish re-prompts the saved polisher", async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, "PLAN.md"), "# plan")
  const state = initialState(dir)
  state.phase = "polish"
  state.sessions.polisher = "ses_pol"
  writeState(state)
  const m = mockClient({ verifier: ["FIXED: ok", "AUDIT: pass"] })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  await plugin.tool.pipeline_resume.execute({}, contextFor(dir))
  const final = readState(dir)
  assert.equal(m.prompts[0].id, "ses_pol")
  assert.match(m.prompts[0].text, /Fix only the audit findings/)
  assert.equal(final.status, "done")
  assert.equal(final.round, 1)
})

test("25. pipeline_resume without PLAN.md is refused", async () => {
  const dir = tempDir()
  const state = initialState(dir)
  state.phase = "implement"
  writeState(state)
  const m = mockClient({})
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const result = await plugin.tool.pipeline_resume.execute({}, contextFor(dir))
  assert.equal(result, "cannot resume: PLAN.md is missing; start a new run")
  assert.equal(m.prompts.length, 0)
})

test("26. pipeline_resume while a run is live is refused", async () => {
  const dir = tempDir()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const m = mockClient({
    planner: [
      async () => {
        await gate
        return "PLAN: ok"
      },
    ],
    implementer: ["IMPL: ok"],
    verifier: ["VERIFY: pass changed=none"],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const first = plugin.tool.run_pipeline.execute({}, contextFor(dir))
  await tick()
  const result = await plugin.tool.pipeline_resume.execute({}, contextFor(dir))
  assert.equal(result, `pipeline already running in ${dir}`)
  release()
  await first
})

test("27. module exports only plugin functions (OpenCode loader contract)", () => {
  for (const [name, value] of Object.entries(pipelineModule)) {
    assert.equal(typeof value, "function", `export ${name} must be a function`)
  }
  assert.equal(typeof Pipeline.__test.extractProtocol, "function")
})

test("28. pipeline_status reports a live run while the lock is held", async () => {
  const dir = tempDir()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const m = mockClient({
    planner: [
      async () => {
        await gate
        return "PLAN: ok"
      },
    ],
    implementer: ["IMPL: ok"],
    verifier: ["VERIFY: pass changed=none"],
  })
  const plugin = await Pipeline({ client: m.client, directory: dir })
  const first = plugin.tool.run_pipeline.execute({}, contextFor(dir))
  await tick()
  const status = await plugin.tool.pipeline_status.execute({}, contextFor(dir))
  assert.match(status, /pipeline running \(live\)/)
  assert.match(status, /pipeline running — plan/)
  release()
  assert.match(await first, /pipeline done/)
})
