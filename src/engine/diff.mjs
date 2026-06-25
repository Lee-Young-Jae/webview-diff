// diff.mjs — Perceptual image diff. A faithful port of the pixelmatch algorithm
// (YIQ color-distance + anti-aliasing detection), with additions this project needs:
//   - size-mismatch handling (cross-engine full-page captures differ in height),
//   - ignore-region masks (dynamic content: dates, avatars, ad slots),
//   - a tight bounding box of changed pixels (for the report + triage).
//
// Anti-aliasing detection is the load-bearing reliability feature: Chromium and
// WebKit render text edges with different sub-pixel AA. Counting those as "design
// drift" would drown real differences in noise, so by default AA pixels are
// detected and NOT counted (includeAA:false).

function rgb2y(r, g, b) { return r * 0.29889531 + g * 0.58662247 + b * 0.11448223; }
function rgb2i(r, g, b) { return r * 0.59597799 - g * 0.27417610 - b * 0.32180189; }
function rgb2q(r, g, b) { return r * 0.21147017 - g * 0.52261711 + b * 0.31114694; }

function blend(c, a) { return 255 + (c - 255) * a; }

// Squared YIQ color delta between pixel k of img a and pixel m of img b.
// Returns signed value; sign indicates which is brighter (used for AA detection).
function colorDelta(a, b, k, m, yOnly) {
  let r1 = a[k], g1 = a[k + 1], b1 = a[k + 2], a1 = a[k + 3];
  let r2 = b[m], g2 = b[m + 1], b2 = b[m + 2], a2 = b[m + 3];
  if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;
  if (a1 < 255) { a1 /= 255; r1 = blend(r1, a1); g1 = blend(g1, a1); b1 = blend(b1, a1); }
  if (a2 < 255) { a2 /= 255; r2 = blend(r2, a2); g2 = blend(g2, a2); b2 = blend(b2, a2); }
  const y1 = rgb2y(r1, g1, b1), y2 = rgb2y(r2, g2, b2);
  const y = y1 - y2;
  if (yOnly) return y;
  const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
  const q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
  const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
  return y1 > y2 ? -delta : delta;
}

function grayPixel(img, i, alpha) {
  const r = img[i], g = img[i + 1], b = img[i + 2];
  return blend(rgb2y(r, g, b), alpha * img[i + 3] / 255);
}

function drawGrayPixel(img, i, alpha, out) {
  const val = blend(grayPixel(img, i, 1), alpha);
  out[i] = out[i + 1] = out[i + 2] = val; out[i + 3] = 255;
}

function drawPixel(out, pos, [r, g, b]) { out[pos] = r; out[pos + 1] = g; out[pos + 2] = b; out[pos + 3] = 255; }

// Is pixel (x1,y1) of img likely anti-aliasing rather than a real difference?
// (Has >=3 equal neighbors and a min/max-contrast neighbor that, in the OTHER
// image, sits on a same-position edge.)  Direct port of pixelmatch's antialiased().
function antialiased(img, x1, y1, width, height, img2) {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0);
  const x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 4;
  let zeroes = (x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2) ? 1 : 0;
  let min = 0, max = 0, minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      const delta = colorDelta(img, img, pos, (y * width + x) * 4, true);
      if (delta === 0) { zeroes++; if (zeroes > 2) return false; }
      else if (delta < min) { min = delta; minX = x; minY = y; }
      else if (delta > max) { max = delta; maxX = x; maxY = y; }
    }
  }
  if (min === 0 || max === 0) return false;
  return (hasManySiblings(img, minX, minY, width, height) && hasManySiblings(img2, minX, minY, width, height)) ||
         (hasManySiblings(img, maxX, maxY, width, height) && hasManySiblings(img2, maxX, maxY, width, height));
}

function hasManySiblings(img, x1, y1, width, height) {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0);
  const x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 4;
  let zeroes = (x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2) ? 1 : 0;
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      const pos2 = (y * width + x) * 4;
      if (img[pos] === img[pos2] && img[pos + 1] === img[pos2 + 1] &&
          img[pos + 2] === img[pos2 + 2] && img[pos + 3] === img[pos2 + 3]) {
        zeroes++; if (zeroes > 2) return true;
      }
    }
  }
  return false;
}

const DEFAULTS = {
  threshold: 0.1,      // 0..1 matching sensitivity (pixelmatch). higher = more tolerant per-pixel.
  includeAA: false,    // count anti-aliased pixels as differences?
  matchRadius: 0,      // shift tolerance: a differing pixel is suppressed if a matching pixel
                       // exists within this radius in the other image (collapses cross-engine
                       // glyph-rasterization + sub-pixel reflow noise). 0 = exact (regression).
  alpha: 0.1,          // opacity of the unchanged image drawn under the diff
  diffColor: [255, 49, 49],
  aaColor: [255, 211, 0],
  diffMask: false,     // if true, output transparent except diff pixels
  masks: [],           // [{x,y,w,h}] regions to ignore (in image pixels)
};

// Does pixel (x,y) of `src` find a within-threshold color match anywhere in the
// (2R+1)² neighborhood of `dst`? Used to ignore local shifts / rendering noise.
function nearMatch(srcData, srcStride, dstData, dstStride, x, y, R, maxDelta, boundW, boundH) {
  const ks = (y * srcStride + x) * 4;
  for (let dy = -R; dy <= R; dy++) {
    const yy = y + dy; if (yy < 0 || yy >= boundH) continue;
    for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx; if (xx < 0 || xx >= boundW) continue;
      if (Math.abs(colorDelta(srcData, dstData, ks, (yy * dstStride + xx) * 4, false)) <= maxDelta) return true;
    }
  }
  return false;
}

