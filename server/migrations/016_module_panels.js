// What a module LOOKS like, and where each analyzed component sits on it.
//
// The analysis turns a manual into a list of jacks and controls, which is
// enough to trace signal but not enough to recognise the module in front of
// you. A panel gives the component list a picture to hang on: the front plate
// image, plus a position for every jack and control on it, so a patch can be
// drawn as the modules and the cables between them rather than as a table of
// names.
//
// Two kinds of panel, in preference order (see services/panelImage.js):
//   source 'image'     — a real front-panel photo or render found on the
//                        manufacturer's product page (or ModularGrid), with
//                        the component positions located on it by the LLM.
//   source 'generated' — no usable image was found, so the LLM derives the
//                        panel LAYOUT from the manual (how wide the module is
//                        in HP, and where each component sits) and the server
//                        draws it as an SVG. A logical stand-in, not a
//                        likeness — but positioned from the same manual, so
//                        the diagram still reads as the module.
//
// Files are content-addressed exactly like manuals and captures: the sha256 of
// the bytes, stored at PANELS_DIR/<hash>.<ext>.

export const description = 'module panels and where each component sits on them';

export async function up({ sql }) {
  await sql`
ALTER TABLE modules ADD COLUMN panel_status TEXT NOT NULL DEFAULT 'pending';

CREATE TABLE module_panels (
  id SERIAL PRIMARY KEY,
  -- One panel per module; a rebuild replaces the row.
  module_id INTEGER NOT NULL UNIQUE REFERENCES modules(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'generated',
  -- Where the image came from, for attribution and for a "this is the wrong
  -- picture" report.
  source_url TEXT,
  image_hash TEXT NOT NULL,
  image_ext TEXT NOT NULL DEFAULT 'svg',
  -- Intrinsic size of the file in pixels (SVG viewBox units for generated
  -- panels), so the client can lay panels out at the right aspect ratio
  -- without waiting for the image to load.
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  -- The front plate's bounding box within the image, as fractions of the
  -- whole: a product photo usually has background around the module, and the
  -- diagram wants the panel alone. 0,0,1,1 means "the image is the panel".
  crop_x REAL NOT NULL DEFAULT 0,
  crop_y REAL NOT NULL DEFAULT 0,
  crop_w REAL NOT NULL DEFAULT 1,
  crop_h REAL NOT NULL DEFAULT 1,
  -- Panel width in HP where the manual or the research states it.
  hp REAL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX module_panels_hash_idx ON module_panels (image_hash);

-- Where one component sits on the panel. x/y/w/h are fractions of the WHOLE
-- image (not of the crop), so the same numbers survive a change of crop and
-- can be compared against the image on its own.
--
-- component_id is a hard reference: re-analyzing a module destroys and
-- recreates its components, and a position pointing at a component that no
-- longer exists is worse than no position at all. The panel job re-runs after
-- every analysis, which is what puts them back.
CREATE TABLE module_panel_components (
  id SERIAL PRIMARY KEY,
  panel_id INTEGER NOT NULL REFERENCES module_panels(id) ON DELETE CASCADE,
  component_id INTEGER REFERENCES module_components(id) ON DELETE CASCADE,
  -- The component's name as the panel drawing labels it, kept denormalized so
  -- a marker still says what it is once its component row is gone.
  name TEXT NOT NULL,
  -- How the marker is drawn: jack, knob, slider, button, toggle, switch,
  -- display, other.
  shape TEXT NOT NULL DEFAULT 'other',
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL DEFAULT 0,
  h REAL NOT NULL DEFAULT 0
);

CREATE INDEX module_panel_components_panel_idx ON module_panel_components (panel_id);
CREATE INDEX module_panel_components_component_idx ON module_panel_components (component_id);
`;
}

export async function down({ dropColumn, dropTable }) {
  await dropTable('module_panel_components', 'module_panels');
  await dropColumn('modules', 'panel_status');
}
