// A patch as a file: written out as JSON, and read back in — here or on
// somebody else's install.
//
// The database stores a patch against ids: which module record an instance is,
// which component row a cable end is. None of those ids mean anything anywhere
// else, so the document is written entirely in NAMES — manufacturer and model
// for an instance, the jack's label for a cable end — and the instances are
// numbered within the document so cables, settings and links have something
// short to point at.
//
// Reading one back resolves those names against the modules the importing user
// actually has, and what it cannot resolve it keeps as a name. That is not a
// fallback bolted on here: patch_modules.module_id and the component ids on
// cables are nullable exactly so a patch survives modules it cannot see, which
// is what makes a patch from a stranger's rack render at all.

export const PATCH_FORMAT = 'eurorack-assistant.patch';
export const PATCH_FORMAT_VERSION = 1;

// A document arrives from outside. These are what stop a hand-written one from
// asking the server to write a million rows.
const LIMITS = {
  modules: 500,
  ports: 200,
  cables: 4000,
  settings: 4000,
  groups: 200,
  links: 500,
  jacks: 200,
  text: 500,
  body: 4000,
};

const JACK_TYPES = ['input_jack', 'output_jack', 'bidirectional_jack'];
const LINK_KINDS = ['expander', 'bridge'];

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportPatchDocument(db, patch) {
  const {
    PatchModule,
    PatchCable,
    PatchSetting,
    PatchGroup,
    PatchModulePort,
    PatchModuleLink,
    PatchModuleLinkJack,
  } = db.models;
  const where = { patch_id: patch.id };
  const [modules, cables, settings, groups, links] = await Promise.all([
    PatchModule.findAll({ where, order: [['id', 'ASC']] }),
    PatchCable.findAll({ where, order: [['id', 'ASC']] }),
    PatchSetting.findAll({ where, order: [['id', 'ASC']] }),
    PatchGroup.findAll({ where, order: [['position', 'ASC'], ['id', 'ASC']] }),
    PatchModuleLink.findAll({ where, order: [['id', 'ASC']] }),
  ]);
  const ports = modules.length
    ? await PatchModulePort.findAll({
        where: { patch_module_id: modules.map((m) => m.id) },
        order: [['position', 'ASC'], ['id', 'ASC']],
      })
    : [];
  const jacks = links.length
    ? await PatchModuleLinkJack.findAll({
        where: { link_id: links.map((l) => l.id) },
        order: [['id', 'ASC']],
      })
    : [];

  // Instances are numbered from 1 in the order they appear; everything that
  // refers to an instance refers to that number.
  const refs = new Map(modules.map((m, at) => [m.id, at + 1]));
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));

  return {
    format: PATCH_FORMAT,
    version: PATCH_FORMAT_VERSION,
    patch: {
      name: patch.name,
      description: patch.description ?? null,
      // The rack the patch was built against, by name — an id would be
      // meaningless in another account.
      rack_name: patch.rack_name,
      groups: groups.map((g) => ({
        name: g.name,
        description: g.description ?? null,
        position: g.position,
      })),
      modules: modules.map((m) => ({
        ref: refs.get(m.id),
        manufacturer: m.manufacturer,
        module_name: m.module_name,
        instance: m.instance,
        label: m.label ?? null,
        group: m.group_id === null ? null : (groupNames.get(m.group_id) ?? null),
        external: Boolean(m.external),
        ports: ports
          .filter((p) => p.patch_module_id === m.id)
          .map((p) => ({
            name: p.name,
            type: p.type,
            port_kind: p.port_kind ?? null,
            description: p.description ?? null,
            position: p.position,
          })),
      })),
      cables: cables.map((c) => ({
        from: { module: refs.get(c.from_patch_module_id) ?? null, jack: c.from_component_name },
        to: { module: refs.get(c.to_patch_module_id) ?? null, jack: c.to_component_name },
        note: c.note ?? null,
        optional: Boolean(c.optional),
        stacked: Boolean(c.stacked),
        alt_group: c.alt_group ?? null,
      })),
      settings: settings.map((s) => ({
        module: refs.get(s.patch_module_id) ?? null,
        control: s.component_name,
        value: s.value,
      })),
      links: links.map((l) => ({
        a: refs.get(l.a_patch_module_id) ?? null,
        b: refs.get(l.b_patch_module_id) ?? null,
        kind: l.kind,
        description: l.description ?? null,
        jacks: jacks
          .filter((j) => j.link_id === l.id)
          .map((j) => ({ a: j.a_component_name, b: j.b_component_name })),
      })),
    },
  };
}

