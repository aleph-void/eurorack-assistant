// A physical rack is organized into horizontal rows.  A row is either the
// normal 3U height or a 1U utility row, and has its own HP capacity.  Each
// row placement is one physical copy of a module; rack_modules remains the
// inventory/quantity record.

export const description = 'rack rows and the placements in them';

export async function up({ sql }) {
  await sql`
CREATE TABLE rack_rows (
  id SERIAL PRIMARY KEY,
  rack_id INTEGER NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
  unit INTEGER NOT NULL DEFAULT 3,
  hp REAL NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rack_rows_rack_idx ON rack_rows (rack_id, position);

CREATE TABLE rack_row_modules (
  id SERIAL PRIMARY KEY,
  row_id INTEGER NOT NULL REFERENCES rack_rows(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rack_row_modules_row_idx ON rack_row_modules (row_id, position);
`;
}

export async function down({ dropTable }) {
  await dropTable('rack_row_modules', 'rack_rows');
}
