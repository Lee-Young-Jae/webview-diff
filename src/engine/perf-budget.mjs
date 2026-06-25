// perf-budget.mjs — Classify measured Web Vitals / load metrics against budgets.
// Pure (no deps). Same PASS/WARN/FAIL vocabulary as the visual diff so CI gates uniformly.

export const DEFAULT_BUDGETS = {
  fcp: { warn: 1800, fail: 3000, unit: 'ms', label: 'FCP' },           // First Contentful Paint
  lcp: { warn: 2500, fail: 4000, unit: 'ms', label: 'LCP' },           // Largest Contentful Paint
  cls: { warn: 0.1, fail: 0.25, unit: '', label: 'CLS' },              // Cumulative Layout Shift
  tbt: { warn: 200, fail: 600, unit: 'ms', label: 'TBT' },             // Total Blocking Time
  bytes: { warn: 500 * 1024, fail: 1024 * 1024, unit: 'B', label: 'Transfer' },
  requests: { warn: 50, fail: 100, unit: '', label: 'Requests' },
};

// metrics that depend on Chromium-only PerformanceObserver entries
const VITALS = new Set(['fcp', 'lcp', 'cls', 'tbt']);
const rank = (l) => (l === 'fail' ? 2 : l === 'warn' ? 1 : 0);

export function classifyPerf(result, budgets = DEFAULT_BUDGETS) {
  const metrics = [];
  let level = 'pass';
  if (!result.median) return { level: 'na', metrics: [], note: result.error || 'no samples' };
  for (const [key, b] of Object.entries(budgets)) {
    const value = result.median[key];
    if (VITALS.has(key) && result.supported && result.supported[key] === false) {
      metrics.push({ key, label: b.label, value, unit: b.unit, level: 'na' });
      continue;
    }
    let m = 'pass';
    if (value > b.fail) m = 'fail'; else if (value > b.warn) m = 'warn';
    if (rank(m) > rank(level)) level = m;
    metrics.push({ key, label: b.label, value, unit: b.unit, level: m, warn: b.warn, fail: b.fail });
  }
  return { level, metrics };
}

export function fmtMetric(value, unit) {
  if (unit === 'ms') return `${Math.round(value)}ms`;
  if (unit === 'B') return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(2)}MB` : `${Math.round(value / 1024)}KB`;
  if (unit === '') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  return String(value);
}
