// Help page: a searchable guide to every system, plus buttons to replay the tours.
import { html, useState, useLayoutEffect } from './vendor/preact-htm.js';

const K = (k) => html`<kbd>${k}</kbd>`;
const SECTIONS = [
  { id: 'start', title: 'Getting started', body: html`
    <p>MTG Goldfish lets you test Commander decks 1-on-1 against <b>Jace</b>, a bot running on Forge's full rules engine.</p>
    <ol>
      <li><b>Set up Forge</b> once on the Settings page (one click downloads it; it needs Java 17+).</li>
      <li><b>Add a deck</b> on the Decks page: paste a list, build one card by card, or import from Moxfield.</li>
      <li><b>Pick a matchup</b> on Home: your deck against one of Jace's decks (or any deck of yours).</li>
      <li><b>Play vs Jace.</b> Jace's turns play out by themselves at a speed you can follow.</li>
    </ol>` },
  { id: 'decks', title: 'Decks & the deck builder', body: html`
    <p>The left side is your <b>library</b>: search by name, commander or tag, sort it, and filter by tag. <b>Jace's decks</b> are presets; use <i>Duplicate to edit</i> to make your own copy.</p>
    <p>A deck has three views:</p>
    <ul>
      <li><b>Cards</b>: the deck as card art, grouped by type. Type in <i>Add a card…</i> to search Scryfall. Hover a card for <b>+</b> / <b>−</b>, <b>★</b> (make it the commander) and <b>✕</b> (remove).</li>
      <li><b>Text</b>: the raw list. Moxfield, Arena and MTGO formats all paste in. Mark the commander with a <i>Commander</i> section, <i>*CMDR*</i>, or the Commander field. Put a companion in the Companion field (it sits outside the 100).</li>
      <li><b>Analysis</b>: see below.</li>
    </ul>
    <p>Tags (e.g. "combo", "budget") go under the deck name. <b>Copy list</b> puts the deck on the clipboard for Moxfield or Arena. ${K('Ctrl')}+${K('S')} saves.</p>` },
  { id: 'analysis', title: 'Deck analysis & brackets', body: html`
    <ul>
      <li><b>Legality</b>: 100 cards, singleton, color identity, banned cards, companion checks.</li>
      <li><b>Mana curve</b> and <b>card types</b>.</li>
      <li><b>What the deck does</b>: ramp, card draw, removal, board wipes, counterspells, tutors, protection. It's read from rules text, so it's a rough guide. The targets (10 ramp, 10 draw, 8 removal, 2 wipes) are common Commander rules of thumb.</li>
      <li><b>Colors</b>: each color's share of mana symbols next to how many lands make it. "low" means that color may be hard to cast.</li>
      <li><b>Bracket estimate</b> (1–5): counts cards on the official Game Changers list (Bracket 3 allows up to 3), mass land destruction and extra turns. It can't see two-card combos.</li>
      <li><b>EDHREC</b>: popular, high-synergy cards for your commander that the deck doesn't run, with one-click <i>+ Add</i>.</li>
    </ul>` },
  { id: 'board', title: 'The game board', body: html`
    <ul>
      <li><b>Top and bottom bars</b>: each player's life (click it when targeting a player), hand, library, graveyard and exile (click to look), commander damage, counters, and your <b>mana pool</b>.</li>
      <li><b>Battlefields</b>: creatures and other permanents near the middle, lands behind them. Identical lands stack with a ×count.</li>
      <li><b>The lane</b> between them: turn and phase, then the <b>stack</b>. Triggers show as <i>Trigger!</i>, and what Jace just did appears here while the game pauses on it.</li>
      <li><b>Action bar</b> (next to your hand): what the game wants, and the buttons. Short questions (yes/no, numbers) appear here too.</li>
      <li><b>Dock</b> (right): bigger choices (pick cards), the graveyard/exile viewer, cards you can use from them, the log, and settings.</li>
    </ul>
    <p><b>Colors</b>: green glow = you can play it · gold = pick it / can attack or block / mana source · red = attacking or targeted · blue = blocking.</p>` },
  { id: 'priority', title: 'Priority, stops & passing', body: html`
    <p>You get priority in every step (the rules call this CR 117.3a). To save clicks the game passes for you when nothing matters. <b>Stop for me</b> (bottom of the dock) chooses when it waits:</p>
    <ul>
      <li><b>When it matters</b> (default): when Jace casts or triggers something you could answer, when Jace attacks, at Jace's end step, and after your blocks.</li>
      <li><b>At every step I can act</b>: any step where you have an instant or ability you can use.</li>
      <li><b>At every step</b>: never passes for you.</li>
    </ul>
    <p><b>To my turn</b> passes everything until your next main phase. <b>Pass turn</b> (${K('Shift')}+${K('Space')}) passes until the turn ends. Both still stop for blocks and anything you must choose, and <b>Stop</b> cancels them.</p>
    <p>When something is on the stack you'll see <b>Pass priority</b> (let it resolve) or <b>Respond</b> (then click a glowing card).</p>` },
  { id: 'mana', title: 'Casting & paying mana', body: html`
    <p>Click a green card to cast it or use its ability. Then pay: click lands and other mana sources (gold), or spend floating mana by clicking its symbol in your pool. Tick <b>Auto-pay mana</b> in the dock to let Forge pick the lands for you.</p>` },
  { id: 'combat', title: 'Combat', body: html`
    <ul>
      <li><b>Attacking</b>: click your creatures (gold) to attack, or <i>Attack with all</i>, then <i>Confirm attack</i>.</li>
      <li><b>Blocking</b>: when Jace attacks, the action bar lists the attackers and the damage coming through. Click one of your gold creatures to block the selected attacker, click another attacker to switch, then <i>Confirm blocks</i>. A blocker shows "blocks X".</li>
      <li><b>Damage</b>: if you divide damage (trample, several blockers), the dock asks you to assign it.</li>
    </ul>` },
  { id: 'commander', title: 'Commander rules', body: html`
    <p>Your commander starts in the command zone (top-right of your bar) with its tax shown. When it would go to the graveyard or exile you're asked whether to move it back to the command zone. 21 combat damage from one commander loses the game. Companions start outside the game: pay {3} (a special action) to put yours into your hand.</p>` },
  { id: 'jace', title: 'Jace, Smarter Jace & reviews', body: html`
    <p>Jace is Forge's AI. <b>Speed</b> (dock) sets how long the game pauses on each of Jace's actions.</p>
    <p><b>Difficulty</b> (with Smarter Jace on): pick it on Home or Play before each match. <b>Easy</b> plays like a relaxed casual player and rarely holds up answers; <b>Normal</b> is solid and uses what Jace has learned; <b>Hard</b> plays tight, holding interaction for real threats; <b>Expert</b> is ruthless and counts lethal every turn. Each level is a Markdown file in <i>difficulties/</i> (Settings → Open difficulty files): edit one to change how Jace plays, or add a new .md to add a level. Every level uses the same Claude model, so difficulty doesn't change what a game costs.</p>
    <p><b>Smarter Jace</b> (Settings) lets Claude plan Jace's turns, mulligans, attacks and responses. After each game Claude reviews the log, grades Jace's key decisions and your play, and updates <i>data/bot-lessons.md</i>, which later games read. It uses your Claude subscription (Claude Code) or an API key.</p>` },
  { id: 'sim', title: 'Simulations', body: html`
    <p>On the Play page, <b>Simulate</b> runs Forge AI vs Forge AI with your two decks, headless, many games in a row, and reports win rates, average game length and how games ended. Good for comparing versions of a deck.</p>` },
  { id: 'keys', title: 'Keyboard shortcuts', body: html`
    <table class="keys">
      <tr><td>${K('Space')} / ${K('Enter')}</td><td>Main button (pass priority, confirm, OK)</td></tr>
      <tr><td>${K('Esc')}</td><td>Cancel / close</td></tr>
      <tr><td>${K('Shift')}+${K('Space')}</td><td>Pass turn</td></tr>
      <tr><td>${K('Ctrl')}+${K('S')}</td><td>Save the deck you're editing</td></tr>
      <tr><td>${K('←')} ${K('→')}</td><td>Move through a tour</td></tr>
    </table>` },
  { id: 'trouble', title: 'Troubleshooting', body: html`
    <ul>
      <li><b>"Forge isn't set up"</b>: Settings → Download & install Forge, or point to an existing Forge folder. Install Java 17+ from adoptium.net if Settings says Java isn't found.</li>
      <li><b>A card isn't found</b>: check the spelling on the Text tab; the list uses Scryfall names.</li>
      <li><b>The game stops responding</b>: leave and start again. Details for bug reports are in <i>data/logs/</i> (one log per game) and <i>data/app.log</i>.</li>
      <li><b>Moxfield import fails</b>: the deck must be public. Otherwise use Moxfield's Export → Copy and paste the list.</li>
    </ul>` },
];

