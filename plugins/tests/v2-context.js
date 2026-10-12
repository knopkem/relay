export function createV2Context({
  directory = process.cwd(),
  agents = [],
  sessionInfo,
  assistantText = "Watcher direction",
} = {}) {
  const sessionHooks = new Map()
  const toolHooks = new Map()
  const tools = new Map()
  const calls = { created: [], prompts: [], switches: [], interrupted: [] }
  const stream = eventStream()

  const ctx = {
    location: {
      directory,
      project: { id: "project", directory, canonical: directory },
    },
    session: {
      hook: async (name, callback) => {
        sessionHooks.set(name, callback)
        return { dispose: async () => sessionHooks.delete(name) }
      },
      get: async ({ sessionID }) =>
        sessionInfo?.(sessionID) ?? {
          id: sessionID,
          agent: "implementer",
          location: { directory },
        },
      create: async (input) => {
        calls.created.push(input)
        return {
          id: `ses_watcher_${calls.created.length}`,
          location: input.location ?? { directory },
        }
      },
      switchAgent: async (input) => calls.switches.push(input),
      prompt: async (input, options) => {
        calls.prompts.push({ input, options })
        return { id: `inbox_${calls.prompts.length}` }
      },
      wait: async () => {},
      context: async () => [
        {
          id: "assistant_1",
          type: "assistant",
          content: [{ type: "text", text: assistantText }],
        },
      ],
      interrupt: async (input) => calls.interrupted.push(input),
    },
    tool: {
      hook: async (name, callback) => {
        toolHooks.set(name, callback)
        return { dispose: async () => toolHooks.delete(name) }
      },
      transform: async (callback) =>
        callback({
          add: (tool) => tools.set(tool.name, tool),
          get: (name) => tools.get(name),
          list: () => [...tools.values()],
          update: () => {},
          remove: (name) => tools.delete(name),
          namespace: () => {},
        }),
    },
    event: {
      subscribe: ({ signal } = {}) => {
        if (signal?.aborted) stream.close()
        else signal?.addEventListener("abort", () => stream.close(), { once: true })
        return stream
      },
    },
    agent: {
      list: async () => ({ data: agents }),
    },
  }

  return { ctx, sessionHooks, toolHooks, tools, calls, stream }
}

function eventStream() {
  const values = []
  const waiters = []
  let closed = false

  return {
    get closed() {
      return closed
    },
    push(value) {
      if (closed) throw new Error("cannot emit on a closed event stream")
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else values.push(value)
    },
    close() {
      if (closed) return
      closed = true
      for (const resolve of waiters.splice(0)) resolve({ done: true })
    },
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      if (values.length) return Promise.resolve({ value: values.shift(), done: false })
      if (closed) return Promise.resolve({ done: true })
      return new Promise((resolve) => waiters.push(resolve))
    },
    return() {
      this.close()
      return Promise.resolve({ done: true })
    },
  }
}
