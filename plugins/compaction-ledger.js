// Keeps long-running sessions honest across compaction.
//
// The implementer and the orchestrator can outlive the context window. The
// summary is lossy, so this plugin injects the durable project memory into the
// compaction prompt: the session re-reads the files instead of trusting a
// degraded summary. Files are only listed when they actually exist in the
// project directory.

import fs from "node:fs"
import path from "node:path"

import { isOcodesaSession, withAgentTracking } from "./lib/agent-gate.js"

const LEDGER_FILES = ["TASK.md", "PLAN.md", "AGENTS.md", "HANDOFF.md", "ISSUES.md", "REVIEW.md"]

export const CompactionLedger = async ({ directory }) =>
  withAgentTracking({
    "experimental.session.compacting": async (input, output) => {
      if (!isOcodesaSession(input?.sessionID)) return
      const present = LEDGER_FILES.filter((name) =>
        fs.existsSync(path.join(directory, name)),
      )
      if (!present.length) return
      output.context.push(
        [
          "## Project memory survives in files",
          "Treat these files as the source of truth over this summary; re-read them before continuing:",
          ...present.map((name) => `- ${name}`),
          "",
          "Preserve in the summary: the current milestone of the plan, every file",
          "created or modified, exact exported symbol names and who imports or",
          "mounts them, what is implemented but not yet wired, the latest handoff",
          "state, the verifier's open findings, and any command still failing.",
        ].join("\n"),
      )
    },
  })
