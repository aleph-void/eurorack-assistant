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

// Which mult section each bidirectional jack of one instance is DEFINITELY
// in, as a lookup over that instance's components.
//
// Usually that is simply the label on the jack. On a SWITCHED multiple
// (component_mult_groups — an A-182-1's per-jack bus toggles) the section
// depends on a control, so it is only definite while the patch records that
// control at a position that puts the jack on a bus. Anything else — the
// toggle not recorded, or recorded at a position that takes the jack off the
// buses — answers null, and null never refuses a cable: these rules bite on
// what is certainly illegal, not on what cannot yet be known.
export async function multGroupResolver(db, patch, pm) {
  const { ComponentMultGroup, PatchSetting } = db.models;
  const rowsByComponent = new Map();
  if (pm.module_id) {
    const rows = await ComponentMultGroup.findAll({ where: { module_id: pm.module_id } });
    for (const row of rows) {
      if (!rowsByComponent.has(row.component_id)) rowsByComponent.set(row.component_id, []);
      rowsByComponent.get(row.component_id).push(row);
    }
  }
  const settingOf = new Map();
  if (rowsByComponent.size > 0) {
    const settings = await PatchSetting.findAll({
      where: { patch_id: patch.id, patch_module_id: pm.id },
    });
    // A menu parameter's value is not the position of a control.
    for (const s of settings) {
      if (!s.parameter_id) settingOf.set(s.component_id, s.value);
    }
  }
  const same = (a, b) =>
    String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  return (component) => {
    const rows = rowsByComponent.get(component.id);
    if (!rows || rows.length === 0) return (component.group_label || '').trim().toLowerCase();
    for (const row of rows) {
      const recorded = settingOf.get(row.condition_component_id);
      if (recorded === undefined || !same(recorded, row.condition_value)) continue;
      const label = String(row.group_label ?? '').trim();
      // The control is at this position: either it names a bus, or it takes
      // the jack off them all.
      return label ? label.toLowerCase() : null;
    }
    return null;
  };
}

// Every bridged jack of a patch, mapped to the jack at the OTHER end of its
// wire. A bridge — the two panels of a dual module, joined by a link cable
// rather than by patch cables — pairs jacks one to one, so this is both the
// list of jacks exempt from the mult rules (a 7Path's jacks are
// interchangeable but they are not copies of each other) and what says which
// jack a signal patched into one panel comes out of.
//
// Keyed by component id AND by jack name, because a link's jack rows keep
// both and the id half goes null on anything imported against a module whose
// components could not be resolved.
export async function bridgePartners(db, patch) {
  const { PatchModuleLink, PatchModuleLinkJack } = db.models;
  const links = await PatchModuleLink.findAll({
    where: { patch_id: patch.id, kind: 'bridge' },
  });
  const partners = new Map();
  if (links.length === 0) return partners;
  const jacks = await PatchModuleLinkJack.findAll({
    where: { link_id: links.map((l) => l.id) },
  });
  const linkById = new Map(links.map((l) => [l.id, l]));
  const add = (pmId, componentId, name, partner) => {
    if (componentId !== null && componentId !== undefined) {
      partners.set(`${pmId}:c${componentId}`, partner);
    }
    const key = String(name ?? '').trim().toLowerCase();
    if (key) partners.set(`${pmId}:n${key}`, partner);
  };
  for (const j of jacks) {
    const link = linkById.get(j.link_id);
    if (!link) continue;
    const a = {
      patch_module_id: link.a_patch_module_id,
      component_id: j.a_component_id,
      name: j.a_component_name,
    };
    const b = {
      patch_module_id: link.b_patch_module_id,
      component_id: j.b_component_id,
      name: j.b_component_name,
    };
    add(a.patch_module_id, a.component_id, a.name, b);
    add(b.patch_module_id, b.component_id, b.name, a);
  }
  return partners;
}

// Every jack of one instance that sits on a bridged wire. Like switch jacks
// these are exempt from the mult rules: a bridge pairs jacks one to one, so
// several jacks of one panel legitimately take cables.
export function bridgedIdsOf(partners, pmId) {
  const ids = new Set();
  const prefix = `${pmId}:c`;
  for (const key of partners.keys()) {
    if (key.startsWith(prefix)) ids.add(Number(key.slice(prefix.length)));
  }
  return ids;
}

