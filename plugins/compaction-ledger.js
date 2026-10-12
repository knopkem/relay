// Keeps long-running sessions honest across compaction.
//
// The implementer and the orchestrator can outlive the context window. The
// summary is lossy, so this plugin injects the durable project memory into the
// compaction prompt: the session re-reads the files instead of trusting a
// degraded summary. Files are only listed when they actually exist in the
// project directory.

import fs from "node:fs"
import path from "node:path"

import {
  isRelaySession,
  rememberAgent,
  withAgentTracking,
} from "./lib/agent-gate.js"
import {
  defineRelayPlugin,
  registerV2Base,
  resolveSessionDirectory,
} from "./lib/plugin-entrypoint.js"

const LEDGER_FILES = ["TASK.md", "PLAN.md", "AGENTS.md", "HANDOFF.md", "ISSUES.md"]

function ledgerContext(directory) {
  const present = LEDGER_FILES.filter((name) =>
    fs.existsSync(path.join(directory, name)),
  )
  if (!present.length) return null
  return [
    "## Project memory survives in files",
    "Treat these files as the source of truth over this summary; re-read them before continuing:",
    ...present.map((name) => `- ${name}`),
    "",
    "Preserve in the summary: the current milestone of the plan, every file",
    "created or modified, exact exported symbol names and who imports or",
    "mounts them, what is implemented but not yet wired, the latest handoff",
    "state, the verifier's open findings, and any command still failing.",
  ].join("\n")
}

const CompactionLedger = async ({ directory }) =>
  withAgentTracking({
    "experimental.session.compacting": async (input, output) => {
      if (!isRelaySession(input?.sessionID)) return
      const context = ledgerContext(directory)
      if (context) output.context.push(context)
    },
  })

export default defineRelayPlugin({
  id: "relay.compaction-ledger",
  server: CompactionLedger,
  setup: async (ctx) => {
    const plugin = await CompactionLedger({ directory: ctx.location.directory })
    const cleanup = await registerV2Base(ctx, plugin, rememberAgent)
    await ctx.session.hook("compaction", async (event) => {
      rememberAgent(event.sessionID, event.agent)
      if (!isRelaySession(event.sessionID)) return
      const directory = await resolveSessionDirectory(ctx, event.sessionID)
      const context = ledgerContext(directory)
      if (context) event.system.push({ type: "text", text: context })
    })
    return cleanup
  },
})
