// Geometry for the patch diagram: where each module's panel goes, where each
// jack sits on it, and the curve a cable takes between two of them.
//
// Kept out of the component so it is plain, testable arithmetic. Everything
// here works in one flat coordinate space that becomes the diagram's SVG
// viewBox, so the drawing scales to any width without measuring the DOM.

export const PANEL_HEIGHT = 420;
// Modules in a case stand shoulder to shoulder, screwed to the same rails,
// and rows sit straight on top of each other — so the diagram draws them that
// way. Each panel's own frame is what separates it from its neighbour. Both
// are constants rather than literal zeroes so a diagram that wants air around
// its panels is one number away.
export const PANEL_GAP = 0;
export const ROW_GAP = 0;
// Room above a panel for its name (only reserved when names are drawn — they
// would overlap on panels this close together), and below it for the jacks
// that have no position on the picture.
export const LABEL_HEIGHT = 30;
export const MAX_ROW_WIDTH = 1750;
export const MARGIN = 20;
// A standard rack row. The floor plan measures height in U and width in HP,
// so this is what turns one into the other: PANEL_HEIGHT is how tall 3U is
// drawn, and a 1U tile row is a third of it.
export const ROW_UNIT = 3;

// A module with no panel at all (off-rack gear, or one deleted from the rack)
// is drawn as a plain outline of about this width.
export const FALLBACK_WIDTH = 150;
const MIN_PANEL_WIDTH = 54;
const MAX_PANEL_WIDTH = 720;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isJack = (c) => typeof c?.type === 'string' && c.type.endsWith('_jack');

// Connections that are not patch points and have no business in a picture of
// a patch. An EXPANSION HEADER is the ribbon connector an expander's cable
// plugs into — behind the panel, not on it, and joined by declaring the two
// modules an expander pair rather than by any cable a person patches. A USB
// socket (mini, micro, C — the manuals name it every way there is) is on the
// panel, but it faces a computer or a power supply, never another jack in
// the case, so no cable in a patch ever starts or ends at one. Nor does a
// MEMORY CARD slot: an SD card is a thing you put in it, not a thing you
// patch to.
const HIDDEN_PORT_KINDS = new Set(['ribbon', 'usb', 'memory_card']);
export const isPatchPoint = (component) => !HIDDEN_PORT_KINDS.has(component?.port_kind);

// The visible part of a panel image: a product photo is cropped to the front
// plate, a drawn panel is all panel.
const cropOf = (panel) => ({
  x: panel?.crop?.x ?? 0,
  y: panel?.crop?.y ?? 0,
  w: panel?.crop?.w || 1,
  h: panel?.crop?.h || 1,
});

// Drawing a panel image inside a box that is the module's FOOTPRINT: the
// stored file is the original picture, whitespace and all, and the crop says
// which part of it is the front plate. Blowing the image up by the crop and
// sliding it under an overflow-hidden box shows that part alone — the same
// thing the patch diagram does with its viewBox, for plain <img> markup.
export function panelCropStyle(panel) {
  const crop = cropOf(panel);
  return {
    width: `${100 / crop.w}%`,
    height: `${100 / crop.h}%`,
    left: `${(-crop.x / crop.w) * 100}%`,
    top: `${(-crop.y / crop.h) * 100}%`,
  };
}

// The widths the server renders a panel at (services/panelThumbs.js). A
// stored panel is the file the manufacturer published — several thousand
// pixels across, megabytes of it — and a diagram of a full case draws forty
// of them a few hundred pixels wide, so each is asked for at the size it is
// about to be drawn. The URL still addresses the same immutable bytes, so a
// variant is cached exactly as hard as the original.
export const PANEL_WIDTHS = [128, 256, 512, 1024];

export function panelImageUrl(panel, drawnWidth) {
  const url = panel?.url ?? null;
  // A drawn panel is an SVG: it is already a few kilobytes and scales on its
  // own. So is a width bigger than anything on offer — that wants the file.
  if (!url || url.endsWith('.svg')) return url;
  const bucket = PANEL_WIDTHS.find((width) => width >= drawnWidth);
  return bucket ? `${url}?w=${bucket}` : url;
}

// The same, for a panel drawn as a plain <img> in a box `cssWidth` wide: the
// rack organizer, the system floor plan, the module page's own figure. They
// have no zoom of their own, so the box size is the whole story.
export function panelThumbUrl(panel, cssWidth, density = 1) {
  return panelImageUrl(panel, imageWidthFor(panel, cssWidth) * density);
}

