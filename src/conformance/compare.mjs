// compare.mjs — Structural design-conformance comparison (the HARD gate).
//
// Compares a design spec (Figma node tokens: color / typography / spacing / radius /
// size) against measured DOM values (getComputedStyle + getBoundingClientRect).
// Emits property-level findings an agent can act on directly. This is deterministic
// and actionable — the two properties a pixel-diff lacks for an agent loop.
//
// Why structural, not pixel: a screenshot baseline only catches code-to-code
// regressions and can't say whether the implementation matches the DESIGN. Reading
// the actual computed values and diffing them against the design tokens does.
// (See DESIGN-CONFORMANCE.md for the cited rationale.)
//
// Deliberately ignores text content, copy, dynamic data and images — those are the
// main source of false positives in design-vs-implementation comparison.

// ---- color: parse → CIELAB → ΔE76 (perceptual distance, not raw RGB) ----
export function parseColor(c) {
  if (c == null) return null;
  if (typeof c === 'object' && 'r' in c) {
    // Figma fill form {r,g,b,a} with channels 0..1
    const s = c.r <= 1 && c.g <= 1 && c.b <= 1 ? 255 : 1;
    return { r: Math.round(c.r * s), g: Math.round(c.g * s), b: Math.round(c.b * s), a: c.a ?? 1 };
  }
  const str = String(c).trim();
  let m = str.match(/^#([0-9a-f]{3})$/i);
  if (m) { const h = m[1]; return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 }; }
  m = str.match(/^#([0-9a-f]{6})$/i);
  if (m) { const h = m[1]; return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }; }
  m = str.match(/rgba?\(([^)]+)\)/i);
  if (m) { const p = m[1].split(/[,\s/]+/).map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; }
  // oklab/oklch — modern engines (Tailwind v4) emit these from getComputedStyle
  m = str.match(/^okl(ab|ch)\(([^)]+)\)/i);
  if (m) {
    const [main, alphaStr] = m[2].split('/');
    const p = main.trim().split(/\s+/);
    const L = p[0].endsWith('%') ? parseFloat(p[0]) / 100 : parseFloat(p[0]);
    const alpha = alphaStr != null ? parseFloat(alphaStr) : 1;
    let A, B;
    if (m[1].toLowerCase() === 'ab') { A = parseFloat(p[1]); B = parseFloat(p[2]); }
    else { const C = parseFloat(p[1]); const h = parseFloat(p[2]) * Math.PI / 180; A = C * Math.cos(h); B = C * Math.sin(h); }
    return { ...oklabToSrgb(L, A, B), a: alpha };
  }
  if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}

function oklabToSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  const to = (v) => Math.max(0, Math.min(255, Math.round(lin(v) * 255)));
  return {
    r: to(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: to(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: to(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  };
}

function srgbToLinear(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function rgbToLab({ r, g, b }) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}
export function deltaE(c1, c2) {
  const a = parseColor(c1), b = parseColor(c2);
  if (!a || !b) return a === b ? 0 : Infinity;
  // treat alpha difference as a perceptual penalty too
  const la = rgbToLab(a), lb = rgbToLab(b);
  const dE = Math.sqrt((la.L - lb.L) ** 2 + (la.a - lb.a) ** 2 + (la.b - lb.b) ** 2);
  return dE + Math.abs((a.a ?? 1) - (b.a ?? 1)) * 100;
}

// ---- property registry: how each design property is compared ----
const COLOR = 'color', PX = 'px', EXACT = 'exact';
const PROP_TYPE = {
  color: COLOR, backgroundColor: COLOR, borderColor: COLOR,
  fontSize: PX, lineHeight: PX, letterSpacing: PX,
  paddingTop: PX, paddingRight: PX, paddingBottom: PX, paddingLeft: PX,
  gap: PX, rowGap: PX, columnGap: PX, borderRadius: PX, borderWidth: PX,
  width: PX, height: PX,
  fontWeight: EXACT, fontFamily: EXACT, textAlign: EXACT, display: EXACT,
};

export const DEFAULT_TOLERANCES = {
  color: 2.0,   // ΔE76 — ~2 is "just noticeable"
  px: 1.5,      // sub-pixel rounding / responsive reflow headroom
  exact: 0,
};

/**
 * Compare a measured component against its design spec.
 * @returns {{findings:Array, severity:number, count:number}}
 */
export function compareComponent(key, expect, measured, tol = DEFAULT_TOLERANCES) {
  const findings = [];
  for (const [prop, want] of Object.entries(expect)) {
    const type = PROP_TYPE[prop];
    if (!type) continue; // unknown / non-structural property — ignore (content, etc.)
    const got = measured ? measured[prop] : undefined;
    if (got === undefined || got === null) {
      findings.push({ component: key, property: prop, type, expected: want, actual: null, delta: Infinity, tol: tol[type], severity: 1, reason: 'not measured' });
      continue;
    }
    // pill radius: when both are "fully rounded" the exact px is irrelevant (99 vs
    // 999 vs 9999 vs 50% all read as a pill) — treat as equal to avoid a false
    // positive. 48px+ is a pill for buttons/badges; real cards use 8-24px.
    if (prop === 'borderRadius' && parseFloat(want) >= 48 && parseFloat(got) >= 48) continue;
    let delta, over;
    if (type === COLOR) {
      delta = deltaE(want, got);
      over = delta - tol.color;
    } else if (type === PX) {
      const w = parseFloat(want), g = parseFloat(got);
      delta = Math.abs(w - g);
      over = delta - tol.px;
    } else { // EXACT
      delta = String(want) === String(got) ? 0 : 1;
      over = delta - tol.exact > 0 ? delta : -1;
    }
    if (over > 0) {
      // severity: how far past tolerance, normalized so colors/px/exact are comparable
      const norm = type === COLOR ? over / tol.color : type === PX ? over / Math.max(tol.px, 1) : 1;
      findings.push({ component: key, property: prop, type, expected: want, actual: got, delta: round(delta), tol: tol[type], severity: round(Math.min(norm, 8)) });
    }
  }
  return { findings, severity: sum(findings.map((f) => f.severity)), count: findings.length };
}

/** Compare a whole spec against a measurement map keyed by component key. */
export function compareSpec(spec, measurements, tol = DEFAULT_TOLERANCES) {
  const all = [];
  for (const c of spec.components) {
    const r = compareComponent(c.key, c.expect, measurements[c.key], tol);
    all.push(...r.findings);
  }
  return { findings: all, severity: round(sum(all.map((f) => f.severity))), count: all.length };
}

const round = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n);
const sum = (a) => a.reduce((s, x) => s + (Number.isFinite(x) ? x : 1), 0);
