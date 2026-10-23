// Renders the zapfleet brand rasters (icon, ICO, social preview, avatar).
// No dependencies. Geometry mirrors design/logo.svg on a 128-unit grid.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
const SS = 4; // supersampling grid per axis for anti-aliasing

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const DECK_TOP = hex('#16160f');
const DECK_BOTTOM = hex('#0c0c0a');
const INK = hex('#0c0c0a');
const LIME = hex('#c6f432');
const ORANGE = hex('#ff4d00');
const CREAM = hex('#e8e4da');

// Stroke-width 6 round-capped lanes: distance <= 3 is covered.
const LANES = [
  [22, 44, 50, 44],
  [18, 64, 54, 64],
  [22, 84, 46, 84],
];
// Bolt polygon; fill LIME with a 4-wide INK stroke (distance <= 2 to edge).
const BOLT = [
  [74, 18], [46, 70], [66, 70], [56, 110], [86, 54], [66, 54], [78, 18],
];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function distToSegment(x, y, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(ax + t * vx - x, ay + t * vy - y);
}

function distToPolygonEdges(x, y, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    d = Math.min(d, distToSegment(x, y, ax, ay, bx, by));
  }
  return d;
}

// Even-odd ray casting.
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Logo color at logo-space (u, v) in 0..128 units; alpha 0 outside the tile.
function logoSample(u, v) {
  if (!inRoundRect(u, v, 0, 0, 128, 128, 28)) return [0, 0, 0, 0];

  let c = mix(DECK_TOP, DECK_BOTTOM, v / 128);
  // Faint inner border (stroke band of 2 units inside the tile edge).
  if (!inRoundRect(u, v, 2, 2, 126, 126, 26)) c = mix(c, [255, 255, 255], 0.06);

  for (const [x1, y1, x2, y2] of LANES) {
    if (distToSegment(u, v, x1, y1, x2, y2) <= 3) return [...ORANGE, 1];
  }
  if (distToPolygonEdges(u, v, BOLT) <= 2) return [...INK, 1];
  if (inPolygon(u, v, BOLT)) return [...LIME, 1];
  return [...c, 1];
}

// Supersamples sample(x, y) over a w x h pixel grid into straight-alpha RGBA.
function rasterize(w, h, sample) {
  const out = new Uint8ClampedArray(w * h * 4);
  const n = SS * SS;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const i = (py * w + px) * 4;
      if (a > 0) {
        out[i] = r / a;
        out[i + 1] = g / a;
        out[i + 2] = b / a;
      }
      out[i + 3] = (a / n) * 255;
    }
  }
  return out;
}

const renderLogo = (size) =>
  rasterize(size, size, (x, y) => logoSample((x * 128) / size, (y * 128) / size));

// 1280x640 social card: logo on the left, three lane bars on the right.
const SOCIAL_LOGO_K = 3.2;
const SOCIAL_LOGO_X = 140;
const SOCIAL_LOGO_Y = 115;
const BARS = [
  [230, 520, ORANGE],
  [320, 440, LIME],
  [410, 360, CREAM],
];

function socialSample(x, y) {
  const logo = logoSample(
    (x - SOCIAL_LOGO_X) / SOCIAL_LOGO_K,
    (y - SOCIAL_LOGO_Y) / SOCIAL_LOGO_K,
  );
  if (logo[3]) return logo;
  for (const [yc, len, col] of BARS) {
    if (inRoundRect(x, y, 640, yc - 14, 640 + len, yc + 14, 14)) return [...col, 1];
  }
  return [...mix(DECK_TOP, DECK_BOTTOM, y / 640), 1];
}

// PNG encoder: RGBA, 8-bit, filter 0 on every scanline.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO container with PNG-compressed entries (sizes >= 256 stored as 0).
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

function write(name, buf) {
  const path = join(BUILD, name);
  writeFileSync(path, buf);
  console.log(`wrote ${path} (${buf.length} bytes)`);
}

mkdirSync(BUILD, { recursive: true });

const logo512 = renderLogo(512);
write('icon.png', encodePng(logo512, 512, 512));
write('zapbot-avatar.png', encodePng(logo512, 512, 512));
write(
  'icon.ico',
  encodeIco(
    [256, 128, 64, 48, 32, 16].map((size) => ({
      size,
      png: encodePng(renderLogo(size), size, size),
    })),
  ),
);
write('social-preview.png', encodePng(rasterize(1280, 640, socialSample), 1280, 640));
