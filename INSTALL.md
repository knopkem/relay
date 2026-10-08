# Installing

Model IDs stay out of the repo: agent files carry placeholders
(`__ORCHESTRATOR_MODEL__`, `__PLANNER_MODEL__`, `__VERIFIER_MODEL__`,
`__IMPLEMENTER_MODEL__`, `__REVIEWER_MODEL__`, `# __<ROLE>_OPTIONS__`) that
`scripts/set-models.py` resolves from gitignored `models.local.json` into
gitignored `agent.local/`.

## Scripted install (recommended)

```bash
cd ocodesa
./scripts/install.sh
```

The script renders the agents (running `set-models.py` for you if
`models.local.json` is missing), links `command/`, and links every
`plugins/*.js` into `~/.config/opencode/plugins/`. It is idempotent, never
overwrites real files, prunes only symlinks it owns, and accepts `--dry-run`.
Restart OpenCode afterwards.

`set-models.py` prompts for `planner`, `implementer`, then `orchestrator`
(default: planner), `verifier` (default: planner), `watcher` (default:
verifier) and `reviewer` (default: verifier), then for each role thinking
(`on`/`off`) and — when on — the effort level. Defaults:
planner/verifier/watcher/reviewer think at `medium`, implementer and
orchestrator think off at `none`. It saves your selection, renders
`agent.local/`, and points `~/.config/opencode/agent` at it — replacing any
existing symlink. If you previously installed opencode-subagents, this script
leaves its plugin alone; remove that symlink yourself if its process gate
blocks the pipeline.

Flags: `--list`, `--render`, `--force`, `--no-link`, role flags
`--orchestrator M --planner M --verifier M --implementer M --watcher M
--reviewer M`, the shorthand `PLANNER IMPLEMENTER`, and per-role reasoning
controls `--<role>-think on|off` and
`--<role>-effort none|low|medium|high|xhigh` (thinking off forces effort
`none`; an effort flag also sets thinking on/off). `--think` / `--no-think`
remain implementer aliases.

## Manual install

Copy `agent/*.md`, replace the model placeholders and the
`# __<ROLE>_OPTIONS__` markers by hand (a block of `reasoningEffort:` plus
`chat_template_kwargs: enable_thinking:`), and place the result in
`~/.config/opencode/agent/`; copy `command/*.md` to
`~/.config/opencode/command/` and `plugins/*.js` plus `plugins/lib/` to
`~/.config/opencode/plugins/`.

## Keep the pipeline out of build/plan

OpenCode lists every installed subagent whose `task` permission is not denied
to the calling agent in the `task` tool description. The rendered `planner`,
`implementer`, `verifier`, `watcher` and `reviewer` are therefore visible to
ordinary `build` and `plan` sessions, and a strong model may dispatch the
pipeline on its own. Deny `task` for those five names in both agents in your
global `opencode.jsonc` (merge with your existing `build`/`plan` blocks);
OpenCode then drops them from the task description and the pipeline only
starts via `/pipeline`:

```jsonc
"agent": {
  "build": { "permission": { "task": { "*": "allow", "planner": "deny", "implementer": "deny", "verifier": "deny", "watcher": "deny", "reviewer": "deny" } } },
  "plan":  { "permission": { "task": { "*": "allow", "planner": "deny", "implementer": "deny", "verifier": "deny", "watcher": "deny", "reviewer": "deny" } } }
}
```

The orchestrator keeps its own allow-list, so `/pipeline` is unaffected.
`hidden: true` on the subagents does not help: hidden agents remain invocable
via the task tool.

## Applying model changes

```bash
python3 scripts/set-models.py --render            # after editing models.local.json
python3 scripts/set-models.py --orchestrator M    # change one role, re-render
python3 scripts/set-models.py --verifier-think on --verifier-effort high
```

## Using it

OpenCode anchors the project at the nearest `.git`/`package.json` upward, so
start opencode in the project root. Then run:

```
/pipeline <task>     # or just /pipeline to use the brief in TASK.md
```

The orchestrator drives planner → implementer → verifier and reports. With no
argument and no `TASK.md`, it stops and asks for a task.

Parallel supervision is on by default once the `watcher` agent is rendered;
set `OCODESA_SUPERVISE=off` to disable, `advisory` for canned nudges only,
`pull` for the ask tool without escalation or prereview, and
`OCODESA_SUPERVISE_DEBUG=1` to log supervision events to
`.ocodesa/supervise.jsonl` in the target project.

Milestone review is on by default once the `reviewer` agent is rendered:
the implementer calls `milestone_done` at each milestone boundary and a
read-only reviewer inspects a frozen snapshot. `OCODESA_MILESTONE=off`
disables it, `serial` forces inline reviews, `review` prefers background
reviews, and `auto` (default) picks serial when the reviewer shares the
implementer's provider. `OCODESA_PLAN=jit` additionally lets a background
planner write `MILESTONES/<id>.md` detail docs when planner and implementer
use different providers. Details: [docs/milestone-review.md](docs/milestone-review.md).