// The far end of the wire one jack of a patch sits on, or null when the jack
// is not bridged at all.
export function bridgePartnerOf(partners, pm, component) {
  return (
    partners.get(`${pm.id}:c${component.id}`) ??
    partners.get(`${pm.id}:n${String(component.name ?? '').trim().toLowerCase()}`) ??
    null
  );
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
  // The interchangeable jacks of one mult section: same instance, same
  // section (ungrouped bidirectional jacks count as one). On a switched
  // multiple the section is whichever the recorded control positions put the
  // jack on, and null where they do not say.
  const fromGroupKey = await multGroupResolver(db, patch, from.pm);
  const toGroupKey =
    from.pm.id === to.pm.id ? fromGroupKey : await multGroupResolver(db, patch, to.pm);
  // A dual module's two panels: which jack each end of a cable is wired to on
  // the other panel, when it is wired to one at all.
  const partners = await bridgePartners(db, patch);
  const fromPartner = bridgePartnerOf(partners, from.pm, from.component);
  const toPartner = bridgePartnerOf(partners, to.pm, to.component);
  // Switch-section and bridged jacks opt out of every mult rule below.
  const exemptJacks = async (end) => {
    if (end.component.type !== BIDIRECTIONAL) return new Set();
    const ids = await switchMemberIds(db, end.pm.module_id);
    for (const id of bridgedIdsOf(partners, end.pm.id)) ids.add(id);
    return ids;
  };
  const fromSwitchJacks = await exemptJacks(from);
  const toSwitchJacks = await exemptJacks(to);
  const sameMultGroup = (a, b) => {
    if (a.type !== BIDIRECTIONAL || b.type !== BIDIRECTIONAL) return false;
    if (fromSwitchJacks.has(a.id) || toSwitchJacks.has(b.id)) return false;
    const ka = fromGroupKey(a);
    const kb = toGroupKey(b);
    return ka !== null && kb !== null && ka === kb;
  };
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
  // Dual-module rules. A bridged wire carries ONE signal in ONE direction:
  // the end a cable is patched into is the input, and the matching jack on
  // the OPPOSITE panel is where it comes out. So a wire takes a cable in at
  // one end only, and neither end is an input and an output at once.
  const cabledInto = (end) =>
    existing.some(
      (c) => c.to_patch_module_id === end.patch_module_id && c.to_component_id === end.component_id
    );
  const cabledOutOf = (end) =>
    existing.some(
      (c) =>
        c.from_patch_module_id === end.patch_module_id && c.from_component_id === end.component_id
    );
  if (fromPartner && toPartner) {
    const sameWire =
      fromPartner.patch_module_id === to.pm.id && fromPartner.component_id === to.component.id;
    if (sameWire) {
      return {
        status: 400,
        error: 'these two jacks are the two ends of one bridged wire — that cable does nothing',
      };
    }
  }
  if (toPartner) {
    if (cabledInto(toPartner)) {
      return {
        status: 409,
        error: `the other panel's '${toPartner.name}' is already the input of that bridged wire — its signal comes out here`,
      };
    }
    if (cabledOutOf({ patch_module_id: to.pm.id, component_id: to.component.id })) {
      return {
        status: 409,
        error: `'${to.component.name}' is already carrying the bridged signal out — the input goes into '${toPartner.name}' on the other panel`,
      };
    }
  }
  if (
    fromPartner &&
    cabledInto({ patch_module_id: from.pm.id, component_id: from.component.id })
  ) {
    return {
      status: 409,
      error: `'${from.component.name}' is the input end of that bridged wire — the signal comes out of '${fromPartner.name}' on the other panel`,
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
    // Which section this jack is on can be a fact the patch has not recorded
    // (a switched multiple whose bus toggle is not dialed in). Then there is
    // no group to be the second input of, and the cable stands.
    const key = toGroupKey(to.component);
    if (key !== null) {
      const groupJacks = (await componentsOfPatchModule(db, to.pm)).filter(
        (j) => j.type === BIDIRECTIONAL && !toSwitchJacks.has(j.id) && toGroupKey(j) === key
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
