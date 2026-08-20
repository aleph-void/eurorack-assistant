# Migrations

The schema lives here, one file per change, applied in file name order. These
files are the source of truth — `sequelize.sync()` is never used, and
`src/db/models.js` describes what the migrations have already built.

## Writing one

Name the file `<next number>_<slug>.js` and export `up`, `down` and a one-line
`description`:

```js
// Why this change exists — the prose that would have been a comment at the top
// of the SQL file. Worth writing: it is the only record of what the schema was
// missing.

export const description = 'panels whose file has already been trimmed';

export async function up({ addColumn }) {
  await addColumn('module_panels', 'trimmed', 'BOOLEAN NOT NULL DEFAULT FALSE');
}

export async function down({ dropColumn }) {
  await dropColumn('module_panels', 'trimmed');
}
```

Both hooks are called with the context built in `src/db/migrationContext.js`:

| helper | what it runs |
| --- | --- |
| ``sql`...` `` | the statements as written; a template may hold several |
| `sql(text, { bind })` | the same, with bind parameters |
| `addColumn(table, column, definition)` | `ALTER TABLE … ADD COLUMN …` |
| `dropColumn(table, ...columns)` | `ALTER TABLE … DROP COLUMN IF EXISTS …` |
| `createIndex(name, table, columns, { unique })` | `CREATE INDEX …` |
| `dropIndex(...names)` | `DROP INDEX IF EXISTS …` |
| `dropTable(...names)` | `DROP TABLE IF EXISTS … CASCADE`, in the order given |
| `comment(target, text)` | `COMMENT ON <target> IS …`, `null` to remove it |

Structure goes in a `sql` template — a `CREATE TABLE` reads better as the SQL it
is, and its column comments are part of the schema. One-line DDL (a column, an
index, a comment) uses the verbs, which is what makes a `down` a list of what it
undoes rather than a second dialect to proofread.

## Rules

- **Every migration has a working `down`.** The runner refuses to load one that
  does not export it. `down` undoes what `up` did, in reverse order: dropping a
  table takes its indexes and the data backfilled into it with it, so a
  migration that only added a table needs only `dropTable`. Where a change
  cannot be undone exactly (a data-only migration whose previous values are not
  recorded), reverse what it set and say in a comment what the reversal cannot
  know — see `025_manual_in_scope_by_default.js`.
- **Never edit a migration that has been applied.** Each one is recorded in
  `schema_migrations` with a checksum of its `up` source, and the server
  refuses to start if that source has changed — the database it already ran on
  cannot be brought up to date by editing the file. Add a new migration
  instead. (Editing a `down` is fine: it is deliberately not part of the
  checksum, so an unfilled `down` can always be filled in later.)
- **Each migration runs in a transaction.** PostgreSQL rolls DDL back like
  anything else, so a migration that throws half-way leaves nothing behind. The
  in-memory database the tests use (pg-mem) does not — see the test gotchas in
  `CLAUDE.md`.

## Running them

The server applies anything pending at startup, and `./setup.sh` does the same.
By hand, from `server/`:

```sh
npm run migrate            # apply everything pending
npm run migrate:status     # what has run, what has not
npm run migrate:down       # revert the last migration
node scripts/migrate.js down 3
node scripts/migrate.js down --to 020_indexes
```
