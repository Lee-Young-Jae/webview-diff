// png.mjs — Zero-dependency PNG decode/encode (normalized to RGBA8).
// Uses only node built-ins (node:zlib). Supports 8-bit color types 0/2/3/4/6,
// non-interlaced — which covers every PNG that Playwright / Chrome screenshots emit.
//
// Why hand-rolled instead of pngjs? So the *diff engine* (the part that decides
// pass/fail in CI) has ZERO install surface: it runs on a bare node, in any
// sandbox, with no native addons to break. Reliability starts at the dependency graph.

import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decode a PNG Buffer into { width, height, data } where data is RGBA8 (Buffer, len = w*h*4). */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG (bad signature)');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off); off += 4;
    const type = buf.toString('ascii', off, off + 4); off += 4;
    const data = buf.subarray(off, off + len); off += len;
    off += 4; // crc — not validated on read (we control producers; speed > paranoia here)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8 supported)`);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let pos = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    for (let i = 0; i < stride; i++) {
      const rb = raw[pos + i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = rb; break;
        case 1: v = rb + a; break;
        case 2: v = rb + b; break;
        case 3: v = rb + ((a + b) >> 1); break;
        case 4: v = rb + paeth(a, b, c); break;
        default: throw new Error(`bad PNG filter ${filter} at row ${y}`);
      }
      cur[i] = v & 0xff;
    }
    pos += stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      switch (colorType) {
        case 6: { const s = x * 4; out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3]; break; }
        case 2: { const s = x * 3; out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255; break; }
        case 0: { const g = cur[x]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255; break; }
        case 4: { const s = x * 2; const g = cur[s]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = cur[s + 1]; break; }
        case 3: { const idx = cur[x]; out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2]; out[o + 3] = trns && idx < trns.length ? trns[idx] : 255; break; }
      }
    }
    cur.copy(prev);
  }
  return { width, height, data: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode RGBA8 pixels into a PNG Buffer (color type 6, filter None). */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0; // filter: none
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(filtered, { level: 6 });
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Stroke a rectangle outline onto an RGBA buffer (for highlighting diff clusters). */
export function strokeRect(rgba, imgW, imgH, x, y, w, h, [r, g, b], thickness = 2) {
  const put = (px, py) => { if (px < 0 || py < 0 || px >= imgW || py >= imgH) return; const o = (py * imgW + px) * 4; rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255; };
  for (let t = 0; t < thickness; t++) {
    for (let px = x; px < x + w; px++) { put(px, y + t); put(px, y + h - 1 - t); }
    for (let py = y; py < y + h; py++) { put(x + t, py); put(x + w - 1 - t, py); }
  }
}

/** Allocate a blank RGBA image filled with the given color (default opaque white). */
export function blank(width, height, [r, g, b, a] = [255, 255, 255, 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a; }
  return { width, height, data };
}
