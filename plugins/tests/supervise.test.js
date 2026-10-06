import { test } from "node:test"
import assert from "node:assert/strict"
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
