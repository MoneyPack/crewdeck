// Generates build/icon.png (512x512 RGBA) with no dependencies.
// Design: dark rounded tile with three stacked "terminal" cards (the crew deck).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');

const px = new Uint8ClampedArray(SIZE * SIZE * 4);

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Supersampled coverage (4x4) for smooth edges.
function coverage(x, y, shape) {
  let hit = 0;
  for (let sy = 0; sy < 4; sy++)
    for (let sx = 0; sx < 4; sx++) if (shape(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hit++;
  return hit / 16;
}

function blend(x, y, [r, g, b], a) {
  if (a <= 0) return;
  const i = (y * SIZE + x) * 4;
  const da = px[i + 3] / 255;
  const oa = a + da * (1 - a);
  px[i] = (r * a + px[i] * da * (1 - a)) / oa;
  px[i + 1] = (g * a + px[i + 1] * da * (1 - a)) / oa;
  px[i + 2] = (b * a + px[i + 2] * da * (1 - a)) / oa;
  px[i + 3] = oa * 255;
}

function fill(shape, color, bbox = [0, 0, SIZE, SIZE]) {
  const [bx0, by0, bx1, by1] = bbox.map((v) => Math.max(0, Math.min(SIZE, Math.round(v))));
  for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) blend(x, y, color, coverage(x, y, shape));
}

function rr(x0, y0, x1, y1, r, color) {
  fill((x, y) => inRoundRect(x, y, x0, y0, x1, y1, r), color, [x0 - 1, y0 - 1, x1 + 1, y1 + 1]);
}

// Background tile with vertical gradient.
const bg = (x, y) => inRoundRect(x, y, 16, 16, SIZE - 16, SIZE - 16, 96);
for (let y = 0; y < SIZE; y++) {
  const t = y / SIZE;
  const c = [Math.round(24 + 10 * t), Math.round(28 + 8 * t), Math.round(44 + 16 * t)];
  for (let x = 0; x < SIZE; x++) blend(x, y, c, coverage(x, y, bg));
}

// Three stacked terminal cards (back to front), one accent per agent.
const cards = [
  { dx: 56, dy: -56, accent: [217, 119, 87] }, // Claude-ish orange
  { dx: 28, dy: -28, accent: [66, 165, 245] }, // Gemini-ish blue
  { dx: 0, dy: 0, accent: [102, 187, 106] }, // Codex-ish green
];
const W = 280;
const H = 220;
const baseX = 88;
const baseY = 196;
for (const { dx, dy, accent } of cards) {
  const x0 = baseX + dx;
  const y0 = baseY + dy;
  rr(x0 - 6, y0 - 6, x0 + W + 6, y0 + H + 6, 30, [16, 18, 28]); // outline/shadow
  rr(x0, y0, x0 + W, y0 + H, 24, [36, 40, 58]); // body
  rr(x0, y0, x0 + W, y0 + 44, 24, accent); // title bar
  rr(x0, y0 + 24, x0 + W, y0 + 44, 0, accent);
}

// Prompt glyph on the front card: ">" chevron and a cursor bar.
const fx = baseX;
const fy = baseY + 44;
const chevron = (x, y) => {
  const cx = fx + 52;
  const cy = fy + 88;
  const dxp = x - cx;
  const dyp = Math.abs(y - cy);
  return dxp >= 0 && dxp <= 44 && Math.abs(dxp - (44 - dyp)) <= 11 && dyp <= 44;
};
fill(chevron, [230, 236, 245], [fx + 40, fy + 36, fx + 110, fy + 140]);
rr(fx + 124, fy + 110, fx + 204, fy + 130, 6, [230, 236, 245]);

// --- PNG encoding ---
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(data, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) Buffer.from(data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 2x box downsample (premultiplied) for the 256px ICO entry.
function downsample(src, size) {
  const h = size / 2;
  const dst = new Uint8ClampedArray(h * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < h; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (const [ox, oy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const i = ((2 * y + oy) * size + 2 * x + ox) * 4;
        const al = src[i + 3];
        r += src[i] * al;
        g += src[i + 1] * al;
        b += src[i + 2] * al;
        a += al;
      }
      const o = (y * h + x) * 4;
      if (a) {
        dst[o] = r / a;
        dst[o + 1] = g / a;
        dst[o + 2] = b / a;
      }
      dst[o + 3] = a / 4;
    }
  return dst;
}

// ICO with a single PNG-compressed 256x256 entry (supported since Windows Vista).
// Emitted directly so electron-builder skips its own png->ico conversion.
function encodeIco(png256) {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  header[6] = 0; // width 256
  header[7] = 0; // height 256
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bpp
  header.writeUInt32LE(png256.length, 14);
  header.writeUInt32LE(22, 18); // offset
  return Buffer.concat([header, png256]);
}

const png = encodePng(px, SIZE);
const ico = encodeIco(encodePng(downsample(px, SIZE), SIZE / 2));
const icoOut = out.replace(/\.png$/, '.ico');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
writeFileSync(icoOut, ico);
console.log(`wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
console.log(`wrote ${icoOut} (256x256, ${ico.length} bytes)`);
