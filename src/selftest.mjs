#!/usr/bin/env node
// selftest.mjs — Prove the *detector* is trustworthy, with NO browser involved.
//
// A visual-regression tool is only as good as its precision/recall. So we render
// synthetic UI scenes we fully control, inject KNOWN design changes (true
// positives) and KNOWN-identical-but-noisy renders (true negatives), then measure:
//   recall    = 1.0  -> every injected change is caught (no blind spots)
//   flakeRate = 0.0  -> no identical-pair is ever flagged (no false alarms)
//   stability       -> the same scene diffed against itself N times is always PASS
//
// Run: node src/selftest.mjs   (exit 0 = trustworthy, exit 1 = regression in the detector)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffImages } from './engine/diff.mjs';
import { classify, confusion, pct, DEFAULT_THRESHOLDS } from './engine/metrics.mjs';
import { encodePng } from './engine/png.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dir, '..', '.out', 'selftest');
fs.mkdirSync(OUT, { recursive: true });

// ---- deterministic PRNG so the self-test never flakes on its own randomness ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- tiny immediate-mode canvas over an RGBA buffer ----
function canvas(w, h, bg = [247, 248, 250]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = bg[0]; data[i + 1] = bg[1]; data[i + 2] = bg[2]; data[i + 3] = 255; }
  return { width: w, height: h, data };
}
function blendPx(c, x, y, [r, g, b], a = 1) {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const o = (y * c.width + x) * 4;
  c.data[o] = r * a + c.data[o] * (1 - a);
  c.data[o + 1] = g * a + c.data[o + 1] * (1 - a);
  c.data[o + 2] = b * a + c.data[o + 2] * (1 - a);
}
function rect(c, x, y, w, h, col, a = 1) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) blendPx(c, xx, yy, col, a);
}
// horizontal "text" lines made of stippled glyph-like runs (so AA detection has edges to chew on)
function textBlock(c, x, y, w, lines, col = [40, 44, 52], lh = 16, glyph = 9) {
  for (let li = 0; li < lines; li++) {
    const yy = y + li * lh;
    let xx = x;
    while (xx < x + w - 6) {
      const wlen = 4 + ((xx * 7 + li * 13) % 7); // pseudo word length
      rect(c, xx, yy, wlen, glyph, col);
      xx += wlen + 4;
    }
  }
}
// add seeded luminance noise of magnitude +-n to EVERY pixel: models benign engine jitter
function addNoise(c, seed, n = 3) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < c.data.length; i += 4) {
    const d = Math.round((rnd() * 2 - 1) * n);
    c.data[i] = clamp(c.data[i] + d); c.data[i + 1] = clamp(c.data[i + 1] + d); c.data[i + 2] = clamp(c.data[i + 2] + d);
  }
  return c;
}
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// ---- the base scene: a believable mobile screen (header, hero card, list, CTA) ----
function scene(opts = {}) {
  const W = 390, H = 760; // iPhone-ish logical px
  const c = canvas(W, H);
  // status/header bar
  rect(c, 0, 0, W, 56, opts.headerColor || [255, 255, 255]);
  rect(c, 16, 20, 120, 16, [30, 33, 40]);              // title
  rect(c, W - 40, 18, 24, 24, [99, 102, 241]);          // avatar
  // hero card
  const heroY = 72 + (opts.heroShift || 0);
  rect(c, 16, heroY, W - 32, 150, [255, 255, 255]);
  rect(c, 16, heroY, W - 32, 150, [226, 232, 240], 0);  // (border noop placeholder)
  rect(c, 32, heroY + 16, W - 64, 90, opts.heroImg || [203, 213, 225]); // image
  textBlock(c, 32, heroY + 116, W - 64, 2);
  // badge (optional — removing it is an injected "missing element" case)
  if (!opts.removeBadge) rect(c, W - 90, heroY + 14, 56, 22, opts.badgeColor || [16, 185, 129]);
  // list of rows
  let ry = heroY + 170;
  for (let i = 0; i < 4; i++) {
    rect(c, 16, ry, W - 32, 64, [255, 255, 255]);
    rect(c, 28, ry + 12, 40, 40, [148, 163, 184]);      // thumb
    textBlock(c, 80, ry + 14, W - 110, 2, [55, 65, 81]);
    ry += 76;
  }
  // small 14×14 status dot in the header — used to test concentrated-cluster
  // detection: recoloring it is a real change too small for the global-ratio gate.
  rect(c, 168, 28, 14, 14, opts.dotColor || [148, 163, 184]);
  // sticky CTA button (color drift / padding drift injected here)
  const btnX = 16 + (opts.btnPad || 0);
  rect(c, btnX, H - 72, W - 32 - (opts.btnPad || 0) * 2, 48, opts.btnColor || [99, 102, 241]);
  return c;
}

// ---- test matrix ----
const PASS_OF = (v) => v.level === 'pass';
const cases = [];

