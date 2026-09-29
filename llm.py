"""Advanced bot: ask Claude for a short game plan the Forge AI then follows (see bridge/src/goldfish/Strategist.java).

Two backends, picked on the Settings tab:
  claude-code  runs the Claude Code CLI headless, billed to your Claude subscription (log in once with `claude`)
  api          calls the Claude API with your API key (billed per token on platform.claude.com)

The bridge runs `python llm.py` with {"kind": "mulligan"|"turn"|"respond", "state": {...}} on stdin and reads the plan
JSON from stdout. Any failure prints {} so Forge's own AI simply decides as usual.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

MODELS = {"claude-opus-5-5": "Opus 5.5 (smartest)", "claude-sonnet-5-5": "Sonnet 5.5 (balanced)",
          "claude-haiku-4-5": "Haiku 4.5 (fastest)"}
DEFAULT_MODEL = "claude-opus-5-5"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

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

ASKS = {
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
    bundled = glob.glob(os.path.join(os.environ.get("APPDATA", ""), "Claude", "claude-code", "*", "claude.exe"))
    return max(bundled, key=lambda p: [int(x) for x in os.path.basename(os.path.dirname(p)).split(".") if x.isdigit()]) if bundled else None


def _via_claude_code(kind, state, model):
    exe = claude_exe()
    if not exe:
        raise RuntimeError("Claude Code CLI not found. Install it or the Claude desktop app, then run `claude` once to log in.")
    out = subprocess.run(
        [exe, "-p", "--output-format", "json", "--model", model, "--tools", "", "--setting-sources", "",
         "--strict-mcp-config", "--system-prompt", SYSTEM, "--json-schema", json.dumps(SCHEMAS[kind])],
        input=_prompt(kind, state), capture_output=True, text=True, encoding="utf-8", timeout=90,
        cwd=tempfile.gettempdir(), creationflags=NO_WINDOW)
    reply = json.loads(out.stdout)
    if reply.get("is_error"):
        raise RuntimeError(reply.get("result") or "Claude Code returned an error")
    plan = reply.get("structured_output")
    return plan if isinstance(plan, dict) else json.loads(reply["result"])


def _via_api(kind, state, model, api_key):
    import anthropic
    extra = {} if model.startswith("claude-haiku") else {"effort": "low"}  # effort isn't supported on Haiku 4.5
    response = anthropic.Anthropic(api_key=api_key or None, timeout=90).messages.create(
        model=model, max_tokens=4000, system=SYSTEM,
        messages=[{"role": "user", "content": _prompt(kind, state)}],
        output_config={"format": {"type": "json_schema", "schema": SCHEMAS[kind]}, **extra})
    if response.stop_reason != "end_turn":
        raise RuntimeError(f"Claude stopped early ({response.stop_reason})")
    return json.loads(next(b.text for b in response.content if b.type == "text"))


def plan(kind, state, backend, model=DEFAULT_MODEL, api_key=None):
    model = model if model in MODELS else DEFAULT_MODEL
    if backend == "api":
        return _via_api(kind, state, model, api_key)
    return _via_claude_code(kind, state, model)


def main():
    try:
        req = json.load(sys.stdin)
        result = plan(req["kind"], req["state"], os.environ.get("GOLDFISH_LLM"), os.environ.get("GOLDFISH_LLM_MODEL"),
                      os.environ.get("ANTHROPIC_API_KEY"))
    except Exception as e:  # noqa: BLE001 - the bot falls back to Forge's AI
        print(f"llm: {type(e).__name__}: {e}", file=sys.stderr)
        result = {}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
