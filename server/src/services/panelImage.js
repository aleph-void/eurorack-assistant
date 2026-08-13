// The module's front plate, and where its analyzed components sit on it.
//
// The analysis (services/manualAnalyzer.js) turns a manual into a list of
// jacks and controls. That is enough to trace signal, but a patch is a
// physical thing: what you actually do with it is look at the panels and plug
// cables between holes. This service gives the component list a picture to
// hang on, in the order a person would try:
//
//   0. Use the picture the user uploaded, if there is one: a panel someone
//      deliberately supplied outranks anything research can turn up, so it is
//      kept and only re-located on (routes/modules.js POST /:id/panel).
//   1. Research the web for the module's real front-panel image on the
//      manufacturer's own product page (or a retailer's), download it, and ask
//      the LLM to locate every analyzed component on it. What the model says
//      is then measured against the pixels and corrected — see
//      services/panelPixels.js, which is where the accuracy actually comes
//      from.
//   2. Failing that, look the module up on ModularGrid, which is not a source
//      but does have a straight-on panel shot of very nearly everything.
//   3. Failing that — no image found, or none of the components could be
//      located on it — ask the LLM to read the module's LAYOUT out of the
//      manual (how many HP wide, and where each control and jack sits) and
//      draw that layout here as an SVG. A logical stand-in rather than a
//      likeness, but positioned from the same manual, so the diagram still
//      reads as the module.
//   4. Failing even that (no manual, or an answer with nothing usable in it),
//      lay the components out in columns by type, so every jack still has a
//      place a cable can be drawn to.
//
// Positions are stored as fractions of the image, so the client can render
// them at any size (see migration 016).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractJsonObject } from './json.js';
import { downloadImage, panelPath, saveImage } from './image.js';
import { HP_MM, PANEL_MM_HEIGHT, PX_PER_MM, DEFAULT_HP } from './panelGeometry.js';
import {
  growBox,
  panelCrop,
  pointInBox,
  readPixels,
  snapPlacements,
  writeCrop,
} from './panelPixels.js';

// How a marker is drawn. Derived from the component's analyzed type, or
// stated by the LLM when it places something the analysis did not list.
export const PANEL_SHAPES = [
  'jack',
  'knob',
  'slider',
  'button',
  'toggle',
  'switch',
  'display',
  'other',
];

const SHAPE_FOR_TYPE = {
  input_jack: 'jack',
  output_jack: 'jack',
  bidirectional_jack: 'jack',
  knob: 'knob',
  slider: 'slider',
  button: 'button',
  toggle: 'toggle',
  switch: 'switch',
  display: 'display',
};

export const shapeForComponent = (component) => SHAPE_FOR_TYPE[component?.type] || 'other';

export { HP_MM, PANEL_MM_HEIGHT, PX_PER_MM, DEFAULT_HP } from './panelGeometry.js';
const MIN_HP = 2;
const MAX_HP = 84;

// A component list this long stops fitting a single narrow column, so an
// unstated width is guessed from it rather than left at DEFAULT_HP.
const HP_PER_COMPONENT = 1.2;

export const PANEL_RESEARCH_TEMPLATE = (manufacturer, name) =>
  `You are researching the eurorack modular synthesizer module: "${manufacturer} ${name}"

Task: find a picture of this module's FRONT PANEL — the flat face of the
module as it appears in a rack, photographed or rendered straight on.

1. Search the manufacturer's official product page for this module, then
   retailers who sell it. Use the maker's own page in preference to anyone
   else's, and do not use rack-planning sites such as ModularGrid.
2. Collect direct links to the image FILES (URLs ending in .jpg, .jpeg, .png
   or .webp), not the pages holding them.
3. Also note how wide the module is in HP, if the page states it.

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{"image_urls": ["https://..."], "page_url": "https://...", "hp": 8}

Rules:
- "image_urls": up to 4 candidate direct image URLs, best first. Prefer a
  straight-on shot of the panel alone, on a plain background, at the largest
  resolution offered. Avoid photographs of the module in a rack among others,
  angled "hero" shots, rear/PCB shots, and lifestyle photos. Use [] if you
  cannot find a usable image.
- "page_url": the page the image was found on, or null.
- "hp": the panel width in HP as a number, or null if it is not stated.
`;

// Asked only when the search above came back with nothing usable. ModularGrid
// is a rack planner rather than a source: its pages are user-maintained, and
// the picture on one is whoever's photograph of whatever they had. But every
// module in it is shown the same way — one panel, straight on, cropped to the
// plate — which is exactly the shape this needs, and a real picture of the
// right module beats the drawing we would otherwise fall back to.
export const PANEL_MODULARGRID_TEMPLATE = (manufacturer, name) =>
  `You are looking for a picture of the front panel of the eurorack modular
synthesizer module "${manufacturer} ${name}". The manufacturer's own site and
the retailers did not have one.

Task: find this module's page on ModularGrid (modulargrid.net) and collect the
direct URL of the panel image shown on it.

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{"image_urls": ["https://..."], "page_url": "https://...", "hp": 8}

Rules:
- "image_urls": up to 4 direct image FILE URLs (ending .jpg, .jpeg, .png or
  .webp), best first. ModularGrid serves these from its own image host; give
  the largest version offered. Use [] if you cannot find the module's page or
  it has no picture.
- Make sure the page really is THIS module by THIS manufacturer. ModularGrid
  holds many modules with the same short name, and a picture of the wrong one
  is worse than no picture at all.
- "page_url": the ModularGrid page for the module, or null.
- "hp": the panel width in HP as a number, or null if the page does not say.
`;

