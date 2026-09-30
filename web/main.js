// The app shell: header, Home, Decks, Play (matchup + simulations), Settings and Help, plus the first-boot
// name prompt and guided tour. The game board itself lives in board.js.
import { html, render, useState, useEffect, useRef } from './vendor/preact-htm.js';
import { api, ready, call, toast, prefs, loadPrefs, setPref, artCrop, cardImages, commanderNames, Modal, useFocus } from './core.js';
import { DecksView } from './decks.js';
import { HelpView } from './help.js';
import { Tour } from './tour.js';

const refOf = (d) => d && { name: d.name, preset: d.preset };
const sameRef = (a, b) => a && b && a.name === b.name && !!a.preset === !!b.preset;

// ---- deck picker: art + name, opens a list ----
function DeckPicker({ label, decks, value, onChange, art }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({});
  const ref = useRef();
  const toggle = () => { // open downward or upward, whichever has more room, and never past the window edge
    if (!open) {
      const r = ref.current.querySelector('.picker-btn').getBoundingClientRect();
      const below = innerHeight - r.bottom - 16, above = r.top - 16;
      setPlace(below >= 300 || below >= above ? { maxHeight: `${Math.min(420, below)}px` } : { maxHeight: `${Math.min(420, above)}px`, top: 'auto', bottom: '100%', marginBottom: '6px' });
    }
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    addEventListener('mousedown', close);
    return () => removeEventListener('mousedown', close);
  }, [open]);
  const cur = decks.find((d) => sameRef(d, value));
  const img = cur && art[commanderNames(cur)[0]];
  const row = (d) => { const a = art[commanderNames(d)[0]]; return html`<button key=${(d.preset ? 'p' : 'm') + d.name} class=${'pick-row' + (sameRef(d, value) ? ' on' : '')}
      onClick=${() => { onChange(refOf(d)); setOpen(false); }}>
      <span class="thumb" style=${a ? { backgroundImage: `url("${artCrop(a)}")` } : null}></span>
      <span><b>${d.name}</b><small>${commanderNames(d).join(' + ')}</small></span></button>`; };
  return html`<div class="picker" ref=${ref}>
    <span class="picker-label">${label}</span>
    <button class="picker-btn" onClick=${toggle}>
      <span class="thumb big" style=${img ? { backgroundImage: `url("${artCrop(img)}")` } : null}></span>
      <span class="picker-text"><b>${cur?.name || 'Choose a deck'}</b><small>${cur ? commanderNames(cur).join(' + ') : ''}</small></span>
      <span class="caret">▾</span>
    </button>
    ${open && html`<div class="pick-menu" style=${place}>
      ${decks.some((d) => !d.preset) && html`<div class="pick-head">My decks</div>`}${decks.filter((d) => !d.preset).map(row)}
      <div class="pick-head">Jace's decks</div>${decks.filter((d) => d.preset).map(row)}
    </div>`}
  </div>`;
}

// ---- Smarter Jace difficulty (only when Claude is connected) ----
function Difficulty({ settings, value, onChange, go }) {
  if (!settings) return null;
  if (!settings.llm_backend) {
    return html`<div class="difficulty off" data-tour="difficulty">Jace: Forge AI · <a href="#" onClick=${(e) => { e.preventDefault(); go('settings'); }}>connect Claude</a> for Smarter Jace and difficulty levels</div>`;
  }
  const levels = settings.difficulties || {};
  const cur = levels[value] || levels.normal;
  return html`<div class="difficulty" data-tour="difficulty">
    <span class="picker-label">Smarter Jace difficulty</span>
    <div class="seg">${Object.entries(levels).map(([k, d]) => html`<button class=${'lvl-' + k + (value === k ? ' on' : '')} onClick=${() => onChange(k)}>${d.label}</button>`)}</div>
    <div class="blurb">${cur?.blurb}</div>
  </div>`;
}

// ---- home ----
function DeckTile({ d, art, onOpen, onPlay }) {
  const img = art[commanderNames(d)[0]];
  return html`<div class="deck-tile" onClick=${onOpen} title=${d.description || ''}>
    <div class="art" style=${img ? { backgroundImage: `url("${artCrop(img)}")` } : null}></div>
    <div class="info"><b>${d.name}</b><small>${commanderNames(d).join(' + ') || 'no commander'}</small>
      ${(d.tags || []).length > 0 && html`<span class="mini-tags">${d.tags.map((t) => html`<i>${t}</i>`)}</span>`}</div>
    <span class=${'cnt' + (d.count === 100 ? '' : ' off')}>${d.count}</span>
    <button class="tile-play" title=${d.preset ? 'Play against this deck' : 'Play with this deck'} onClick=${(e) => { e.stopPropagation(); onPlay(); }}>▶</button>
  </div>`;
}

