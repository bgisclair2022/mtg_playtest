// In-app board for a Forge-powered match (see bridge/src/goldfish/Bridge.java), in Preact.
// The bridge owns all rules: every click here is forwarded to Forge, which decides what it means.
// Cards are keyed by Forge's card id, so the board updates in place and cards glide between zones.
import { html, render, useState, useEffect, useLayoutEffect, useRef } from './vendor/preact-htm.js';
import { api, call, esc, prefs, setPref } from './core.js';
import { Tour } from './tour.js';

// Every step of the turn (CR 500-514); combat is split so each sub-step is visible.
const PHASES = [
  ['Upkeep', ['UNTAP', 'UPKEEP']], ['Draw', ['DRAW']], ['Main 1', ['MAIN1']],
  ['Combat', ['COMBAT_BEGIN']], ['Attack', ['COMBAT_DECLARE_ATTACKERS']], ['Block', ['COMBAT_DECLARE_BLOCKERS']],
  ['Damage', ['COMBAT_FIRST_STRIKE_DAMAGE', 'COMBAT_DAMAGE']], ['End combat', ['COMBAT_END']],
  ['Main 2', ['MAIN2']], ['End', ['END_OF_TURN', 'CLEANUP']],
];
const STEP_NAMES = {
  UPKEEP: 'upkeep', DRAW: 'draw step', MAIN1: 'first main phase', MAIN2: 'second main phase', COMBAT_BEGIN: 'beginning of combat',
  COMBAT_DECLARE_ATTACKERS: 'declare attackers step', COMBAT_DECLARE_BLOCKERS: 'declare blockers step',
  COMBAT_FIRST_STRIKE_DAMAGE: 'first-strike damage step', COMBAT_DAMAGE: 'combat damage step', COMBAT_END: 'end of combat',
  END_OF_TURN: 'end step', CLEANUP: 'cleanup step',
};
const MANA_BG = { W: '#f3eccd', U: '#5b9bd5', B: '#a99bab', R: '#e0634b', G: '#5fae6a', C: '#c9c5bd' };
const COUNTER_ICONS = { poison: '☠', energy: '⚡', experience: '✦', rad: '☢', ticket: '🎟' };
const stepName = (key, fallback) => STEP_NAMES[key] || (fallback || '').toLowerCase();
const tidy = (msg) => String(msg || '').replace(/ \(\d+\)/g, ''); // Forge appends internal card ids like "Shock (29)"
const topOfStack = (s) => s.stack.find((x) => x.top) || s.stack[0] || null;
const targetNames = (it) => (it.targets || []).map((t) => t.name).join(', ');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const plain = (t) => String(t || '').replace(/<[^>]+>/g, ''); // Forge marks up some rules text with HTML

// ---- connection to the bridge ----
const G = { port: null, running: false, version: -1, reviews: false, images: {}, asked: new Set(), setState: null, you: null, bot: null };
const send = (path, body) => fetch(`http://127.0.0.1:${G.port}${path}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
const act = (type, extra = {}) => send('/act', { type, ...extra }); // text/plain body: no CORS preflight
const answer = (id, value) => send('/answer', { id, value });

async function poll(port) {
  while (G.running && G.port === port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/state?v=${G.version}`, { signal: AbortSignal.timeout(30000) });
      const s = await res.json();
      const speed = savedSpeed();
      if (G.version === -1 && s.speed !== undefined && s.speed !== speed) act('speed', { value: speed }); // remembered speed
      G.version = s.version;
      snapshotRects(); // FLIP: remember where every card was before this update
      G.setState?.({ s });
    } catch {
      if (!(await api.game_alive())) { G.running = false; G.setState?.({ error: 'Forge stopped unexpectedly. Details are in data/logs/.' }); return; }
      await new Promise((r) => setTimeout(r, 800)); // still loading
    }
  }
}

// ---- card art (Scryfall, via the Python side's cache) ----
let imageTimer = null;
function wantImages(cards) {
  const missing = cards.filter((c) => c && c.name && !c.token && !c.hidden && !(c.name in G.images) && !G.asked.has(c.name)).map((c) => c.name);
  if (!missing.length) return;
  missing.forEach((n) => G.asked.add(n));
  clearTimeout(imageTimer);
  imageTimer = setTimeout(async () => {
    const names = [...G.asked].filter((n) => !(n in G.images));
    const found = await api.card_images(names);
    if (found && !found.error) { names.forEach((n) => { G.images[n] = found[n] || null; }); G.setState?.({}); }
  }, 120);
}
const artCrop = (url) => url && url.replace('/normal/', '/art_crop/');

