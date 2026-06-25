// determinism.mjs — Kill every source of screenshot flake BEFORE the pixels are read.
//
// Flake is the enemy of a visual-regression tool: one false alarm and people stop
// trusting (and then stop reading) the report. The sources, and how we neutralize each:
//   time-based UI (clocks, "3분 전")  -> freeze Date / Date.now
//   randomized content / shuffles      -> seed Math.random
//   animations, transitions, carets    -> disable via CSS, force reduced-motion
//   web fonts (FOUT)                   -> await document.fonts.ready
//   lazy images / below-the-fold       -> scroll the page, then await decode()
//   in-flight network                  -> caller navigates with waitUntil:networkidle

const FROZEN_EPOCH = Date.UTC(2026, 0, 2, 3, 0, 0); // fixed instant for all runs

/** Init script (runs before the app): freeze time + seed randomness. */
export function determinismInitScript() {
  const arg = { epoch: FROZEN_EPOCH, seed: 0x9e3779b9 };
  const fn = (cfg) => {
    const RealDate = Date;
    class FrozenDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(cfg.epoch); else super(...a); }
      static now() { return cfg.epoch; }
    }
    FrozenDate.parse = RealDate.parse; FrozenDate.UTC = RealDate.UTC;
    // eslint-disable-next-line no-global-assign
    window.Date = FrozenDate;

    let s = cfg.seed >>> 0;
    Math.random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };

    // deterministic rAF timestamps (some libs key animations off the high-res clock)
    let t = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf(() => cb((t += 16)));
  };
  return { fn, arg };
}

/** CSS that freezes motion and hides carets/scrollbars for stable capture. */
export const STABILIZE_CSS = `
*,*::before,*::after{
  animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;
  transition-duration:0s!important;transition-delay:0s!important;
  caret-color:transparent!important;
}
html,body{scroll-behavior:auto!important}
/* hide scrollbars so their (engine-specific) width never counts as a diff */
::-webkit-scrollbar{display:none!important}
*{scrollbar-width:none!important}
`;

/**
 * Settle a navigated page into a deterministic, fully-rendered state.
 * @param {import('playwright').Page} page
 */
export async function settle(page, { extraWaitMs = 150, timeout = 15000 } = {}) {
  // 1) trigger lazy / below-the-fold content by scrolling through, then return to top
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      let y = 0;
      const step = () => {
        window.scrollTo(0, y); y += window.innerHeight;
        if (y < h) setTimeout(step, 8); else { window.scrollTo(0, 0); resolve(); }
      };
      step();
    });
  }).catch(() => {});

  // 2) fonts loaded + every image decoded (kills FOUT and half-painted images)
  await page.evaluate(async () => {
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
    await Promise.all([...document.images].map((img) =>
      img.complete && img.naturalWidth ? Promise.resolve() : (img.decode ? img.decode().catch(() => {}) : Promise.resolve())
    ));
  }).catch(() => {});

  // 3) freeze motion / carets
  await page.addStyleTag({ content: STABILIZE_CSS }).catch(() => {});

  // 4) let one more frame paint, then a fixed settle
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  await page.waitForTimeout(extraWaitMs);
}
