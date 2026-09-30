# Mechanics coverage

Checked against the Comprehensive Rules (2026-08-07): every keyword action (701) and keyword ability (702).
For each mechanic, the real paper cards using it were pulled from Scryfall and matched against Forge's card
scripts (`res/cardsfolder`, 33,978 scripts in Forge 2.0.15). A card with no script can't be played in Forge.

- **217** mechanics: every sampled paper card has a Forge script (incl. daybound/nightbound).
- **21** mechanics: a few cards missing (listed below).
- Not checked: generic verbs (exile, create, destroy, ...; core Forge effects) and mechanics not legal in
  Commander (Attractions/Visit, Space Sculptor: Un-sets; Set in Motion: Archenemy).

**Meld results and dungeons** (Brisela, Chittering Host, Hanweir the Writhing Township, Titania, Ragnarok, Mishra
Lost to Phyrexia, the dungeon cards) are scripted inside their front cards / as dungeon files, so they work.

**"Missing" cards that aren't:** 19 of the 21 names not found by name are *Universes Within* printings,
Wizards' in-universe renames of Secret Lair crossover cards. Forge has every one under its crossover name and
records the Universes Within name on the script (`Variant:UniversesWithin:FlavorName:...`), e.g. Cecily,
Haunted Mage = Eleven, the Mage; Gregor, Shrewd Magistrate = Glenn, the Voice of Calm. MTG Goldfish now
translates these (189 in total) when exporting decks to Forge (`forge.alternate_names`).

**Truly absent from Forge:** Fluttershy and Applejack (My Little Pony Secret Lair), which aren't legal in Commander.

## Human-side coverage (what the board can show and answer)

Every question Forge asks a human goes through `IGuiGame`, implemented in `bridge/src/goldfish/Bridge.java`;
Forge's static prompt helpers (`SGuiChoose`, `SOptionPane`) are routed to the board too (`RoutedGui`).
- Priority in every step (CR 117.3a); holds when you can act, otherwise each step is shown briefly.
- Declare attackers/blockers with highlighted eligible creatures; combat damage split among blockers and
  trample assignment are your choice (CR 510.1c, 702.19b).
- Scry/surveil (pick then order), library/graveyard/exile picks (tray), X costs, modes, optional costs,
  alternative costs, distribute damage/counters, replacement-effect and trigger ordering, votes, coin flips.
- Commander: return to command zone (CR 903.9a, needs the Commander variant applied), commander tax, commander damage.
- Player state: poison, energy, experience, rad, monarch, initiative, city's blessing, speed, the Ring, day/night.
- Cards: face-down (yours revealed to you), phased out, attachments, both faces of DFCs, counters, battles' defense counters.
