import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createDispatcher } from "../ocodesa/dispatcher.mjs"
import { mergeConfig, resolveRepoRoot, validateConfig } from "../ocodesa/role-config.mjs"
import { RpcChild } from "../ocodesa/rpc.mjs"

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-jeff.mjs", import.meta.url))

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocodesa-dispatch-"))
}

function config() {
  return validateConfig(
    mergeConfig({
      roles: {
        planner: { model: "p/m" },
        implementer: { model: "i/m" },
        verifier: { model: "v/m" },
        audit: { model: "v/m" },
      },
    }),
  )
}

function fixtureSpawn(script) {
  const spawned = []
  const spawnChild = ({ args, cwd, env }) => {
    spawned.push({ args, cwd, env })
    return new RpcChild({
      command: process.execPath,
      args: [FIXTURE],
      cwd,
      env: { ...env, FAKE_REPLIES: JSON.stringify(script) },
    }).start()
  }
  return { spawned, spawnChild }
}

test("dispatcher reuses a live session child and spawns a new one after close", async () => {
  const dir = tempDir()
  const { spawned, spawnChild } = fixtureSpawn([["PLAN: ok\n"], ["PLAN: ok\n"]])
  const dispatcher = createDispatcher({
    config: config(),
    repoRoot: resolveRepoRoot(),
    targetDir: dir,
    spawnChild,
  })
  try {
    const first = await dispatcher.dispatch("planner", { brief: "a", sessionId: "oc-t-planner-1" })
    assert.equal(first.text, "PLAN: ok\n")
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].env.OCODESA_ROLE, "planner")
    const sessionFlag = spawned[0].args.indexOf("--session-id")
    assert.equal(spawned[0].args[sessionFlag + 1], "oc-t-planner-1")
    assert.ok(fs.existsSync(path.join(dir, ".ocodesa", "sessions")))

    await dispatcher.dispatch("planner", { brief: "b", sessionId: "oc-t-planner-1" })
    assert.equal(spawned.length, 1, "the live child is reused")

    await dispatcher.close("oc-t-planner-1")
    await dispatcher.dispatch("planner", { brief: "c", sessionId: "oc-t-planner-1" })
    assert.equal(spawned.length, 2, "a closed session respawns")
  } finally {
    await dispatcher.closeAll()
  }
})

test("dispatcher fails before spawning when the role prompt is missing", async () => {
  const dir = tempDir()
  const { spawned, spawnChild } = fixtureSpawn([["PLAN: ok\n"]])
  const dispatcher = createDispatcher({
    config: config(),
    repoRoot: path.join(dir, "no-repo"),
    targetDir: dir,
    spawnChild,
  })
  await assert.rejects(dispatcher.dispatch("planner", { brief: "a", sessionId: "s1" }), /missing role prompt/)
  assert.equal(spawned.length, 0)
})
