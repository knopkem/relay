// Role dispatcher: one `jeff --mode rpc` child per session id.
//
// The driver asks by session id; the dispatcher reuses a live child or spawns
// a new one (resuming the session from --session-dir when it already exists on
// disk, which is how pipeline-resume and fix rounds work).

import fs from "node:fs"
import path from "node:path"
import { buildRoleArgs, childEnv } from "./role-config.mjs"
import { RpcChild } from "./rpc.mjs"

export function defaultSpawn({ command, args, cwd, env, onStderr }) {
  return new RpcChild({ command, args, cwd, env, onStderr }).start()
}

export function createDispatcher({
  config,
  repoRoot,
  targetDir,
  spawnChild = defaultSpawn,
  onChildEvent,
  onStderr,
}) {
  const children = new Map()

  function ensureSessionDir(sessionDir) {
    fs.mkdirSync(sessionDir, { recursive: true })
  }

  function spawnFor(roleKey, sessionId) {
    const role = config.roles[roleKey]
    if (!role) throw new Error(`ocodesa: unknown role "${roleKey}"`)
    const roleFile = path.join(repoRoot, "jeff", "roles", `${role.prompt}.md`)
    if (!fs.existsSync(roleFile)) throw new Error(`ocodesa: missing role prompt ${roleFile}`)
    const guardDir = path.join(repoRoot, "jeff", "role-guard")
    if (!fs.existsSync(path.join(guardDir, "index.ts"))) {
      throw new Error(`ocodesa: missing role guard extension ${guardDir}`)
    }
    const args = buildRoleArgs({ config, roleKey, role, targetDir, repoRoot, sessionId })
    ensureSessionDir(args[args.indexOf("--session-dir") + 1])
    const child = spawnChild({
      command: config.jeff_bin,
      args,
      cwd: targetDir,
      env: childEnv(role),
      onStderr: onStderr ? (text) => onStderr(roleKey, text) : undefined,
    })
    if (onChildEvent) {
      child.onEvent((record) => onChildEvent(roleKey, record))
    }
    return child
  }

  /**
   * Prompts one role session and returns its final assistant text.
   * @returns {Promise<{text: string, sessionId: string, roleKey: string, disposition: string|undefined}>}
   */
  async function dispatch(roleKey, { brief, sessionId, timeoutMs }) {
    let child = children.get(sessionId)
    if (!child || child.dead) {
      if (child) children.delete(sessionId)
      child = spawnFor(roleKey, sessionId)
      children.set(sessionId, child)
    }
    try {
      const { text, disposition } = await child.promptAndWait(brief, { timeoutMs })
      return { text, sessionId, roleKey, disposition }
    } catch (error) {
      await child.stop().catch(() => {})
      children.delete(sessionId)
      throw error
    }
  }

  async function close(sessionId) {
    const child = children.get(sessionId)
    if (!child) return
    children.delete(sessionId)
    await child.stop()
  }

  async function closeAll() {
    const all = [...children.values()]
    children.clear()
    await Promise.all(all.map((child) => child.stop().catch(() => {})))
  }

  return { dispatch, close, closeAll }
}
