import fs from 'node:fs';
import { Router } from 'express';
import { Op } from 'sequelize';
import { requireAuth } from '../auth.js';
import { isProbablyPdfBuffer, manualPath, sha256Buffer } from '../services/pdf.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function moduleRoutes(db, { manualsDir = process.env.MANUALS_DIR || '/data/manuals' } = {}) {
  const { Module, Rack, RackModule, ModuleComponent, Manual, Note, NoteModule, NoteComponent } =
    db.models;
  const router = Router();
  router.use(requireAuth(db));

  // The user's rack mappings for a module (across all their racks), or null
  // if it isn't in any of them. Returns the module plus its per-rack
  // placements and the total quantity.
  async function userModule(userId, moduleId) {
    const mappings = await RackModule.findAll({
      where: { module_id: Number(moduleId) },
      include: [{ model: Rack, where: { user_id: userId } }, Module],
      order: [[Rack, 'name', 'ASC']],
    });
    if (mappings.length === 0 || !mappings[0].Module) return null;
    return {
      ...mappings[0].Module.get({ plain: true }),
      quantity: mappings.reduce((sum, rm) => sum + rm.quantity, 0),
      racks: mappings.map((rm) => ({
        id: rm.Rack.id,
        name: rm.Rack.name,
        quantity: rm.quantity,
      })),
    };
  }

  // The user's modules, either across all their racks (deduped, quantities
  // summed) or filtered to one rack via ?rack_id=. Each entry carries its
  // per-rack placements.
  router.get('/', async (req, res, next) => {
    try {
      const rackWhere = { user_id: req.user.id };
      if (req.query.rack_id) {
        const rack = await Rack.findOne({
          where: { id: Number(req.query.rack_id), user_id: req.user.id },
        });
        if (!rack) return res.status(404).json({ error: 'Rack not found' });
        rackWhere.id = rack.id;
      }
      const mappings = await RackModule.findAll({
        include: [{ model: Rack, where: rackWhere }, Module],
        order: [
          [Module, 'manufacturer', 'ASC'],
          [Module, 'name', 'ASC'],
          [Rack, 'name', 'ASC'],
        ],
      });
      const byModule = new Map();
      for (const rm of mappings) {
        const m = rm.Module;
        if (!byModule.has(m.id)) {
          byModule.set(m.id, {
            id: m.id,
            manufacturer: m.manufacturer,
            name: m.name,
            quantity: 0,
            racks: [],
            manual_status: m.manual_status,
            analysis_status: m.analysis_status,
            summary: m.summary,
            created_at: m.created_at,
            updated_at: m.updated_at,
          });
        }
        const entry = byModule.get(m.id);
        entry.quantity += rm.quantity;
        entry.racks.push({ id: rm.Rack.id, name: rm.Rack.name, quantity: rm.quantity });
      }
      res.json([...byModule.values()]);
    } catch (e) {
      next(e);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      const components = await ModuleComponent.findAll({
        where: { module_id: module.id },
        attributes: ['id', 'type', 'name', 'description', 'voltage_min', 'voltage_max', 'polarity'],
        order: [
          ['type', 'ASC'],
          ['id', 'ASC'],
        ],
      });
      // Documents: the shared auto-found manual plus this user's own uploads.
      const manuals = await Manual.findAll({
        where: {
          module_id: module.id,
          [Op.or]: [{ user_id: null }, { user_id: req.user.id }],
        },
        attributes: ['id', 'hash', 'name', 'original_name', 'source', 'user_id', 'created_at'],
        order: [['id', 'ASC']],
      });
      // The requesting user's notes attached to this module (component_id NULL)
      // or to one of its components. Notes are strictly private per user.
      const moduleNotes = await NoteModule.findAll({
        where: { module_id: module.id },
        include: [{ model: Note, where: { user_id: req.user.id } }],
        order: [[Note, 'id', 'ASC']],
      });
      const componentNotes = await NoteComponent.findAll({
        include: [
          { model: Note, where: { user_id: req.user.id } },
          { model: ModuleComponent, where: { module_id: module.id }, attributes: [] },
        ],
        order: [[Note, 'id', 'ASC']],
      });
      const noteJson = (note, componentId) => ({
        id: note.id,
        title: note.title,
        body: note.body,
        updated_at: note.updated_at,
        component_id: componentId,
      });
      res.json({
        ...module,
        components,
        manuals,
        notes: [
          ...moduleNotes.map((nm) => noteJson(nm.Note, null)),
          ...componentNotes.map((nc) => noteJson(nc.Note, nc.component_id)),
        ],
      });
    } catch (e) {
      next(e);
    }
  });

  // Removing a module removes it from *your* racks only (one rack when
  // ?rack_id= is given, otherwise all of them); the shared module record
  // (manual, analysis) remains for other users.
  router.delete('/:id', async (req, res, next) => {
    try {
      const rackWhere = { user_id: req.user.id };
      if (req.query.rack_id) rackWhere.id = Number(req.query.rack_id);
      const racks = await Rack.findAll({ where: rackWhere });
      const deleted =
        racks.length === 0
          ? 0
          : await RackModule.destroy({
              where: { rack_id: racks.map((r) => r.id), module_id: Number(req.params.id) },
            });
      if (deleted === 0) return res.status(404).json({ error: 'Module not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Attach an additional PDF document to your module instance. Body:
  // { name, filename, data_base64 }. Private to the uploading user. The name
  // labels the document; 'manual' is reserved for the shared auto-found
  // manual, so uploads must pick something else.
  router.post('/:id/manuals', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });

      const { name: rawName, filename, data_base64: dataBase64 } = req.body || {};
      if (!rawName || !filename || !dataBase64) {
        return res.status(400).json({ error: 'name, filename and data_base64 are required' });
      }
      const name = String(rawName).trim();
      if (!name) return res.status(400).json({ error: 'name, filename and data_base64 are required' });
      if (name.toLowerCase() === 'manual') {
        return res.status(400).json({ error: "'manual' is reserved for the shared manual" });
      }
      let data;
      try {
        data = Buffer.from(String(dataBase64), 'base64');
      } catch {
        return res.status(400).json({ error: 'data_base64 is not valid base64' });
      }
      if (data.length === 0 || data.length > MAX_UPLOAD_BYTES) {
        return res.status(400).json({ error: 'file is empty or larger than 25MB' });
      }

      const { ok, reason } = isProbablyPdfBuffer(data);
      if (!ok) return res.status(400).json({ error: `not a valid PDF (${reason})` });

      // Content-addressed storage: the file lands at <sha256>.pdf, so a
      // document that already exists (under any record) is stored once.
      const hash = sha256Buffer(data);
      const dest = manualPath(manualsDir, hash);
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(manualsDir, { recursive: true });
        fs.writeFileSync(dest, data);
      }

      // Re-uploading a document you already attached references the existing
      // record instead of creating a duplicate (the original name is kept).
      const existing = await Manual.findOne({
        where: { module_id: module.id, user_id: req.user.id, hash },
      });
      // A database name may not be reused for different content (backed by
      // the unique index on (module_id, name, hash)).
      if (!existing) {
        const nameTaken = await Manual.findOne({
          where: { module_id: module.id, user_id: req.user.id, name },
        });
        if (nameTaken) {
          return res
            .status(409)
            .json({ error: `you already have a document named '${name}' on this module` });
        }
      }
      const manual =
        existing ||
        (await Manual.create({
          module_id: module.id,
          user_id: req.user.id,
          hash,
          name,
          original_name: String(filename),
          source: 'upload',
        }));
      const { id, original_name, source, user_id, created_at } = manual;
      res
        .status(existing ? 200 : 201)
        .json({ id, hash, name: manual.name, original_name, source, user_id, created_at });
    } catch (e) {
      next(e);
    }
  });

  // Remove one of your own uploaded documents (the shared manual cannot be
  // deleted this way).
  router.delete('/:id/manuals/:manualId', async (req, res, next) => {
    try {
      const manual = await Manual.findOne({
        where: {
          id: Number(req.params.manualId),
          module_id: Number(req.params.id),
          user_id: req.user.id,
        },
      });
      if (!manual) return res.status(404).json({ error: 'Document not found' });
      await manual.destroy();
      // The file is shared by every record with the same content hash; only
      // remove it once the last reference is gone.
      const remaining = await Manual.count({ where: { hash: manual.hash } });
      if (remaining === 0) fs.rmSync(manualPath(manualsDir, manual.hash), { force: true });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
