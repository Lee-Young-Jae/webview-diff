// bridge-mock.mjs — Generic webview bridge mock injector.
//
// Many webview apps expose a JS bridge on `window` (e.g. window.NativeBridge,
// window.webkit.messageHandlers, a custom name…) that the web depends on; in a plain
// browser it's absent, so screens that read it won't render. This injects a
// CONFIGURABLE mock BEFORE app code runs — same role MSW plays for the API layer.
//
// It's fully generic: you pick the global name and the method/property fixtures in
// `webview-diff.config.json`. `platform` and `safe-area insets` are provided
// automatically from the active profile (universal webview concepts) so pages that
// branch on platform or read insets render the way they would inside that WebView.
//
// config.bridge:
//   globalName  : window property to define (e.g. "NativeBridge"). ABSENT → no injection.
//   api         : { method: returnValue } — each becomes `async () => returnValue`
//   props       : { name: value }          — static properties on the bridge
//   exposeSafeAreaVars : default true — set --safe-area-inset-* CSS vars from the profile
//   initScript  : path to a fully custom init script (escape hatch; handled by the caller)
//
// Returns { fn, arg } for page.addInitScript, or null when no bridge is configured.

export function bridgeInitScript(profile, bridgeConfig = {}) {
  if (!bridgeConfig.globalName) return null;
  const arg = {
    globalName: bridgeConfig.globalName,
    api: bridgeConfig.api || {},
    props: bridgeConfig.props || {},
    platform: bridgeConfig.platform || profile.platform || 'web',
    safeArea: profile.safeArea || { top: 0, right: 0, bottom: 0, left: 0 },
    exposeSafeAreaVars: bridgeConfig.exposeSafeAreaVars !== false,
  };

  const fn = (cfg) => {
    const listeners = {};
    const on = (ev, cb) => { (listeners[ev] ||= []).push(cb); return () => off(ev, cb); };
    const off = (ev, cb) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); };
    const emit = (ev, payload) => (listeners[ev] || []).forEach((f) => { try { f(payload); } catch {} });

    const bridge = {
      __isMock: true,
      // universal webview concepts, sourced from the active profile
      platform: cfg.platform,
      getPlatform: () => cfg.platform,
      getSafeAreaInsets: () => ({ ...cfg.safeArea }),
      appReady: () => { window.__WEBVIEW_APP_READY__ = true; emit('appReady', {}); },
      on, off, postMessage: (m) => emit('message', m),
      // app-defined static properties
      ...cfg.props,
    };
    // app-defined methods → async functions returning the configured fixture
    for (const [name, value] of Object.entries(cfg.api)) {
      bridge[name] = async () => (value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value);
    }

    Object.defineProperty(window, cfg.globalName, { value: bridge, writable: false, configurable: true });
    window.__WEBVIEW_BRIDGE_MOCK__ = cfg.globalName;

    // Real WebViews set env(safe-area-inset-*); emulators don't, so expose them as
    // CSS vars from the profile — otherwise inset-aware layout goes untested.
    if (cfg.exposeSafeAreaVars) {
      const apply = () => {
        const r = document.documentElement; if (!r) return;
        r.style.setProperty('--safe-area-inset-top', cfg.safeArea.top + 'px');
        r.style.setProperty('--safe-area-inset-right', cfg.safeArea.right + 'px');
        r.style.setProperty('--safe-area-inset-bottom', cfg.safeArea.bottom + 'px');
        r.style.setProperty('--safe-area-inset-left', cfg.safeArea.left + 'px');
        r.dataset.platform = cfg.platform;
      };
      if (document.documentElement) apply();
      document.addEventListener('DOMContentLoaded', apply);
    }
  };

  return { fn, arg };
}
