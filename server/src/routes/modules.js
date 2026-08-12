import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { isProbablyPdf } from '../services/pdf.js';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function moduleRoutes(db, { manualsDir = process.env.MANUALS_DIR || '/data/manuals' } = {}) {
  const router = Router();
  router.use(requireAuth(db));

  // The user's mapping row for a module, or null if it isn't in their system.
  async function userModule(userId, moduleId) {
    const { rows } = await db.query(
      `SELECT m.*, um.quantity FROM user_modules um
       JOIN modules m ON m.id = um.module_id
       WHERE um.user_id = $1 AND um.module_id = $2`,
      [userId, Number(moduleId)]
    );
    return rows[0] || null;
  }

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT m.id, m.manufacturer, m.name, um.quantity, m.manual_status,
                m.analysis_status, m.summary, m.created_at, m.updated_at
         FROM user_modules um JOIN modules m ON m.id = um.module_id
         WHERE um.user_id = $1 ORDER BY m.manufacturer, m.name`,
        [req.user.id]
      );
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const module = await userModule(req.user.id, req.params.id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
      const { rows: components } = await db.query(
        `SELECT id, type, name, description, voltage_min, voltage_max, polarity
         FROM module_components WHERE module_id = $1 ORDER BY type, id`,
        [module.id]
      );
      // Documents: the shared auto-found manual plus this user's own uploads.
      const { rows: manuals } = await db.query(
        `SELECT id, filename, original_name, source, user_id, created_at
         FROM manuals
         WHERE module_id = $1 AND (user_id IS NULL OR user_id = $2)
         ORDER BY id`,
        [module.id, req.user.id]
      );
      // The requesting user's notes attached to this module (component_id NULL)
      // or to one of its components. Notes are strictly private per user.
      const { rows: moduleNotes } = await db.query(
        `SELECT n.id, n.title, n.body, n.updated_at, NULL AS component_id
         FROM note_modules nm JOIN notes n ON n.id = nm.note_id
         WHERE nm.module_id = $1 AND n.user_id = $2
         ORDER BY n.id`,
        [module.id, req.user.id]
      );
      const { rows: componentNotes } = await db.query(
        `SELECT n.id, n.title, n.body, n.updated_at, nc.component_id
         FROM note_components nc
         JOIN notes n ON n.id = nc.note_id
         JOIN module_components mc ON mc.id = nc.component_id
         WHERE mc.module_id = $1 AND n.user_id = $2
         ORDER BY n.id`,
        [module.id, req.user.id]
      );
      res.json({ ...module, components, manuals, notes: [...moduleNotes, ...componentNotes] });
    } catch (e) {
      next(e);
    }
  });

  // Removing a module removes it from *your* system only; the shared module
  // record (manual, analysis) remains for other users.
  router.delete('/:id', async (req, res, next) => {
    try {
      const result = await db.query(
        'DELETE FROM user_modules WHERE user_id = $1 AND module_id = $2',
        [req.user.id, Number(req.params.id)]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Module not found' });
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

      const { rows } = await db.query(
        `INSERT INTO manuals (module_id, user_id, filename, original_name, source)
         VALUES ($1, $2, $3, $4, 'upload')
         RETURNING id, filename, original_name, source, user_id, created_at`,
        [module.id, req.user.id, stored, String(filename)]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      next(e);
    }
  });

  // Remove one of your own uploaded documents (the shared manual cannot be
  // deleted this way).
  router.delete('/:id/manuals/:manualId', async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT * FROM manuals WHERE id = $1 AND module_id = $2 AND user_id = $3`,
        [Number(req.params.manualId), Number(req.params.id), req.user.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Document not found' });
      await db.query('DELETE FROM manuals WHERE id = $1', [rows[0].id]);
      fs.rmSync(path.join(manualsDir, rows[0].filename), { force: true });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
