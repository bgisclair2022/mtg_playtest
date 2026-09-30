// Decks page: your library (search, sort, tags, duplicate, rename, delete) and a deck builder with a visual
// card view, the raw list, and an analysis of curve, roles, colours and bracket.
import { html, useState, useEffect, useMemo, useRef } from './vendor/preact-htm.js';
import { api, call, toast, artCrop, cardImages, commanderNames, hoverPreview, Modal, useFocus } from './core.js';

const TYPES = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Land'];
const SECTION = /^(commanders?|companions?|deck|main ?deck|mainboard|sideboard|maybeboard|considering|tokens?)\s*:?\s*(\(\d+\))?$/i;
const ROLE_TARGETS = { Ramp: 10, 'Card draw': 10, Removal: 8, 'Board wipes': 2 }; // common Commander guidelines
const COLORS = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const blank = () => ({ name: '', commander: '', companion: '', list: '', tags: [], source: '' });
const typeOf = (c) => TYPES.find((t) => c.type_line.includes(t)) || 'Other';

// ---- editing the list text in place, so nothing the user typed (sections, typos) gets lost ----
function parseLine(line) {
  const t = line.trim();
  if (!t || /^(\/\/|#)/.test(t) || SECTION.test(t)) return null;
  const m = /^(\d+)x?\s+(.+)$/.exec(t);
  const name = (m ? m[2] : t).replace(/\s\*[A-Za-z]+\*/g, '').replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+\S+)?\s*$/, '').trim();
  return { count: m ? +m[1] : 1, name };
}
const sameCard = (listName, card) => {
  const n = listName.toLowerCase();
  return [card.name, card.name.split(' // ')[0], card.forge_name].some((x) => x && x.toLowerCase() === n);
};
function changeCount(list, card, delta) {
  const lines = list.split('\n');
  const i = lines.findIndex((l) => { const p = parseLine(l); return p && (typeof card === 'string' ? p.name.toLowerCase() === card.toLowerCase() : sameCard(p.name, card)); });
  if (i < 0) return delta > 0 ? (list.trim() ? list.replace(/\s*$/, '\n') : '') + `${delta} ${typeof card === 'string' ? card : card.name}` : list;
  const p = parseLine(lines[i]);
  const n = p.count + delta;
  if (n <= 0) lines.splice(i, 1); else lines[i] = `${n} ${p.name}`;
  return lines.join('\n');
}

