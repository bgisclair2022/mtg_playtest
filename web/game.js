// In-app board for a Forge-powered match (see bridge/src/goldfish/Bridge.java).
// The bridge owns all rules: every click here is forwarded to Forge, which decides what it means.
const G = { port: null, running: false, version: -1, state: null, images: {}, asked: new Set(), askId: null, sel: [], seenNotice: 0, lastRef: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every step of the turn (CR 500-514); combat is split so each sub-step is visible.
const PHASES = [
  ['Upkeep', ['UNTAP', 'UPKEEP']], ['Draw', ['DRAW']], ['Main 1', ['MAIN1']],
  ['Begin combat', ['COMBAT_BEGIN']], ['Attackers', ['COMBAT_DECLARE_ATTACKERS']], ['Blockers', ['COMBAT_DECLARE_BLOCKERS']],
  ['Damage', ['COMBAT_FIRST_STRIKE_DAMAGE', 'COMBAT_DAMAGE']], ['End combat', ['COMBAT_END']],
  ['Main 2', ['MAIN2']], ['End', ['END_OF_TURN', 'CLEANUP']],
];
const STEP_NAMES = {
  UPKEEP: 'upkeep', DRAW: 'draw step', MAIN1: 'first main phase', MAIN2: 'second main phase', COMBAT_BEGIN: 'beginning of combat',
  COMBAT_DECLARE_ATTACKERS: 'declare attackers step', COMBAT_DECLARE_BLOCKERS: 'declare blockers step',
  COMBAT_FIRST_STRIKE_DAMAGE: 'first-strike damage step', COMBAT_DAMAGE: 'combat damage step', COMBAT_END: 'end of combat',
  END_OF_TURN: 'end step', CLEANUP: 'cleanup step',
};
const stepName = (key, fallback) => STEP_NAMES[key] || (fallback || '').toLowerCase();
const MANA_BG = { W: '#f3eccd', U: '#5b9bd5', B: '#a99bab', R: '#e0634b', G: '#5fae6a', C: '#c9c5bd' };

// ---- lifecycle ----
async function startGame(you, bot) {
  $('#view-game').hidden = false;
  loading('Starting Forge… (the first game takes ~20 seconds to load cards)');
  try {
    const r = await call('start_game', you, bot);
    Object.assign(G, { port: r.port, running: true, version: -1, state: null, askId: null, seenNotice: 0, overShown: false, actionId: null, reviews: r.reviews });
    $('#g-autopass').checked = true;
    poll();
  } catch {
    $('#view-game').hidden = true;
  }
}

async function leaveGame() {
  G.running = false;
  await call('stop_game');
  $('#view-game').hidden = true;
}

async function poll() {
  const port = G.port;
  while (G.running && G.port === port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/state?v=${G.version}`, { signal: AbortSignal.timeout(30000) });
      const s = await res.json();
      if (G.version === -1 && s.speed !== undefined && String(s.speed) !== $('#g-speed').value) {
        act('speed', { value: +$('#g-speed').value }); // apply the remembered speed to a new game
      }
      G.version = s.version;
      G.state = s;
      render();
    } catch {
      if (!(await api.game_alive())) {
        loading('Forge stopped unexpectedly. Details are in data/logs/.', true);
        G.running = false;
        return;
      }
      await sleep(800); // still loading
    }
  }
}

function send(path, body) {
  // text/plain keeps this a "simple" request, so no CORS preflight to the bridge
  return fetch(`http://127.0.0.1:${G.port}${path}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
}
const act = (type, extra = {}) => send('/act', { type, ...extra });
const answer = (value) => { const id = G.askId; $('#g-ask').hidden = true; return send('/answer', { id, value }); };

function loading(msg, stuck = false) {
  $('#g-loading').hidden = false;
  $('#g-loading-msg').innerHTML = esc(msg) + (stuck ? '<br><br><button onclick="leaveGame()">Back</button>' : '');
  $('#g-loading .spinner').hidden = stuck;
}

// ---- card art (Scryfall, via the Python side's cache) ----
let imageTimer = null;
function wantImages(cards) {
  const missing = cards.filter((c) => c.name && !c.token && !(c.name in G.images) && !G.asked.has(c.name)).map((c) => c.name);
  if (!missing.length) return;
  missing.forEach((n) => G.asked.add(n));
  clearTimeout(imageTimer);
  imageTimer = setTimeout(async () => {
    const names = [...G.asked].filter((n) => !(n in G.images));
    const found = await api.card_images(names);
    if (found && !found.error) {
      names.forEach((n) => { G.images[n] = found[n] || null; });
      render();
    }
  }, 150);
}

// ---- rendering ----
function render() {
  const s = G.state;
  if (!s || !s.players) return loading(s?.prompt?.message || 'Starting Forge…');
  $('#g-loading').hidden = true;
  const me = s.players.find((p) => p.local), opp = s.players.find((p) => !p.local);
  const all = s.players.flatMap((p) => [...p.hand, ...p.battlefield, ...p.command, ...p.graveyard, ...p.exile]).concat(s.stack.map((x) => x.card).filter(Boolean));
  wantImages(all);

  const blocks = {}; // blocker id -> attacker name
  for (const c of s.combat) {
    const a = all.find((x) => x.id === c.attacker);
    c.blockers.forEach((b) => { blocks[b] = a?.name || ''; });
  }
  const top = topOfStack(s);
  G.targeted = new Set((top?.targets || []).map((t) => t.card ?? `p${t.player}`));
  renderPlayer($('#g-opp'), opp, s, blocks);
  renderPlayer($('#g-me'), me, s, blocks);
  renderHand(me);
  renderCenter(s, me);
  renderLog(s.log);
  renderNotices(s.notices);
  renderAction(s.lastAction);
  renderTrigger(s, me);
  renderDecision(s);
  renderCombat(s, me, opp);
  renderTray(s);
  if (s.gameOver) renderGameOver(s); else renderAsk(s.ask);
}

function renderPlayer(el, p, s, blocks) {
  const mine = p.local;
  const pool = Object.entries(p.mana);
  const paying = mine && /^InputPayMana/.test(s.prompt.input || '');
  const manaBox = mine || pool.length ? `
      <div class="g-manabox ${paying ? 'paying' : ''}">
        <div class="lbl">Mana pool${paying ? ' · click to spend' : ''}</div>
        <div class="pips">${pool.map(([k, n]) => `<button class="pip" data-color="${k}" style="background:${MANA_BG[k] || '#ccc'}" title="Spend ${k} from your pool">${k}<b>${n}</b></button>`).join('') || '<span class="muted">empty</span>'}</div>
        ${mine && p.untappedSources >= 0 ? `<div class="src">${p.untappedSources} untapped mana source${p.untappedSources === 1 ? '' : 's'}</div>` : ''}
      </div>` : '';
  // Forge highlights card targets itself, but not players; light both up when a player could be the target
  const targeting = /^InputSelect(Targets|Entities)/.test(s.prompt.input || '') && /player|opponent|any target/i.test(s.prompt.message);
  p.highlighted = p.highlighted || targeting;
  const cmdDmg = Object.entries(p.commanderDamage).map(([n, d]) => `<span title="Commander damage from ${esc(n)}">⚔ ${d}/21</span>`).join('');
  const status = Object.entries(p.playerCounters || {}).map(([k, n]) => `<span class="status" title="${esc(k)} counters">${COUNTER_ICONS[k.toLowerCase()] || '●'} ${n} ${esc(k.toLowerCase())}</span>`).join('')
    + (p.flags || []).map((f) => `<span class="status flag">${f === 'Monarch' ? '👑 ' : f === 'Initiative' ? '🏰 ' : ''}${esc(f)}</span>`).join('');
  const hot = (zone) => p[zone].some((c) => c.playable || c.selectable) ? 'hot' : ''; // something usable in there
  el.innerHTML = `
    <div class="g-info">
      <div class="g-name"><span>${mine ? '' : '<img class="g-avatar" src="img/jace.png" alt="">'}${esc(p.name)}${mine ? ' <span class="muted">(you)</span>' : ''}</span>${p.priority ? '<span class="prio">● priority</span>' : ''}</div>
      <div class="g-life ${p.highlighted ? 'target' : ''} ${G.targeted?.has(`p${p.id}`) ? 'targeted' : ''}" data-player="${p.id}" title="Click to target this player">${p.life}</div>
      <div class="g-stats">
        ${mine ? '' : `<span title="Cards in hand">✋ ${p.handSize}</span>`}
        <span title="Library">📚 ${p.library}</span>
        <button data-zone="graveyard" class="${hot('graveyard')}" title="Graveyard">🪦 ${p.graveyard.length}</button>
        <button data-zone="exile" class="${hot('exile')}" title="Exile">⌀ ${p.exile.length}</button>
        ${cmdDmg}${status}
      </div>
      ${manaBox}
      <div class="g-cmd"></div>
    </div>
    <div class="g-field"><div class="g-row"></div><div class="g-row lands"></div>${mine ? '' : `<div class="g-row opphand" title="${esc(p.name)}&#39;s hand"></div>`}</div>`;
  el.querySelector('.g-life').onclick = () => act('player', { id: p.id });
  el.querySelectorAll('.pip').forEach((b) => b.onclick = () => act('mana', { color: b.dataset.color }));
  if (!mine) {
    const oh = el.querySelector('.opphand');
    p.hand.forEach((c) => { const sl = slot(c); sl.querySelector('.gc').onclick = null; oh.appendChild(sl); });
  }
  el.querySelectorAll('[data-zone]').forEach((b) => b.onclick = () => showZone(p, b.dataset.zone));
  p.command.forEach((c) => el.querySelector('.g-cmd').appendChild(slot(c, { tax: (p.commanderTax || {})[c.id] })));
  const [row, lands] = el.querySelectorAll('.g-row');
  const everything = s.players.flatMap((pl) => pl.battlefield);
  const onHost = (c) => c.attachedTo && everything.some((h) => h.id === c.attachedTo);
  const nonLands = p.battlefield.filter((c) => !c.land && !onHost(c));
  nonLands.sort((a, b) => (b.creature - a.creature));
  nonLands.forEach((c) => row.appendChild(hostSlot(c, { blocks: blocks[c.id] }, everything.filter((a) => a.attachedTo === c.id))));
  // group identical lands so a 40-land Commander board stays readable
  const groups = [];
  for (const c of p.battlefield.filter((c) => c.land && !onHost(c))) {
    const key = [c.name, c.tapped, c.selectable, c.highlighted, c.playable, c.manaSource].join('|');
    const g = groups.find((x) => x.key === key && !c.attachedTo && !Object.keys(c.counters).length);
    if (g) g.cards.push(c); else groups.push({ key, cards: [c] });
  }
  groups.forEach((g) => lands.appendChild(slot(g.cards[0], { count: g.cards.length })));
}

function renderHand(me) {
  const hand = $('#g-hand');
  hand.innerHTML = '';
  const n = me.hand.length;
  hand.style.setProperty('--overlap', n > 9 ? `${Math.min(40, (n - 9) * 5)}px` : '0px');
  me.hand.forEach((c) => hand.appendChild(slot(c)));
}

// A permanent with whatever is attached to it (auras, equipment) shown small underneath.
function hostSlot(c, opts, attached) {
  if (!attached.length) return slot(c, opts);
  const wrap = document.createElement('div');
  wrap.className = 'gc-host';
  wrap.appendChild(slot(c, opts));
  const row = document.createElement('div');
  row.className = 'gc-attached';
  attached.forEach((a) => row.appendChild(slot(a)));
  wrap.appendChild(row);
  return wrap;
}

function slot(c, opts = {}) {
  const s = document.createElement('div');
  s.className = 'gc-slot' + (c.tapped ? ' tapped' : '') + (c.attacking ? ' attacking' : '');
  s.appendChild(cardEl(c, opts));
  return s;
}

function cardEl(c, opts = {}) {
  const el = document.createElement('div');
  const flags = ['selectable', 'playable', 'highlighted', 'attacking', 'blocking'].filter((f) => c[f]);
  const input = G.state?.prompt?.input || '';
  if (c.manaSource && /^InputPayMana/.test(input)) flags.push(c.manaSource > 1 ? 'selectable' : 'mana-source');
  if (c.manaSource && /^Input(Block|Attack)$/.test(input) && !c.attacking && !c.blocking) flags.push('mana-source'); // could attack/block
  el.className = 'gc ' + flags.join(' ') + (c.hidden ? ' back' : '') + (G.targeted?.has(c.id) ? ' targeted' : '') + (c.phasedOut ? ' phased' : '');
  const img = !c.hidden && !c.token && G.images[c.name];
  el.innerHTML = c.hidden ? '' : img ? `<img src="${esc(img)}" alt="${esc(c.name)}">`
    : `<div class="gc-text"><b>${esc(c.name)}</b><small>${esc(c.type)}</small><p>${esc(c.text)}</p></div>`;
  if (c.creature) el.innerHTML += `<span class="pt ${c.damage ? 'hurt' : ''}">${c.power}/${c.toughness - (c.damage || 0)}</span>`;
  if (c.faceDown) el.innerHTML += `<span class="facedown" title="${c.hidden ? 'Face-down 2/2' : 'Face-down on the table (only you see what it is)'}">face-down</span>`;
  if (c.phasedOut) el.innerHTML += '<span class="facedown">phased out</span>';
  if (c.loyalty) el.innerHTML += `<span class="pt">◆${esc(c.loyalty)}</span>`;
  const counters = Object.entries(c.counters || {}).map(([k, v]) => `${v} ${k}`).join(', ');
  if (counters) el.innerHTML += `<span class="badge">${esc(counters)}</span>`;
  if (opts.count > 1) el.innerHTML += `<span class="count">×${opts.count}</span>`;
  if (opts.tax) el.innerHTML += `<span class="count" title="Commander tax">+${opts.tax}</span>`;
  if (c.sick && c.creature && !c.hidden) el.innerHTML += '<span class="sick" title="Summoning sick">💤</span>';
  if (opts.blocks) el.innerHTML += `<span class="blocks">blocks ${esc(opts.blocks)}</span>`;
  if (G.targeted?.has(c.id)) el.innerHTML += '<span class="crosshair" title="Targeted">🎯</span>';
  el.onclick = () => act('card', { id: c.id });
  el.onmouseenter = () => preview(c);
  return el;
}

function preview(c) {
  if (c.hidden) return;
  const img = !c.token && G.images[c.name];
  $('#g-preview').innerHTML = img ? `<img src="${esc(img)}">`
    : `<div class="gc-text"><b>${esc(c.name)}</b><small>${esc(c.type)}</small><p>${esc(c.text)}</p></div>`;
}

function friendlyPrompt(s, me) {
  const p = s.prompt;
  const myTurn = s.activePlayer === me.id;
  if (p.input === 'InputPassPriority') {
    const top = topOfStack(s);
    if (top) {
      const thing = `${top.card?.name || 'spell'}${top.trigger ? ' trigger' : ''}${targetText(top)}`;
      const what = `${top.mine ? 'Your' : `${botName()}'s`} ${thing}`;
      if (G.responding === top.id) {
        return { msg: `Responding to ${top.mine ? 'your' : `${botName()}'s`} ${thing}: click a glowing card to cast or activate it.`, hideOk: true, hideCancel: true, extra: ['Back', () => { G.responding = null; render(); }] };
      }
      const canRespond = s.holding || me.hand.concat(me.battlefield, me.command, me.graveyard, me.exile).some((c) => c.playable && !c.land);
      return { msg: `${what} is on the stack. Pass priority to let it resolve${canRespond ? ', or respond' : ''}.`, ok: 'Pass priority', hideCancel: true,
        extra: canRespond ? ['Respond', () => { G.responding = top.id; render(); }] : null };
    }
    if (myTurn && s.phaseKey === 'MAIN1') return { msg: 'Your main phase: play a land and cast spells (green = playable). Next goes to combat.', ok: 'To combat' };
    if (myTurn && s.phaseKey === 'MAIN2') return { msg: 'Second main phase. Cast anything else, then end your turn.', ok: 'End turn' };
    // Any other step: you have priority in it (CR 117.3a). The bridge holds when you can act, else passes shortly.
    const step = `${myTurn ? 'Your' : `${botName()}'s`} ${stepName(s.phaseKey, s.phase)}`;
    const options = me.hand.concat(me.battlefield, me.command, me.graveyard, me.exile).filter((c) => c.playable && !c.land).map((c) => c.name);
    if (s.holding && options.length) {
      return { msg: `${step}. You have priority: respond with ${[...new Set(options)].join(', ')}, or pass.`, ok: 'Pass priority', hideCancel: !myTurn };
    }
    return { msg: `${step}. Nothing to respond with, passing priority…`, ok: 'Pass priority', hideCancel: !myTurn };
  }
  if (/^InputPayMana/.test(p.input || '')) {
    return { msg: `${p.message.split('\n').filter(Boolean).slice(-1)[0] || 'Pay the cost'}. Click lands or other mana sources (gold), or mana in your pool.` };
  }
  if (p.input === 'InputAttack') return { msg: 'Click creatures to attack with them (click again to remove).', ok: 'Confirm attack', extra: ['Attack with all', () => act('alpha')] };
  if (p.input === 'InputBlock') return { msg: `Declare blockers: ${p.message} Confirm when done, or confirm with none to take the damage.`, ok: 'Confirm blocks' };
  return { msg: p.message };
}
const COUNTER_ICONS = { poison: '☠', energy: '⚡', experience: '✦', rad: '☢', ticket: '🎟' };
const botName = () => G.state?.players?.find((p) => !p.local)?.name || 'The bot';
const tidy = (msg) => msg.replace(/ \(\d+\)/g, ''); // Forge appends internal card ids like "Shock (29)"
const topOfStack = (s) => s.stack.find((x) => x.top) || s.stack[0] || null;
const targetText = (it) => (it.targets?.length ? ` → ${it.targets.map((t) => t.name).join(', ')}` : '');

// "Trigger!" pop-up for as long as a triggered ability sits on top of the stack. The bridge either
// holds priority (you can respond) or lets it resolve after a moment, so you always see it.
function renderTrigger(s, me) {
  const el = $('#g-trigger'), top = topOfStack(s);
  if (!top || !top.trigger || s.gameOver) { el.hidden = true; G.triggerId = null; return; }
  const holding = s.prompt.input === 'InputPassPriority' && s.prompt.okOn && s.holding;
  if (G.triggerId !== top.id) { // fresh pop-up (replay the entrance animation)
    G.triggerId = top.id;
    el.innerHTML = '';
    if (top.card) { el.appendChild(slot(top.card)); preview(top.card); }
    const targets = top.targets?.length ? `<p class="targets">🎯 Targets: ${top.targets.map((t) => esc(t.name)).join(', ')}</p>` : '';
    el.insertAdjacentHTML('beforeend', `<div><h2>Trigger!</h2><p>${esc(tidy(top.text))}</p>${targets}<div class="who"></div></div>`);
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  }
  el.querySelector('.who').textContent = `${top.mine ? 'Your' : `${botName()}'s`} trigger · ${holding ? 'pass priority to resolve it, or respond' : 'resolving…'}`;
  el.hidden = false;
}

function renderCenter(s, me) {
  const myTurn = s.activePlayer === me.id;
  const t = $('#g-turn');
  t.textContent = (s.mulligan || !s.turn ? 'Game start' : `Round ${s.round} · ${myTurn ? 'Your' : `${botName()}'s`} turn`)
    + (s.dayNight === 'day' ? ' · ☀ Day' : s.dayNight === 'night' ? ' · ☾ Night' : '');
  t.className = myTurn ? 'mine' : 'theirs';
  $('#g-phases').innerHTML = PHASES.map(([label, keys]) => `<span class="${keys.includes(s.phaseKey) ? 'on' : ''}">${label}</span>`).join('');
  $('#g-stack').innerHTML = '';
  s.stack.forEach((it) => {
    const d = document.createElement('div');
    d.className = 'st' + (it.trigger ? ' trigger' : '');
    if (it.card) d.appendChild(slot(it.card));
    d.insertAdjacentHTML('beforeend', `<span>${it.trigger ? '<span class="tag">TRIGGER</span>' : ''}${esc(tidy(it.text))}${it.targets?.length ? `<b class="tg">🎯 ${it.targets.map((x) => esc(x.name)).join(', ')}</b>` : ''}</span>`);
    $('#g-stack').appendChild(d);
  });
  const f = friendlyPrompt(s, me), p = s.prompt;
  $('#g-msg').textContent = tidy(f.msg);
  const pc = $('#g-promptcard');
  pc.innerHTML = '';
  if (p.card) { pc.appendChild(slot(p.card)); pc.querySelector('.gc').onclick = null; wantImages([p.card]); }
  const ok = $('#g-ok'), cancel = $('#g-cancel'), extra = $('#g-extra');
  ok.textContent = f.ok || p.ok; ok.hidden = !p.okOn || f.hideOk; ok.onclick = () => act('ok');
  cancel.textContent = p.cancel; cancel.hidden = !p.cancelOn || f.hideCancel; cancel.onclick = () => act('cancel');
  extra.hidden = !f.extra;
  if (f.extra) { extra.textContent = f.extra[0]; extra.onclick = f.extra[1]; }
  $('#g-autopass').checked = s.autoPass;
  $('#g-autopay').checked = s.autoPay;
}

function renderLog(lines) {
  const el = $('#g-log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  el.innerHTML = lines.map((l) => {
    const t = /^Turn (\d+) \((.+)\)$/.exec(l);
    return t ? `<div class="round">Round ${Math.ceil(+t[1] / 2)} · ${esc(t[2])}'s turn</div>` : `<div>${esc(tidy(l))}</div>`;
  }).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function renderNotices(ns) {
  for (const n of ns) {
    if (n.id <= G.seenNotice) continue;
    G.seenNotice = n.id;
    const d = document.createElement('div');
    d.textContent = tidy(n.text);
    $('#g-toasts').appendChild(d);
    setTimeout(() => d.remove(), 6000);
  }
}

// Banner for what the bot just did; the bridge holds the game for a.ms while it shows.
let actionTimer = null;
function renderAction(a) {
  if (!a || a.id === G.actionId) return;
  G.actionId = a.id;
  const el = $('#g-action');
  if (!a.ms) { el.hidden = true; return; } // "Instant" speed: no banner
  el.innerHTML = '';
  if (a.card) { el.appendChild(slot(a.card)); preview(a.card); }
  el.insertAdjacentHTML('beforeend', `<span>${esc(tidy(a.text))}</span>`);
  el.className = /^Your turn/.test(a.text) ? 'mine' : '';
  el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(actionTimer);
  actionTimer = setTimeout(() => { el.hidden = true; }, Math.max(a.ms, 900) + 300);
}

// Declare attackers / blockers (turn-based actions, CR 508.1 / 509.1): a clear banner, clicks pass through to the board.
function renderCombat(s, me, opp) {
  const el = $('#g-combat'), input = s.prompt.input;
  if (input !== 'InputBlock' && input !== 'InputAttack') { el.hidden = true; return; }
  if (input === 'InputBlock') {
    const attackers = s.combat.map((c) => opp.battlefield.find((x) => x.id === c.attacker)).filter(Boolean);
    const unblocked = s.combat.filter((c) => !c.blockers.length).map((c) => opp.battlefield.find((x) => x.id === c.attacker)).filter(Boolean);
    const incoming = unblocked.reduce((t, c) => t + (c.power || 0), 0);
    el.innerHTML = `<h2>⚔ ${esc(botName())} attacks with ${attackers.length} creature${attackers.length === 1 ? '' : 's'}</h2>
      <p>${attackers.map((c) => `<b>${esc(c.name)}</b> ${c.power}/${c.toughness}`).join(' · ')}</p>
      <p>${esc(tidy(s.prompt.message))}</p>
      <p>Click your creature (gold = can block) to block that attacker, or click another attacker first to switch.
      Unblocked damage right now: <b>${incoming}</b>. Then press Confirm blocks.</p>`;
  } else {
    el.innerHTML = `<h2>⚔ Declare attackers</h2><p>Click your creatures (gold = can attack) to attack ${esc(botName())}, then Confirm attack.</p>`;
  }
  el.hidden = false;
}

// Cards you can use (or must pick) that live in a graveyard or exile, surfaced so you don't have to go looking.
function renderTray(s) {
  const el = $('#g-tray');
  const items = [];
  for (const pl of s.players) {
    for (const c of pl.librarySelectable || []) items.push({ c, where: `${pl.local ? 'your' : `${pl.name}'s`} library` });
    for (const zone of ['graveyard', 'exile']) {
      for (const c of pl[zone]) {
        if (c.selectable || (pl.local && c.playable)) items.push({ c, where: `${pl.local ? 'your' : `${pl.name}'s`} ${zone}` });
      }
    }
  }
  if (!items.length) { el.hidden = true; return; }
  el.innerHTML = '<div class="lbl">Usable from graveyard / exile / library</div><div class="row"></div>';
  const row = el.querySelector('.row');
  items.forEach(({ c, where }) => { const sl = slot(c); sl.title = where; row.appendChild(sl); });
  wantImages(items.map((x) => x.c));
  el.hidden = false;
}

// Forge asks some yes/no questions through the prompt bar (InputConfirm); show them as a proper dialog.
function renderDecision(s) {
  const el = $('#g-decide'), p = s.prompt;
  const show = /^InputConfirm/.test(p.input || '') && p.input !== 'InputConfirmMulligan' && !s.ask && p.okOn && !s.gameOver;
  if (!show) { el.hidden = true; return; }
  const cmdZone = /command zone/i.test(p.message);
  const name = p.card?.name || (cmdZone ? p.message.split(':')[0] : '') || 'Your commander'; // Forge names it in the text
  const title = cmdZone ? `Your commander ${esc(name)} left play` : 'Decision';
  const text = cmdZone ? `It went to your graveyard or exile. Move it to the command zone (so you can recast it), or leave it where it is?` : esc(tidy(p.message));
  const [yes, no] = cmdZone ? ['Command zone', 'Leave it'] : [p.ok, p.cancel];
  el.innerHTML = `<div class="g-decide-box"><div class="card-spot"></div><div><h2>${title}</h2><p>${text}</p>
    <div class="row"><button class="primary" id="g-dyes">${esc(yes)}</button>${p.cancelOn ? `<button id="g-dno">${esc(no)}</button>` : ''}</div></div></div>`;
  if (p.card) { const sl = slot(p.card); sl.querySelector('.gc').onclick = null; el.querySelector('.card-spot').appendChild(sl); }
  el.querySelector('#g-dyes').onclick = () => { el.hidden = true; act('ok'); };
  el.querySelector('#g-dno')?.addEventListener('click', () => { el.hidden = true; act('cancel'); });
  el.hidden = false;
}

// ---- questions Forge asks (choices, confirms, numbers) ----
function renderAsk(a) {
  const wrap = $('#g-ask');
  if (!a) { wrap.hidden = true; G.askId = null; return; }
  if (G.askId === a.id) return; // keep the in-progress selection
  G.askId = a.id; G.sel = [];
  wrap.hidden = false; wrap.classList.remove('peek');
  const box = wrap.querySelector('.g-ask-box');
  const head = `<h3>${esc(tidy(a.message))}</h3>`;
  const peek = '<button class="peek-btn">Look at board</button>';

  if (a.kind === 'options') {
    box.innerHTML = head + (a.card ? '<div class="g-ask-items"></div>' : '') +
      `<div class="g-ask-foot">${peek}${a.options.map((o, i) => `<button data-i="${i}" class="${i === 0 ? 'primary' : ''}">${esc(o)}</button>`).join('')}</div>`;
    if (a.card) { box.querySelector('.g-ask-items').appendChild(slot(a.card)); box.querySelector('.g-ask-items .gc').onclick = null; }
    box.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => answer(+b.dataset.i));
  } else if (a.kind === 'choose') {
    const cards = a.items.some((it) => it.card);
    const single = a.max === 1 && !a.ordered;
    box.innerHTML = head + `<div class="g-ask-items ${cards ? '' : 'text'}"></div>
      <div class="g-ask-foot"><span class="muted">${single ? 'Pick one.' : a.min === a.max ? `Pick ${a.min}${a.ordered ? ' in order' : ''}.` : `Pick ${a.min}–${a.max}${a.ordered ? ' in order' : ''}.`}</span>
      ${peek}${a.min === 0 ? '<button class="skip">None</button>' : ''}${single ? '' : '<button class="primary done">Done</button>'}</div>`;
    const list = box.querySelector('.g-ask-items');
    a.items.forEach((it, i) => {
      const o = document.createElement('div');
      o.className = 'opt';
      if (it.card) {
        o.appendChild(slot(it.card));
        if (it.label !== it.card.name) o.insertAdjacentHTML('beforeend', `<div class="cap">${esc(it.label)}</div>`);
        o.querySelector('.gc').onclick = null;
      } else {
        o.innerHTML = `<button>${esc(it.label)}</button>`;
      }
      o.onclick = () => {
        if (single) return answer([i]);
        const at = G.sel.indexOf(i);
        if (at >= 0) G.sel.splice(at, 1); else if (G.sel.length < a.max) G.sel.push(i);
        list.querySelectorAll('.opt').forEach((x, j) => {
          const k = G.sel.indexOf(j);
          x.classList.toggle('sel', k >= 0);
          x.querySelector('.num')?.remove();
          if (k >= 0 && a.ordered) x.insertAdjacentHTML('afterbegin', `<span class="num">${k + 1}</span>`);
        });
        box.querySelector('.done').disabled = G.sel.length < a.min;
      };
      list.appendChild(o);
    });
    if (a.items.length > 20) { // long lists get a filter
      list.insertAdjacentHTML('beforebegin', '<input class="g-filter" placeholder="Type to filter…">');
      const f = box.querySelector('.g-filter');
      f.oninput = () => list.querySelectorAll('.opt').forEach((o, j) => {
        o.hidden = !a.items[j].label.toLowerCase().includes(f.value.toLowerCase());
      });
      setTimeout(() => f.focus(), 0);
    }
    wantImages(a.items.map((it) => it.card).filter(Boolean));
    box.querySelector('.skip')?.addEventListener('click', () => answer([]));
    const done = box.querySelector('.done');
    if (done) { done.disabled = a.min > 0; done.onclick = () => answer(G.sel); }
  } else if (a.kind === 'number' || a.kind === 'input') {
    const num = a.kind === 'number' || a.numeric;
    box.innerHTML = head + `<div class="row"><input id="g-num" ${num ? `type="number" min="${a.min ?? ''}" max="${a.max ?? ''}"` : ''} value="${esc(a.initial ?? a.min ?? '')}">
      <button class="primary" id="g-num-ok">OK</button><button id="g-num-cancel">Cancel</button>${peek}</div>`;
    box.querySelector('#g-num-ok').onclick = () => { const v = box.querySelector('#g-num').value; answer(num ? +v : v); };
    box.querySelector('#g-num-cancel').onclick = () => answer(null);
    setTimeout(() => box.querySelector('#g-num').focus(), 0);
  } else if (a.kind === 'distribute') {
    box.innerHTML = head + `<div class="g-dist">${a.items.map((it, i) => `<span>${esc(it.label)}</span><input type="number" min="${a.atLeastOne ? 1 : 0}" value="${i === 0 ? a.amount : 0}" data-i="${i}">`).join('')}</div>
      <div class="g-ask-foot"><span class="muted left"></span>${peek}<button class="primary">OK</button></div>`;
    const inputs = [...box.querySelectorAll('input')], ok = box.querySelector('.primary'), left = box.querySelector('.left');
    const check = () => {
      const sum = inputs.reduce((t, x) => t + (+x.value || 0), 0);
      left.textContent = `${a.amount - sum} left to assign`;
      ok.disabled = sum !== a.amount || (a.atLeastOne && inputs.some((x) => +x.value < 1));
    };
    inputs.forEach((x) => x.oninput = check); check();
    ok.onclick = () => answer(inputs.map((x) => +x.value || 0));
  }
  box.querySelectorAll('.peek-btn').forEach((b) => b.onclick = () => {
    wrap.classList.toggle('peek');
    b.textContent = wrap.classList.contains('peek') ? 'Back to question' : 'Look at board';
  });
}

function showZone(p, zone) {
  const cards = p[zone];
  const box = modal(`<h2>${p.local ? 'Your' : `${botName()}'s`} ${zone} (${cards.length})</h2><div class="g-ask-items"></div>`);
  box.style.width = 'min(900px, 92vw)';
  const list = box.querySelector('.g-ask-items');
  cards.forEach((c) => { const o = document.createElement('div'); o.className = 'opt'; o.style.setProperty('--cw', '120px'); o.appendChild(slot(c)); list.appendChild(o); });
  wantImages(cards);
  if (!cards.length) list.innerHTML = '<p class="muted">Empty.</p>';
}

function renderGameOver(s) {
  if (G.overShown) return;
  G.overShown = true;
  const box = $('#g-ask .g-ask-box');
  $('#g-ask').hidden = false;
  $('#g-ask').classList.remove('peek');
  const won = s.winner && s.players.find((p) => p.local && p.name === s.winner);
  box.innerHTML = `<div class="g-over"><h2>${won ? '🏆 You win!' : s.winner ? `${esc(s.winner)} wins` : 'Draw'}</h2>
    <p class="muted">Round ${s.round}</p><div class="row" style="justify-content:center">
    <button class="primary" id="g-again">Rematch</button><button id="g-back">Back to decks</button><button id="g-stay">Look at the board</button></div>
    ${G.reviews ? '<div class="g-review"><div class="spinner"></div> Claude is reviewing the game and updating the bot\'s lessons…</div>' : ''}</div>`;
  box.querySelector('#g-again').onclick = () => startGame(pick('#you-deck'), pick('#bot-deck'));
  box.querySelector('#g-back').onclick = leaveGame;
  box.querySelector('#g-stay').onclick = () => { $('#g-ask').hidden = true; };
  if (G.reviews) reviewGame(box.querySelector('.g-review'));
}

// Post-game review by Claude: grades the bot's decisions (and yours) and updates data/bot-lessons.md.
async function reviewGame(el) {
  const r = await api.review_game();
  if (!r || r.error) { el.innerHTML = `<span class="bad">Review failed: ${esc(r?.error || 'no answer')}</span>`; return; }
  const mark = { optimal: '✅', fine: '➖', mistake: '❌' };
  el.innerHTML = `<h3>Game review</h3><p>${esc(r.summary)}</p>
    <h4>Jace's key decisions</h4><ul>${(r.bot_decisions || []).map((d) => `<li>${mark[d.verdict] || ''} <b>${esc(d.when)}</b>: ${esc(d.choice)}${d.better ? `<br><span class="muted">Better: ${esc(d.better)}</span>` : ''}</li>`).join('')}</ul>
    ${r.your_play?.length ? `<h4>Your play</h4><ul>${r.your_play.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="row"><button id="g-report">Open full report</button><button id="g-lessons">Open Jace's lessons</button></div>`;
  el.querySelector('#g-report').onclick = () => api.open_file(r.report);
  el.querySelector('#g-lessons').onclick = () => api.open_lessons();
}

// ---- controls ----
$('#play-game').onclick = () => {
  if (!pick('#you-deck') || !pick('#bot-deck')) return toast('Pick both decks first.', true);
  startGame(pick('#you-deck'), pick('#bot-deck'));
};
$('#g-leave').onclick = leaveGame;
$('#g-concede').onclick = () => { if (confirm('Concede this game?')) act('concede'); };
$('#g-autopass').onchange = (e) => act('autopass', { value: e.target.checked });
$('#g-autopay').onchange = (e) => act('autopay', { value: e.target.checked });
$('#g-speed').onchange = (e) => {
  try { localStorage.setItem('goldfish-speed', e.target.value); } catch { /* per-viewer nicety only */ }
  act('speed', { value: +e.target.value });
};
try {
  const saved = localStorage.getItem('goldfish-speed');
  if ([...$('#g-speed').options].some((o) => o.value === saved)) $('#g-speed').value = saved;
} catch { /* ignore */ }
document.addEventListener('keydown', (e) => {
  if ($('#view-game').hidden || !$('#g-ask').hidden || !$('#modal').hidden || e.target.tagName === 'INPUT') return;
  if ((e.key === ' ' || e.key === 'Enter') && !$('#g-ok').hidden) { e.preventDefault(); act('ok'); }
  if (e.key === 'Escape' && !$('#g-cancel').hidden) act('cancel');
});
