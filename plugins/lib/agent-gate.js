// Shared role scoping for the ocodesa plugins.
//
// The plugins are installed globally, so every OpenCode session loads them.
// They must only act in the pipeline's own agent roles (orchestrator, planner,
// implementer, verifier, watcher) — never in ordinary `build`/`plan` sessions.
//
// Tool hooks carry no agent, so each session's agent is remembered from the
// chat hooks (`chat.message`, `chat.params`), which run before any tool call
// of the same turn. `withAgentTracking` installs those hooks on a plugin.

export const OCODESA_AGENTS = new Set([
  "orchestrator",
  "planner",
  "implementer",
  "verifier",
  "watcher",
  "reviewer",
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

/** Only sessions whose agent is an ocodesa role are guarded. */
export function isOcodesaSession(sessionID) {
  const agent = agentFor(sessionID)
  return agent !== undefined && OCODESA_AGENTS.has(agent)
}

/** Adds the chat hooks that remember each session's agent to a plugin's hooks. */
export function withAgentTracking(hooks) {
  return {
    ...hooks,
    "chat.message": async (input) => rememberAgent(input?.sessionID, input?.agent),
    "chat.params": async (input) => rememberAgent(input?.sessionID, input?.agent),
  }
}