function Home({ decks, match, setMatch, art, settings, user, go, onPlay, openDeck, onTour, level, setLevel }) {
  const you = decks.find((d) => sameRef(d, match.you)), bot = decks.find((d) => sameRef(d, match.bot));
  const heroImg = art[commanderNames(you)[0]] || art[commanderNames(bot)[0]];
  const mine = decks.filter((d) => !d.preset), presets = decks.filter((d) => d.preset);
  return html`<section class="view home">
    <div class="hero">
      <div class="hero-art" key=${heroImg || 'none'} style=${heroImg ? { backgroundImage: `url("${artCrop(heroImg)}")` } : null}></div>
      <div class="hero-shade"></div>
      <div class="hero-content">
        <div class="hero-text">
          <h1>${user ? `Welcome back, ${user}` : 'Welcome'}</h1>
          <p>Test your Commander decks against Jace, a bot on Forge's full rules engine.</p>
        </div>
        <div class="matchup-card" data-tour="matchup">
          <${DeckPicker} label="Your deck" decks=${decks} value=${match.you} art=${art} onChange=${(r) => setMatch({ ...match, you: r })} />
          <div class="vs">vs</div>
          <${DeckPicker} label="Jace's deck" decks=${decks} value=${match.bot} art=${art} onChange=${(r) => setMatch({ ...match, bot: r })} />
          <${Difficulty} settings=${settings} value=${level} onChange=${setLevel} go=${go} />
          <button class="primary big" data-tour="play-cta" disabled=${!you || !bot} onClick=${onPlay}>▶ Play vs Jace</button>
          <div class="hero-links"><a href="#" onClick=${(e) => { e.preventDefault(); go('play'); }}>Simulate this matchup</a></div>
        </div>
      </div>
    </div>
    ${settings && !settings.forge_ok && html`<div class="banner warn"><b>Forge isn't set up yet.</b> The game engine is a one-time download.
      <button class="primary" onClick=${() => go('settings')}>Set up Forge</button></div>`}
    ${!prefs.tourDone && html`<div class="banner"><b>New here?</b> A one-minute tour shows where everything is.
      <button class="primary" onClick=${onTour}>Take the tour</button></div>`}
    <div class="shelf">
      <div class="shelf-head"><h2>Your decks</h2><button class="link" onClick=${() => go('decks')}>Manage decks →</button></div>
      <div class="tiles">
        ${mine.map((d) => html`<${DeckTile} key=${d.name} d=${d} art=${art} onOpen=${() => openDeck(refOf(d))}
          onPlay=${() => { setMatch({ ...match, you: refOf(d) }); toast(`Your deck: ${d.name}`); }} />`)}
        <button class="deck-tile add" onClick=${() => openDeck(null)}><span>+</span>New deck</button>
      </div>
    </div>
    <div class="shelf">
      <div class="shelf-head"><h2>Jace's decks</h2><span class="muted">Built from EDHREC: five mono-color archetypes, a partner pair and a companion deck</span></div>
      <div class="tiles">${presets.map((d) => html`<${DeckTile} key=${d.name} d=${d} art=${art} onOpen=${() => openDeck(refOf(d))}
        onPlay=${() => { setMatch({ ...match, bot: refOf(d) }); toast(`Jace's deck: ${d.name}`); }} />`)}</div>
    </div>
  </section>`;
}

