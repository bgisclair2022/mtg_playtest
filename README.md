# MTG Goldfish

A desktop app for testing Commander decks against a bot. Games run on [Forge](https://github.com/Card-Forge/forge)'s full rules engine and AI, played on MTG Goldfish's own board.

- **Play vs Bot:** a 1v1 Commander game in the app, with Scryfall card art. Forge applies every rule; the board shows what you can play (green), what you can pick (gold), attackers (red) and blockers (blue). The bot's turn plays out by itself at a watchable pace: each land, spell, attack and block is announced in the lane between the battlefields, and the game pauses on it (Bot speed: Slow 7s / Normal 4s / Fast 2s / Instant). If you hold an instant-speed play (e.g. an instant with a legal target, or an activated ability you can afford), the game stops at the bot's attack, blocks and end step, and whenever it casts something, so you can respond; otherwise it flows through. Triggered abilities (yours or the bot's, e.g. Esper Sentinel) show as a "Trigger!" card on the stack in that lane: if you can respond the game holds priority for you, otherwise they resolve after a moment to read. Scry and surveil ask which cards go to the bottom/graveyard, then let you order the rest. You tap your own mana: usable sources glow gold while paying (brighter for what Forge's Auto would pick), and floating mana in the pool is spent by clicking it (Cabal Coffers and other costed mana abilities work); tick Auto-pay mana to skip this. You get priority in every step (CR 117.3a): the game holds when you have an instant-speed play and otherwise shows each step briefly before passing, combat included (beginning, attackers, blockers, damage, end). Anything on the stack offers Pass priority or Respond; turns are counted in rounds; the bot's hand shows as card backs; your commander leaving play asks whether it goes to the command zone. Infinite loops (the same triggers going on the stack cycle after cycle) show an ∞ Loop banner and play out at full speed to their result; a loop of mandatory triggers that no player can stop and that changes nothing, or runs 500 cycles, is a draw (CR 104.4b). Stop to respond gives you priority back mid-loop. A loop you drive yourself (e.g. Kiki-Jiki + Zealous Conscripts) is offered as a shortcut once you've gone round it twice: Repeat ×5/×20/×100 redoes your same clicks and choices for real, so Jace still gets priority each time (CR 732.2a). Space/Enter presses the main button. The main buttons sit in an action bar beside your hand. "Stop for me" is set to *When it matters* by default: the game waits for you only when the bot casts or triggers something you can answer, when it attacks, at its end step, and after your blocks. *At every step I can act* restores the old behaviour. **To my turn** passes everything until your next main phase and **Pass turn** (Shift+Space) passes until the turn ends; both still ask you about blocks and choices. Nothing pops up over the board: every question (choices, targets, numbers, decisions, game over and the review) sits in the dock on the right, which widens when it needs room, and cards slide between zones as they move. While Forge loads, the loading screen shows art from both decks.
- **Advanced bot that learns (optional, Claude):** pick a difficulty before each match (Easy, Normal, Hard, Expert). Each level is a Markdown file in `difficulties/` describing how Jace plays, so you can edit them or add your own; difficulty never changes the Claude model. Claude plans the bot's turns, decides whether to answer your spells, and after each game reviews the log, grades the bot's decisions (and yours) and rewrites `data/bot-lessons.md`, which every later decision reads. Reports are saved in `data/reviews/`.
- **Home:** pick your deck and Jace's with art-backed pickers (your last matchup is remembered) and hit Play; your decks and Jace's presets sit below as tiles.
- **Avatar:** pick any card's art from Scryfall as your avatar (click your name at the top right, or Settings); it shows at the table and on Home.
- **Guided tour & Help:** first launch walks you through the app with spotlights on the real UI, and your first game gets a short tour of the board. The Help page (top right) is a searchable guide to every system and can replay both tours.
- **Decks:** paste any decklist (Moxfield, Arena or MTGO export) or import public decks from Moxfield by URL or username. The library has search, sorting and tags; decks can be duplicated, renamed, copied to the clipboard and deleted. The builder shows the deck as card art: add cards with Scryfall search, and use + / − / ★ (commander) / ✕ on hover.
- **Deck analysis:** card lookup (cached in `data/cards.json`; card art skips Universes Beyond printings whenever a regular printing exists), 100-card, singleton, color-identity and ban checks, mana curve, card types, ramp/draw/removal/wipe counts against common targets, color costs vs. land sources, and a bracket estimate from the Game Changers list.
- **Simulate:** Forge's AI pilots both decks headless and reports win rates, game length and how games ended.
- **Open in Forge instead:** exports both decks to Forge's own app, with its settings tuned so the bot's turns don't need clicking through.
- **Preset bot decks (built from EDHREC average decks, with cards Forge's AI can't play swapped out, then tuned to Bracket 3: 37 lands, more card draw, at most 3 Game Changers):** Black Removal (Sheoldred, the Apocalypse), Green Stompy (Ghalta, Primal Hunger), Red Burn (Torbran, Thane of Red Fell), White Stax (Thalia, Guardian of Thraben), Blue Control (Baral, Chief of Compliance), plus two multicolor decks that show off other commander rules: Sans-Red Counters (partner commanders Ishai, Ojutai Dragonspeaker + Reyhan, Last of the Abzan; four-color +1/+1 counters) and Naya Dinosaurs (Gishath, Sun's Avatar, with Kaheera, the Orphanguard as companion). See `presets/` and `edhrec.py`.
- **EDHREC card knowledge:** checking a deck lists popular, high-synergy cards for its commander that it doesn't run yet.

## Getting started

MTG Goldfish runs on **Windows 10/11**.

1. **Download**: on GitHub click **Code → Download ZIP**, and unzip it somewhere permanent (e.g. `Documents\MTG Goldfish`; the desktop shortcut points at this folder). With Git: `git clone https://github.com/bgisclair2022/mtg_playtest.git`.
2. **Double-click `setup.bat`.** That's it. It installs whatever is missing, skips whatever you already have, and opens the app when it's done:
   - **Python 3.12** (via `winget`) if you don't have Python 3.10+
   - the Python packages (`pywebview`, `anthropic`)
   - **Java** (Temurin 21 JDK, via `winget`; Windows may ask for permission once)
   - the **Forge** rules engine (about 300 MB) into `%USERPROFILE%\Forge`, unless Forge is already in `%USERPROFILE%\Forge` or `C:\Forge`
   - the app's small Forge bridge
   - an **MTG Goldfish** shortcut on your desktop and in the Start menu

   The first run takes a few minutes, mostly downloads. If a step fails, the window says what to do; fix it and run `setup.bat` again. Re-running it is also how you repair an install.
3. **Play**: the app opens with a short guided tour. Pick your deck and one of Jace's on **Home**, then **Play vs Jace**. Add your own decks on the **Decks** page (paste a list, build card by card, or import from Moxfield).

<details><summary>Installing the prerequisites by hand instead</summary>

If `winget` isn't available (older Windows 10), install these yourself, then run `setup.bat`:

| What | Where |
|---|---|
| **Python 3.10+** | https://www.python.org/downloads/ (tick **"Add python.exe to PATH"**) |
| **Java 17+ JDK** (not just a JRE) | https://adoptium.net/ (Temurin 17 or 21) |

</details>

### Optional: Advanced bot (Claude)

On **Settings → Advanced bot (Claude)** you can let Claude plan the bot's mulligans and turns (Forge still plays the cards). Pick one backend:

- **Claude Code (your Claude subscription):** install [Claude Code](https://claude.com/claude-code) or the Claude desktop app, then run `claude` once in a terminal to log in.
- **Claude API key (pay per use):** paste an API key from https://platform.claude.com, or leave the box blank to use the `ANTHROPIC_API_KEY` environment variable. The key is stored only in `data/settings.json` on your machine.

If Claude is slow or fails, the bot falls back to Forge's own AI.

### Updating

```bat
git pull
```

Then run `setup.bat` again (it only installs what changed). With the ZIP, download the new one over the old folder and do the same.

### Troubleshooting

- The shortcut runs without a console window; errors go to `data/app.log`, and in-game errors to `data/logs/`. Run `python app.py` from the folder to see errors live.
- **"javac not found" / the game won't start:** run `setup.bat` again; it installs the Java JDK if it's missing. (A JRE alone isn't enough: the bridge needs `javac`.)
- **`setup.bat` can't find or install Python:** install Python 3.10+ from python.org with "Add python.exe to PATH" ticked, then run `setup.bat` again.
- **Moxfield import fails:** on the deck page use *Export → Copy for MTGA* and paste it into a new deck.

## How in-app games work

`bridge/src/goldfish/Bridge.java` starts a Forge `HostedMatch` (you vs Forge AI) and implements Forge's `IGuiGame`, the interface its desktop, mobile and network clients use. It serves the game over `http://127.0.0.1:<port>`:

- `GET /state?v=N`: a JSON snapshot, long-polled until something changes.
- `POST /act`: card and player clicks and the OK/Cancel buttons, forwarded to Forge's own input handling.
- `POST /answer`: replies to Forge's questions (choose cards, yes/no, numbers, dividing damage).

`web/main.js` (with `decks.js`, `help.js`, `tour.js` and the shared `core.js`) is the app around it; `web/board.js` renders the snapshot (Preact + htm, vendored in `web/vendor/`, no build step) and sends clicks back. `forge.py` compiles the bridge against your Forge jar when needed (`bridge/classes/`) and launches it.

## Notes

- Moxfield has no official API; the importer reads the same public JSON as moxfield.com. Private decks aren't reachable. If Moxfield blocks the request, use *Export → Copy for MTGA* on the deck page and paste it into a new deck.
- Deck files for Forge are written to `data/forge-decks/`. "Open in Forge" copies them (and its preferences) into Forge's own folder through a child process, because Microsoft Store Python silently sandboxes its own writes under `AppData`.
- Forge sims default to a 300-second clock per game; games that hit it count as draws.
- Files: `app.py` (window + JS API), `decks.py`, `scryfall.py`, `moxfield.py`, `forge.py` (install, sims, bridge), `llm.py` (advanced bot), `bridge/` (Java), `web/` (UI), `assets/` (icon).
