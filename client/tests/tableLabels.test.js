// Below the narrow-screen width a table row is drawn as a card, one line per
// column, with the column's own name in front of the value — and that name
// comes from the cell's `data-label` (see the stacked table block in
// style.css). A column added without one loses its heading on every phone,
// which is invisible on a desk and obvious on a train, so the rule is checked
// here rather than left to be noticed.
//
// The exceptions are the cells that speak for themselves: one under a heading
// that has no text (the tick that picks a row, the bar of buttons that acts
// on it) and one that spans the row.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function vueFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return vueFiles(full);
    return entry.name.endsWith('.vue') ? [full] : [];
  });
}

const headings = (table) =>
  [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  );

// Every body cell of every table, paired with the heading above it.
function unlabelledCells(file) {
  const source = fs.readFileSync(file, 'utf8');
  const missing = [];
  for (const [table] of source.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const ths = headings(table);
    if (ths.length === 0) continue;
    const body = table.slice(table.indexOf('</thead>') + 1);
    for (const row of body.split(/<tr[^>]*>/).slice(1)) {
      let column = -1;
      for (const [cell] of row.matchAll(/<td(?=[\s>])[^>]*/g)) {
        column += 1;
        const heading = ths[column] ?? '';
        if (!heading || heading.includes('{{') || cell.includes('colspan')) continue;
        if (!cell.includes('data-label')) {
          missing.push(`${path.basename(file)}: "${heading}" column`);
        }
      }
    }
  }
  return missing;
}

describe('table cells carry their column name', () => {
  it('every column with a heading labels its cells', () => {
    const missing = vueFiles(SRC).flatMap(unlabelledCells);
    expect(missing).toEqual([]);
  });

  // The check is only worth anything if it is looking at the tables at all.
  it('finds the tables it is checking', () => {
    const labelled = vueFiles(SRC).filter((file) =>
      fs.readFileSync(file, 'utf8').includes('data-label')
    );
    expect(labelled.length).toBeGreaterThan(20);
  });
});