// How wide the WHOLE image is drawn when the visible part of it is
// `drawnWidth` wide: a photograph is cropped to its front plate, and the
// bytes still carry the background the crop hides.
export function imageWidthFor(panel, drawnWidth) {
  return drawnWidth / cropOf(panel).w;
}

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
// on the picture.
//
// A module with a picture simply does not draw them: they used to hang in a
// strip beneath the panel, which is the one thing in the diagram that pushed
// the rows of a case apart — a gap under every module whose photograph was
// read imperfectly. The cables that end at one are counted and reported
// instead. A module with NO picture is the other case: there is no frame for
// them to be outside of, so they are arranged inside its placeholder.
export function spareJacks(pm) {
  const placed = new Set(
    (pm.panel?.components ?? []).map((p) => p.component_id).filter((id) => id !== null)
  );
  return (pm.components ?? []).filter((c) => isJack(c) && isPatchPoint(c) && !placed.has(c.id));
}

// The racks of a studio, each as a block of rows, placed the way the floor
// plan has them — but never on top of one another.
//
// A plan is allowed to hold racks that overlap: the rule only bites on the
// rack being dragged, so a studio arranged before the rule (or grown by
// dropping case after case at the origin) has its furniture piled up. Drawn
// literally that is one panel over another with nothing readable underneath.
// So the plan is read for what it SAYS — which cases stand in a row together,
// in what order, and which stand below them — and a rack that would land on
// its neighbour comes to rest flush beside it instead, which is exactly what
// the floor plan does with a rack dropped onto another.
//
// Racks whose tops are level form a band, in the order they stand left to
// right; each band sits below the deepest rack of the band above it. Gaps a
// plan really has are kept: a rack only moves when it would overlap.
export function floorBlocks(rows, { widthOf = () => 0 } = {}) {
  const blocks = new Map();
  for (const row of rows) {
    const key = `${row.rack_id ?? 'none'}:${Number(row.rack_x) || 0}:${Number(row.rack_y) || 0}`;
    if (!blocks.has(key)) {
      blocks.set(key, {
        key,
        planX: Number(row.rack_x) || 0,
        planY: Number(row.rack_y) || 0,
        width: 0,
        heightU: 0,
        rows: [],
      });
    }
    const block = blocks.get(key);
    // As wide as its widest row is DRAWN. A case is its panels, and the plan's
    // HP is a different measure of the same thing — mixing the two leaves a
    // strip of empty floor beside every rack whose pictures are narrower than
    // its rails.
    block.width = Math.max(block.width, widthOf(row));
    block.heightU += row.unit || ROW_UNIT;
    block.rows.push(row);
  }
  const ordered = [...blocks.values()].sort(
    (a, b) => Math.round(a.planY) - Math.round(b.planY) || a.planX - b.planX
  );
  let bandY = 0;
  let bandTop = null;
  let bandDepth = 0;
  let cursor = 0;
  for (const block of ordered) {
    if (bandTop === null || Math.round(block.planY) !== bandTop) {
      if (bandTop !== null) bandY += bandDepth;
      bandTop = Math.round(block.planY);
      bandDepth = 0;
      cursor = 0;
    }
    block.x = cursor;
    block.y = bandY;
    cursor += block.width;
    bandDepth = Math.max(bandDepth, block.heightU);
  }
  return ordered;
}

// Where each row of a studio goes, as the floor plan has it.
//
// A system is racks standing side by side and one below another — a wall of
// cases with a skiff under the desk — and the patch carries the coordinates
// each rack stood at (x in HP, y in U). So a row is placed at ITS RACK'S
// place on that floor, plus its own place inside the rack, and the picture
// is the room rather than one tall column of rows.
//
// Panels are drawn at the size their pictures want, which is not the same
// scale as the plan's HP: the whole floor is scaled by the tightest row on it
// — the one whose panels need the most room per HP — so no rack's panels ever
// run into the rack beside it, and the gaps of the plan are kept.
function placeFloorRows(rows, { height, labels }) {
  const band = labels ? LABEL_HEIGHT : 0;
  // What one U covers vertically, and how tall a row of `unit` U is drawn.
  const perU = (height + band) / ROW_UNIT;
  const panelHeight = (unit) => ((unit || ROW_UNIT) * height) / ROW_UNIT;

  const widthsOf = (row) =>
    (row.modules ?? []).map((pm) => panelWidth(pm, panelHeight(row.unit)));
  const rowWidth = (row) =>
    widthsOf(row).reduce((sum, width) => sum + width + PANEL_GAP, 0);
  const blocks = floorBlocks(rows, { widthOf: rowWidth });

  const panels = [];
  let index = 0;
  for (const block of blocks) {
    // How far into its own rack a row sits, in U. Counted over EVERY row,
    // including the ones with nothing visible on them, so hiding a row does
    // not slide the rows below it up the case.
    let offset = 0;
    for (const row of block.rows) {
      const top = MARGIN + (block.y + offset) * perU + band;
      offset += row.unit || ROW_UNIT;
      let x = MARGIN + block.x;
      const widths = widthsOf(row);
      (row.modules ?? []).forEach((pm, moduleIndex) => {
        const width = widths[moduleIndex];
        panels.push({
          pm,
          x,
          y: top,
          width,
          height: panelHeight(row.unit),
          labelY: top - 9,
          loose: spareJacks(pm),
          row: index,
        });
        x += width + PANEL_GAP;
      });
      index += 1;
    }
  }
  return panels;
}

