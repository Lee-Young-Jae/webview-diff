#!/usr/bin/env node
// run.mjs — Orchestrator + CI gate.
//
// Pipeline:  capture (every route × profile)  ->  diff  ->  report  ->  exit code
// Two diff axes run off the same captures:
//   cross-engine : profile-vs-profile for the SAME build  (the "flutter에서 오는 차이")
//   regression   : profile-vs-its-baseline                (the "did my change drift")
//
// Usage:
//   node src/run.mjs                 full run (capture + diff + report), CI exit code
//   node src/run.mjs capture         capture only
//   node src/run.mjs diff            diff existing captures only
//   node src/run.mjs approve         accept current captures as the new baselines
//   flags: --base <url>  --fail-on <fail|warn>  --out <dir>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { captureAll } from './capture/capture.mjs';
import { runPerf } from './capture/perf.mjs';
import { decodePng, encodePng, strokeRect } from './engine/png.mjs';
import { diffImages } from './engine/diff.mjs';
import { classify, summarize, pct } from './engine/metrics.mjs';
import { classifyPerf, fmtMetric } from './engine/perf-budget.mjs';
import { classifyOcclusions } from './capture/safe-area-audit.mjs';
import { renderReport } from './engine/report.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { mode: 'run', flags: {} };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.flags.baseUrl = argv[++i];
    else if (a === '--out') args.flags.outDir = argv[++i];
    else if (a === '--fail-on') args.flags.failOn = argv[++i];
    else if (a.startsWith('--')) args.flags[a.slice(2)] = true;
    else rest.push(a);
  }
  if (rest[0]) args.mode = rest[0];
  return args;
}

