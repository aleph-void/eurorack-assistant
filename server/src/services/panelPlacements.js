// Where each component sits on the plate, as fractions of the whole image.
//
// The model answers with a list of names and boxes; this turns that into rows
// against the module's own components, fills in the ones it missed, and puts
// right the markers that ended up behind nothing. Stored as fractions so the
// client can draw them at any size (see migration 016).

import { clamp01 } from './panelGeometry.js';
import {
  PANEL_SHAPES,
  shapeForComponent,
  MIN_HP,
  MAX_HP,
  HP_PER_COMPONENT,
} from './panelShapes.js';

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
export const DEFAULT_MARKER = 0.06;

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

// A placement's name may arrive with the component's TYPE in brackets. The
// prompt lists the module's components as "- PITCH A (knob)", and a model
// that copies the line whole is naming that knob, not a control called
// "PITCH A (knob)" — matching the literal string leaves a marker with nothing
// behind it, drawn on the plate and in none of the lists. It is also the only
// way to tell two components apart when a panel names a knob and its jack the
// same thing, which is exactly when this happens.
const TYPED_NAME = /^(.*?)\s*\(\s*([a-z][a-z0-9_ -]*)\s*\)\s*$/i;

const typeKey = (type) => String(type ?? '').toLowerCase().replace(/[\s-]+/g, '_');

export function componentIndex(components) {
  const byKey = new Map();
  for (const c of components) {
    const key = matchKey(c.name);
    if (!key) continue;
    // The name alone, first one wins — two components of one name are told
    // apart by the typed key below.
    if (!byKey.has(key)) byKey.set(key, c);
    byKey.set(`${key}\u0000${typeKey(c.type)}`, c);
  }
  return byKey;
}

// The component a placement's name means: by name and type where the name
// carries one (or the entry states one), by name alone otherwise.
export function matchComponent(byKey, name, type = null) {
  const typed = TYPED_NAME.exec(name);
  const stated = typeKey(type ?? (typed ? typed[2] : ''));
  const base = typed ? typed[1] : name;
  return (
    (stated ? byKey.get(`${matchKey(base)}\u0000${stated}`) : null) ??
    byKey.get(matchKey(name)) ??
    byKey.get(matchKey(base)) ??
    null
  );
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
    const component = matchComponent(byKey, name, entry.type);
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

// Markers on a stored panel with nothing behind them, matched to the module's
// components again.
//
// A marker whose component_id is null is drawn on the plate but appears in no
// list and can anchor no cable — and, because the untyped fallback colour is
// the same violet output jacks are drawn in, it reads as an output jack that
// has gone missing. They come from a placement whose name did not match a
// component: most often the model echoing the prompt's "- PITCH A (knob)"
// line whole. normalizePlacements no longer produces them (matchComponent
// reads the type off the name), and this puts the ones already stored right:
// a marker that names a component with no marker becomes that component's
// marker, and one that names a component which already has its own is the
// duplicate it looks like, and goes.
export async function relinkPanelPlacements(db, moduleId) {
  const { ModulePanel, ModulePanelComponent, ModuleComponent } = db.models;
  const panel = await ModulePanel.findOne({ where: { module_id: moduleId } });
  const result = { orphans: 0, linked: 0, removed: 0 };
  if (!panel) return result;
  const rows = await ModulePanelComponent.findAll({ where: { panel_id: panel.id } });
  const orphans = rows.filter((row) => row.component_id === null || row.component_id === undefined);
  result.orphans = orphans.length;
  if (orphans.length === 0) return result;
  const components = await ModuleComponent.findAll({ where: { module_id: moduleId } });
  const byKey = componentIndex(components.map((c) => c.get({ plain: true })));
  const placed = new Set(rows.map((row) => row.component_id).filter((id) => id != null));
  for (const row of orphans) {
    const component = matchComponent(byKey, row.name);
    if (!component) continue;
    if (placed.has(component.id)) {
      await row.destroy();
      result.removed += 1;
      continue;
    }
    await row.update({ component_id: component.id, name: component.name });
    placed.add(component.id);
    result.linked += 1;
  }
  return result;
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
