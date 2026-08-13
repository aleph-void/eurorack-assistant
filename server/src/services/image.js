// Raster images retrieved from the web (front-panel photos), handled the same
// way manuals are: sniffed from their own bytes rather than trusted from a URL
// or a Content-Type, content-addressed on disk, and never re-encoded.
//
// Only the four formats every browser renders are accepted, and remote SVG is
// deliberately NOT among them: an SVG is a document that can carry script, and
// nothing about a manufacturer's product page makes it worth hosting one of
// those under our own origin. The SVGs this app serves are the ones it draws
// itself (services/panelImage.js).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME_DESKTOP_HEADERS, USER_AGENT } from './pdf.js';

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

// Files this module will store, and the Content-Type each is served with.
export const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

// Panels below this are thumbnails or spacer GIFs, not front-plate images: a
// eurorack panel is 128.5mm tall, so anything usefully readable is at least a
// few hundred pixels on its long side.
export const MIN_PANEL_PIXELS = 120;

export function panelPath(panelsDir, hash, ext) {
  return path.join(panelsDir, `${hash}.${ext}`);
}

const startsWith = (buffer, bytes) =>
  buffer.length >= bytes.length && buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));

function pngSize(buffer) {
  // 8-byte signature, then the IHDR chunk's length + type, then w/h.
  if (buffer.length < 24) return null;
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gifSize(buffer) {
  if (buffer.length < 10) return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

// Walk the JPEG marker segments to the start-of-frame, which is the only
// place the real dimensions are written.
function jpegSize(buffer) {
  let pos = 2;
  while (pos + 9 < buffer.length) {
    if (buffer[pos] !== 0xff) {
      pos += 1;
      continue;
    }
    const marker = buffer[pos + 1];
    // Padding (a run of 0xFF) and the standalone markers carry no length.
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const length = buffer.readUInt16BE(pos + 2);
    // SOF0..SOF15, minus the three that are not frame headers (DHT, JPG, DAC).
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return { height: buffer.readUInt16BE(pos + 5), width: buffer.readUInt16BE(pos + 7) };
    }
    if (length < 2) return null;
    pos += 2 + length;
  }
  return null;
}

function webpSize(buffer) {
  if (buffer.length < 30) return null;
  const chunk = buffer.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
    };
  }
  return null;
}

// The format and pixel size of an image, read out of the bytes themselves.
// Returns null for anything that is not one of the four supported formats or
// whose header does not parse.
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  let ext = null;
  let size = null;
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    ext = 'png';
    size = pngSize(buffer);
  } else if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    ext = 'jpg';
    size = jpegSize(buffer);
  } else if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) {
    ext = 'gif';
    size = gifSize(buffer);
  } else if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    ext = 'webp';
    size = webpSize(buffer);
  }
  if (!ext || !size || !size.width || !size.height) return null;
  return { ext, width: size.width, height: size.height };
}

// Writes the bytes under their own hash if they are not already there, and
// returns the hash. Written to a temporary name first so a crash mid-write
// cannot leave a truncated file sitting under the hash of the whole thing.
export function saveImage(panelsDir, buffer, ext) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const target = panelPath(panelsDir, hash, ext);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(panelsDir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  }
  return hash;
}

// Fetch one candidate image and accept it only if its own bytes say it is a
// large enough image in a format we serve. Retries once with fuller browser
// headers, like downloadPdf: manufacturer sites behind Cloudflare refuse the
// plain user agent.
export async function downloadImage(url, { fetchImpl = fetch, log = () => {} } = {}) {
  const origin = url.match(/^https?:\/\/[^/]+/);
  const retryHeaders = { ...CHROME_DESKTOP_HEADERS };
  if (origin) retryHeaders.Referer = `${origin[0]}/`;
  const attempts = [
    [{ 'User-Agent': USER_AGENT }, null],
    [retryHeaders, 'retrying with Chrome desktop headers'],
  ];

  for (const [headers, note] of attempts) {
    if (note) log(`${note}: ${url}`);
    let buffer;
    try {
      const res = await fetchImpl(url, { headers, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      log(`image download failed: ${url}: ${e.message}`);
      continue;
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      log(`${url} is larger than the ${MAX_IMAGE_BYTES} byte limit`);
      return null;
    }
    const info = sniffImage(buffer);
    if (!info) {
      log(`${url} is not a PNG, JPEG, GIF or WebP image`);
      continue;
    }
    if (Math.max(info.width, info.height) < MIN_PANEL_PIXELS) {
      log(`${url} is only ${info.width}x${info.height}; too small to be a panel image`);
      continue;
    }
    return { ...info, buffer, url };
  }
  return null;
}
