// Shared role scoping for the Relay plugins.
//
// The plugins are installed globally, so every OpenCode session loads them.
// They must only act in the pipeline's own agent roles (orchestrator, planner,
// implementer, verifier, watcher) — never in ordinary `build`/`plan` sessions.
//
// V1 tool hooks omit the agent, so the chat hooks (`chat.message`,
// `chat.params`) cache it before tool calls. V2 tool hooks carry the agent;
// the session context hook also caches it before model requests.

export const RELAY_AGENTS = new Set([
  "orchestrator",
  "planner",
  "implementer",
  "verifier",
  "watcher",
])

const MAX_SESSIONS = 256
const sessionAgents = new Map()

export function rememberAgent(sessionID, agent) {
  if (!sessionID || !agent) return
  sessionAgents.delete(sessionID)
  sessionAgents.set(sessionID, String(agent))
  if (sessionAgents.size > MAX_SESSIONS) {
    sessionAgents.delete(sessionAgents.keys().next().value)
  }
}

export function forgetAgent(sessionID) {
  if (sessionID) sessionAgents.delete(sessionID)
}

export function agentFor(sessionID) {
  return sessionID ? sessionAgents.get(sessionID) : undefined
}

/** Only sessions whose agent is a Relay role are guarded. */
export function isRelaySession(sessionID) {
  const agent = agentFor(sessionID)
  return agent !== undefined && RELAY_AGENTS.has(agent)
}

/** Adds the chat hooks that remember each session's agent to a plugin's hooks. */
export function withAgentTracking(hooks) {
  return {
    ...hooks,
    "chat.message": async (input) => rememberAgent(input?.sessionID, input?.agent),
    "chat.params": async (input) => rememberAgent(input?.sessionID, input?.agent),
  }
}

/** Tracks the active V2 agent before each model context is assembled. */
export async function registerV2AgentTracking(ctx, onContext) {
  await ctx.session.hook("context", (event) => {
    rememberAgent(event.sessionID, event.agent)
    return onContext?.(event)
  })
}
