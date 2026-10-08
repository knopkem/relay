#!/usr/bin/env python3
"""Assign a model per role, render the agents, and link them.

The repository stores placeholders (`__ORCHESTRATOR_MODEL__`,
`__PLANNER_MODEL__`, `__VERIFIER_MODEL__`, `__IMPLEMENTER_MODEL__`,
`# __<ROLE>_OPTIONS__`); your selection is saved
to gitignored `models.local.json` and rendered into gitignored `agent.local/`,
which is symlinked into `~/.config/opencode/agent` (replacing any existing
agent-dir symlink). Unset roles default: verifier -> planner,
orchestrator -> planner, watcher -> verifier, reviewer -> verifier.

Roles:
    orchestrator -> orchestrator.md
    planner      -> planner.md
    verifier     -> verifier.md
    implementer  -> implementer.md
    watcher      -> watcher.md
    reviewer     -> reviewer.md

Usage:
    scripts/set-models.py                      interactive picker (models + thinking)
    scripts/set-models.py --list               print numbered model list
    scripts/set-models.py PLANNER IMPLEMENTER  set the two required roles
    scripts/set-models.py --orchestrator M --verifier M ...
                                               any subset of role flags
    scripts/set-models.py --render             re-render from models.local.json
    scripts/set-models.py --think ...          implementer keeps reasoning (alias)
    scripts/set-models.py --no-think ...       implementer thinking off (alias)
    scripts/set-models.py --<role>-think on|off
                                               thinking per role
    scripts/set-models.py --<role>-effort L    reasoning effort per role
                                               (none|low|medium|high|xhigh)
    scripts/set-models.py --force ...          allow ids not in `opencode models`
    scripts/set-models.py --no-link ...        don't touch ~/.config/opencode/agent

Defaults: planner/verifier/watcher/reviewer think at medium, implementer and
orchestrator think off (effort none). Thinking off forces effort none.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = ROOT / "agent"
OUT_DIR = ROOT / "agent.local"
SELECTION = ROOT / "models.local.json"
CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "opencode"
LINK = CONFIG_DIR / "agent"

ROLES = ["orchestrator", "planner", "verifier", "implementer", "watcher", "reviewer"]
ROLE_FILES = {
    "orchestrator": "orchestrator.md",
    "planner": "planner.md",
    "verifier": "verifier.md",
    "implementer": "implementer.md",
    "watcher": "watcher.md",
    "reviewer": "reviewer.md",
}
ROLE_TOKENS = {role: f"__{role.upper()}_MODEL__" for role in ROLES}
ROLE_FLAGS = {f"--{role}": role for role in ROLES}
VALUE_FLAGS = {
    **ROLE_FLAGS,
    **{f"--{role}-think": f"{role}_think" for role in ROLES},
    **{f"--{role}-effort": f"{role}_effort" for role in ROLES},
}
ROLE_DEFAULTS = {
    "orchestrator": "planner",
    "verifier": "planner",
    "watcher": "verifier",
    "reviewer": "verifier",
}
MODEL_TOKEN = re.compile(r"__[A-Z]+_MODEL__")
OPTIONS_MARKERS = {role: f"# __{role.upper()}_OPTIONS__" for role in ROLES}
EFFORTS = ("none", "low", "medium", "high", "xhigh")
THINK_DEFAULTS = {
    "orchestrator": False,
    "planner": True,
    "implementer": False,
    "verifier": True,
    "watcher": True,
    "reviewer": True,
}
EFFORT_DEFAULTS = {
    "orchestrator": "none",
    "planner": "medium",
    "implementer": "none",
    "verifier": "medium",
    "watcher": "medium",
    "reviewer": "medium",
}

ANSI = re.compile(r"\x1b\[[0-9;]*m")
MODEL_ID = re.compile(r"[A-Za-z0-9_.@-]+/[^\s/]+(?:/[^\s/]+)*")


def list_models():
    try:
        out = subprocess.run(
            ["opencode", "models"], capture_output=True, text=True, check=True
        ).stdout
    except FileNotFoundError:
        sys.exit("error: 'opencode' not found on PATH")
    except subprocess.CalledProcessError as e:
        sys.exit(f"error: 'opencode models' failed: {e}")

    models, seen = [], set()
    for line in ANSI.sub("", out).splitlines():
        line = line.strip()
        if MODEL_ID.fullmatch(line) and line not in seen:
            seen.add(line)
            models.append(line)
    return models


def print_models(models):
    print("\nAvailable models:\n")
    for i, m in enumerate(models, 1):
        print(f"  {i:>3}) {m}")


def prompt_choice(role, models, default=None):
    hint = f", Enter = {default}" if default else ""
    while True:
        ans = input(
            f"\n{role} model (number, substring, or q to quit{hint}): "
        ).strip()
        if not ans and default:
            return default
        if ans.lower() in ("q", "quit", "exit"):
            sys.exit("aborted")
        if ans.isdigit() and 1 <= int(ans) <= len(models):
            return models[int(ans) - 1]
        if ans in models:
            return ans
        matches = [m for m in models if ans.lower() in m.lower()]
        if len(matches) == 1:
            return matches[0]
        if matches:
            print("Multiple matches:")
            for m in matches[:10]:
                print(f"    {m}")
        else:
            print("No match, try again.")


def resolve_roles(selection):
    roles = {role: selection.get(role) for role in ROLES}
    for role, source in ROLE_DEFAULTS.items():
        if not roles.get(role):
            roles[role] = roles.get(source)
    return roles


def load_selection():
    if not SELECTION.exists():
        return None
    try:
        return json.loads(SELECTION.read_text())
    except json.JSONDecodeError as e:
        sys.exit(f"error: {SELECTION} is not valid JSON: {e}")


def save_selection(selection):
    SELECTION.write_text(json.dumps(selection, indent=2) + "\n")


def parse_think(value, flag):
    raw = str(value).strip().lower()
    if raw in ("on", "true", "yes", "1"):
        return True
    if raw in ("off", "false", "no", "0"):
        return False
    sys.exit(f"error: {flag} must be on or off, got '{value}'")


def options_for(selection, role):
    think = selection.get(f"{role}_think")
    if think is None:
        think = THINK_DEFAULTS[role]
    think = bool(think)
    effort = selection.get(f"{role}_effort") or EFFORT_DEFAULTS[role]
    if effort not in EFFORTS:
        sys.exit(f"error: {role}_effort must be one of: {', '.join(EFFORTS)}")
    if not think:
        return False, "none"
    if effort == "none":
        effort = "medium"
    return True, effort


def normalize_options(selection):
    for role in ROLES:
        think, effort = options_for(selection, role)
        selection[f"{role}_think"] = think
        selection[f"{role}_effort"] = effort
    return selection


def render_options(selection, role):
    think, effort = options_for(selection, role)
    return (
        f"reasoningEffort: {effort}\n"
        "chat_template_kwargs:\n"
        f"  enable_thinking: {'true' if think else 'false'}"
    )


def prompt_thinking(role, default):
    hint = "on" if default else "off"
    while True:
        ans = input(f"{role} thinking (on/off, Enter = {hint}): ").strip().lower()
        if not ans:
            return default
        if ans in ("on", "off"):
            return ans == "on"
        print("Enter on or off.")


def prompt_effort(role, default):
    while True:
        ans = input(
            f"{role} effort ({'/'.join(EFFORTS)}, Enter = {default}): "
        ).strip().lower()
        if not ans:
            return default
        if ans in EFFORTS:
            return ans
        print(f"Enter one of: {', '.join(EFFORTS)}")


def prompt_options(selection):
    chosen = {}
    for role in ROLES:
        stored_think = selection.get(f"{role}_think")
        if stored_think is None:
            stored_think = THINK_DEFAULTS[role]
        think = prompt_thinking(role, bool(stored_think))
        if think:
            default_effort = selection.get(f"{role}_effort") or EFFORT_DEFAULTS[role]
            if default_effort == "none":
                default_effort = "medium"
            effort = prompt_effort(role, default_effort)
        else:
            effort = "none"
        chosen[f"{role}_think"] = think
        chosen[f"{role}_effort"] = effort
    return chosen


def render(selection, link=True):
    OUT_DIR.mkdir(exist_ok=True)
    normalize_options(selection)
    roles = resolve_roles(selection)
    if roles.get("watcher") and roles.get("watcher") == roles.get("implementer"):
        print(
            f"warning: watcher model equals implementer model ({roles['implementer']}); "
            "supervision will be advisory-only — use --watcher <different model> "
            "to enable it.",
            file=sys.stderr,
        )
    if roles.get("reviewer") and roles.get("reviewer") == roles.get("implementer"):
        print(
            f"warning: reviewer model equals implementer model ({roles['implementer']}); "
            "milestone reviews run serial (inline at each boundary), not in the "
            "background — use --reviewer <different model> for parallel review.",
            file=sys.stderr,
        )
    if roles.get("reviewer") and roles.get("reviewer") == roles.get("watcher"):
        print(
            f"warning: reviewer and watcher share a model ({roles['reviewer']}); "
            "they will contend when supervision and milestone review are both active.",
            file=sys.stderr,
        )
    written = []
    for role in ROLES:
        name = ROLE_FILES[role]
        text = (TEMPLATE_DIR / name).read_text()
        token = ROLE_TOKENS[role]
        if token not in text:
            sys.exit(f"error: {TEMPLATE_DIR / name}: no {token} placeholder")
        text = text.replace(token, roles[role])
        marker = OPTIONS_MARKERS[role]
        if marker not in text:
            sys.exit(f"error: {TEMPLATE_DIR / name}: no {marker} placeholder")
        text = text.replace(marker, render_options(selection, role))
        if MODEL_TOKEN.search(text):
            sys.exit(f"error: {TEMPLATE_DIR / name}: unresolved model placeholder")
        (OUT_DIR / name).write_text(text)
        written.append((name, roles[role]))

    print(f"rendered {len(written)} agents -> {OUT_DIR}")
    for name, model in written:
        print(f"  {name} -> {model}")

    if link:
        link_config()


def link_config():
    if LINK.is_symlink():
        if LINK.resolve() == OUT_DIR.resolve():
            print(f"link ok: {LINK} -> {OUT_DIR}")
            return
        LINK.unlink()
    elif LINK.exists():
        sys.exit(
            f"error: {LINK} is a real directory, not a symlink; move it aside and re-run"
        )
    LINK.parent.mkdir(parents=True, exist_ok=True)
    LINK.symlink_to(OUT_DIR)
    print(f"linked {LINK} -> {OUT_DIR}")


def parse_args(argv):
    value_flags = {}
    positional = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in VALUE_FLAGS:
            if i + 1 >= len(argv):
                sys.exit(f"error: {arg} needs a value")
            value_flags[VALUE_FLAGS[arg]] = argv[i + 1]
            i += 2
            continue
        if arg.startswith("--"):
            i += 1
            continue
        positional.append(arg)
        i += 1
    return value_flags, positional


def validate(selection, models, force):
    if not models or force:
        return
    for role in ROLES:
        model = selection.get(role)
        if model and model not in models:
            sys.exit(
                f"error: {role} model '{model}' not in `opencode models` (use --force)"
            )


def main():
    args = sys.argv[1:]

    if "--list" in args:
        for i, m in enumerate(list_models(), 1):
            print(f"{i:>3}) {m}")
        return

    force = "--force" in args
    think = "--think" in args
    no_think = "--no-think" in args
    render_only = "--render" in args
    link = "--no-link" not in args
    role_flags, positional = parse_args(args)
    for key, value in list(role_flags.items()):
        if key.endswith("_think"):
            role_flags[key] = parse_think(value, f"--{key[:-len('_think')]}-think")
    for role in ROLES:
        effort_flag = f"{role}_effort"
        think_flag = f"{role}_think"
        if effort_flag in role_flags and think_flag not in role_flags:
            role_flags[think_flag] = role_flags[effort_flag] != "none"

    if render_only:
        selection = load_selection()
        if not selection:
            sys.exit(f"error: {SELECTION} not found; run set-models.py first")
        selection.update(role_flags)
        if think or no_think:
            selection["implementer_think"] = bool(think and not no_think)
        normalize_options(selection)
        save_selection(selection)
        render(selection, link=link)
        return

    models = list_models()
    selection = load_selection() or {}

    if positional:
        if len(positional) != 2:
            sys.exit(__doc__)
        selection["planner"] = positional[0]
        selection["implementer"] = positional[1]
    selection.update(role_flags)

    if not args:
        print_models(models)
        planner = prompt_choice("planner", models)
        implementer = prompt_choice("implementer", models)
        verifier = prompt_choice("verifier", models, default=planner)
        watcher = prompt_choice("watcher", models, default=verifier)
        selection.update(
            {
                "planner": planner,
                "implementer": implementer,
                "orchestrator": prompt_choice("orchestrator", models, default=planner),
                "verifier": verifier,
                "watcher": watcher,
                "reviewer": prompt_choice("reviewer", models, default=verifier),
            }
        )
        selection.update(prompt_options(selection))
    else:
        if not selection.get("planner"):
            print_models(models)
            selection["planner"] = prompt_choice("planner", models)
        if not selection.get("implementer"):
            selection["implementer"] = prompt_choice("implementer", models)

    roles = resolve_roles(selection)
    for role in ("planner", "implementer"):
        if not roles[role]:
            sys.exit(f"error: {role} model is required")
    selection.update({role: roles[role] for role in ROLES})

    if think or no_think:
        selection["implementer_think"] = bool(think and not no_think)

    normalize_options(selection)
    validate(selection, models, force)

    save_selection(selection)
    print(f"saved {SELECTION}")
    render(selection, link=link)


if __name__ == "__main__":
    main()
