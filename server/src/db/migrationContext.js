// The object every migration's up()/down() is called with: a way to run SQL,
// plus the handful of one-line schema verbs that make a down() readable.
//
// The division of labour is deliberate. Structure (CREATE TABLE, backfills,
// anything with a shape worth reading) is written as SQL in a `sql` template,
// because SQL is what the schema is really written in and a DSL only hides it.
// The reversals — drop this column, drop that index, drop those tables — are
// one-liners with no shape to hide, so they get verbs: a down() built from
// them says what it undoes at a glance and cannot mistype a DDL keyword.
//
// Drops are all IF EXISTS: a down() may be re-run after a partial rollback
// (PostgreSQL rolls a failed migration back, but an operator who ran half of
// one by hand should still be able to finish it).

// Migration identifiers are written by us, never by users, but a typo that
// silently produces `DROP TABLE undefined` is worth catching here.
const IDENTIFIER = /^[a-z_][a-z0-9_$]*$/i;

function identifier(value, what) {
  const text = String(value ?? '');
  if (!IDENTIFIER.test(text)) throw new Error(`Invalid ${what} in migration: ${JSON.stringify(value)}`);
  return text;
}

// A SQL string literal, for the one place a migration passes text to the
// database as part of a statement rather than as a bind parameter (COMMENT ON
// takes no parameters).
function literal(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

export function createMigrationContext(sequelize, transaction) {
  const run = (text, options = {}) => sequelize.query(text, { transaction, ...options });

  // Usable both as a tagged template (sql`CREATE TABLE ...`) and as a plain
  // call (sql('CREATE TABLE ...', { bind: [...] })). A template may hold as
  // many statements as it likes: postgres runs a multi-statement simple query
  // in one go, which is what keeps a migration's SQL in one readable block.
  const sql = (text, ...rest) => {
    if (Array.isArray(text) && Array.isArray(text.raw)) {
      return run(text.reduce((acc, part, i) => acc + part + (i < rest.length ? String(rest[i]) : ''), ''));
    }
    return run(String(text), rest[0] ?? {});
  };

  const addColumn = (table, column, definition) =>
    run(`ALTER TABLE ${identifier(table, 'table')} ADD COLUMN ${identifier(column, 'column')} ${definition}`);

  const dropColumn = async (table, ...columns) => {
    for (const column of columns) {
      await run(
        `ALTER TABLE ${identifier(table, 'table')} DROP COLUMN IF EXISTS ${identifier(column, 'column')}`
      );
    }
  };

  const createIndex = (name, table, columns, { unique = false } = {}) =>
    run(
      `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${identifier(name, 'index')} ` +
        `ON ${identifier(table, 'table')} (${[]
          .concat(columns)
          .map((c) => identifier(c, 'column'))
          .join(', ')})`
    );

  const dropIndex = async (...names) => {
    for (const name of names) await run(`DROP INDEX IF EXISTS ${identifier(name, 'index')}`);
  };

  // Dropped in the order given: a down() lists its tables children-first, so
  // nothing depends on a table by the time it goes. CASCADE takes the foreign
  // keys other tables point at it with (never those tables themselves).
  const dropTable = async (...names) => {
    for (const name of names) await run(`DROP TABLE IF EXISTS ${identifier(name, 'table')} CASCADE`);
  };

  // COMMENT ON <target> IS <text>, or IS NULL to take a comment off again.
  const comment = async (target, text) => {
    const statement = `COMMENT ON ${target} IS ${text == null ? 'NULL' : literal(text)}`;
    try {
      await run(statement);
    } catch (e) {
      // pg-mem (the in-memory database the tests run against) parses
      // `COMMENT ON ... IS '<text>'` and rejects `IS NULL`. A comment is
      // documentation: losing it in a test database costs nothing, and the
      // same statement is correct against real postgres.
      if (text != null) throw e;
    }
  };

  return { sql, addColumn, dropColumn, createIndex, dropIndex, dropTable, comment };
}
