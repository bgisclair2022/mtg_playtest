"""EDHREC data: what real Commander decks play with a given commander.

Uses EDHREC's public JSON (the same data its website shows), politely: identified, one request per
second, cached in data/edhrec/. Used to build the preset bot decks and to suggest cards for yours.
"""
import json
import os
import re
import time
import urllib.error
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, "data", "edhrec")
HEADERS = {"User-Agent": "MTGGoldfish/0.1 (personal deck-testing tool)", "Accept": "application/json"}
BASIC = {"Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes"}
_last = 0.0


def slug(name):
    """EDHREC's URL name for a card: 'Baral, Chief of Compliance' -> 'baral-chief-of-compliance'."""
    front = name.split(" // ")[0]
    return re.sub(r"[^a-z0-9]+", "-", front.lower().replace("'", "").replace(",", "")).strip("-")


def _get(kind, name, max_age_days=14):
    path = os.path.join(CACHE, f"{kind}-{slug(name)}.json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age_days * 86400:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    global _last
    time.sleep(max(0.0, 1.0 - (time.time() - _last)))
    url = f"https://json.edhrec.com/pages/{kind}/{slug(name)}.json"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        raise ValueError(f"EDHREC has no page for {name} ({e.code}).") from e
    finally:
        _last = time.time()
    os.makedirs(CACHE, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return data


def average_deck(commander):
    """The aggregate of real decks for this commander: [(count, name)] for the 99."""
    cards = _get("average-decks", commander)["deck"]["cards"]
    return [(n, name) for group in cards.values() for name, n in group]


def top_cards(commander):
    """Cards EDHREC associates with this commander, best first: [{name, synergy, inclusion, section}]."""
    page = _get("commanders", commander)
    out, seen = [], set()
    for section in page.get("container", {}).get("json_dict", {}).get("cardlists", []):
        for cv in section.get("cardviews", []):
            if cv["name"] in seen:
                continue
            seen.add(cv["name"])
            decks = cv.get("potential_decks") or 0
            out.append({"name": cv["name"], "synergy": round(cv.get("synergy", 0) or 0, 2),
                        "inclusion": round(100 * (cv.get("num_decks") or 0) / decks) if decks else None,
                        "section": section.get("header", "")})
    # high synergy first, then by how often it's played
    return sorted(out, key=lambda c: (-(c["synergy"] or 0), -(c["inclusion"] or 0)))


def suggestions(commander, deck_names, limit=15):
    """Popular / high-synergy cards for this commander that the deck doesn't run yet."""
    have = {n.lower() for n in deck_names}
    return [c for c in top_cards(commander) if c["name"].lower() not in have and c["name"] not in BASIC][:limit]


def forge_ai_unplayable(forge_dir):
    """Card names Forge's AI is flagged as unable to play well (AI:RemoveDeck:All in its card scripts)."""
    path = os.path.join(forge_dir, "res", "cardsfolder", "cardsfolder.zip")
    out = set()
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n.endswith(".txt"):
                text = z.read(n)
                if b"RemoveDeck:All" in text:
                    m = re.search(rb"^Name:(.+)$", text, re.M)
                    if m:
                        out.add(m.group(1).decode("utf-8", "replace").strip())
    return out


def bot_deck(commander, unplayable):
    """EDHREC's average deck, with cards Forge's AI can't play swapped for the next-best EDHREC cards it can.
    Returns (list text, [(swapped_out, swapped_in)])."""
    deck = average_deck(commander)
    keep = [(n, name) for n, name in deck if name not in unplayable]
    dropped = [name for n, name in deck if name in unplayable]
    have = {name for _, name in keep} | {commander}
    extras = [c["name"] for c in top_cards(commander)
              if c["name"] not in have and c["name"] not in unplayable and c["name"] not in BASIC]
    swaps = list(zip(dropped, extras))
    keep += [(1, new) for _, new in swaps]
    missing = 99 - sum(n for n, _ in keep)
    if missing > 0:  # ran out of replacements: top up with the deck's most common basic land
        basics = [(n, name) for n, name in keep if name in BASIC]
        basic = max(basics)[1] if basics else "Wastes"
        keep.append((missing, basic))
    lines = [f"{n} {name}" for n, name in sorted(keep, key=lambda x: (x[1] in BASIC, x[1]))]
    return "\n".join(lines), swaps
