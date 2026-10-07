// Brief builders for the ocodesa pipeline on jeff-code. Copied verbatim from
// docs/pipeline-v3.md's brief table; the role prompts are appended system
// prompts in the child jeff-code process, so a brief carries only the paths.

export const QUICK_MAX_LINES = 5

/** @returns {string} */
export function buildBrief(key, { directory, task } = {}) {
  const T = directory
  switch (key) {
    case "planFile":
      return `## Target: ${T}\n## Brief: ${T}/TASK.md\nWrite PLAN.md.`
    case "planQuick":
      return `## Target: ${T}\n## Goal: ${task}\nWrite PLAN.md.`
    case "implement":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\nRead AGENTS.md too. Implement the entire plan in one go.`
    case "implementResume":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\nRead AGENTS.md too. Implement the entire plan in one go.\nYou were interrupted. Read HANDOFF.md if it exists, continue the plan, keep HANDOFF.md updated, run the plan's build/test commands.`
    case "verify":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\n## Handoff: ${T}/HANDOFF.md\nFull verification.`
    case "recheck":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\n## Handoff: ${T}/HANDOFF.md\nFull verification.\nRe-check mode: only the findings in the latest section of ISSUES.md.`
    case "fix":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\n## Fix: ${T}/ISSUES.md\nFix only the findings still open in the latest section.`
    case "audit":
      return `## Target: ${T}\n## Plan: ${T}/PLAN.md\nMODE: audit — read the latest section of ISSUES.md.`
    case "polish":
      return `## Target: ${T}\n## Fix: ${T}/ISSUES.md\nFix only the audit findings in the latest section; keep test changes justified.`
    default:
      throw new Error(`unknown brief "${key}"`)
  }
}

/**
 * The one continuation brief used when a reply contains no protocol line.
 * @param {{directory: string, reportFile: string, line: string}} spec
 */
export function continuationBrief({ directory, reportFile, line }) {
  return [
    `## Target: ${directory}`,
    "Your previous reply was interrupted or contained no protocol line.",
    `Read ${reportFile} and bring it up to date, then reply with exactly one line:`,
    line,
  ].join("\n")
}
