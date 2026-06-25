// report.mjs — Self-contained HTML report (no external assets, no network).
// One card per comparison: baseline | candidate | diff overlay, with a drag
// slider to A/B-wipe, severity badges, and the numbers that drove the verdict.

import { pct } from './metrics.mjs';
import { fmtMetric } from './perf-budget.mjs';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderReport({ title, summary, comparisons, meta = {}, perf = null, occlusions = null }) {
  const badge = (lvl) => `<span class="badge ${lvl}">${lvl.toUpperCase()}</span>`;

  const occlusionHtml = (occlusions && occlusions.length) ? `
    <section class="occl">
      <h2>Safe-area occlusion <span class="mut">· DOM 감사 — 노치/홈 인디케이터에 가려지는 요소 (픽셀 diff가 못 잡는 버그)</span></h2>
      ${occlusions.map((f) => `
        <div class="occ-grp ${f.level}">
          <div class="occ-head">${badge(f.level)} <strong>${esc(f.route)}</strong> <span class="mut">${esc(f.profile)}</span>${f.interactiveCount ? ` <span class="warn-t">${f.interactiveCount} interactive 가려짐</span>` : ''}</div>
          <ul>${f.occlusions.map((o) => `<li>${o.interactive ? '⌖' : '·'} <code>&lt;${esc(o.tag)}&gt;</code> "${esc(o.text)}" — ${o.overlapPx}px under <b>${esc(o.band)}</b></li>`).join('')}</ul>
        </div>`).join('')}
    </section>` : '';

  const perfHtml = (perf && perf.length) ? `
    <section class="perf">
      <h2>Performance <span class="mut">· median of ${perf[0].runs} runs, throttled (Vitals = Chromium only)</span></h2>
      <table>
        <thead><tr><th>route</th><th>profile</th><th>verdict</th>${perf[0].verdict.metrics.map((m) => `<th>${esc(m.label)}</th>`).join('')}</tr></thead>
        <tbody>${perf.map((r) => `
          <tr>
            <td><strong>${esc(r.route)}</strong></td><td class="mut">${esc(r.profile)} <span class="eng">${esc(r.engine)}</span></td>
            <td>${badge(r.verdict.level === 'na' ? 'pass' : r.verdict.level)}</td>
            ${r.verdict.metrics.map((m) => `<td class="m ${m.level}">${m.level === 'na' ? '<span class="na">n/a</span>' : esc(fmtMetric(m.value, m.unit))}</td>`).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </section>` : '';
  const cards = comparisons.map((c, i) => `
    <article class="card ${c.verdict.level}" data-level="${c.verdict.level}" id="c${i}">
      <header>
        <div class="t">${badge(c.verdict.level)} <strong>${esc(c.route)}</strong> <span class="pair">${esc(c.pairLabel)}</span></div>
        <div class="nums">
          diff <b>${pct(c.result.diffRatio)}</b> · ${c.result.diffPixels.toLocaleString()} px
          ${c.result.largestCluster ? `· cluster <b>${c.result.largestCluster.w}×${c.result.largestCluster.h}</b> (${c.result.largestCluster.area.toLocaleString()}px, ${Math.round(c.result.largestCluster.density * 100)}%)` : ''}
          ${c.result.sizeMismatch ? `· <span class="warn-t">size ${c.result.dims.a.w}×${c.result.dims.a.h} vs ${c.result.dims.b.w}×${c.result.dims.b.h}</span>` : ''}
        </div>
      </header>
      ${c.verdict.reasons.length ? `<div class="reasons">${c.verdict.reasons.map(esc).join(' · ')}</div>` : ''}
      <div class="viz">
        <div class="wipe" data-i="${i}">
          <img class="b" src="${esc(c.bPathRel)}" alt="candidate" loading="lazy">
          <div class="a-wrap"><img class="a" src="${esc(c.aPathRel)}" alt="baseline" loading="lazy"></div>
          <div class="handle"></div>
        </div>
        <div class="diffcol"><img src="${esc(c.diffPathRel)}" alt="diff" loading="lazy"><span class="cap">diff overlay</span></div>
      </div>
      <footer><span class="lbl-a">A: ${esc(c.aLabel)}</span><span class="lbl-b">B: ${esc(c.bLabel)}</span></footer>
    </article>`).join('\n');

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{--pass:#16a34a;--warn:#d97706;--fail:#dc2626;--bg:#0b0e14;--card:#141925;--ink:#e6e9ef;--mut:#8b93a7;--line:#222a3a}
  *{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  header.top{position:sticky;top:0;z-index:5;background:rgba(11,14,20,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 20px}
  h1{font-size:16px;margin:0 0 6px}
  .meta{color:var(--mut);font-size:12px}
  .sumbar{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
  .chip{padding:4px 10px;border-radius:999px;border:1px solid var(--line);cursor:pointer;user-select:none;font-size:12px}
  .chip.on{outline:2px solid #3b82f6}
  .chip .n{font-weight:700;margin-left:4px}
  .chip.pass{color:var(--pass)}.chip.warn{color:var(--warn)}.chip.fail{color:var(--fail)}
  main{padding:18px;display:grid;gap:18px;max-width:1500px;margin:0 auto}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;border-left:4px solid var(--line)}
  .card.pass{border-left-color:var(--pass)}.card.warn{border-left-color:var(--warn)}.card.fail{border-left-color:var(--fail)}
  .card header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:8px}
  .pair{color:var(--mut);font-size:12px;margin-left:6px}
  .nums{color:var(--mut);font-size:12px}.nums b{color:var(--ink)}
  .badge{font-size:10px;font-weight:800;padding:2px 7px;border-radius:5px;letter-spacing:.04em}
  .badge.pass{background:rgba(22,163,74,.15);color:var(--pass)}.badge.warn{background:rgba(217,119,6,.15);color:var(--warn)}.badge.fail{background:rgba(220,38,38,.15);color:var(--fail)}
  .reasons{color:var(--warn);font-size:12px;margin:2px 0 10px}
  .warn-t{color:var(--warn)}
  .viz{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .wipe{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:#1b2030;cursor:ew-resize}
  .wipe img{display:block;width:100%;height:auto}
  .wipe .a-wrap{position:absolute;inset:0;width:50%;overflow:hidden;border-right:2px solid #3b82f6}
  .wipe .a-wrap img{width:auto;max-width:none;height:100%}
  .wipe .handle{position:absolute;top:0;bottom:0;left:50%;width:2px;background:#3b82f6;pointer-events:none}
  .diffcol{position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#1b2030}
  .diffcol img{display:block;width:100%;height:auto}
  .cap{position:absolute;top:6px;left:8px;font-size:10px;color:var(--mut);background:rgba(0,0,0,.5);padding:2px 6px;border-radius:4px}
  footer{display:flex;justify-content:space-between;color:var(--mut);font-size:11px;margin-top:8px}
  .hidden{display:none}
  .mut{color:var(--mut)}
  section.perf{max-width:1500px;margin:18px auto 0;padding:0 18px}
  section.perf h2{font-size:14px;font-weight:700;margin:0 0 10px}
  section.perf table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:13px}
  section.perf th,section.perf td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line)}
  section.perf th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  section.perf tr:last-child td{border-bottom:0}
  section.perf td.m{font-variant-numeric:tabular-nums;font-weight:600}
  section.perf td.m.pass{color:var(--pass)} section.perf td.m.warn{color:var(--warn)} section.perf td.m.fail{color:var(--fail)}
  section.perf td.m.na .na{color:var(--mut);font-weight:400}
  section.perf .eng{font-size:10px;color:var(--mut);border:1px solid var(--line);border-radius:4px;padding:1px 5px;margin-left:4px}
  section.occl{max-width:1500px;margin:18px auto 0;padding:0 18px}
  section.occl h2{font-size:14px;font-weight:700;margin:0 0 10px}
  .occ-grp{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}
  .occ-grp.fail{border-left-color:var(--fail)} .occ-grp.warn{border-left-color:var(--warn)}
  .occ-head{display:flex;gap:8px;align-items:center;font-size:13px}
  .occ-grp ul{margin:8px 0 0;padding-left:18px;color:var(--ink);font-size:12px}
  .occ-grp li{margin:2px 0}
  .occ-grp code{background:#1b2030;border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:11px}
</style></head><body>
<header class="top">
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(meta.subtitle || '')}</div>
  ${comparisons.length ? `<div class="sumbar">
    <span class="chip on" data-f="all">전체<span class="n">${summary.total}</span></span>
    <span class="chip fail" data-f="fail">FAIL<span class="n">${summary.fail}</span></span>
    <span class="chip warn" data-f="warn">WARN<span class="n">${summary.warn}</span></span>
    <span class="chip pass" data-f="pass">PASS<span class="n">${summary.pass}</span></span>
  </div>` : ''}
</header>
${occlusionHtml}
${perfHtml}
${comparisons.length ? `<main id="grid">${cards}</main>` : ''}
<script>
  // severity filter
  const chips=[...document.querySelectorAll('.chip')];
  chips.forEach(ch=>ch.onclick=()=>{
    chips.forEach(c=>c.classList.toggle('on',c===ch));
    const f=ch.dataset.f;
    document.querySelectorAll('.card').forEach(c=>c.classList.toggle('hidden', f!=='all' && c.dataset.level!==f));
  });
  // drag-wipe each comparison
  document.querySelectorAll('.wipe').forEach(w=>{
    const aw=w.querySelector('.a-wrap'), h=w.querySelector('.handle');
    const set=x=>{const r=w.getBoundingClientRect();let p=(x-r.left)/r.width;p=Math.max(0,Math.min(1,p));aw.style.width=(p*100)+'%';h.style.left=(p*100)+'%';};
    let down=false;
    w.addEventListener('pointerdown',e=>{down=true;set(e.clientX);});
    window.addEventListener('pointermove',e=>{if(down)set(e.clientX);});
    window.addEventListener('pointerup',()=>down=false);
    w.addEventListener('pointermove',e=>{if(!down)set(e.clientX);}); // hover-scrub too
  });
</script>
</body></html>`;
}
