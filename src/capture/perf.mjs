// perf.mjs — Performance测정 축. 요구의 "성능 테스트"를 같은 파이프라인에서 게이트한다.
//
// 신뢰성 두 축:
//   1) 재현성 — CPU/네트워크 스로틀(CDP, Chromium)로 머신·실행 간 편차를 고정. 스로틀 없으면
//      빠른 개발 머신에서 늘 통과하다 CI에서 깨지는 식으로 무의미해진다(Lighthouse와 동일 이유).
//   2) 저분산 — 같은 측정을 N회 반복해 median을 취하고 min/max(분산)도 같이 보고한다.
//
// Web Vitals(LCP/CLS/TBT/FCP)는 PerformanceObserver 기반이라 사실상 Chromium에서만 신뢰 가능.
// WebKit은 navigation/resource timing(load·DCL·바이트·요청수)만 측정해 cross-engine 로드 비교에 쓴다.

import { chromium, webkit } from 'playwright';
import { contextOptions } from './profiles.mjs';
import { bridgeInitScript } from './bridge-mock.mjs';

const ENGINES = { chromium, webkit };

const NET_PRESETS = {
  '4g': { offline: false, latency: 20, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 },
  'fast3g': { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  'none': { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

// Injected BEFORE app code: register observers so buffered entries are captured.
function PERF_COLLECTOR() {
  const p = (window.__perf = { lcp: 0, cls: 0, tbt: 0, fcp: 0, longtasks: 0 });
  const obs = (type, cb) => { try { new PerformanceObserver(cb).observe({ type, buffered: true }); } catch {} };
  obs('largest-contentful-paint', (l) => { const e = l.getEntries(); const last = e[e.length - 1]; if (last) p.lcp = last.renderTime || last.loadTime || last.startTime; });
  obs('layout-shift', (l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) p.cls += e.value; });
  obs('longtask', (l) => { for (const e of l.getEntries()) { p.longtasks++; p.tbt += Math.max(0, e.duration - 50); } });
  obs('paint', (l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') p.fcp = e.startTime; });
}

// Read after the page has settled.
function PERF_READER() {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource');
  // include the main document itself (it's in the navigation entry, not resource[])
  let bytes = nav.transferSize || nav.encodedBodySize || 0;
  let jsBytes = 0, imgBytes = 0;
  for (const r of res) {
    const size = r.transferSize || r.encodedBodySize || 0;
    bytes += size;
    if (r.initiatorType === 'script' || /\.m?js(\?|$)/.test(r.name)) jsBytes += size;
    if (r.initiatorType === 'img' || /\.(png|jpe?g|webp|gif|svg)(\?|$)/.test(r.name)) imgBytes += size;
  }
  const requests = res.length + 1; // + main document
  const p = window.__perf || {};
  return {
    fcp: Math.round(p.fcp || 0), lcp: Math.round(p.lcp || 0), cls: +(p.cls || 0).toFixed(4),
    tbt: Math.round(p.tbt || 0), longtasks: p.longtasks || 0,
    ttfb: Math.round(nav.responseStart || 0),
    dcl: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0),
    bytes, jsBytes, imgBytes, requests,
  };
}

async function measureOnce(browser, profile, url, { throttle, bridgeConfig, navTimeout, settleMs }) {
  const context = await browser.newContext(contextOptions(profile));
  const page = await context.newPage();
  await page.addInitScript(PERF_COLLECTOR);
  if (bridgeConfig.initScript) {
    await page.addInitScript({ path: bridgeConfig.initScript });
  } else {
    const b = bridgeInitScript(profile, bridgeConfig);
    if (b) await page.addInitScript(b.fn, b.arg);
  }

  if (profile.engine === 'chromium' && throttle) {
    try {
      const client = await context.newCDPSession(page);
      if (throttle.cpu) await client.send('Emulation.setCPUThrottlingRate', { rate: throttle.cpu });
      if (throttle.net && throttle.net !== 'none') {
        await client.send('Network.enable');
        await client.send('Network.emulateNetworkConditions', NET_PRESETS[throttle.net] || NET_PRESETS['4g']);
      }
    } catch {}
  }

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
  await page.waitForLoadState('load', { timeout: navTimeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  // CLS accumulates from LATE shifts (banners/ads inserted after paint); under CPU
  // throttle those frames are slow, so we settle generously past the load event.
  await page.waitForTimeout(settleMs);
  const m = await page.evaluate(PERF_READER);
  m.wallMs = Date.now() - t0;
  await context.close();
  return m;
}

const NUMERIC = ['fcp', 'lcp', 'cls', 'tbt', 'longtasks', 'ttfb', 'dcl', 'load', 'bytes', 'jsBytes', 'imgBytes', 'requests', 'wallMs'];
function median(a) { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
function aggregate(samples) {
  const med = {}, spread = {};
  for (const k of NUMERIC) {
    const vals = samples.map((s) => s[k] ?? 0);
    med[k] = median(vals);
    spread[k] = { min: Math.min(...vals), max: Math.max(...vals) };
  }
  return { median: med, spread };
}

/**
 * @returns {Promise<Array<{route,profile,engine,runs,median,spread,supported}>>}
 */
export async function runPerf(o) {
  const {
    baseUrl, routes, profiles, runs = 3,
    throttle = { cpu: 4, net: '4g' }, bridgeConfig = {},
    navTimeout = 30000, settleMs = 2000, onProgress = () => {},
  } = o;

  const engines = {};
  const getBrowser = async (e) => { if (!engines[e]) engines[e] = await ENGINES[e].launch({ headless: true }); return engines[e]; };

  const results = [];
  let done = 0;
  const total = Object.keys(profiles).length * routes.length;
  try {
    for (const profileName of Object.keys(profiles)) {
      const profile = profiles[profileName];
      const browser = await getBrowser(profile.engine);
      const supported = { fcp: profile.engine === 'chromium', lcp: profile.engine === 'chromium', cls: profile.engine === 'chromium', tbt: profile.engine === 'chromium' };
      for (const route of routes) {
        const url = new URL(route.path, baseUrl).toString();
        const samples = [];
        for (let i = 0; i < runs; i++) {
          try { samples.push(await measureOnce(browser, profile, url, { throttle, bridgeConfig, navTimeout, settleMs })); }
          catch (e) { /* skip a failed sample; median over the rest */ }
        }
        if (!samples.length) { results.push({ route: route.name, profile: profileName, engine: profile.engine, runs: 0, error: 'all samples failed' }); onProgress(++done, total); continue; }
        const { median: med, spread } = aggregate(samples);
        const r = { route: route.name, profile: profileName, engine: profile.engine, runs: samples.length, median: med, spread, supported };
        results.push(r);
        onProgress(++done, total, r);
      }
    }
  } finally {
    await Promise.all(Object.values(engines).map((b) => b.close().catch(() => {})));
  }
  return results;
}
