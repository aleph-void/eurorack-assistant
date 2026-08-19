import fs from 'node:fs';
import { Router } from 'express';
import {
  downloadImage,
  MAX_IMAGE_BYTES,
  MIN_PANEL_PIXELS,
  panelPath,
  saveImage,
  sniffImage,
} from '../../services/image.js';
import { panelCrop, readPixels } from '../../services/panelPixels.js';
import {
  deletePanelImageIfOrphaned,
  fillMissingPlacements,
  FULL_CROP,
  loadPanels,
  normalizeHp,
  savePanel,
} from '../../services/panelImage.js';
import { enqueueModuleJob } from '../../jobs/worker.js';
import { requireBudget } from '../../services/budgets.js';
import { requireOwnedModule } from './helpers.js';
import { asyncHandler } from '../asyncHandler.js';

export function modulePanelRoutes(db, { panelsDir, fetchImpl }) {
  const {
    Module,
    ModuleComponent,
    ModulePanel,
    ModulePanelComponent,
    Manual,
  } = db.models;
  const router = Router();

  // Supply your own front-panel picture for this module. Body:
  // { filename, data_base64, hp? }, or { url, hp? }.
  //
  // The panel job researches an image and, failing that, draws one from the
  // manual — but a photograph you took of the module in your own rack, or the
  // press shot you know is the right one, beats both. A user-supplied panel
  // replaces whatever panel the module had and is never replaced by research
  // afterwards; the job only re-locates the components on it (see
  // services/panelImage.js), which is what draws the markers on and what puts
  // them back after a re-analysis.
  //
  // Like the manual and the analysis, the panel belongs to the shared module
  // record rather than to one user: everyone with this module racked sees the
  // picture, and anyone with it racked may replace it.
  router.post('/:id/panel', requireBudget(db), requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;

    const { filename, data_base64: dataBase64 } = req.body || {};
    const rawUrl = String(req.body?.url ?? '').trim();
    const hasFileFields = Boolean(filename || dataBase64);
    if (rawUrl && hasFileFields) {
      return res
        .status(400)
        .json({ error: 'supply either a panel URL or an uploaded file, not both' });
    }

    let data;
    let info;
    let sourceUrl = null;
    let description;
    if (rawUrl) {
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return res.status(400).json({ error: 'panel URL is not valid' });
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        return res.status(400).json({ error: 'panel URL must be an HTTP or HTTPS URL' });
      }
      if (rawUrl.length > 2048) {
        return res.status(400).json({ error: 'panel URL is too long' });
      }
      const downloaded = await downloadImage(parsed.href, { fetchImpl });
      if (!downloaded) {
        return res.status(400).json({
          error: 'could not download a PNG, JPEG, GIF or WebP panel image from that URL',
        });
      }
      data = downloaded.buffer;
      info = downloaded;
      sourceUrl = parsed.href;
      description = `Panel image supplied by URL (${parsed.href.slice(0, 240)}).`;
    } else {
      if (!filename || !dataBase64) {
        return res.status(400).json({
          error: 'url or filename and data_base64 are required',
        });
      }
      try {
        data = Buffer.from(String(dataBase64), 'base64');
      } catch {
        return res.status(400).json({ error: 'data_base64 is not valid base64' });
      }
      if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
        return res.status(400).json({ error: 'image is empty or larger than 12MB' });
      }
      info = sniffImage(data);
      description = `Uploaded panel image (${String(filename).slice(0, 120)}).`;
    }

    // What the file IS decides whether it is accepted, not what it is
    // called: the same sniff the downloader uses, so an uploaded panel is
    // held to exactly the standard a found one is. SVG is not among the
    // formats — a document that can carry script is not something this app
    // hosts on behalf of a user (services/image.js).
    if (!info) {
      return res.status(400).json({ error: 'not a PNG, JPEG, GIF or WebP image' });
    }
    if (Math.max(info.width, info.height) < MIN_PANEL_PIXELS) {
      return res.status(400).json({
        error: `image is only ${info.width}x${info.height}; too small to be a panel image`,
      });
    }

    // An HP given with the picture is the user telling us how wide the
    // module is, which outranks anything extracted for it. Optional, but a
    // width that cannot be read is rejected rather than quietly dropped.
    const rawHp = req.body?.hp;
    const statesHp = rawHp !== undefined && rawHp !== null && String(rawHp).trim() !== '';
    const hp = statesHp ? normalizeHp(rawHp) : null;
    if (statesHp && hp === null) {
      return res.status(400).json({ error: 'hp must be a panel width in HP' });
    }
    if (hp !== null) await Module.update({ hp }, { where: { id: module.id } });
    const width = hp ?? module.hp ?? null;

    // Crop the blank backdrop as part of accepting the upload, rather than
    // waiting for the component-mapping job to do it later. Some uploads do
    // not queue that job at all (there are no analyzed components yet), and
    // even when they do, the user should see the panel they just supplied
    // without a temporary white/transparent frame around it. Keep the
    // original bytes: the client already renders a panel through this crop,
    // which avoids lossy re-encoding and preserves animated image formats.
    const pixels = await readPixels(data);
    const crop = pixels ? panelCrop(pixels, { hp: width }) : null;
    const uploadCrop = crop
      ? { crop_x: crop.x, crop_y: crop.y, crop_w: crop.w, crop_h: crop.h }
      : { ...FULL_CROP };

    const previous = await ModulePanel.findOne({ where: { module_id: module.id } });
    const hash = saveImage(panelsDir, data, info.ext);
    await savePanel(
      db,
      { ...module, hp: width },
      {
        source: 'upload',
        source_url: sourceUrl,
        image_hash: hash,
        image_ext: info.ext,
        width: info.width,
        height: info.height,
        ...uploadCrop,
        hp: width,
        description,
      },
      // The markers come from the panel job below: where a component sits
      // on a picture the server has never seen is not something this
      // request can work out.
      []
    );
    if (previous) {
      await deletePanelImageIfOrphaned(db, panelsDir, previous.image_hash, previous.image_ext);
    }

    // Locating the components on it is LLM work, so it goes to the queue.
    // If the component list does not exist yet, enter the chained pipeline
    // one step earlier: analyze the shared manual first, or find that manual
    // first when the module has none. A successful analysis queues the panel
    // job itself, which then sees and keeps this user-supplied image.
    const components = await ModuleComponent.count({ where: { module_id: module.id } });
    let jobType = 'panel_image';
    if (components === 0) {
      const manual = await Manual.findOne({
        where: { module_id: module.id, user_id: null },
        attributes: ['id'],
      });
      jobType = manual ? 'analyze_manual' : 'find_manual';
    }
    const queued = await enqueueModuleJob(db, jobType, module, req.user.id);
    if (queued && jobType === 'analyze_manual') {
      await Module.update({ analysis_status: 'pending' }, { where: { id: module.id } });
    } else if (queued && jobType === 'find_manual') {
      await Module.update(
        { manual_status: 'pending', analysis_status: 'pending' },
        { where: { id: module.id } }
      );
    }
    const panels = await loadPanels(db, [module.id]);
    res.status(201).json({ panel: panels.get(module.id) ?? null, job_id: queued ? queued.id : null });
  }));

  // Trim the blank backdrop away from the existing panel picture: work the
  // front plate's box out of the pixels again and store it as the crop, the
  // same way an upload is cropped on arrival. The markers store their
  // positions as fractions of the WHOLE image and every renderer maps them
  // through the crop, so each one stays glued to the hardware it marks —
  // nothing about the placements needs rewriting, and the original bytes are
  // kept untouched (no lossy re-encoding, animated formats survive).
  router.post('/:id/panel/trim', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const panel = await ModulePanel.findOne({ where: { module_id: module.id } });
    if (!panel) return res.status(404).json({ error: 'Module has no panel' });
    const file = panel.image_hash
      ? panelPath(panelsDir, panel.image_hash, panel.image_ext)
      : null;
    if (!file || !fs.existsSync(file)) {
      return res.status(404).json({ error: 'Panel image not found' });
    }
    const pixels = await readPixels(file);
    const crop = pixels ? panelCrop(pixels, { hp: panel.hp ?? module.hp ?? null }) : null;
    if (!crop) {
      return res.status(400).json({ error: 'Could not find a panel edge to trim to' });
    }
    await panel.update({ crop_x: crop.x, crop_y: crop.y, crop_w: crop.w, crop_h: crop.h });
    const panels = await loadPanels(db, [module.id]);
    res.json({ panel: panels.get(module.id) ?? null });
  }));

  // Give an analyzed component the panel marker the image-mapping pass missed.
  // Body: { component_id }. The marker starts in the same free-space layout as
  // a hand-added component and can immediately be dragged onto the hardware.
  router.post('/:id/panel/components', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const panel = await ModulePanel.findOne({ where: { module_id: module.id } });
    if (!panel) return res.status(404).json({ error: 'Module has no panel' });
    const component = await ModuleComponent.findOne({
      where: { id: Number(req.body?.component_id) || 0, module_id: module.id },
    });
    if (!component) return res.status(404).json({ error: 'Component not found' });

    let placement = await ModulePanelComponent.findOne({
      where: { panel_id: panel.id, component_id: component.id },
    });
    let created = false;
    if (!placement) {
      const [existing, components] = await Promise.all([
        ModulePanelComponent.findAll({ where: { panel_id: panel.id } }),
        ModuleComponent.findAll({ where: { module_id: module.id } }),
      ]);
      const planned = fillMissingPlacements(
        existing.map((row) => row.get({ plain: true })),
        components.map((row) => row.get({ plain: true }))
      ).find((row) => row.component_id === component.id);
      placement = await ModulePanelComponent.create({
        panel_id: panel.id,
        component_id: component.id,
        name: component.name,
        shape: planned?.shape ?? 'other',
        x: planned?.x ?? 0.5,
        y: planned?.y ?? 0.5,
        w: planned?.w ?? 0.06,
        h: planned?.h ?? 0.06,
      });
      created = true;
    }
    const panels = await loadPanels(db, [module.id]);
    res.status(created ? 201 : 200).json({
      panel: panels.get(module.id) ?? null,
      placement_id: placement.id,
    });
  }));

  // Move one marker on the panel. Body: { x, y } as fractions of the whole
  // image, the same numbers the panel job stores.
  //
  // Everything upstream of this is an estimate — a model reading a photograph,
  // corrected against the pixels (services/panelPixels.js) — and estimates are
  // right most of the time. This is for the rest of the time: the person
  // looking at the picture can see where the jack is, and dragging the circle
  // onto it is both the fastest way to say so and the only one that needs no
  // judgement from us about whether they are right.
  //
  // A hand-placed marker is not defended against the panel job, which rebuilds
  // every marker from scratch when it next runs — the job is also what puts
  // markers back after a re-analysis renumbers every component, and a position
  // pinned to a component id that no longer exists would be worse than one
  // worked out again. Rebuilds are rare and deliberate (rebuild_panels, a new
  // upload, a re-analysis); a correction lasts until one.
  router.patch('/:id/panel/components/:placementId', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;

    const panel = await ModulePanel.findOne({ where: { module_id: module.id } });
    if (!panel) return res.status(404).json({ error: 'Module has no panel' });
    const placement = await ModulePanelComponent.findOne({
      where: { id: req.params.placementId, panel_id: panel.id },
    });
    if (!placement) return res.status(404).json({ error: 'Marker not found on this panel' });

    // A position off the image is not a position. Rejected rather than
    // clamped: a marker that lands somewhere other than where it was
    // dropped is a bug report waiting to happen.
    const coord = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
    };
    const x = coord(req.body?.x);
    const y = coord(req.body?.y);
    if (x === null || y === null) {
      return res.status(400).json({ error: 'x and y must be fractions of the image between 0 and 1' });
    }

    await placement.update({ x, y });
    const panels = await loadPanels(db, [module.id]);
    res.json({ panel: panels.get(module.id) ?? null });
  }));

  // Discard an uploaded panel picture and let the module go back to a
  // researched or drawn one. Only an upload can be removed this way: there is
  // no value in deleting a generated panel, since the same job would draw the
  // same one again.
  router.delete('/:id/panel', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    const panel = await ModulePanel.findOne({
      where: { module_id: module.id, source: 'upload' },
    });
    if (!panel) return res.status(404).json({ error: 'No uploaded panel image' });

    await db.sequelize.transaction(async (transaction) => {
      await ModulePanelComponent.destroy({ where: { panel_id: panel.id }, transaction });
      await ModulePanel.destroy({ where: { id: panel.id }, transaction });
      await Module.update(
        { panel_status: 'pending' },
        { where: { id: module.id }, transaction }
      );
    });
    await deletePanelImageIfOrphaned(db, panelsDir, panel.image_hash, panel.image_ext);

    const components = await ModuleComponent.count({ where: { module_id: module.id } });
    const queued = components > 0 && (await enqueueModuleJob(db, 'panel_image', module, req.user.id));
    res.json({ ok: true, job_id: queued ? queued.id : null });
  }));

  return router;
}
