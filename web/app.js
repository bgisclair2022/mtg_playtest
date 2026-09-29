// UI for MTG Goldfish. Every backend call goes through call(), which surfaces {error} results as toasts.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let api, decks = [], current = null, simTimer = null;

async function call(method, ...args) {
  const res = await api[method](...args);
  if (res && res.error) { toast(res.error, true); throw new Error(res.error); }
  return res;
}

function toast(msg, error = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), error ? 7000 : 3500);
}

function busy(button, label) {
  const old = button.textContent;
  button.disabled = true; button.textContent = label;
  return () => { button.disabled = false; button.textContent = old; };
}

// ---- tabs ----
document.querySelectorAll('.tab').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === b));
  document.querySelectorAll('.view').forEach((v) => v.hidden = v.id !== 'view-' + b.dataset.view);
  if (b.dataset.view === 'settings') loadSettings();
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-url]');
  if (a) { e.preventDefault(); api.open_url(a.dataset.url); }
});

// ---- deck library ----
function renderDeckList() {
  const item = (d) => `<li data-name="${esc(d.name)}" data-preset="${d.preset}" class="${current && current.name === d.name && current.preset === d.preset ? 'active' : ''}">
    ${esc(d.name)}<small>${esc(d.commander.split('\n').join(' + ') || 'no commander')}</small></li>`;
  $('#my-decks').innerHTML = decks.filter((d) => !d.preset).map(item).join('') || '<li class="muted">No saved decks yet</li>';
  $('#preset-decks').innerHTML = decks.filter((d) => d.preset).map(item).join('');
  document.querySelectorAll('.deck-list li[data-name]').forEach((li) => li.onclick = () => openDeck(li.dataset.name, li.dataset.preset === 'true'));
  const opts = decks.map((d) => `<option value='${esc(JSON.stringify({ name: d.name, preset: d.preset }))}'>${d.preset ? '★ ' : ''}${esc(d.name)}</option>`).join('');
  for (const id of ['#you-deck', '#bot-deck']) {
    const sel = $(id), keep = sel.value;
    sel.innerHTML = opts;
    if (keep) sel.value = keep;
  }
  if (!$('#bot-deck').value || $('#bot-deck').selectedIndex === $('#you-deck').selectedIndex) {
    const firstPreset = decks.findIndex((d) => d.preset);
    if (firstPreset >= 0) $('#bot-deck').selectedIndex = firstPreset;
  }
}

async function refreshDecks() { decks = await call('list_decks'); renderDeckList(); }

async function openDeck(name, preset) {
  const d = await call('load_deck', name, preset);
  current = { ...d, preset };
  fillEditor(d, preset);
  renderDeckList();
}

function fillEditor(d, preset = false) {
  $('#deck-name').value = d.name || '';
  $('#deck-commander').value = (d.commander || '').split('\n').join('; ');
  $('#deck-list').value = d.list || '';
  $('#deck-source').innerHTML = d.source ? `From <a href="#" data-url="${esc(d.source)}">Moxfield</a>` : (preset ? 'Preset: save a copy to edit it' : '');
  $('#delete-deck').disabled = preset;
  $('#deck-report').innerHTML = '';
}

function editorDeck() {
  return { name: $('#deck-name').value.trim(), commander: $('#deck-commander').value, list: $('#deck-list').value, source: current?.source || '' };
}

$('#new-deck').onclick = () => { current = null; fillEditor({}); renderDeckList(); $('#deck-name').focus(); };

$('#save-deck').onclick = async () => {
  const d = editorDeck();
  decks = await call('save_deck', d);
  current = { ...d, preset: false };
  renderDeckList();
  $('#delete-deck').disabled = false;
  toast(`Saved "${d.name}"`);
};

$('#delete-deck').onclick = async () => {
  if (!current || current.preset || !confirm(`Delete "${current.name}"?`)) return;
  decks = await call('delete_deck', current.name);
  current = null; fillEditor({}); renderDeckList();
};

$('#check-deck').onclick = async () => {
  const done = busy($('#check-deck'), 'Checking…');
  try { renderReport(await call('check_deck', editorDeck())); } finally { done(); }
};

