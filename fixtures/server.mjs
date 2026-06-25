// server.mjs — Minimal static server for the fixture pages (no deps).
// Stands in for the future apps/fe-web so the detector can be exercised end-to-end.
// The detector points at ANY URL, so swapping this for the real Next.js dev server
// is just a config change (designdiff.config.json -> baseUrl).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, 'pages');
const PORT = process.env.PORT || 4321;

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  if (!path.extname(url)) url += '.html'; // /drift -> /drift.html
  const file = path.join(ROOT, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => console.log(`fixture server on http://localhost:${PORT}`));
