// Turning what a manual said about ANOTHER panel into rows, once that becomes
// possible.
//
// Analysis is per module, but manuals are per instrument: one PDF describes a
// host and its expander, and the signal paths it describes run between the
// two panels. At the moment the host is analyzed, the expander's module record
// may not be imported, may not be analyzed, and is certainly not linked — so
// those paths are stored by name as module_path_hints instead of being thrown
// away, and this module resolves them whenever the situation changes:
//
//   - after any analysis (of either panel), and
//   - when a user links two modules by hand.
//
// Resolution is idempotent and re-runnable by design. Re-analyzing a panel
// rewrites its components under fresh ids, which cascades away every resolved
// cross-panel row pointing at them; the hints survive that, so the next pass
// puts the rows back.

import { Op } from 'sequelize';
import { normalizationKind } from './manualAnalyzer.js';

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Words that mark a module record as somebody's expander: "Quad Operator Algo
// Extension", "Bohm Groove Sequence Expander".
const EXPANDER_WORDS = ['expander', 'expansion', 'extension'];

const parseHint = (row) => {
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
};

// Every module id wired to this one by a declared expander link.
export async function linkedModuleIds(db, moduleId) {
  const { ModuleExpander } = db.models;
  const rows = await ModuleExpander.findAll({
    where: { [Op.or]: [{ host_module_id: moduleId }, { expander_module_id: moduleId }] },
  });
  const ids = new Set([moduleId]);
  for (const row of rows) {
    ids.add(row.host_module_id);
    ids.add(row.expander_module_id);
  }
  return [...ids];
}

// The module a panel name refers to. Manuals write "Atlx" where the record
// says "Intellijel Atlx", so both the bare name and the manufacturer-prefixed
// one count; a module from the same manufacturer wins a tie.
function matchPanel(panel, modules, { manufacturer } = {}) {
  const wanted = normalize(panel);
  if (!wanted) return null;
  const matches = modules.filter(
    (m) => normalize(m.name) === wanted || normalize(`${m.manufacturer} ${m.name}`) === wanted
  );
  if (matches.length === 0) return null;
  return matches.find((m) => normalize(m.manufacturer) === normalize(manufacturer)) ?? matches[0];
}

async function linkExists(db, a, b) {
  const { ModuleExpander } = db.models;
  return ModuleExpander.findOne({
    where: {
      [Op.or]: [
        { host_module_id: a, expander_module_id: b },
        { host_module_id: b, expander_module_id: a },
      ],
    },
  });
}

async function createLink(db, hostId, expanderId, description) {
  if (hostId === expanderId) return null;
  if (await linkExists(db, hostId, expanderId)) return null;
  return db.models.ModuleExpander.create({
    host_module_id: hostId,
    expander_module_id: expanderId,
    description: description || null,
  });
}

// Link module records from the panels the manuals named. Both directions are
// tried: this module's own hints, and other modules' hints that name this one
// — the second is what links a pair whose expander is imported later.
export async function linkExpandersFromHints(db, module) {
  const { Module, ModulePathHint } = db.models;
  const modules = await Module.findAll();
  const created = [];

  for (const row of await ModulePathHint.findAll({
    where: { module_id: module.id, kind: 'expander' },
  })) {
    const hint = parseHint(row);
    if (!hint?.name) continue;
    const partner = matchPanel(hint.name, modules, { manufacturer: module.manufacturer });
    if (!partner) continue;
    const link =
      hint.role === 'host'
        ? await createLink(db, partner.id, module.id, hint.description)
        : await createLink(db, module.id, partner.id, hint.description);
    if (link) created.push(link);
  }

  for (const row of await ModulePathHint.findAll({
    where: { kind: 'expander', module_id: { [Op.ne]: module.id } },
  })) {
    const hint = parseHint(row);
    if (!hint?.name) continue;
    const owner = modules.find((m) => m.id === row.module_id);
    if (!owner) continue;
    if (matchPanel(hint.name, [module], { manufacturer: owner.manufacturer })?.id !== module.id) {
      continue;
    }
    const link =
      hint.role === 'host'
        ? await createLink(db, module.id, owner.id, hint.description)
        : await createLink(db, owner.id, module.id, hint.description);
    if (link) created.push(link);
  }
  return created;
}

