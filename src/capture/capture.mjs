// capture.mjs — Playwright driver. Renders each route under each profile into a
// deterministic PNG. Reuses one browser per engine, runs a small concurrency pool,
// retries flaky navigations, and injects the bridge mock + determinism harness
// before any app code runs.

import { chromium, webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { contextOptions } from './profiles.mjs';
import { bridgeInitScript } from './bridge-mock.mjs';
import { determinismInitScript, settle } from './determinism.mjs';
import { SAFE_AREA_AUDIT } from './safe-area-audit.mjs';

const ENGINES = { chromium, webkit };

/**
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {Array<{path:string,name:string,masks?:string[],waitFor?:string}>} o.routes
 * @param {Record<string,import('./profiles.mjs').Profile>} o.profiles
 * @param {string} o.outDir
 * @returns {Promise<{captures:Array, errors:Array, meta:object}>}
 */
export async function captureAll(o) {
  const {
    baseUrl, routes, profiles, outDir,
    bridgeConfig = {}, concurrency = 4, retries = 2,
    fullPage = true, navTimeout = 30000, networkIdleTimeout = 8000,
    onProgress = () => {},
  } = o;
  fs.mkdirSync(outDir, { recursive: true });

  const browsers = {};
  const getBrowser = async (engine) => {
    if (!browsers[engine]) {
      if (!ENGINES[engine]) throw new Error(`unknown engine "${engine}"`);
      browsers[engine] = await ENGINES[engine].launch({ headless: true });
    }
    return browsers[engine];
  };

  // build task list (every profile × every route)
  const tasks = [];
  for (const profileName of Object.keys(profiles)) {
    for (const route of routes) tasks.push({ profileName, route });
  }

  const captures = [];
  let cursor = 0, done = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const t = tasks[cursor++];
      const res = await captureOne(t, { profiles, baseUrl, outDir, bridgeConfig, fullPage, navTimeout, networkIdleTimeout, retries, getBrowser });
      captures.push(res);
      onProgress(++done, tasks.length, res);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  } finally {
    await Promise.all(Object.values(browsers).map((b) => b.close().catch(() => {})));
  }

  const errors = captures.filter((c) => !c.ok);
  return {
    captures,
    errors,
    meta: { baseUrl, profiles: Object.keys(profiles), routes: routes.map((r) => r.name), capturedAt: null },
  };
}

async function captureOne({ profileName, route }, ctx) {
  const { profiles, baseUrl, outDir, bridgeConfig, fullPage, navTimeout, networkIdleTimeout, retries, getBrowser } = ctx;
  const profile = profiles[profileName];
  const dir = path.join(outDir, route.name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${profileName}.png`);
  const url = new URL(route.path, baseUrl).toString();

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let context;
    try {
      const browser = await getBrowser(profile.engine);
      context = await browser.newContext(contextOptions(profile));
      const page = await context.newPage();

      // inject BEFORE app code: bridge mock first (app may read it at module load), then determinism.
      // bridge is optional — only injected when config.bridge.globalName (or a custom initScript) is set.
      if (bridgeConfig.initScript) {
        await page.addInitScript({ path: bridgeConfig.initScript });
      } else {
        const b = bridgeInitScript(profile, bridgeConfig);
        if (b) await page.addInitScript(b.fn, b.arg);
      }
      const d = determinismInitScript();
      await page.addInitScript(d.fn, d.arg);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      // best-effort network quiet; long-polling apps may never idle, so don't fail on it
      await page.waitForLoadState('networkidle', { timeout: networkIdleTimeout }).catch(() => {});
      if (route.waitFor) await page.waitForSelector(route.waitFor, { timeout: navTimeout });

      await settle(page);

      // safe-area occlusion audit (only where the profile has OS insets): does any
      // interactive/text element fall under the notch / home-indicator band?
      let occlusions;
      const ins = profile.safeArea || {};
      if (ins.top || ins.bottom || ins.left || ins.right) {
        occlusions = await page.evaluate(SAFE_AREA_AUDIT, ins).catch(() => null);
      }

      const mask = (route.masks || []).map((sel) => page.locator(sel));
      // scale:'css' captures at CSS-pixel resolution so differing devicePixelRatios
      // (2 / 2.625 / 3) don't make output dimensions diverge — comparisons stay
      // apples-to-apples. DPR still drives media queries / srcset, just not size.
      await page.screenshot({ path: file, fullPage, animations: 'disabled', caret: 'hide', mask, maskColor: '#FF00FF', scale: 'css' });

      await context.close();
      return { route: route.name, path: route.path, profile: profileName, engine: profile.engine, file, ok: true, attempt, occlusions };
    } catch (e) {
      lastErr = e;
      await context?.close().catch(() => {});
    }
  }
  return { route: route.name, path: route.path, profile: profileName, engine: profile.engine, file: null, ok: false, error: String(lastErr && lastErr.message || lastErr) };
}
