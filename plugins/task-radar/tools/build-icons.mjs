// Original Task Radar release artwork. No third-party images or fonts.
// One geometry model drives both the SVG source and deterministic PNG output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const size = 256;
const background = '#142b38';
const rings = [80, 48, 16];
const stroke = '#81d8bc';
const beam = '#315c60';
const point = '#f1bd6a';
const triangle = [[128, 128], [184, 72], [204, 110]];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="Task Radar">
  <rect width="256" height="256" rx="40" fill="${background}"/>
  <path d="M128 128L184 72L204 110Z" fill="${beam}"/>
${rings.map((r) => `  <circle cx="128" cy="128" r="${r}" fill="none" stroke="${stroke}" stroke-width="5"/>`).join('\n')}
  <path d="M128 128L184 72" fill="none" stroke="${stroke}" stroke-width="5" stroke-linecap="round"/>
  <circle cx="184" cy="72" r="10" fill="${point}"/>
</svg>
`;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function inTriangle(x, y) {
  const sign = (a, b) => (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1]);
  const v = [sign(triangle[0], triangle[1]), sign(triangle[1], triangle[2]), sign(triangle[2], triangle[0])];
  return !(v.some((n) => n < 0) && v.some((n) => n > 0));
}
function lineDistance(x, y) {
  const dx = 56, dy = -56;
  const t = Math.max(0, Math.min(1, ((x - 128) * dx + (y - 128) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - 128 - t * dx, y - 128 - t * dy);
}
function colorAt(x, y) {
  const cx = Math.max(40, Math.min(216, x)), cy = Math.max(40, Math.min(216, y));
  if (Math.hypot(x - cx, y - cy) > 40) return [0, 0, 0, 0];
  let color = background;
  if (inTriangle(x, y)) color = beam;
  if (rings.some((r) => Math.abs(Math.hypot(x - 128, y - 128) - r) <= 2.5) || lineDistance(x, y) <= 2.5) color = stroke;
  if (Math.hypot(x - 184, y - 72) <= 10) color = point;
  return [...rgb(color), 255];
}
const raw = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const samples = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([dx, dy]) => colorAt(x + dx, y + dy));
    const alpha = samples.reduce((sum, s) => sum + s[3], 0);
    const pos = y * (size * 4 + 1) + 1 + x * 4;
    for (let channel = 0; channel < 3; channel++) raw[pos + channel] = alpha ? Math.round(samples.reduce((sum, s) => sum + s[channel] * s[3], 0) / alpha) : 0;
    raw[pos + 3] = Math.round(alpha / 4);
  }
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, content) {
  const tag = Buffer.from(type), body = Buffer.concat([tag, content]);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(content.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, {level: 9})), chunk('IEND', Buffer.alloc(0))]);
const checking = process.argv.includes('--check');
for (const [name, bytes] of [['icon.svg', Buffer.from(svg)], ['assets/icon.png', png]]) {
  const file = path.join(root, name);
  if (checking) {
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) throw new Error(name + ' is stale; run node tools/build-icons.mjs');
    console.log('verified ' + name + ': ' + bytes.length + ' bytes');
  } else {
    fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes);
    console.log('generated ' + name + ': ' + bytes.length + ' bytes');
  }
}
