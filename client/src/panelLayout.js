// Geometry for the patch diagram: where each module's panel goes, where each
// jack sits on it, and the curve a cable takes between two of them.
//
// Kept out of the component so it is plain, testable arithmetic. Everything
// here works in one flat coordinate space that becomes the diagram's SVG
// viewBox, so the drawing scales to any width without measuring the DOM.

export const PANEL_HEIGHT = 420;
export const PANEL_GAP = 26;
export const ROW_GAP = 120;
// Room above a panel for its name, and below it for the jacks that have no
// position on the picture.
export const LABEL_HEIGHT = 30;
export const SPARE_ROW_HEIGHT = 26;
export const SPARE_COLUMNS = 2;
export const MAX_ROW_WIDTH = 1750;
export const MARGIN = 20;

// A module with no panel at all (off-rack gear, or one deleted from the rack)
// is drawn as a plain outline of about this width.
export const FALLBACK_WIDTH = 150;
const MIN_PANEL_WIDTH = 54;
const MAX_PANEL_WIDTH = 720;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isJack = (c) => typeof c?.type === 'string' && c.type.endsWith('_jack');

// The visible part of a panel image: a product photo is cropped to the front
// plate, a drawn panel is all panel.
const cropOf = (panel) => ({
  x: panel?.crop?.x ?? 0,
  y: panel?.crop?.y ?? 0,
  w: panel?.crop?.w || 1,
  h: panel?.crop?.h || 1,
});

// How wide the panel is drawn, at the diagram's fixed panel height.
export function panelWidth(pm, height = PANEL_HEIGHT) {
  const panel = pm?.panel;
  if (!panel?.width || !panel?.height) return FALLBACK_WIDTH;
  const crop = cropOf(panel);
  const ratio = (panel.width * crop.w) / (panel.height * crop.h);
  if (!Number.isFinite(ratio) || ratio <= 0) return FALLBACK_WIDTH;
  return clamp(Math.round(height * ratio), MIN_PANEL_WIDTH, MAX_PANEL_WIDTH);
}

// Where a placement sits within the drawn panel, as a fraction of it: the
// stored position is relative to the whole image, the drawing shows the crop.
export function placementFraction(panel, placement) {
  const crop = cropOf(panel);
  return {
    fx: (placement.x - crop.x) / crop.w,
    fy: (placement.y - crop.y) / crop.h,
  };
}

// Jacks the panel does not place. On a photograph the LLM only marks what it
// could actually see, and a jack it missed must NOT be given an invented spot
// on the picture — it goes in a strip under the panel instead, where a cable
// can still reach it and nothing claims to know where it really is.
export function spareJacks(pm) {
  const placed = new Set(
    (pm.panel?.components ?? []).map((p) => p.component_id).filter((id) => id !== null)
  );
  return (pm.components ?? []).filter((c) => isJack(c) && !placed.has(c.id));
}

const spareHeight = (count) =>
  count === 0 ? 0 : Math.ceil(count / SPARE_COLUMNS) * SPARE_ROW_HEIGHT + 6;

