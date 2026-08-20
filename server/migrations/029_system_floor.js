// How big the system's floor plan is, in the same units the rack coordinates
// are in: HP across and rack units down. A studio that stands in one long
// row needs a plan far wider than the default, and the plan cannot be
// dragged into space that is not there — so the size is the user's to set.
// The defaults are the extent the plan used to assume.

export const description = 'how much floor a system has to arrange on';

export async function up({ addColumn }) {
  await addColumn('systems', 'floor_width', 'REAL NOT NULL DEFAULT 140');
  await addColumn('systems', 'floor_height', 'REAL NOT NULL DEFAULT 9');
}

export async function down({ dropColumn }) {
  await dropColumn('systems', 'floor_width', 'floor_height');
}
