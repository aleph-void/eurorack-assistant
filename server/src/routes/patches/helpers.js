import { Op } from 'sequelize';
import { componentJson, portJson } from '../../services/patchDetail.js';

// Helpers shared by the /api/patches sub-routers. Each takes db explicitly so
// the sub-routers stay plain factory functions over it.

// A jack with no port_kind is an ordinary eurorack 3.5mm patch point; a
// cable only ever joins two connections of the same kind.
export const portKind = (component) => component.port_kind || 'eurorack';

export function ownPatch(db, userId, id) {
  const { Patch } = db.models;
  return Patch.findOne({ where: { id: Number(id) || 0, user_id: userId } });
}

export function ownPatchModule(db, patch, patchModuleId) {
  const { PatchModule } = db.models;
  return PatchModule.findOne({
    where: { id: Number(patchModuleId) || 0, patch_id: patch.id },
  });
}

// The jacks of a module that belong to one of its routing switch sections
// (common or step). Switch jacks are exempt from the mult rules: an N→1
// switch legitimately takes cables into several jacks of the section —
// only one is live at a time, chosen by the switch, not by the patch.
export async function switchMemberIds(db, moduleId) {
  const { ComponentSwitch, ComponentSwitchStep } = db.models;
  if (!moduleId) return new Set();
  const sections = await ComponentSwitch.findAll({ where: { module_id: moduleId } });
  const ids = new Set(sections.map((s) => s.common_component_id));
  if (sections.length > 0) {
    const steps = await ComponentSwitchStep.findAll({
      where: { switch_id: sections.map((s) => s.id) },
    });
    for (const st of steps) ids.add(st.component_id);
  }
  return ids;
}

// The jacks of an instance that are bridged to another instance. Like
// switch jacks, these are exempt from the mult rules: a bridge pairs jacks
// one to one, so several jacks of one panel legitimately take cables — a
// 7Path's jacks are interchangeable but they are not copies of each other.
export async function bridgeMemberIds(db, patch, patchModuleId) {
  const { PatchModuleLink, PatchModuleLinkJack } = db.models;
  const links = await PatchModuleLink.findAll({
    where: {
      patch_id: patch.id,
      kind: 'bridge',
      [Op.or]: [{ a_patch_module_id: patchModuleId }, { b_patch_module_id: patchModuleId }],
    },
  });
  if (links.length === 0) return new Set();
  const jacks = await PatchModuleLinkJack.findAll({
    where: { link_id: links.map((l) => l.id) },
  });
  const linkById = new Map(links.map((l) => [l.id, l]));
  const ids = new Set();
  for (const j of jacks) {
    const link = linkById.get(j.link_id);
    if (link.a_patch_module_id === patchModuleId) ids.add(j.a_component_id);
    if (link.b_patch_module_id === patchModuleId) ids.add(j.b_component_id);
  }
  return ids;
}

// Every jack of one instance: an analyzed module's components, or the
// connection points the patch declares on it.
export async function componentsOfPatchModule(db, pm) {
  const { ModuleComponent, PatchModulePort } = db.models;
  if (pm.module_id) {
    const rows = await ModuleComponent.findAll({ where: { module_id: pm.module_id } });
    if (rows.length > 0) return rows.map((c) => componentJson(c));
  }
  const ports = await PatchModulePort.findAll({ where: { patch_module_id: pm.id } });
  return ports.map((p) => portJson(p));
}

// A patch_modules row of this patch, with the component (when given)
// verified to be one of that instance's connection points.
export async function resolveEndpoint(db, patch, patchModuleId, componentId) {
  const { PatchModule } = db.models;
  const pm = await PatchModule.findOne({
    where: { id: Number(patchModuleId) || 0, patch_id: patch.id },
  });
  if (!pm) return { error: 'that module is not part of this patch' };
  const jacks = await componentsOfPatchModule(db, pm);
  const component = jacks.find((c) => c.id === (Number(componentId) || 0));
  if (!component) return { error: 'that component does not belong to this module' };
  return { pm, component };
}

