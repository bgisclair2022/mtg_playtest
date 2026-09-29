"""Decklist parsing, the saved-deck library (data/decks/), bundled presets (presets/),
Scryfall validation and export to Forge's .dck format."""
import json
import os
import re

import scryfall

ROOT = os.path.dirname(os.path.abspath(__file__))
SAVE_DIR = os.path.join(ROOT, "data", "decks")
PRESET_DIR = os.path.join(ROOT, "presets")
SECTION = re.compile(r"^(commanders?|companions?|deck|main ?deck|mainboard|sideboard|maybeboard|considering|tokens?)\s*:?\s*(\(\d+\))?$", re.I)
SKIP_SECTIONS = ("side", "maybe", "consider", "token", "companion")


def parse(text):
    """Parse Moxfield/Arena/MTGO-style text. Returns (commander names, [(count, name)])."""
    commanders, cards, section = [], [], "deck"
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("//", "#")):
            continue
        m = SECTION.match(line)
        if m:
            section = m[1].lower()
            continue
        if section.startswith(SKIP_SECTIONS):
            continue
        is_commander = "*CMDR*" in line.upper() or section.startswith("commander")
        line = re.sub(r"\s\*[A-Za-z]+\*", "", line)  # *CMDR*, *F* (foil) tags
        line = re.sub(r"\s+\([A-Za-z0-9]{2,6}\)(\s+\S+)?\s*$", "", line)  # "(SET) 123"
        m = re.match(r"(\d+)x?\s+(.+)", line)
        count, name = (int(m[1]), m[2].strip()) if m else (1, line)
        if is_commander:
            commanders.append(name)
        else:
            cards.append((count, name))
    return commanders, cards


def _commander_names(deck):
    names, entries = parse(deck.get("list", ""))
    typed = [n.strip() for n in re.split(r"[\n;]", deck.get("commander") or "") if n.strip()]
    if typed:
        lowered = {n.lower() for n in typed}
        return typed, [(c, n) for c, n in entries if n.lower() not in lowered]
    return names, entries


# ---- library -------------------------------------------------------------

def _slug(name):
    return re.sub(r"[^\w\- ]", "", name).strip() or "deck"


def _read(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def list_all():
    out = []
    for folder, preset in ((SAVE_DIR, False), (PRESET_DIR, True)):
        if os.path.isdir(folder):
            for f in sorted(os.listdir(folder)):
                if f.endswith(".json"):
                    d = _read(os.path.join(folder, f))
                    out.append({"name": d["name"], "commander": d.get("commander", ""), "preset": preset})
    return out


def load(name, preset=False):
    return _read(os.path.join(PRESET_DIR if preset else SAVE_DIR, _slug(name) + ".json"))


def save(deck):
    if not deck.get("name", "").strip():
        raise ValueError("Give the deck a name first.")
    os.makedirs(SAVE_DIR, exist_ok=True)
    keep = {k: deck.get(k, "") for k in ("name", "commander", "list", "source")}
    with open(os.path.join(SAVE_DIR, _slug(deck["name"]) + ".json"), "w", encoding="utf-8") as f:
        json.dump(keep, f, indent=2)


def delete(name):
    path = os.path.join(SAVE_DIR, _slug(name) + ".json")
    if os.path.exists(path):
        os.remove(path)


# ---- validation ------------------------------------------------------------

def _unlimited(card):
    return card["type_line"].startswith("Basic") or "any number of cards named" in card["oracle_text"]


def resolve(deck):
    """Look every card up on Scryfall and check Commander deck rules."""
    cmd_names, entries = _commander_names(deck)
    found, not_found = scryfall.lookup(cmd_names + [n for _, n in entries])
    problems = [f"Not found on Scryfall: {n}" for n in not_found]
    commanders = [found[n.lower()] for n in cmd_names if n.lower() in found]
    cards = [(c, found[n.lower()]) for c, n in entries if n.lower() in found]

    if not commanders:
        problems.append("No commander set. Fill in the Commander field or mark a line with *CMDR*.")
    total = len(commanders) + sum(c for c, _ in cards)
    if total != 100:
        problems.append(f"Deck has {total} cards; Commander decks have exactly 100.")
    identity = set().union(*(c["color_identity"] for c in commanders)) if commanders else set("WUBRG")
    off = sorted({d["name"] for _, d in cards if not set(d["color_identity"]) <= identity})
    if off:
        problems.append("Outside the commander's color identity: " + ", ".join(off))
    dupes = sorted({d["name"] for c, d in cards if c > 1 and not _unlimited(d)})
    if dupes:
        problems.append("More than one copy (singleton format): " + ", ".join(dupes))
    banned = sorted({d["name"] for _, d in cards if d["legal"] == "banned"} | {d["name"] for d in commanders if d["legal"] == "banned"})
    if banned:
        problems.append("Banned in Commander: " + ", ".join(banned))

    curve = [0] * 8
    types = {}
    for c, d in cards:
        main = next((t for t in ("Land", "Creature", "Planeswalker", "Instant", "Sorcery", "Artifact", "Enchantment", "Battle") if t in d["type_line"]), "Other")
        types[main] = types.get(main, 0) + c
        if main != "Land":
            curve[min(int(d["cmc"]), 7)] += c
    spells = sum(curve)
    avg = sum(i * n for i, n in enumerate(curve)) / spells if spells else 0
    return {
        "commanders": commanders,
        "cards": [{"count": c, **d} for c, d in cards],
        "problems": problems,
        "stats": {"total": total, "curve": curve, "types": types, "avg_cmc": round(avg, 2), "identity": [c for c in "WUBRG" if c in identity]},
    }


def to_dck(name, resolved):
    """Forge deck file text."""
    lines = ["[metadata]", f"Name={name}", "[Commander]"]
    lines += [f"1 {d['forge_name']}" for d in resolved["commanders"]]
    lines.append("[Main]")
    lines += [f"{c['count']} {c['forge_name']}" for c in resolved["cards"]]
    return "\n".join(lines) + "\n"
