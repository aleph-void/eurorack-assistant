import { Router } from 'express';
import { requireAuth } from '../auth.js';

// Per-user notes, attachable to any number of the user's modules and module
// components. Attachments can be added or removed after creation so one note
// can be reused across modules/components.
export function noteRoutes(db) {
  const router = Router();
  router.use(requireAuth(db));

  // Module ids from the user's system only.
  async function validModuleIds(userId, ids) {
    const out = [];
    for (const raw of ids || []) {
      const id = Number(raw);
      const { rows } = await db.query(
        'SELECT 1 FROM user_modules WHERE user_id = $1 AND module_id = $2',
        [userId, id]
      );
      if (rows.length === 0) return { error: `Module ${raw} is not in your system` };
      out.push(id);
    }
    return { ids: out };
  }

  // Component ids whose parent module is in the user's system.
  async function validComponentIds(userId, ids) {
    const out = [];
    for (const raw of ids || []) {
      const id = Number(raw);
      const { rows } = await db.query(
        `SELECT 1 FROM module_components mc
         JOIN user_modules um ON um.module_id = mc.module_id
         WHERE um.user_id = $1 AND mc.id = $2`,
        [userId, id]
      );
      if (rows.length === 0) return { error: `Component ${raw} is not in your system` };
      out.push(id);
    }
    return { ids: out };
  }

  async function attach(noteId, moduleIds, componentIds) {
    for (const id of moduleIds) {
      const { rows } = await db.query(
        'SELECT 1 FROM note_modules WHERE note_id = $1 AND module_id = $2',
        [noteId, id]
      );
      if (rows.length === 0) {
        await db.query('INSERT INTO note_modules (note_id, module_id) VALUES ($1, $2)', [
          noteId,
          id,
        ]);
      }
    }
    for (const id of componentIds) {
      const { rows } = await db.query(
        'SELECT 1 FROM note_components WHERE note_id = $1 AND component_id = $2',
        [noteId, id]
      );
      if (rows.length === 0) {
        await db.query('INSERT INTO note_components (note_id, component_id) VALUES ($1, $2)', [
          noteId,
          id,
        ]);
      }
    }
  }

  async function noteWithAttachments(note) {
    const { rows: modules } = await db.query(
      `SELECT m.id, m.manufacturer, m.name
       FROM note_modules nm JOIN modules m ON m.id = nm.module_id
       WHERE nm.note_id = $1 ORDER BY m.manufacturer, m.name`,
      [note.id]
    );
    const { rows: components } = await db.query(
      `SELECT mc.id, mc.name, mc.type, mc.module_id,
              m.manufacturer AS module_manufacturer, m.name AS module_name
       FROM note_components nc
       JOIN module_components mc ON mc.id = nc.component_id
       JOIN modules m ON m.id = mc.module_id
       WHERE nc.note_id = $1 ORDER BY mc.id`,
      [note.id]
    );
    return { ...note, modules, components };
  }

  async function ownNote(userId, id) {
    const { rows } = await db.query('SELECT * FROM notes WHERE id = $1 AND user_id = $2', [
      Number(id),
      userId,
    ]);
    return rows[0] || null;
  }

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'SELECT * FROM notes WHERE user_id = $1 ORDER BY updated_at DESC, id DESC',
        [req.user.id]
      );
      res.json(await Promise.all(rows.map((n) => noteWithAttachments(n))));
    } catch (e) {
      next(e);
    }
  });

  // Body: { body, title?, module_ids?, component_ids? }
  router.post('/', async (req, res, next) => {
    try {
      const body = String(req.body?.body || '').trim();
      if (!body) return res.status(400).json({ error: 'body is required' });
      const title = req.body?.title ? String(req.body.title).trim() : null;

      const modules = await validModuleIds(req.user.id, req.body?.module_ids);
      if (modules.error) return res.status(400).json({ error: modules.error });
      const components = await validComponentIds(req.user.id, req.body?.component_ids);
      if (components.error) return res.status(400).json({ error: components.error });

      const { rows } = await db.query(
        'INSERT INTO notes (user_id, title, body) VALUES ($1, $2, $3) RETURNING *',
        [req.user.id, title, body]
      );
      await attach(rows[0].id, modules.ids, components.ids);
      res.status(201).json(await noteWithAttachments(rows[0]));
    } catch (e) {
      next(e);
    }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const note = await ownNote(req.user.id, req.params.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });
      const body = req.body?.body !== undefined ? String(req.body.body).trim() : note.body;
      if (!body) return res.status(400).json({ error: 'body cannot be empty' });
      const title =
        req.body?.title !== undefined
          ? String(req.body.title).trim() || null
          : note.title;
      const { rows } = await db.query(
        'UPDATE notes SET title = $2, body = $3, updated_at = now() WHERE id = $1 RETURNING *',
        [note.id, title, body]
      );
      res.json(await noteWithAttachments(rows[0]));
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const note = await ownNote(req.user.id, req.params.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });
      await db.query('DELETE FROM notes WHERE id = $1', [note.id]);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Attach an existing note to more modules/components.
  // Body: { module_ids?, component_ids? }
  router.post('/:id/attach', async (req, res, next) => {
    try {
      const note = await ownNote(req.user.id, req.params.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });

      const modules = await validModuleIds(req.user.id, req.body?.module_ids);
      if (modules.error) return res.status(400).json({ error: modules.error });
      const components = await validComponentIds(req.user.id, req.body?.component_ids);
      if (components.error) return res.status(400).json({ error: components.error });
      if (modules.ids.length === 0 && components.ids.length === 0) {
        return res.status(400).json({ error: 'module_ids or component_ids required' });
      }

      await attach(note.id, modules.ids, components.ids);
      res.json(await noteWithAttachments(note));
    } catch (e) {
      next(e);
    }
  });

  // Detach from one module or component. Body: { module_id? , component_id? }
  router.post('/:id/detach', async (req, res, next) => {
    try {
      const note = await ownNote(req.user.id, req.params.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });
      const { module_id: moduleId, component_id: componentId } = req.body || {};
      if (moduleId) {
        await db.query('DELETE FROM note_modules WHERE note_id = $1 AND module_id = $2', [
          note.id,
          Number(moduleId),
        ]);
      } else if (componentId) {
        await db.query('DELETE FROM note_components WHERE note_id = $1 AND component_id = $2', [
          note.id,
          Number(componentId),
        ]);
      } else {
        return res.status(400).json({ error: 'module_id or component_id required' });
      }
      res.json(await noteWithAttachments(note));
    } catch (e) {
      next(e);
    }
  });

  return router;
}
