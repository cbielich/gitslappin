// Draws GitSlappin's own mark (a swinging arc between two nodes, with two impact dashes, orange on a dark tile) as PNG-in-ICO at 16, 32, 48 and 256 px.
// Same drawing as client/public/gitslappin.svg. Run: node scripts/make-icon.mjs   (writes assets/gitslappin.ico; only that one file)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'gitslappin.ico');
const SIZES = [16, 32, 48, 256];
const BG = [0x14, 0x16, 0x1a];
const ACCENT = [0xff, 0x9f, 0x43];

// The drawing in a 64 x 64 space (the same numbers as the SVG).
const quad = (p0, p1, p2, n = 12) => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n;
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
});
const PATH = quad([14, 46], [30, 2], [46, 46], 24);
const DASHES = [[[53, 33], [58, 28]], [[55, 43], [61, 43]]];
const NODES = [[14, 46], [46, 46]];
const NODE_R = 7;
const HALF_STROKE = 2.5;
const TILE_R = 12;

function distToSegment(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
const inTile = (x, y) => {
  const cx = Math.min(Math.max(x, TILE_R), 64 - TILE_R);
  const cy = Math.min(Math.max(y, TILE_R), 64 - TILE_R);
  return x >= 0 && y >= 0 && x <= 64 && y <= 64 && Math.hypot(x - cx, y - cy) <= TILE_R;
};
const inMark = (x, y) => {
  if (NODES.some((n) => Math.hypot(x - n[0], y - n[1]) <= NODE_R)) return true;
  for (let i = 0; i + 1 < PATH.length; i++) if (distToSegment(x, y, PATH[i], PATH[i + 1]) <= HALF_STROKE) return true;
  for (const d of DASHES) if (distToSegment(x, y, d[0], d[1]) <= HALF_STROKE) return true;
  return false;
};

/** RGBA pixels, 4 x 4 samples per pixel for smooth edges. */
function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0;
      let mark = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) * 64) / size;
          const y = ((py + (sy + 0.5) / SS) * 64) / size;
          if (!inTile(x, y)) continue;
          tile++;
          if (inMark(x, y)) mark++;
        }
      }
      const o = (py * size + px) * 4;
      const n = SS * SS;
      const m = tile === 0 ? 0 : mark / tile; // share of the covered samples that is the mark
      for (let c = 0; c < 3; c++) buf[o + c] = Math.round(BG[c] * (1 - m) + ACCENT[c] * m);
      buf[o + 3] = Math.round((tile / n) * 255);
    }
  }
  return buf;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
function png(size, rgba) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const images = SIZES.map((s) => png(s, render(s)));
const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2); // type: icon
head.writeUInt16LE(SIZES.length, 4);
let offset = 6 + 16 * SIZES.length;
const dir = SIZES.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([head, ...dir, ...images]));
console.log(`wrote ${OUT} (${offset} bytes)`);
