// Manual analysis: submit a module's manual PDF to the LLM backend and store a
// summary plus a structured inventory of the module's components (jacks,
// buttons, toggles, ...) with voltage ranges and polarity, and the normalled
// connections between them (defaults that exist until a patch cable overrides
// them) so a patch's real signal path can be traced.
//
// The vocabulary the answer is written in is services/manualVocabulary.js,
// the prompt is services/manualPrompt.js and the pure functions that turn an
// answer into rows are services/manualNormalize.js. What is left here is the
// one thing that needs a backend and a database: making the call and writing
// what came back.

import { extractJsonObject } from './json.js';
import { refreshModuleLinks } from './moduleLinks.js';
import { normalizeHp } from './panelPlacements.js';
import { ANALYSIS_TEMPLATE } from './manualPrompt.js';
import {
  normalizeComponents,
  normalizeExpanders,
  normalizeNormalizations,
  normalizePairs,
  normalizeRoutes,
  normalizeSwitches,
  panelNamesModule,
  resolveNormalizations,
  resolvePairs,
  resolveRoutes,
  resolveSwitches,
  splitByPanel,
} from './manualNormalize.js';

// Analyze one module's manual and persist summary + components +
// normalizations.
export async function analyzeManualForModule(
  db,
  backend,
  module,
  manualPaths,
  { productPage = false, buildDoc = false, retailerPages = false } = {}
) {
  const paths = Array.isArray(manualPaths) ? manualPaths : [manualPaths];
  const prompt = ANALYSIS_TEMPLATE(module.manufacturer, module.name, {
    productPage,
    buildDoc,
    retailerPages,
  });
  const response =
    paths.length > 1
      ? await backend.analyzeDocuments(prompt, paths)
      : await backend.analyzeDocument(prompt, paths[0]);
  const parsed = extractJsonObject(response);
  const summary = String(parsed.summary || '').trim();
  // The panel width, where the manual states it. This is the module's own
  // property rather than the panel drawing's, so it is written to the module
  // record; a manual that states none leaves whatever is already recorded.
  const hp = normalizeHp(parsed.hp);
  const parsedComponents = normalizeComponents(parsed.components);
  const switches = normalizeSwitches(parsed.switches);
  const pairs = normalizePairs(parsed.pairs);
  const expanders = normalizeExpanders(parsed.expanders);
  if (!summary && parsedComponents.length === 0) {
    throw new Error('LLM analysis returned neither a summary nor components');
  }

  // One manual often covers a host and its expander. Only this module's own
  // panel becomes its component inventory; a signal path that runs to the
  // other panel is kept by name and resolved once both panels are analyzed
  // and linked.
  const { own: components, panelsUsable } = splitByPanel(parsedComponents, module);
  const isOwnPanel = (panel) => !panelsUsable || panelNamesModule(panel, module);
  const crossPanel = [];
  const normalizations = normalizeNormalizations(parsed.normalizations).filter((n) => {
    if (isOwnPanel(n.target_panel) && isOwnPanel(n.source_panel)) return true;
    crossPanel.push({ kind: 'normalization', payload: n });
    return false;
  });
  const routes = normalizeRoutes(parsed.routes).filter((r) => {
    if (isOwnPanel(r.input_panel) && isOwnPanel(r.output_panel)) return true;
    crossPanel.push({ kind: 'route', payload: r });
    return false;
  });
  const hints = [
    ...crossPanel,
    ...expanders.map((payload) => ({ kind: 'expander', payload })),
  ];

  const {
    Module,
    ModuleComponent,
    ComponentNormalization,
    ComponentRoute,
    ComponentSwitch,
    ComponentSwitchStep,
    ComponentValue,
    ComponentPair,
    ModulePathHint,
    ModuleParameter,
  } = db.models;
  // Replacing the component inventory and marking the analysis complete is
  // one atomic step — a failure mid-way must not leave the module stripped of
  // its previous components.
  let resolved = [];
  let resolvedRoutes = [];
  let resolvedSwitches = [];
  let resolvedPairs = [];
  await db.sequelize.transaction(async (transaction) => {
    // component_values cascade with their components in real Postgres, but
    // the explicit destroy keeps pg-mem (tests) honest too.
    const previous = await ModuleComponent.findAll({
      where: { module_id: module.id },
      attributes: ['id', 'name'],
      transaction,
    });
    const componentNameById = new Map(previous.map((c) => [c.id, c.name]));
    if (previous.length > 0) {
      await ComponentValue.destroy({
        where: { component_id: previous.map((c) => c.id) },
        transaction,
      });
    }
    const previousSwitches = await ComponentSwitch.findAll({
      where: { module_id: module.id },
      attributes: ['id'],
      transaction,
    });
    if (previousSwitches.length > 0) {
      await ComponentSwitchStep.destroy({
        where: { switch_id: previousSwitches.map((s) => s.id) },
        transaction,
      });
      await ComponentSwitch.destroy({ where: { module_id: module.id }, transaction });
    }
    await ModulePathHint.destroy({ where: { module_id: module.id }, transaction });
    if (hints.length > 0) {
      await ModulePathHint.bulkCreate(
        hints.map((h) => ({
          module_id: module.id,
          kind: h.kind,
          payload: JSON.stringify(h.payload),
        })),
        { transaction }
      );
    }
    await ComponentPair.destroy({ where: { module_id: module.id }, transaction });
    await ComponentRoute.destroy({ where: { module_id: module.id }, transaction });
    await ComponentNormalization.destroy({ where: { module_id: module.id }, transaction });
    // The MENU is not rebuilt here — it is read by its own pass, and a
    // parameter carries hand corrections and a list of options that cost a
    // model run. But it hangs off the components about to be destroyed, and
    // would cascade away with them: let go of the component ids first, and
    // put each parameter back on the component of the same NAME below. A
    // parameter whose component the new inventory no longer has keeps its
    // name and loses the link, which is what the module page shows as a
    // parameter of a component that is gone.
    const parameters = await ModuleParameter.findAll({
      where: { module_id: module.id },
      transaction,
    });
    const parameterNames = new Map();
    for (const parameter of parameters) {
      const name = parameter.component_name ?? componentNameById.get(parameter.component_id) ?? null;
      parameterNames.set(parameter.id, name);
      if (parameter.component_id !== null) {
        await parameter.update({ component_id: null, component_name: name }, { transaction });
      }
    }
    await ModuleComponent.destroy({ where: { module_id: module.id }, transaction });
    await ModuleComponent.bulkCreate(
      // values and panel are not columns: values become component_values rows
      // once the components have ids, and panel has already done its job.
      components.map(({ values, panel, ...c }) => ({ ...c, module_id: module.id })),
      { transaction }
    );
    // Re-read the freshly created components to resolve normalization names
    // to component ids.
    const created = await ModuleComponent.findAll({
      where: { module_id: module.id },
      order: [['id', 'ASC']],
      transaction,
    });
    // Every menu parameter back onto the component it names, now that the
    // new inventory has its ids.
    if (parameters.length > 0) {
      const byName = new Map(
        created.map((c) => [String(c.name ?? '').trim().toLowerCase(), c.id])
      );
      for (const parameter of parameters) {
        const name = parameterNames.get(parameter.id);
        const id = name ? byName.get(String(name).trim().toLowerCase()) : null;
        if (id) await parameter.update({ component_id: id }, { transaction });
      }
    }
    resolved = resolveNormalizations(normalizations, created);
    if (resolved.length > 0) {
      await ComponentNormalization.bulkCreate(
        resolved.map((n) => ({ ...n, module_id: module.id })),
        { transaction }
      );
    }
    resolvedRoutes = resolveRoutes(routes, created);
    if (resolvedRoutes.length > 0) {
      await ComponentRoute.bulkCreate(
        resolvedRoutes.map((r) => ({ ...r, module_id: module.id })),
        { transaction }
      );
    }
    resolvedPairs = resolvePairs(pairs, created);
    if (resolvedPairs.length > 0) {
      await ComponentPair.bulkCreate(
        resolvedPairs.map((p) => ({ ...p, module_id: module.id })),
        { transaction }
      );
    }
    resolvedSwitches = resolveSwitches(switches, created);
    for (const s of resolvedSwitches) {
      const row = await ComponentSwitch.create(
        {
          module_id: module.id,
          name: s.name,
          common_component_id: s.common_component_id,
          description: s.description,
        },
        { transaction }
      );
      await ComponentSwitchStep.bulkCreate(
        s.step_component_ids.map((componentId, i) => ({
          switch_id: row.id,
          component_id: componentId,
          position: i + 1,
        })),
        { transaction }
      );
    }
    // bulkCreate assigns serial ids in input order and `created` is read back
    // ordered by id, so created[i] is components[i]'s row.
    const valueRows = components.flatMap((c, i) =>
      c.values.map((v) => ({ ...v, component_id: created[i].id }))
    );
    if (valueRows.length > 0) {
      await ComponentValue.bulkCreate(valueRows, { transaction });
    }
    await Module.update(
      { summary, analysis_status: 'complete', ...(hp === null ? {} : { hp }) },
      { where: { id: module.id }, transaction }
    );
  });
  // Anything the manual described about another panel — a signal path that
  // crosses to it, or the panel's existence — is acted on now that the
  // analysis is committed: link the two module records if both exist, and
  // materialize every path that has become resolvable (in either direction,
  // since this module may be the panel another one was waiting for).
  const links = await refreshModuleLinks(db, module);

  return {
    summary,
    hp,
    components,
    normalizations: resolved,
    routes: resolvedRoutes,
    switches: resolvedSwitches,
    pairs: resolvedPairs,
    hints,
    links,
  };
}