function renderReport(r) {
  const s = r.stats, max = Math.max(1, ...s.curve);
  const problems = r.problems.length
    ? `<ul class="problems">${r.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
    : '<div class="good">✓ Legal Commander deck: 100 cards, singleton, within color identity.</div>';
  const curve = s.curve.map((n, i) => `<div style="height:${(n / max) * 100}%" data-n="${n || ''}" data-label="${i === 7 ? '7+' : i}"></div>`).join('');
  const types = Object.entries(s.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(' · ');
  const byType = {};
  for (const c of r.cards) {
    const t = ['Land', 'Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle'].find((x) => c.type_line.includes(x)) || 'Other';
    (byType[t] ||= []).push(c);
  }
  const tile = (c, extra = '') => `<div class="card ${extra}" data-img="${esc(c.image || '')}">
      ${c.image ? `<img loading="lazy" src="${esc(c.image)}" alt="${esc(c.name)}">` : `<div class="name">${esc(c.name)}</div>`}
      ${c.count > 1 ? `<span class="count">×${c.count}</span>` : ''}</div>`;
  $('#deck-report').innerHTML = `${problems}
    <div class="stats">
      <div class="stat"><b>${s.total}</b><span>cards</span></div>
      <div class="stat"><b>${s.avg_cmc}</b><span>avg mana value</span></div>
      <div class="stat"><div class="pips">${s.identity.map((c) => `<i class="pip" style="background:var(--${c})" title="${c}"></i>`).join('') || '<span class="muted">colorless</span>'}</div><span>color identity</span></div>
      <div class="stat"><div class="curve">${curve}</div><br></div>
      <div class="stat muted">${types}</div>
    </div>
    <div class="group"><h4>Commander</h4><div class="grid">${r.commanders.map((c) => tile(c, 'commander')).join('')}</div></div>
    ${Object.entries(byType).map(([t, cs]) => `<div class="group"><h4>${t} (${cs.reduce((a, c) => a + c.count, 0)})</h4>
      <div class="grid">${cs.sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name)).map((c) => tile(c)).join('')}</div></div>`).join('')}`;
}

// Large card preview on hover.
document.addEventListener('mouseover', (e) => {
  const card = e.target.closest('.card[data-img]');
  const p = $('#preview');
  if (!card || !card.dataset.img) { p.hidden = true; return; }
  const r = card.getBoundingClientRect();
  p.innerHTML = `<img src="${card.dataset.img}">`;
  p.style.left = (r.right + 316 < innerWidth ? r.right + 12 : r.left - 312) + 'px';
  p.style.top = Math.max(8, Math.min(r.top, innerHeight - 430)) + 'px';
  p.hidden = false;
});

// ---- Moxfield ----
function modal(html) {
  $('.modal-box').innerHTML = html;
  $('#modal').hidden = false;
  return $('.modal-box');
}
// A "locked" modal (the first-launch name prompt) can't be dismissed without answering.
const closeModal = () => { if (!$('#modal').dataset.locked) $('#modal').hidden = true; };
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function showUser(name) {
  $('#user-chip').textContent = '👤 ' + name;
  $('#user-chip').hidden = false;
}

function askName(first, current = '') {
  const box = modal(`<h2>${first ? 'Welcome to MTG Goldfish' : 'Your name'}</h2>
    <p class="muted">${first ? 'What should we call you? This is your name at the table and in the game log.' : 'Shown at the table and in the game log.'}</p>
    <div class="row"><input id="name-input" maxlength="24" placeholder="Your name" value="${esc(current)}"><button id="name-save" class="primary">${first ? "Let's go" : 'Save'}</button></div>`);
  $('#modal').dataset.locked = first ? '1' : '';
  const input = box.querySelector('#name-input');
  const save = async () => {
    const name = await call('set_username', input.value);
    delete $('#modal').dataset.locked;
    $('#modal').hidden = true;
    showUser(name);
  };
  box.querySelector('#name-save').onclick = save;
  input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  setTimeout(() => input.focus(), 0);
}
$('#user-chip').onclick = async () => askName(false, (await call('settings')).username || '');

$('#open-moxfield').onclick = async () => {
  const s = await call('settings');
  const box = modal(`<h2>Import from Moxfield</h2>
    <p class="muted">Moxfield has no official API, so this reads <b>public</b> decks only. If it stops working, use Export → Copy on Moxfield and paste into a new deck.</p>
    <div class="row"><input id="mox-url" placeholder="Deck URL, e.g. https://moxfield.com/decks/…"><button id="mox-import-url" class="primary">Import</button></div>
    <div class="row"><input id="mox-user" placeholder="…or your Moxfield username" value="${esc(s.moxfield_user || '')}"><button id="mox-list">List my decks</button></div>
    <ul id="mox-decks"></ul>`);
  const importDeck = async (url, button) => {
    const done = busy(button, 'Importing…');
    try {
      const d = await call('moxfield_import', url);
      await refreshDecks();
      await openDeck(d.name, false);
      toast(`Imported "${d.name}"`);
      $('#check-deck').click();
    } finally { done(); }
  };
  box.querySelector('#mox-import-url').onclick = (e) => importDeck($('#mox-url').value, e.target);
  box.querySelector('#mox-list').onclick = async (e) => {
    const done = busy(e.target, 'Loading…');
    try {
      const list = await call('moxfield_decks', $('#mox-user').value);
      $('#mox-decks').innerHTML = list.map((d) => `<li><span>${esc(d.name)}</span><button data-id="${esc(d.id)}">Import</button></li>`).join('') || '<li class="muted">No public Commander decks found.</li>';
      $('#mox-decks').querySelectorAll('button').forEach((b) => b.onclick = () => importDeck(b.dataset.id, b));
    } finally { done(); }
  };
};

// ---- Forge: play & simulate ----
const pick = (id) => JSON.parse($(id).value || 'null');

$('#play-forge').onclick = async () => {
  if (!pick('#you-deck') || !pick('#bot-deck')) return toast('Pick both decks first.', true);
  const done = busy($('#play-forge'), 'Exporting…');
  try {
    const r = await call('play_in_forge', pick('#you-deck'), pick('#bot-deck'));
    $('#play-msg').innerHTML = `<p class="ok">Decks exported and Forge is starting. Find them under Commander → deck list.</p>` +
      (r.warnings.length ? `<ul class="problems">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '');
  } finally { done(); }
};