// True negatives: identical scene rendered twice with independent benign noise.
for (let i = 0; i < 12; i++) {
  cases.push({ name: `identical#${i}`, actuallyDifferent: false, a: addNoise(scene(), 100 + i), b: addNoise(scene(), 900 + i) });
}
// True negatives: a sub-pixel-ish AA stress (heavier noise, still no design change).
for (let i = 0; i < 4; i++) {
  cases.push({ name: `aa-noise#${i}`, actuallyDifferent: false, a: addNoise(scene(), 50 + i, 4), b: addNoise(scene(), 70 + i, 4) });
}
// True positives: injected design drifts.
cases.push({ name: 'button-color-drift', actuallyDifferent: true, a: scene(), b: scene({ btnColor: [239, 68, 68] }) });
cases.push({ name: 'badge-color-drift', actuallyDifferent: true, a: scene(), b: scene({ badgeColor: [234, 179, 8] }) });
cases.push({ name: 'hero-shift-8px', actuallyDifferent: true, a: scene(), b: scene({ heroShift: 8 }) });
cases.push({ name: 'button-padding-12px', actuallyDifferent: true, a: scene(), b: scene({ btnPad: 12 }) });
cases.push({ name: 'missing-badge', actuallyDifferent: true, a: scene(), b: scene({ removeBadge: true }) });
cases.push({ name: 'header-bg-tint', actuallyDifferent: true, a: scene(), b: scene({ headerColor: [243, 244, 246] }) });
// concentrated small change: 14×14 dot recolor — below the global-ratio gate,
// must be caught by cluster-density escalation (proves cluster adds recall).
cases.push({ name: 'tiny-dot-recolor', actuallyDifferent: true, a: scene(), b: scene({ dotColor: [239, 68, 68] }) });
cases.push({ name: 'hero-image-tint', actuallyDifferent: true, a: scene(), b: scene({ heroImg: [186, 230, 253] }) });
// True positive: size mismatch (candidate 24px taller — a reflow).
{
  const a = scene();
  const b = canvas(390, 784); scene2Into(b);
  cases.push({ name: 'size-mismatch-+24h', actuallyDifferent: true, a, b });
}
function scene2Into(target) {
  const s = scene();
  s.data.copy(target.data, 0, 0, Math.min(s.data.length, target.data.length));
}

// Regression sensitivity: same-engine captures are pixel-deterministic, so we can
// run a tight per-pixel threshold and still never flake. Math check that makes this
// safe: our benign noise is +-4/channel/image -> max luminance delta between a pair
// is 8 -> YIQ delta 0.5053*8^2 = 32.3, which is below maxDelta(0.035)=35215*0.035^2
// = 43.1. So noise can never trip a pixel, while a 12-level surface tint (delta ~62)
// always does. (cross-engine mode uses a looser threshold; see config.)
const REGRESSION_THRESHOLD = 0.035;

// ---- run ----
const rows = [];
const records = [];
for (const tc of cases) {
  const res = diffImages(tc.a, tc.b, { threshold: REGRESSION_THRESHOLD });
  const verdict = classify(res);
  const predictedDifferent = !PASS_OF(verdict);
  rows.push({ predictedDifferent, actuallyDifferent: tc.actuallyDifferent });
  records.push({ name: tc.name, expected: tc.actuallyDifferent ? 'different' : 'identical', verdict: verdict.level, reasons: verdict.reasons, diffRatio: res.diffRatio, diffPixels: res.diffPixels, sizeMismatch: res.sizeMismatch, largestCluster: res.largestCluster });
  // save diff PNGs for the worst few (visual evidence)
  if (predictedDifferent) fs.writeFileSync(path.join(OUT, `${tc.name}.diff.png`), encodePng(res.width, res.height, res.data));
}

// ---- stability: same scene vs itself, 20x, must always be PASS (idempotence) ----
let stabilityFails = 0;
const baseA = scene();
for (let i = 0; i < 20; i++) {
  const b = addNoise(scene(), 5000 + i, 2);
  const v = classify(diffImages(baseA, b, { threshold: REGRESSION_THRESHOLD }));
  if (!PASS_OF(v)) stabilityFails++;
}

const cm = confusion(rows);
fs.writeFileSync(path.join(OUT, 'selftest.json'), JSON.stringify({ confusion: cm, records, stabilityFails }, null, 2));

// ---- assertions ----
const tiny = records.find((r) => r.name === 'tiny-dot-recolor');
const tinyByRatioWouldPass = tiny && tiny.diffRatio < DEFAULT_THRESHOLDS.pass;       // global ratio alone = PASS
const tinyCaughtByCluster = tiny && tiny.verdict !== 'pass' && tiny.reasons.some((s) => s.includes('cluster'));

const checks = [
  ['recall == 1.0 (no missed design changes)', cm.recall === 1],
  ['flakeRate == 0.0 (no false alarms on identical renders)', cm.flakeRate === 0],
  ['precision == 1.0 (no spurious detections)', cm.precision === 1],
  ['stability: 20/20 identical-with-noise are PASS', stabilityFails === 0],
  ['cluster: tiny recolor is below the global-ratio gate', !!tinyByRatioWouldPass],
  ['cluster: ...yet caught via concentrated-cluster escalation', !!tinyCaughtByCluster],
];

console.log('\n  webview-diff — engine self-test');
console.log('  ' + '─'.repeat(54));
for (const r of records) {
  const ok = (r.expected === 'different') === (r.verdict !== 'pass');
  console.log(`  ${ok ? '✓' : '✗'} ${r.name.padEnd(22)} ${r.verdict.toUpperCase().padEnd(5)} diff=${pct(r.diffRatio).padStart(9)} ${r.expected}`);
}
console.log('  ' + '─'.repeat(54));
console.log(`  precision=${cm.precision.toFixed(3)} recall=${cm.recall.toFixed(3)} f1=${cm.f1.toFixed(3)} flake=${cm.flakeRate.toFixed(3)} miss=${cm.missRate.toFixed(3)}`);
console.log(`  confusion: tp=${cm.tp} fp=${cm.fp} tn=${cm.tn} fn=${cm.fn}  stabilityFails=${stabilityFails}`);
console.log('  ' + '─'.repeat(54));
let allOk = true;
for (const [label, ok] of checks) { console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${label}`); if (!ok) allOk = false; }
console.log('');
console.log(`  artifacts: ${path.relative(process.cwd(), OUT)}/  (selftest.json + diff PNGs)\n`);
process.exit(allOk ? 0 : 1);
