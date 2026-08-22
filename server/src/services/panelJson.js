// Reading panels back out: one panel in the shape the client draws from.
//
// The serializer for a module's front plate, beside services/moduleJson.js
// (the module's other hardware facts) and separate from the acquisition flow
// in services/panelImage.js, which is what puts a panel there in the first
// place.

export const panelImageUrl = (panel) => `/api/panels/${panel.image_hash}.${panel.image_ext}`;

// One panel in the shape the client draws from: the image, the box of it that
// is the panel, and where each component sits as a fraction of the image.
//
// `facts` maps component id to what that component IS ({ type, description }).
// A marker on a picture is a circle with a name on it, which tells you which
// jack it is but not what it is for, nor what kind of thing it is — and the
// panel is exactly where both questions get asked, since it is the thing you
// look at with a cable in your hand. Carried on the placement rather than
// fetched by the client so that every renderer (the patch diagram, the module
// page, the rack organizer's rows) can colour a marker by its component type
// without loading the module behind it, for the price of one query.
// `describe` is off for a payload that only has to be DRAWN: a patch of a
// whole studio carries five thousand placements, and the sentence explaining
// each control is the largest thing in it and is read nowhere on that page.
export const panelJson = (panel, placements = [], facts = new Map(), { describe = true } = {}) => ({
  source: panel.source,
  source_url: panel.source_url ?? null,
  url: panelImageUrl(panel),
  width: panel.width,
  height: panel.height,
  crop: { x: panel.crop_x, y: panel.crop_y, w: panel.crop_w, h: panel.crop_h },
  // The file has already been cut down to the front plate, so Trim has
  // nothing left to take off (routes/modules/panel.js).
  trimmed: Boolean(panel.trimmed),
  hp: panel.hp ?? null,
  description: panel.description ?? null,
  components: placements.map((p) => ({
    id: p.id,
    component_id: p.component_id ?? null,
    name: p.name,
    shape: p.shape,
    // The component's own type ('input_jack', 'knob', …), which is finer than
    // `shape`: every jack is one shape but three different types, and the
    // direction a jack runs is the thing a picture most needs to say.
    type: (p.component_id != null ? facts.get(p.component_id)?.type : null) ?? null,
    ...(describe
      ? {
          description:
            (p.component_id != null ? facts.get(p.component_id)?.description : null) ?? null,
        }
      : {}),
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
  })),
});

// The panels of a set of modules, keyed by module id. Flat queries, so pg-mem
// (the test database) can run them as well as postgres.
export async function loadPanels(db, moduleIds, { describe = true } = {}) {
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
  const facts = new Map();
  if (componentIds.length > 0) {
    for (const c of await ModuleComponent.findAll({ where: { id: componentIds } })) {
      facts.set(c.id, { type: c.type ?? null, description: c.description ?? null });
    }
  }
  return new Map(
    panels.map((panel) => [
      panel.module_id,
      panelJson(panel, byPanel.get(panel.id) ?? [], facts, { describe }),
    ])
  );
}
