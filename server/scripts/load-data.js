// Restore the file volumes — manuals, panels, captures — from a zip made by
// scripts/dump-data.js, read on stdin, for ./restore-db.sh --files:
//   docker compose run --rm --no-deps -T server node scripts/load-data.js < files.zip
// Entries land under the volume directory their top-level folder names;
// anything outside those folders is skipped, and a path that would escape
// its volume aborts the run. Existing files are overwritten; files the
// archive does not name are left alone — the stores are content-addressed,
// so an extra file is merely unreferenced, never wrong.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const VOLUMES = new Map([
  ['manuals', process.env.MANUALS_DIR || '/data/manuals'],
  ['panels', process.env.PANELS_DIR || '/data/panels'],
  ['captures', process.env.CAPTURES_DIR || '/data/captures'],
]);

// The end-of-central-directory record sits in the file's last 22 bytes plus
// up to a 64KB archive comment.
function endOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('not a zip file (no end-of-central-directory record)');
}

// Where an entry belongs on disk, or null for entries that are not a volume
// file (directory placeholders, foreign top-level folders).
function targetPath(name) {
  if (!name || name.endsWith('/')) return null;
  const [top, ...rest] = name.split('/');
  const root = VOLUMES.get(top);
  if (!root || rest.length === 0) return null;
  const target = path.join(root, ...rest);
  if (!path.resolve(target).startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`unsafe path in archive: ${name}`);
  }
  return target;
}

const buf = fs.readFileSync(0); // all of stdin
const eocd = endOfCentralDirectory(buf);
const count = buf.readUInt16LE(eocd + 10);
let p = buf.readUInt32LE(eocd + 16);

let written = 0;
let skipped = 0;
for (let n = 0; n < count; n += 1) {
  if (buf.readUInt32LE(p) !== 0x02014b50) {
    throw new Error('corrupt zip: bad central directory record');
  }
  const method = buf.readUInt16LE(p + 10);
  const compressedSize = buf.readUInt32LE(p + 20);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const localOffset = buf.readUInt32LE(p + 42);
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  p += 46 + nameLen + extraLen + commentLen;

  const target = targetPath(name);
  if (!target) {
    skipped += 1;
    continue;
  }
  // The local header's own name/extra lengths govern where the data starts —
  // other zip writers pad them differently than the central copy.
  const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
  const raw = buf.subarray(dataStart, dataStart + compressedSize);
  let data;
  if (method === 0) data = raw;
  else if (method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`unsupported compression method ${method} for ${name}`);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  written += 1;
}

console.error(`restored ${written} file(s)${skipped ? `, skipped ${skipped} non-volume entr${skipped === 1 ? 'y' : 'ies'}` : ''}`);
