// Role configuration for the ocodesa pipeline on jeff-code.
//
// scripts/set-models.py renders jeff/config.local.json from models.local.json
// (same picker as the OpenCode agents). This module merges it with defaults,
// validates it, and builds the `jeff --mode rpc` command line for each role.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

export const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"]
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"]

export const ROLE_KEYS = ["planner", "implementer", "verifier", "audit"]

export const DEFAULT_CONFIG = {
  jeff_bin: "jeff",
  round_cap: 5,
  quick_max_lines: 5,
  state_dir: ".ocodesa",
  session_dir: ".ocodesa/sessions",
  trace_file: "",
  roles: {
    planner: {
      model: "",
      thinking: "low",
      tools: ["read", "grep", "find", "ls", "write"],
      guard: "planner",
      prompt: "planner",
      env: {},
    },
    implementer: {
      model: "",
      thinking: "off",
      tools: [...ALL_TOOLS],
      guard: "implementer",
      prompt: "implementer",
      env: {},
    },
    verifier: {
      model: "",
      thinking: "off",
      tools: [...ALL_TOOLS],
      guard: "verifier",
      prompt: "verifier",
      env: {},
    },
    audit: {
      model: "",
      thinking: "off",
      tools: [...READ_ONLY_TOOLS],
      guard: "audit",
      prompt: "verifier",
      env: { JEFF_FIRST_RUN_APPROVAL: "never" },
    },
  },
}

export function resolveRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
}

export function configPath(repoRoot) {
  return path.join(repoRoot, "jeff", "config.local.json")
}

/** Shallow-merge a raw role over a default role; env objects merge key-wise. */
function mergeRole(base, raw) {
  return {
    ...base,
    ...(raw ?? {}),
    tools: Array.isArray(raw?.tools) ? [...raw.tools] : [...base.tools],
    env: { ...base.env, ...(raw?.env ?? {}) },
  }
}

export function mergeConfig(raw = {}) {
  const roles = {}
  for (const key of ROLE_KEYS) roles[key] = mergeRole(DEFAULT_CONFIG.roles[key], raw.roles?.[key])
  return { ...DEFAULT_CONFIG, ...raw, roles }
}

export function validateConfig(config) {
  if (!Number.isInteger(config.round_cap) || config.round_cap < 1) {
    throw new Error("ocodesa config: round_cap must be a positive whole number")
  }
  if (!Number.isInteger(config.quick_max_lines) || config.quick_max_lines < 1) {
    throw new Error("ocodesa config: quick_max_lines must be a positive whole number")
  }
  if (typeof config.jeff_bin !== "string" || config.jeff_bin === "") {
    throw new Error("ocodesa config: jeff_bin must be the jeff executable path or name")
  }
  for (const key of ROLE_KEYS) {
    const role = config.roles[key]
    if (!role.model) throw new Error(`ocodesa config: roles.${key}.model is missing; run python3 scripts/set-models.py`)
    if (!THINKING_LEVELS.includes(role.thinking)) {
      throw new Error(`ocodesa config: roles.${key}.thinking must be one of ${THINKING_LEVELS.join(", ")}`)
    }
    if (!Array.isArray(role.tools) || role.tools.length === 0) {
      throw new Error(`ocodesa config: roles.${key}.tools must be a non-empty list`)
    }
    for (const tool of role.tools) {
      if (!ALL_TOOLS.includes(tool)) {
        throw new Error(`ocodesa config: roles.${key}.tools has unknown tool "${tool}"`)
      }
    }
  }
  return config
}

export function loadConfig(repoRoot) {
  const file = configPath(repoRoot)
  if (!fs.existsSync(file)) {
    throw new Error(`ocodesa: ${file} is missing; run python3 scripts/set-models.py`)
  }
  return validateConfig(mergeConfig(JSON.parse(fs.readFileSync(file, "utf8"))))
}

/** The environment for a role child: inherits the host's Jeff settings. */
export function childEnv(role, baseEnv = process.env) {
  return { ...baseEnv, OCODESA_ROLE: role.guard, ...role.env }
}

/**
 * The `jeff` command line for one role session. Sessions live inside the
 * target so the pipeline is self-contained and resumable.
 */
export function buildRoleArgs({ config, roleKey, role, targetDir, repoRoot, sessionId }) {
  const guardDir = path.join(repoRoot, "jeff", "role-guard")
  const roleFile = path.join(repoRoot, "jeff", "roles", `${role.prompt}.md`)
  const sessionDir = path.isAbsolute(config.session_dir)
    ? config.session_dir
    : path.join(targetDir, config.session_dir)
  return [
    "--mode",
    "rpc",
    "--session-dir",
    sessionDir,
    "--session-id",
    sessionId,
    "--name",
    `ocodesa-${roleKey}`,
    "--model",
    role.model,
    "--thinking",
    role.thinking,
    "--tools",
    role.tools.join(","),
    "--no-extensions",
    "--extension",
    guardDir,
    "--no-skills",
    "--no-prompt-templates",
    "--append-system-prompt",
    roleFile,
  ]
}
