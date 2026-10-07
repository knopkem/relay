#!/usr/bin/env bash
# Install ocodesa into the OpenCode config dir: render the agents, link the
# slash commands, link the plugins. Idempotent and safe to re-run: it only
# touches symlinks it owns and never clobbers real files.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

say() { printf '%s\n' "$*"; }
run() {
  if [[ $DRY -eq 1 ]]; then say "would:  $*"; else "$@"; fi
}

# link <src> <dst>: idempotent symlink, never clobbers a real file.
link() {
  local src="$1" dst="$2"
  if [[ -L "$dst" ]]; then
    if [[ "$(readlink "$dst")" == "$src" ]]; then
      say "ok:     $dst"
      return
    fi
    run rm "$dst"
  elif [[ -e "$dst" ]]; then
    say "skip:   $dst exists and is not a symlink"
    return
  fi
  run ln -s "$src" "$dst"
  say "linked: $dst -> $src"
}

[[ -f "$ROOT/package.json" && -d "$ROOT/plugins" ]] ||
  { echo "error: $ROOT is not the ocodesa repo" >&2; exit 1; }
command -v python3 >/dev/null ||
  { echo "error: python3 not found" >&2; exit 1; }
command -v opencode >/dev/null || say "note: 'opencode' not on PATH"

# 1. Agents: render from models.local.json and link ~/.config/opencode/agent.
if [[ -f "$ROOT/models.local.json" ]]; then
  run python3 "$ROOT/scripts/set-models.py" --render
else
  say "models.local.json missing; starting the interactive picker"
  run python3 "$ROOT/scripts/set-models.py"
fi

# 2. Slash commands.
if [[ -L "$CONF/command" ]]; then
  resolved="$(cd "$CONF/command" 2>/dev/null && pwd -P || true)"
  if [[ "$resolved" == "$ROOT/command" ]]; then
    say "ok:     $CONF/command -> $ROOT/command"
  else
    say "warn:   $CONF/command points elsewhere ($resolved); leaving it alone"
  fi
else
  run mkdir -p "$CONF/command"
  for src in "$ROOT"/command/*.md; do
    link "$src" "$CONF/command/$(basename "$src")"
  done
fi

# 3. Plugins.
run mkdir -p "$CONF/plugins"
for src in "$ROOT"/plugins/*.js; do
  link "$src" "$CONF/plugins/$(basename "$src")"
done

# 4. Prune links we own whose source no longer exists.
for dir in "$CONF/plugins" "$CONF/command"; do
  for dst in "$dir"/*; do
    [[ -L "$dst" ]] || continue
    target="$(readlink "$dst")"
    case "$target" in
      "$ROOT"/*)
        if [[ ! -e "$target" ]]; then
          run rm "$dst"
          say "pruned: $dst"
        fi
        ;;
    esac
  done
done

say ""
say "done. restart opencode to load plugins."
