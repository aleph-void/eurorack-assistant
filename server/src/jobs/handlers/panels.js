// The front plate.
//
//   panel_image — find (or draw) the module's front panel and place every
//                 analyzed component on it
//   trim_panels — cut the blank backdrop off every panel picture in a
//                 system's racks, one module at a time. No LLM involved
//
// One of the groups composed by jobs/handlers.js. Every handler takes
// (job, backend, progress); the queue mechanics are jobs/worker.js.

import { manualPath } from '../../services/pdf.js';
import { buildPanelForModule } from '../../services/panelImage.js';
import { trimPanelImage } from '../../services/panelTrim.js';

export function createPanelsHandlers(db, { manualsDir, panelsDir, fetchImpl = fetch }) {
  async function handlePanelImage(job, backend, progress) {
    const { Module, Manual } = db.models;
    const record = await Module.findByPk(job.module_id);
    if (!record) throw new Error(`Module ${job.module_id} no longer exists`);
    const module = record.get({ plain: true });
    // The shared auto-found manual is what the drawn-panel fallback reads.
    const manual = await Manual.findOne({
      where: { module_id: module.id, user_id: null },
      order: [['id', 'ASC']],
    });
    await Module.update({ panel_status: 'searching' }, { where: { id: module.id } });
    progress(`building front panel: ${module.manufacturer} ${module.name}`.trim());
    try {
      const { panel, placements } = await buildPanelForModule(db, backend, module, panelsDir, {
        fetchImpl,
        log: progress,
        manualFile: manual ? manualPath(manualsDir, manual.hash) : null,
      });
      progress(
        `panel ready (${panel.source}): ${placements.filter((p) => p.component_id).length} ` +
          'component(s) placed'
      );
    } catch (e) {
      await Module.update({ panel_status: 'failed' }, { where: { id: module.id } });
      throw e;
    }
  }

  // Trim every panel in a system: the same cut the module page's Trim button
  // makes (services/panelImage.js), asked for once for a whole studio rather
  // than module by module. No model runs — it is pixels and file writes — so
  // the job needs no LLM account (see worker.js).
  //
  // A panel that is already trimmed, has no picture on disk, or has no
  // findable plate edge is reported and skipped: one module that cannot be
  // cut must not fail the sweep for the rest, since a retry would re-trim
  // nothing and leave the same module behind again.
  async function handleTrimPanels(job, backend, progress) {
    const { Module, ModulePanel, Rack, RackModule, System } = db.models;
    const payload = JSON.parse(job.payload || '{}');
    const system = await System.findOne({
      where: { id: payload.system_id, user_id: job.user_id },
    });
    if (!system) throw new Error(`System ${payload.system_id} no longer exists`);
    const racks = await Rack.findAll({ where: { system_id: system.id }, attributes: ['id'] });
    if (racks.length === 0) throw new Error(`System '${system.name}' has no racks in it`);
    const mappings = await RackModule.findAll({
      where: { rack_id: racks.map((rack) => rack.id) },
      attributes: ['module_id'],
    });
    const moduleIds = [...new Set(mappings.map((mapping) => mapping.module_id))];
    if (moduleIds.length === 0) throw new Error(`System '${system.name}' has no modules in it`);
    const modules = await Module.findAll({ where: { id: moduleIds }, order: [['id', 'ASC']] });
    progress(`trimming panels: ${modules.length} module(s) in '${system.name}'`);
    const tally = { trimmed: 0, already: 0, skipped: 0 };
    for (const record of modules) {
      const module = record.get({ plain: true });
      const label = `${module.manufacturer} ${module.name}`.trim();
      const panel = await ModulePanel.findOne({ where: { module_id: module.id } });
      if (!panel) {
        tally.skipped += 1;
        progress(`no panel yet: ${label}`);
        continue;
      }
      // Same rule as the module page's Trim button: a panel_image job in
      // flight is working from these bytes, and cutting them up mid-job races
      // its save. The sweep skips the module; it can be trimmed once the
      // markers have landed.
      const locating = await db.models.Job.count({
        where: { module_id: module.id, type: 'panel_image', status: ['pending', 'running'] },
      });
      if (locating > 0) {
        tally.skipped += 1;
        progress(`panel is still being placed; skipped: ${label}`);
        continue;
      }
      const { outcome, width, height } = await trimPanelImage(db, module, panel, panelsDir);
      if (outcome === 'trimmed') {
        tally.trimmed += 1;
        progress(`trimmed to ${width}x${height}: ${label}`);
      } else if (outcome === 'crop') {
        tally.trimmed += 1;
        progress(`could not cut the file; recorded the crop instead: ${label}`);
      } else if (outcome === 'already') {
        tally.already += 1;
        progress(`already trimmed: ${label}`);
      } else {
        tally.skipped += 1;
        progress(
          outcome === 'missing'
            ? `panel image is missing: ${label}`
            : `no panel edge to trim to: ${label}`
        );
      }
    }
    progress(
      `${tally.trimmed} panel(s) trimmed, ${tally.already} already trimmed, ` +
        `${tally.skipped} skipped`
    );
  }

  return {
    panel_image: handlePanelImage,
    trim_panels: handleTrimPanels,
  };
}
