// safe-area-audit.mjs — Detect content OCCLUDED by the OS safe-area (notch / status
// bar / home indicator). This is the safe-area bug a pixel diff CANNOT catch:
//   - visual diff sees that insets *change* the layout (home shifts down) — expected.
//   - but it can't tell that a tap target now sits UNDER the home indicator, hidden.
//
// So we audit the DOM: with the profile's real insets applied (the bridge mock sets
// --safe-area-inset-* vars), find interactive / text elements whose box lands inside
// an unsafe band. A well-built page pads its chrome by the inset so its content sits
// ABOVE the band; a buggy one doesn't, and its buttons fall into the band.

/** Runs IN the page. Returns occluded elements. @param {{top,right,bottom,left}} insets */
export function SAFE_AREA_AUDIT(insets) {
  window.scrollTo(0, 0);
  const vw = window.innerWidth, vh = window.innerHeight;
  const topInset = insets.top || 0, bottomInset = insets.bottom || 0;
  const importantSel = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[tabindex]:not([tabindex="-1"])';
  const out = [];
  const seen = new Set();
  const els = document.body ? document.body.querySelectorAll('*') : [];

  for (const el of els) {
    const interactive = el.matches(importantSel);
    const isTextLeaf = el.children.length === 0 && el.textContent.trim().length > 0;
    if (!interactive && !isTextLeaf) continue;
    // a text leaf inside an interactive ancestor is covered by that ancestor — skip dup
    if (isTextLeaf && !interactive && el.closest(importantSel)) continue;

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= vh) continue;

    const topOv = Math.min(r.bottom, topInset) - Math.max(r.top, 0);
    const botOv = Math.min(r.bottom, vh) - Math.max(r.top, vh - bottomInset);
    let band = null, overlap = 0;
    if (topInset && topOv > 2) { band = 'top'; overlap = topOv; }
    else if (bottomInset && botOv > 2) { band = 'bottom'; overlap = botOv; }
    if (!band) continue;

    // Signal vs noise: an INTERACTIVE control under either band is an unambiguous bug
    // (untappable / hidden). Plain TEXT is only flagged under the BOTTOM home-indicator
    // band — top-of-page text commonly (and acceptably) scrolls under a translucent
    // status bar, so flagging it there would be noise.
    if (!interactive && band === 'top') continue;

    const text = el.textContent.trim().slice(0, 40) || el.getAttribute('aria-label') || '';
    const key = `${band}|${Math.round(r.top)}|${el.tagName}|${text.slice(0, 16)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      band, overlapPx: Math.round(overlap), interactive,
      tag: el.tagName.toLowerCase(), text,
      rect: { x: Math.round(r.x), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return out;
}

/** Verdict for a route's occlusions: interactive-in-band = FAIL (untappable/hidden), text-only = WARN. */
export function classifyOcclusions(occlusions) {
  if (!occlusions || !occlusions.length) return { level: 'pass', occlusions: [], reasons: [] };
  const interactive = occlusions.filter((o) => o.interactive);
  const level = interactive.length ? 'fail' : 'warn';
  const reasons = occlusions.slice(0, 6).map((o) =>
    `${o.interactive ? '⌖' : '·'} <${o.tag}> "${o.text || ''}" ${o.overlapPx}px under ${band(o.band)}`);
  return { level, occlusions, reasons, interactiveCount: interactive.length };
}

function band(b) { return b === 'top' ? 'status bar / notch (top)' : b === 'bottom' ? 'home indicator (bottom)' : b; }