// Link a module whose NAME says what it is: "<base> Expander" next to
// "<base>" from the same manufacturer. Manuals do not always spell the
// relationship out, but a rack list often does.
export async function linkExpandersByName(db, module) {
  const { Module } = db.models;
  const modules = await Module.findAll();
  const sameMaker = modules.filter(
    (m) => m.id !== module.id && normalize(m.manufacturer) === normalize(module.manufacturer)
  );
  const created = [];

  // Strip a trailing expander word (and anything between it and the base
  // name) to get the host this module expands: "Quad Operator Algo Extension"
  // → "Quad Operator".
  const baseOf = (name) => {
    const tokens = normalize(name).split(' ');
    const cut = tokens.findIndex((t) => EXPANDER_WORDS.includes(t));
    return cut <= 0 ? null : tokens.slice(0, cut).join(' ');
  };

  const ownBase = baseOf(module.name);
  if (ownBase) {
    // The longest matching prefix wins, so "Quad Operator Algo Extension"
    // links to "Quad Operator" rather than to "Quad".
    const host = sameMaker
      .filter((m) => ownBase.startsWith(normalize(m.name)))
      .sort((a, b) => normalize(b.name).length - normalize(a.name).length)[0];
    if (host) {
      const link = await createLink(db, host.id, module.id, null);
      if (link) created.push(link);
    }
  }
  for (const other of sameMaker) {
    const otherBase = baseOf(other.name);
    if (otherBase && otherBase.startsWith(normalize(module.name))) {
      const link = await createLink(db, module.id, other.id, null);
      if (link) created.push(link);
    }
  }
  return created;
}

