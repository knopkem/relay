// One task per model. Each LLM provider serves a single session at a time, so
// a task may only start when both its model provider and its agent type are
// free. This keeps a single-model setup ("one model does everything") fully
// serial, while a split setup (builder on one box, planner/reviewer on
// another) may pipeline review(N) with coding(N+1) — but never two coders,
// because the agent type is reserved too.
//
// The provider comes from the subagent's rendered frontmatter
// (`model: provider/model-id`) in the opencode config agent directory, so
// set-models.py changes are picked up without touching this file.
//
// Locks are acquired in `tool.execute.before` and released in
// `tool.execute.after`, but opencode skips `tool.execute.after` when a task
// call fails before executing (e.g. "Subagent depth limit reached", an abort,
// or a cancel). The `event` hook therefore also releases on tool parts that
// reach a terminal state; without it those calls leak their lock until the
// stale sweep and block every later task on the same provider.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const STALE_MS = 2 * 60 * 60 * 1000
const running = new Map()
const calls = new Map()

function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode")
}

function providerOf(agent) {
  try {
    const text = fs.readFileSync(
      path.join(configDir(), "agent", `${agent}.md`),
      "utf8",
    )
    const match = text.match(/^model:\s*(\S+)/m)
    return match ? match[1].split("/")[0] : "unknown"
  } catch {
    return "unknown"
  }
}

function keysFor(agent) {
  const name = agent || "unknown"
  return [`model:${providerOf(name)}`, `agent:${name}`]
}

function release(keys, callID) {
  for (const key of keys) {
    const entry = running.get(key)
    if (!entry) continue
    // Never release a lock that a newer call already owns.
    if (callID != null && entry.callID !== callID) continue
    if (callID == null && calls.has(entry.callID)) continue
    running.delete(key)
  }
}

function sweep() {
  const cutoff = Date.now() - STALE_MS
  for (const [key, entry] of running) {
    if (entry.at < cutoff) running.delete(key)
  }
  for (const [callID, keys] of calls) {
    if (!keys.some((key) => running.has(key))) calls.delete(callID)
  }
}

function label(key) {
  return key.startsWith("model:")
    ? `model "${key.slice(6)}"`
    : `agent "${key.slice(6)}"`
}

function isTerminalTaskPart(part) {
  return (
    part?.type === "tool" &&
    part.tool === "task" &&
    (part.state?.status === "completed" || part.state?.status === "error")
  )
}

export const OneTaskPerModel = async () => ({
  "tool.execute.before": async (input, output) => {
    if (input?.tool !== "task") return
    const agent = output?.args?.subagent_type ?? output?.args?.agent ?? ""
    const keys = keysFor(agent)
    sweep()
    const busy = keys.filter((key) => running.has(key))
    if (busy.length) {
      throw new Error(
        `Task blocked: ${busy.map(label).join(" and ")} already running a task. Each model serves one session at a time — wait for it to finish.`,
      )
    }
    const now = Date.now()
    for (const key of keys) running.set(key, { at: now, callID: input.callID })
    if (input.callID) calls.set(input.callID, keys)
  },
  "tool.execute.after": async (input, output) => {
    if (input?.tool !== "task") return
    let keys = input.callID ? calls.get(input.callID) : undefined
    if (!keys) {
      const agent =
        input?.args?.subagent_type ??
        output?.args?.subagent_type ??
        output?.args?.agent
      if (agent) keys = keysFor(agent)
    }
    if (keys) release(keys, input.callID)
    if (input?.callID) calls.delete(input.callID)
  },
  event: async ({ event }) => {
    if (event?.type !== "message.part.updated") return
    const part = event.properties?.part
    if (!isTerminalTaskPart(part)) return
    const keys = part.callID ? calls.get(part.callID) : undefined
    if (!keys) return
    release(keys, part.callID)
    calls.delete(part.callID)
  },
})
