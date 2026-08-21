// A rack's rows are saved by REPLACEMENT: PUT /api/racks/:id/layout deletes
// every row of the rack and writes the ones it was sent, at positions 0..n-1.
// Two of those saves running at once each delete the rows they can see and
// then insert their own — under READ COMMITTED the second delete never sees
// the first insert — and the rack is left holding BOTH sets: every row twice.
// A rack in that state places each of its modules twice as well, which is
// more copies than the rack holds, so the layout route refuses every
// subsequent save and the organizer stops working entirely.
//
// The route now takes the rack itself for the length of the write, so the two
// saves cannot interleave. This says the same thing in the schema, where it
// cannot be forgotten: one row per position per rack. A save that somehow
// still raced would fail loudly on the duplicate rather than quietly doubling
// the layout.

export const description = 'one rack row per position';

export async function up({ sql, createIndex }) {
  // Racks already doubled by that race keep the FIRST of each pair — both
  // copies hold identical placements, so what goes is the second write.
  // Kept to one statement per shape rather than a single self-joined DELETE:
  // the delete-the-later-duplicate idioms (DELETE … USING, NOT IN (SELECT …))
  // are both beyond pg-mem's parser, and the server tests run every migration.
  const [rows] = await sql`SELECT id, rack_id, position FROM rack_rows ORDER BY id`;
  const seen = new Set();
  const duplicates = [];
  for (const row of rows) {
    const key = `${row.rack_id}:${row.position}`;
    if (seen.has(key)) duplicates.push(Number(row.id));
    else seen.add(key);
  }
  // The ids are integers the database just handed over, coerced again here so
  // the list interpolated into the statement cannot be anything else.
  if (duplicates.length) await sql(`DELETE FROM rack_rows WHERE id IN (${duplicates.join(', ')})`);
  await createIndex('rack_rows_rack_position_uniq', 'rack_rows', ['rack_id', 'position'], { unique: true });
}

export async function down({ dropIndex }) {
  // The rows the `up` deleted were duplicates of rows that are still here;
  // dropping the index is the whole of the reversal.
  await dropIndex('rack_rows_rack_position_uniq');
}
