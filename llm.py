"""Advanced bot: ask Claude for a short game plan the Forge AI then follows (see bridge/src/goldfish/Strategist.java).

Two backends, picked on the Settings tab:
  claude-code  runs the Claude Code CLI headless, billed to your Claude subscription (log in once with `claude`)
  api          calls the Claude API with your API key (billed per token on platform.claude.com)

The bridge runs `python llm.py` with {"kind": "mulligan"|"turn"|"respond", "state": {...}} on stdin and reads the plan
JSON from stdout. Any failure prints {} so Forge's own AI simply decides as usual.
"""
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
LESSONS_FILE = os.path.join(ROOT, "data", "bot-lessons.md")  # what the bot has learned; rewritten after each reviewed game
REVIEWS_DIR = os.path.join(ROOT, "data", "reviews")
LESSONS_TEMPLATE = "# Bot lessons\n\nNothing learned yet. Lessons are added after each reviewed game.\n"
# Shipped starting point, learned from simulated games between the preset decks; used until you have your own file.
BASE_LESSONS = os.path.join(ROOT, "presets", "bot-lessons.md")

MODELS = {"claude-opus-5-5": "Opus 5.5 (smartest)", "claude-sonnet-5-5": "Sonnet 5.5 (balanced)",
          "claude-haiku-4-5": "Haiku 4.5 (fastest)"}
DEFAULT_MODEL = "claude-opus-5-5"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
DIFFICULTY_DIR = os.path.join(ROOT, "difficulties")
DEFAULT_DIFFICULTY = "normal"


def difficulties():
    """Smarter Jace's difficulty levels, one Markdown file each in difficulties/ (e.g. 3-hard.md). The file name gives
    the order and key, the front matter a label and whether past lessons are used, the first paragraph a one-line
    description for the picker, and the whole body is added to Claude's instructions. Add a file to add a level."""
    out = {}
    for path in sorted(glob.glob(os.path.join(DIFFICULTY_DIR, "*.md"))):
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        key = re.sub(r"^\d+[-_ ]*", "", os.path.splitext(os.path.basename(path))[0]).lower()
        meta, body = {}, text
        m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.S)
        if m:
            meta = dict(re.findall(r"^(\w+):\s*(.*?)\s*$", m[1], re.M))
            body = text[m.end():]
        blurb = next((ln.strip() for ln in body.splitlines() if ln.strip() and not ln.startswith("#")), "")
        out[key] = {"label": meta.get("label") or key.title(), "blurb": blurb, "style": body.strip()[:4000],
                    "lessons": meta.get("lessons", "yes").lower() not in ("no", "false", "0"), "file": path}
    return out


def difficulty(name):
    levels = difficulties()
    return levels.get(name or "") or levels.get(DEFAULT_DIFFICULTY) or {"label": "Normal", "style": "", "lessons": True}


SYSTEM = """You are the strategist for a Magic: The Gathering Commander bot playing 1v1 against a human.
A rules engine plays the cards; you only set the plan. Cards are referred to by their numeric "id".
Be concise and practical: think about mana, threats on board, removal, and when attacking is safe."""

SCHEMAS = {
    "mulligan": {
        "type": "object", "additionalProperties": False, "required": ["keep", "note"],
        "properties": {
            "keep": {"type": "boolean", "description": "true keeps this opening hand, false mulligans"},
            "note": {"type": "string", "description": "one short sentence explaining why"},
        },
    },
    "turn": {
        "type": "object", "additionalProperties": False, "required": ["attack", "attackers", "cast_first", "hold", "note"],
        "properties": {
            "attack": {"type": "string", "enum": ["auto", "none", "all", "list"],
                       "description": "auto: engine decides; none: no attacks; all: everything that can attack; list: exactly `attackers`"},
            "attackers": {"type": "array", "items": {"type": "integer"}, "description": "creature ids when attack is 'list'"},
            "cast_first": {"type": "array", "items": {"type": "integer"},
                           "description": "hand/command-zone card ids to cast this turn, most important first"},
            "hold": {"type": "array", "items": {"type": "integer"},
                     "description": "card ids NOT to cast on your own turn (e.g. save removal or counters)"},
            "note": {"type": "string", "description": "one short sentence summarising the plan, shown to the player"},
        },
    },
    "respond": {
        "type": "object", "additionalProperties": False, "required": ["respond", "target_cards", "target_players", "note"],
        "properties": {
            "respond": {"type": "integer", "description": "index of the option to use in response, or -1 to let the stack resolve"},
            "target_cards": {"type": "array", "items": {"type": "integer"},
                             "description": "card ids to target, chosen from that option's legal_targets (empty if none)"},
            "target_players": {"type": "array", "items": {"type": "string", "enum": ["you", "opponent"]},
                               "description": "players to target, from that option's legal_targets (empty if none)"},
            "note": {"type": "string", "description": "one short sentence explaining the decision, shown to the player"},
        },
    },
}

