import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import { Op } from 'sequelize';
import { requireAuth } from '../auth.js';
import { isProbablyPdf } from '../services/pdf.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function moduleRoutes(db, { manualsDir = process.env.MANUALS_DIR || '/data/manuals' } = {}) {
  const { Module, UserModule, ModuleComponent, Manual, Note, NoteModule, NoteComponent } =
    db.models;
  const router = Router();
  router.use(requireAuth(db));

  // The user's mapping row for a module, or null if it isn't in their system.
  async function userModule(userId, moduleId) {
    const mapping = await UserModule.findOne({
      where: { user_id: userId, module_id: Number(moduleId) },
      include: Module,
    });
    if (!mapping || !mapping.Module) return null;
    return { ...mapping.Module.get({ plain: true }), quantity: mapping.quantity };
  }

  router.get('/', async (req, res, next) => {
    try {
      const mappings = await UserModule.findAll({
        where: { user_id: req.user.id },
        include: Module,
        order: [
          [Module, 'manufacturer', 'ASC'],
          [Module, 'name', 'ASC'],
        ],
      });
      res.json(
        mappings.map((um) => {
          const m = um.Module;
          return {
            id: m.id,
            manufacturer: m.manufacturer,
            name: m.name,
            quantity: um.quantity,
            manual_status: m.manual_status,
            analysis_status: m.analysis_status,
            summary: m.summary,
            created_at: m.created_at,
            updated_at: m.updated_at,
          };
        })
      );
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
        attributes: ['id', 'filename', 'original_name', 'source', 'user_id', 'created_at'],
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

  // Removing a module removes it from *your* system only; the shared module
  // record (manual, analysis) remains for other users.
  router.delete('/:id', async (req, res, next) => {
    try {
      const deleted = await UserModule.destroy({
        where: { user_id: req.user.id, module_id: Number(req.params.id) },
      });
      if (deleted === 0) return res.status(404).json({ error: 'Module not found' });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Attach an additional PDF document to your module instance. Body:
  // { filename, data_base64 }. Private to the uploading user.
  router.post('/:id/manuals', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });

      const { filename, data_base64: dataBase64 } = req.body || {};
      if (!filename || !dataBase64) {
        return res.status(400).json({ error: 'filename and data_base64 are required' });
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

      const safeBase = String(filename)
        .replace(/\.pdf$/i, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .slice(0, 80);
      const stored = `user${req.user.id}_${module.id}_${crypto
        .randomBytes(4)
        .toString('hex')}_${safeBase}.pdf`;
      const dest = path.join(manualsDir, stored);
      fs.mkdirSync(manualsDir, { recursive: true });
      fs.writeFileSync(dest, data);

      const { ok, reason } = isProbablyPdf(dest);
      if (!ok) {
        fs.rmSync(dest, { force: true });
        return res.status(400).json({ error: `not a valid PDF (${reason})` });
      }

      const manual = await Manual.create({
        module_id: module.id,
        user_id: req.user.id,
        filename: stored,
        original_name: String(filename),
        source: 'upload',
      });
      const { id, original_name, source, user_id, created_at } = manual;
      res.status(201).json({ id, filename: stored, original_name, source, user_id, created_at });
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
      fs.rmSync(path.join(manualsDir, manual.filename), { force: true });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
