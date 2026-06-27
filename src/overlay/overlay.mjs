// overlay.mjs — design ↔ screenshot 오버레이 뷰어 생성기.
//
// 이미지 두 장(디자인 export, 앱 스크린샷)을 받아 self-contained HTML을 만든다.
// 앱 출처(Flutter 네이티브 / 웹 / 무엇이든)와 무관 — 사람이 비교·리뷰하는 용도.
//
// 신뢰 장치: 스케일 정규화 / 수동 정렬(nudge) / 모드 4종(onion·wipe·difference·toggle) / 8px 그리드.
// 의존성 0 (node 내장만).

import fs from 'node:fs';
import path from 'node:path';

const dataUri = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
const dims = (p) => { const b = fs.readFileSync(p); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }; // PNG IHDR
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SCRIPT = [
  "const stage=document.getElementById('stage'),design=document.getElementById('design'),op=document.getElementById('op');",
  "const read=document.getElementById('read'),gridEl=document.getElementById('gridEl'),wipe=document.getElementById('wipe');",
  "let dx=0,dy=0,scale=1,mode='onion';",
  "function apply(){",
  "  design.style.transform='translate('+dx+'px,'+dy+'px) scale('+scale+')';",
  "  read.textContent='dx '+dx+' \\u00b7 dy '+dy+' \\u00b7 scale '+scale.toFixed(3);",
  "  design.style.mixBlendMode = mode==='diff' ? 'difference' : 'normal';",
  "  if(mode==='onion'){ design.style.opacity=op.value/100; design.style.clipPath='none'; design.style.display='block'; }",
  "  else if(mode==='diff'){ design.style.opacity=1; design.style.clipPath='none'; design.style.display='block'; }",
  "  else if(mode==='toggle'){ design.style.clipPath='none'; }",
  "  else if(mode==='wipe'){ design.style.opacity=1; design.style.display='block';",
  "    const r=stage.getBoundingClientRect(); const x=(wipe._x==null?r.width/2:wipe._x);",
  "    design.style.clipPath='inset(0 0 0 '+x+'px)'; wipe.style.left=x+'px'; }",
  "  wipe.style.display = mode==='wipe' ? 'block':'none';",
  "}",
  "function setMode(m){ mode=m; const seg=document.getElementById('modes'); [].forEach.call(seg.children,function(b){b.classList.toggle('on',b.dataset.m===m);}); apply(); }",
  "document.getElementById('modes').onclick=function(e){ if(e.target.dataset.m) setMode(e.target.dataset.m); };",
  "op.oninput=apply;",
  "document.getElementById('grid').onchange=function(e){ gridEl.style.display=e.target.checked?'block':'none'; };",
  "document.getElementById('reset').onclick=function(){ dx=0;dy=0;scale=1; apply(); };",
  "stage.addEventListener('click',function(e){ if(mode==='toggle'&&e.target!==wipe) design.style.opacity=(design.style.opacity==='0'?'1':'0'); stage.focus(); });",
  "let drag=false;",
  "wipe.addEventListener('pointerdown',function(){drag=true;});",
  "window.addEventListener('pointerup',function(){drag=false;});",
  "stage.addEventListener('pointermove',function(e){ if(!drag||mode!=='wipe')return; const r=stage.getBoundingClientRect(); wipe._x=Math.max(0,Math.min(r.width,e.clientX-r.left)); apply(); });",
  "stage.addEventListener('keydown',function(e){ const s=e.shiftKey?10:1; let h=true;",
  "  if(e.key==='ArrowLeft')dx-=s; else if(e.key==='ArrowRight')dx+=s; else if(e.key==='ArrowUp')dy-=s; else if(e.key==='ArrowDown')dy+=s;",
  "  else if(e.key===']')scale+=0.002; else if(e.key==='[')scale-=0.002;",
  "  else if(e.key==='g'){var c=document.getElementById('grid');c.checked=!c.checked;gridEl.style.display=c.checked?'block':'none';}",
  "  else if('1234'.indexOf(e.key)>=0){ setMode(['onion','wipe','diff','toggle'][+e.key-1]); }",
  "  else h=false; if(h){e.preventDefault();apply();} });",
  "stage.focus(); apply();",
].join('\n');

