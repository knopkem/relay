# Installing

Two runtimes are supported: the primary **jeff-code** pipeline
(`docs/jeff-runtime-port.md`) and the legacy **OpenCode** pipeline. Both read
the same gitignored `models.local.json`, rendered by `scripts/set-models.py`:
jeff-code into `jeff/config.local.json`, OpenCode into `agent.local/` with the
four model placeholders resolved.

## jeff-code runtime (recommended)

### 1. Jeff decision server

```bash
git clone https://github.com/firelex/jeff ~/projects/jeff
cd ~/projects/jeff
uv sync --no-default-groups --extra lora --extra mac     # MLX on Apple Silicon
uv run --no-default-groups hf download mstrasser/jeff-base --revision v1.3 --local-dir jeff-base-v1.3
uv run --no-default-groups hf download mstrasser/jeff-adapter-code --revision v1.3 --local-dir adapters/jeff-step
uv run --no-default-groups hf download mstrasser/jeff-adapter-code-router --revision v1.3 --local-dir adapters/jeff-router
```

Start it with `JEFF_HOME=~/projects/jeff JEFF_CODE_HOME=~/projects/jeff-code
./scripts/start-jeff.sh` (adds the `/v1/fit` endpoint the scout needs, MLX
backend by default, port 8920). A GPU box can host it instead with
`JEFF_BACKEND`/`JEFF_DEVICE`; PyTorch CPU is the last resort at seconds per
decision.

### 2. jeff-code

```bash
git clone https://github.com/firelex/jeff-code ~/projects/jeff-code
cd ~/projects/jeff-code && npm install && npm run build
```

Add both Qwen endpoints to `~/.jeff/agent/models.json` (see jeff-code's
`docs/models.md`), for example `splash` → `http://192.168.10.112:8000/v1` and
`strata` → `http://192.168.10.136:8080/v1`, each model with
`"reasoning": true`, `"compat": { "thinkingFormat": "qwen-chat-template" }` and
`"maxTokens": 32768`.

### 3. ocodesa

```bash
cd ocodesa
python3 scripts/set-models.py          # prompts for planner, implementer, etc.
./scripts/run-ocodesa.sh               # exports JEFF_FIRST_* and starts jeff
```

The first run of `set-models.py` prompts for `planner`, `implementer`, then
`orchestrator` (default: planner) and `verifier` (default: planner); the same
selection renders the jeff-code roles. Flags: `--list`, `--render`, `--force`,
`--think` / `--no-think` (implementer reasoning), `--planner-effort
none|low|medium|high`, role flags `--planner M --implementer M --verifier M
--orchestrator M`, or the shorthand `PLANNER IMPLEMENTER`. `--render` no
longer needs `opencode` on PATH; only the interactive picker and validation do.

### 4. Use it

Open jeff-code in the target project and run:

```
echo "build a minesweeper clone in rust using macroquad" > TASK.md
/pipeline
```

or `/pipeline-quick fix the typo in foo` for a short task; never paste a large
plan into the command line. `/pipeline-status` reports the last run and
`/pipeline-resume` continues a stopped one. `JEFF_FIRST_MODE=off
./scripts/run-ocodesa.sh` starts the same pipeline without the scout and
router (the baseline for comparisons).

## Legacy OpenCode runtime

The original agents, commands and plugins remain in the repo. Install:

```bash
python3 scripts/set-models.py
ln -sfn "$PWD/command" ~/.config/opencode/command
mkdir -p ~/.config/opencode/plugins
# remove old plugin symlinks (opencode-subagents' process-gate would block this pipeline)
find ~/.config/opencode/plugins -maxdepth 1 -name '*.js' -type l -delete
ln -sf "$PWD/plugins/"*.js ~/.config/opencode/plugins/
```

`set-models.py` saves your selection, renders `agent.local/`, and points
`~/.config/opencode/agent` at it (replacing any existing symlink). Manual
install: copy `agent/*.md`, replace the four model placeholders and the
`# __IMPLEMENTER_OPTIONS__` marker, then place the result in
`~/.config/opencode/agent/`; copy `command/pipeline.md` to
`~/.config/opencode/command/` and `plugins/*.js` to
`~/.config/opencode/plugins/`.

Applying model changes: `python3 scripts/set-models.py --render`,
`--orchestrator M`, `--think`, `--planner-effort medium`.

Using it: start OpenCode in the project root, write the brief to a file, then
run `/pipeline` (or `/pipeline-quick fix the typo in foo`). The orchestrator
drives planner → implementer → verifier and reports.
