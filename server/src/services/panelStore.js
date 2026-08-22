// Putting a panel and its markers in the database, and taking the bytes away
// again when nothing points at them.
//
// A panel image is content-addressed and SHARED: two racks holding the same
// module hold the same file, so the bytes only go once the last panel row
// referring to them has. Split out of services/panelImage.js, which is what
// finds the picture in the first place.

import fs from 'node:fs';
import path from 'node:path';
import { panelPath } from './image.js';
import { PANEL_WIDTHS, thumbsDir } from './panelThumbs.js';

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

// Remove a panel image file that no panel row references any more, along with
// the sized copies rendered from it (services/panelThumbs.js) — they are the
// same picture and are orphaned by the same delete.
export async function deletePanelImageIfOrphaned(db, panelsDir, hash, ext) {
  if (!hash) return;
  if ((await db.models.ModulePanel.count({ where: { image_hash: hash } })) > 0) return;
  fs.rmSync(panelPath(panelsDir, hash, ext), { force: true });
  for (const width of PANEL_WIDTHS) {
    fs.rmSync(path.join(thumbsDir(panelsDir), `${hash}@${width}.webp`), { force: true });
  }
}
