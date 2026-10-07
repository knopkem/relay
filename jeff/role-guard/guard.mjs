// Per-role tool-call rules for the ocodesa pipeline on jeff-code.
//
// Pi/jeff-code has no built-in permission system, so the pipeline enforces the
// role boundaries in a `tool_call` handler: the planner writes only PLAN.md or
// AGENTS.md (and never edits), the implementer never writes test files, and
// audit never mutates anything. Pure decision function so node --test can
// cover every rule.

import fs from "node:fs"
import path from "node:path"

export const LEDGER_FILES = ["TASK.md", "PLAN.md", "AGENTS.md", "HANDOFF.md", "ISSUES.md"]

const TEST_DIR = /(^|\/)(tests?|__tests__|specs?)\//
const TEST_FILE =
  /(^test[_-].*|.*[_-]tests?\.(py|js|jsx|ts|tsx|mjs|cjs|rb|go|rs|java|cs|c|cpp|h|sh)|.*\.(test|spec|tests?)\.[^/]+|conftest\.py|tests?\.py)$/i

function toolPath(input) {
  for (const key of ["path", "filePath", "file_path", "file"]) {
    const value = input?.[key]
    if (typeof value === "string" && value !== "") return value
  }
  return ""
}

function resolveTarget(filePath, cwd) {
  return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd ?? process.cwd(), filePath)
}

/** True when the path is a test file by directory, name, or suffix convention. */
export function isTestPath(filePath, cwd) {
  if (!filePath) return false
  const target = resolveTarget(filePath, cwd)
  const relative = path.relative(cwd ?? process.cwd(), target).split(path.sep).join("/")
  const normalized = relative.startsWith("..") ? target.split(path.sep).join("/") : relative
  return TEST_DIR.test(normalized) || TEST_FILE.test(path.basename(normalized))
}

/**
 * @param {{role: string, toolName: string, input?: object, cwd?: string}} call
 * @returns {{block: boolean, reason?: string}}
 */
export function decide({ role, toolName, input = {}, cwd }) {
  const mutating = toolName === "edit" || toolName === "write"
  const shell = toolName === "bash" || toolName === "powershell"

  if (role === "planner") {
    if (toolName === "edit") {
      return { block: true, reason: "planner may not edit; write PLAN.md or AGENTS.md instead" }
    }
    if (toolName === "write") {
      const target = toolPath(input)
      const name = target ? path.basename(resolveTarget(target, cwd)) : ""
      if (name === "PLAN.md" || name === "AGENTS.md") return { block: false }
      return { block: true, reason: `planner may write only PLAN.md or AGENTS.md, not ${target || "an unnamed file"}` }
    }
    if (shell) return { block: true, reason: "planner is read-only apart from PLAN.md/AGENTS.md" }
    return { block: false }
  }

  if (role === "implementer") {
    if (mutating && isTestPath(toolPath(input), cwd)) {
      return { block: true, reason: "implementer may not create or edit test files; report it in HANDOFF.md" }
    }
    return { block: false }
  }

  if (role === "verifier") return { block: false }

  if (role === "audit") {
    if (mutating || shell) return { block: true, reason: "audit is read-only" }
    return { block: false }
  }

  // Unknown role: fail closed for anything that could change the project.
  if (mutating || shell) return { block: true, reason: `unknown ocodesa role "${role}" may not mutate` }
  return { block: false }
}

/** The durable-artifact reminder appended before each role run (empty when no artifact exists). */
export function ledgerNote(cwd, exists = fs.existsSync) {
  const present = LEDGER_FILES.filter((name) => exists(path.join(cwd, name)))
  if (present.length === 0) return ""
  return [
    "## Project memory survives in files",
    "Treat these files as the source of truth over the conversation replay; re-read them before continuing:",
    ...present.map((name) => `- ${name}`),
    "Keep them current: the plan is authoritative, the handoff is the implementer's state, and the issues file holds the verifier's findings.",
  ].join("\n")
}