/** Build a self-contained overlay HTML comparing a design image and an app screenshot. */
export function buildOverlay({ designPath, appPath, outPath, title }) {
  const d = dims(designPath), a = dims(appPath);
  const displayW = Math.round(a.w / 2); // screenshots are typically @2x; show at CSS px
  const ttl = title || `${path.basename(designPath)} ↔ ${path.basename(appPath)}`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>overlay · ${esc(ttl)}</title>
<style>
  :root{--bg:#0b0e14;--ink:#e6e9ef;--mut:#8b93a7;--line:#222a3a;--accent:#3b82f6}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .bar{position:sticky;top:0;z-index:10;background:rgba(11,14,20,.95);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:10px 14px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
  .bar b{font-weight:700} .mut{color:var(--mut)} code{color:#cbd5e1}
  .seg{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .seg button{background:transparent;color:var(--ink);border:0;padding:6px 11px;cursor:pointer;font-size:12px}
  .seg button.on{background:var(--accent)}
  .ctl{display:flex;gap:6px;align-items:center;font-size:12px} input[type=range]{width:120px}
  kbd{background:#1b2030;border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:11px}
  .readout{font-variant-numeric:tabular-nums;color:var(--mut)}
  .wrap{display:flex;justify-content:center;padding:18px}
  .stage{position:relative;width:${displayW}px;outline:1px solid var(--line)}
  .stage .app{position:relative;width:100%;display:block}
  .stage .design{position:absolute;top:0;left:0;width:100%;display:block;transform-origin:top left}
  .grid{position:absolute;inset:0;pointer-events:none;display:none;background-image:linear-gradient(rgba(59,130,246,.25) 1px,transparent 1px),linear-gradient(90deg,rgba(59,130,246,.25) 1px,transparent 1px);background-size:8px 8px}
  .wipeline{position:absolute;top:0;bottom:0;width:2px;background:var(--accent);display:none;z-index:5;cursor:ew-resize}
  .hint{padding:0 14px 18px;color:var(--mut);font-size:12px}
</style></head><body>
<div class="bar">
  <b>overlay</b>
  <span class="mut">design <code>${esc(path.basename(designPath))}</code> ${d.w}×${d.h} &nbsp;↔&nbsp; app <code>${esc(path.basename(appPath))}</code> ${a.w}×${a.h}</span>
  <div class="seg" id="modes">
    <button data-m="onion" class="on">onion</button><button data-m="wipe">wipe</button><button data-m="diff">difference</button><button data-m="toggle">toggle</button>
  </div>
  <label class="ctl">opacity <input type="range" id="op" min="0" max="100" value="50"></label>
  <label class="ctl"><input type="checkbox" id="grid"> grid 8px</label>
  <span class="readout" id="read">dx 0 · dy 0 · scale 1.000</span>
  <button class="ctl" id="reset" style="background:#1b2030;border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:5px 9px;cursor:pointer">reset</button>
</div>
<div class="wrap"><div class="stage" id="stage" tabindex="0">
  <img class="app" id="app" src="${dataUri(appPath)}" alt="app">
  <img class="design" id="design" src="${dataUri(designPath)}" alt="design">
  <div class="grid" id="gridEl"></div><div class="wipeline" id="wipe"></div>
</div></div>
<div class="hint">정렬: <kbd>←↑↓→</kbd> 1px (<kbd>Shift</kbd> 10px) · <kbd>[</kbd> <kbd>]</kbd> 스케일 · <kbd>g</kbd> 그리드 · <kbd>1–4</kbd> 모드. stage 클릭 후 사용.</div>
<script>
${SCRIPT}
</script>
</body></html>`;
  fs.writeFileSync(outPath, html);
  return { outPath, design: d, app: a, bytes: html.length };
}
