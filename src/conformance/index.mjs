// index.mjs — `webview-diff conformance`: measure the live DOM, diff it against the
// design spec, emit property-level findings + a CI exit code. This is the HARD gate
// a harness hook calls; on non-zero it routes the agent back to fix mode with the
// findings list. (The convergence guards live in loop.mjs for the agent loop itself.)

import fs from 'node:fs';
import path from 'node:path';
import { measurePage, fetchFigmaSpec } from './measure.mjs';
import { compareSpec, DEFAULT_TOLERANCES } from './compare.mjs';

const C = { gray: (s) => `\x1b[90m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
const fmtVal = (f) => (f.type === 'color' ? `${f.expected} ≠ ${f.actual} (ΔE ${f.delta})` : f.type === 'px' ? `${f.expected} ≠ ${f.actual} (Δ${f.delta}px)` : `${f.expected} ≠ ${f.actual}`);

export async function conformanceMode(cfg, flags) {
  const specPath = path.resolve(cfg.cwd, flags.spec || cfg.conformance?.spec || 'webview-diff.conformance.json');
  if (!fs.existsSync(specPath)) {
    console.log(C.red(`\n  no conformance spec at ${path.relative(cfg.cwd, specPath)}`));
    console.log(C.gray('  provide one (--spec <file>), or generate from Figma (see DESIGN-CONFORMANCE.md).\n'));
    return 2;
  }
  let spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

  // Optional: refresh `expect` straight from Figma when a token + mapping are present.
  const token = process.env.FIGMA_TOKEN;
  if (spec.figma && token) {
    console.log(C.gray(`  pulling design tokens from Figma file ${spec.figma.fileKey} …`));
    spec = await fetchFigmaSpec({ fileKey: spec.figma.fileKey, token, mapping: spec.figma.mapping });
  }

  const tol = { ...DEFAULT_TOLERANCES, ...(spec.tolerances || cfg.conformance?.tolerances) };
  const selectors = Object.fromEntries(spec.components.map((c) => [c.key, c.selector]));
  const url = new URL(spec.route || '/', cfg.baseUrl).toString();

  console.log(C.bold(`\n  webview-diff · conformance — ${spec.components.length} component(s)`));
  console.log(C.gray(`  ${url}  ·  spec ${path.relative(cfg.cwd, specPath)}`));

  const measured = await measurePage({ url, selectors, viewport: cfg.conformance?.viewport });
  const result = compareSpec(spec, measured, tol);

  // group findings by component
  const byComp = {};
  for (const f of result.findings) (byComp[f.component] ||= []).push(f);

  console.log('  ' + '─'.repeat(60));
  for (const c of spec.components) {
    const fs_ = byComp[c.key] || [];
    if (!fs_.length) { console.log('  ' + C.green('✓ ') + c.key + C.gray(`  (${c.selector})`)); continue; }
    console.log('  ' + C.red('✗ ') + C.bold(c.key) + C.gray(`  (${c.selector})`));
    for (const f of fs_) console.log('      ' + C.yellow(f.property.padEnd(15)) + C.gray(fmtVal(f)));
  }
  console.log('  ' + '─'.repeat(60));
  console.log(`  ${result.count ? C.red(`${result.count} finding(s)`) : C.green('0 findings')}  ·  severity ${result.severity}`);

  const outDir = path.resolve(cfg.cwd, cfg.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'conformance.json');
  fs.writeFileSync(outFile, JSON.stringify({ url, spec: path.relative(cfg.cwd, specPath), ...result, measured }, null, 2));
  console.log(C.gray(`  findings: ${path.relative(cfg.cwd, outFile)}`));

  if (result.count > 0) { console.log(C.red('\n  ✗ conformance gate failed — route the agent back to fix with the findings above\n')); return 1; }
  console.log(C.green('\n  ✓ conformance gate passed\n')); return 0;
}