$('#start-sim').onclick = async () => {
  if (!pick('#you-deck') || !pick('#bot-deck')) return toast('Pick both decks first.', true);
  const done = busy($('#start-sim'), 'Starting…');
  try {
    renderSim(await call('start_sim', pick('#you-deck'), pick('#bot-deck'), +$('#sim-games').value));
    $('#cancel-sim').hidden = false;
    pollSim();
  } catch { done(); return; }
  simDone = done;
};
let simDone = null;

$('#cancel-sim').onclick = () => call('cancel_sim');

function pollSim() {
  clearTimeout(simTimer);
  simTimer = setTimeout(async () => {
    const s = await call('sim_status');
    renderSim(s);
    if (s && !s.done) return pollSim();
    $('#cancel-sim').hidden = true;
    simDone && simDone();
  }, 1500);
}

function renderSim(s) {
  if (!s) return;
  const [a, b] = s.labels, played = s.played || 0;
  const pct = (n) => played ? Math.round((n / played) * 100) : 0;
  const seg = (cls, n, label) => n ? `<div class="${cls}" style="width:${pct(n)}%">${esc(label)} ${pct(n)}%</div>` : '';
  $('#sim-out').innerHTML = `
    <div class="muted">${s.done ? 'Finished' : 'Running'}: ${played}/${s.games} games · ${s.elapsed}s elapsed</div>
    <div class="bar"><div style="width:${(played / s.games) * 100}%"></div></div>
    ${s.error ? `<pre class="tail bad">${esc(s.error)}</pre>` : ''}
    ${played ? `<div class="split">${seg('a', s.wins[a], a)}${seg('b', s.wins[b], b)}${seg('d', s.draws, 'Draw')}</div>
    <table><tr><th>Deck</th><th>Wins</th><th>Win rate</th></tr>
      <tr><td>${esc(a)}</td><td>${s.wins[a]}</td><td>${pct(s.wins[a])}%</td></tr>
      <tr><td>${esc(b)}</td><td>${s.wins[b]}</td><td>${pct(s.wins[b])}%</td></tr>
      <tr><td>Draws / timeouts</td><td>${s.draws}</td><td>${pct(s.draws)}%</td></tr></table>
    <p class="muted">Avg game: ${s.avg_seconds ?? '–'}s${s.avg_turns ? ` · ${s.avg_turns} rounds (turns per player)` : ''}</p>
    ${Object.keys(s.reasons).length ? `<p class="muted">How games ended: ${Object.entries(s.reasons).map(([r, n]) => `${esc(r)} (${n})`).join(' · ')}</p>` : ''}` : ''}
    <details><summary class="muted">Forge output</summary><pre class="tail">${esc(s.tail.join('\n'))}</pre></details>`;
}

