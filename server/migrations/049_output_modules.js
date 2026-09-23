// An output is a MODULE, with the jacks of it in use as an optional list.
//
// Migrations 047 and 048 recorded where sound leaves a rack and a system one
// row per JACK. But the thing a person marks is the output module — the
// Outs, the mixer, the interface's input panel — and which of its jacks are
// in use is a detail they may add or may not know yet. So:
//
//   * rack_outputs and system_outputs become one row per MODULE, and the
//     jacks each had move to rack_output_jacks / system_output_jacks under
//     it — none at all is a real answer, the module as a whole;
//   * a patch_outputs row may name no jack (component_id and component_name
//     both NULL) — the whole instance is the exit.
//
// The old per-jack column on each owner table is RETIRED rather than dropped:
// always NULL from here on, and in no model. Dropping it is what postgres
// would do, but the test database keeps a dropped column's foreign key and
// goes on cascading deletes of module_components into a column that is gone
// — and names no constraint that could be dropped first.

export const description = 'outputs are modules, with their jacks optional and under them';

// The two owner tables, folded the same way.
const OWNERS = [
  {
    table: 'rack_outputs',
    jacks: 'rack_output_jacks',
    keys: ['rack_id', 'module_id'],
    unique: 'rack_outputs_unique',
  },
  {
    table: 'system_outputs',
    jacks: 'system_output_jacks',
    keys: ['system_id', 'rack_id', 'module_id'],
    unique: 'system_outputs_unique',
  },
];

export async function up({ sql, createIndex, dropIndex }) {
  for (const { table, jacks, keys, unique } of OWNERS) {
    const on = keys.map((k) => `keep.${k} = o.${k}`).join(' AND ');
    await sql`
CREATE TABLE ${jacks} (
  id SERIAL PRIMARY KEY,
  output_id INTEGER NOT NULL REFERENCES ${table}(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES module_components(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0
);

-- Every jack moves under the first row its module had...
INSERT INTO ${jacks} (output_id, component_id, position)
SELECT keep.id, o.component_id, o.position
FROM ${table} o
JOIN (SELECT MIN(id) AS id, ${keys.join(', ')} FROM ${table} GROUP BY ${keys.join(', ')}) keep
  ON ${on};

-- ...and the other rows of that module go: each row is a module now.
DELETE FROM ${table} WHERE id NOT IN (SELECT output_id FROM ${jacks});

ALTER TABLE ${table} ALTER COLUMN component_id DROP NOT NULL;
UPDATE ${table} SET component_id = NULL;
`;
    await dropIndex(unique);
    await createIndex(unique, table, keys, { unique: true });
    await createIndex(`${jacks}_unique`, jacks, ['output_id', 'component_id'], { unique: true });
  }
  await sql`ALTER TABLE patch_outputs ALTER COLUMN component_name DROP NOT NULL;`;
}

// Back to one row per jack. 047 and 048 have no way to say "the module as a
// whole", so an output with no jacks goes, as does a patch exit naming none.
export async function down({ sql, createIndex, dropIndex, dropTable }) {
  await sql`DELETE FROM patch_outputs WHERE component_name IS NULL;`;
  await sql`ALTER TABLE patch_outputs ALTER COLUMN component_name SET NOT NULL;`;

  for (const { table, jacks, keys, unique } of OWNERS) {
    await dropIndex(unique);
    const outputs = await sql(`SELECT id, ${keys.join(', ')}, position FROM ${table} ORDER BY id`, {
      type: 'SELECT',
    });
    const marked = await sql(
      `SELECT output_id, component_id, position FROM ${jacks} ORDER BY output_id, position, id`,
      { type: 'SELECT' }
    );
    for (const output of outputs) {
      const mine = marked.filter((j) => j.output_id === output.id);
      if (mine.length === 0) {
        await sql(`DELETE FROM ${table} WHERE id = $1`, { bind: [output.id] });
        continue;
      }
      await sql(`UPDATE ${table} SET component_id = $1, position = $2 WHERE id = $3`, {
        bind: [mine[0].component_id, mine[0].position, output.id],
      });
      const columns = [...keys, 'component_id', 'position'];
      for (const jack of mine.slice(1)) {
        await sql(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
          { bind: [...keys.map((k) => output[k]), jack.component_id, jack.position] }
        );
      }
    }
    await dropTable(jacks);
    await sql`ALTER TABLE ${table} ALTER COLUMN component_id SET NOT NULL;`;
    await createIndex(unique, table, [...keys, 'component_id'], { unique: true });
  }
}