// ---- library sidebar ----
function Library({ decks, selected, onSelect, onNew, onImport, art }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('recent');
  const [tag, setTag] = useState(null);
  const tags = [...new Set(decks.flatMap((d) => d.tags || []))].sort();
  const match = (d) => (!tag || (d.tags || []).includes(tag))
    && (!q || `${d.name} ${d.commander} ${(d.tags || []).join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  const order = (a, b) => sort === 'name' ? a.name.localeCompare(b.name)
    : sort === 'commander' ? (a.commander || '').localeCompare(b.commander || '') : (b.modified || 0) - (a.modified || 0);
  const item = (d) => {
    const on = selected && selected.name === d.name && selected.preset === d.preset;
    const img = art[commanderNames(d)[0]];
    return html`<button key=${(d.preset ? 'p:' : 'm:') + d.name} class=${'lib-item' + (on ? ' on' : '')} onClick=${() => onSelect({ name: d.name, preset: d.preset })}
      title=${d.description || ''}>
      <span class="thumb" style=${img ? { backgroundImage: `url("${artCrop(img)}")` } : null}></span>
      <span class="meta"><b>${d.name}</b><small>${commanderNames(d).join(' + ') || 'no commander'}</small>
        ${(d.tags || []).length > 0 && html`<span class="mini-tags">${d.tags.map((t) => html`<i>${t}</i>`)}</span>`}</span>
      <span class=${'cnt' + (d.count === 100 ? '' : ' off')}>${d.count}</span>
    </button>`;
  };
  const mine = decks.filter((d) => !d.preset && match(d)).sort(order);
  const presets = decks.filter((d) => d.preset && match(d)).sort(order);
  return html`<aside class="library" data-tour="library">
    <div class="lib-actions" data-tour="deck-new">
      <button class="primary" onClick=${onNew}>+ New deck</button>
      <button onClick=${onImport}>Import from Moxfield</button>
    </div>
    <input class="lib-search" placeholder="Search decks, commanders, tags…" value=${q} onInput=${(e) => setQ(e.target.value)} />
    <div class="lib-sort">
      <select value=${sort} onChange=${(e) => setSort(e.target.value)}>
        <option value="recent">Recently edited</option><option value="name">Name</option><option value="commander">Commander</option>
      </select>
    </div>
    ${tags.length > 0 && html`<div class="tag-filter">${tags.map((t) => html`<button class=${'chip' + (tag === t ? ' on' : '')} onClick=${() => setTag(tag === t ? null : t)}>${t}</button>`)}</div>`}
    <h3>My decks <span class="muted">${mine.length}</span></h3>
    <div class="lib-list">${mine.length ? mine.map(item) : html`<p class="muted small">${q || tag ? 'No matches.' : 'No saved decks yet. Paste one with “New deck” or import from Moxfield.'}</p>`}</div>
    <h3>Jace's decks <span class="muted">${presets.length}</span></h3>
    <div class="lib-list">${presets.map(item)}</div>
  </aside>`;
}

// ---- card search (Scryfall autocomplete) ----
function AddCard({ onAdd }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [i, setI] = useState(0);
  const timer = useRef();
  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setHits([]); return; }
    timer.current = setTimeout(async () => { const r = await api.card_search(q); setHits(Array.isArray(r) ? r.slice(0, 8) : []); setI(0); }, 220);
  }, [q]);
  const add = (name) => { if (!name) return; onAdd(name); setQ(''); setHits([]); };
  return html`<div class="add-card" data-tour="add-card">
    <input placeholder="Add a card… (type a name, Enter to add)" value=${q} onInput=${(e) => setQ(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, hits.length - 1)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
        if (e.key === 'Enter') add(hits[i] || q.trim());
        if (e.key === 'Escape') setHits([]);
      }} />
    ${hits.length > 0 && html`<div class="ac">${hits.map((h, j) => html`<button class=${j === i ? 'on' : ''} onMouseDown=${(e) => { e.preventDefault(); add(h); }}>${h}</button>`)}</div>`}
  </div>`;
}

// ---- the visual deck: card art grouped by type ----
function CardsView({ res, editable, onCount, onCommander, onAdd }) {
  if (!res) return html`<div class="empty-state"><div class="spinner"></div><p class="muted">Looking cards up on Scryfall…</p></div>`;
  const groups = {};
  for (const c of res.cards) (groups[typeOf(c)] ||= []).push(c);
  const tile = (c, role) => html`<div class=${'tile' + (role ? ' ' + role : '')} data-img=${c.image || ''} key=${c.name}>
      ${c.image ? html`<img loading="lazy" src=${c.image} alt=${c.name} />` : html`<div class="tile-name">${c.name}</div>`}
      ${c.count > 1 && html`<span class="count">×${c.count}</span>`}
      ${role && html`<span class="role">${role === 'commander' ? 'Commander' : 'Companion'}</span>`}
      ${editable && !role && html`<div class="tile-tools">
        <button title="One more" onClick=${() => onCount(c, 1)}>+</button>
        <button title="One fewer" onClick=${() => onCount(c, -1)}>−</button>
        ${/Legendary/.test(c.type_line) && /Creature|Planeswalker/.test(c.type_line) && html`<button title="Make this the commander" onClick=${() => onCommander(c)}>★</button>`}
        <button title="Remove from the deck" onClick=${() => onCount(c, -c.count)}>✕</button>
      </div>`}
    </div>`;
  return html`<div class="cards-view" onMouseOver=${hoverPreview} onMouseLeave=${() => { document.getElementById('preview').hidden = true; }}>
    ${editable && html`<${AddCard} onAdd=${onAdd} />`}
    <${Problems} res=${res} />
    <div class="group"><h4>Commander${res.companions?.length ? ' & companion' : ''}</h4>
      <div class="grid">${res.commanders.map((c) => tile(c, 'commander'))}${(res.companions || []).map((c) => tile(c, 'companion'))}
        ${!res.commanders.length && html`<p class="muted">No commander yet. Hover a legendary creature below and press ★, or type one on the Text tab.</p>`}</div></div>
    ${[...TYPES, 'Other'].filter((t) => groups[t]).map((t) => html`<div class="group" key=${t}>
      <h4>${t} <span class="muted">${groups[t].reduce((a, c) => a + c.count, 0)}</span></h4>
      <div class="grid">${groups[t].sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name)).map((c) => tile(c))}</div></div>`)}
  </div>`;
}

function Problems({ res }) {
  return res.problems.length
    ? html`<ul class="problems">${res.problems.map((p) => html`<li>${p}</li>`)}</ul>`
    : html`<div class="good">✓ Legal Commander deck: 100 cards, singleton, within color identity.</div>`;
}

// ---- analysis ----
function Analysis({ res, deck, editable, onAdd }) {
  const [sugg, setSugg] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    let alive = true;
    setSugg(null);
    api.edhrec_suggestions(deck).then((r) => alive && setSugg(r && !r.error ? r : { error: r?.error || 'No suggestions.' }));
    return () => { alive = false; };
  }, [deck.commander, res?.commanders?.[0]?.name]);
  if (!res) return html`<div class="empty-state"><div class="spinner"></div></div>`;
  const s = res.stats, a = res.analysis, max = Math.max(1, ...s.curve);
  const typeMax = Math.max(1, ...Object.values(s.types));
  const pipTotal = Object.values(a.pips).reduce((x, y) => x + y, 0) || 1;
  const srcTotal = Object.values(a.sources).reduce((x, y) => x + y, 0) || 1;
  return html`<div class="analysis">
    <${Problems} res=${res} />
    <div class="stat-row">
      <div class="stat"><b>${s.total}</b><span>cards</span></div>
      <div class="stat"><b>${s.avg_cmc}</b><span>average mana value</span></div>
      <div class="stat"><b>${s.types.Land || 0}</b><span>lands</span></div>
      <div class="stat"><div class="pips">${s.identity.map((c) => html`<i class="pip" style=${{ background: `var(--${c})` }} title=${COLORS[c]}></i>`)}${!s.identity.length && html`<span class="muted">colorless</span>`}</div><span>color identity</span></div>
      <div class=${'stat bracket b' + a.bracket} title="An estimate from the Game Changers list, mass land destruction and extra turns. Two-card combos aren't detected.">
        <b>Bracket ${a.bracket}</b><span>${a.bracket_why}</span></div>
    </div>
    <div class="panels">
      <section class="panel-s"><h4>Mana curve</h4>
        <div class="curve">${s.curve.map((n, i) => html`<div style=${{ height: `${(n / max) * 100}%` }} data-n=${n || ''} data-label=${i === 7 ? '7+' : i}></div>`)}</div></section>
      <section class="panel-s"><h4>Card types</h4>
        ${Object.entries(s.types).sort((x, y) => y[1] - x[1]).map(([t, n]) => html`<div class="hbar"><span>${t}</span><i style=${{ width: `${(n / typeMax) * 100}%` }}></i><b>${n}</b></div>`)}</section>
      <section class="panel-s"><h4>What the deck does <span class="muted">(click to see the cards)</span></h4>
        ${Object.entries(a.roles).map(([r, cards]) => {
          const target = ROLE_TARGETS[r];
          const low = target && cards.length < target;
          return html`<div class=${'role-row' + (low ? ' low' : '')} onClick=${() => setOpen(open === r ? null : r)}>
            <span>${r}</span><i><em style=${{ width: `${Math.min(100, (cards.length / (target || Math.max(cards.length, 1))) * 100)}%` }}></em></i>
            <b>${cards.length}${target ? html`<small> / ${target}+</small>` : ''}</b></div>
            ${open === r && html`<div class="role-cards">${cards.join(' · ') || 'None'}</div>`}`;
        })}
        <p class="muted small">Counts come from rules text, so treat them as a rough guide.</p></section>
      <section class="panel-s"><h4>Colors: costs vs. land sources</h4>
        ${s.identity.length ? s.identity.map((c) => {
          const pip = Math.round((a.pips[c] / pipTotal) * 100), src = Math.round((a.sources[c] / srcTotal) * 100);
          return html`<div class="color-row"><i class="pip" style=${{ background: `var(--${c})` }}></i>
            <div class="bars"><div><em style=${{ width: `${pip}%`, background: `var(--${c})` }}></em><span>${pip}% of mana symbols</span></div>
            <div><em class="src" style=${{ width: `${src}%` }}></em><span>${a.sources[c]} lands make it (${src}%)</span></div></div>
            ${src + 10 < pip && html`<b class="bad" title="Fewer sources than this colour's share of costs">low</b>`}</div>`;
        }) : html`<p class="muted">Colorless deck.</p>`}</section>
      <section class="panel-s"><h4>Power level</h4>
        <p><b>Game Changers (${a.game_changers.length}/3 for Bracket 3):</b> ${a.game_changers.join(', ') || 'none'}</p>
        ${a.mld.length > 0 && html`<p><b>Mass land destruction:</b> ${a.mld.join(', ')}</p>`}
        ${a.extra_turns.length > 0 && html`<p><b>Extra turns:</b> ${a.extra_turns.join(', ')}</p>`}
        <p class="muted small">Brackets: 1–2 casual/core, 3 upgraded (up to 3 Game Changers), 4 optimized, 5 cEDH. Combos aren't detected.</p></section>
      <section class="panel-s wide"><h4>EDHREC: popular with ${res.commanders[0]?.name || 'this commander'}, not in this deck</h4>
        ${!sugg ? html`<p class="muted">Loading…</p>` : sugg.error ? html`<p class="muted">${sugg.error}</p>` : html`<ul class="sugg">${sugg.map((c) => html`<li>
          <span><b>${c.name}</b> <span class="muted">synergy ${c.synergy >= 0 ? '+' : ''}${Math.round(c.synergy * 100)}%${c.inclusion != null ? ` · in ${c.inclusion}% of decks` : ''}</span></span>
          ${editable && html`<button onClick=${() => onAdd(c.name)}>+ Add</button>`}</li>`)}</ul>`}</section>
    </div>
  </div>`;
}

// ---- the editor ----
function Editor({ ref0, decks, onSaved, onDeleted, onPlay, art, onDirty }) {
  const [draft, setDraft] = useState(null);
  const [orig, setOrig] = useState(null); // saved state, for "unsaved changes"
  const [res, setRes] = useState(null);
  const [tab, setTab] = useState('cards');
  const [tagInput, setTagInput] = useState('');
  const preset = !!ref0?.preset;
  const editable = !preset;

  useEffect(() => { // load the selected deck
    let alive = true;
    setRes(null);
    if (!ref0) { const d = blank(); setDraft(d); setOrig(JSON.stringify(d)); setTab('text'); return; }
    call('load_deck', ref0.name, ref0.preset).then((d) => {
      if (!alive) return;
      const full = { ...blank(), ...d, tags: d.tags || [] };
      setDraft(full); setOrig(JSON.stringify(full)); setTab('cards');
    });
    return () => { alive = false; };
  }, [ref0?.name, ref0?.preset]);

  useEffect(() => { // re-check with Scryfall shortly after every change
    if (!draft || !draft.list.trim()) { setRes(draft ? { cards: [], commanders: [], companions: [], problems: ['The deck is empty. Paste a list on the Text tab or add cards.'], stats: { total: 0, curve: [0, 0, 0, 0, 0, 0, 0, 0], types: {}, avg_cmc: 0, identity: [] }, analysis: { roles: {}, pips: {}, sources: {}, game_changers: [], mld: [], extra_turns: [], bracket: '?', bracket_why: '' } } : null); return; }
    const t = setTimeout(async () => { const r = await api.check_deck(draft); if (r && !r.error) setRes(r); }, res ? 450 : 0);
    return () => clearTimeout(t);
  }, [draft?.list, draft?.commander, draft?.companion]);

  const dirty = draft && orig !== JSON.stringify(draft);
  useEffect(() => onDirty(!!dirty), [dirty]);
  useEffect(() => { // Ctrl+S saves
    const key = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && editable) { e.preventDefault(); save(); } };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });
  if (!draft) return html`<div class="editor"><div class="empty-state"><div class="spinner"></div></div></div>`;

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const addCard = (name) => { set({ list: changeCount(draft.list, name, 1) }); toast(`Added ${name}`); };
  const count = (card, delta) => set({ list: changeCount(draft.list, card, delta) });
  const makeCommander = (card) => {
    let list = changeCount(draft.list, card, -card.count);
    for (const old of commanderNames(draft)) list = changeCount(list, old, 1);
    set({ list, commander: card.name });
  };
  async function save() {
    if (!draft.name.trim()) return toast('Give the deck a name first.', true);
    if (ref0 && !preset && ref0.name !== draft.name.trim()) await call('rename_deck', ref0.name, draft.name.trim());
    const list = await call('save_deck', { ...draft, name: draft.name.trim() });
    setOrig(JSON.stringify(draft));
    toast(`Saved "${draft.name.trim()}"`);
    onSaved(list, { name: draft.name.trim(), preset: false });
  }
  async function duplicate() {
    const r = await call('duplicate_deck', ref0.name, preset);
    toast(`Saved a copy: "${r.name}"`);
    onSaved(r.decks, { name: r.name, preset: false });
  }
  async function remove() {
    if (!confirm(`Delete "${ref0.name}"? This can't be undone.`)) return;
    onDeleted(await call('delete_deck', ref0.name));
  }
  function exportList() {
    const text = [commanderNames(draft).length ? 'Commander\n' + commanderNames(draft).map((n) => `1 ${n}`).join('\n') : '',
      draft.companion ? `Companion\n1 ${draft.companion}` : '',
      'Deck\n' + draft.list.split('\n').filter((l) => parseLine(l)).join('\n')].filter(Boolean).join('\n\n');
    navigator.clipboard.writeText(text).then(() => toast('Deck list copied (pastes into Moxfield, Arena or MTGO).'), () => toast('Couldn\'t reach the clipboard.', true));
  }
  const addTag = () => { const t = tagInput.trim(); if (t && !draft.tags.includes(t)) set({ tags: [...draft.tags, t] }); setTagInput(''); };
  const img = art[res?.commanders?.[0]?.name] || res?.commanders?.[0]?.image;

  return html`<div class="editor">
    <header class="deck-head" style=${img ? { '--art': `url("${artCrop(img)}")` } : null}>
      <div class="deck-head-main">
        ${preset ? html`<h2>${draft.name}</h2>` : html`<input class="deck-title" placeholder="Deck name" value=${draft.name} onInput=${(e) => set({ name: e.target.value })} />`}
        <div class="deck-sub">${commanderNames(draft).join(' + ') || res?.commanders?.map((c) => c.name).join(' + ') || 'No commander yet'}
          ${res?.analysis?.bracket && res.analysis.bracket !== '?' && html` · <span class=${'bracket-pill b' + res.analysis.bracket}>Bracket ${res.analysis.bracket}</span>`}
          ${res && html` · ${res.stats.total} cards`}
          ${draft.source && html` · <a href="#" onClick=${(e) => { e.preventDefault(); api.open_url(draft.source); }}>${/edhrec/i.test(draft.source) ? 'EDHREC' : /moxfield/i.test(draft.source) ? 'Moxfield' : 'Source'}</a>`}</div>
        ${preset ? html`<p class="deck-desc">${draft.description || ''} <span class="muted">Jace's preset: duplicate it to make your own version.</span></p>`
          : html`<div class="tags">${draft.tags.map((t) => html`<span class="chip">${t}<button onClick=${() => set({ tags: draft.tags.filter((x) => x !== t) })}>×</button></span>`)}
            <input class="tag-input" placeholder="+ tag" value=${tagInput} onInput=${(e) => setTagInput(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && addTag()} onBlur=${addTag} /></div>`}
      </div>
      <div class="deck-actions" data-tour="deck-actions">
        ${editable && html`<button class=${'primary' + (dirty ? ' pulse' : '')} disabled=${!dirty && !!ref0} onClick=${save}>${dirty ? 'Save changes' : 'Saved'}</button>`}
        ${ref0 && html`<button onClick=${() => onPlay(ref0, preset ? 'bot' : 'you')}>${preset ? 'Play against this' : 'Play this deck'}</button>`}
        ${ref0 && html`<button onClick=${duplicate}>${preset ? 'Duplicate to edit' : 'Duplicate'}</button>`}
        <button onClick=${exportList} disabled=${!draft.list.trim()}>Copy list</button>
        ${ref0 && editable && html`<button class="danger" onClick=${remove}>Delete</button>`}
      </div>
    </header>
    <nav class="subtabs" data-tour="deck-tabs">
      ${[['cards', 'Cards'], ['text', 'Text'], ['analysis', 'Analysis']].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}
    </nav>
    <div class="editor-body" key=${tab}>
      ${tab === 'cards' && html`<${CardsView} res=${res} editable=${editable} onCount=${count} onCommander=${makeCommander} onAdd=${addCard} />`}
      ${tab === 'text' && html`<div class="text-view">
        <div class="row">
          <label>Commander(s)<input value=${draft.commander} disabled=${!editable} placeholder="One per line, or separated by ;" onInput=${(e) => set({ commander: e.target.value })} /></label>
          <label>Companion<input value=${draft.companion} disabled=${!editable} placeholder="Optional, outside the 100" onInput=${(e) => set({ companion: e.target.value })} /></label>
        </div>
        <textarea spellcheck="false" readOnly=${!editable} value=${draft.list} onInput=${(e) => set({ list: e.target.value })}
          placeholder=${'Paste a decklist, e.g.\n1 Sol Ring\n1 Arcane Signet\n35 Forest\n\nMoxfield, Arena and MTGO exports all work. Mark the commander with a "Commander" section header or *CMDR*, or type it above.'}></textarea>
        ${res && html`<${Problems} res=${res} />`}
      </div>`}
      ${tab === 'analysis' && html`<${Analysis} res=${res} deck=${draft} editable=${editable} onAdd=${addCard} />`}
    </div>
  </div>`;
}

function MoxfieldImport({ onClose, onImported }) {
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState('');
  const focus = useFocus();
  useEffect(() => { call('settings').then((s) => setUser(s.moxfield_user || '')); }, []);
  const importDeck = async (idOrUrl) => {
    setBusy(idOrUrl);
    try { const d = await call('moxfield_import', idOrUrl); toast(`Imported "${d.name}"`); onImported(d.name); } finally { setBusy(''); }
  };
  return html`<${Modal} onClose=${onClose}>
    <h2>Import from Moxfield</h2>
    <p class="muted">Moxfield has no official API, so this reads <b>public</b> decks only. If it stops working, use Export → Copy on Moxfield and paste into a new deck.</p>
    <div class="row"><input ref=${focus} placeholder="Deck URL, e.g. https://moxfield.com/decks/…" value=${url} onInput=${(e) => setUrl(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && importDeck(url)} />
      <button class="primary" disabled=${!url || busy} onClick=${() => importDeck(url)}>${busy === url ? 'Importing…' : 'Import'}</button></div>
    <div class="row"><input placeholder="…or your Moxfield username" value=${user} onInput=${(e) => setUser(e.target.value)} />
      <button disabled=${!user || busy} onClick=${async () => { setBusy('list'); try { setList(await call('moxfield_decks', user)); } finally { setBusy(''); } }}>${busy === 'list' ? 'Loading…' : 'List my decks'}</button></div>
    ${list && html`<ul class="mox-list">${list.length ? list.map((d) => html`<li><span>${d.name}</span><button disabled=${!!busy} onClick=${() => importDeck(d.id)}>${busy === d.id ? 'Importing…' : 'Import'}</button></li>`)
      : html`<li class="muted">No public Commander decks found.</li>`}</ul>`}
  </${Modal}>`;
}

export function DecksView({ decks, setDecks, selected, setSelected, onPlay }) {
  const [art, setArt] = useState({});
  const [importing, setImporting] = useState(false);
  const dirty = useRef(false);
  useEffect(() => { cardImages(decks.flatMap((d) => commanderNames(d).slice(0, 1))).then(setArt); }, [decks]);
  const choose = (ref) => {
    if (dirty.current && !confirm('Discard your unsaved changes to this deck?')) return;
    dirty.current = false;
    setSelected(ref);
  };
  return html`<section class="view decks-view">
    <${Library} decks=${decks} selected=${selected} art=${art} onSelect=${choose} onNew=${() => choose(null)} onImport=${() => setImporting(true)} />
    <${Editor} key=${selected ? (selected.preset ? 'p:' : 'm:') + selected.name : 'new'} ref0=${selected} decks=${decks} art=${art}
      onDirty=${(d) => { dirty.current = d; }}
      onSaved=${(list, ref) => { setDecks(list); dirty.current = false; setSelected(ref); }}
      onDeleted=${(list) => { setDecks(list); dirty.current = false; setSelected(list.find((d) => !d.preset) ? { name: list.find((d) => !d.preset).name, preset: false } : null); }}
      onPlay=${onPlay} />
    ${importing && html`<${MoxfieldImport} onClose=${() => setImporting(false)}
      onImported=${async (name) => { setImporting(false); setDecks(await call('list_decks')); dirty.current = false; setSelected({ name, preset: false }); }} />`}
  </section>`;
}
