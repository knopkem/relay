// ocodesa role guard extension for jeff-code children.
//
// Loaded with `--no-extensions --extension jeff/role-guard`; the role comes
// from OCODESA_ROLE (set by the dispatcher). Enforces the role's path rules on
// `tool_call` and keeps the durable artifacts visible before each run.

import { decide, ledgerNote } from "./guard.mjs"

export default function (pi) {
  const role = process.env.OCODESA_ROLE ?? ""

  pi.on("tool_call", async (event) => {
    const verdict = decide({ role, toolName: event.toolName, input: event.input, cwd: process.cwd() })
    if (verdict.block) return { block: true, reason: verdict.reason }
  })

  pi.on("before_agent_start", async (event) => {
    const note = ledgerNote(process.cwd())
    if (!note) return
    return { systemPrompt: `${event.systemPrompt}\n\n${note}` }
  })
}
