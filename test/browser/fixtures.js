'use strict';
/* 產生 06-photo.js 需要的測試素材（純 Node，不進執行期相依、不放二進位檔進 repo）
 * 用法：node test/browser/fixtures.js  */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const T = (() => { const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const ch = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([l, td, c]); };

const W = 640, H = 480, raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0;
  for (let x = 0; x < W; x++) { const i = y * (W * 4 + 1) + 1 + x * 4;
    raw[i] = 200 - ((x * y) % 60); raw[i + 1] = 150; raw[i + 2] = 90; raw[i + 3] = 255; } }
const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 6;

fs.writeFileSync(path.join(__dirname, 'meal.png'), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih),
  ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]));
fs.writeFileSync(path.join(__dirname, 'notimage.txt'), 'this is not an image');
console.log('fixtures 產生完成：meal.png / notimage.txt');