// Create the rows for every stored cross-panel path that now resolves. A hint
// whose other panel is still missing, unanalyzed or unlinked is simply left
// for a later pass.
export async function materializePathHints(db, moduleIds) {
  const { Module, ModuleComponent, ModulePathHint, ComponentRoute, ComponentNormalization } =
    db.models;
  const created = { routes: 0, normalizations: 0 };
  for (const moduleId of moduleIds) {
    const hints = await ModulePathHint.findAll({
      where: { module_id: moduleId, kind: ['route', 'normalization'] },
    });
    if (hints.length === 0) continue;
    const module = await Module.findByPk(moduleId);
    if (!module) continue;

    const partnerIds = (await linkedModuleIds(db, moduleId)).filter((id) => id !== moduleId);
    const partners = partnerIds.length ? await Module.findAll({ where: { id: partnerIds } }) : [];
    const components = await ModuleComponent.findAll({
      where: { module_id: [moduleId, ...partnerIds] },
    });
    const byModule = new Map();
    for (const c of components) {
      if (!byModule.has(c.module_id)) byModule.set(c.module_id, new Map());
      const key = c.name.trim().toLowerCase();
      if (!byModule.get(c.module_id).has(key)) byModule.get(c.module_id).set(key, c);
    }

    // A (name, panel) endpoint: no panel (or this module's own) resolves
    // against this module, anything else against the linked panel it names.
    const resolve = (name, panel) => {
      if (!name) return null;
      const target = panel
        ? (matchPanel(panel, [module], { manufacturer: module.manufacturer })
            ? module
            : matchPanel(panel, partners, { manufacturer: module.manufacturer }))
        : module;
      if (!target) return null;
      return byModule.get(target.id)?.get(name.trim().toLowerCase()) ?? null;
    };
    // A condition names a control on the panel the path was described from.
    const resolveCondition = (condition) => {
      if (!condition) return { condition_component_id: null, condition_value: null };
      const control = byModule.get(moduleId)?.get(condition.control.trim().toLowerCase());
      if (!control || control.type.endsWith('_jack')) {
        return { condition_component_id: null, condition_value: null };
      }
      return { condition_component_id: control.id, condition_value: condition.value };
    };

    const existingRoutes = await ComponentRoute.findAll({ where: { module_id: moduleId } });
    const existingNorms = await ComponentNormalization.findAll({ where: { module_id: moduleId } });

    for (const row of hints) {
      const hint = parseHint(row);
      if (!hint) continue;
      const condition = resolveCondition(hint.condition);

      if (row.kind === 'route') {
        const input = resolve(hint.input, hint.input_panel);
        const output = resolve(hint.output, hint.output_panel);
        if (!input || !output) continue;
        if (input.type !== 'input_jack' || output.type !== 'output_jack') continue;
        const duplicate = existingRoutes.some(
          (r) =>
            r.input_component_id === input.id &&
            r.output_component_id === output.id &&
            (r.condition_component_id ?? null) === condition.condition_component_id
        );
        if (duplicate) continue;
        const record = await ComponentRoute.create({
          module_id: moduleId,
          input_component_id: input.id,
          output_component_id: output.id,
          ...condition,
          alt_group: hint.alt_group ?? null,
          description: hint.description ?? null,
        });
        existingRoutes.push(record);
        created.routes += 1;
        continue;
      }

      const target = resolve(hint.target, hint.target_panel);
      if (!target) continue;
      const source = hint.source ? resolve(hint.source, hint.source_panel) : null;
      // A named source that does not resolve would silently become a label,
      // which is exactly the loss the hint exists to prevent — leave it.
      if (hint.source && !source) continue;
      if (!source && !hint.source_label) continue;
      if (source && source.id === target.id) continue;
      const breakJack = hint.break_jack ? resolve(hint.break_jack, hint.target_panel) : null;
      const breaksElsewhere = breakJack && breakJack.id !== target.id;
      const duplicate = existingNorms.some(
        (n) =>
          n.target_component_id === target.id &&
          (n.source_component_id ?? null) === (source ? source.id : null) &&
          (n.condition_component_id ?? null) === condition.condition_component_id
      );
      if (duplicate) continue;
      const record = await ComponentNormalization.create({
        module_id: moduleId,
        target_component_id: target.id,
        source_component_id: source ? source.id : null,
        source_label: source ? null : hint.source_label,
        kind: normalizationKind(source),
        ...condition,
        alt_group: hint.alt_group ?? null,
        break_component_id: breaksElsewhere ? breakJack.id : null,
        break_on: breaksElsewhere ? hint.break_on || 'cable_in' : 'cable_in',
        description: hint.description ?? null,
      });
      existingNorms.push(record);
      created.normalizations += 1;
    }
  }
  return created;
}

// The whole pass, run after an analysis or a manual link: work out which
// module records belong together, then materialize every cross-panel path
// that has become resolvable — for this module and for each panel linked to
// it, since this module may be the one another panel was waiting for.
export async function refreshModuleLinks(db, module) {
  const links = [
    ...(await linkExpandersFromHints(db, module)),
    ...(await linkExpandersByName(db, module)),
  ];
  const created = await materializePathHints(db, await linkedModuleIds(db, module.id));
  return { links: links.length, ...created };
}

// The panels a module's manual named that are still not linked to a module
// record — worth showing, because it usually means the expander has not been
// imported yet.
export async function unlinkedExpanderHints(db, module) {
  const { ModulePathHint, Module } = db.models;
  const rows = await ModulePathHint.findAll({
    where: { module_id: module.id, kind: 'expander' },
    order: [['id', 'ASC']],
  });
  if (rows.length === 0) return [];
  const modules = await Module.findAll();
  const linked = new Set(await linkedModuleIds(db, module.id));
  const suggestions = [];
  for (const row of rows) {
    const hint = parseHint(row);
    if (!hint?.name) continue;
    const partner = matchPanel(hint.name, modules, { manufacturer: module.manufacturer });
    if (partner && linked.has(partner.id)) continue;
    suggestions.push({
      name: hint.name,
      role: hint.role,
      description: hint.description ?? null,
      module_id: partner?.id ?? null,
    });
  }
  return suggestions;
}