export function HelpView({ onTour, onBoardTips }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null); // ids of sections whose text matches the search
  useLayoutEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const want = q.trim().toLowerCase();
    setHits(SECTIONS.filter((s) => document.getElementById('h-' + s.id)?.textContent.toLowerCase().includes(want)).map((s) => s.id));
  }, [q]);
  const visible = (s) => !hits || hits.includes(s.id);
  return html`<section class="view help-view">
    <aside class="help-nav">
      <input placeholder="Search help…" value=${q} onInput=${(e) => setQ(e.target.value)} />
      ${SECTIONS.filter(visible).map((s) => html`<a href=${'#' + s.id} onClick=${(e) => { e.preventDefault(); document.getElementById('h-' + s.id)?.scrollIntoView({ behavior: 'smooth' }); }}>${s.title}</a>`)}
      <div class="help-tours">
        <button class="primary" onClick=${onTour}>Take the app tour</button>
        <button onClick=${onBoardTips}>Show board tips next game</button>
      </div>
    </aside>
    <div class="help-body">
      <h1>Help</h1>
      ${SECTIONS.map((s) => html`<article id=${'h-' + s.id} key=${s.id} hidden=${!visible(s)}><h2>${s.title}</h2>${s.body}</article>`)}
      ${hits && !hits.length && html`<p class="muted">Nothing matches "${q}".</p>`}
    </div>
  </section>`;
}
