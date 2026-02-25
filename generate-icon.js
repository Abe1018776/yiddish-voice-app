// Generates icon.png — run once with: node generate-icon.js
const zlib = require('zlib');
const fs = require('fs');

const W = 256, H = 256;
const img = Buffer.alloc(W * H * 4, 0); // RGBA, start transparent

function px(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  img[i] = r; img[i+1] = g; img[i+2] = b; img[i+3] = a;
}

// Dark blue rounded-square background
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const R = 52;
    const dx = Math.max(0, R - x, x - (W - 1 - R));
    const dy = Math.max(0, R - y, y - (H - 1 - R));
    if (dx * dx + dy * dy <= R * R) px(x, y, 26, 26, 62);
  }
}

// Rounded rectangle helper
function roundRect(x0, y0, w, h, r, R, G, B) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.max(0, r - (x - x0), (x - x0) - (w - 1 - r));
      const dy = Math.max(0, r - (y - y0), (y - y0) - (h - 1 - r));
      if (dx * dx + dy * dy <= r * r) px(x, y, R, G, B);
    }
  }
}

// Microphone body
roundRect(98, 48, 60, 100, 30, 255, 255, 255);

// Arc (bottom half of ring, representing mic stand curve)
const arcX = 128, arcY = 148, arcR = 52, arcThick = 11;
for (let y = arcY; y <= arcY + arcR + 4; y++) {
  for (let x = arcX - arcR - arcThick; x <= arcX + arcR + arcThick; x++) {
    const d = Math.sqrt((x - arcX) ** 2 + (y - arcY) ** 2);
    if (Math.abs(d - arcR) <= arcThick / 2) px(x, y, 255, 255, 255);
  }
}

// Vertical stand
roundRect(123, 198, 10, 28, 5, 255, 255, 255);

// Base bar
roundRect(88, 224, 80, 10, 5, 255, 255, 255);

// ── Build PNG ──────────────────────────────────────────────────
function crc32(buf) {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : (c >>> 1);
    t[i] = c;
  }
  let c = 0xFFFFFFFF;
  for (const b of buf) c = t[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0;
  img.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}

fs.writeFileSync('icon.png', Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log('icon.png created (256x256)');
