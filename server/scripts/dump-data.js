// Zip the file volumes — manuals, panels, captures — to stdout, for
// ./backup-db.sh --files:
//   docker compose exec -T server node scripts/dump-data.js > files.zip
// Each volume's directory becomes a top-level folder in the archive
// (manuals/<hash>.pdf, panels/..., captures/...), which is what
// scripts/load-data.js expects back. Entries stream out one file at a time,
// so an archive larger than memory still zips; exports are deliberately not
// included (each zip there is a one-shot download, deleted once served).

import fs from 'node:fs';
import path from 'node:path';
import { zipDirectory, zipEntry } from '../src/services/zip.js';

const VOLUMES = [
  ['manuals', process.env.MANUALS_DIR || '/data/manuals'],
  ['panels', process.env.PANELS_DIR || '/data/panels'],
  ['captures', process.env.CAPTURES_DIR || '/data/captures'],
];

// Blocking fd-1 writes: process.stdout.write into a pipe buffers whole files
// ahead of the reader, while writeSync applies backpressure for free.
function writeOut(buf) {
  let written = 0;
  while (written < buf.length) {
    written += fs.writeSync(1, buf, written, buf.length - written);
  }
}

function* walk(dir, prefix) {
  const items = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) yield* walk(file, `${prefix}${item.name}/`);
    else if (item.isFile()) yield { file, name: `${prefix}${item.name}` };
  }
}

let offset = 0;
let files = 0;
const centrals = [];
for (const [top, dir] of VOLUMES) {
  if (!fs.existsSync(dir)) continue;
  for (const { file, name } of walk(dir, `${top}/`)) {
    const entry = zipEntry(name, fs.readFileSync(file), offset, {
      now: fs.statSync(file).mtime,
    });
    for (const chunk of entry.localChunks) writeOut(chunk);
    centrals.push(entry.central);
    offset += entry.size;
    files += 1;
  }
}
writeOut(zipDirectory(centrals, offset));
// Progress goes to stderr — stdout is the archive.
console.error(`zipped ${files} file(s) from ${VOLUMES.map(([top]) => top).join(', ')}`);
