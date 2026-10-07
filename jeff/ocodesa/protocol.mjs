// Protocol parsing for the ocodesa pipeline on jeff-code.
//
// The role prompts make every subagent reply with exactly one protocol line;
// the driver parses the assistant text (last matching line wins, so prose or
// a quoted example cannot trip it). Copied from docs/pipeline-v3.md, which
// specified the same parser for the OpenCode plugin driver.

const PATTERNS = {
  plan: [
    { re: /^PLAN: ok\b/, parse: () => ({ status: "ok" }) },
    { re: /^PLAN-FAIL:\s*(.+)$/, parse: (m) => ({ status: "fail", reason: m[1].trim() }) },
  ],
  implement: [
    { re: /^IMPL: ok\b/, parse: () => ({ status: "ok" }) },
    { re: /^BLOCKED:\s*(.+)$/, parse: (m) => ({ status: "blocked", reason: m[1].trim() }) },
  ],
  verify: [
    {
      re: /^VERIFY: pass changed=(app|tests|none)\b/,
      parse: (m) => ({ status: "pass", changed: m[1] }),
    },
    { re: /^VERIFY: fail\b/, parse: () => ({ status: "fail" }) },
  ],
  audit: [
    { re: /^AUDIT: pass\b/, parse: () => ({ status: "pass" }) },
    { re: /^AUDIT: fail\b/, parse: () => ({ status: "fail" }) },
  ],
  polish: [
    { re: /^FIXED: ok\b/, parse: () => ({ status: "ok" }) },
    { re: /^BLOCKED:\s*(.+)$/, parse: (m) => ({ status: "blocked", reason: m[1].trim() }) },
  ],
}

// fix shares the implementer's protocol; recheck shares the verifier's.
const ALIASES = { fix: "implement", recheck: "verify" }

export const PHASES = ["plan", "implement", "verify", "recheck", "audit", "fix", "polish"]

/** Returns the expected protocol line(s) for a continuation brief. */
export function expectedLine(phase) {
  switch (phase) {
    case "plan":
      return "PLAN: ok"
    case "implement":
    case "fix":
      return "IMPL: ok"
    case "verify":
    case "recheck":
      return "VERIFY: pass changed=app|tests|none"
    case "audit":
      return "AUDIT: pass"
    case "polish":
      return "FIXED: ok"
    default:
      throw new Error(`unknown phase "${phase}"`)
  }
}

/**
 * Scans the assistant text from its last line to its first and returns the
 * first protocol match, or null when no expected line is present.
 *
 * @param {string} text
 * @param {string} phase one of PHASES (aliases fix/recheck allowed)
 * @returns {{status: string, reason?: string, changed?: string, line: string} | null}
 */
export function extractProtocol(text, phase) {
  const key = ALIASES[phase] ?? phase
  const patterns = PATTERNS[key]
  if (!patterns) throw new Error(`unknown phase "${phase}"`)
  const lines = String(text ?? "").split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line) continue
    for (const pattern of patterns) {
      const match = pattern.re.exec(line)
      if (match) return { ...pattern.parse(match), line }
    }
  }
  return null
}

/** Number of lines in a brief; used for the /pipeline-quick limit. */
export function countLines(text) {
  if (text === undefined || text === null || String(text).trim() === "") return 0
  return String(text).replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").length
}
