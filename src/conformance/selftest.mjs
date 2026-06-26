#!/usr/bin/env node
// selftest.mjs — Prove the conformance gate + convergence loop, with NO browser.
//
// Asserts the four properties the design depends on:
//   (a) catch      — known design deltas produce findings
//   (b) no-FP      — within-tolerance deviations produce NO findings
//   (c) converge   — a good fixer drives severity to 0 and the loop terminates
//   (d) anti-thrash— a non-improving (overcorrecting) edit is rejected by the
//                    strict-decrease guard; severity never degrades
//
// Run: node src/conformance/selftest.mjs   (exit 0 = gate logic trustworthy)

import { compareSpec, parseColor } from './compare.mjs';
import { runConformanceLoop } from './loop.mjs';

// ---- synthetic "design" (what we'd derive from Figma node tokens + mapping) ----
const spec = {
  components: [
    { key: 'cta', selector: '.cta', expect: { backgroundColor: '#4f46e5', color: '#ffffff', fontSize: 16, fontWeight: 600, paddingTop: 14, paddingBottom: 14, borderRadius: 12, height: 48 } },
    { key: 'card', selector: '.card', expect: { backgroundColor: '#ffffff', paddingTop: 16, paddingLeft: 16, borderRadius: 16, gap: 12 } },
    { key: 'badge', selector: '.badge', expect: { backgroundColor: '#10b981', borderRadius: 999, fontSize: 11 } },
  ],
};

// measured DOM values (getComputedStyle form: rgb() + px strings)
const buggy = () => ({
  cta: { backgroundColor: 'rgb(99,102,241)' /* #6366f1, wrong shade */, color: 'rgb(255,255,255)', fontSize: '16px', fontWeight: '600', paddingTop: '12px' /* want 14 */, paddingBottom: '14px', borderRadius: '8px' /* want 12 */, height: '48px' },
  card: { backgroundColor: 'rgb(255,255,255)', paddingTop: '16px', paddingLeft: '16px', borderRadius: '16px', gap: '12px' }, // correct
  badge: { backgroundColor: 'rgb(234,179,8)' /* wrong */, borderRadius: '999px', fontSize: '11px' },
});
const within = () => ({
  cta: { backgroundColor: 'rgb(79,70,229)' /* #4f46e5 exact */, color: 'rgb(255,255,255)', fontSize: '16px', fontWeight: '600', paddingTop: '14.4px' /* <1.5 off */, paddingBottom: '13.7px', borderRadius: '12px', height: '48px' },
  card: { backgroundColor: 'rgb(255,255,255)', paddingTop: '16px', paddingLeft: '16px', borderRadius: '16.5px', gap: '12px' },
  badge: { backgroundColor: 'rgb(16,185,129)', borderRadius: '999px', fontSize: '11px' },
});

// ---- helpers to apply a finding's expected value back into measured state ----
function fmt(finding) {
  if (finding.type === 'color') { const c = parseColor(finding.expected); return `rgb(${c.r},${c.g},${c.b})`; }
  if (finding.type === 'px') return `${finding.expected}px`;
  return String(finding.expected);
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const sevOf = (state) => compareSpec(spec, state).severity;

// ---- (a) catch ----
const fBuggy = compareSpec(spec, buggy());
const caught = new Set(fBuggy.findings.map((f) => `${f.component}.${f.property}`));
const catchOk = caught.has('cta.backgroundColor') && caught.has('cta.paddingTop') && caught.has('cta.borderRadius') && caught.has('badge.backgroundColor') && !caught.has('card.paddingTop');

// ---- (b) no false positives within tolerance ----
const fWithin = compareSpec(spec, within());
const noFpOk = fWithin.count === 0;

// ---- (c) convergence with a good fixer (applies every finding) ----
let stateC = buggy();
const convC = await runConformanceLoop({
  check: () => compareSpec(spec, stateC),
  fix: (findings) => { for (const f of findings) stateC[f.component][f.property] = fmt(f); },
  snapshot: () => clone(stateC),
  applyState: (s) => { stateC = clone(s); },
});
const convergeOk = convC.converged && convC.severity === 0;

// ---- (c2) monotonic convergence (fix one finding per round) ----
let stateM = buggy();
const initialCount = compareSpec(spec, stateM).count;
const convM = await runConformanceLoop({
  check: () => compareSpec(spec, stateM),
  fix: (findings) => { const top = [...findings].sort((a, b) => b.severity - a.severity)[0]; if (top) stateM[top.component][top.property] = fmt(top); },
  snapshot: () => clone(stateM), applyState: (s) => { stateM = clone(s); }, maxRounds: 20,
});
const monotonicOk = convM.converged && convM.accepted === initialCount && convM.rejected === 0;

// ---- (d) anti-thrash: an overcorrecting fixer (fixes one, breaks a bigger one) is rejected ----
let stateB = buggy();
const initialSevB = sevOf(stateB);
const convB = await runConformanceLoop({
  check: () => compareSpec(spec, stateB),
  fix: (findings) => {
    const top = [...findings].sort((a, b) => b.severity - a.severity)[0];
    if (top) stateB[top.component][top.property] = fmt(top);   // fixes one (small win)
    stateB.card.paddingLeft = '64px';                          // ...but breaks a correct one bigger (net worse)
  },
  snapshot: () => clone(stateB), applyState: (s) => { stateB = clone(s); }, maxRounds: 6,
});
const finalSevB = sevOf(stateB);
const antiThrashOk = !convB.converged && convB.accepted === 0 && convB.rounds === 6
  && Math.abs(finalSevB - initialSevB) < 1e-9;  // best-so-far preserved, never degraded

// ---- report ----
const checks = [
  ['(a) catch: known design deltas are flagged (color/px), correct props are not', catchOk],
  ['(b) no false positives: within-tolerance deviations produce 0 findings', noFpOk],
  ['(c) convergence: good fixer reaches severity 0 and terminates', convergeOk],
  ['(c2) monotonic: one-fix-per-round converges, every round accepted', monotonicOk],
  ['(d) anti-thrash: overcorrecting edit rejected, severity never degrades', antiThrashOk],
];

const C = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, gray: (s) => `\x1b[90m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };
console.log(C.b('\n  webview-diff — conformance gate self-test'));
console.log('  ' + '─'.repeat(58));
console.log(C.gray(`  buggy: ${fBuggy.count} findings (severity ${fBuggy.severity}) · within-tol: ${fWithin.count}`));
console.log(C.gray(`  good fixer: converged in ${convC.rounds} round(s) · monotonic: ${convM.rounds} rounds, ${convM.accepted} accepted`));
console.log(C.gray(`  anti-thrash: ${convB.rounds} rounds, ${convB.accepted} accepted, ${convB.rejected} rejected, severity ${initialSevB}→${finalSevB} (preserved)`));
console.log('  ' + '─'.repeat(58));
let ok = true;
for (const [label, pass] of checks) { console.log(`  ${pass ? C.g('✓ PASS') : C.r('✗ FAIL')}  ${label}`); if (!pass) ok = false; }
console.log('');
process.exit(ok ? 0 : 1);
