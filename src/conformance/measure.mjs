// measure.mjs — Read the LIVE DOM as design-comparable numbers, and (optionally)
// pull the design spec from the Figma REST API.
//
// The browser is the measurement instrument: getComputedStyle gives the actual
// color/typography/spacing/radius, getBoundingClientRect gives actual size — exactly
// the values to diff against Figma node tokens. No screenshots involved.

import { chromium } from 'playwright';

// Runs IN the page. Returns design-comparable values per mapped selector.
function MEASURE(selectors) {
  const num = (v) => (v == null || v === 'normal' || v === 'auto' ? null : parseFloat(v));
  // normalize ANY CSS color (oklab/oklch/color()/named/hsl) to rgb(a) via the browser,
  // so the comparator only ever sees rgb/hex — modern engines (Tailwind v4) emit oklab.
  let _cx; const norm = (v) => { try { _cx ||= document.createElement('canvas').getContext('2d'); _cx.fillStyle = '#000'; _cx.fillStyle = v; return _cx.fillStyle; } catch { return v; } };
  const out = {};
  for (const [key, sel] of Object.entries(selectors)) {
    const el = document.querySelector(sel);
    if (!el) { out[key] = null; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const gap = cs.gap && cs.gap !== 'normal' ? cs.gap.split(' ')[0] : (cs.rowGap !== 'normal' ? cs.rowGap : null);
    out[key] = {
      color: norm(cs.color), backgroundColor: norm(cs.backgroundColor), borderColor: norm(cs.borderTopColor),
      fontSize: num(cs.fontSize), fontWeight: cs.fontWeight, lineHeight: num(cs.lineHeight), letterSpacing: num(cs.letterSpacing),
      paddingTop: num(cs.paddingTop), paddingRight: num(cs.paddingRight), paddingBottom: num(cs.paddingBottom), paddingLeft: num(cs.paddingLeft),
      gap: num(gap), borderRadius: num(cs.borderTopLeftRadius), borderWidth: num(cs.borderTopWidth),
      width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100,
      fontFamily: cs.fontFamily, textAlign: cs.textAlign, display: cs.display,
    };
  }
  return out;
}

/** Measure mapped components on a rendered page. selectors = {key: cssSelector}. */
export async function measurePage({ url, selectors, viewport = { width: 393, height: 852 }, deviceScaleFactor = 2, settleMs = 200, navTimeout = 30000 }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.evaluate(async () => { try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {} });
    await page.waitForTimeout(settleMs);
    return await page.evaluate(MEASURE, selectors);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---- Figma REST API → design spec (the source of truth for `expect`) ----
// Pulls the mapped nodes and reads their tokens. Needs a Figma access token.
// Demo runs from a local spec file instead; this is the production path.
const FIGMA_API = 'https://api.figma.com/v1';

export async function fetchFigmaSpec({ fileKey, token, mapping }) {
  // mapping: [{ key, selector, nodeId }] — author-maintained Figma-node ↔ DOM anchor
  if (!token) throw new Error('FIGMA_TOKEN required to fetch the design spec from Figma');
  const ids = mapping.map((m) => m.nodeId).join(',');
  const res = await fetch(`${FIGMA_API}/files/${fileKey}/nodes?ids=${encodeURIComponent(ids)}`, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const components = [];
  for (const m of mapping) {
    const node = data.nodes?.[m.nodeId]?.document;
    if (!node) continue;
    components.push({ key: m.key, selector: m.selector, expect: nodeToExpect(node) });
  }
  return { components };
}

// Map a Figma node's properties to the structural `expect` shape compare.mjs uses.
export function nodeToExpect(node) {
  const e = {};
  const solid = (fills) => (fills || []).find((f) => f.type === 'SOLID' && f.visible !== false);
  const bg = solid(node.fills); if (bg) e.backgroundColor = bg.color;
  if (node.style) {
    if (node.style.fontSize) e.fontSize = node.style.fontSize;
    if (node.style.fontWeight) e.fontWeight = node.style.fontWeight;
    if (node.style.lineHeightPx) e.lineHeight = Math.round(node.style.lineHeightPx);
    if (node.style.letterSpacing) e.letterSpacing = node.style.letterSpacing;
  }
  if (node.paddingTop != null) e.paddingTop = node.paddingTop;
  if (node.paddingRight != null) e.paddingRight = node.paddingRight;
  if (node.paddingBottom != null) e.paddingBottom = node.paddingBottom;
  if (node.paddingLeft != null) e.paddingLeft = node.paddingLeft;
  if (node.itemSpacing != null) e.gap = node.itemSpacing;
  if (node.cornerRadius != null) e.borderRadius = node.cornerRadius;
  if (node.absoluteBoundingBox) { e.width = Math.round(node.absoluteBoundingBox.width); e.height = Math.round(node.absoluteBoundingBox.height); }
  // text node fill is the foreground color
  if (node.type === 'TEXT' && bg) { delete e.backgroundColor; e.color = bg.color; }
  return e;
}