_VERDICTS = ["optimal", "fine", "mistake"]
SCHEMAS["review"] = {
    "type": "object", "additionalProperties": False,
    "required": ["summary", "bot_decisions", "your_play", "lessons_md"],
    "properties": {
        "summary": {"type": "string", "description": "2-3 sentences: why the game was won or lost, and the turning point"},
        "bot_decisions": {"type": "array", "description": "the bot's most important decisions, in game order", "items": {
            "type": "object", "additionalProperties": False, "required": ["when", "choice", "verdict", "better"],
            "properties": {
                "when": {"type": "string", "description": "e.g. 'Round 4, response to Ram Through'"},
                "choice": {"type": "string"},
                "verdict": {"type": "string", "enum": _VERDICTS},
                "better": {"type": "string", "description": "the better line if not optimal, else empty"},
            }}},
        "your_play": {"type": "array", "items": {"type": "string"},
                      "description": "up to 4 short observations on the human's play: missed lines or strong plays"},
        "lessons_md": {"type": "string", "description": (
            "the COMPLETE updated lessons file in Markdown: keep what still holds, merge duplicates, fix anything this "
            "game proved wrong, add new lessons. The bot may be handed ANY deck, so these are general rules for "
            "Commander play: principles for any deck, and how to pilot and how to beat each archetype (aggro, control, "
            "ramp, stax, midrange, combo). Not about this one game or these particular decks: name cards only as brief "
            "examples. Grouped under short headings, at most ~40 bullets.")},
    },
}

ASKS = {
    "review": ("The game is over. Review it: `result`, the full game `log` (oldest first) and `decisions`, the bot's "
               "journal (what it saw, what it chose and why). Judge whether the bot's choices were optimal, note the "
               "human's key plays, then rewrite the bot's lessons file (`current_lessons`) so future games go better."),
    "mulligan": "Decide whether to keep this opening hand.",
    "turn": "It is your main phase. Plan this turn: what to cast first, what to hold, and how to attack.",
    "respond": ("Your opponent just put something on the stack (`stack`, top first). You may answer it with one of your "
                "`options` (by index) or pass with -1. Respond when it clearly pays off: saving your creature or "
                "commander, countering or blunting a real threat, or removing a creature in response to a pump or "
                "aura on it. Otherwise pass and keep your cards. Pick targets only from that option's legal_targets."),
}


def _prompt(kind, state):
    return f"{ASKS[kind]}\n\nGame state (JSON):\n{json.dumps(state, separators=(',', ':'))}"


def claude_exe():
    """The `claude` CLI on PATH, else the copy bundled with the Claude desktop app."""
    found = shutil.which("claude")
    if found:
        return found
    root = os.path.join(os.environ.get("APPDATA", ""), "Claude", "claude-code")
    # claude-code\<version>\claude.exe, or (newer desktop apps) claude-code\<version>\<id>\claude.exe
    bundled = glob.glob(os.path.join(root, "*", "claude.exe")) + glob.glob(os.path.join(root, "*", "*", "claude.exe"))
    version = lambda p: [int(x) for x in os.path.relpath(p, root).split(os.sep)[0].split(".") if x.isdigit()]
    return max(bundled, key=version) if bundled else None


def lessons():
    for path in (LESSONS_FILE, BASE_LESSONS):
        try:
            with open(path, encoding="utf-8") as f:
                return f.read()[:8000]
        except OSError:
            pass
    return ""