// Everything that makes one cable legal, given the cables already patched.
// Returns null when the cable is fine, or { status, error }.
export async function cableProblem(db, patch, from, to, existing) {
  const BIDIRECTIONAL = 'bidirectional_jack';
  if (from.component.type !== 'output_jack' && from.component.type !== BIDIRECTIONAL) {
    return { status: 400, error: 'a cable must start at an output or mult jack' };
  }
  if (to.component.type !== 'input_jack' && to.component.type !== BIDIRECTIONAL) {
    return { status: 400, error: 'a cable must end at an input or mult jack' };
  }
  // A MIDI socket, a USB port and a 3.5mm patch point do not connect to
  // each other; patch a piece of gear in between instead.
  if (portKind(from.component) !== portKind(to.component)) {
    return {
      status: 400,
      error: `'${from.component.name}' is a ${portKind(from.component).replace(/_/g, ' ')} connection and '${to.component.name}' is a ${portKind(to.component).replace(/_/g, ' ')} one — a cable cannot join them`,
    };
  }
  // The interchangeable jacks of one mult section: same module, same group
  // label (ungrouped bidirectional jacks count as one group).
  const groupKey = (c) => (c.group_label || '').trim().toLowerCase();
  // Switch-section and bridged jacks opt out of every mult rule below.
  const exemptJacks = async (end) => {
    if (end.component.type !== BIDIRECTIONAL) return new Set();
    const ids = await switchMemberIds(db, end.pm.module_id);
    for (const id of await bridgeMemberIds(db, patch, end.pm.id)) ids.add(id);
    return ids;
  };
  const fromSwitchJacks = await exemptJacks(from);
  const toSwitchJacks = await exemptJacks(to);
  const sameMultGroup = (a, b) =>
    a.type === BIDIRECTIONAL &&
    b.type === BIDIRECTIONAL &&
    !fromSwitchJacks.has(a.id) &&
    !toSwitchJacks.has(b.id) &&
    groupKey(a) === groupKey(b);
  if (from.pm.id === to.pm.id && sameMultGroup(from.component, to.component)) {
    return {
      status: 400,
      error: 'both jacks belong to the same mult group — that cable does nothing',
    };
  }
  // An input takes exactly one cable; the same output may fan out via
  // multiples/stackcables, but not twice into the same input.
  const inputTaken = existing.some(
    (c) => c.to_patch_module_id === to.pm.id && c.to_component_id === to.component.id
  );
  if (inputTaken) {
    return {
      status: 409,
      error: `'${to.component.name}' on ${to.pm.manufacturer} ${to.pm.module_name} already has a cable in it`,
    };
  }
  // Mult rules. Cabling INTO a bidirectional jack makes it its group's
  // input, so the jack must not already carry a copy out, and the group
  // must not already have an input on another jack.
  if (to.component.type === BIDIRECTIONAL && !toSwitchJacks.has(to.component.id)) {
    if (
      existing.some(
        (c) => c.from_patch_module_id === to.pm.id && c.from_component_id === to.component.id
      )
    ) {
      return {
        status: 409,
        error: `'${to.component.name}' is already carrying a copy out of the mult`,
      };
    }
    const groupJacks = (await componentsOfPatchModule(db, to.pm)).filter(
      (j) =>
        j.type === BIDIRECTIONAL &&
        !toSwitchJacks.has(j.id) &&
        groupKey(j) === groupKey(to.component)
    );
    const groupIds = new Set(groupJacks.map((j) => j.id));
    const groupInput = existing.find(
      (c) => c.to_patch_module_id === to.pm.id && groupIds.has(c.to_component_id)
    );
    if (groupInput) {
      return {
        status: 409,
        error: `this mult group already takes its input at '${groupInput.to_component_name}'`,
      };
    }
  }
  // ... and cabling OUT of one only works while the jack is not already
  // the group's input.
  if (
    from.component.type === BIDIRECTIONAL &&
    !fromSwitchJacks.has(from.component.id) &&
    existing.some(
      (c) => c.to_patch_module_id === from.pm.id && c.to_component_id === from.component.id
    )
  ) {
    return {
      status: 409,
      error: `'${from.component.name}' is already the mult group's input — copies come out of the other jacks`,
    };
  }
  return null;
}

// The other half of a stereo (or other) pair: the jack that carries the
// signal's second half on the same instance.
export async function pairedJack(db, pm, component) {
  const { ComponentPair } = db.models;
  if (!pm.module_id) return null;
  const pairs = await ComponentPair.findAll({ where: { module_id: pm.module_id } });
  const pair = pairs.find(
    (p) => p.a_component_id === component.id || p.b_component_id === component.id
  );
  if (!pair) return null;
  const otherId = pair.a_component_id === component.id ? pair.b_component_id : pair.a_component_id;
  const jacks = await componentsOfPatchModule(db, pm);
  return jacks.find((c) => c.id === otherId) ?? null;
}

// Route middleware: load the patch under req.params.id if the requesting
// user owns it, 404 otherwise. Every /:id route that operates on a patch
// goes through this — except GET /:id, which also accepts shared patches
// via readableResource. "Forgot the ownership check" cannot happen.
export function requireOwnedPatch(db) {
  return (req, res, next) => {
    ownPatch(db, req.user.id, req.params.id)
      .then((patch) => {
        if (!patch) return res.status(404).json({ error: 'Patch not found' });
        req.patch = patch;
        next();
      })
      .catch(next);
  };
}
