import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { RpcChild } from "../ocodesa/rpc.mjs"

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-jeff.mjs", import.meta.url))

function child(replies, extraEnv = {}) {
  return new RpcChild({
    command: process.execPath,
    args: [FIXTURE],
    cwd: process.cwd(),
    env: {
      ...process.env,
      FAKE_REPLIES: JSON.stringify(replies),
      ...extraEnv,
    },
  }).start()
}

test("promptAndWait reassembles text deltas", async () => {
  const rpc = child([["PLAN", ": ok\n"]])
  try {
    const { text, disposition } = await rpc.promptAndWait("hello", { timeoutMs: 10_000 })
    assert.equal(disposition, "started")
    assert.equal(text, "PLAN: ok\n")
  } finally {
    await rpc.stop()
  }
})

test("framing does not split on U+2028 or U+2029 inside strings", async () => {
  const line = 'IMPL: ok\n'
  const rpc = child([[`before\u2028middle\u2029${line}`, line]])
  try {
    const { text } = await rpc.promptAndWait("x", { timeoutMs: 10_000 })
    assert.equal(text, `before\u2028middle\u2029${line}${line}`)
  } finally {
    await rpc.stop()
  }
})

test("sequential prompts advance the script", async () => {
  const rpc = child([["one\n"], ["two\n"]])
  try {
    assert.equal((await rpc.promptAndWait("a", { timeoutMs: 10_000 })).text, "one\n")
    assert.equal((await rpc.promptAndWait("b", { timeoutMs: 10_000 })).text, "two\n")
  } finally {
    await rpc.stop()
  }
})

test("a failed prompt response rejects", async () => {
  const rpc = child([["never\n"]], { FAKE_FAIL_PROMPT_INDEX: "0" })
  try {
    await assert.rejects(rpc.promptAndWait("x", { timeoutMs: 10_000 }), /fake provider failure/)
  } finally {
    await rpc.stop()
  }
})

test("stop closes the child", async () => {
  const rpc = child([["x\n"]])
  await rpc.promptAndWait("x", { timeoutMs: 10_000 })
  await rpc.stop()
  assert.equal(rpc.dead, true)
})

test("a dead child rejects further prompts", async () => {
  const rpc = child([["x\n"]])
  await rpc.stop()
  await assert.rejects(rpc.promptAndWait("x", { timeoutMs: 1000 }), /not running/)
})
