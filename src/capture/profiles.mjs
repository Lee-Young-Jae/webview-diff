// profiles.mjs — Environment profiles that emulate the *real* render targets.
//
// "디자인 차이가 flutter에서 온다"의 정체: 같은 웹 콘텐츠가 환경마다 다르게 그려진다.
//   - Android System WebView  ≈ Blink/Chromium   -> Playwright `chromium`
//   - iOS WKWebView           ≈ WebKit/Safari     -> Playwright `webkit`
//   - dev-browser             = 웹 개발자가 매일 보는 화면 (설계 기준선)
//
// A profile pins everything that changes pixels: engine, viewport, devicePixelRatio,
// UA (incl. the `wv` WebView token + app marker so the web can detect it), locale,
// timezone, color scheme, and OS safe-area insets (notch / home-indicator) — which
// are a MAJOR source of webview-only layout bugs and are NOT emulated by default.

/** @typedef {{ name:string, engine:'chromium'|'webkit', platform:'android'|'ios'|'web',
 *   viewport:{width:number,height:number}, deviceScaleFactor:number, isMobile:boolean,
 *   hasTouch:boolean, userAgent?:string, locale:string, timezoneId:string,
 *   colorScheme:'light'|'dark', safeArea:{top:number,right:number,bottom:number,left:number},
 *   appMarker?:string }} Profile */

const UA = {
  // Android 14 System WebView (Chrome 124) — note the trailing ` wv` token.
  androidWebview: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 wv',
  // iOS 17 WKWebView (WebKit). WKWebView UA omits "Safari" but is otherwise Mobile WebKit.
  iosWkwebview: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
};

// Profiles are designed for ONE-VARIABLE-PER-COMPARISON. Each non-baseline profile
// differs from `baseline` in exactly one dimension, so a failing pair points at a
// single cause instead of a soup of engine+platform+inset effects. Everything is
// pinned equal (viewport 393×852, DPR 2, ko-KR, Asia/Seoul, light) except the one
// axis under test. The real shipping iOS target (webkit+ios+insets+DPR3 all at once)
// is exercised by regression-vs-baseline, not by cross-diffing — see DESIGN.md.
const VP = { width: 393, height: 852 };
const COMMON = { viewport: VP, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul', colorScheme: 'light' };
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
const IOS_INSETS = { top: 59, right: 0, bottom: 34, left: 0 }; // iPhone 15 notch + home indicator

export const PROFILES = {
  // reference environment: Blink engine, android branch, no insets
  baseline: { ...COMMON, name: 'baseline', engine: 'chromium', platform: 'android', safeArea: NO_INSETS, appMarker: 'App/1.0 (android)' },
  // vary ONLY the engine -> isolates Blink↔WebKit rendering (iOS WKWebView ≈ WebKit)
  'engine-webkit': { ...COMMON, name: 'engine-webkit', engine: 'webkit', platform: 'android', userAgent: UA.iosWkwebview, safeArea: NO_INSETS, appMarker: 'App/1.0 (android)' },
  // vary ONLY the platform branch -> isolates platform-conditional CSS/JS (data-platform / bridge.platform)
  'platform-ios': { ...COMMON, name: 'platform-ios', engine: 'chromium', platform: 'ios', userAgent: UA.androidWebview, safeArea: NO_INSETS, appMarker: 'App/1.0 (ios)' },
  // vary ONLY the OS safe-area insets -> isolates inset handling (notch / home indicator)
  'insets-ios': { ...COMMON, name: 'insets-ios', engine: 'chromium', platform: 'android', safeArea: IOS_INSETS, appMarker: 'App/1.0 (android)' },
};

/** Each pair changes exactly one axis, so a failure has a single, nameable cause. */
export const DEFAULT_PAIRS = [
  { a: 'baseline', b: 'engine-webkit', mode: 'cross-engine', axis: 'engine', label: 'Blink → WebKit (engine)' },
  { a: 'baseline', b: 'platform-ios', mode: 'cross-engine', axis: 'platform', label: 'android → ios (platform branch)' },
  { a: 'baseline', b: 'insets-ios', mode: 'cross-engine', axis: 'safe-area', label: 'safe-area insets (OS)' },
];

export function resolveProfiles(config = {}) {
  const merged = { ...PROFILES };
  for (const [k, v] of Object.entries(config.profiles || {})) {
    merged[k] = { ...(merged[k] || {}), ...v, name: k };
  }
  return merged;
}

/** Build a Playwright context options object from a profile. */
export function contextOptions(profile) {
  return {
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.engine === 'chromium' ? profile.isMobile : undefined, // isMobile unsupported on webkit
    hasTouch: profile.hasTouch,
    userAgent: profile.userAgent,
    locale: profile.locale,
    timezoneId: profile.timezoneId,
    colorScheme: profile.colorScheme,
    reducedMotion: 'reduce',
    forcedColors: 'none',
  };
}