// Lay the modules out left to right. Returns the placed panels (in diagram
// coordinates), the anchor point of every jack, and the size of the whole
// drawing.
//
// `rowStarts` are the module indexes a PHYSICAL row begins at, and a physical
// row is never broken in two: a rack row that runs off the side of the screen
// is scrolled to, not folded, or the picture stops being the case in front of
// you. `wrap` is for a diagram with no rack rows behind it, where the only
// row breaks there are to find are the ones that keep the drawing on a page.
// `labels` reserves the band each panel's name is drawn in.
//
// `rows` is the studio as its floor plan has it — each row with the modules
// standing in it and the place its rack stands — and takes over from
// `modules`/`rowStarts` entirely when it is given.
export function layoutDiagram(
  modules,
  {
    height = PANEL_HEIGHT,
    maxRowWidth = MAX_ROW_WIDTH,
    rowStarts = [],
    wrap = true,
    labels = false,
    rows = null,
  } = {}
) {
  const labelBand = labels ? LABEL_HEIGHT : 0;
  const anchors = new Map(); // `${patch_module_id}:${component_id}` -> point
  const panels = rows ? placeFloorRows(rows, { height, labels }) : [];
  if (!rows) {
    let rowStart = 0;
    let x = MARGIN;
    let y = MARGIN;

    const closeRow = () => {
      y += labelBand + height + ROW_GAP;
      x = MARGIN;
      rowStart = panels.length;
    };

    for (const [moduleIndex, pm] of modules.entries()) {
      const width = panelWidth(pm, height);
      if (
        (x > MARGIN && rowStarts.includes(moduleIndex)) ||
        (wrap && x > MARGIN && x + width > maxRowWidth)
      ) {
        closeRow();
      }
      const loose = spareJacks(pm);
      panels.push({
        pm,
        x,
        y: y + labelBand,
        width,
        height,
        labelY: y + labelBand - 9,
        loose,
        row: rowStart,
      });
      x += width + PANEL_GAP;
    }
  }

  const totalHeight =
    panels.length === 0 ? 0 : Math.max(...panels.map((p) => p.y + p.height)) + MARGIN;
  const totalWidth =
    panels.length === 0
      ? 0
      : Math.max(...panels.map((p) => p.x + p.width)) + MARGIN;

  for (const placed of panels) {
    const { pm } = placed;
    // Positions the panel knows about, minus the connectors that are not
    // patch points (an expander's ribbon header is on the circuit board).
    const hidden = new Set(
      (pm.components ?? []).filter((c) => !isPatchPoint(c)).map((c) => c.id)
    );
    for (const placement of pm.panel?.components ?? []) {
      if (placement.component_id === null || placement.component_id === undefined) continue;
      if (hidden.has(placement.component_id)) continue;
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
    // A jack the picture does not place is out of frame: the diagram says so
    // by not drawing it (and by counting the cables it could not draw),
    // rather than by inventing a place for it.
  }

  return { panels, anchors, width: totalWidth, height: totalHeight };
}

// How far a cable hangs below its two ends. Its own function because the
// curve and the BOX the curve lives in have to agree: the diagram draws only
// what is on screen, and a cable is on screen when that box is.
export function cableSag(from, to, index = 0) {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return clamp(Math.hypot(dx, dy) * 0.35, 30, 220) + (index % 3) * 14;
}

// The rectangle a drawn cable occupies. The curve's control points sit `sag`
// below both ends and a cubic never reaches its control points, so this is a
// little generous — which is what it should be for deciding what to draw.
export function cableBounds(from, to, index = 0) {
  const sag = cableSag(from, to, index);
  return {
    x0: Math.min(from.x, to.x),
    x1: Math.max(from.x, to.x),
    y0: Math.min(from.y, to.y),
    y1: Math.max(from.y, to.y) + sag,
  };
}

// A patch cable hangs. Drawn as a cubic curve whose control points sag below
// both ends by an amount that grows with the distance covered, which reads as
// a cable rather than as a wiring-diagram elbow — and keeps two cables between
// the same pair of panels from lying exactly on top of each other.
export function cablePath(from, to, index = 0) {
  const sag = cableSag(from, to, index);
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
