// How a clip's channels are drawn: as panes, or overlaid on one grid.
//
// A scope draws several channels either way — one strip each, or every trace
// superimposed on a single graticule, which is how you see that the envelope
// really does open where the gate goes high. The device has both modes; the
// recording asked for one of them and the file that came back shows it, so
// the mode belongs on the row: a clip listing its panes as 'Pane 1, Pane 2'
// is a lie about a video with one grid and two coloured traces on it.
//
// 'panes' is what every clip recorded before this was, which is why it is the
// default rather than NULL — there is nothing unknown about them.

export const description = 'clips record whether their channels are overlaid';

export async function up({ addColumn }) {
  await addColumn(
    'scope_clips',
    'display_mode',
    "TEXT NOT NULL DEFAULT 'panes'"
  );
}

export async function down({ dropColumn }) {
  await dropColumn('scope_clips', 'display_mode');
}
