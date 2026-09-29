# MTG Goldfish

A desktop app for testing Commander decks against a bot. Games run on [Forge](https://github.com/Card-Forge/forge)'s full rules engine and AI, played on MTG Goldfish's own board.

- **Play vs Bot:** a 1v1 Commander game in the app, with Scryfall card art. Forge applies every rule; the board shows what you can play (green), what you can pick (gold), attackers (red) and blockers (blue). The bot's turn plays out by itself at a watchable pace: each land, spell, attack and block is announced in a banner, and the game pauses on it (Bot speed: Slow 7s / Normal 4s / Fast 2s / Instant). If you hold an instant-speed play (e.g. an instant with a legal target, or an activated ability you can afford), the game stops at the bot's attack, blocks and end step, and whenever it casts something, so you can respond; otherwise it flows through. Triggered abilities (yours or the bot's, e.g. Esper Sentinel) pop up a "Trigger!" card and sit on the stack: if you can respond the game holds priority for you, otherwise they resolve after a moment to read. Scry and surveil ask which cards go to the bottom/graveyard, then let you order the rest. You tap your own mana: usable sources glow gold while paying (brighter for what Forge's Auto would pick), and floating mana in the pool is spent by clicking it (Cabal Coffers and other costed mana abilities work); tick Auto-pay mana to skip this. Anything on the stack offers Pass priority or Respond; turns are counted in rounds; the bot's hand is visible; your commander leaving play asks whether it goes to the command zone. Space/Enter presses the main button.
- **Decks:** paste any decklist (Moxfield, Arena or MTGO export) or import public decks from Moxfield by URL or username. Decks are saved locally.
- **Scryfall check:** card lookup (cached in `data/cards.json`), 100-card, singleton, color-identity and ban checks, mana curve, and a card image grid.
- **Simulate:** Forge's AI pilots both decks headless and reports win rates, game length and how games ended.
- **Open in Forge instead:** exports both decks to Forge's own app, with its settings tuned so the bot's turns don't need clicking through.
- **Preset bot decks:** Green Stompy, Red Burn and Black Removal (see `presets/`).

## Getting started

MTG Goldfish runs on **Windows**. Setup takes about 10 minutes, most of it downloads.

### 1. Install the prerequisites

| What | Why | Where |
|---|---|---|
| **Python 3.10+** | runs the app | https://www.python.org/downloads/ (tick **"Add python.exe to PATH"** in the installer) |
| **Java 17+ JDK** (not just a JRE) | runs Forge, and `javac` compiles the app's small Forge bridge the first time you play | https://adoptium.net/ (Temurin 17 or 21; tick **"Set JAVA_HOME"** and **"Add to PATH"**) |
| **Git** (optional) | to clone and update the app | https://git-scm.com/download/win |

Check both in a new terminal:

```bat
python --version
javac -version
```

### 2. Get the code

```bat
git clone https://github.com/bgisclair2022/mtg_playtest.git
cd mtg_playtest
```

No Git? Click **Code → Download ZIP** on GitHub and unzip it somewhere permanent (the desktop shortcut points at this folder, so don't leave it in a temp folder).

### 3. Run setup (one time)

Double-click **`setup.bat`**. It installs the Python packages from `requirements.txt` (`pywebview`, `anthropic`) and adds an **MTG Goldfish** shortcut to your desktop and Start menu.

### 4. Install Forge

Open **MTG Goldfish** from the desktop, go to the **Settings** tab and click **Download & install Forge**. It installs to `%USERPROFILE%\Forge`. If you already have Forge, `%USERPROFILE%\Forge` and `C:\Forge` are detected automatically, and any other folder can be picked on the same tab.

### 5. Play

1. **Decks** tab: paste a decklist (Moxfield, Arena or MTGO export), or import a public Moxfield deck by URL or username. Or just use one of the preset bot decks.
2. **Test vs Bot** tab: pick your deck and the bot's deck, then start a game or run a simulation.

The first game takes a little longer while the bridge compiles against your Forge install.

### Optional: Advanced bot (Claude)

On **Settings → Advanced bot (Claude)** you can let Claude plan the bot's mulligans and turns (Forge still plays the cards). Pick one backend:

- **Claude Code (your Claude subscription):** install [Claude Code](https://claude.com/claude-code) or the Claude desktop app, then run `claude` once in a terminal to log in.
- **Claude API key (pay per use):** paste an API key from https://platform.claude.com, or leave the box blank to use the `ANTHROPIC_API_KEY` environment variable. The key is stored only in `data/settings.json` on your machine.

If Claude is slow or fails, the bot falls back to Forge's own AI.

### Updating

```bat
git pull
```

Then re-run `setup.bat` if `requirements.txt` changed.

### Troubleshooting

- The shortcut runs without a console window; errors go to `data/app.log`, and in-game errors to `data/bridge.log`. Run `python app.py` from the folder to see errors live.
- **"javac not found" / the game won't start:** you installed a JRE instead of a JDK, or Java isn't on PATH. Reinstall Temurin JDK with "Add to PATH" ticked and open a new terminal.
- **`python` opens the Microsoft Store:** install Python from python.org with "Add to PATH" ticked, or turn off the `python.exe` App execution alias in Windows settings.
- **Moxfield import fails:** on the deck page use *Export → Copy for MTGA* and paste it into a new deck.

## How in-app games work

`bridge/src/goldfish/Bridge.java` starts a Forge `HostedMatch` (you vs Forge AI) and implements Forge's `IGuiGame`, the interface its desktop, mobile and network clients use. It serves the game over `http://127.0.0.1:<port>`:

- `GET /state?v=N`: a JSON snapshot, long-polled until something changes.
- `POST /act`: card and player clicks and the OK/Cancel buttons, forwarded to Forge's own input handling.
- `POST /answer`: replies to Forge's questions (choose cards, yes/no, numbers, dividing damage).

`web/game.js` renders the snapshot and sends clicks back. `forge.py` compiles the bridge against your Forge jar when needed (`bridge/classes/`) and launches it.

## Notes

- Moxfield has no official API; the importer reads the same public JSON as moxfield.com. Private decks aren't reachable. If Moxfield blocks the request, use *Export → Copy for MTGA* on the deck page and paste it into a new deck.
- Deck files for Forge are written to `data/forge-decks/`. "Open in Forge" copies them (and its preferences) into Forge's own folder through a child process, because Microsoft Store Python silently sandboxes its own writes under `AppData`.
- Forge sims default to a 300-second clock per game; games that hit it count as draws.
- Files: `app.py` (window + JS API), `decks.py`, `scryfall.py`, `moxfield.py`, `forge.py` (install, sims, bridge), `llm.py` (advanced bot), `bridge/` (Java), `web/` (UI), `assets/` (icon).