// ---- FLIP animation: cards keep their Forge id across zones, so we can slide them from old to new spot ----
let rects = new Map();
const ZONES = '.g-hand, .g-field.me, .g-field.opp, .g-stack, .g-opphand, .g-bar.me .g-cmd, .g-bar.opp .g-cmd, .tray, .d-panel';
const zoneOf = (el) => { const z = el.closest(ZONES); return z ? z.className + (z.closest('.g-bar.opp') ? ' opp' : '') : ''; };
function snapshotRects() {
  rects = new Map();
  // r: where it is on screen (for moves between zones); x/y: its layout spot, ignoring hover lifts and tapping
  document.querySelectorAll('#view-game [data-cid]').forEach((el) => rects.set(el.dataset.cid, { r: el.getBoundingClientRect(), x: el.offsetLeft, y: el.offsetTop, zone: zoneOf(el) }));
}
function playFlip() {
  if (!rects.size) return;
  document.querySelectorAll('#view-game [data-cid]').forEach((el) => {
    const was = rects.get(el.dataset.cid);
    const after = el.getBoundingClientRect();
    if (!after.width) return;
    const zone = zoneOf(el);
    const sameZone = was && was.zone === zone;
    // Cards that changed zone glide there; in your hand the others slide to close the gap. Elsewhere a card that merely
    // shifted because something else changed size snaps into place, so the board doesn't wobble.
    if (sameZone && !zone.startsWith('g-hand')) return;
    // within the hand, only a real change of spot counts (not a hover lift in progress)
    if (sameZone && Math.abs(was.x - el.offsetLeft) < 2 && Math.abs(was.y - el.offsetTop) < 2) return;
    const before = sameZone ? { left: after.left + was.x - el.offsetLeft, top: after.top + was.y - el.offsetTop, width: after.width } : was?.r;
    const moves = before && (Math.abs(before.left - after.left) >= 2 || Math.abs(before.top - after.top) >= 2 || Math.abs(before.width / after.width - 1) >= 0.02);
    if (before && !moves) return;
    // a new slide starts from wherever the card is right now (the measurement includes any slide in progress)
    el.getAnimations().filter((x) => !(x instanceof CSSTransition)).forEach((x) => x.cancel());
    if (!before) { // new to the visible board (drawn, created, revealed)
      el.animate([{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'ease-out' });
      return;
    }
    const dx = before.left - after.left, dy = before.top - after.top, sx = sameZone ? 1 : before.width / after.width;
    el.animate([{ transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx})` },
                { transformOrigin: 'top left', transform: 'none' }],
               { duration: sameZone ? 220 : 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
  rects = new Map();
}

// ---- small pieces ----
function Card({ c, opts = {}, s, onClick, noClick }) {
  if (!c) return null;
  const input = s?.prompt?.input || '';
  const flags = ['selectable', 'playable', 'highlighted', 'attacking', 'blocking'].filter((f) => c[f]);
  if (c.manaSource && /^InputPayMana/.test(input)) flags.push(c.manaSource > 1 ? 'selectable' : 'mana-source');
  if (c.manaSource && /^Input(Block|Attack)$/.test(input) && !c.attacking && !c.blocking) flags.push('mana-source'); // could attack/block
  const targeted = G.targeted?.has(c.id);
  const img = !c.hidden && !c.token && G.images[c.name];
  const counters = Object.entries(c.counters || {}).map(([k, v]) => `${v} ${k}`).join(', ');
  const cls = ['gc', ...flags, c.hidden && 'back', targeted && 'targeted', c.phasedOut && 'phased'].filter(Boolean).join(' ');
  const click = noClick ? undefined : (onClick || (() => act('card', { id: c.id })));
  return html`
    <div class=${'gc-slot' + (c.tapped ? ' tapped' : '') + (c.attacking ? ' attacking' : '')} data-cid=${opts.flip === false ? undefined : opts.cid || c.id} title=${opts.title}>
      <div class=${cls} onClick=${click} onMouseEnter=${(e) => showPreview(c, e.currentTarget)} onMouseLeave=${hidePreview}>
        ${c.hidden ? null : img ? html`<img src=${img} alt=${c.name} draggable="false" />`
          : html`<div class="gc-text"><b>${c.name}</b><small>${c.type}</small><p>${plain(c.text)}</p></div>`}
        ${c.creature && html`<span class=${'pt' + (c.damage ? ' hurt' : '')}>${c.power}/${c.toughness - (c.damage || 0)}</span>`}
        ${c.loyalty && html`<span class="pt">◆${c.loyalty}</span>`}
        ${c.faceDown && html`<span class="facedown" title=${c.hidden ? 'Face-down 2/2' : 'Face-down (only you see what it is)'}>face-down</span>`}
        ${c.phasedOut && html`<span class="facedown">phased out</span>`}
        ${counters && html`<span class="badge">${counters}</span>`}
        ${opts.count > 1 && html`<span class="count">×${opts.count}</span>`}
        ${opts.tax ? html`<span class="count" title="Commander tax">+${opts.tax}</span>` : null}
        ${c.sick && c.creature && !c.hidden && html`<span class="sick" title="Summoning sick">💤</span>`}
        ${opts.blocks && html`<span class="blocks">blocks ${opts.blocks}</span>`}
        ${targeted && html`<span class="crosshair" title="Targeted">🎯</span>`}
      </div>
    </div>`;
}

// Large preview beside whatever card the pointer is over.
function showPreview(c, el) {
  G.hoverEl = el;
  if (c.hidden) return;
  const p = document.getElementById('g-preview');
  const img = !c.token && G.images[c.name];
  p.innerHTML = img ? `<img src="${esc(img)}">` : `<div class="gc-text"><b>${esc(c.name)}</b><small>${esc(c.type)}</small><p>${esc(plain(c.text))}</p></div>`;
  const r = el.getBoundingClientRect(), w = 270, h = 376;
  p.style.left = (r.right + w + 16 < innerWidth ? r.right + 12 : Math.max(8, r.left - w - 12)) + 'px';
  p.style.top = Math.max(8, Math.min(r.top - 40, innerHeight - h - 8)) + 'px';
  p.hidden = false;
}
function hidePreview() { G.hoverEl = null; document.getElementById('g-preview').hidden = true; }

// A permanent with whatever is attached to it (auras, equipment) tucked underneath.
function Permanent({ c, attached, s, blocks }) {
  if (!attached.length) return html`<${Card} c=${c} s=${s} opts=${{ blocks }} />`;
  return html`<div class="gc-host"><${Card} c=${c} s=${s} opts=${{ blocks }} />
    <div class="gc-attached">${attached.map((a) => html`<${Card} key=${a.id} c=${a} s=${s} />`)}</div></div>`;
}

function Battlefield({ p, s, blocks }) {
  const everything = s.players.flatMap((pl) => pl.battlefield);
  const onHost = (c) => c.attachedTo && everything.some((h) => h.id === c.attachedTo);
  const nonLands = p.battlefield.filter((c) => !c.land && !onHost(c)).sort((a, b) => b.creature - a.creature);
  // group identical lands so a 37-land Commander board stays readable
  const groups = [];
  for (const c of p.battlefield.filter((c) => c.land && !onHost(c))) {
    const key = [c.name, c.tapped].join('|'); // not highlights, which change every prompt and would regroup the lands
    const g = groups.find((x) => x.key === key && !c.attachedTo && !Object.keys(c.counters || {}).length);
    if (g) g.cards.push(c); else groups.push({ key, cards: [c] });
  }
  return html`<div class=${'g-field ' + (p.local ? 'me' : 'opp')}>
    <div class="g-row">${nonLands.map((c) => html`<${Permanent} key=${c.id} c=${c} s=${s} blocks=${blocks[c.id]}
      attached=${everything.filter((a) => a.attachedTo === c.id)} />`)}</div>
    <div class="g-row lands">${groups.map((g, i) => {
      // show the group as able to act if any land in it can, and send the click to that land
      const act1 = g.cards.find((c) => c.selectable || c.manaSource || c.playable || c.highlighted) || g.cards[0];
      const shown = { ...act1, selectable: g.cards.some((c) => c.selectable), playable: g.cards.some((c) => c.playable),
        highlighted: g.cards.some((c) => c.highlighted), manaSource: Math.max(0, ...g.cards.map((c) => c.manaSource || 0)) };
      const gid = g.cards.length > 1 ? `land:${g.key}:${groups.slice(0, i).filter((x) => x.key === g.key).length}` : undefined;
      return html`<${Card} key=${gid || g.cards[0].id} c=${shown} s=${s} opts=${{ count: g.cards.length, cid: gid }} />`;
    })}</div>
  </div>`;
}

// A player's colours, from their commander's mana cost (partners combined).
function identity(p) {
  const cost = p.command.filter((c) => !c.hidden).map((c) => c.cost || '').join('');
  return ['W', 'U', 'B', 'R', 'G'].filter((c) => cost.includes(c));
}

// Life total: flashes and floats a +/- when it changes.
function Life({ p, targetable }) {
  const prev = useRef(p.life);
  const [deltas, setDeltas] = useState([]);
  useEffect(() => {
    const d = p.life - prev.current;
    prev.current = p.life;
    if (!d) return;
    const id = Math.random();
    setDeltas((cur) => [...cur, { id, d }]);
    setTimeout(() => setDeltas((cur) => cur.filter((x) => x.id !== id)), 1400);
  }, [p.life]);
  const last = deltas[deltas.length - 1];
  const cls = 'g-life' + (targetable ? ' target' : '') + (G.targeted?.has(`p${p.id}`) ? ' targeted' : '') + (last ? (last.d < 0 ? ' hurt' : ' heal') : '');
  return html`<button class=${cls} key=${'life' + (last ? last.id : '')} title="Click to target this player" onClick=${() => act('player', { id: p.id })}>
    ${p.life}${deltas.map((x) => html`<span key=${x.id} class=${'life-delta ' + (x.d < 0 ? 'down' : 'up')}>${x.d > 0 ? '+' : '\u2212'}${Math.abs(x.d)}</span>`)}
  </button>`;
}

function PlayerBar({ p, s, onZone }) {
  const mine = p.local;
  const paying = mine && /^InputPayMana/.test(s.prompt.input || '');
  // Forge highlights card targets itself, but not players; light both up when a player could be the target
  const targetable = p.highlighted || (/^InputSelect(Targets|Entities)/.test(s.prompt.input || '') && /player|opponent|any target/i.test(s.prompt.message));
  const hot = (zone) => p[zone].some((c) => c.playable || c.selectable);
  const pool = Object.entries(p.mana);
  const prio = p.priority && !s.gameOver;
  const ids = identity(p);
  const grad = (ids.length > 1 ? ids : [ids[0], ids[0]]).map((c) => MANA_BG[c] || 'var(--accent)').join(', ');
  const idStyle = { '--id': MANA_BG[ids[0]] || 'var(--accent)', '--id-grad': `linear-gradient(90deg, ${grad})` };
  return html`<div class=${'g-bar ' + (mine ? 'me' : 'opp') + (prio ? ' has-prio' : '')} style=${idStyle}>
    <div class="g-who">
      ${!mine ? html`<img class="g-avatar" src="img/jace.png" alt="" />`
        : prefs.avatar?.url ? html`<img class="g-avatar" src=${prefs.avatar.url} alt="" title=${prefs.avatar.name} />`
        : html`<span class="g-avatar you">${(p.name || '?')[0].toUpperCase()}</span>`}
      <div><div class="g-name">${p.name}${mine && html` <span class="muted">(you)</span>`}${!mine && G.level && G.reviews && html` <span class=${'lvl-tag lvl-' + G.level}>${G.level[0].toUpperCase() + G.level.slice(1)}</span>`}</div>
        <div class="g-prio">${prio ? 'priority' : ' '}</div></div>
    </div>
    <${Life} p=${p} targetable=${targetable} />
    <div class="g-chips">
      ${!mine && html`<span class="chip" title="Cards in hand">✋ ${p.handSize}</span>`}
      <span class="chip" title="Library">📚 ${p.library}</span>
      <button class=${'chip' + (hot('graveyard') ? ' hot' : '')} title="Graveyard" onClick=${() => onZone(p, 'graveyard')}>🪦 ${p.graveyard.length}</button>
      <button class=${'chip' + (hot('exile') ? ' hot' : '')} title="Exile" onClick=${() => onZone(p, 'exile')}>⌀ ${p.exile.length}</button>
      ${Object.entries(p.commanderDamage).map(([n, d]) => html`<span class="chip" title=${`Commander damage from ${n}`}>⚔ ${d}/21</span>`)}
      ${Object.entries(p.playerCounters || {}).map(([k, n]) => html`<span class="chip status" title=${`${k} counters`}>${COUNTER_ICONS[k.toLowerCase()] || '●'} ${n} ${k.toLowerCase()}</span>`)}
      ${(p.flags || []).map((f) => html`<span class="chip flag">${f === 'Monarch' ? '👑 ' : f === 'Initiative' ? '🏰 ' : ''}${f}</span>`)}
    </div>
    ${!mine && html`<div class="g-opphand">${p.hand.map((c) => html`<${Card} key=${c.id} c=${c} s=${s} noClick />`)}</div>`}
    <div class="g-cmd">${p.command.map((c) => html`<${Card} key=${c.id} c=${c} s=${s} opts=${{ tax: (p.commanderTax || {})[c.id] }} />`)}</div>
    ${(mine || pool.length > 0) && html`<div class=${'g-manabox' + (paying ? ' paying' : '')}>
      <div class="pips">${pool.length ? pool.map(([k, n]) => html`<button class="pip" style=${{ background: MANA_BG[k] || '#ccc' }}
          title=${`Spend ${k} from your pool`} onClick=${() => act('mana', { color: k })}>${k}<b>${n}</b></button>`)
        : html`<span class="muted">no floating mana</span>`}</div>
      ${mine && p.untappedSources >= 0 && html`<div class="src">${plural(p.untappedSources, 'untapped source')}${paying ? ' · click to spend' : ''}</div>`}
    </div>`}
  </div>`;
}

function Hand({ me, s }) {
  // Overlap the cards just enough to fit the space next to the action bar.
  const ref = useRef();
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const n = me.hand.length;
  const cw = ref.current?.querySelector('.gc-slot')?.offsetWidth || 0;
  const overlap = n > 1 && cw && width ? Math.max(0, (n * (cw + 6) - width) / (2 * (n - 1))) : 0;
  return html`<div class="g-hand" ref=${ref} style=${{ '--overlap': `${Math.ceil(overlap)}px` }}>
    ${me.hand.map((c) => html`<${Card} key=${c.id} c=${c} s=${s} />`)}</div>`;
}

// The lane between the battlefields: turn, phases, the stack (triggers stand out), and what Jace just did.
function Lane({ s, me, action }) {
  const myTurn = s.activePlayer === me.id;
  const top = topOfStack(s);
  const holding = s.prompt.input === 'InputPassPriority' && s.prompt.okOn && s.holding;
  const [sweep, setSweep] = useState(null);
  const lastTurn = useRef(s.turn);
  useEffect(() => { // a short banner when the turn passes
    const changed = s.turn && s.turn !== lastTurn.current && !s.gameOver;
    lastTurn.current = s.turn;
    if (!changed) return;
    setSweep({ id: s.turn, mine: myTurn, text: myTurn ? 'Your turn' : `${botName(s)}\u2019s turn` });
    const t = setTimeout(() => setSweep(null), 1600);
    return () => clearTimeout(t);
  }, [s.turn]);
  return html`<div class="g-lane">
    ${sweep && html`<div key=${sweep.id} class=${'turn-sweep' + (sweep.mine ? ' mine' : '')}><span>${sweep.text}</span></div>`}
    <div class="g-turninfo">
      <div class=${'g-turn ' + (myTurn ? 'mine' : 'theirs')}>
        ${s.gameOver ? `Game over · ${s.winner ? `${s.winner} wins` : 'draw'} in round ${s.round}`
          : s.mulligan || !s.turn ? 'Game start' : `Round ${s.round} · ${myTurn ? 'Your' : `${botName(s)}'s`} turn`}
        ${s.dayNight === 'day' ? ' · ☀ Day' : s.dayNight === 'night' ? ' · ☾ Night' : ''}</div>
      ${s.loop && !s.gameOver ? html`<div class=${'loop-bar' + (s.loop.paused ? ' paused' : '')} title=${`${s.loop.label}. An infinite loop plays out by itself until something changes; a mandatory loop that never ends is a draw (CR 104.4b).`}>
        <div><b>∞ Loop</b> · cycle ${s.loop.cycles}</div><span>${s.loop.label}</span>
        ${s.loop.paused ? html`<button onClick=${() => act('loop', { value: 'run' })}>Fast-forward</button>`
          : html`<button onClick=${() => act('loop', { value: 'stop' })}>Stop to respond</button>`}</div>`
      : html`<div class="g-phases">${PHASES.map(([label, keys]) => html`<span class=${!s.gameOver && keys.includes(s.phaseKey) ? 'on' : ''}>${label}</span>`)}</div>`}
    </div>
    <div class="g-stack">
      ${s.stack.length ? [...s.stack].sort((a, b) => (b === top) - (a === top)).map((it) => html`<div key=${it.id} class=${'st' + (it.trigger ? ' trigger' : '') + (it === top ? ' top' : '') + (it.mine ? ' mine' : '')}>
          ${it.card && html`<${Card} c=${it.card} s=${s} />`}
          <div class="st-text">
            ${it.trigger && html`<div class="tag">Trigger!</div>`}
            <div>${tidy(it.text)}</div>
            ${it.targets?.length ? html`<div class="tg">🎯 ${targetNames(it)}</div>` : null}
            ${it === top && html`<div class="who">${it.mine ? 'Yours' : botName(s) + "'s"} · ${holding ? 'you can respond' : 'resolving…'}</div>`}
          </div></div>`)
        : action ? html`<div key=${'a' + action.id} class=${'st action' + (/Your turn/.test(action.text) ? ' mine' : '')}>
          ${action.card && html`<${Card} c=${action.card} s=${s} opts=${{ flip: false }} noClick />`}
          <div class="st-text"><div>${tidy(action.text)}</div></div></div>`
        : html`<div class="st-empty">Stack is empty</div>`}
    </div>
  </div>`;
}

// ---- the dock: everything you're asked or told sits here instead of in pop-ups ----
function friendlyPrompt(s, me, ui) {
  const p = s.prompt;
  const myTurn = s.activePlayer === me.id;
  const anyPlayable = (c) => c.playable && !c.land;
  const mine = me.hand.concat(me.battlefield, me.command, me.graveyard, me.exile);
  if (!p.input) { // Forge isn't asking you anything right now (the bot is acting, or a step is changing)
    return { title: myTurn ? 'Your turn' : `${botName(s)} is playing…`, msg: '', hideOk: true, hideCancel: true, quiet: true };
  }
  if (p.input === 'InputPassPriority') {
    const top = topOfStack(s);
    if (top) {
      const thing = `${top.card?.name || 'spell'}${top.trigger ? ' trigger' : ''}${top.targets?.length ? ` → ${targetNames(top)}` : ''}`;
      const whose = top.mine ? 'Your' : `${botName(s)}'s`;
      if (ui.responding === top.id) {
        return { title: 'Responding', msg: `Click a glowing card to cast or activate it in response to ${whose.toLowerCase()} ${thing}.`, hideOk: true, hideCancel: true, extra: ['Back', () => ui.set({ responding: null })] };
      }
      const canRespond = s.holding || mine.some(anyPlayable);
      if (!canRespond) return { title: top.trigger ? 'Trigger on the stack' : 'Spell on the stack', msg: `${whose} ${thing}. Nothing to respond with, resolving…`, ok: 'Pass priority', hideCancel: true, quiet: true };
      return { title: top.trigger ? 'Trigger on the stack' : 'Spell on the stack', msg: `${whose} ${thing}. Pass priority to let it resolve, or respond.`,
        ok: 'Pass priority', hideCancel: true, extra: ['Respond', () => ui.set({ responding: top.id })] };
    }
    if (myTurn && s.phaseKey === 'MAIN1') return { title: 'Your main phase', msg: 'Play a land and cast spells (green = playable).', ok: 'To combat' };
    if (myTurn && s.phaseKey === 'MAIN2') return { title: 'Second main phase', msg: 'Cast anything else, then end your turn.', ok: 'End turn' };
    // Any other step: you have priority in it (CR 117.3a). The bridge holds when you can act, else passes shortly.
    const step = `${myTurn ? 'Your' : `${botName(s)}'s`} ${stepName(s.phaseKey, s.phase)}`;
    const options = [...new Set(mine.filter((c) => c.playable && !(c.land && me.hand.includes(c))).map((c) => c.name))];
    if (s.holding) { // the bridge is waiting for you: never claim it's passing
      return { title: step, msg: options.length ? `You have priority: respond with ${options.join(', ')}, or pass.` : 'You have priority: respond with an instant or ability, or pass.', ok: 'Pass priority', hideCancel: !myTurn };
    }
    return { title: step, msg: 'Nothing to respond with, passing priority…', ok: 'Pass priority', hideCancel: !myTurn, quiet: true };
  }
  if (/^InputPayMana/.test(p.input || '')) {
    return { title: 'Pay the cost', msg: `${p.message.split('\n').filter(Boolean).slice(-1)[0] || 'Pay the cost'}. Click lands or other mana sources (gold), or mana in your pool.` };
  }
  if (p.input === 'InputAttack') return { title: 'Declare attackers', msg: `Click your creatures (gold = can attack) to attack ${botName(s)}, then confirm.`, ok: 'Confirm attack', extra: ['Attack with all', () => act('alpha')] };
  if (p.input === 'InputBlock') return { title: 'Declare blockers', msg: `${p.message} Click your creature (gold = can block) to block, or confirm with none to take the damage.`, ok: 'Confirm blocks' };
  if (/discard/i.test(p.message) && /hand/i.test(p.message)) return { title: 'Discard down to hand size', msg: `${tidy(p.message).split(/\n/).pop()} Click the card(s) in your hand, then confirm.` };
  return { title: s.mulligan || p.input === 'InputConfirmMulligan' ? 'Opening hand' : 'Forge asks', msg: p.message };
}

function PromptPanel({ s, me, opp, ui }) {
  const p = s.prompt, f = friendlyPrompt(s, me, ui);
  const combat = p.input === 'InputBlock' && s.combat.length ? (() => {
    const find = (id) => opp.battlefield.find((x) => x.id === id);
    const attackers = s.combat.map((c) => find(c.attacker)).filter(Boolean);
    const incoming = s.combat.filter((c) => !c.blockers.length).map((c) => find(c.attacker)).filter(Boolean).reduce((t, c) => t + (c.power || 0), 0);
    return html`<div class="d-combat"><b>⚔ ${botName(s)} attacks with ${plural(attackers.length, 'creature')}</b>
      <div>${attackers.map((c) => `${c.name} ${c.power}/${c.toughness}`).join(' · ')}</div>
      <div>Unblocked damage right now: <b>${incoming}</b></div></div>`;
  })() : null;
  return html`<div class=${'d-panel prompt' + (f.quiet ? ' quiet' : '') + (/^Input(Attack|Block)$/.test(p.input) ? ' combat' : '')}>
    <div class="d-title">${tidy(f.title)}</div>
    ${p.card && html`<div class="d-card"><${Card} c=${p.card} s=${s} noClick opts=${{ flip: false }} /></div>`}
    ${f.msg && html`<div class="d-msg">${tidy(f.msg)}</div>`}
    ${combat}
    ${p.input === 'InputPassPriority' && !s.stack.length && html`<div class="d-skip">
      ${!(s.activePlayer === me.id && /^MAIN/.test(s.phaseKey)) && html`<button title="Pass priority until this turn ends (Shift+Space). You're still asked about blocks." onClick=${() => act('skip', { value: 'turn' })}>Pass turn</button>`}
      <button title="Pass everything until your next main phase (you're still asked about blocks)" onClick=${() => act('skip', { value: 'myturn' })}>To my turn</button>
    </div>`}
    <div class="d-btns">
      ${f.extra && html`<button onClick=${f.extra[1]}>${f.extra[0]}</button>`}
      ${p.cancelOn && !f.hideCancel && html`<button onClick=${() => act('cancel')}>${p.cancel}</button>`}
      ${p.okOn && !f.hideOk && html`<button class="primary" onClick=${() => act('ok')}>${f.ok || p.ok}</button>`}
    </div>
  </div>`;
}

// Forge asks some yes/no questions through the prompt bar (InputConfirm), e.g. commander to the command zone.
function DecisionPanel({ s }) {
  const p = s.prompt;
  const cmdZone = /command zone/i.test(p.message);
  const name = p.card?.name || (cmdZone ? p.message.split(':')[0] : '') || 'Your commander';
  return html`<div class="d-panel decide">
    <div class="d-title">${cmdZone ? `Your commander ${name} left play` : 'Decision'}</div>
    ${p.card && html`<div class="d-card"><${Card} c=${p.card} s=${s} noClick opts=${{ flip: false }} /></div>`}
    <div class="d-msg">${cmdZone ? 'It went to your graveyard or exile. Move it to the command zone (so you can recast it), or leave it where it is?' : tidy(p.message)}</div>
    ${twoColors(p) ? html`<div class="mana-choices">${[['ok', p.ok], ['cancel', p.cancel]].map(([k, l]) => html`<button title=${l} onClick=${() => act(k)}>
        <i class="pip-lg" style=${{ background: MANA_BG[manaSymbols(l)[0]] }}>${manaSymbols(l)[0]}</i></button>`)}</div>`
    : html`<div class="d-btns">
      ${p.cancelOn && html`<button onClick=${() => act('cancel')}>${cmdZone ? 'Leave it' : p.cancel}</button>`}
      <button class="primary" onClick=${() => act('ok')}>${cmdZone ? 'Command zone' : p.ok}</button>
    </div>`}</div>`;
}
// A land that could make either of two colours asks through a yes/no prompt whose buttons are the colours.
const twoColors = (p) => p.cancelOn && manaSymbols(p.ok || '').length === 1 && manaSymbols(p.cancel || '').length === 1
  && COLOR_WORDS[(p.ok || '').trim().toLowerCase()] && COLOR_WORDS[(p.cancel || '').trim().toLowerCase()];

// Short questions fit beside the hand; card choices, long lists and damage division need the dock.
const compactAsk = (a, s) => a.kind === 'options' || a.kind === 'number' || a.kind === 'input' || !!manaChoice(a, s)
  || (a.kind === 'choose' && !a.items.some((it) => it.card) && a.items.length <= 6);

// Mana choices while paying (which ability of a dual/tri land, or which colour a Command Tower/Citadel makes)
// all become one row of coloured mana buttons in the action bar, next to the payment.
const COLOR_WORDS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G', colorless: 'C' };
function manaSymbols(label) {
  const after = /add(.*)/i.exec(label)?.[1] ?? label;
  const syms = [...after.matchAll(/\{([WUBRGC])\}/g)].map((m) => m[1]);
  if (syms.length) return syms;
  const t = label.trim().toLowerCase();
  const word = COLOR_WORDS[t] || (/^[wubrgc]$/.test(t) ? t.toUpperCase() : null);
  return word ? [word] : [];
}
function manaChoice(a, s) {
  if (a.kind !== 'choose' || a.max !== 1 || !/^InputPayMana/.test(s?.prompt?.input || '')) return null;
  const syms = a.items.map((it) => manaSymbols(it.label));
  return syms.every((x) => x.length) ? syms : null;
}

// Questions Forge asks (choices, confirms, numbers, damage division).
function AskPanel({ a, s }) {
  const [sel, setSel] = useState([]);
  const [filter, setFilter] = useState('');
  const [text, setText] = useState(String(a.initial ?? a.min ?? ''));
  const [dist, setDist] = useState(() => (a.items || []).map((_, i) => (i === 0 ? a.amount : 0)));
  const reply = (v) => answer(a.id, v);
  useEffect(() => { wantImages([a.card, ...(a.items || []).map((it) => it.card)]); }, [a.id]);
  const head = html`<div class="d-title">${tidy(a.message)}</div>`;

  if (a.kind === 'options') {
    return html`<div class="d-panel ask">${head}
      ${a.card && html`<div class="d-card"><${Card} c=${a.card} s=${s} noClick opts=${{ flip: false }} /></div>`}
      <div class="d-btns wrap">${a.options.map((o, i) => html`<button class=${i === 0 ? 'primary' : ''} onClick=${() => reply(i)}>${o}</button>`)}</div></div>`;
  }
  const mana = manaChoice(a, s);
  if (mana) {
    return html`<div class="d-panel ask mana-ask">${head}
      <div class="mana-choices">${a.items.map((it, i) => html`<button title=${it.label} onClick=${() => reply([i])}>
        ${mana[i].map((c) => html`<i class="pip-lg" style=${{ background: MANA_BG[c] || '#ccc' }}>${c}</i>`)}</button>`)}</div>
      ${a.min === 0 && html`<div class="d-btns"><button onClick=${() => reply([])}>Cancel</button></div>`}</div>`;
  }
  if (a.kind === 'choose') {
    const single = a.max === 1 && !a.ordered;
    const cards = a.items.some((it) => it.card);
    const toggle = (i) => {
      if (single) return reply([i]);
      setSel((cur) => cur.includes(i) ? cur.filter((x) => x !== i) : cur.length < a.max ? [...cur, i] : cur);
    };
    const hint = single ? 'Pick one.' : a.min === a.max ? `Pick ${a.min}${a.ordered ? ' in order' : ''}.` : `Pick ${a.min}–${a.max}${a.ordered ? ' in order' : ''}.`;
    return html`<div class="d-panel ask">${head}
      <div class="muted">${hint}</div>
      ${a.items.length > 12 && html`<input class="d-filter" placeholder="Type to filter…" value=${filter} onInput=${(e) => setFilter(e.target.value)} autofocus />`}
      <div class=${'d-items' + (cards ? '' : ' text')}>
        ${a.items.map((it, i) => {
          if (filter && !it.label.toLowerCase().includes(filter.toLowerCase())) return null;
          const k = sel.indexOf(i);
          return html`<div key=${i} class=${'opt' + (k >= 0 ? ' sel' : '')} onClick=${() => toggle(i)}>
            ${k >= 0 && a.ordered && html`<span class="num">${k + 1}</span>`}
            ${it.card ? html`<${Card} c=${it.card} s=${s} noClick opts=${{ flip: false }} />${it.label !== it.card.name && html`<div class="cap">${it.label}</div>`}`
              : html`<button>${it.label}</button>`}
          </div>`;
        })}
      </div>
      <div class="d-btns">
        ${a.min === 0 && html`<button onClick=${() => reply([])}>None</button>`}
        ${!single && html`<button class="primary" disabled=${sel.length < a.min} onClick=${() => reply(sel)}>Done</button>`}
      </div></div>`;
  }
  if (a.kind === 'number' || a.kind === 'input') {
    const num = a.kind === 'number' || a.numeric;
    const ok = () => reply(num ? +text : text);
    return html`<div class="d-panel ask">${head}
      <input class="d-input" type=${num ? 'number' : 'text'} min=${a.min} max=${a.max} value=${text} autofocus
        onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && ok()} />
      <div class="d-btns"><button onClick=${() => reply(null)}>Cancel</button><button class="primary" onClick=${ok}>OK</button></div></div>`;
  }
  if (a.kind === 'distribute') {
    const sum = dist.reduce((t, x) => t + (+x || 0), 0);
    const bad = sum !== a.amount || (a.atLeastOne && dist.some((x) => +x < 1));
    return html`<div class="d-panel ask">${head}
      <div class="d-dist">${a.items.map((it, i) => html`<span>${it.label}</span>
        <input type="number" min=${a.atLeastOne ? 1 : 0} value=${dist[i]} onInput=${(e) => setDist((d) => d.map((x, j) => (j === i ? +e.target.value || 0 : x)))} />`)}</div>
      <div class="d-btns"><span class="muted">${a.amount - sum} left to assign</span><button class="primary" disabled=${bad} onClick=${() => reply(dist)}>OK</button></div></div>`;
  }
  return null;
}

// Cards you can use (or must pick) from a graveyard, exile or library, surfaced so you don't go looking.
function Tray({ s }) {
  const items = [];
  for (const pl of s.players) {
    const who = pl.local ? 'your' : `${pl.name}'s`;
    for (const c of pl.librarySelectable || []) items.push({ c, where: `${who} library` });
    for (const zone of ['graveyard', 'exile']) for (const c of pl[zone]) if (c.selectable || (pl.local && c.playable)) items.push({ c, where: `${who} ${zone}` });
  }
  useEffect(() => wantImages(items.map((x) => x.c)));
  if (!items.length) return null;
  return html`<div class="d-panel tray"><div class="d-label">Usable from graveyard / exile / library</div>
    <div class="d-items">${items.map(({ c, where }) => html`<${Card} key=${c.id} c=${c} s=${s} opts=${{ title: where }} />`)}</div></div>`;
}

function ZonePanel({ zone, s, onClose }) {
  const p = s.players.find((x) => x.id === zone.player);
  const cards = p ? p[zone.zone] : [];
  useEffect(() => wantImages(cards));
  return html`<div class="d-panel zone">
    <div class="d-title">${p?.local ? 'Your' : `${p?.name}'s`} ${zone.zone} (${cards.length})</div>
    <div class="d-items">${cards.length ? cards.map((c) => html`<${Card} key=${c.id} c=${c} s=${s} opts=${{ flip: false }} />`) : html`<p class="muted">Empty.</p>`}</div>
    <div class="d-btns"><button onClick=${onClose}>Close</button></div></div>`;
}

function GameOver({ s, onLeave, onRematch }) {
  const [review, setReview] = useState(G.reviews ? 'loading' : null);
  useEffect(() => {
    if (!G.reviews) return;
    api.review_game().then((r) => setReview(!r || r.error ? { error: r?.error || 'no answer' } : r));
  }, []);
  const won = s.winner && s.players.find((p) => p.local && p.name === s.winner);
  const mark = { optimal: '✅', fine: '➖', mistake: '❌' };
  return html`<div class="d-panel over">
    <div class="over-title">${won ? '🏆 You win!' : s.winner ? `${s.winner} wins` : 'Draw'}</div>
    <div class="muted">Round ${s.round}</div>
    <div class="d-btns"><button onClick=${onLeave}>Back to decks</button><button class="primary" onClick=${onRematch}>Rematch</button></div>
    ${review === 'loading' && html`<div class="d-review"><span class="spinner small"></span> Claude is reviewing the game and updating Jace's lessons…</div>`}
    ${review?.error && html`<div class="d-review bad">Review failed: ${review.error}</div>`}
    ${review?.summary && html`<div class="d-review"><h4>Game review</h4><p>${review.summary}</p>
      <h4>Jace's key decisions</h4><ul>${(review.bot_decisions || []).map((d) => html`<li>${mark[d.verdict] || ''} <b>${d.when}</b>: ${d.choice}
        ${d.better && html`<div class="muted">Better: ${d.better}</div>`}</li>`)}</ul>
      ${review.your_play?.length > 0 && html`<h4>Your play</h4><ul>${review.your_play.map((x) => html`<li>${x}</li>`)}</ul>`}
      <div class="d-btns"><button onClick=${() => api.open_file(review.report)}>Full report</button><button onClick=${() => api.open_lessons()}>Jace's lessons</button></div></div>`}
  </div>`;
}

function Log({ lines }) {
  const ref = useRef();
  const stick = useRef(true);
  useLayoutEffect(() => { if (stick.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines.length]);
  return html`<div class="d-log" ref=${ref} onScroll=${(e) => { const el = e.target; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30; }}>
    ${lines.map((l, i) => {
      const t = /^Turn (\d+) \((.+)\)$/.exec(l);
      return t ? html`<div key=${i} class="round">Round ${Math.ceil(+t[1] / 2)} · ${t[2]}'s turn</div>` : html`<div key=${i}>${tidy(l)}</div>`;
    })}</div>`;
}

function Toasts({ notices }) {
  const [shown, setShown] = useState([]);
  const seen = useRef(0);
  useEffect(() => {
    const fresh = notices.filter((n) => n.id > seen.current);
    if (!fresh.length) return;
    seen.current = Math.max(...fresh.map((n) => n.id));
    setShown((cur) => [...cur, ...fresh]);
    fresh.forEach((n) => setTimeout(() => setShown((cur) => cur.filter((x) => x.id !== n.id)), 6000));
  }, [notices]);
  return html`<div class="g-toasts">${shown.map((n) => html`<div key=${n.id}>${tidy(n.text)}</div>`)}</div>`;
}

// Full-screen art while Forge starts: commanders and a few cards from both decks, cross-fading.
function Loading({ msg, stuck, onBack }) {
  const [art, setArt] = useState([]);
  const [i, setI] = useState(0);
  useEffect(() => {
    let alive = true;
    loadingArt().then((a) => alive && setArt(a));
    const t = setInterval(() => setI((x) => x + 1), 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const cur = art.length ? art[i % art.length] : null;
  return html`<div class="g-loading">
    ${art.map((a, j) => html`<div key=${a.url} class=${'art' + (a === cur ? ' on' : '')} style=${{ backgroundImage: `url("${a.url}")` }}></div>`)}
    <div class="shade"></div>
    <div class="load-box">
      <div class="load-title">${G.you?.name || ''} <span>vs</span> ${G.bot?.name || ''}</div>
      ${!stuck && html`<div class="spinner"></div>`}
      <div class="load-msg">${tidy(msg)}</div>
      ${stuck && html`<button onClick=${onBack}>Back</button>`}
    </div>
    ${cur && html`<div class="art-cap">${cur.name}</div>`}
  </div>`;
}

let artCache = null;
async function loadingArt() {
  if (artCache) return artCache;
  const names = [];
  for (const ref of [G.you, G.bot]) {
    try {
      const d = await api.load_deck(ref.name, ref.preset);
      const cmd = (d.commander || '').split(/[\n;]/).map((x) => x.trim()).filter(Boolean);
      const rest = (d.list || '').split('\n').map((l) => l.replace(/^\d+x?\s+/, '').replace(/\s+\(.*$/, '').trim())
        .filter((n) => n && !/^(commander|deck|companion|sideboard|main)/i.test(n) && !/^(Plains|Island|Swamp|Mountain|Forest|Wastes)$/.test(n));
      names.push(...cmd, ...rest.sort(() => Math.random() - 0.5).slice(0, 3));
    } catch { /* art is a nicety */ }
  }
  const found = await api.card_images(names).catch(() => null);
  artCache = found && !found.error ? names.filter((n) => found[n]).map((n) => ({ name: n, url: artCrop(found[n]) })) : [];
  artCache.slice(0, 3).forEach((a) => { new Image().src = a.url; });
  return artCache;
}

const botName = (s) => s?.players?.find((p) => !p.local)?.name || 'Jace';
const SPEEDS = [['7000', 'Slow'], ['4000', 'Normal'], ['2000', 'Fast'], ['0', 'Instant']];
function savedSpeed() { const v = String(prefs.speed ?? ''); return SPEEDS.some(([k]) => k === v) ? +v : 4000; }

// First game: what each part of the board is for.
const BOARD_TIPS = [
  { title: 'Your first game', text: 'A quick look at the board before you start. The arrow keys move through these tips; Esc skips them.' },
  { sel: '.g-bar.opp', title: 'Jace', text: 'Life total (click it when a spell targets a player), hand, library, graveyard and exile (click to look), and his commander on the right.' },
  { sel: '.g-lane', title: 'Turn, phases and the stack', text: `Where the turn is, and what's on the stack. When Jace does something it shows here while the game pauses on it; triggers are marked "Trigger!".` },
  { sel: '.g-hand', title: 'Your hand', text: 'Green glow = you can play it: click to play a land or cast a spell. Hover any card to see it large. Gold means "pick this" (a target, a blocker, a land to tap).' },
  { sel: '.g-actionbar', title: 'The action bar', text: 'What the game wants from you, and the buttons for it. Space presses the main button. "To my turn" skips ahead until your next turn.' },
  { sel: '.g-bar.me', title: 'You', text: 'Your life, zones, commander (with its tax) and mana pool. Click floating mana to spend it while paying a cost.' },
  { sel: '.d-foot', title: 'Game settings', text: `Jace's speed, when the game should stop for you (default: only when it matters), and auto-pay for mana. The log above shows everything that happened.` },
];

// Each commander's art behind its half of the board, darkened like the Home banner.
function Backdrop({ top, bottom }) {
  const url = (c) => c && !c.hidden && G.images[c.name] && artCrop(G.images[c.name]);
  const t = url(top), b = url(bottom);
  return html`<div class="g-backdrop">
    ${t && html`<div class="bd top" key=${t} style=${{ backgroundImage: `url("${t}")` }}></div>`}
    ${b && html`<div class="bd bottom" key=${b} style=${{ backgroundImage: `url("${b}")` }}></div>`}
    <div class="bd-shade"></div>
  </div>`;
}

// ---- the whole game view ----
function Game() {
  const [st, setSt] = useState({ s: null, error: null });
  const [ui, setUi] = useState({ responding: null, zone: null, stayOnBoard: false });
  const [action, setAction] = useState(null);
  const [speed, setSpeed] = useState(savedSpeed());
  const [tips, setTips] = useState(false);
  G.setState = (patch) => setSt((cur) => ({ ...cur, ...patch }));
  ui.set = (patch) => setUi((cur) => ({ ...cur, ...patch }));
  const s = st.s;

  useLayoutEffect(() => {
    playFlip();
    if (G.hoverEl && !G.hoverEl.isConnected) hidePreview(); // the hovered card left (resolved, died, ...)
  });
  // What Jace just did: shown in the lane for as long as the bridge pauses for it.
  useEffect(() => {
    const a = s?.lastAction;
    if (!a || a.id === action?.id || !a.ms) return;
    setAction(a);
    const t = setTimeout(() => setAction((cur) => (cur?.id === a.id ? null : cur)), Math.max(a.ms, 900) + 300);
    return () => clearTimeout(t);
  }, [s?.lastAction?.id]);
  // keyboard: Space/Enter = OK, Esc = Cancel
  useEffect(() => {
    const key = (e) => {
      const p = G.last?.prompt;
      if (!p || G.last.ask || G.last.gameOver || document.querySelector('.tour') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === ' ' && e.shiftKey && p.input === 'InputPassPriority') { e.preventDefault(); act('skip', { value: 'turn' }); return; }
      if ((e.key === ' ' || e.key === 'Enter') && p.okOn) { e.preventDefault(); act('ok'); }
      if (e.key === 'Escape' && p.cancelOn) act('cancel');
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  if (st.error) return html`<${Loading} msg=${st.error} stuck onBack=${leaveGame} />`;
  if (!s || !s.players) return html`<${Loading} msg=${s?.prompt?.message || 'Starting Forge… (the first game takes ~20 seconds to load cards)'} />`;
  G.last = s;
  if (!prefs.boardTipsDone && !tips && !G.tipsShown) { G.tipsShown = true; setTimeout(() => setTips(true), 600); } // first game: a short board tour

  const me = s.players.find((p) => p.local), opp = s.players.find((p) => !p.local);
  const all = s.players.flatMap((p) => [...p.hand, ...p.battlefield, ...p.command, ...p.graveyard, ...p.exile]).concat(s.stack.map((x) => x.card));
  wantImages([...all, s.prompt.card, action?.card]);
  const blocks = {}; // blocker id -> attacker name
  for (const c of s.combat) {
    const a = all.find((x) => x && x.id === c.attacker);
    c.blockers.forEach((b) => { blocks[b] = a?.name || ''; });
  }
  G.targeted = new Set((topOfStack(s)?.targets || []).map((t) => t.card ?? `p${t.player}`));
  if (ui.responding && topOfStack(s)?.id !== ui.responding) ui.responding = null;

  const deciding = /^InputConfirm/.test(s.prompt.input || '') && s.prompt.input !== 'InputConfirmMulligan' && !s.ask && s.prompt.okOn;
  const zone = ui.zone && html`<${ZonePanel} zone=${ui.zone} s=${s} onClose=${() => ui.set({ zone: null })} />`;
  // Short questions and the main buttons sit beside your hand; card choices and the review get the dock's room.
  const bigAsk = s.ask && !compactAsk(s.ask, s);
  // While passing ahead, only the steps being passed show the "Passing…" panel; blocks and questions still show.
  const skipping = s.skip && !s.ask && !deciding && (!s.prompt.input || /^(InputPassPriority|InputAttack)$/.test(s.prompt.input));
  const bar = s.gameOver ? html`<div class="d-panel over-bar"><div class="d-title">${s.winner ? (me.name === s.winner ? '🏆 You win!' : `${s.winner} wins`) : 'Draw'}</div>
        <div class="d-btns"><button onClick=${leaveGame}>Back to decks</button><button class="primary" onClick=${() => startGame(G.you, G.bot, G.level)}>Rematch</button></div></div>`
    : skipping ? html`<div class="d-panel prompt quiet"><div class="d-title">${s.skip === 'myturn' ? 'Passing to your turn…' : 'Passing to the end of the turn…'}</div>
        <div class="d-msg">You'll still be asked about blocks and choices.</div>
        <div class="d-btns"><button class="primary" onClick=${() => act('skip', { value: 'stop' })}>Stop</button></div></div>`
    : bigAsk ? html`<div class="d-panel prompt"><div class="d-title">${tidy(s.ask.message)}</div><div class="d-msg">Choose in the panel on the right →</div></div>`
    : s.ask ? html`<${AskPanel} key=${s.ask.id} a=${s.ask} s=${s} />`
    : deciding ? html`<${DecisionPanel} s=${s} />`
    : html`<${PromptPanel} s=${s} me=${me} opp=${opp} ui=${ui} />`;
  const main = s.gameOver ? html`<${GameOver} s=${s} onLeave=${leaveGame} onRematch=${() => startGame(G.you, G.bot, G.level)} />`
    : bigAsk ? html`<${AskPanel} key=${s.ask.id} a=${s.ask} s=${s} />` : null;
  const wide = !!(ui.zone || (s.ask?.items?.some((it) => it.card) && s.ask.items.length > 4));

  return html`<div class=${'g-wrap' + (wide ? ' wide' : '') + (s.gameOver ? ' over' : '')}>
    <div class="g-board">
      <${Backdrop} top=${opp.command.find((c) => c.commander) || opp.command[0]} bottom=${me.command.find((c) => c.commander) || me.command[0]} />
      <${PlayerBar} p=${opp} s=${s} onZone=${(p, z) => ui.set({ zone: { player: p.id, zone: z } })} />
      <${Battlefield} p=${opp} s=${s} blocks=${blocks} />
      <${Lane} s=${s} me=${me} action=${action} />
      <${Battlefield} p=${me} s=${s} blocks=${blocks} />
      <${PlayerBar} p=${me} s=${s} onZone=${(p, z) => ui.set({ zone: { player: p.id, zone: z } })} />
      <div class="g-bottom">
        <${Hand} me=${me} s=${s} />
        <div class="g-actionbar" key=${s.ask?.id || (s.gameOver ? 'over' : deciding ? 'decide' : skipping ? 'skip' : 'prompt')}>${bar}</div>
      </div>
    </div>
    <aside class="g-dock">
      ${main && html`<div class="d-main" key=${s.ask?.id || 'over'}>${main}</div>`}
      ${zone}
      <${Tray} s=${s} />
      <${Log} lines=${s.log} />
      <div class="d-foot">
        <label>Jace's speed <select value=${String(speed)} onChange=${(e) => {
          setSpeed(+e.target.value);
          setPref('speed', +e.target.value);
          act('speed', { value: +e.target.value });
        }}>${SPEEDS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></label>
        <label>Stop for me <select value=${s.stops || 'smart'} onChange=${(e) => act('stops', { value: e.target.value })}>
          <option value="smart">When it matters</option><option value="held">At every step I can act</option><option value="all">At every step</option></select></label>
        <label class="check"><input type="checkbox" checked=${s.autoPay} onChange=${(e) => act('autopay', { value: e.target.checked })} /> Auto-pay mana (untick to choose lands)</label>
        <div class="d-btns">${!s.gameOver && html`<button class="danger" onClick=${() => confirm('Concede this game?') && act('concede')}>Concede</button>`}<button onClick=${leaveGame}>Leave game</button></div>
      </div>
    </aside>
    <${Toasts} notices=${s.notices} />
    ${tips && html`<${Tour} steps=${BOARD_TIPS} onDone=${() => { setTips(false); setPref('boardTipsDone', true); }} />`}
  </div>`;
}

// ---- lifecycle (called from app.js) ----
const root = document.getElementById('view-game');
async function startGame(you, bot, level) {
  G.running = false;
  Object.assign(G, { you, bot, level, version: -1, tipsShown: false });
  artCache = null;
  root.hidden = false;
  render(null, root);
  render(html`<${Game} />`, root);
  try {
    const r = await call('start_game', you, bot, level || null);
    Object.assign(G, { port: r.port, running: true, version: -1, reviews: r.reviews });
    poll(r.port);
  } catch {
    root.hidden = true;
    render(null, root);
  }
}

async function leaveGame() {
  G.running = false;
  await call('stop_game');
  root.hidden = true;
  hidePreview();
  render(null, root);
}

window.startGame = startGame;
window.leaveGame = leaveGame;
