"""MTG Goldfish: a desktop companion for testing Commander decks against Forge's AI.

Launch from the desktop shortcut (or `python app.py`). The UI lives in web/ and calls the Api methods below
through window.pywebview.api.
"""
import functools
import importlib.util
import json
import mimetypes
import os
import sys
import time
import traceback
import urllib.request
import webbrowser

import webview

import decks
import edhrec
import forge
import llm
import moxfield
import scryfall

ROOT = os.path.dirname(os.path.abspath(__file__))
SETTINGS = os.path.join(ROOT, "data", "settings.json")


def _safe(fn):
    """Return {"error": message} to the UI instead of raising across the JS bridge."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001 - everything should reach the UI as a message
            traceback.print_exc()
            return {"error": str(e) or type(e).__name__}
    return wrapper


class Api:
    # pywebview exposes public attributes to JS, so state stays underscored.
    def __init__(self):
        self._sim = self._installer = self._match = None
        try:
            with open(SETTINGS, encoding="utf-8") as f:
                self._settings = json.load(f)
        except (OSError, ValueError):
            self._settings = {}
        if not forge.find_jar(self._settings.get("forge_dir")):
            self._settings["forge_dir"] = forge.detect()

    def _save_settings(self):
        os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
        with open(SETTINGS, "w", encoding="utf-8") as f:
            json.dump(self._settings, f, indent=2)

    def _forge_dir(self):
        d = self._settings.get("forge_dir")
        if not forge.find_jar(d):
            raise ValueError("Forge isn't set up yet. Point to its folder on the Settings tab.")
        return d

    # ---- in-app games (Forge engine + our board) ----
    @_safe
    def start_game(self, you, bot, level=None):
        self.stop_game()
        forge_dir = self._forge_dir()
        your_file, problems = self._export(you)
        bot_file, _ = self._export(bot)
        s = self._settings
        llm_env = {}
        if s.get("llm_backend"):  # advanced bot: the bridge runs llm.py for each plan
            level = level if level in llm.difficulties() else llm.DEFAULT_DIFFICULTY
            llm_env = {"GOLDFISH_LLM": s["llm_backend"], "GOLDFISH_LLM_MODEL": s.get("llm_model", llm.DEFAULT_MODEL),
                       "GOLDFISH_DIFFICULTY": level,
                       "GOLDFISH_PYTHON": sys.executable, "GOLDFISH_LLM_SCRIPT": os.path.abspath(llm.__file__)}
            if s.get("anthropic_api_key"):
                llm_env["ANTHROPIC_API_KEY"] = s["anthropic_api_key"]
            # every Claude decision this game is journaled for the post-game review
            journal_dir = os.path.join(ROOT, "data", "journal")
            os.makedirs(journal_dir, exist_ok=True)
            self._journal = os.path.join(journal_dir, time.strftime("%Y-%m-%d_%H%M%S") + ".jsonl")
            llm_env["GOLDFISH_JOURNAL"] = self._journal
        self._match = forge.Match(forge_dir, your_file, bot_file, s.get("username", ""), llm_env)
        self._level = level if s.get("llm_backend") else None
        return {"port": self._match.port, "warnings": problems, "reviews": bool(s.get("llm_backend"))}

    @_safe
    def review_game(self):
        """Post-game: Claude grades the bot's decisions (and yours) and updates data/bot-lessons.md."""
        s = self._settings
        if not s.get("llm_backend"):
            raise ValueError("Game reviews need the advanced bot. Turn it on in Settings.")
        if not self._match:
            raise ValueError("No game to review.")
        with urllib.request.urlopen(f"http://127.0.0.1:{self._match.port}/log", timeout=10) as r:
            log = json.load(r)  # grab it now, before a rematch closes the bridge
        winner = log.get("winner")
        level = getattr(self, "_level", None)
        result = (f"{winner} won" if winner else "no winner (conceded or unfinished)") + f" in round {log.get('round')}. " \
                 f"The bot is 'Jace'; the human is '{s.get('username') or 'You'}'." \
                 + (f" Jace played at {llm.difficulty(level)['label']} difficulty; judge its choices against that "
                    f"playstyle:\n{llm.difficulty(level)['style']}" if level else "")
        r = llm.review(result, log.get("lines", []), getattr(self, "_journal", None), s["llm_backend"],
                       s.get("llm_model", llm.DEFAULT_MODEL), s.get("anthropic_api_key"))
        return {k: r.get(k) for k in ("summary", "bot_decisions", "your_play", "report")}

    def open_lessons(self):
        if not os.path.exists(llm.LESSONS_FILE):
            os.makedirs(os.path.dirname(llm.LESSONS_FILE), exist_ok=True)
            with open(llm.LESSONS_FILE, "w", encoding="utf-8") as f:
                f.write(llm.LESSONS_TEMPLATE)
        os.startfile(llm.LESSONS_FILE)

    def open_file(self, path):
        if path and os.path.abspath(path).startswith(os.path.join(ROOT, "data")) and os.path.exists(path):
            os.startfile(path)

    @_safe
    def set_username(self, name):
        name = " ".join(str(name).split())[:24]
        if not name:
            raise ValueError("Pick a name with at least one letter.")
        self._settings["username"] = name
        self._save_settings()
        return name

    @_safe
    def stop_game(self):
        if self._match:
            self._match.stop()
            self._match = None
        return True

    @_safe
    def game_alive(self):
        return bool(self._match and self._match.alive())

    @_safe
    def card_images(self, names):
        found, _ = scryfall.lookup(names)
        return {n: found[n.lower()]["image"] for n in names if n.lower() in found}

    # ---- decks ----
    @_safe
    def list_decks(self):
        return decks.list_all()

    @_safe
    def load_deck(self, name, preset):
        return decks.load(name, preset)

    @_safe
    def save_deck(self, deck):
        decks.save(deck)
        return decks.list_all()

    @_safe
    def delete_deck(self, name):
        decks.delete(name)
        return decks.list_all()

    @_safe
    def rename_deck(self, old, new):
        new = " ".join(str(new).split())
        if not new:
            raise ValueError("Give the deck a name.")
        if new.lower() != old.lower() and any(d["name"].lower() == new.lower() and not d["preset"] for d in decks.list_all()):
            raise ValueError(f'You already have a deck called "{new}".')
        deck = decks.load(old)
        decks.save({**deck, "name": new})
        if decks._slug(new) != decks._slug(old):
            decks.delete(old)
        return decks.list_all()

    @_safe
    def duplicate_deck(self, name, preset):
        deck = decks.load(name, preset)
        mine = {d["name"].lower() for d in decks.list_all() if not d["preset"]}
        base = deck["name"] if preset else f"{deck['name']} (copy)"
        new, i = base, 2
        while new.lower() in mine:
            new, i = f"{base} {i}", i + 1
        deck = {**deck, "name": new}
        deck.pop("description", None)
        decks.save(deck)
        return {"name": new, "decks": decks.list_all()}

    @_safe
    def card_search(self, q):
        return scryfall.autocomplete(q)

    @_safe
    def set_pref(self, key, value):
        """Small UI preferences (seen the tour, last matchup, bot speed). The window runs in private mode, so
        browser storage doesn't survive a restart; these live in data/settings.json instead."""
        self._settings.setdefault("prefs", {})[str(key)] = value
        self._save_settings()
        return self._settings["prefs"]

    def open_difficulties(self):
        """Open the folder of difficulty files (one .md per level) so they can be edited or added to."""
        os.startfile(llm.DIFFICULTY_DIR)

    @_safe
    def check_deck(self, deck):
        return decks.resolve(deck)

    @_safe
    def edhrec_suggestions(self, deck):
        """EDHREC's popular / high-synergy cards for this deck's commander that it doesn't run yet."""
        commanders, entries = decks.commander_and_cards(deck)
        if not commanders:
            return []
        return edhrec.suggestions(commanders[0], [n for _, n in entries] + commanders)

    # ---- moxfield ----
    @_safe
    def moxfield_decks(self, username):
        self._settings["moxfield_user"] = username
        self._save_settings()
        return moxfield.user_decks(username)

    @_safe
    def moxfield_import(self, url):
        deck = moxfield.fetch(url)
        decks.save(deck)
        return deck

    # ---- forge ----
    @_safe
    def settings(self):
        d = self._settings.get("forge_dir")
        shown = {k: v for k, v in self._settings.items() if k != "anthropic_api_key"}  # never send the key back to the UI
        return {**shown, "forge_ok": bool(forge.find_jar(d)), "java": forge.java_version(),
                "deck_dir": forge.deck_dir(d) if d else None,
                "llm_models": llm.MODELS, "llm_model": self._settings.get("llm_model", llm.DEFAULT_MODEL),
                "difficulties": {k: {"label": v["label"], "blurb": v["blurb"]} for k, v in llm.difficulties().items()},
                "llm_has_key": bool(self._settings.get("anthropic_api_key")), "claude_cli": llm.claude_exe(),
                "anthropic_sdk": importlib.util.find_spec("anthropic") is not None}

    @_safe
    def set_llm(self, backend, model, api_key=""):
        if backend not in ("", "claude-code", "api") or model not in llm.MODELS:
            raise ValueError("Unknown advanced-bot setting.")
        self._settings.update(llm_backend=backend, llm_model=model)
        if api_key:
            self._settings["anthropic_api_key"] = api_key
        self._save_settings()
        return self.settings()

    @_safe
    def set_forge_dir(self, path):
        if not forge.find_jar(path):
            raise ValueError("No forge-gui-desktop-*-jar-with-dependencies.jar in that folder.")
        self._settings["forge_dir"] = path
        self._save_settings()
        return self.settings()

    @_safe
    def install_forge(self):
        if not (self._installer and not self._installer.done):
            self._installer = forge.Installer()
        return self._installer.status()

    @_safe
    def install_status(self):
        s = self._installer.status()
        if s["ok"] and s["done"]:
            self._settings["forge_dir"] = self._installer.target
            self._save_settings()
        return s

    @_safe
    def browse_forge_dir(self):
        picked = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
        return self.set_forge_dir(picked[0]) if picked else self.settings()

    def _export(self, ref):
        """Validate a saved/preset deck and write it into Forge's deck folder."""
        deck = decks.load(ref["name"], ref.get("preset", False))
        resolved = decks.resolve(deck)
        if not resolved["commanders"]:
            raise ValueError(f"{deck['name']}: no commander found.")
        rename = forge.alternate_names(self._forge_dir())  # e.g. Universes Within names -> Forge's names
        return forge.export(deck["name"], decks.to_dck(deck["name"], resolved, rename)), resolved["problems"]

    @_safe
    def play_in_forge(self, you, bot):
        warnings = []
        for ref in (you, bot):
            filename, problems = self._export(ref)
            forge.install(self._forge_dir(), filename)
            warnings += [f"{ref['name']}: {p}" for p in problems]
        forge.apply_prefs(self._forge_dir())
        forge.launch(self._forge_dir())
        return {"warnings": warnings}

    @_safe
    def start_sim(self, you, bot, games):
        if self._sim and not self._sim.done:
            raise ValueError("A simulation is already running.")
        self._forge_dir()
        files = [self._export(you)[0], self._export(bot)[0]]
        labels = [f"You: {you['name']}", f"Bot: {bot['name']}"]
        self._sim = forge.Sim(self._forge_dir(), files, labels, max(1, min(int(games), 200)))
        return self._sim.status()

    @_safe
    def sim_status(self):
        return self._sim.status() if self._sim else None

    @_safe
    def cancel_sim(self):
        if self._sim:
            self._sim.cancel()
        return True

    def open_url(self, url):
        if url.startswith("https://"):
            webbrowser.open(url)


def main():
    # Launched from the desktop shortcut (pythonw) there's no console, so keep errors in a log file.
    if sys.stderr is None:
        os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
        sys.stdout = sys.stderr = open(os.path.join(ROOT, "data", "app.log"), "a", encoding="utf-8", buffering=1)
    # The board is an ES module; some Windows registries map .js to text/plain, which WebView2 refuses to run.
    mimetypes.add_type("text/javascript", ".js")
    api = Api()
    window = webview.create_window("MTG Goldfish", os.path.join(ROOT, "web", "index.html"), js_api=api,
                                   width=1400, height=900, min_size=(1000, 650), maximized=True)
    window.events.closed += api.stop_game  # don't leave a Forge match running in the background
    webview.start(icon=os.path.join(ROOT, "assets", "goldfish.ico" if os.name == "nt" else "icon.png"))


if __name__ == "__main__":
    main()