const componentList = (components) =>
  components.map((c) => `- ${c.name} (${c.type})`).join('\n');

export const PANEL_MAP_TEMPLATE = (manufacturer, name, components, { cropped = false } = {}) =>
  `You are looking at a photograph of the front panel of the eurorack module
"${manufacturer} ${name}". Locate each of its components on the image.

These are the components the manual describes:

${componentList(components)}

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{
  "is_panel": true,${cropped ? '' : '\n  "panel": { "x": 0.12, "y": 0.02, "w": 0.5, "h": 0.96 },'}
  "components": [
    { "name": "1V/OCT", "x": 0.312, "y": 0.824, "w": 0.14, "h": 0.05 }
  ]
}

Rules:
- ALL coordinates are fractions of the WHOLE image, with 0,0 at the top left
  and 1,1 at the bottom right. "x"/"y" are the CENTRE of the thing, "w"/"h"
  its size. Give "x" and "y" to three decimal places.
- "is_panel" is false if the image does not actually show this module's front
  panel straight on — a different module, a rear/PCB shot, a rack full of
  modules, a heavily angled photo, a logo or a placeholder. Say so honestly
  and return [] for "components": a wrong picture is worse than none, and
  there is a fallback that does not need one.
${
  cropped
    ? `- The image has already been cropped to this module's front plate, so the
  panel fills the frame edge to edge. Every component is somewhere on it.`
    : `- "panel" is the bounding box of this module's front plate within the image,
  excluding background, packaging, other modules and rack rails. Use
  {"x": 0.5, "y": 0.5, "w": 1, "h": 1} if the panel fills the image.`
}
- List one entry per component you can actually see, using the component's
  EXACT name from the list above. Omit the ones you cannot find rather than
  guessing at a position — an unplaced jack is fine, a jack placed on top of
  the wrong hole is not.
- Jacks are the round sockets a patch cable plugs into; knobs are the larger
  round controls with a pointer or indent; sliders are the long slots; the
  small rectangles are buttons and toggles.
- Give the centre of the HARDWARE ITSELF: the middle of a jack's hole, the
  middle of a knob's cap. A panel's silkscreened names are printed a few
  millimetres above or below the things they name, and are NOT part of them.
  Read the name to work out WHICH control you are looking at, then give the
  position of that control alone — a centre that has drifted towards the
  lettering is the one mistake worth taking care over here.
`;

export const PANEL_LAYOUT_TEMPLATE = (manufacturer, name, components) =>
  `You are a eurorack modular synthesizer expert. Using the attached user
manual for "${manufacturer} ${name}", describe the LAYOUT of the module's
front panel, so it can be drawn as a diagram.

These are the components the manual describes:

${componentList(components)}

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{
  "hp": 8,
  "components": [
    { "name": "1V/OCT", "shape": "jack", "x": 0.3, "y": 0.82 },
    { "name": "FREQ", "shape": "knob", "x": 0.5, "y": 0.18 }
  ]
}

Rules:
- "hp" is the panel width in HP (1HP = 5.08mm) as a number. Give the width the
  manual states; if it states none, estimate it from the panel drawing or the
  number of controls.
- "x" and "y" place the CENTRE of each component on the panel as fractions of
  the panel's own width and height, with 0,0 at the top left of the panel and
  1,1 at the bottom right.
- Follow the panel drawing in the manual: the real positions, in the real
  order, with jacks generally along the bottom and the controls they belong to
  above them. Keep 0.04 clear of every edge, and do not stack two components
  on the same spot.
- "shape" is one of: ${PANEL_SHAPES.join(', ')}. It says how the component is
  drawn, and should follow the component's type from the list above.
- Include EVERY component in the list, using its exact name. Components the
  manual shows on a different panel (an expander) are not part of this one and
  are not in the list — leave them out.
`;

// How many of this job's LLM calls came back with something readable.
//
// Every step below treats an unreadable answer as "nothing found", because
// usually that is what it is: a model that could not find a panel image says
// so, and the drawn panel exists for exactly that case. But a provider that
// is not answering at all fails every call identically — an expired
// subscription, an exhausted quota, a CLI that prints an apology and exits 0 —
// and then "nothing found" is a lie that costs the rack every photographed
// panel it had, replaced by drawings and its images deleted as orphans.
//
// So the two are counted apart. A job where nothing answered is a failed job,
// which leaves the panel the module already has exactly where it is.
// The call has to be counted BEFORE it is made, not after it returns: the
// commonest way for a provider to be down is the CLI exiting non-zero, which
// throws rather than returning anything to read. Counting on the way back
// misses exactly the case this is for.
export function answerTally() {
  return {
    asked: 0,
    answered: 0,
    // One call: counted going in, counted as answered only if it came back
    // and held a JSON object. Throws what the call or the parse throws, which
    // every caller already handles as "this step found nothing".
    async attempt(call) {
      this.asked += 1;
      const value = extractJsonObject(await call());
      this.answered += 1;
      return value;
    },
    silent() {
      return this.asked > 0 && this.answered === 0;
    },
  };
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));

