import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import {
  ALL_TOOLS,
  buildRoleArgs,
  childEnv,
  configPath,
  DEFAULT_CONFIG,
  loadConfig,
  mergeConfig,
  READ_ONLY_TOOLS,
  validateConfig,
} from "../ocodesa/role-config.mjs"

function fullConfig(overrides = {}) {
  const roles = {
    planner: { model: "p/m" },
    implementer: { model: "s/m" },
    verifier: { model: "p/m" },
    audit: { model: "p/m" },
  }
  for (const [key, value] of Object.entries(overrides.roles ?? {})) {
    roles[key] = { ...(roles[key] ?? {}), ...value }
  }
  return mergeConfig(Object.fromEntries([...Object.entries(overrides).filter(([key]) => key !== "roles"), ["roles", roles]]))
}

test("defaults are complete", () => {
  const config = mergeConfig()
  assert.equal(config.round_cap, 5)
  assert.equal(config.quick_max_lines, 5)
  assert.equal(config.jeff_bin, "jeff")
  assert.deepEqual(config.roles.audit.tools, READ_ONLY_TOOLS)
  assert.deepEqual(config.roles.implementer.tools, ALL_TOOLS)
  assert.deepEqual(config.roles.planner.tools, ["read", "grep", "find", "ls", "write"])
  assert.equal(config.roles.audit.env.JEFF_FIRST_RUN_APPROVAL, "never")
  assert.equal(DEFAULT_CONFIG.roles.verifier.prompt, "verifier")
  assert.equal(DEFAULT_CONFIG.roles.audit.prompt, "verifier")
})

test("raw roles merge over defaults", () => {
  const config = mergeConfig({
    round_cap: 3,
    roles: { planner: { model: "splash/m", tools: ["read"], thinking: "medium" } },
  })
  assert.equal(config.round_cap, 3)
  assert.equal(config.roles.planner.model, "splash/m")
  assert.deepEqual(config.roles.planner.tools, ["read"])
  assert.equal(config.roles.planner.guard, "planner")
  assert.equal(config.roles.verifier.thinking, "off")
})

test("validation accepts a full config and rejects broken ones", () => {
  assert.doesNotThrow(() => validateConfig(fullConfig()))
  assert.throws(() => validateConfig({ ...fullConfig(), round_cap: 0 }), /round_cap/)
  const missing = mergeConfig({ roles: { planner: { model: "p/m" } } })
  assert.throws(() => validateConfig(missing), /model is missing/)
  assert.throws(() => validateConfig(fullConfig({ roles: { audit: { thinking: "wild" } } })), /thinking/)
  assert.throws(() => validateConfig(fullConfig({ roles: { audit: { tools: ["read", "teleport"] } } })), /unknown tool/)
})

test("loadConfig explains a missing render", () => {
  assert.throws(() => loadConfig("/nonexistent-repo"), /set-models\.py/)
  assert.equal(configPath("/repo"), path.join("/repo", "jeff", "config.local.json"))
})

test("buildRoleArgs", () => {
  const config = validateConfig(fullConfig({ roles: { planner: { model: "splash/27b" } } }))
  const args = buildRoleArgs({
    config,
    roleKey: "planner",
    role: config.roles.planner,
    targetDir: "/tmp/proj",
    repoRoot: "/repo",
    sessionId: "oc-abcd-planner-1",
  })
  assert.deepEqual(args, [
    "--mode",
    "rpc",
    "--session-dir",
    "/tmp/proj/.ocodesa/sessions",
    "--session-id",
    "oc-abcd-planner-1",
    "--name",
    "ocodesa-planner",
    "--model",
    "splash/27b",
    "--thinking",
    "low",
    "--tools",
    "read,grep,find,ls,write",
    "--no-extensions",
    "--extension",
    "/repo/jeff/role-guard",
    "--no-skills",
    "--no-prompt-templates",
    "--append-system-prompt",
    "/repo/jeff/roles/planner.md",
  ])
})

test("audit role uses the verifier prompt and its own guard", () => {
  const config = validateConfig(fullConfig())
  const args = buildRoleArgs({
    config,
    roleKey: "audit",
    role: config.roles.audit,
    targetDir: "/tmp/proj",
    repoRoot: "/repo",
    sessionId: "oc-abcd-audit-1",
  })
  assert.match(args.join(" "), /--thinking off /)
  assert.match(args.join(" "), /--tools read,grep,find,ls /)
  assert.match(args.join(" "), /--append-system-prompt \/repo\/jeff\/roles\/verifier\.md/)
})

test("childEnv sets the guard role and role env", () => {
  const config = validateConfig(fullConfig())
  const env = childEnv(config.roles.audit, { HOME: "/h" })
  assert.equal(env.OCODESA_ROLE, "audit")
  assert.equal(env.JEFF_FIRST_RUN_APPROVAL, "never")
  assert.equal(env.HOME, "/h")
})