// ---- settings ----
async function loadSettings() {
  const s = await call('settings');
  $('#forge-dir').value = s.forge_dir || '';
  $('#install-forge').hidden = s.forge_ok;
  $('#forge-status').innerHTML = `
    <p>Forge: ${s.forge_ok ? `<span class="ok">found</span> <span class="muted">(decks export to ${esc(s.deck_dir)})</span>` : '<span class="bad">not set up</span>'}</p>
    <p>Java: ${s.java ? `<span class="ok">${esc(s.java)}</span>` : '<span class="bad">not found (install Java 17+)</span>'}</p>`;
  $('#llm-backend').value = s.llm_backend || '';
  $('#llm-model').innerHTML = Object.entries(s.llm_models).map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('');
  $('#llm-model').value = s.llm_model;
  $('#llm-key').value = '';
  $('#llm-key').placeholder = s.llm_has_key ? 'API key saved (type a new one to replace it)' : 'API key (sk-ant-…); blank uses ANTHROPIC_API_KEY';
  showLlm(s);
}
function showLlm(s) {
  const backend = $('#llm-backend').value;
  $('#llm-model').hidden = !backend;
  $('#llm-key').hidden = backend !== 'api';
  $('#llm-status').innerHTML = backend === 'claude-code'
    ? (s.claude_cli ? `Uses <code>${esc(s.claude_cli)}</code>. If the bot never shows a plan, open a terminal and run <code>claude</code> once to log in.`
                    : '<span class="bad">Claude Code CLI not found.</span> Install Claude Code or the Claude desktop app.')
    : backend === 'api' ? (s.anthropic_sdk ? 'Billed per token to your key at platform.claude.com.' : '<span class="bad">Run setup.bat again to install the anthropic package.</span>')
    : '';
}
$('#llm-backend').onchange = async () => showLlm(await call('settings'));
$('#set-llm').onclick = async () => {
  await call('set_llm', $('#llm-backend').value, $('#llm-model').value, $('#llm-key').value.trim());
  loadSettings();
  toast('Advanced bot saved. Applies to the next game');
};
$('#set-forge').onclick = async () => { await call('set_forge_dir', $('#forge-dir').value.trim()); loadSettings(); toast('Forge folder saved'); };
$('#browse-forge').onclick = async () => { await call('browse_forge_dir'); loadSettings(); };

$('#install-forge').onclick = async () => {
  const done = busy($('#install-forge'), 'Installing…');
  const show = (s) => $('#install-out').innerHTML = `<div class="muted">${esc(s.stage)}</div>
    <div class="bar"><div style="width:${s.progress * 100}%"></div></div>${s.error ? `<p class="bad">${esc(s.error)}</p>` : ''}`;
  try {
    let s = await call('install_forge');
    while (!s.done) { show(s); await new Promise((r) => setTimeout(r, 1000)); s = await call('install_status'); }
    show(s);
    if (s.ok) { toast('Forge installed'); loadSettings(); }
  } finally { done(); }
};

window.addEventListener('pywebviewready', async () => {
  api = window.pywebview.api;
  await refreshDecks();
  const s = await call('settings');
  if (s.username) showUser(s.username); else askName(true);
  if (!s.forge_ok) toast('Forge is not set up yet. See the Settings tab.');
});