const finite = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// The LLM is asked for a centre plus a size; either may be missing, and a few
// answers give a top-left corner box instead. Accept both readings: a box
// whose x/y sit at its own corner is treated as a corner box.
function readBox(raw, defaultSize) {
  const w = clamp01(finite(raw.w ?? raw.width, defaultSize) ?? defaultSize);
  const h = clamp01(finite(raw.h ?? raw.height, defaultSize) ?? defaultSize);
  let x = finite(raw.x ?? raw.cx ?? raw.left);
  let y = finite(raw.y ?? raw.cy ?? raw.top);
  if (x === null || y === null) return null;
  if (raw.left !== undefined && raw.x === undefined) x += w / 2;
  if (raw.top !== undefined && raw.y === undefined) y += h / 2;
  return { x: clamp01(x), y: clamp01(y), w, h };
}

// Default marker size on a real photograph, as a fraction of the panel: a
// 3.5mm jack is roughly 8mm across on a 128.5mm-tall panel.
const DEFAULT_MARKER = 0.06;

export function normalizeHp(value) {
  const hp = finite(value);
  if (hp === null || hp <= 0) return null;
  return Math.min(MAX_HP, Math.max(MIN_HP, Math.round(hp * 2) / 2));
}

// Match a placement's name to one of the module's components. Compared
// loosely: a panel silkscreens "1V/OCT" where the manual writes "1V/Oct in".
const matchKey = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function componentIndex(components) {
  const byKey = new Map();
  for (const c of components) {
    const key = matchKey(c.name);
    if (key && !byKey.has(key)) byKey.set(key, c);
  }
  return byKey;
}

// Turn the LLM's list of placements into rows against the stored components.
// A placement whose name matches no component is kept with a null
// component_id: on a generated panel it is still worth drawing (it is
// something the manual shows), it simply cannot anchor a cable.
export function normalizePlacements(raw, components, { defaultSize = DEFAULT_MARKER } = {}) {
  if (!Array.isArray(raw)) return [];
  const byKey = componentIndex(components);
  const placements = [];
  const usedComponents = new Set();
  const usedNames = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name ?? entry.component ?? entry.label ?? '').trim();
    if (!name) continue;
    const box = readBox(entry, defaultSize);
    if (!box) continue;
    const component = byKey.get(matchKey(name)) ?? null;
    // One position per component, and one per unmatched label: a repeated
    // name is the LLM listing the same control twice, not two controls.
    if (component) {
      if (usedComponents.has(component.id)) continue;
      usedComponents.add(component.id);
    } else {
      const key = matchKey(name);
      if (usedNames.has(key)) continue;
      usedNames.add(key);
    }
    let shape = String(entry.shape ?? '').trim().toLowerCase();
    if (!PANEL_SHAPES.includes(shape)) shape = component ? shapeForComponent(component) : 'other';
    placements.push({
      component_id: component?.id ?? null,
      name: component?.name ?? name,
      shape,
      ...box,
    });
  }
  return placements;
}

// Components the LLM did not place, dropped into the free space below the
// ones it did. A jack with no position cannot be patched in the diagram, so
// an approximate place beats none — they are laid out in reading order in a
// grid of their own so they never land on top of each other.
export function fillMissingPlacements(placements, components) {
  const placed = new Set(placements.map((p) => p.component_id).filter(Boolean));
  const missing = components.filter((c) => !placed.has(c.id));
  if (missing.length === 0) return placements;
  // Below everything already placed, or over the whole panel when nothing is.
  const top = placements.length === 0 ? 0.06 : Math.min(0.94, Math.max(...placements.map((p) => p.y + p.h / 2)) + 0.05);
  const columns = missing.length > 8 ? 3 : missing.length > 3 ? 2 : 1;
  const rows = Math.ceil(missing.length / columns);
  const rowStep = rows > 0 ? Math.min(0.1, (0.96 - top) / rows) : 0.1;
  return [
    ...placements,
    ...missing.map((c, i) => ({
      component_id: c.id,
      name: c.name,
      shape: shapeForComponent(c),
      x: (Math.floor(i % columns) + 0.5) / columns,
      y: clamp01(top + (Math.floor(i / columns) + 0.5) * rowStep),
      w: DEFAULT_MARKER,
      h: DEFAULT_MARKER,
    })),
  ];
}

// ---------------------------------------------------------------------------
// Drawing the logical panel
// ---------------------------------------------------------------------------

const xmlEscape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Glyph geometry in millimetres, so a drawn panel is to scale with the real
// thing: a 3.5mm jack sits in an 8mm nut, a standard knob is about 12mm.
const GLYPH_MM = {
  jack: { r: 4 },
  knob: { r: 6 },
  slider: { w: 5, h: 26 },
  button: { w: 6, h: 6 },
  toggle: { w: 4, h: 8 },
  switch: { w: 5, h: 9 },
  display: { w: 22, h: 11 },
  other: { r: 4 },
};

const round = (n) => Math.round(n * 10) / 10;

