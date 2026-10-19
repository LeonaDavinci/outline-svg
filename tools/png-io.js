/* =============================================================
 * png-io.js  —  零依赖 PNG 编解码（仅 8bit，非隔行）
 * 解码：IHDR / PLTE / tRNS / IDAT，5 种行过滤器
 * 编码：RGBA8，带 alpha
 * ============================================================= */
'use strict';
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ---------------- 解码 ---------------- */
function decodePNG(buf) {
  if (!buf.slice(0, 8).equals(SIG)) throw new Error('不是 PNG 文件');
  let off = 8, ihdr = null, idat = [], palette = null, trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0), h: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12]
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('缺少 IHDR');
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) throw new Error('只支持 8bit 非隔行 PNG');

  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
  const stride = ihdr.w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(ihdr.h * stride);

  let p = 0;
  const paeth = (a, b, c) => {
    const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc) ? b : c;
  };
  for (let y = 0; y < ihdr.h; y++) {
    const ft = raw[p++];
    const line = raw.slice(p, p + stride); p += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) v = (v + paeth(a, b, c)) & 255;
      cur[i] = v;
    }
  }

  const { w, h, color } = ihdr;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r, g, b, a = 255;
    if (color === 6) { r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]; }
    else if (color === 2) { r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]; }
    else if (color === 0) { r = g = b = out[i]; }
    else if (color === 4) { r = g = b = out[i * 2]; a = out[i * 2 + 1]; }
    else if (color === 3) {
      const k = out[i];
      r = palette[k * 3]; g = palette[k * 3 + 1]; b = palette[k * 3 + 2];
      if (trns && k < trns.length) a = trns[k];
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width: w, height: h, data: rgba };
}

/** 合成到白底（画布里做二值化需要不透明白底） */
function flattenOnWhite(img) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    const lum = data[i * 4] * a + 255 * (1 - a);
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = lum;
    out[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/** 前景包围盒（灰度 < limit 视为前景） */
function contentBox(img, limit) {
  const { width: w, height: h, data } = img;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4] < limit) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* ---------------- 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** @param rgba Uint8ClampedArray RGBA8 */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 把多张 PNG 打包成 ICO（Vista+ 支持内嵌 PNG） */
function encodeICO(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  const dir = [];
  images.forEach((im) => {
    const e = Buffer.alloc(16);
    e[0] = im.size >= 256 ? 0 : im.size;
    e[1] = im.size >= 256 ? 0 : im.size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(im.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += im.png.length;
    dir.push(e);
  });
  return Buffer.concat([header, ...dir, ...images.map((im) => im.png)]);
}

module.exports = { decodePNG, encodePNG, encodeICO, flattenOnWhite, contentBox };