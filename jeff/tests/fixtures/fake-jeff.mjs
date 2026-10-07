#!/usr/bin/env node
// Fake `jeff --mode rpc` child for rpc.test.mjs.
//
// Speaks the subset of the RPC protocol the driver uses: prompt/response
// correlation, assistant message streaming with text_delta, agent_settled,
// get_last_assistant_text, abort, and error responses.
//
// FAKE_REPLIES: JSON array, one entry per prompt; each entry is an array of
// text chunks (or a string). FAKE_FAIL_PROMPT_INDEX: fail that prompt.

const replies = JSON.parse(process.env.FAKE_REPLIES ?? '[["IMPL: ok\\n"]]')
const failIndex = process.env.FAKE_FAIL_PROMPT_INDEX
let index = 0
let lastText = ""
let buffer = ""

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

function handle(line) {
  let command
  try {
    command = JSON.parse(line)
  } catch {
    send({ type: "response", command: "parse", success: false, error: "bad json" })
    return
  }
  if (command.type === "prompt") {
    if (failIndex !== undefined && Number(failIndex) === index) {
      index += 1
      send({ id: command.id, type: "response", command: "prompt", success: false, error: "fake provider failure" })
      return
    }
    const reply = replies[index] ?? ["IMPL: ok\n"]
    index += 1
    send({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } })
    const messageId = `m${index}`
    const message = { id: messageId, role: "assistant" }
    send({ type: "message_start", message })
    lastText = ""
    for (const delta of reply) {
      lastText += delta
      send({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta } })
    }
    send({ type: "message_end", message })
    send({ type: "agent_settled" })
    return
  }
  if (command.type === "get_last_assistant_text") {
    send({ id: command.id, type: "response", command: command.type, success: true, data: { text: lastText } })
    return
  }
  if (command.type === "abort") {
    send({ type: "agent_settled" })
    return
  }
  send({ id: command.id, type: "response", command: command.type, success: false, error: `unknown command ${command.type}` })
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at = buffer.indexOf("\n")
  while (at !== -1) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() !== "") handle(line)
    at = buffer.indexOf("\n")
  }
})
process.stdin.on("end", () => process.exit(0))