def starting_lessons():
    """What a new lessons file starts from: the shipped base lessons if present, else an empty template."""
    try:
        with open(BASE_LESSONS, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return LESSONS_TEMPLATE


def _system(kind, level=None):
    """The strategist prompt at this difficulty, plus everything learned so far (the review rewrites the lessons itself)."""
    if kind == "review":
        return SYSTEM
    d = difficulty(level)
    learned = lessons() if d["lessons"] else ""
    return (SYSTEM + (f"\n\nYour difficulty level is {d['label']}. Follow this playstyle:\n{d['style']}" if d["style"] else "")
            + (f"\n\nLessons from your previous games (follow them unless the situation clearly differs):\n{learned}" if learned else ""))


def _via_claude_code(kind, state, model, level=None):
    exe = claude_exe()
    if not exe:
        raise RuntimeError("Claude Code CLI not found. Install it or the Claude desktop app, then run `claude` once to log in.")
    out = subprocess.run(
        [exe, "-p", "--output-format", "json", "--model", model, "--tools", "", "--setting-sources", "",
         "--strict-mcp-config", "--system-prompt", _system(kind, level), "--json-schema", json.dumps(SCHEMAS[kind])],
        input=_prompt(kind, state), capture_output=True, text=True, encoding="utf-8", timeout=240 if kind == "review" else 90,
        cwd=tempfile.gettempdir(), creationflags=NO_WINDOW)
    reply = json.loads(out.stdout)
    if reply.get("is_error"):
        raise RuntimeError(reply.get("result") or "Claude Code returned an error")
    plan = reply.get("structured_output")
    return plan if isinstance(plan, dict) else json.loads(reply["result"])


def _via_api(kind, state, model, api_key, level=None):
    import anthropic
    extra = {} if model.startswith("claude-haiku") else {"effort": "low"}  # effort isn't supported on Haiku 4.5
    response = anthropic.Anthropic(api_key=api_key or None, timeout=240 if kind == "review" else 90).messages.create(
        model=model, max_tokens=16000 if kind == "review" else 4000, system=_system(kind, level),
        messages=[{"role": "user", "content": _prompt(kind, state)}],
        output_config={"format": {"type": "json_schema", "schema": SCHEMAS[kind]}, **extra})
    if response.stop_reason != "end_turn":
        raise RuntimeError(f"Claude stopped early ({response.stop_reason})")
    return json.loads(next(b.text for b in response.content if b.type == "text"))


def plan(kind, state, backend, model=DEFAULT_MODEL, api_key=None, level=None):
    model = model if model in MODELS else DEFAULT_MODEL  # difficulty never changes the model (or its cost)
    if backend == "api":
        return _via_api(kind, state, model, api_key, level)
    return _via_claude_code(kind, state, model, level)


def review(result, log, journal_path, backend, model=DEFAULT_MODEL, api_key=None):
    """Grade a finished game, rewrite the lessons file, and save a Markdown report. Returns the review dict."""
    decisions = []
    try:
        with open(journal_path, encoding="utf-8") as f:
            decisions = [json.loads(line) for line in f if line.strip()]
    except (OSError, TypeError):
        pass
    state = {"result": result, "log": log[-600:], "decisions": decisions[-60:], "current_lessons": lessons() or LESSONS_TEMPLATE}
    r = plan("review", state, backend, model, api_key)

    os.makedirs(os.path.dirname(LESSONS_FILE), exist_ok=True)
    if r.get("lessons_md", "").strip():
        with open(LESSONS_FILE, "w", encoding="utf-8") as f:
            f.write(r["lessons_md"].strip()[:8000] + "\n")
    os.makedirs(REVIEWS_DIR, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M")
    lines = [f"# Game review · {stamp.replace('_', ' ')}", "", f"**Result:** {result}", "", r.get("summary", ""), "",
             "## Bot decisions", ""]
    lines += [f"- **{d['when']}** · {d['choice']} · *{d['verdict']}*" + (f"; better: {d['better']}" if d.get("better") else "")
              for d in r.get("bot_decisions", [])]
    lines += ["", "## Your play", ""] + [f"- {x}" for x in r.get("your_play", [])]
    r["report"] = os.path.join(REVIEWS_DIR, f"{stamp}.md")
    with open(r["report"], "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return r


def _journal(kind, state, result):
    """Record a decision for the post-game review (the bridge passes the journal path per game)."""
    path = os.environ.get("GOLDFISH_JOURNAL")
    if not path or not result:
        return
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"kind": kind, "turn": state.get("turn"), "stack": state.get("stack"),
                                "options": state.get("options"), "decision": result}) + "\n")
    except OSError:
        pass


def main():
    try:
        req = json.load(sys.stdin)
        result = plan(req["kind"], req["state"], os.environ.get("GOLDFISH_LLM"), os.environ.get("GOLDFISH_LLM_MODEL"),
                      os.environ.get("ANTHROPIC_API_KEY"), os.environ.get("GOLDFISH_DIFFICULTY"))
        _journal(req["kind"], req["state"], result)
    except Exception as e:  # noqa: BLE001 - the bot falls back to Forge's AI
        print(f"llm: {type(e).__name__}: {e}", file=sys.stderr)
        result = {}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
