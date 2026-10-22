import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agent")

function frontmatter(name) {
  const text = readFileSync(join(AGENT_DIR, `${name}.md`), "utf8")
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(match, `${name}.md has frontmatter`)
  return Object.fromEntries(
    match[1]
      .split("\n")
      .filter((line) => /^[a-z_]+:/.test(line))
      .map((line) => {
        const index = line.indexOf(":")
        return [line.slice(0, index), line.slice(index + 1).trim()]
      }),
  )
}

test("relay subagents stay out of the global subagent catalog", () => {
  for (const role of ["planner", "implementer", "verifier", "watcher"]) {
    const meta = frontmatter(role)
    assert.equal(meta.mode, "subagent", `${role} is a subagent`)
    assert.equal(meta.hidden, "true", `${role} must be hidden from regular sessions`)
  }
})

test("the orchestrator stays selectable", () => {
  const meta = frontmatter("orchestrator")
  assert.equal(meta.mode, "primary")
  assert.notEqual(meta.hidden, "true")
})
