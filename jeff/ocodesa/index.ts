// ocodesa pipeline extension for jeff-code.
//
// Registers /pipeline, /pipeline-quick, /pipeline-status and /pipeline-resume.
// The handler drives the state machine in driver.mjs with `jeff --mode rpc`
// children (dispatcher.mjs); no model routes anything.
//
// Load with: jeff --extension <repo>/jeff/ocodesa
// (scripts/run-ocodesa.sh exports the JEFF_FIRST_* settings first).

import fs from "node:fs"
import path from "node:path"
import { drive, validateRun } from "./driver.mjs"
import { createDispatcher } from "./dispatcher.mjs"
import { loadConfig, resolveRepoRoot } from "./role-config.mjs"
import { formatSummary, readState } from "./state.mjs"

const LOCK_STALE_MS = 2 * 60 * 60 * 1000
const activeRuns = new Map()
const liveDispatchers = new Set()

function sweepLocks() {
  const cutoff = Date.now() - LOCK_STALE_MS
  for (const [directory, startedAt] of activeRuns) {
    if (startedAt < cutoff) activeRuns.delete(directory)
  }
}

function acquireLock(directory) {
  sweepLocks()
  if (activeRuns.has(directory)) return false
  activeRuns.set(directory, Date.now())
  return true
}

function releaseLock(directory) {
  activeRuns.delete(directory)
}

function phaseLabel(state) {
  return `pipeline: ${state.phase}${state.round > 0 ? ` r${state.round}` : ""}`
}

async function runPipeline(pi, ctx, { quick, task, state }) {
  const directory = ctx.cwd
  let config
  try {
    config = loadConfig(resolveRepoRoot())
  } catch (error) {
    ctx.ui.notify(`ocodesa: ${error.message}`, "error")
    return
  }

  if (!state) {
    const failure = validateRun({
      directory,
      quick,
      task,
      quickMaxLines: config.quick_max_lines,
    })
    if (failure) {
      ctx.ui.notify(failure, "error")
      return
    }
  }

  if (!acquireLock(directory)) {
    ctx.ui.notify(`ocodesa: pipeline already running in ${directory}`, "warning")
    return
  }

  const dispatcher = createDispatcher({ config, repoRoot: resolveRepoRoot(), targetDir: directory })
  liveDispatchers.add(dispatcher)
  let lastLabel = ""
  const onPhase = async (current) => {
    const label = phaseLabel(current)
    if (label === lastLabel) return
    lastLabel = label
    ctx.ui.setStatus("ocodesa", label)
    if (ctx.hasUI) ctx.ui.notify(label, "info")
  }

  try {
    const finalState = await drive({
      directory,
      quick: Boolean(quick),
      task: task ?? null,
      state,
      config,
      dispatcher,
      signal: ctx.signal,
      onPhase,
    })
    const summary = formatSummary(finalState, directory)
    ctx.ui.notify(summary, finalState.status === "done" ? "info" : "warning")
    pi.appendEntry("ocodesa-state", finalState)
  } catch (error) {
    ctx.ui.notify(`ocodesa: ${error instanceof Error ? error.message : String(error)}`, "error")
  } finally {
    ctx.ui.setStatus("ocodesa", undefined)
    liveDispatchers.delete(dispatcher)
    await dispatcher.closeAll()
    releaseLock(directory)
  }
}

function statusReport(directory) {
  const state = readState(directory)
  if (!state) return `no pipeline run recorded in ${directory}`
  const live = activeRuns.has(directory)
  return [live ? "pipeline running (this process)" : "pipeline stopped", formatSummary(state, directory)].join("\n")
}

export default function (pi) {
  pi.registerCommand("pipeline", {
    description: "Plan → implement → verify → audit pipeline (brief in TASK.md)",
    handler: async (_args, ctx) => {
      await runPipeline(pi, ctx, { quick: false })
    },
  })

  pi.registerCommand("pipeline-quick", {
    description: "Same pipeline for an inline brief (at most 5 lines)",
    handler: async (args, ctx) => {
      await runPipeline(pi, ctx, { quick: true, task: args })
    },
  })

  pi.registerCommand("pipeline-status", {
    description: "Show the last pipeline run in this directory",
    handler: async (_args, ctx) => {
      ctx.ui.notify(statusReport(ctx.cwd), "info")
    },
  })

  pi.registerCommand("pipeline-resume", {
    description: "Continue a stopped pipeline run in this directory",
    handler: async (_args, ctx) => {
      const state = readState(ctx.cwd)
      if (!state) {
        ctx.ui.notify(`ocodesa: no pipeline run to resume in ${ctx.cwd}`, "warning")
        return
      }
      if (state.status === "done") {
        ctx.ui.notify("ocodesa: pipeline already done; start a new run", "info")
        return
      }
      if (activeRuns.has(ctx.cwd)) {
        ctx.ui.notify(`ocodesa: pipeline already running in ${ctx.cwd}`, "warning")
        return
      }
      if (state.phase !== "plan" && !fs.existsSync(path.join(ctx.cwd, "PLAN.md"))) {
        ctx.ui.notify("ocodesa: cannot resume: PLAN.md is missing; start a new run", "error")
        return
      }
      await runPipeline(pi, ctx, { quick: Boolean(state.quick), task: state.task, state })
    },
  })

  pi.on("session_shutdown", async () => {
    const dispatchers = [...liveDispatchers]
    liveDispatchers.clear()
    await Promise.all(dispatchers.map((dispatcher) => dispatcher.closeAll().catch(() => {})))
  })
}
