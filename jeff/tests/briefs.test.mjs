import test from "node:test"
import assert from "node:assert/strict"
import { buildBrief, continuationBrief, QUICK_MAX_LINES } from "../ocodesa/briefs.mjs"

const T = "/tmp/proj"

test("plan briefs", () => {
  assert.equal(buildBrief("planFile", { directory: T }), `## Target: ${T}\n## Brief: ${T}/TASK.md\nWrite PLAN.md.`)
  assert.equal(buildBrief("planQuick", { directory: T, task: "fix the typo" }), `## Target: ${T}\n## Goal: fix the typo\nWrite PLAN.md.`)
})

test("implement briefs", () => {
  assert.equal(
    buildBrief("implement", { directory: T }),
    `## Target: ${T}\n## Plan: ${T}/PLAN.md\nRead AGENTS.md too. Implement the entire plan in one go.`,
  )
  assert.match(buildBrief("implementResume", { directory: T }), /You were interrupted/)
})

test("verify briefs", () => {
  assert.equal(
    buildBrief("verify", { directory: T }),
    `## Target: ${T}\n## Plan: ${T}/PLAN.md\n## Handoff: ${T}/HANDOFF.md\nFull verification.`,
  )
  assert.match(buildBrief("recheck", { directory: T }), /Re-check mode/)
})

test("fix, audit and polish briefs", () => {
  assert.match(buildBrief("fix", { directory: T }), /Fix only the findings still open/)
  assert.match(buildBrief("audit", { directory: T }), /MODE: audit/)
  assert.match(buildBrief("polish", { directory: T }), /keep test changes justified/)
})

test("unknown brief", () => {
  assert.throws(() => buildBrief("nope", { directory: T }), /unknown brief/)
})

test("continuation brief", () => {
  const brief = continuationBrief({ directory: T, reportFile: "HANDOFF.md", line: "IMPL: ok" })
  assert.equal(
    brief,
    `## Target: ${T}\nYour previous reply was interrupted or contained no protocol line.\nRead HANDOFF.md and bring it up to date, then reply with exactly one line:\nIMPL: ok`,
  )
})

test("quick limit constant", () => {
  assert.equal(QUICK_MAX_LINES, 5)
})