// What the browser should call the downloaded file.
export function patchFileName(patch) {
  const stem = String(patch.name || 'patch')
    .replace(/[^A-Za-z0-9._ -]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${stem || 'patch'}.patch.json`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

// Everything below treats the document as hostile: it came out of a file.

class DocumentError extends Error {}
const fail = (message) => {
  throw new DocumentError(message);
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A required string, trimmed and length-capped.
function text(value, label, { max = LIMITS.text, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${label} is required`);
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') fail(`${label} must be text`);
  const out = String(value).trim().slice(0, max);
  if (!out && required) fail(`${label} is required`);
  return out || null;
}

function list(value, label, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${label} must be a list`);
  if (value.length > max) fail(`${label} has more than ${max} entries`);
  return value;
}

const integer = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
};

// The document, checked into a shape the writer below can trust. Kept apart
// from the writing so a bad file is rejected before anything is created.
export function parsePatchDocument(input) {
  if (!isObject(input)) fail('not a patch document');
  // A bare patch body is accepted too, so a document pasted without its
  // envelope still reads.
  const envelope = isObject(input.patch) ? input : { patch: input };
  if (input.format !== undefined && input.format !== PATCH_FORMAT) {
    fail(`unknown format '${String(input.format).slice(0, 60)}'`);
  }
  if (input.version !== undefined && integer(input.version, -1) > PATCH_FORMAT_VERSION) {
    fail(`this file was written by a newer version (${input.version}) of the app`);
  }
  const body = envelope.patch;
  if (!isObject(body)) fail('not a patch document');

  const groups = list(body.groups, 'groups', LIMITS.groups).map((g, at) => {
    if (!isObject(g)) fail('every group must be an object');
    return {
      name: text(g.name, `group ${at + 1} name`),
      description: text(g.description, 'group description', { required: false }),
      position: integer(g.position, at),
    };
  });

  const seenRefs = new Set();
  const modules = list(body.modules, 'modules', LIMITS.modules).map((m, at) => {
    if (!isObject(m)) fail('every module must be an object');
    const ref = integer(m.ref, at + 1);
    if (seenRefs.has(ref)) fail(`two modules share the reference ${ref}`);
    seenRefs.add(ref);
    const groupName = text(m.group, 'module group', { required: false });
    if (groupName && !groups.some((g) => g.name === groupName)) {
      fail(`module ${at + 1} is in a bus '${groupName}' the file does not define`);
    }
    return {
      ref,
      manufacturer: text(m.manufacturer, `module ${at + 1} manufacturer`, { required: false }) ?? '',
      module_name: text(m.module_name ?? m.name, `module ${at + 1} name`),
      instance: Math.max(1, integer(m.instance, 1)),
      label: text(m.label, 'module label', { required: false }),
      group: groupName,
      external: Boolean(m.external),
      ports: list(m.ports, `module ${at + 1} ports`, LIMITS.ports).map((p, pat) => {
        if (!isObject(p)) fail('every port must be an object');
        const type = text(p.type, 'port type', { required: false }) ?? 'input_jack';
        if (!JACK_TYPES.includes(type)) fail(`port type must be one of ${JACK_TYPES.join(', ')}`);
        return {
          name: text(p.name, 'port name'),
          type,
          port_kind: text(p.port_kind, 'port kind', { required: false }),
          description: text(p.description, 'port description', { required: false }),
          position: integer(p.position, pat),
        };
      }),
    };
  });

  // A reference that points at no instance is the one thing that cannot be
  // repaired on the way in, so it is refused rather than guessed at.
  const end = (value, label) => {
    if (!isObject(value)) fail(`${label} must be an object`);
    const ref = integer(value.module, -1);
    if (!seenRefs.has(ref)) fail(`${label} refers to module ${value.module}, which is not in the file`);
    return { module: ref, jack: text(value.jack ?? value.component, `${label} jack`) };
  };

  const cables = list(body.cables, 'cables', LIMITS.cables).map((c, at) => {
    if (!isObject(c)) fail('every cable must be an object');
    return {
      from: end(c.from, `cable ${at + 1} 'from'`),
      to: end(c.to, `cable ${at + 1} 'to'`),
      note: text(c.note, 'cable note', { required: false, max: LIMITS.body }),
      optional: Boolean(c.optional),
      stacked: Boolean(c.stacked),
      alt_group: text(c.alt_group, 'cable alt_group', { required: false }),
    };
  });

  const settings = list(body.settings, 'settings', LIMITS.settings).map((s, at) => {
    if (!isObject(s)) fail('every setting must be an object');
    const ref = integer(s.module, -1);
    if (!seenRefs.has(ref)) fail(`setting ${at + 1} refers to a module that is not in the file`);
    return {
      module: ref,
      control: text(s.control ?? s.component, `setting ${at + 1} control`),
      value: text(s.value, `setting ${at + 1} value`, { max: LIMITS.body }),
    };
  });

  const links = list(body.links, 'links', LIMITS.links).map((l, at) => {
    if (!isObject(l)) fail('every link must be an object');
    const a = integer(l.a, -1);
    const b = integer(l.b, -1);
    if (!seenRefs.has(a) || !seenRefs.has(b)) {
      fail(`link ${at + 1} joins a module that is not in the file`);
    }
    if (a === b) fail(`link ${at + 1} joins an instance to itself`);
    const kind = text(l.kind, 'link kind', { required: false }) ?? 'expander';
    if (!LINK_KINDS.includes(kind)) fail(`link kind must be one of ${LINK_KINDS.join(', ')}`);
    return {
      a,
      b,
      kind,
      description: text(l.description, 'link description', { required: false }),
      jacks: list(l.jacks, `link ${at + 1} jacks`, LIMITS.jacks).map((j) => {
        if (!isObject(j)) fail('every linked jack must be an object');
        return { a: text(j.a, 'linked jack name'), b: text(j.b, 'linked jack name') };
      }),
    };
  });

  return {
    name: text(body.name, 'patch name', { required: false }),
    description: text(body.description, 'patch description', { required: false, max: LIMITS.body }),
    rack_name: text(body.rack_name, 'rack name', { required: false }),
    groups,
    modules,
    cables,
    settings,
    links,
  };
}

// Which of the user's modules the document's instances mean. Only modules the
// user actually has are resolved: a name that matches a module record they do
// not own stays a name, so importing a patch never quietly hands anybody a
// module they have not imported.
async function resolveModules(db, userId, documentModules) {
  const { Module, Rack, RackModule, ModuleComponent } = db.models;
  const key = (manufacturer, name) =>
    `${String(manufacturer ?? '').trim().toLowerCase()}|${String(name ?? '').trim().toLowerCase()}`;

  const wanted = new Set(documentModules.map((m) => key(m.manufacturer, m.module_name)));
  const mappings = await RackModule.findAll({
    include: [
      { model: Rack, where: { user_id: userId }, attributes: [] },
      { model: Module, attributes: ['id', 'manufacturer', 'name'] },
    ],
  });
  const byName = new Map();
  for (const rm of mappings) {
    if (!rm.Module) continue;
    const k = key(rm.Module.manufacturer, rm.Module.name);
    if (wanted.has(k) && !byName.has(k)) byName.set(k, rm.Module.id);
  }

  // The components of every module that resolved, so cable ends and settings
  // can be matched to real rows by name.
  const moduleIds = [...new Set(byName.values())];
  const components = moduleIds.length
    ? await ModuleComponent.findAll({
        where: { module_id: moduleIds },
        attributes: ['id', 'module_id', 'name'],
      })
    : [];
  const componentsByModule = new Map();
  for (const c of components) {
    if (!componentsByModule.has(c.module_id)) componentsByModule.set(c.module_id, new Map());
    // First writer wins, so a module with two identically named jacks
    // resolves to the first rather than the last.
    const names = componentsByModule.get(c.module_id);
    const lower = c.name.trim().toLowerCase();
    if (!names.has(lower)) names.set(lower, c.id);
  }

  return documentModules.map((m) => {
    // Off-rack gear declares its own connection points and never stands for a
    // module record, however it happens to be named.
    const moduleId = m.external ? null : (byName.get(key(m.manufacturer, m.module_name)) ?? null);
    return {
      ...m,
      module_id: moduleId,
      components: moduleId === null ? new Map() : (componentsByModule.get(moduleId) ?? new Map()),
    };
  });
}

// Write a parsed document as a patch belonging to userId. `rack` is the user's
// rack the patch should be filed against, or null to keep the document's rack
// name and no rack.
export async function importPatchDocument(db, { userId, document, rack = null, name = null }) {
  const {
    Patch,
    PatchModule,
    PatchCable,
    PatchSetting,
    PatchGroup,
    PatchModulePort,
    PatchModuleLink,
    PatchModuleLinkJack,
  } = db.models;

  const resolved = await resolveModules(db, userId, document.modules);
  const byRef = new Map(resolved.map((m) => [m.ref, m]));

  let patch;
  await db.sequelize.transaction(async (transaction) => {
    patch = await Patch.create(
      {
        user_id: userId,
        rack_id: rack?.id ?? null,
        rack_name: rack?.name ?? document.rack_name ?? 'imported patch',
        name: name || document.name || 'Imported patch',
        description: document.description,
      },
      { transaction }
    );

    // Buses first: instances point at them.
    const groupIds = new Map();
    for (const g of document.groups) {
      const created = await PatchGroup.create({ ...g, patch_id: patch.id }, { transaction });
      groupIds.set(g.name, created.id);
    }

    // Instances, then the connection points declared on them.
    const rowIds = new Map();
    const portIds = new Map();
    for (const m of resolved) {
      const created = await PatchModule.create(
        {
          patch_id: patch.id,
          module_id: m.module_id,
          manufacturer: m.manufacturer,
          module_name: m.module_name,
          instance: m.instance,
          label: m.label,
          external: m.external,
          group_id: m.group === null ? null : (groupIds.get(m.group) ?? null),
        },
        { transaction }
      );
      rowIds.set(m.ref, created.id);
      const ports = new Map();
      for (const p of m.ports) {
        const port = await PatchModulePort.create(
          { ...p, patch_module_id: created.id },
          { transaction }
        );
        ports.set(p.name.trim().toLowerCase(), port.id);
      }
      portIds.set(m.ref, ports);
    }

    // A jack name against one instance: the component row when the instance is
    // a module this user has, the declared port when it is not, and nothing at
    // all when the name matches neither — in which case the name alone is what
    // the patch shows, which is exactly what it does for a module that was
    // deleted underneath it.
    const jackId = (ref, jackName) => {
      const lower = String(jackName ?? '').trim().toLowerCase();
      const m = byRef.get(ref);
      if (!m) return null;
      if (m.module_id !== null) return m.components.get(lower) ?? null;
      return portIds.get(ref)?.get(lower) ?? null;
    };

    for (const c of document.cables) {
      await PatchCable.create(
        {
          patch_id: patch.id,
          from_patch_module_id: rowIds.get(c.from.module),
          from_component_id: jackId(c.from.module, c.from.jack),
          from_component_name: c.from.jack,
          to_patch_module_id: rowIds.get(c.to.module),
          to_component_id: jackId(c.to.module, c.to.jack),
          to_component_name: c.to.jack,
          note: c.note,
          optional: c.optional,
          stacked: c.stacked,
          alt_group: c.alt_group,
        },
        { transaction }
      );
    }

    for (const s of document.settings) {
      await PatchSetting.create(
        {
          patch_id: patch.id,
          patch_module_id: rowIds.get(s.module),
          component_id: jackId(s.module, s.control),
          component_name: s.control,
          value: s.value,
        },
        { transaction }
      );
    }

    for (const l of document.links) {
      const created = await PatchModuleLink.create(
        {
          patch_id: patch.id,
          a_patch_module_id: rowIds.get(l.a),
          b_patch_module_id: rowIds.get(l.b),
          kind: l.kind,
          description: l.description,
        },
        { transaction }
      );
      for (const j of l.jacks) {
        await PatchModuleLinkJack.create(
          {
            link_id: created.id,
            a_component_id: jackId(l.a, j.a),
            a_component_name: j.a,
            b_component_id: jackId(l.b, j.b),
            b_component_name: j.b,
          },
          { transaction }
        );
      }
    }
  });

  // What the importer could not place. Not an error — the patch renders by
  // name — but the one thing the person doing it needs to be told.
  const unresolved = resolved
    .filter((m) => !m.external && m.module_id === null)
    .map((m) => `${m.manufacturer} ${m.module_name}`.trim());

  return {
    patch,
    counts: {
      modules: resolved.length,
      cables: document.cables.length,
      settings: document.settings.length,
      groups: document.groups.length,
      links: document.links.length,
    },
    unresolved_modules: [...new Set(unresolved)],
  };
}

export { DocumentError };