// ---- play: matchup, Forge, simulations ----
function Play({ decks, match, setMatch, art, onPlay, settings, level, setLevel, go }) {
  const [games, setGames] = useState(10);
  const [sim, setSim] = useState(null);
  const [msg, setMsg] = useState(null);
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  const poll = () => { timer.current = setTimeout(async () => { const s = await call('sim_status'); setSim(s); if (s && !s.done) poll(); }, 1500); };
  useEffect(() => { call('sim_status').then((s) => { setSim(s); if (s && !s.done) poll(); }); }, []);
  const ok = match.you && match.bot;
  return html`<section class="view play-view">
    <div class="panel">
      <h2>Matchup</h2>
      <div class="matchup-row">
        <${DeckPicker} label="Your deck" decks=${decks} value=${match.you} art=${art} onChange=${(r) => setMatch({ ...match, you: r })} />
        <div class="vs">vs</div>
        <${DeckPicker} label="Jace's deck" decks=${decks} value=${match.bot} art=${art} onChange=${(r) => setMatch({ ...match, bot: r })} />
      </div>
      <div class="play-diff"><${Difficulty} settings=${settings} value=${level} onChange=${setLevel} go=${go} /></div>
      <div class="row">
        <button class="primary big" disabled=${!ok} onClick=${onPlay}>▶ Play vs Jace</button>
        <button disabled=${!ok} onClick=${async () => { const r = await call('play_in_forge', match.you, match.bot); setMsg(r.warnings); }}>Open in Forge instead</button>
        <span class="muted">Forge's own app: Commander → pick the decks, opponent = AI.</span>
      </div>
      ${msg && html`<p class="ok">Decks exported and Forge is starting.</p>${msg.length > 0 && html`<ul class="problems">${msg.map((w) => html`<li>${w}</li>`)}</ul>`}`}
    </div>
    <div class="panel">
      <h2>Simulate <span class="muted">Forge AI vs Forge AI</span></h2>
      <p class="muted">Forge pilots both decks, headless, game after game, and reports who wins and how. Each game takes about 10–60 seconds.</p>
      <div class="row">
        <label class="inline">Games <input type="number" min="1" max="200" value=${games} onInput=${(e) => setGames(+e.target.value)} /></label>
        <button class="primary" disabled=${!ok || (sim && !sim.done)} onClick=${async () => { setSim(await call('start_sim', match.you, match.bot, games)); poll(); }}>Run simulation</button>
        ${sim && !sim.done && html`<button class="danger" onClick=${() => call('cancel_sim')}>Cancel</button>`}
      </div>
      ${sim && html`<${SimResult} s=${sim} />`}
    </div>
  </section>`;
}

function SimResult({ s }) {
  const [a, b] = s.labels, played = s.played || 0;
  const pct = (n) => (played ? Math.round((n / played) * 100) : 0);
  return html`<div class="sim">
    <div class="muted">${s.done ? 'Finished' : 'Running'}: ${played}/${s.games} games · ${s.elapsed}s</div>
    <div class="bar"><div style=${{ width: `${(played / s.games) * 100}%` }}></div></div>
    ${s.error && html`<pre class="tail bad">${s.error}</pre>`}
    ${played > 0 && html`<div class="split">
        ${s.wins[a] > 0 && html`<div class="a" style=${{ width: `${pct(s.wins[a])}%` }}>${a} ${pct(s.wins[a])}%</div>`}
        ${s.wins[b] > 0 && html`<div class="b" style=${{ width: `${pct(s.wins[b])}%` }}>${b} ${pct(s.wins[b])}%</div>`}
        ${s.draws > 0 && html`<div class="d" style=${{ width: `${pct(s.draws)}%` }}>Draw ${pct(s.draws)}%</div>`}</div>
      <table><tr><th>Deck</th><th>Wins</th><th>Win rate</th></tr>
        <tr><td>${a}</td><td>${s.wins[a]}</td><td>${pct(s.wins[a])}%</td></tr>
        <tr><td>${b}</td><td>${s.wins[b]}</td><td>${pct(s.wins[b])}%</td></tr>
        <tr><td>Draws / timeouts</td><td>${s.draws}</td><td>${pct(s.draws)}%</td></tr></table>
      <p class="muted">Average game: ${s.avg_seconds ?? '–'}s${s.avg_turns ? ` · ${s.avg_turns} rounds` : ''}
        ${Object.keys(s.reasons).length > 0 && html` · Endings: ${Object.entries(s.reasons).map(([r, n]) => `${r} (${n})`).join(' · ')}`}</p>`}
    <details><summary class="muted">Forge output</summary><pre class="tail">${s.tail.join('\n')}</pre></details>
  </div>`;
}

