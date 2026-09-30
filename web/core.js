// Shared plumbing for every page: the Python API, toasts, saved preferences and small helpers.
import { html, useEffect, useRef } from './vendor/preact-htm.js';

export let api = null;
// pywebview fills window.pywebview.api and then fires "pywebviewready" (it may already have fired).
export const ready = new Promise((resolve) => {
  const done = () => { api = window.pywebview.api; resolve(); };
  if (window.pywebview?.api?.settings) done(); else addEventListener('pywebviewready', done, { once: true });
});

/** Call a backend method; {error} results become a toast and a thrown Error. */
export async function call(method, ...args) {
  const res = await api[method](...args);
  if (res && res.error) { toast(res.error, true); throw new Error(res.error); }
  return res;
}

export function toast(msg, error = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (error ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), error ? 7000 : 3500);
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const artCrop = (url) => url && url.replace('/normal/', '/art_crop/');
export const commanderNames = (d) => (d?.commander || '').split(/[\n;]/).map((x) => x.trim()).filter(Boolean);

// Preferences live in data/settings.json (the window runs in private mode, so browser storage is wiped on exit).
export const prefs = {};
export async function loadPrefs() { Object.assign(prefs, (await call('settings')).prefs || {}); return prefs; }
export function setPref(key, value) { prefs[key] = value; api.set_pref(key, value); }

// Card images, fetched once per name through the Python side's Scryfall cache.
const images = {}, waiting = new Map();
export async function cardImages(names) {
  const want = [...new Set(names.filter(Boolean))].filter((n) => !(n in images));
  if (want.length) {
    const key = want.join('|');
    if (!waiting.has(key)) waiting.set(key, api.card_images(want).then((found) => { want.forEach((n) => { images[n] = found?.[n] || null; }); }));
    await waiting.get(key);
  }
  return Object.fromEntries(names.filter(Boolean).map((n) => [n, images[n]]));
}

/** Big card preview beside whatever is hovered (element with data-img). */
export function hoverPreview(e) {
  const card = e.target.closest?.('[data-img]');
  const p = document.getElementById('preview');
  if (!card || !card.dataset.img) { p.hidden = true; return; }
  const r = card.getBoundingClientRect();
  if (p.dataset.src !== card.dataset.img) { p.innerHTML = `<img src="${esc(card.dataset.img)}">`; p.dataset.src = card.dataset.img; }
  p.style.left = (r.right + 316 < innerWidth ? r.right + 12 : Math.max(8, r.left - 312)) + 'px';
  p.style.top = Math.max(8, Math.min(r.top, innerHeight - 430)) + 'px';
  p.hidden = false;
}

/** A dialog over the page. Esc or clicking outside closes it unless `locked`. */
export function Modal({ children, onClose, locked, wide }) {
  useEffect(() => {
    if (locked) return;
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [locked]);
  return html`<div class="modal" onClick=${(e) => { if (!locked && e.target === e.currentTarget) onClose(); }}>
    <div class=${'modal-box' + (wide ? ' wide' : '')}>${children}</div></div>`;
}

/** Autofocus that also works when a component re-mounts. */
export function useFocus() {
  const ref = useRef();
  useEffect(() => { setTimeout(() => ref.current?.focus(), 0); }, []);
  return ref;
}
