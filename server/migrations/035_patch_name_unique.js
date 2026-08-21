// A patch is referred to by its name — in the patch list, in a question, in
// the file an export writes — so two patches of one account called 'Evening
// drone' are two things a person cannot tell apart. One name per account,
// said here in the schema so no write can forget it.
//
// Per ACCOUNT, not globally: two users may each have an 'Evening drone', and
// a patch shared with somebody is read under its owner rather than added to
// their own names. And per LIVE patch: deleting a patch is a real DELETE
// (patches are not soft-deleted), so the name it held comes free with it.

export const description = 'one patch name per user';

export async function up({ sql, createIndex }) {
  // Accounts that already hold the same name twice keep it on the OLDEST
  // patch; every later namesake becomes '<name> 2', '<name> 3' ... — the same
  // shape a clone or a re-import takes. Read and decided in JS rather than in
  // SQL: the window-function idiom this would otherwise want is beyond
  // pg-mem's parser, and the server tests run every migration.
  const [rows] = await sql`SELECT id, user_id, name FROM patches ORDER BY id`;
  const taken = new Set();
  const key = (userId, name) => `${userId} ${name}`;
  for (const row of rows) {
    const userId = Number(row.user_id);
    const name = String(row.name ?? '');
    if (!taken.has(key(userId, name))) {
      taken.add(key(userId, name));
      continue;
    }
    let n = 2;
    while (taken.has(key(userId, `${name} ${n}`))) n += 1;
    const renamed = `${name} ${n}`;
    taken.add(key(userId, renamed));
    await sql('UPDATE patches SET name = $1 WHERE id = $2', {
      bind: [renamed, Number(row.id)],
    });
  }
  await createIndex('patches_user_name_uniq', 'patches', ['user_id', 'name'], { unique: true });
}

export async function down({ dropIndex }) {
  // The renames the up() made are left standing: they are valid names either
  // way, and there is nothing left to say which patch each one was before.
  await dropIndex('patches_user_name_uniq');
}
