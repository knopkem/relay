import { Plugin } from "@opencode/plugin"
import { registerV2AgentTracking } from "./agent-gate.js"

export function defineRelayPlugin({ id, setup, server }) {
  return {
    ...Plugin.define({ id, setup }),
    server,
  }
}

export function normalizeV2ToolName(tool) {
  if (tool === "shell") return "bash"
  if (tool === "subagent") return "task"
  return tool
}

export function toolResultText(result) {
  if (typeof result === "string") return result
  if (typeof result?.content === "string") return result.content
  if (!Array.isArray(result?.content)) return ""
  return result.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
}

export async function resolveSessionDirectory(ctx, sessionID) {
  if (!sessionID) throw new Error("Relay plugin event is missing its session ID")
  const session = await ctx.session.get({ sessionID })
  const directory = session?.location?.directory
  if (typeof directory !== "string" || !directory) {
    throw new Error(`OpenCode did not provide a location for session ${sessionID}`)
  }
  return directory
}

export async function registerV2ToolHooks(
  ctx,
  plugin,
  { rememberAgent, onBefore, onAfter } = {},
) {
  const before = plugin["tool.execute.before"]
  if (before || rememberAgent || onBefore) {
    await ctx.tool.hook("execute.before", async (event) => {
      rememberAgent?.(event.sessionID, event.agent)
      const input = {
        tool: normalizeV2ToolName(event.tool),
        sessionID: event.sessionID,
        callID: event.id,
      }
      const output = { args: event.input }
      await before?.(input, output)
      await onBefore?.(event, input, output)
    })
  }

  const after = plugin["tool.execute.after"]
  if (after || onAfter) {
    await ctx.tool.hook("execute.after", async (event) => {
      rememberAgent?.(event.sessionID, event.agent)
      const input = {
        tool: normalizeV2ToolName(event.tool),
        sessionID: event.sessionID,
        callID: event.id,
        args: event.input,
      }
      const output = {
        args: event.input,
        output: event.status === "completed" ? toolResultText(event.result) : "",
        error: event.status === "error" ? event.error : undefined,
        metadata: event.status === "completed" ? event.result?.metadata : undefined,
      }
      await after?.(input, output)
      await onAfter?.(event, input, output)
    })
  }
}

export function subscribeV2Events(ctx, onEvent) {
  const controller = new AbortController()

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          await onEvent({ event })
        } catch (error) {
          console.error("Relay plugin event handler failed:", error)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("Relay plugin event subscription failed:", error)
      }
    }
  })()

  return () => controller.abort()
}

export async function registerV2Base(
  ctx,
  plugin,
  rememberAgent,
  { onContext, onBefore, onAfter } = {},
) {
  await registerV2AgentTracking(ctx, onContext)
  await registerV2ToolHooks(ctx, plugin, { rememberAgent, onBefore, onAfter })
  const cleanup = plugin.event
    ? subscribeV2Events(ctx, plugin.event)
    : () => {}
  return cleanup
}
