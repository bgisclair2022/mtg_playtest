"""Import public decks from Moxfield.

Moxfield has no official API or account linking; this reads the same public JSON its
website uses, identifying itself honestly. Private decks can't be reached, and if
Moxfield starts refusing requests the app falls back to Export -> Copy and paste.
"""
import json
import re
import urllib.error
import urllib.parse
import urllib.request

API = "https://api2.moxfield.com"
HEADERS = {"User-Agent": "MTGGoldfish/0.1 (personal deck-testing tool)", "Accept": "application/json"}
BLOCKED = ("Moxfield didn't allow the request. On the deck's Moxfield page use "
           "More -> Export -> Copy for MTGA, then paste it into a new deck here.")


def _get(path, params=None):
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise ValueError("Not found on Moxfield (the deck may be private or the name misspelled).")
        raise ValueError(BLOCKED) from e
    except ValueError as e:  # an HTML challenge page instead of JSON
        raise ValueError(BLOCKED) from e


def user_decks(username):
    """A user's public Commander decks, newest first."""
    out = []
    for page in range(1, 6):
        res = _get("/v2/decks/search", {"authorUserNames": username.strip(), "fmt": "commander",
                                        "pageNumber": page, "pageSize": 100, "sortType": "updated", "sortDirection": "descending"})
        out += [{"name": d["name"], "id": d["publicId"], "url": d.get("publicUrl", "")} for d in res.get("data", [])]
        if page >= res.get("totalPages", 1):
            break
    return out


def deck_id(url_or_id):
    m = re.search(r"moxfield\.com/decks/([\w-]+)", url_or_id)
    return m[1] if m else url_or_id.strip()


def fetch(url_or_id):
    """Returns a deck dict ready for decks.save()."""
    d = _get(f"/v3/decks/all/{deck_id(url_or_id)}")
    boards = d.get("boards", {})

    def names(board):
        return [(e["quantity"], e["card"]["name"]) for e in boards.get(board, {}).get("cards", {}).values()]

    return {
        "name": d["name"],
        "commander": "\n".join(n for _, n in names("commanders")),
        "companion": "\n".join(n for _, n in names("companions")),
        "list": "\n".join(f"{q} {n}" for q, n in sorted(names("mainboard"), key=lambda e: e[1])),
        "source": d.get("publicUrl", ""),
    }
