"""Scryfall card lookups with an on-disk cache (data/cards.json).

Only the cards named in your decklists are fetched, 75 at a time through
/cards/collection, with a fuzzy /cards/named fallback for typos.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(ROOT, "data", "cards.json")
API = "https://api.scryfall.com"
HEADERS = {"User-Agent": "MTGGoldfish/0.1", "Accept": "application/json"}

_lock = threading.Lock()
_cache = None
_last = 0.0


def _load():
    global _cache
    if _cache is None:
        try:
            with open(CACHE_FILE, encoding="utf-8") as f:
                _cache = json.load(f)
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save():
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    with open(CACHE_FILE + ".tmp", "w", encoding="utf-8") as f:
        json.dump(_cache, f)
    os.replace(CACHE_FILE + ".tmp", CACHE_FILE)


def _request(path, body=None):
    global _last
    wait = 0.1 - (time.time() - _last)  # Scryfall asks for at most ~10 requests/second
    if wait > 0:
        time.sleep(wait)
    data = json.dumps(body).encode() if body is not None else None
    headers = {**HEADERS, **({"Content-Type": "application/json"} if data else {})}
    try:
        with urllib.request.urlopen(urllib.request.Request(API + path, data, headers), timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    finally:
        _last = time.time()


def _slim(c):
    face = (c.get("card_faces") or [c])[0]
    images = c.get("image_uris") or face.get("image_uris") or {}
    # Forge names split/aftermath cards "A // B" and everything else by its front face.
    forge_name = c["name"] if c.get("layout") in ("split", "aftermath") else face.get("name", c["name"])
    return {
        "name": c["name"],
        "forge_name": forge_name,
        "type_line": face.get("type_line") or c.get("type_line", ""),
        "mana_cost": face.get("mana_cost") or c.get("mana_cost", ""),
        "oracle_text": face.get("oracle_text") or c.get("oracle_text", ""),
        "cmc": c.get("cmc", 0),
        "color_identity": c.get("color_identity", []),
        "legal": c.get("legalities", {}).get("commander", "legal"),
        "image": images.get("normal"),
    }


def _store(key, card):
    s = _slim(card)
    with _lock:
        for k in {key, s["name"], s["forge_name"]}:
            _cache[k.lower()] = s
        # Each face of a double-faced card under its own name and art, so a transformed or
        # daybound/nightbound card shows the right side (Forge reports the face that's up).
        for face in card.get("card_faces") or []:
            if face.get("image_uris") and face.get("name") and face["name"].lower() not in _cache:
                _cache[face["name"].lower()] = {**s, "type_line": face.get("type_line", s["type_line"]),
                                                "oracle_text": face.get("oracle_text", ""),
                                                "image": face["image_uris"].get("normal")}


def lookup(names):
    """Resolve card names. Returns ({lowercased requested name: card}, [names not found])."""
    cache = _load()
    missing = sorted({n for n in names if n.lower() not in cache}, key=str.lower)
    for i in range(0, len(missing), 75):
        res = _request("/cards/collection", {"identifiers": [{"name": n} for n in missing[i:i + 75]]})
        for c in res.get("data", []):
            _store(c["name"], c)
    not_found = []
    for n in missing:
        if n.lower() not in cache:
            c = _request("/cards/named?" + urllib.parse.urlencode({"fuzzy": n}))
            if c:
                _store(n, c)
            else:
                not_found.append(n)
    if missing:
        _save()
    return {n.lower(): cache[n.lower()] for n in names if n.lower() in cache}, not_found
