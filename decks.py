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
SKIP_SECTIONS = ("side", "maybe", "consider", "token")


def parse(text):
    """Parse Moxfield/Arena/MTGO-style text. Returns (commander names, [(count, name)], companion names)."""
    commanders, cards, companions, section = [], [], [], "deck"
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
        if section.startswith("companion"):
            companions.append(name)  # companions start outside the game (CR 702.139)
        elif is_commander:
            commanders.append(name)
        else:
            cards.append((count, name))
    return commanders, cards, companions


def commander_and_cards(deck):
    """(commander names, [(count, name)]) for a saved deck: the Commander field wins over list markers."""
    return _commander_names(deck)


def _companion_names(deck):
    """The deck's companion: the Companion field, else a 'Companion' section in the list."""
    typed = [n.strip() for n in re.split(r"[\n;]", deck.get("companion") or "") if n.strip()]
    return typed or parse(deck.get("list", ""))[2]


def _commander_names(deck):
    names, entries, _ = parse(deck.get("list", ""))
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
                    cmd, cards = _commander_names(d)
                    out.append({"name": d["name"], "commander": d.get("commander", "") or "\n".join(cmd), "preset": preset,
                                "description": d.get("description", ""), "tags": d.get("tags", []),
                                "count": len(cmd) + sum(c for c, _ in cards), "source": d.get("source", ""),
                                "modified": os.path.getmtime(os.path.join(folder, f))})
    return out


def load(name, preset=False):
    return _read(os.path.join(PRESET_DIR if preset else SAVE_DIR, _slug(name) + ".json"))


def save(deck):
    if not deck.get("name", "").strip():
        raise ValueError("Give the deck a name first.")
    os.makedirs(SAVE_DIR, exist_ok=True)
    keep = {k: deck.get(k, "") for k in ("name", "commander", "companion", "list", "source")}
    keep["tags"] = [t.strip() for t in deck.get("tags") or [] if t.strip()][:8]
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
    comp_names = _companion_names(deck)
    lowered = {n.lower() for n in comp_names}
    entries = [(c, n) for c, n in entries if n.lower() not in lowered]  # a companion is outside the 100
    found, not_found = scryfall.lookup(cmd_names + [n for _, n in entries] + comp_names)
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
    companions = [found[n.lower()] for n in comp_names if n.lower() in found]
    for comp in companions:  # its deckbuilding condition is checked by Forge when the game starts
        if not re.search(r"^Companion\b", comp["oracle_text"], re.M):
            problems.append(f"{comp['name']} doesn't have companion.")
        if not set(comp["color_identity"]) <= identity:
            problems.append(f"Companion {comp['name']} is outside the commander's color identity.")
        if comp["legal"] == "banned":
            problems.append(f"Companion {comp['name']} is banned in Commander.")

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
        "analysis": analyse(commanders, cards, identity),
        "commanders": commanders,
        "companions": companions,
        "cards": [{"count": c, **d} for c, d in cards],
        "problems": problems,
        "stats": {"total": total, "curve": curve, "types": types, "avg_cmc": round(avg, 2), "identity": [c for c in "WUBRG" if c in identity]},
    }


# ---- analysis ------------------------------------------------------------------

ROLES = {  # rough oracle-text patterns; good enough to spot a deck that's short on something
    "Ramp": r"add \{|search your library for (up to \w+ )?(a )?basic land|lands? cards?.{0,40}onto the battlefield|create[^.]*treasure",
    "Card draw": r"\bdraws? (a|two|three|four|x|that many|cards?|an additional)|investigate|connive",
    "Removal": r"(destroy|exile) target|damage to (any target|target creature|target planeswalker)|return target (creature|nonland|permanent)[^.]*owner's hand|fights? target",
    "Board wipes": r"(destroy|exile) all|damage to each creature|all creatures get -|return all (creatures|nonland)|each (player|opponent) sacrifices (a|all) creatures",
    "Counterspells": r"counter target",
    "Tutors": r"search your library for (a|an|up to (one|two)) (?!basic)[^.]*card",
    "Protection": r"hexproof|indestructible|phase out|shroud|\bward\b",
}
MLD = r"destroy all lands|destroy all nonbasic lands|each player sacrifices (all|\w+) lands|sacrifice all lands"
EXTRA_TURNS = r"takes? an extra turn"


def analyse(commanders, cards, identity):
    """Deck roles, colour pips vs. land sources, and a rough Commander bracket estimate."""
    roles = {r: [] for r in ROLES}
    pips = {c: 0 for c in "WUBRG"}
    sources = {c: 0 for c in "WUBRG"}
    gc_list, mld, turns = scryfall.game_changers(), [], []
    for count, d in cards:
        text, name = d["oracle_text"].lower(), d["name"]
        if "Land" not in d["type_line"]:
            for role, rx in ROLES.items():
                if re.search(rx, text):
                    roles[role].append(name)
            for c in "WUBRG":
                pips[c] += count * len(re.findall(r"\{[^}]*" + c + r"[^}]*\}", d.get("mana_cost", "")))
        else:
            makes = set(re.findall(r"\{([wubrg])\}", text.split("add", 1)[1] if "add" in text else ""))
            if "any color" in text or "commander's color identity" in text or "any one color" in text:
                makes = set("wubrg")
            makes |= {c for c, t in zip("wubrg", ("plains", "island", "swamp", "mountain", "forest")) if t in d["type_line"].lower()}
            for c in makes:
                if c.upper() in identity:
                    sources[c.upper()] += count
        if re.search(MLD, text):
            mld.append(name)
        if re.search(EXTRA_TURNS, text):
            turns.append(name)
    gcs = sorted({d["name"] for _, d in cards if d["name"] in gc_list} | {d["name"] for d in commanders if d["name"] in gc_list})
    if len(gcs) > 3 or mld:
        bracket, why = 4, "more than 3 Game Changers" if len(gcs) > 3 else "mass land destruction"
    elif gcs or len(turns) > 1:
        bracket, why = 3, (f"{len(gcs)} Game Changer{'s' if len(gcs) != 1 else ''}" if gcs else "several extra-turn cards")
    else:
        bracket, why = 2, "no Game Changers, mass land destruction or chained extra turns"
    return {"roles": {r: sorted(set(n)) for r, n in roles.items()}, "pips": pips, "sources": sources,
            "game_changers": gcs, "mld": sorted(set(mld)), "extra_turns": sorted(set(turns)),
            "bracket": bracket, "bracket_why": why}


def to_dck(name, resolved, rename=None):
    """Forge deck file text. `rename` maps alternate printed names (e.g. Universes Within) to Forge's names."""
    rename = rename or {}

    def forge_name(d):
        return rename.get(d["forge_name"].lower(), d["forge_name"])

    lines = ["[metadata]", f"Name={name}", "[Commander]"]
    lines += [f"1 {forge_name(d)}" for d in resolved["commanders"]]
    lines.append("[Main]")
    lines += [f"{c['count']} {forge_name(c)}" for c in resolved["cards"]]
    if resolved.get("companions"):  # Forge offers sideboard companions at the start of the game
        lines.append("[Sideboard]")
        lines += [f"1 {forge_name(d)}" for d in resolved["companions"]]
    return "\n".join(lines) + "\n"
