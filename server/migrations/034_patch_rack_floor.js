// Where each rack STOOD, not just which order it came in.
//
// A system's racks are arranged on a floor plan — a wall of cases side by
// side, a skiff below the desk — and that plan is the picture of the studio.
// The patch snapshot recorded only a reading ORDER (`rack_position`), so a
// patch drawn from a system stacked every rack's rows in one tall column: the
// right rows in the right sequence, and nothing like the room they stand in.
//
// These are the floor coordinates of the rack the row belongs to, in the
// plan's own units — x in HP, y in rack units — frozen into the patch the way
// everything else about a snapshot is, so a patch keeps drawing the studio as
// it stood even after the furniture is pushed around.
//
// Patches made before this default to (0, 0), which is the old picture: every
// rack at the same place, rows stacked in order. `POST /api/patches/:id/
// rack-layout/resync` is how one catches up.

export const description = 'where each rack stood on the system floor plan';

export async function up({ addColumn }) {
  await addColumn('patch_rack_rows', 'rack_x', 'REAL NOT NULL DEFAULT 0');
  await addColumn('patch_rack_rows', 'rack_y', 'REAL NOT NULL DEFAULT 0');
}

export async function down({ dropColumn }) {
  await dropColumn('patch_rack_rows', 'rack_x', 'rack_y');
}
