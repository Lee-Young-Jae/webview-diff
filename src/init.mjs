// init.mjs — `webview-diff init`: scaffold config + print setup steps + (optional) CI.
// Non-interactive so it works in any shell/agent. Flags: --base <url>, --ci, --force.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME } from './config.mjs';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const C = { gray: (s) => `\x1b[90m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m` };

function configTemplate(baseUrl) {
  return {
    title: 'My App · webview-diff',
    baseUrl,
    routes: ['/'],
    masks: [],
    // Uncomment if your web depends on a JS bridge (window.<Name>). Omit for plain web apps.
    // bridge: { globalName: 'NativeBridge', api: { getAuthToken: 'mock.token' } },
    perf: { enabled: false, runs: 3, throttle: { cpu: 4, net: '4g' }, profiles: ['baseline', 'engine-webkit'] },
  };
}

export function init(cwd, flags = {}) {
  const baseUrl = flags.baseUrl || 'http://localhost:3000';
  const cfgPath = path.join(cwd, CONFIG_FILENAME);

  console.log(C.bold('\n  webview-diff init\n'));

  // 1) config
  if (fs.existsSync(cfgPath) && !flags.force) {
    console.log(C.yellow(`  • ${CONFIG_FILENAME} already exists — left untouched (use --force to overwrite)`));
  } else {
    fs.writeFileSync(cfgPath, JSON.stringify(configTemplate(baseUrl), null, 2) + '\n');
    console.log(C.green(`  ✓ wrote ${CONFIG_FILENAME}`) + C.gray(`  (baseUrl=${baseUrl}, edit routes/bridge/perf)`));
  }

  // 2) optional CI workflow
  if (flags.ci) {
    const wfDir = path.join(cwd, '.github', 'workflows');
    const dst = path.join(wfDir, 'webview-diff.yml');
    const src = path.join(PKG_ROOT, 'ci', 'github-actions.yml');
    if (fs.existsSync(dst) && !flags.force) {
      console.log(C.yellow('  • .github/workflows/webview-diff.yml exists — skipped (use --force)'));
    } else if (fs.existsSync(src)) {
      fs.mkdirSync(wfDir, { recursive: true });
      fs.copyFileSync(src, dst);
      console.log(C.green('  ✓ wrote .github/workflows/webview-diff.yml') + C.gray('  (edit the "Start app" step)'));
    }
  }

  // 3) next steps
  console.log(C.bold('\n  next:'));
  console.log('    1) ' + C.cyan('pnpm exec playwright install chromium webkit') + C.gray('   # one-time, browser binaries'));
  console.log('    2) edit ' + C.cyan(CONFIG_FILENAME) + C.gray('   # set real routes; add bridge/masks if needed'));
  console.log('    3) ' + C.cyan('pnpm exec webview-diff selftest') + C.gray('   # verify the detector (no browser)'));
  console.log('    4) ' + C.cyan(`pnpm exec webview-diff --base ${baseUrl}`) + C.gray('   # run against your app'));
  console.log('    5) ' + C.cyan('pnpm exec webview-diff approve') + C.gray('   # (optional) seed regression baselines'));
  console.log(C.gray('\n    tip: add `--ci` to scaffold a GitHub Actions workflow.\n'));
}
