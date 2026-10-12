// Write guard: reroutes bash file writes to a direct write, blocks the rest.
//
// Weak models fall back to `cat > f <<'EOF'` or inline `python3 - <<'PY'`
// when the write/edit tools are awkward, which skips the write tool and
// produces malformed files. This plugin inspects every bash command before
// it runs (language-agnostic: it only reasons about shell shapes, never
// about the project's language):
//   - simple heredoc writes inside the project directory (`cat > f <<'EOF'`,
//     `cat >> f <<'EOF'`, `tee [-a] f <<'EOF'`) are applied directly, and the
//     bash command is replaced with a success note so the shell never runs;
//   - inline interpreter writes (python/node/perl/ruby/php) and in-place
//     editors (`sed -i`, `perl -i`) are rejected with a pointer to the
//     write/edit tools;
//   - writes outside the project directory and unrelated commands are left
//     untouched.
// Disable with RELAY_WRITE_GUARD=off.

import fs from "node:fs"
import path from "node:path"

import { isRelaySession, rememberAgent, withAgentTracking } from "./lib/agent-gate.js"
import {
  defineRelayPlugin,
  registerV2Base,
  resolveSessionDirectory,
} from "./lib/plugin-entrypoint.js"

const INTERPRETER_COMMAND = /^\s*(?:env\s+)?(?:python[0-9.]*|node|perl|ruby|php)\b/
const SCRIPT_WRITER =
  /open\s*\([^)]*['"][wa]\+?['"]|\.write_text\s*\(|\.write_bytes\s*\(|writeFileSync\s*\(|appendFileSync\s*\(|os\.(?:write|pwrite|remove|unlink|rename|replace|makedirs?)\s*\(|shutil\.|pathlib/
const INPLACE_EDITOR = /\b(?:sed|perl)\b[^\n]*(?:-i\b|--in-place\b)/
const HEREDOC = /<<(-?)(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/
const REDIRECT = /(>>?)\s*(?:'([^']+)'|"([^"]+)"|([^\s;|&<>]+))/
const TEE = /^\s*tee\s+(-a\s+)?(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/

function shellQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`
}

function resolveTarget(target, directory, body, append) {
  if (/[$`]/.test(target)) {
    return { kind: "block", reason: "dynamic heredoc target cannot be rerouted" }
  }
  const root = path.resolve(directory ?? process.cwd())
  const file = path.isAbsolute(target) ? path.normalize(target) : path.resolve(root, target)
  if (file !== root && !file.startsWith(root + path.sep)) return null
  return { kind: "write", file, body, append }
}

function planHeredoc(command, directory) {
  const lines = String(command).split("\n")
  const head = lines[0]
  const opener = HEREDOC.exec(head)
  if (!opener) return null

  const dash = opener[1] === "-"
  const marker = opener[2] ?? opener[3] ?? opener[4]
  const quoted = opener[2] !== undefined || opener[3] !== undefined

  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    const line = dash ? lines[i].replace(/^\t+/, "") : lines[i]
    if (line === marker) {
      end = i
      break
    }
  }
  if (end === -1) return { kind: "block", reason: `unterminated heredoc (${marker})` }

  const body = lines
    .slice(1, end)
    .map((line) => (dash ? line.replace(/^\t+/, "") : line))
    .map((line) => `${line}\n`)
    .join("")
  if (!quoted && /[$`\\]/.test(body)) {
    return { kind: "block", reason: "unquoted heredoc with expansions cannot be rerouted safely" }
  }

  const rest = lines.slice(end + 1).join("\n").trim()
  const simple = head.replace(opener[0], " ")
  if (/[;&|]/.test(simple) || rest) {
    return { kind: "block", reason: "compound command around a heredoc write cannot be rerouted safely" }
  }

  if (/^\s*tee\b/.test(simple)) {
    const tee = TEE.exec(simple)
    if (!tee) return { kind: "block", reason: "unsupported tee form around a heredoc write" }
    const target = tee[2] ?? tee[3] ?? tee[4]
    return resolveTarget(target, directory, body, Boolean(tee[1]))
  }

  if (!/^\s*cat\b/.test(simple)) return null
  const redirect = REDIRECT.exec(simple)
  if (!redirect) return null
  if (simple.replace(redirect[0], " ").trim() !== "cat") {
    return { kind: "block", reason: "unsupported cat form around a heredoc write" }
  }
  const target = redirect[2] ?? redirect[3] ?? redirect[4]
  return resolveTarget(target, directory, body, redirect[1] === ">>")
}

function planWrite(command, directory) {
  const text = String(command ?? "")
  if (!text) return null
  if (text.includes("<<")) {
    const heredoc = planHeredoc(text, directory)
    if (heredoc) return heredoc
  }
  const first = text.split("\n")[0]
  if (INTERPRETER_COMMAND.test(first) && SCRIPT_WRITER.test(text)) {
    return { kind: "block", reason: "writing files from an inline interpreter must use the write/edit tools" }
  }
  if (INPLACE_EDITOR.test(text)) {
    return { kind: "block", reason: "in-place edits must use the edit tool" }
  }
  return null
}

const WriteGuard = async ({ directory, directoryForSession } = {}) => {
  if (String(process.env.RELAY_WRITE_GUARD ?? "").toLowerCase() === "off") return {}

  return withAgentTracking({
    "tool.execute.before": async (input, output) => {
      if (!isRelaySession(input?.sessionID)) return
      if (input?.tool !== "bash") return
      const args = output?.args
      if (!args || typeof args.command !== "string") return
      const projectDirectory =
        (await directoryForSession?.(input.sessionID)) ?? directory
      const plan = planWrite(args.command, projectDirectory)
      if (!plan) return
      if (plan.kind === "block") {
        throw new Error(`Write guard: ${plan.reason}. Use the write/edit tool for file changes.`)
      }
      try {
        fs.mkdirSync(path.dirname(plan.file), { recursive: true })
        if (plan.append) fs.appendFileSync(plan.file, plan.body)
        else fs.writeFileSync(plan.file, plan.body)
      } catch (error) {
        throw new Error(
          `Write guard: reroute failed for ${plan.file}: ${error?.message ?? error}. Use the write/edit tool.`,
        )
      }
      const bytes = Buffer.byteLength(plan.body, "utf-8")
      const root = path.resolve(projectDirectory ?? process.cwd())
      const where = path.relative(root, plan.file)
      args.command = `echo ${shellQuote(
        `write guard: wrote ${where} (${bytes} bytes) via the write tool. Do not use bash to write files.`,
      )}`
    },
  })
}

export default defineRelayPlugin({
  id: "relay.write-guard",
  server: WriteGuard,
  setup: async (ctx) => {
    const plugin = await WriteGuard({
      directory: ctx.location.directory,
      directoryForSession: (sessionID) => resolveSessionDirectory(ctx, sessionID),
    })
    return registerV2Base(ctx, plugin, rememberAgent)
  },
})

WriteGuard.__test = { planWrite, planHeredoc, resolveTarget, shellQuote }
