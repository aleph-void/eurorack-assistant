// Dual modules: two panels of one product joined by a link cable (Omnitone
// 7Path's ethernet pair). The pair is declared ONCE on the hardware
// (module_bridges, migration 033); this module is what turns that declaration
// into the patch-level rows every reader already understands —
// patch_module_links kind 'bridge' plus the jack-for-jack map under it.
//
// Pairing instances is the whole job. A dual is usually ONE module record
// racked twice (a 7Path pair), so its two halves are instance 1 and instance
// 2 of the same module; a dual whose panels are two separate records pairs
// instance i of one with instance i of the other. Either way a panel already
// bridged in the patch is left alone, so this can be re-run over a patch that
// is half wired up — which is exactly what happens when an instance is added
// to a patch that was built before the pair was declared.

const key = (name) => String(name ?? '').trim().toLowerCase();

const isJack = (component) => String(component.type ?? '').endsWith('_jack');

// Jack N of one panel ↔ jack N of the other. Two panels of one product carry
// the same labels, so this is the default; a pair whose panels label the same
// wire differently records the map explicitly instead.
export function pairJacksByName(aComponents, bComponents) {
  const byName = new Map();
  for (const c of bComponents.filter(isJack)) {
    if (!byName.has(key(c.name))) byName.set(key(c.name), c);
  }
  const rows = [];
  for (const a of aComponents.filter(isJack)) {
    const b = byName.get(key(a.name));
    if (!b) continue;
    rows.push({
      a_component_id: a.id,
      a_component_name: a.name,
      b_component_id: b.id,
      b_component_name: b.name,
    });
  }
  return rows;
}

// The jack map of one declared pair: the rows it recorded, or a pairing by
// name when it recorded none. `componentsByModule` holds the live components
// of both panels.
export function bridgeJackRows(bridge, jackRows, componentsByModule) {
  const aComponents = componentsByModule.get(bridge.a_module_id) || [];
  const bComponents = componentsByModule.get(bridge.b_module_id) || [];
  const declared = jackRows.filter((j) => j.bridge_id === bridge.id);
  if (declared.length === 0) return pairJacksByName(aComponents, bComponents);
  const aById = new Map(aComponents.map((c) => [c.id, c]));
  const bById = new Map(bComponents.map((c) => [c.id, c]));
  const rows = [];
  for (const j of declared) {
    const a = aById.get(j.a_component_id);
    const b = bById.get(j.b_component_id);
    if (!a || !b) continue;
    rows.push({
      a_component_id: a.id,
      a_component_name: a.name,
      b_component_id: b.id,
      b_component_name: b.name,
    });
  }
  return rows;
}

// Every dual pair among a set of module ids, with its jack map resolved.
export async function declaredBridges(db, moduleIds, { transaction } = {}) {
  const { ModuleBridge, ModuleBridgeJack, ModuleComponent } = db.models;
  const ids = [...new Set(moduleIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const bridges = await ModuleBridge.findAll({
    where: { a_module_id: ids, b_module_id: ids },
    order: [['id', 'ASC']],
    transaction,
  });
  if (bridges.length === 0) return [];
  const jackRows = await ModuleBridgeJack.findAll({
    where: { bridge_id: bridges.map((b) => b.id) },
    order: [['id', 'ASC']],
    transaction,
  });
  const components = await ModuleComponent.findAll({
    where: { module_id: [...new Set(bridges.flatMap((b) => [b.a_module_id, b.b_module_id]))] },
    order: [['id', 'ASC']],
    transaction,
  });
  const componentsByModule = new Map();
  for (const c of components) {
    if (!componentsByModule.has(c.module_id)) componentsByModule.set(c.module_id, []);
    componentsByModule.get(c.module_id).push(c);
  }
  return bridges.map((bridge) => ({
    id: bridge.id,
    a_module_id: bridge.a_module_id,
    b_module_id: bridge.b_module_id,
    description: bridge.description,
    jacks: bridgeJackRows(bridge, jackRows, componentsByModule),
  }));
}

// Wire up every dual pair this patch holds both halves of, and that the patch
// has not already got a bridge for. Idempotent: run it again after adding an
// instance and only the new pairing appears.
export async function materializeBridges(db, patch, { transaction } = {}) {
  const { PatchModule, PatchModuleLink, PatchModuleLinkJack } = db.models;
  const patchModules = await PatchModule.findAll({
    where: { patch_id: patch.id },
    order: [['id', 'ASC']],
    transaction,
  });
  const live = patchModules.filter((pm) => pm.module_id);
  if (live.length === 0) return [];
  const bridges = await declaredBridges(
    db,
    live.map((pm) => pm.module_id),
    { transaction }
  );
  if (bridges.length === 0) return [];

  // A panel that is already half of a link in this patch is spoken for —
  // whether the user linked it by hand or an earlier pass did.
  const spokenFor = new Set();
  for (const link of await PatchModuleLink.findAll({
    where: { patch_id: patch.id },
    transaction,
  })) {
    spokenFor.add(link.a_patch_module_id);
    spokenFor.add(link.b_patch_module_id);
  }
  const free = (moduleId) =>
    live.filter((pm) => pm.module_id === moduleId && !spokenFor.has(pm.id));

  const created = [];
  for (const bridge of bridges) {
    if (bridge.jacks.length === 0) continue;
    const pairs = [];
    if (bridge.a_module_id === bridge.b_module_id) {
      // One record racked twice: instances 1 & 2 are the two halves, 3 & 4
      // the next pair. An odd panel out waits for its partner.
      const instances = free(bridge.a_module_id);
      for (let i = 0; i + 1 < instances.length; i += 2) {
        pairs.push([instances[i], instances[i + 1]]);
      }
    } else {
      const a = free(bridge.a_module_id);
      const b = free(bridge.b_module_id);
      for (let i = 0; i < Math.min(a.length, b.length); i += 1) pairs.push([a[i], b[i]]);
    }
    for (const [a, b] of pairs) {
      spokenFor.add(a.id);
      spokenFor.add(b.id);
      const link = await PatchModuleLink.create(
        {
          patch_id: patch.id,
          a_patch_module_id: a.id,
          b_patch_module_id: b.id,
          kind: 'bridge',
          description: bridge.description,
        },
        { transaction }
      );
      await PatchModuleLinkJack.bulkCreate(
        bridge.jacks.map((j) => ({ ...j, link_id: link.id })),
        { transaction }
      );
      created.push(link);
    }
  }
  return created;
}
