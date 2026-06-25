// config.mjs — Load + normalize webview-diff.config.json (with env overrides).

import fs from 'node:fs';
import path from 'node:path';
import { resolveProfiles, DEFAULT_PAIRS } from './capture/profiles.mjs';
import { DEFAULT_THRESHOLDS } from './engine/metrics.mjs';
import { DEFAULT_BUDGETS } from './engine/perf-budget.mjs';

export const CONFIG_FILENAME = 'webview-diff.config.json';

const DEFAULTS = {
  title: 'webview-diff · report',
  baseUrl: 'http://localhost:4321',
  outDir: '.out',
  baselineDir: 'baselines',
  fullPage: true,
  concurrency: 4,
  retries: 2,
  routes: [{ path: '/', name: 'home' }],
  pairs: DEFAULT_PAIRS,
  // per-mode per-pixel sensitivity (see selftest.mjs for why these values):
  thresholds: {
    // same engine, deterministic captures -> strict, exact (no shift tolerance)
    regression: { pixel: 0.035, matchRadius: 0, ...DEFAULT_THRESHOLDS },
    // cross-engine -> tolerant per-pixel + shift tolerance (radius 2) to ignore
    // glyph-rasterization noise, while real structural drift still exceeds the radius
    // cross-engine has an irreducible edge-AA noise floor (~1-2% on solid shapes);
    // pass<0.3% (clean), warn 0.3-2% (diffuse edge noise — eyeball it), fail>2% (structural).
    // cluster gate is stricter than regression: cross-engine text renders as wide,
    // ~60%-fill bands (glyph rows). Only a near-solid block (>=70% fill) should
    // escalate, so engine font noise never trips it while a real recolored block does.
    'cross-engine': { pixel: 0.1, matchRadius: 2, ...DEFAULT_THRESHOLDS, pass: 0.003, warn: 0.02, clusterDensity: 0.7, clusterWarnArea: 600, clusterFailArea: 1500 },
  },
  bridge: {},
  masks: [], // global ignore selectors applied to every route
  // performance budget axis (the "성능 테스트"). off in `run` by default (it's slower —
  // runs×profiles×routes navigations); `perf` mode always runs it. CPU/net throttle +
  // median-of-N for reproducibility. Vitals (FCP/LCP/CLS/TBT) are Chromium-only.
  perf: {
    enabled: false,
    runs: 3,
    throttle: { cpu: 4, net: '4g' },
    profiles: ['baseline', 'engine-webkit'],
    routes: null, // null = all routes
    budgets: DEFAULT_BUDGETS,
    failOn: 'fail',
  },
};

export function loadConfig(cwd = process.cwd(), overrides = {}) {
  let file = {};
  const cfgPath = path.join(cwd, CONFIG_FILENAME);
  if (fs.existsSync(cfgPath)) {
    try { file = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (e) { throw new Error(`failed to parse ${cfgPath}: ${e.message}`); }
  }
  // drop undefined overrides so they don't clobber file/defaults
  const cleanOverrides = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  const cfg = { ...DEFAULTS, ...file, ...cleanOverrides };
  cfg.baseUrl = process.env.WEBVIEW_DIFF_BASE_URL || cleanOverrides.baseUrl || cfg.baseUrl;
  cfg.profiles = resolveProfiles(file);
  cfg.bridge = { ...(file.bridge || {}) };
  // resolve a custom bridge init script to an absolute path (relative to the config dir)
  if (cfg.bridge.initScript) cfg.bridge.initScript = path.resolve(cwd, cfg.bridge.initScript);
  cfg.thresholds = { ...DEFAULTS.thresholds, ...(file.thresholds || {}) };
  cfg.perf = { ...DEFAULTS.perf, ...(file.perf || {}) };
  cfg.perf.throttle = { ...DEFAULTS.perf.throttle, ...(file.perf?.throttle || {}) };
  cfg.perf.budgets = { ...DEFAULT_BUDGETS, ...(file.perf?.budgets || {}) };
  // normalize routes: allow string shorthand "/path" -> {path, name}
  cfg.routes = (cfg.routes || []).map((r) => typeof r === 'string'
    ? { path: r, name: r === '/' ? 'home' : r.replace(/^\//, '').replace(/\//g, '_') }
    : r);
  // apply global masks to each route
  for (const r of cfg.routes) r.masks = [...(cfg.masks || []), ...(r.masks || [])];
  cfg.cwd = cwd;
  return cfg;
}
