# Installing

Model IDs stay out of the repo: agent files carry placeholders
(`__ORCHESTRATOR_MODEL__`, `__PLANNER_MODEL__`, `__VERIFIER_MODEL__`,
`__IMPLEMENTER_MODEL__`, `# __IMPLEMENTER_OPTIONS__`,
`# __PLANNER_OPTIONS__`) that `scripts/set-models.py` resolves from gitignored
`models.local.json` into gitignored `agent.local/`.

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
(default: planner), `verifier` (default: planner) and `watcher` (default:
verifier); it saves your selection, renders `agent.local/`, and points
`~/.config/opencode/agent` at it — replacing any existing symlink. If you
previously installed opencode-subagents, this script leaves its plugin alone;
remove that symlink yourself if its process gate blocks the pipeline.

Flags: `--list`, `--render`, `--force`, `--think` / `--no-think` (implementer
reasoning; off by default), `--planner-effort none|low|medium|high|xhigh`
(planner reasoning; default low), `--no-link`, role flags
`--orchestrator M --planner M --verifier M --implementer M`, or the shorthand
`PLANNER IMPLEMENTER`.

## Manual install

Copy `agent/*.md`, replace the four model placeholders and the
`# __IMPLEMENTER_OPTIONS__` / `# __PLANNER_OPTIONS__` markers by hand, and
place the result in `~/.config/opencode/agent/`; copy `command/*.md` to
`~/.config/opencode/command/` and `plugins/*.js` to
`~/.config/opencode/plugins/`.

## Applying model changes

```bash
python3 scripts/set-models.py --render            # after editing models.local.json
python3 scripts/set-models.py --orchestrator M    # change one role, re-render
python3 scripts/set-models.py --think             # implementer keeps reasoning
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
set `OCODESA_SUPERVISE=off` to disable, `advisory` for canned nudges only, and
`OCODESA_SUPERVISE_DEBUG=1` to log supervision events to
`.ocodesa/supervise.jsonl` in the target project.