function glyph(shape, cx, cy, mm) {
  const g = GLYPH_MM[shape] || GLYPH_MM.other;
  if (g.r) {
    const r = g.r * mm;
    if (shape === 'knob') {
      // A knob reads as a knob because of its pointer.
      return (
        `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" class="knob"/>` +
        `<line x1="${round(cx)}" y1="${round(cy)}" x2="${round(cx)}" y2="${round(cy - r * 0.8)}" class="pointer"/>`
      );
    }
    const cls = shape === 'jack' ? 'jack' : 'other';
    return (
      `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" class="${cls}"/>` +
      (shape === 'jack'
        ? `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r * 0.42)}" class="jack-hole"/>`
        : '')
    );
  }
  const w = g.w * mm;
  const h = g.h * mm;
  const cls = shape === 'display' ? 'display' : 'control';
  return (
    `<rect x="${round(cx - w / 2)}" y="${round(cy - h / 2)}" width="${round(w)}" ` +
    `height="${round(h)}" rx="${round(mm)}" class="${cls}"/>`
  );
}

// Draw the panel: an SVG the client renders exactly like a photograph, with
// the same fractional positions overlaid on it. Deliberately built here
// rather than asked of the LLM — the drawing and the stored positions must
// agree, and markup from a model is not something to serve from our origin.
export function renderPanelSvg({ manufacturer, name, hp, placements }) {
  const mm = PX_PER_MM;
  const width = Math.round((hp || DEFAULT_HP) * HP_MM * mm);
  const height = Math.round(PANEL_MM_HEIGHT * mm);
  const label = `${manufacturer} ${name}`.trim();
  const font = round(2.6 * mm);
  const titleFont = round(3.4 * mm);

  const parts = [];
  for (const p of placements) {
    const cx = p.x * width;
    const cy = p.y * height;
    parts.push(`<g><title>${xmlEscape(p.name)}</title>${glyph(p.shape, cx, cy, mm)}</g>`);
    const g = GLYPH_MM[p.shape] || GLYPH_MM.other;
    const below = (g.r ? g.r : g.h / 2) * mm + font;
    parts.push(
      `<text x="${round(cx)}" y="${round(cy + below)}" class="label" font-size="${font}">` +
        `${xmlEscape(p.name)}</text>`
    );
  }

  return {
    width,
    height,
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${xmlEscape(label)} front panel">
  <title>${xmlEscape(label)}</title>
  <style>
    .plate { fill: #1c1c28; stroke: #3a3a52; stroke-width: ${round(0.4 * mm)}; }
    .rail { fill: #2a2a3c; }
    .jack { fill: #0d0d14; stroke: #6d6d8a; stroke-width: ${round(0.35 * mm)}; }
    .jack-hole { fill: #05050a; }
    .knob { fill: #2f2f42; stroke: #8b5cf6; stroke-width: ${round(0.35 * mm)}; }
    .pointer { stroke: #e4e4e7; stroke-width: ${round(0.4 * mm)}; stroke-linecap: round; }
    .control { fill: #2f2f42; stroke: #8b5cf6; stroke-width: ${round(0.3 * mm)}; }
    .display { fill: #0d0d14; stroke: #4ade80; stroke-width: ${round(0.3 * mm)}; }
    .other { fill: #23233a; stroke: #6d6d8a; stroke-width: ${round(0.3 * mm)}; }
    .label { fill: #c8c8d4; font-family: 'Inter', system-ui, sans-serif; text-anchor: middle; }
    .title { fill: #a78bfa; font-family: 'Inter', system-ui, sans-serif; text-anchor: middle; font-weight: 600; }
  </style>
  <rect x="0" y="0" width="${width}" height="${height}" class="plate"/>
  <rect x="0" y="0" width="${width}" height="${round(3 * mm)}" class="rail"/>
  <rect x="0" y="${round(height - 3 * mm)}" width="${width}" height="${round(3 * mm)}" class="rail"/>
  <text x="${round(width / 2)}" y="${round(8 * mm)}" class="title" font-size="${titleFont}">${xmlEscape(
    name
  )}</text>
  ${parts.join('\n  ')}
</svg>
`,
  };
}

// ---------------------------------------------------------------------------
// Reading panels back out
// ---------------------------------------------------------------------------

export const panelImageUrl = (panel) => `/api/panels/${panel.image_hash}.${panel.image_ext}`;

// One panel in the shape the client draws from: the image, the box of it that
// is the panel, and where each component sits as a fraction of the image.
//
// `blurbs` maps component id to what the manual says that component does. A
// marker on a picture is a circle with a name on it, which tells you which
// jack it is but not what it is for — and the panel is exactly where that
// question gets asked, since it is the thing you look at with a cable in your
// hand. Carried on the placement rather than fetched by the client so the
// patch diagram gets it too, for the price of one query.
export const panelJson = (panel, placements = [], blurbs = new Map()) => ({
  source: panel.source,
  source_url: panel.source_url ?? null,
  url: panelImageUrl(panel),
  width: panel.width,
  height: panel.height,
  crop: { x: panel.crop_x, y: panel.crop_y, w: panel.crop_w, h: panel.crop_h },
  hp: panel.hp ?? null,
  description: panel.description ?? null,
  components: placements.map((p) => ({
    id: p.id,
    component_id: p.component_id ?? null,
    name: p.name,
    shape: p.shape,
    description: (p.component_id != null ? blurbs.get(p.component_id) : null) ?? null,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
  })),
});

// The panels of a set of modules, keyed by module id. Flat queries, so pg-mem
// (the test database) can run them as well as postgres.
export async function loadPanels(db, moduleIds) {
  const ids = [...new Set(moduleIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { ModuleComponent, ModulePanel, ModulePanelComponent } = db.models;
  const panels = await ModulePanel.findAll({ where: { module_id: ids } });
  if (panels.length === 0) return new Map();
  const placements = await ModulePanelComponent.findAll({
    where: { panel_id: panels.map((p) => p.id) },
    order: [['id', 'ASC']],
  });
  const byPanel = new Map();
  for (const p of placements) {
    if (!byPanel.has(p.panel_id)) byPanel.set(p.panel_id, []);
    byPanel.get(p.panel_id).push(p);
  }
  const componentIds = [...new Set(placements.map((p) => p.component_id).filter((id) => id != null))];
  const blurbs = new Map();
  if (componentIds.length > 0) {
    for (const c of await ModuleComponent.findAll({ where: { id: componentIds } })) {
      if (c.description) blurbs.set(c.id, c.description);
    }
  }
  return new Map(
    panels.map((panel) => [panel.module_id, panelJson(panel, byPanel.get(panel.id) ?? [], blurbs)])
  );
}

// ---------------------------------------------------------------------------
// Building a module's panel
// ---------------------------------------------------------------------------

// Last resort: no image, no manual layout. Components go into columns by kind
// — controls up top, jacks along the bottom, the way nearly every module is
// actually arranged — so the diagram is at least honest about what is where.
export function fallbackLayout(components) {
  const jacks = components.filter((c) => c.type.endsWith('_jack'));
  const controls = components.filter((c) => !c.type.endsWith('_jack'));
  const place = (list, top, bottom) => {
    if (list.length === 0) return [];
    const columns = list.length > 10 ? 3 : list.length > 4 ? 2 : 1;
    const rows = Math.ceil(list.length / columns);
    return list.map((c, i) => ({
      component_id: c.id,
      name: c.name,
      shape: shapeForComponent(c),
      x: (Math.floor(i % columns) + 0.5) / columns,
      y: top + ((Math.floor(i / columns) + 0.5) / rows) * (bottom - top),
      w: DEFAULT_MARKER,
      h: DEFAULT_MARKER,
    }));
  };
  const split = controls.length === 0 ? 0.08 : jacks.length === 0 ? 0.92 : 0.52;
  return [...place(controls, 0.1, split), ...place(jacks, split, 0.94)];
}

// How wide to draw a module nobody told us the width of.
export function estimateHp(components) {
  return normalizeHp(Math.max(4, Math.min(28, Math.round(components.length * HP_PER_COMPONENT))));
}

// The front plate's box within the image, as a stored origin + size. A box
// too small to be a panel, or one the model did not give at all, becomes the
// whole image — showing all of a photograph is a mild waste of space, showing
// a sliver of one is a broken diagram.
export const FULL_CROP = { crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1 };
const MIN_CROP = 0.1;

export function normalizeCrop(raw) {
  const box = readBox(raw ?? {}, 1);
  if (!box || box.w < MIN_CROP || box.h < MIN_CROP) return { ...FULL_CROP };
  const x = clamp01(box.x - box.w / 2);
  const y = clamp01(box.y - box.h / 2);
  return {
    crop_x: x,
    crop_y: y,
    // Never let the box run off the edge of the image it is a box within.
    crop_w: Math.min(box.w, 1 - x),
    crop_h: Math.min(box.h, 1 - y),
  };
}

// Ask the LLM where the components are on an image. Returns null when the
// image turns out not to show this module's panel, or when nothing on it
// could be identified.
//
// `cropped` says the file has already been cut down to the front plate, in
// which case the model is not asked for a panel box (we already know it, and
// better than it does) and its coordinates are relative to the crop.
export async function locateComponentsOnImage(
  backend,
  module,
  components,
  imagePath,
  log,
  { cropped = false, tally = answerTally() } = {}
) {
  let parsed;
  try {
    parsed = await tally.attempt(() =>
      backend.analyzeImage(
        PANEL_MAP_TEMPLATE(module.manufacturer, module.name, components, { cropped }),
        imagePath
      )
    );
  } catch (e) {
    log(`could not map components onto the panel image: ${e.message}`);
    return null;
  }
  if (parsed.is_panel === false) {
    log('the image found is not a straight-on shot of this module\'s panel');
    return null;
  }
  const placements = normalizePlacements(parsed.components, components);
  // A picture with one lucky hit on it is not a mapped panel; the drawn
  // fallback is more useful than a photo with three markers on it.
  const matched = placements.filter((p) => p.component_id).length;
  if (matched < Math.min(3, components.length)) {
    log(`only ${matched} of ${components.length} component(s) could be located on the image`);
    return null;
  }
  return { placements, crop: cropped ? null : normalizeCrop(parsed.panel), matched };
}

// How much backdrop is left around the plate in the picture handed to the
// model: enough that nothing along an edge is cut in half, little enough that
// the panel is still what the picture is of.
const ANALYSIS_MARGIN = 0.03;
// A trim that barely shrinks the frame is not worth a second file on disk.
const WORTH_CROPPING = 0.8;

// Where this module's components are on a panel photograph, in the fractions
// of the whole image the client renders from — the model's reading of the
// picture, corrected against the picture itself.
//
// The plate is found by trimming the backdrop rather than by asking, the
// model is then shown the plate on its own rather than a module 4% of the way
// across a press shot, and every round component it places is finally snapped
// onto the hardware it names. Each of those steps is skipped silently if the
// image cannot be decoded, leaving exactly the single unrefined LLM pass this
// used to be.
export async function mapPanelImage(backend, module, components, file, deps = {}) {
  const { hp = null, log = () => {}, tmpdir = os.tmpdir, tally = answerTally() } = deps;
  const pixels = await readPixels(file);
  const plate = pixels ? panelCrop(pixels, { hp }) : null;

  // The box the model's answer will be relative to: the crop we hand it, or
  // the whole image when there is no crop to hand it.
  let analysisBox = null;
  let analysisFile = file;
  let scratch = null;
  try {
    if (plate && plate.w * plate.h < WORTH_CROPPING) {
      const box = growBox(plate, ANALYSIS_MARGIN);
      scratch = fs.mkdtempSync(path.join(tmpdir(), 'panel-crop-'));
      const written = await writeCrop(file, box, path.join(scratch, 'panel.png'));
      if (written) {
        analysisBox = box;
        analysisFile = written;
        log(
          `cropped the front plate out of the ${pixels.width}x${pixels.height} image ` +
            `(${Math.round(plate.w * 100)}% of its width) before mapping`
        );
      }
    }

    const located = await locateComponentsOnImage(backend, module, components, analysisFile, log, {
      cropped: analysisBox !== null,
      tally,
    });
    if (!located) return null;

    let placements = located.placements;
    if (analysisBox) {
      placements = placements.map((p) => ({
        ...p,
        ...pointInBox(analysisBox, p.x, p.y),
        w: p.w * analysisBox.w,
        h: p.h * analysisBox.h,
      }));
    }

    const crop = plate
      ? { crop_x: plate.x, crop_y: plate.y, crop_w: plate.w, crop_h: plate.h }
      : located.crop ?? { ...FULL_CROP };

    if (pixels) {
      const snap = snapPlacements(pixels, placements, {
        x: crop.crop_x,
        y: crop.crop_y,
        w: crop.crop_w,
        h: crop.crop_h,
      });
      placements = snap.placements;
      if (snap.snapped > 0) {
        // A fraction of the image's height is that many 128.5mm plates.
        const mm = (Math.abs(snap.shift.y) * PANEL_MM_HEIGHT) / crop.crop_h;
        log(
          `snapped ${snap.snapped} of ${placements.length} marker(s) onto the hardware` +
            (snap.shifted
              ? `, and carried the other ${snap.shifted} ${snap.shift.y < 0 ? 'up' : 'down'} ` +
                `with them (${mm.toFixed(1)}mm at the middle of the panel)`
              : '')
        );
      }
    }

    return { placements, crop, matched: located.matched };
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Ask the LLM to read the panel layout out of the manual, for the case where
// no usable photograph exists.
export async function layoutFromManual(
  backend,
  module,
  components,
  manualFile,
  log,
  { tally = answerTally() } = {}
) {
  if (!manualFile || !fs.existsSync(manualFile)) return null;
  let parsed;
  try {
    parsed = await tally.attempt(() =>
      backend.analyzeDocument(
        PANEL_LAYOUT_TEMPLATE(module.manufacturer, module.name, components),
        manualFile
      )
    );
  } catch (e) {
    log(`could not read a panel layout out of the manual: ${e.message}`);
    return null;
  }
  const placements = normalizePlacements(parsed.components, components);
  if (placements.length === 0) return null;
  return { placements, hp: normalizeHp(parsed.hp) };
}

// One research prompt: ask, then download the first candidate that turns out
// to be an image we serve. Returns { image, hp, page_url }, image null when
// the search found nothing or none of what it found could be fetched.
async function researchPanelImage(
  backend,
  template,
  module,
  panelsDir,
  { fetchImpl, log, tally = answerTally() }
) {
  let info;
  try {
    info = await tally.attempt(() =>
      backend.completeTextWithSearch(template(module.manufacturer, module.name))
    );
  } catch (e) {
    log(`panel image research failed: ${e.message}`);
    return { image: null, hp: null, page_url: null };
  }
  const hp = normalizeHp(info.hp);
  const page_url = info.page_url ? String(info.page_url).trim() : null;
  const urls = (Array.isArray(info.image_urls) ? info.image_urls : [info.image_urls])
    .filter(Boolean)
    .map((u) => String(u).trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 4);
  for (const url of urls) {
    log(`trying panel image: ${url}`);
    const image = await downloadImage(url, { fetchImpl, log });
    if (!image) continue;
    const hash = saveImage(panelsDir, image.buffer, image.ext);
    return {
      image: { ...image, hash, path: panelPath(panelsDir, hash, image.ext) },
      hp,
      page_url,
    };
  }
  return { image: null, hp, page_url };
}

// Research and download a front-panel photograph. The maker's own page and
// the retailers first; ModularGrid only if that turns up nothing, since it is
// a rack planner whose pictures are contributed rather than published. A
// width learnt from either search is kept even when neither yields a picture,
// because a module with no recorded HP still wants one.
export async function findPanelImage(backend, module, panelsDir, deps = {}) {
  const { fetchImpl = fetch, log = () => {}, tally = answerTally() } = deps;
  const options = { fetchImpl, log, tally };
  const first = await researchPanelImage(backend, PANEL_RESEARCH_TEMPLATE, module, panelsDir, options);
  if (first.image) return first;

  log('no panel image from the manufacturer or a retailer; trying ModularGrid');
  const second = await researchPanelImage(
    backend,
    PANEL_MODULARGRID_TEMPLATE,
    module,
    panelsDir,
    options
  );
  return {
    image: second.image,
    hp: (second.image ? second.hp ?? first.hp : first.hp ?? second.hp) ?? null,
    page_url: (second.image ? second.page_url : first.page_url ?? second.page_url) ?? null,
  };
}

// Replace the module's panel record and its component positions, and mark the
// module's panel status complete. One transaction: a half-written panel whose
// markers point at the previous image would be worse than none.
//
// A width the panel step worked out also fills in the module's own hp when
// nothing has recorded one yet (migration 017) — but never overwrites a width
// that is already there, which came from the manual or from the import and is
// the better source.
export async function savePanel(db, module, panel, placements) {
  const { Module, ModulePanel, ModulePanelComponent } = db.models;
  await db.sequelize.transaction(async (transaction) => {
    const previous = await ModulePanel.findAll({
      where: { module_id: module.id },
      transaction,
    });
    if (previous.length > 0) {
      await ModulePanelComponent.destroy({
        where: { panel_id: previous.map((p) => p.id) },
        transaction,
      });
      await ModulePanel.destroy({ where: { module_id: module.id }, transaction });
    }
    const row = await ModulePanel.create({ ...panel, module_id: module.id }, { transaction });
    if (placements.length > 0) {
      await ModulePanelComponent.bulkCreate(
        placements.map((p) => ({ ...p, panel_id: row.id })),
        { transaction }
      );
    }
    await Module.update(
      {
        panel_status: 'complete',
        ...(panel.hp != null && module.hp == null ? { hp: panel.hp } : {}),
      },
      { where: { id: module.id }, transaction }
    );
  });
  // The previous image's file goes only once nothing points at those bytes.
  return { panel, placements };
}

// Remove a panel image file that no panel row references any more.
export async function deletePanelImageIfOrphaned(db, panelsDir, hash, ext) {
  if (!hash) return;
  if ((await db.models.ModulePanel.count({ where: { image_hash: hash } })) > 0) return;
  fs.rmSync(panelPath(panelsDir, hash, ext), { force: true });
}

// Place this module's components on a panel image that is already stored —
// the picture a user uploaded (routes/modules.js POST /:id/panel). The image
// itself is never in question here: it is kept whatever the mapping says,
// because someone chose it deliberately. Only the markers are (re)derived,
// which is also what puts them back after a re-analysis has replaced every
// component row the previous markers pointed at.
//
// Returns null when the file has gone missing, so the caller can fall back to
// building a panel from scratch.
export async function locateOnUploadedPanel(db, backend, module, panel, components, panelsDir, deps = {}) {
  const { log = () => {}, tally = answerTally() } = deps;
  const file = panelPath(panelsDir, panel.image_hash, panel.image_ext);
  if (!fs.existsSync(file)) return null;
  log(`locating components on the uploaded ${panel.width}x${panel.height} image`);
  const located = await mapPanelImage(backend, module, components, file, {
    hp: module.hp ?? panel.hp ?? null,
    log,
    tally,
  });
  // Stripping the markers off a picture the user chose, because the provider
  // is not answering, would be worse than doing nothing at all.
  if (tally.silent()) throw silentModel(module, tally);
  if (!located) {
    log('no component could be located on the uploaded image; keeping it unmarked');
  }
  return savePanel(
    db,
    module,
    {
      source: 'upload',
      source_url: panel.source_url ?? null,
      image_hash: panel.image_hash,
      image_ext: panel.image_ext,
      width: panel.width,
      height: panel.height,
      ...(located?.crop ?? { ...FULL_CROP }),
      hp: module.hp ?? panel.hp ?? null,
      description: located
        ? `Uploaded panel image — ${located.matched} of ${components.length} component(s) located on it.`
        : 'Uploaded panel image. The components on it could not be located automatically.',
    },
    located?.placements ?? []
  );
}

const silentModel = (module, tally) =>
  new Error(
    `${module.manufacturer} ${module.name}: none of the ${tally.asked} model request(s) this ` +
      'panel needed came back readable, so there is nothing to tell a panel from. Check the ' +
      'provider CLI is logged in and has quota; the panel this module already had is untouched'
  );

// The whole pipeline for one module: an uploaded picture if there is one,
// then a researched image, then a drawn panel, then columns by type. Always
// produces a panel — a module with an analysis but no picture is exactly the
// case this exists to remove — unless the model answered nothing at all, in
// which case it produces nothing rather than a drawing standing in for a
// photograph that is still perfectly findable.
export async function buildPanelForModule(db, backend, module, panelsDir, deps = {}) {
  const {
    fetchImpl = fetch,
    log = () => {},
    manualFile = null,
    findImages = true,
    tally = answerTally(),
  } = deps;
  const components = (
    await db.models.ModuleComponent.findAll({
      where: { module_id: module.id },
      order: [['id', 'ASC']],
    })
  ).map((c) => c.get({ plain: true }));
  if (components.length === 0) {
    throw new Error(
      `${module.manufacturer} ${module.name} has no analyzed components to place on a panel`
    );
  }

  const previous = await db.models.ModulePanel.findOne({ where: { module_id: module.id } });

  // A panel someone uploaded is the panel. Research would only replace a
  // deliberate choice with a guess, so the picture stays and its markers are
  // worked out again on it.
  //
  // Checked against the stored row rather than once at the top, because this
  // job spends minutes in LLM calls and an upload can land in the middle of
  // one: the answer to "is there an uploaded panel" has to be the answer at
  // the moment of saving, or the upload is silently thrown away.
  const uploadedPanel = async () => {
    const current = await db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    if (current?.source !== 'upload') return null;
    return locateOnUploadedPanel(db, backend, module, current.get({ plain: true }), components, panelsDir, {
      log,
      tally,
    });
  };

  const uploaded = await uploadedPanel();
  if (uploaded) return uploaded;
  if (previous?.source === 'upload') {
    log('the uploaded panel image is no longer on disk; building one instead');
  }

  let researched = { image: null, hp: null, page_url: null };
  if (findImages) {
    log('researching a front panel image');
    researched = await findPanelImage(backend, module, panelsDir, { fetchImpl, log, tally });
  }

  if (researched.image) {
    log(`locating components on ${researched.image.width}x${researched.image.height} image`);
    const located = await mapPanelImage(backend, module, components, researched.image.path, {
      hp: module.hp ?? researched.hp ?? null,
      log,
      tally,
    });
    if (located) {
      log(`panel image mapped: ${located.matched} of ${components.length} component(s) located`);
      const landed = await uploadedPanel();
      if (landed) {
        log('a panel picture was uploaded while this ran; keeping that instead');
        await deletePanelImageIfOrphaned(db, panelsDir, researched.image.hash, researched.image.ext);
        return landed;
      }
      const saved = await savePanel(
        db,
        module,
        {
          source: 'image',
          source_url: researched.image.url,
          image_hash: researched.image.hash,
          image_ext: researched.image.ext,
          width: researched.image.width,
          height: researched.image.height,
          ...located.crop,
          hp: researched.hp,
          description: researched.page_url ? `Found on ${researched.page_url}` : null,
        },
        located.placements
      );
      if (previous) {
        await deletePanelImageIfOrphaned(db, panelsDir, previous.image_hash, previous.image_ext);
      }
      return saved;
    }
    // The image is of no use to us; do not leave its bytes on disk.
    await deletePanelImageIfOrphaned(
      db,
      panelsDir,
      researched.image.hash,
      researched.image.ext
    );
  }

  log('drawing a logical panel from the manual');
  const layout = await layoutFromManual(backend, module, components, manualFile, log, { tally });
  // Everything above came up empty. That is a real answer when the model gave
  // one — plenty of modules have no findable photograph — and no answer at all
  // when it did not, and a drawing saved on the strength of no answer would
  // replace this module's picture with a column of circles and delete it.
  if (tally.silent()) throw silentModel(module, tally);
  const placements = fillMissingPlacements(
    layout?.placements ?? fallbackLayout(components),
    components
  );
  // The module's own width (from its manual, or from the imported list) beats
  // anything worked out while drawing.
  const hp = module.hp ?? layout?.hp ?? researched.hp ?? estimateHp(components);
  const { svg, width, height } = renderPanelSvg({
    manufacturer: module.manufacturer,
    name: module.name,
    hp,
    placements,
  });
  const landed = await uploadedPanel();
  if (landed) {
    log('a panel picture was uploaded while this ran; keeping that instead');
    return landed;
  }
  const hash = saveImage(panelsDir, Buffer.from(svg, 'utf-8'), 'svg');
  log(
    layout
      ? `logical panel drawn from the manual: ${hp}HP, ${placements.length} component(s)`
      : `logical panel drawn from the component list: ${hp}HP, ${placements.length} component(s)`
  );
  const saved = await savePanel(
    db,
    module,
    {
      source: 'generated',
      source_url: null,
      image_hash: hash,
      image_ext: 'svg',
      width,
      height,
      crop_x: 0,
      crop_y: 0,
      crop_w: 1,
      crop_h: 1,
      hp,
      description: layout
        ? 'Drawn from the panel layout described in the manual.'
        : 'Drawn from the analyzed component list; no panel layout was available.',
    },
    placements
  );
  if (previous) {
    await deletePanelImageIfOrphaned(db, panelsDir, previous.image_hash, previous.image_ext);
  }
  return saved;
}