// Lay the modules out left to right, wrapping into rows. Returns the placed
// panels (in diagram coordinates), the anchor point of every jack, and the
// size of the whole drawing.
export function layoutDiagram(modules, { height = PANEL_HEIGHT, maxRowWidth = MAX_ROW_WIDTH } = {}) {
  const panels = [];
  const anchors = new Map(); // `${patch_module_id}:${component_id}` -> point
  let rowStart = 0;
  let x = MARGIN;
  let y = MARGIN;
  let rowSpare = 0;

  const closeRow = () => {
    // Every panel in a row shares the row's height, so the row below clears
    // the longest spare strip in it.
    y += LABEL_HEIGHT + height + rowSpare + ROW_GAP;
    x = MARGIN;
    rowStart = panels.length;
    rowSpare = 0;
  };

  for (const pm of modules) {
    const width = panelWidth(pm, height);
    if (x > MARGIN && x + width > maxRowWidth) closeRow();
    // Jacks with no place on the panel go in a strip under it — but a module
    // with no panel at all has no picture to be off, so its jacks are drawn
    // inside its placeholder and cost the row no extra height.
    const loose = spareJacks(pm);
    const spare = pm.panel ? loose : [];
    rowSpare = Math.max(rowSpare, spareHeight(spare.length));
    panels.push({
      pm,
      x,
      y: y + LABEL_HEIGHT,
      width,
      height,
      labelY: y + LABEL_HEIGHT - 9,
      spare,
      loose,
      row: rowStart,
    });
    x += width + PANEL_GAP;
  }

  const totalHeight = panels.length === 0 ? 0 : y + LABEL_HEIGHT + height + rowSpare + MARGIN;
  const totalWidth =
    panels.length === 0
      ? 0
      : Math.max(...panels.map((p) => p.x + p.width)) + MARGIN;

  for (const placed of panels) {
    const { pm } = placed;
    // Positions the panel knows about.
    for (const placement of pm.panel?.components ?? []) {
      if (placement.component_id === null || placement.component_id === undefined) continue;
      const { fx, fy } = placementFraction(pm.panel, placement);
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) continue;
      anchors.set(`${pm.id}:${placement.component_id}`, {
        x: placed.x + clamp(fx, 0, 1) * placed.width,
        y: placed.y + clamp(fy, 0, 1) * placed.height,
        name: placement.name,
        shape: placement.shape,
        on_panel: true,
      });
    }
    // A module with no panel image gets its jacks arranged inside its
    // placeholder, so the diagram still shows what plugs into what.
    if (!pm.panel) {
      const jacks = placed.loose;
      const columns = jacks.length > 8 ? 2 : 1;
      const rows = Math.max(1, Math.ceil(jacks.length / columns));
      jacks.forEach((jack, i) => {
        anchors.set(`${pm.id}:${jack.id}`, {
          x: placed.x + ((Math.floor(i % columns) + 0.5) / columns) * placed.width,
          y: placed.y + 30 + ((Math.floor(i / columns) + 0.5) / rows) * (placed.height - 50),
          name: jack.name,
          shape: 'jack',
          on_panel: false,
        });
      });
      continue;
    }
    // Jacks the panel could not place go under it.
    placed.spare.forEach((jack, i) => {
      anchors.set(`${pm.id}:${jack.id}`, {
        x: placed.x + ((Math.floor(i % SPARE_COLUMNS) + 0.5) / SPARE_COLUMNS) * placed.width,
        y: placed.y + placed.height + 10 + Math.floor(i / SPARE_COLUMNS) * SPARE_ROW_HEIGHT,
        name: jack.name,
        shape: 'jack',
        on_panel: false,
      });
    });
  }

  return { panels, anchors, width: totalWidth, height: totalHeight };
}

// A patch cable hangs. Drawn as a cubic curve whose control points sag below
// both ends by an amount that grows with the distance covered, which reads as
// a cable rather than as a wiring-diagram elbow — and keeps two cables between
// the same pair of panels from lying exactly on top of each other.
export function cablePath(from, to, index = 0) {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const sag = clamp(Math.hypot(dx, dy) * 0.35, 30, 220) + (index % 3) * 14;
  return (
    `M ${round(from.x)} ${round(from.y)} ` +
    `C ${round(from.x)} ${round(from.y + sag)} ` +
    `${round(to.x)} ${round(to.y + sag)} ` +
    `${round(to.x)} ${round(to.y)}`
  );
}

const round = (n) => Math.round(n * 10) / 10;

// Distinct cable colours, in the order patch cables get handed out. Chosen to
// stay apart from each other and readable on the dark panel background.
export const CABLE_COLORS = [
  '#f87171',
  '#facc15',
  '#4ade80',
  '#38bdf8',
  '#a78bfa',
  '#fb923c',
  '#f472b6',
  '#2dd4bf',
];

export const cableColor = (index) => CABLE_COLORS[index % CABLE_COLORS.length];

// The instances a patch actually uses: anything a cable touches. A patch is a
// snapshot of the WHOLE rack, so drawing every module in it would bury the
// four that are patched under the thirty that are not.
export function usedModules(modules, cables) {
  const used = new Set();
  for (const cable of cables ?? []) {
    used.add(cable.from_patch_module_id);
    used.add(cable.to_patch_module_id);
  }
  return modules.filter((pm) => used.has(pm.id));
}