// ---- settings ----
function Settings({ settings, reload, user, onName, onTour }) {
  const s = settings;
  const [dir, setDir] = useState(s?.forge_dir || '');
  const [backend, setBackend] = useState(s?.llm_backend || '');
  const [model, setModel] = useState(s?.llm_model);
  const [key, setKey] = useState('');
  const [install, setInstall] = useState(null);
  useEffect(() => { setDir(s?.forge_dir || ''); setBackend(s?.llm_backend || ''); setModel(s?.llm_model); }, [s]);
  if (!s) return html`<section class="view"><div class="spinner"></div></section>`;
  const runInstall = async () => {
    let st = await call('install_forge');
    while (!st.done) { setInstall(st); await new Promise((r) => setTimeout(r, 1000)); st = await call('install_status'); }
    setInstall(st);
    if (st.ok) { toast('Forge installed'); reload(); }
  };
  return html`<section class="view settings-view">
    <div class="panel" data-tour="forge-setup">
      <h2>Forge <span class=${s.forge_ok ? 'ok' : 'bad'}>${s.forge_ok ? '● ready' : '● not set up'}</span></h2>
      <p class="muted">Forge is the open-source rules engine Jace plays on. ${s.forge_ok ? html`Decks export to <code>${s.deck_dir}</code>.` : ''}</p>
      <p>Java: ${s.java ? html`<span class="ok">${s.java}</span>` : html`<span class="bad">not found</span>: install <a href="#" onClick=${(e) => { e.preventDefault(); api.open_url('https://adoptium.net/'); }}>Java 17+</a>`}</p>
      <div class="row">
        <input value=${dir} placeholder="Folder containing forge-gui-desktop-…-jar-with-dependencies.jar" onInput=${(e) => setDir(e.target.value)} />
        <button onClick=${async () => { await call('set_forge_dir', dir.trim()); reload(); toast('Forge folder saved'); }}>Use this folder</button>
        <button onClick=${async () => { await call('browse_forge_dir'); reload(); }}>Browse…</button>
      </div>
      ${!s.forge_ok && html`<div class="row"><button class="primary" disabled=${install && !install.done} onClick=${runInstall}>Download & install Forge</button>
        <span class="muted">About 300 MB from Forge's GitHub into <code>%USERPROFILE%\\Forge</code>.</span></div>`}
      ${install && html`<div class="muted">${install.stage}</div><div class="bar"><div style=${{ width: `${install.progress * 100}%` }}></div></div>${install.error && html`<p class="bad">${install.error}</p>`}`}
    </div>
    <div class="panel">
      <h2>Smarter Jace <span class="muted">Claude</span></h2>
      <p class="muted">Claude reads the game once per Jace turn (and at the mulligan) and tells Forge's AI what to cast, what to hold and how to attack. It also decides whether to answer your spells, and reviews each game to update <code>data/bot-lessons.md</code>. If Claude is slow or fails, Jace plays as usual. Simulations don't use it.</p>
      <p class="muted">Once connected, pick a <b>difficulty</b> before each match on Home or Play. Each level is a Markdown file in <code>difficulties/</code> describing how Jace should play; edit them, or add a new <code>.md</code> to add a level. Difficulty never changes the model below, so it costs the same.</p>
      <div class="row">
        <select value=${backend} onChange=${(e) => setBackend(e.target.value)}>
          <option value="">Off (Forge AI only)</option>
          <option value="claude-code">Claude Code (your Claude subscription)</option>
          <option value="api">Claude API key (pay per use)</option>
        </select>
        ${backend && html`<select value=${model} onChange=${(e) => setModel(e.target.value)}>${Object.entries(s.llm_models).map(([id, l]) => html`<option value=${id}>${l}</option>`)}</select>`}
        ${backend === 'api' && html`<input type="password" value=${key} onInput=${(e) => setKey(e.target.value)} placeholder=${s.llm_has_key ? 'API key saved (type a new one to replace it)' : 'API key (sk-ant-…); blank uses ANTHROPIC_API_KEY'} />`}
        <button class="primary" onClick=${async () => { await call('set_llm', backend, model || s.llm_model, key.trim()); setKey(''); reload(); toast('Smarter Jace saved. Applies to the next game'); }}>Save</button>
      </div>
      <p class="muted">${backend === 'claude-code' ? (s.claude_cli ? html`Uses <code>${s.claude_cli}</code>. If Jace never shows a plan, run <code>claude</code> once in a terminal to log in.` : html`<span class="bad">Claude Code CLI not found.</span> Install Claude Code or the Claude desktop app.`)
        : backend === 'api' ? (s.anthropic_sdk ? 'Billed per token to your key.' : html`<span class="bad">Run setup.bat again to install the anthropic package.</span>`) : ''}</p>
      <div class="row"><button onClick=${() => api.open_lessons()}>Open Jace's lessons file</button><button onClick=${() => api.open_difficulties()}>Open difficulty files</button></div>
    </div>
    <div class="panel">
      <h2>You & the guide</h2>
      <div class="row"><span>Name at the table: <b>${user}</b></span><button onClick=${onName}>Change</button></div>
      <div class="row"><button onClick=${onTour}>Replay the app tour</button>
        <button onClick=${() => { setPref('boardTipsDone', false); toast('Board tips will show at the start of your next game.'); }}>Show board tips next game</button></div>
    </div>
  </section>`;
}

function NamePrompt({ first, current, onDone, onClose }) {
  const [name, setName] = useState(current || '');
  const focus = useFocus();
  const save = async () => onDone(await call('set_username', name));
  return html`<${Modal} locked=${first} onClose=${onClose}>
    <div class="welcome">
      ${first && html`<img src="img/icon.png" alt="" />`}
      <h2>${first ? 'Welcome to MTG Goldfish' : 'Your name'}</h2>
      <p class="muted">${first ? 'What should we call you? This is your name at the table and in the game log.' : 'Shown at the table and in the game log.'}</p>
      <div class="row"><input ref=${focus} maxLength="24" placeholder="Your name" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && save()} />
        <button class="primary" onClick=${save}>${first ? "Let's go" : 'Save'}</button></div>
    </div>
  </${Modal}>`;
}

// ---- the app ----
function App() {
  const [view, setView] = useState('home');
  const [decks, setDecks] = useState([]);
  const [settings, setSettings] = useState(null);
  const [user, setUser] = useState('');
  const [selected, setSelected] = useState(undefined); // deck open on the Decks page (null = new deck)
  const [match, setMatchState] = useState({ you: null, bot: null });
  const [art, setArt] = useState({});
  const [naming, setNaming] = useState(null); // 'first' | 'change'
  const [touring, setTouring] = useState(false);
  const [level, setLevelState] = useState('normal');
  const reload = async () => setSettings(await call('settings'));

  useEffect(() => {
    (async () => {
      await ready;
      const [list, s] = await Promise.all([call('list_decks'), call('settings')]);
      await loadPrefs();
      if (prefs.difficulty) setLevelState(prefs.difficulty);
      setDecks(list); setSettings(s); setUser(s.username || '');
      const valid = (r) => r && list.some((d) => sameRef(d, r));
      const lm = prefs.lastMatch || {};
      setMatchState({ you: valid(lm.you) ? lm.you : refOf(list.find((d) => !d.preset) || list[0]),
                      bot: valid(lm.bot) ? lm.bot : refOf(list.find((d) => d.preset)) });
      document.getElementById('splash').classList.add('gone');
      setTimeout(() => document.getElementById('splash')?.remove(), 400);
      if (!s.username) setNaming('first');
      else if (!prefs.tourDone) setTimeout(() => setTouring(true), 500);
    })();
  }, []);
  useEffect(() => { cardImages(decks.map((d) => commanderNames(d)[0])).then(setArt); }, [decks]);

  const setMatch = (m) => { setMatchState(m); setPref('lastMatch', m); };
  const setLevel = (l) => { setLevelState(l); setPref('difficulty', l); };
  const go = (v) => { setView(v); document.getElementById('preview').hidden = true; };
  const openDeck = (ref) => { setSelected(ref); go('decks'); };
  const play = () => { if (match.you && match.bot) { setPref('lastMatch', match); window.startGame(match.you, match.bot, settings?.llm_backend ? level : null); } };
  const playWith = (ref, as) => { const m = { ...match, [as]: ref }; setMatch(m); go('home'); toast(as === 'bot' ? `Jace's deck: ${ref.name}` : `Your deck: ${ref.name}`); };
  const endTour = () => { setTouring(false); setPref('tourDone', true); };

  const decksSel = selected === undefined ? refOf(decks.find((d) => !d.preset) || decks[0]) : selected;
  const steps = [
    { before: () => go('home'), title: 'Welcome to MTG Goldfish', text: 'Test your Commander decks 1-on-1 against Jace, a bot on Forge\'s full rules engine. This one-minute tour shows where everything is (the arrow keys work too).' },
    { sel: '[data-tour=matchup]', title: 'Pick a matchup', text: 'Choose your deck and the deck Jace plays: one of his presets, or any deck of yours. Your last matchup is remembered.' },
    { sel: '[data-tour=difficulty]', title: 'Difficulty', text: settings?.llm_backend
        ? `Pick how hard Jace plays before each match: Easy, Normal, Hard or Expert. Each level is a Markdown file you can edit (Settings → Open difficulty files), and every level uses the same Claude model, so the cost doesn't change.`
        : `With Claude connected (Smarter Jace, in Settings) you can pick how hard Jace plays before each match: Easy, Normal, Hard or Expert. Without it, Jace is Forge's built-in AI.` },
    { sel: '[data-tour=play-cta]', title: 'Play', text: 'Starts a game right here. Jace\'s turns play out by themselves at a speed you can follow; you get a short tour of the board in your first game.' },
    { sel: '[data-tour=nav-decks]', title: 'Your decks', text: 'Everything about decks lives on the Decks page.' },
    { before: () => { setSelected(refOf(decks.find((d) => d.preset))); go('decks'); }, sel: '[data-tour=deck-new]', title: 'Add decks', text: 'Start a new deck (paste a list or build card by card) or import a public deck from Moxfield. Search, sort and tag your library below.' },
    { sel: '[data-tour=deck-tabs]', title: 'Cards, Text, Analysis', text: 'See the deck as card art and edit it with + / − / ★ on hover, edit the raw list, or open the analysis: curve, ramp/draw/removal counts, color sources, bracket estimate and EDHREC suggestions.' },
    { sel: '[data-tour=deck-actions]', title: 'Manage a deck', text: 'Save, play it, duplicate it (Jace\'s presets need a copy before editing), copy the list for Moxfield, or delete it.' },
    { before: () => go('settings'), sel: '[data-tour=forge-setup]', title: 'Settings', text: 'Forge (the rules engine) is a one-time download here. You can also turn on Smarter Jace, where Claude plans Jace\'s turns and reviews each game.' },
    { before: () => go('home'), sel: '[data-tour=help-btn]', title: 'Help any time', text: 'The Help page explains every system (priority and stops, combat, mana, brackets) and can replay this tour.' },
  ];

  return html`<div class="app">
    <header class="topbar">
      <div class="brand" onClick=${() => go('home')}><img src="img/icon.png" alt="" /><span>MTG Goldfish</span></div>
      <nav>${[['home', 'Home'], ['decks', 'Decks'], ['play', 'Play'], ['settings', 'Settings']].map(([k, l]) => html`
        <button class=${'tab' + (view === k ? ' active' : '')} data-tour=${'nav-' + k} onClick=${() => go(k)}>${l}</button>`)}</nav>
      <div class="spacer"></div>
      <button class=${'help-btn' + (view === 'help' ? ' active' : '')} data-tour="help-btn" onClick=${() => go('help')}>? Help</button>
      ${user && html`<button class="user-chip" title="Change your name" onClick=${() => setNaming('change')}>👤 ${user}</button>`}
    </header>
    <main key=${view}>
      ${view === 'home' && html`<${Home} decks=${decks} match=${match} setMatch=${setMatch} art=${art} settings=${settings} user=${user} go=${go}
        onPlay=${play} openDeck=${openDeck} onTour=${() => setTouring(true)} level=${level} setLevel=${setLevel} />`}
      ${view === 'decks' && html`<${DecksView} decks=${decks} setDecks=${setDecks} selected=${decksSel} setSelected=${setSelected} onPlay=${playWith} />`}
      ${view === 'play' && html`<${Play} decks=${decks} match=${match} setMatch=${setMatch} art=${art} onPlay=${play} settings=${settings} level=${level} setLevel=${setLevel} go=${go} />`}
      ${view === 'settings' && html`<${Settings} settings=${settings} reload=${reload} user=${user} onName=${() => setNaming('change')} onTour=${() => setTouring(true)} />`}
      ${view === 'help' && html`<${HelpView} onTour=${() => setTouring(true)} onBoardTips=${() => { setPref('boardTipsDone', false); toast('Board tips will show at the start of your next game.'); }} />`}
    </main>
    ${naming && html`<${NamePrompt} first=${naming === 'first'} current=${user} onClose=${() => setNaming(null)}
      onDone=${(n) => { const first = naming === 'first'; setUser(n); setNaming(null); if (first && !prefs.tourDone) setTimeout(() => setTouring(true), 300); }} />`}
    ${touring && decks.length > 0 && html`<${Tour} steps=${steps} onDone=${endTour} />`}
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