const C = { gray: (s) => `\x1b[90m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
const levelColor = { pass: C.green, warn: C.yellow, fail: C.red };

async function main() {
  const { mode, flags } = parseArgs(process.argv.slice(2));

  // these run before config load (no config needed)
  if (mode === 'init') { const { init } = await import('./init.mjs'); return init(process.cwd(), flags); }
  if (mode === 'selftest') { await import('./selftest.mjs'); return; } // self-exits with pass/fail code

  const cfg = loadConfig(process.cwd(), { baseUrl: flags.baseUrl, outDir: flags.outDir });
  const outDir = path.resolve(cfg.cwd, cfg.outDir);
  const capDir = path.join(outDir, 'captures');
  const diffDir = path.join(outDir, 'diffs');
  const baselineDir = path.resolve(cfg.cwd, cfg.baselineDir);
  const reportPath = path.join(outDir, 'report.html');
  const failOn = flags.failOn || 'fail';

  if (mode === 'approve') return approve(capDir, baselineDir, cfg);

  if (mode === 'perf') {
    const ps = await perfStage(cfg, outDir);
    fs.writeFileSync(path.join(outDir, 'perf.json'), JSON.stringify(ps.results, null, 2));
    const html = renderReport({ title: cfg.title, meta: { subtitle: `${cfg.baseUrl}  ·  ${new Date().toISOString()}` }, summary: { total: 0, pass: 0, warn: 0, fail: 0, worst: 'pass' }, comparisons: [], perf: ps.results });
    fs.writeFileSync(reportPath, html);
    console.log(C.gray(`  report: ${path.relative(cfg.cwd, reportPath)}   json: ${path.relative(cfg.cwd, path.join(outDir, 'perf.json'))}`));
    const blocked = cfg.perf.failOn === 'warn' ? ps.worst !== 'pass' : ps.worst === 'fail';
    if (blocked) { console.log(C.red(`\n  ✗ perf gate failed (worst=${ps.worst}, fail-on=${cfg.perf.failOn})\n`)); process.exit(1); }
    console.log(C.green(`\n  ✓ perf gate passed\n`)); return;
  }

  // ---- 1. capture ----
  if (mode === 'run' || mode === 'capture') {
    console.log(C.bold(`\n  webview-diff · capturing ${cfg.routes.length} route(s) × ${Object.keys(cfg.profiles).length} profile(s)`));
    console.log(C.gray(`  base: ${cfg.baseUrl}`));
    const t0 = Date.now();
    const cap = await captureAll({
      baseUrl: cfg.baseUrl, routes: cfg.routes, profiles: cfg.profiles, outDir: capDir,
      bridgeConfig: cfg.bridge, concurrency: cfg.concurrency, retries: cfg.retries, fullPage: cfg.fullPage,
      onProgress: (n, total, r) => {
        const tag = r.ok ? C.green('ok ') : C.red('ERR');
        console.log(C.gray(`  [${String(n).padStart(2)}/${total}] `) + `${tag} ${r.route} · ${r.profile} ${r.ok ? '' : C.red(r.error)}`);
      },
    });
    cap.meta.capturedAt = new Date().toISOString();
    cap.meta.captureMs = Date.now() - t0;
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(cap, null, 2));
    console.log(C.gray(`  captured in ${(cap.meta.captureMs / 1000).toFixed(1)}s` + (cap.errors.length ? C.red(`  (${cap.errors.length} failed)`) : '')));
    if (cap.errors.length && mode === 'run') {
      // capture failures are hard errors — a missing screenshot can't be diffed
      console.log(C.red(`\n  ✗ ${cap.errors.length} capture(s) failed; aborting before diff.\n`));
      process.exit(2);
    }
    if (mode === 'capture') { console.log(''); return; }
  }

  // ---- 2 + 3. diff + report ----
  const comparisons = [];
  const tFix = (p) => path.relative(path.dirname(reportPath), p);

  // 2a. cross-engine pairs (same build, profile vs profile)
  for (const pair of cfg.pairs) {
    const th = cfg.thresholds[pair.mode] || cfg.thresholds['cross-engine'];
    for (const route of cfg.routes) {
      const aFile = path.join(capDir, route.name, `${pair.a}.png`);
      const bFile = path.join(capDir, route.name, `${pair.b}.png`);
      if (!fs.existsSync(aFile) || !fs.existsSync(bFile)) continue;
      const cmp = compare(aFile, bFile, th, diffDir, `${route.name}__${pair.a}__vs__${pair.b}`);
      comparisons.push({
        route: route.name, pairLabel: `${pair.label || `${pair.a} ↔ ${pair.b}`}  ·  ${pair.axis || pair.mode}`,
        aLabel: pair.a, bLabel: pair.b,
        aPathRel: tFix(aFile), bPathRel: tFix(bFile), diffPathRel: tFix(cmp.diffFile),
        result: cmp.result, verdict: cmp.verdict, axis: pair.axis || 'cross-engine',
      });
    }
  }

  // 2b. regression vs baseline (same profile, baseline vs current)
  for (const profileName of Object.keys(cfg.profiles)) {
    const th = cfg.thresholds.regression;
    for (const route of cfg.routes) {
      const curFile = path.join(capDir, route.name, `${profileName}.png`);
      const baseFile = path.join(baselineDir, route.name, `${profileName}.png`);
      if (!fs.existsSync(curFile) || !fs.existsSync(baseFile)) continue;
      const cmp = compare(baseFile, curFile, th, diffDir, `${route.name}__${profileName}__regression`);
      comparisons.push({
        route: route.name, pairLabel: `baseline ↔ current  ·  ${profileName}  ·  regression`,
        aLabel: `baseline/${profileName}`, bLabel: `current/${profileName}`,
        aPathRel: tFix(baseFile), bPathRel: tFix(curFile), diffPathRel: tFix(cmp.diffFile),
        result: cmp.result, verdict: cmp.verdict, axis: 'regression',
      });
    }
  }

  if (comparisons.length === 0) {
    console.log(C.yellow('\n  no comparisons produced (need ≥2 profiles for cross-engine, or baselines for regression).'));
    console.log(C.gray('  tip: run `node src/run.mjs approve` once to seed baselines.\n'));
    process.exit(0);
  }

  // safe-area occlusion findings (DOM audit, not pixels) read back from the manifest
  let occlusionFindings = [];
  const manifestPath = path.join(outDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const c of (man.captures || [])) {
        if (c.occlusions && c.occlusions.length) {
          occlusionFindings.push({ route: c.route, profile: c.profile, ...classifyOcclusions(c.occlusions) });
        }
      }
    } catch {}
  }
  const occlusionWorst = occlusionFindings.reduce((w, f) => (rank(f.level) > rank(w) ? f.level : w), 'pass');
  if (occlusionFindings.length) {
    console.log(C.bold('\n  safe-area occlusion'));
    for (const f of occlusionFindings) {
      console.log('  ' + levelColor[f.level](f.level.toUpperCase().padEnd(5)) + ` ${f.route.padEnd(12)} ${C.gray(f.profile)}  ${f.interactiveCount ? C.red(`${f.interactiveCount} interactive`) : ''}`);
      for (const o of f.occlusions.slice(0, 4)) console.log(C.gray(`        ${o.interactive ? '⌖' : '·'} <${o.tag}> "${o.text}" ${o.overlapPx}px under ${o.band}`));
    }
  }

  // optional performance axis (folded into the same report + gate).
  // run-mode only — perf needs live navigation; `diff` is a fast re-compute over captures.
  let perfResults = null, perfWorst = 'pass';
  if (mode === 'run' && cfg.perf.enabled) {
    const ps = await perfStage(cfg, outDir);
    perfResults = ps.results; perfWorst = ps.worst;
    fs.writeFileSync(path.join(outDir, 'perf.json'), JSON.stringify(perfResults, null, 2));
  }

  const summary = summarize(comparisons);
  const html = renderReport({
    title: cfg.title,
    meta: { subtitle: `${cfg.baseUrl}  ·  ${new Date().toISOString()}  ·  ${comparisons.length} comparisons` },
    summary, comparisons, perf: perfResults, occlusions: occlusionFindings,
  });
  fs.writeFileSync(reportPath, html);
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({
    summary,
    comparisons: comparisons.map((c) => ({ route: c.route, pair: c.pairLabel, axis: c.axis, level: c.verdict.level, diffRatio: c.result.diffRatio, diffPixels: c.result.diffPixels, sizeMismatch: c.result.sizeMismatch, reasons: c.verdict.reasons })),
    perf: perfResults ? perfResults.map((r) => ({ route: r.route, profile: r.profile, level: r.verdict.level, median: r.median, metrics: r.verdict.metrics })) : undefined,
    occlusions: occlusionFindings.length ? occlusionFindings.map((f) => ({ route: f.route, profile: f.profile, level: f.level, items: f.occlusions })) : undefined,
  }, null, 2));

  // ---- summary print ----
  console.log(C.bold('\n  results'));
  console.log('  ' + '─'.repeat(64));
  for (const c of comparisons.sort((a, b) => rank(b.verdict.level) - rank(a.verdict.level))) {
    const col = levelColor[c.verdict.level];
    console.log('  ' + col(c.verdict.level.toUpperCase().padEnd(5)) + ` ${c.route.padEnd(12)} ${C.gray(c.pairLabel.padEnd(40))} ${pct(c.result.diffRatio).padStart(9)}`);
  }
  console.log('  ' + '─'.repeat(64));
  console.log(`  ${C.green(`PASS ${summary.pass}`)}  ${C.yellow(`WARN ${summary.warn}`)}  ${C.red(`FAIL ${summary.fail}`)}  ·  total ${summary.total}`);
  console.log(C.gray(`  report: ${path.relative(cfg.cwd, reportPath)}   json: ${path.relative(cfg.cwd, path.join(outDir, 'result.json'))}`));

  const gate = failOn === 'warn' ? (summary.fail + summary.warn) : summary.fail;
  const perfBlocked = cfg.perf.enabled && (cfg.perf.failOn === 'warn' ? perfWorst !== 'pass' : perfWorst === 'fail');
  const occlusionBlocked = failOn === 'warn' ? occlusionWorst !== 'pass' : occlusionWorst === 'fail';
  if (gate > 0 || perfBlocked || occlusionBlocked) {
    const parts = [];
    if (gate > 0) parts.push(`${gate} visual comparison(s)`);
    if (perfBlocked) parts.push(`perf (${perfWorst})`);
    if (occlusionBlocked) parts.push(`safe-area occlusion (${occlusionWorst})`);
    console.log(C.red(`\n  ✗ gate failed: ${parts.join(' + ')}\n`)); process.exit(1);
  }
  console.log(C.green(`\n  ✓ gate passed\n`));
}

function rank(l) { return l === 'fail' ? 2 : l === 'warn' ? 1 : 0; }

function compare(aFile, bFile, th, diffDir, id) {
  const a = decodePng(fs.readFileSync(aFile));
  const b = decodePng(fs.readFileSync(bFile));
  const result = diffImages(a, b, { threshold: th.pixel, matchRadius: th.matchRadius || 0 });
  const verdict = classify(result, th);
  fs.mkdirSync(diffDir, { recursive: true });
  const diffFile = path.join(diffDir, `${id}.png`);
  // highlight the largest concentrated cluster (cyan box) so the eye lands on the
  // most likely real change, not the diffuse scatter.
  const lc = result.largestCluster;
  if (lc && lc.area >= 60 && lc.density >= 0.3) {
    strokeRect(result.data, result.width, result.height, lc.x - 2, lc.y - 2, lc.w + 4, lc.h + 4, [0, 229, 255], 2);
  }
  fs.writeFileSync(diffFile, encodePng(result.width, result.height, result.data));
  return { result, verdict, diffFile };
}

async function perfStage(cfg, outDir) {
  const profiles = {};
  for (const name of cfg.perf.profiles) if (cfg.profiles[name]) profiles[name] = cfg.profiles[name];
  const routes = cfg.perf.routes
    ? cfg.routes.filter((r) => cfg.perf.routes.includes(r.name) || cfg.perf.routes.includes(r.path))
    : cfg.routes;

  console.log(C.bold(`\n  webview-diff · perf — ${routes.length} route(s) × ${Object.keys(profiles).length} profile(s) × ${cfg.perf.runs} runs`));
  console.log(C.gray(`  base: ${cfg.baseUrl}  ·  throttle: ${cfg.perf.throttle.cpu}× CPU, net ${cfg.perf.throttle.net}  (Vitals=Chromium만 신뢰)`));
  const t0 = Date.now();
  const raw = await runPerf({
    baseUrl: cfg.baseUrl, routes, profiles, runs: cfg.perf.runs, throttle: cfg.perf.throttle, bridgeConfig: cfg.bridge,
    onProgress: (n, total, r) => {
      if (!r) return;
      console.log(C.gray(`  [${String(n).padStart(2)}/${total}] `) + `${r.route.padEnd(10)} ${r.profile.padEnd(14)} ` +
        C.gray(r.median ? `lcp=${r.median.lcp}ms cls=${r.median.cls} tbt=${r.median.tbt}ms ${Math.round(r.median.bytes / 1024)}KB/${r.median.requests}req` : C.red(r.error || 'fail')));
    },
  });

  const results = raw.map((r) => ({ ...r, verdict: classifyPerf(r, cfg.perf.budgets) }));
  console.log(C.bold('\n  perf results') + C.gray('  (median of runs; Vitals n/a = engine unsupported)'));
  console.log('  ' + '─'.repeat(72));
  for (const r of results) {
    const lvl = r.verdict.level === 'na' ? 'pass' : r.verdict.level;
    console.log('  ' + levelColor[lvl](r.verdict.level.toUpperCase().padEnd(5)) + ` ${r.route.padEnd(10)} ${C.gray(r.profile.padEnd(15))}`);
    if (r.verdict.metrics.length) {
      console.log('        ' + r.verdict.metrics.map((m) => {
        const txt = `${m.label} ${m.level === 'na' ? 'n/a' : fmtMetric(m.value, m.unit)}`;
        return m.level === 'fail' ? C.red(txt) : m.level === 'warn' ? C.yellow(txt) : C.gray(txt);
      }).join('   '));
    }
  }
  console.log('  ' + '─'.repeat(72));
  const worst = results.reduce((w, r) => (rank(r.verdict.level === 'na' ? 'pass' : r.verdict.level) > rank(w) ? (r.verdict.level === 'na' ? 'pass' : r.verdict.level) : w), 'pass');
  console.log(C.gray(`  perf in ${((Date.now() - t0) / 1000).toFixed(1)}s · worst=${worst}`));
  return { results, worst, ms: Date.now() - t0 };
}

function approve(capDir, baselineDir, cfg) {
  if (!fs.existsSync(capDir)) { console.log(C.red('\n  no captures to approve — run `node src/run.mjs capture` first.\n')); process.exit(1); }
  let n = 0;
  for (const route of cfg.routes) {
    const src = path.join(capDir, route.name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(baselineDir, route.name);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) { fs.copyFileSync(path.join(src, f), path.join(dst, f)); n++; }
  }
  console.log(C.green(`\n  ✓ approved ${n} baseline image(s) → ${path.relative(cfg.cwd, baselineDir)}/\n`));
}

main().catch((e) => { console.error(C.red('\n  fatal: ' + (e.stack || e.message)) + '\n'); process.exit(2); });
