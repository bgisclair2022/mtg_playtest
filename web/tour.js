// Guided tours: a spotlight on a real part of the UI with a short explanation beside it.
import { html, useState, useEffect, useLayoutEffect } from './vendor/preact-htm.js';

/**
 * steps: [{ sel?, title, text, before?() }]. `sel` is a CSS selector to spotlight (none = centred card);
 * `before` runs first (e.g. switch to the page the step talks about).
 */
export function Tour({ steps, onDone }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const step = steps[i];

  useLayoutEffect(() => {
    let alive = true;
    step.before?.();
    let scrolled = false;
    const find = () => {
      if (!alive) return;
      const el = step.sel && document.querySelector(step.sel);
      if (el && !scrolled) { el.scrollIntoView({ block: 'nearest' }); scrolled = true; }
      const r = el && el.getBoundingClientRect();
      setRect((old) => (!r ? null : old && ['left', 'top', 'width', 'height'].every((k) => Math.abs(old[k] - r[k]) < 1) ? old : r));
    };
    const t1 = setTimeout(find, step.before ? 260 : 0);
    const iv = setInterval(find, 250); // keep up with pages switching, images loading and animations settling
    return () => { alive = false; clearTimeout(t1); clearInterval(iv); };
  }, [i]);

  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') onDone();
      if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  });
  const next = () => (i + 1 < steps.length ? setI(i + 1) : onDone());

  const pad = 8;
  const spot = rect && { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
  // put the card below the spotlight if there's room, else above, else beside; centred when there's no target
  const card = { width: 340 };
  if (!spot) Object.assign(card, { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' });
  else {
    const below = spot.top + spot.height + 12, h = 190;
    card.left = Math.min(Math.max(12, spot.left), innerWidth - 352);
    if (below + h < innerHeight) card.top = below;
    else if (spot.top - h - 12 > 0) card.top = spot.top - h - 12;
    else { card.top = Math.max(12, Math.min(spot.top, innerHeight - h - 12)); card.left = spot.left > 380 ? spot.left - 352 : Math.min(spot.left + spot.width + 12, innerWidth - 352); }
  }
  return html`<div class="tour">
    ${spot ? html`<div class="tour-spot" style=${spot}></div>` : html`<div class="tour-dim"></div>`}
    <div class="tour-card" style=${card} key=${i}>
      <div class="tour-step">${i + 1} / ${steps.length}</div>
      <h3>${step.title}</h3>
      <p>${step.text}</p>
      <div class="tour-btns">
        <button class="link" onClick=${onDone}>${i + 1 < steps.length ? 'Skip tour' : ''}</button>
        ${i > 0 && html`<button onClick=${() => setI(i - 1)}>Back</button>`}
        <button class="primary" onClick=${next}>${i + 1 < steps.length ? 'Next' : 'Done'}</button>
      </div>
    </div>
  </div>`;
}
