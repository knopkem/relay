// Minimal JSONL client for `jeff --mode rpc`.
//
// jeff-code docs/rpc.md: one JSON object per line on stdin/stdout, LF framing
// only (a generic line reader would also split U+2028/U+2029, which are valid
// inside JSON strings); a prompt response only means the prompt was accepted,
// so the driver waits for `agent_settled`. The final assistant text is
// rebuilt from `message_update` text deltas.

import { spawn } from "node:child_process"
import crypto from "node:crypto"

export const DEFAULT_PROMPT_TIMEOUT_MS = 60 * 60 * 1000

class RpcTimeoutError extends Error {}

function withTimeout(promise, timeoutMs, message) {
  if (!timeoutMs) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RpcTimeoutError(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export class RpcChild {
  /**
   * @param {{command: string, args?: string[], cwd?: string, env?: object, onStderr?: (text: string) => void}} options
   */
  constructor({ command, args = [], cwd, env, onStderr }) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.onStderr = onStderr
    this.child = null
    this.buffer = ""
    this.dead = false
    this.exitInfo = null
    this.pending = new Map()
    this.settleWaiters = []
    this.listeners = new Set()
    this.lastText = ""
    this.lastMessageId = null
    this.started = false
  }

  start() {
    if (this.started) return this
    this.started = true
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk) => this.feed(chunk))
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk) => this.onStderr?.(chunk))
    this.child.on("error", (error) => this.failAll(error))
    this.child.on("exit", (code, signal) => {
      this.dead = true
      this.exitInfo = { code, signal }
      this.failAll(new Error(`jeff rpc child exited (code ${code}, signal ${signal})`))
      for (const resolve of this.settleWaiters.splice(0)) resolve()
    })
    return this
  }

  /** Feeds a stdout chunk; splits on LF only and parses each complete record. */
  feed(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf("\n")
    while (index !== -1) {
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      if (line !== "") this.handleLine(line)
      index = this.buffer.indexOf("\n")
    }
  }

  handleLine(line) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      return
    }
    if (record === null || typeof record !== "object") return
    if (record.type === "response" && record.id !== undefined) {
      const pending = this.pending.get(record.id)
      if (pending) {
        this.pending.delete(record.id)
        if (record.success === false) pending.reject(new Error(record.error ?? "jeff rpc command failed"))
        else pending.resolve(record.data ?? {})
      }
      return
    }
    if (record.type === "message_start" && record.message?.role === "assistant") {
      this.lastText = ""
      this.lastMessageId = record.message.id ?? null
    }
    if (record.type === "message_update") {
      const event = record.assistantMessageEvent
      const id = record.message?.id ?? this.lastMessageId
      if (id !== null && id !== this.lastMessageId) {
        this.lastText = ""
        this.lastMessageId = id
      }
      if (event?.type === "text_delta" && typeof event.delta === "string") {
        this.lastText += event.delta
      }
    }
    if (record.type === "agent_settled") {
      for (const resolve of this.settleWaiters.splice(0)) resolve()
    }
    for (const listener of this.listeners) listener(record)
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resolves after the next `agent_settled` (or when the child exits). */
  waitSettled() {
    if (this.dead) return Promise.resolve()
    return new Promise((resolve) => this.settleWaiters.push(resolve))
  }

  /** Sends one command and resolves with its response data. */
  request(command, { timeoutMs = 30_000 } = {}) {
    if (this.dead) return Promise.reject(new Error("jeff rpc child is not running"))
    const id = command.id ?? `r-${crypto.randomUUID()}`
    const body = JSON.stringify({ ...command, id })
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    try {
      this.child.stdin.write(`${body}\n`)
    } catch (error) {
      this.pending.delete(id)
      return Promise.reject(error)
    }
    return withTimeout(promise, timeoutMs, `jeff rpc command ${command.type} timed out`)
  }

  /** Asks jeff-code to stop the active run. */
  abort() {
    if (this.dead) return
    this.child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`)
  }

  /**
   * Sends a prompt and waits for the run to settle.
   * @returns {Promise<{text: string, disposition: string|undefined}>}
   */
  async promptAndWait(text, { timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS } = {}) {
    const settled = this.waitSettled()
    const data = await this.request({ type: "prompt", message: text })
    const disposition = data?.disposition
    if (disposition === "handled") return { text: this.lastText, disposition }
    await withTimeout(settled, timeoutMs, `jeff rpc prompt did not settle within ${Math.round(timeoutMs / 1000)}s`)
    return { text: this.lastText, disposition }
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  /** Closes stdin for an orderly shutdown, then kills after a grace period. */
  async stop({ timeoutMs = 3000 } = {}) {
    if (!this.child) return
    const child = this.child
    if (!this.dead) {
      try {
        child.stdin.end()
      } catch {}
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!this.dead) child.kill("SIGKILL")
          resolve()
        }, timeoutMs)
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    this.dead = true
    this.child = null
  }
}
