// metrics.mjs — Turn raw diff numbers into a verdict, and (for the self-test)
// score the detector itself against ground truth.
//
// Two thresholds give three states so CI can be strict without being brittle:
//   diffRatio <= pass  -> PASS  (treated as identical)
//   diffRatio <= warn  -> WARN  (review, but don't block)
//   diffRatio >  warn   -> FAIL  (block the merge)
// A size mismatch is always at least WARN (layout reflowed) and FAIL past a band.

export const DEFAULT_THRESHOLDS = {
  pass: 0.0008,  // <=0.08% of pixels may differ and still count as "same" (AA jitter headroom)
  warn: 0.005,   // 0.08%..0.5% -> warn
  // > warn -> fail
  sizeMismatchPixels: 0,   // any extra/missing pixels at least warns
  sizeMismatchFail: 4000,  // a large reflow band fails outright
  // concentrated-cluster escalation (defaults tuned for regression / deterministic capture):
  clusterDensity: 0.4,     // min fill ratio for a cluster to count as "concentrated"
  clusterWarnArea: 80,     // a dense cluster >= this many px -> at least WARN
  clusterFailArea: 150,    // a dense cluster >= this many px -> FAIL (even if global ratio is tiny)
};

const rank = (l) => (l === 'fail' ? 2 : l === 'warn' ? 1 : 0);

export function classify(result, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  let level = 'pass';
  const reasons = [];
  if (result.diffRatio > t.warn) { level = 'fail'; reasons.push(`diffRatio ${pct(result.diffRatio)} > ${pct(t.warn)}`); }
  else if (result.diffRatio > t.pass) { level = 'warn'; reasons.push(`diffRatio ${pct(result.diffRatio)} > ${pct(t.pass)}`); }
  if (result.sizeMismatch) {
    const extra = Math.abs(result.dims.a.w * result.dims.a.h - result.dims.b.w * result.dims.b.h);
    if (extra > t.sizeMismatchFail) { level = 'fail'; reasons.push(`size mismatch ${result.dims.a.w}x${result.dims.a.h} vs ${result.dims.b.w}x${result.dims.b.h}`); }
    else if (level === 'pass') { level = 'warn'; reasons.push(`minor size mismatch ${result.dims.a.w}x${result.dims.a.h} vs ${result.dims.b.w}x${result.dims.b.h}`); }
  }
  // concentrated cluster: a dense localized change matters even at a tiny global ratio.
  const lc = result.largestCluster;
  if (lc && lc.density >= t.clusterDensity) {
    if (lc.area >= t.clusterFailArea && rank(level) < 2) {
      level = 'fail'; reasons.push(`dense diff cluster ${lc.w}×${lc.h} (${lc.area}px, ${Math.round(lc.density * 100)}% fill) @(${lc.x},${lc.y})`);
    } else if (lc.area >= t.clusterWarnArea && level === 'pass') {
      level = 'warn'; reasons.push(`localized diff cluster ${lc.w}×${lc.h} (${lc.area}px) @(${lc.x},${lc.y})`);
    }
  }
  return { level, reasons };
}

const pct = (r) => `${(r * 100).toFixed(3)}%`;
export { pct };

export function summarize(comparisons) {
  const s = { total: comparisons.length, pass: 0, warn: 0, fail: 0 };
  for (const c of comparisons) s[c.verdict.level]++;
  s.worst = s.fail > 0 ? 'fail' : s.warn > 0 ? 'warn' : 'pass';
  return s;
}

/**
 * Confusion matrix for the self-test: given predicted "different?" booleans and
 * ground-truth "actually different?" booleans, report precision/recall/F1/flake.
 *  - flakeRate = false positives among pairs that are truly identical (the cost of nervousness)
 *  - missRate  = false negatives among pairs that are truly different (the cost of blindness)
 */
export function confusion(rows) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const { predictedDifferent, actuallyDifferent } of rows) {
    if (actuallyDifferent && predictedDifferent) tp++;
    else if (actuallyDifferent && !predictedDifferent) fn++;
    else if (!actuallyDifferent && predictedDifferent) fp++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    tp, fp, tn, fn,
    precision, recall, f1,
    flakeRate: tn + fp ? fp / (tn + fp) : 0,
    missRate: tp + fn ? fn / (tp + fn) : 0,
  };
}