/**
 * Diff two RGBA images. Returns metrics + an RGBA diff overlay (Buffer).
 * Handles size mismatch by diffing the overlap and charging the non-overlap area as differing.
 */
export function diffImages(imgA, imgB, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const sizeMismatch = imgA.width !== imgB.width || imgA.height !== imgB.height;
  const width = Math.max(imgA.width, imgB.width);
  const height = Math.max(imgA.height, imgB.height);
  const ovW = Math.min(imgA.width, imgB.width);
  const ovH = Math.min(imgA.height, imgB.height);

  const out = Buffer.alloc(width * height * 4);
  // background: faint version of A (or transparent in mask mode)
  if (!o.diffMask) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (x < imgA.width && y < imgA.height) drawGrayPixel(imgA.data, (y * imgA.width + x) * 4, o.alpha, out);
      else { out[p] = out[p + 1] = out[p + 2] = 255; out[p + 3] = 255; }
    }
  }

  const maskAt = buildMaskLookup(o.masks, width, height);
  const maxDelta = 35215 * o.threshold * o.threshold;
  let diffPixels = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  // boolean map of REAL differences (shift/AA-suppressed pixels excluded) — fed to
  // connected-component analysis so we can tell a concentrated change (one dense
  // cluster = likely real) from diffuse edge scatter (many tiny clusters = noise).
  const diffMask = new Uint8Array(width * height);

  // pixels that exist in only one image (the size-mismatch band) count as diff
  let mismatchPixels = 0;
  if (sizeMismatch) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (x < ovW && y < ovH) continue;
      if (maskAt && maskAt[y * width + x]) continue;
      const p = (y * width + x) * 4;
      drawPixel(out, p, o.diffColor);
      diffMask[y * width + x] = 1;
      mismatchPixels++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }

  for (let y = 0; y < ovH; y++) {
    for (let x = 0; x < ovW; x++) {
      const ka = (y * imgA.width + x) * 4;
      const kb = (y * imgB.width + x) * 4;
      const pOut = (y * width + x) * 4;
      if (maskAt && maskAt[y * width + x]) continue;
      const delta = colorDelta(imgA.data, imgB.data, ka, kb, false);
      if (Math.abs(delta) > maxDelta) {
        const isAA = !o.includeAA &&
          (antialiased(imgA.data, x, y, ovW, ovH, imgB.data) ||
           antialiased(imgB.data, x, y, ovW, ovH, imgA.data));
        const isShift = !isAA && o.matchRadius > 0 &&
          nearMatch(imgA.data, imgA.width, imgB.data, imgB.width, x, y, o.matchRadius, maxDelta, ovW, ovH) &&
          nearMatch(imgB.data, imgB.width, imgA.data, imgA.width, x, y, o.matchRadius, maxDelta, ovW, ovH);
        if (isAA || isShift) {
          if (!o.diffMask) drawPixel(out, pOut, o.aaColor);
        } else {
          drawPixel(out, pOut, o.diffColor);
          diffMask[y * width + x] = 1;
          diffPixels++;
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
  }

  const totalConsidered = width * height - (maskAt ? maskAt.count : 0);
  const changed = diffPixels + mismatchPixels;
  const bbox = maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  const clusters = changed ? connectedComponents(diffMask, width, height) : [];
  return {
    width, height,
    diffPixels: changed,
    totalPixels: totalConsidered,
    diffRatio: totalConsidered ? changed / totalConsidered : 0,
    sizeMismatch,
    dims: { a: { w: imgA.width, h: imgA.height }, b: { w: imgB.width, h: imgB.height } },
    bbox,
    clusters,
    largestCluster: clusters[0] || null,
    clusterCount: clusters.length,
    data: out,
  };
}

// 8-connected component labeling over the real-diff mask (iterative BFS).
// Returns clusters sorted by area desc: { area, x, y, w, h, density }.
// density = area / bboxArea, the key signal: ~1.0 = solid block (real region change),
// low = thin/scattered (edge AA, decorative lines).
function connectedComponents(mask, width, height, maxClusters = 64) {
  const visited = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const clusters = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || visited[i]) continue;
    let sp = 0; stack[sp++] = i; visited[i] = 1;
    let area = 0, minX = width, minY = height, maxX = -1, maxY = -1;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width, y = (idx / width) | 0;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= width) continue;
          const nidx = ny * width + nx;
          if (mask[nidx] && !visited[nidx]) { visited[nidx] = 1; stack[sp++] = nidx; }
        }
      }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    clusters.push({ area, x: minX, y: minY, w, h, density: area / (w * h) });
  }
  clusters.sort((a, b) => b.area - a.area);
  return clusters.slice(0, maxClusters);
}

function buildMaskLookup(masks, width, height) {
  if (!masks || masks.length === 0) return null;
  const lut = new Uint8Array(width * height);
  let count = 0;
  for (const m of masks) {
    const x0 = Math.max(0, m.x | 0), y0 = Math.max(0, m.y | 0);
    const x1 = Math.min(width, (m.x + m.w) | 0), y1 = Math.min(height, (m.y + m.h) | 0);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const idx = y * width + x;
      if (!lut[idx]) { lut[idx] = 1; count++; }
    }
  }
  lut.count = count;
  return lut;
}
