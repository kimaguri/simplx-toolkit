// Generates neutral placeholder icons for the extension (no Gitea branding).
// Draws a rounded square background with a simple branch/dashboard glyph
// (three nodes connected by lines, evoking a git-branch / dashboard motif)
// directly as PNG bytes using only Node built-ins (zlib for deflate).
//
// Usage: node scripts/gen-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SIZES = [16, 32, 48, 128];
const OUT_DIR = path.join(process.cwd(), 'public', 'icon');

// Colors (neutral slate/blue, not Gitea's teal/green)
const BG = [0x33, 0x41, 0x55]; // slate-700
const BG2 = [0x1e, 0x29, 0x3b]; // darker corner shading
const FG = [0xe2, 0xe8, 0xf0]; // near-white glyph
const ACCENT = [0x60, 0xa5, 0xfa]; // blue-400 accent dot

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size) {
  // RGBA pixel buffer
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };

  const radius = Math.round(size * 0.2);
  const inRoundedSquare = (x, y) => {
    const minD = 0;
    const maxD = size - 1;
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    if (x >= radius && x <= size - 1 - radius) return true;
    if (y >= radius && y <= size - 1 - radius) return true;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  // Background with subtle diagonal shading
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRoundedSquare(x, y)) continue;
      const t = (x + y) / (2 * size);
      const r = Math.round(BG[0] + (BG2[0] - BG[0]) * t);
      const g = Math.round(BG[1] + (BG2[1] - BG[1]) * t);
      const b = Math.round(BG[2] + (BG2[2] - BG[2]) * t);
      set(x, y, [r, g, b]);
    }
  }

  // Glyph: three nodes (branch/dashboard motif) connected by lines.
  // Node positions in unit space [0,1] x [0,1]
  const nodes = [
    [0.30, 0.28],
    [0.30, 0.72],
    [0.72, 0.50],
  ];
  const toPx = ([nx, ny]) => [Math.round(nx * size), Math.round(ny * size)];
  const [p0, p1, p2] = nodes.map(toPx);

  const drawLine = (a, b, color, thickness) => {
    const steps = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) * 2 + 1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      for (let dx = -thickness; dx <= thickness; dx++) {
        for (let dy = -thickness; dy <= thickness; dy++) {
          if (dx * dx + dy * dy <= thickness * thickness) {
            set(Math.round(x + dx), Math.round(y + dy), color);
          }
        }
      }
    }
  };

  const lineThickness = Math.max(1, Math.round(size * 0.035));
  drawLine(p0, p2, FG, lineThickness);
  drawLine(p1, p2, FG, lineThickness);

  const drawDisc = (center, r, color) => {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (dx * dx + dy * dy <= r * r) {
          set(center[0] + dx, center[1] + dy, color);
        }
      }
    }
  };

  const nodeRadius = Math.max(2, Math.round(size * 0.09));
  drawDisc(p0, nodeRadius, FG);
  drawDisc(p1, nodeRadius, FG);
  drawDisc(p2, Math.round(nodeRadius * 1.15), ACCENT);

  // Build PNG
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const srcI = (y * size + x) * 4;
      const dstI = y * (1 + size * 4) + 1 + x * 4;
      raw[dstI] = px[srcI];
      raw[dstI + 1] = px[srcI + 1];
      raw[dstI + 2] = px[srcI + 2];
      raw[dstI + 3] = px[srcI + 3];
    }
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = makePng(size);
  const outPath = path.join(OUT_DIR, `${size}.png`);
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}
