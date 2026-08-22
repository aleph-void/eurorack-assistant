// Cutting a stored panel down to the front plate.
//
// Every panel is cut as it ARRIVES (trimIncomingPanel, on an upload or a URL
// and on the picture the panel job downloads alike), which cuts bytes that are
// not stored yet and re-bases any markers already worked out on them. Cutting
// resets the crop to full and sets module_panels.trimmed, so a picture is only
// ever cut once: cutting twice eats into the hardware.
//
// trimPanelImage does the same to a panel ALREADY stored — one from before the
// cut-on-arrival rule, or one an install without sharp let through — and
// re-bases the markers that were placed on the uncut picture.
//
// Split out of services/panelImage.js, which is what finds the picture.

import fs from 'node:fs';
import { panelPath, saveImage } from './image.js';
import { clamp01 } from './panelGeometry.js';
import { cropImage, panelCrop, readPixels } from './panelPixels.js';
import { FULL_CROP } from './panelPlacements.js';
import { deletePanelImageIfOrphaned } from './panelStore.js';

// A marker's position is a fraction of the picture it was placed on, so
// cutting that picture down to `box` puts the marker at the same fraction of
// what survives — and one that fell outside the plate lands on the edge it
// was nearest.
const rebaseMarker = (marker, box) => ({
  ...marker,
  x: clamp01(((Number(marker.x) || 0) - box.x) / box.w),
  y: clamp01(((Number(marker.y) || 0) - box.y) / box.h),
  w: Math.min(1, (Number(marker.w) || 0) / box.w),
  h: Math.min(1, (Number(marker.h) || 0) / box.h),
});

// A plate that already fills its picture is not worth a second encode.
const WORTH_CUTTING = 0.999;

// Cut a panel picture down to its front plate BEFORE it becomes the module's
// panel: the same cut trimPanelImage() makes to a stored one, made instead to
// bytes that are only just in hand — a picture the user uploaded or gave a URL
// for (routes/modules/panel.js), or one the panel job downloaded
// (buildPanelForModule below). Doing it as the picture lands means the panel
// stored is the panel and nothing else from the start, with no Trim press
// needed and no half-second where a photograph's backdrop is drawn as panel.
//
// `source` is the bytes or the file to cut, `box` the plate in fractions of
// it, and `markers` whatever has already been placed on it, which comes back
// re-based onto the cut. Null when there is nothing worth cutting, when sharp
// will not load, or when the format cannot be cut — in which case the caller
// stores the picture whole and records the crop, exactly as it used to.
export async function trimIncomingPanel(source, box, { ext = 'png', markers = [] } = {}) {
  if (!box) return null;
  if (box.w >= WORTH_CUTTING && box.h >= WORTH_CUTTING) return null;
  const cut = await cropImage(source, box, { ext });
  if (!cut) return null;
  return { ...cut, markers: markers.map((marker) => rebaseMarker(marker, box)) };
}

// Cut the blank backdrop away from a panel picture that is already stored:
// work the front plate's box out of the pixels, CUT THE FILE DOWN TO IT, and
// re-base every marker onto what survives — after which the crop is the whole
// picture again and every renderer draws what it drew before. The new bytes
// are stored under their own hash and the old ones go once no panel points at
// them.
//
// Trim peels uniform lines off the edges, and a plate that has already been
// cut out has uniform edges of its own, so a panel is only ever trimmed once
// (module_panels.trimmed) — trimming twice would eat into the hardware.
//
// One panel's worth of the work, shared by the module page's Trim button
// (routes/modules/panel.js) and the system-wide sweep (jobs/handlers.js), so
// trimming means the same thing however it was asked for. Reports what
// happened rather than throwing: 'trimmed', 'already' (nothing to do),
// 'missing' (the file has gone), 'no-edge' (no plate found in the pixels) or
// 'crop' (an install whose sharp will not load, or a format that cannot be
// cut — the crop alone is recorded, which is what the route used to do).
export async function trimPanelImage(db, module, panel, panelsDir) {
  const { ModulePanelComponent } = db.models;
  if (panel.trimmed) return { outcome: 'already' };
  const file = panel.image_hash ? panelPath(panelsDir, panel.image_hash, panel.image_ext) : null;
  if (!file || !fs.existsSync(file)) return { outcome: 'missing' };
  const pixels = await readPixels(file);
  const crop = pixels ? panelCrop(pixels, { hp: panel.hp ?? module.hp ?? null }) : null;
  if (!crop) return { outcome: 'no-edge' };
  // Both the crop and every marker are fractions of the file as it stands,
  // so the box cuts straight out of it.
  const cut = await cropImage(file, crop, { ext: panel.image_ext });
  if (!cut) {
    await panel.update({ crop_x: crop.x, crop_y: crop.y, crop_w: crop.w, crop_h: crop.h });
    return { outcome: 'crop' };
  }
  const stale = { hash: panel.image_hash, ext: panel.image_ext };
  const hash = saveImage(panelsDir, cut.buffer, cut.ext);
  // Every marker is a fraction of the image that is being cut down, so each
  // one moves to the same fraction of what survives — and a marker that fell
  // outside the plate stays on the edge it was nearest.
  const placements = await ModulePanelComponent.findAll({ where: { panel_id: panel.id } });
  for (const placement of placements) {
    const { x, y, w, h } = rebaseMarker(placement, crop);
    await placement.update({ x, y, w, h });
  }
  await panel.update({
    image_hash: hash,
    image_ext: cut.ext,
    width: cut.width,
    height: cut.height,
    trimmed: true,
    ...FULL_CROP,
  });
  if (hash !== stale.hash || cut.ext !== stale.ext) {
    await deletePanelImageIfOrphaned(db, panelsDir, stale.hash, stale.ext);
  }
  return { outcome: 'trimmed', width: cut.width, height: cut.height };
}
