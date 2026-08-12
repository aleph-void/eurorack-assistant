import { Router } from 'express';
import { requireAuth } from '../auth.js';

// Per-user notes, attachable to any number of the user's modules and module
// components. Attachments can be added or removed after creation so one note
// can be reused across modules/components.
export function noteRoutes(db) {
  const { Note, NoteModule, NoteComponent, Module, ModuleComponent, UserModule } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  // Module ids from the user's system only.
  async function validModuleIds(userId, ids) {
    const out = [];
    for (const raw of ids || []) {
      const id = Number(raw);
      const mapping = await UserModule.findOne({ where: { user_id: userId, module_id: id } });
      if (!mapping) return { error: `Module ${raw} is not in your system` };
      out.push(id);
    }
    return { ids: out };
  }

  // Component ids whose parent module is in the user's system.
  async function validComponentIds(userId, ids) {
    const out = [];
    for (const raw of ids || []) {
      const id = Number(raw);
      const component = await ModuleComponent.findByPk(id);
      const mapping =
        component &&
        (await UserModule.findOne({
          where: { user_id: userId, module_id: component.module_id },
        }));
      if (!mapping) return { error: `Component ${raw} is not in your system` };
      out.push(id);
    }
    return { ids: out };
  }

  async function attach(noteId, moduleIds, componentIds, transaction) {
    for (const id of moduleIds) {
      const existing = await NoteModule.findOne({
        where: { note_id: noteId, module_id: id },
        transaction,
      });
      if (!existing) await NoteModule.create({ note_id: noteId, module_id: id }, { transaction });
    }
    for (const id of componentIds) {
      const existing = await NoteComponent.findOne({
        where: { note_id: noteId, component_id: id },
        transaction,
      });
      if (!existing) {
        await NoteComponent.create({ note_id: noteId, component_id: id }, { transaction });
      }
    }
  }

  async function noteWithAttachments(note) {
    const moduleLinks = await NoteModule.findAll({
      where: { note_id: note.id },
      include: Module,
      order: [
        [Module, 'manufacturer', 'ASC'],
        [Module, 'name', 'ASC'],
      ],
    });
    const componentLinks = await NoteComponent.findAll({
      where: { note_id: note.id },
      include: [{ model: ModuleComponent, include: [Module] }],
      order: [[ModuleComponent, 'id', 'ASC']],
    });
    return {
      ...(typeof note.get === 'function' ? note.get({ plain: true }) : note),
      modules: moduleLinks.map(({ Module: m }) => ({
        id: m.id,
        manufacturer: m.manufacturer,
        name: m.name,
      })),
      components: componentLinks.map(({ ModuleComponent: mc }) => ({
        id: mc.id,
        name: mc.name,
        type: mc.type,
        module_id: mc.module_id,
        module_manufacturer: mc.Module.manufacturer,
        module_name: mc.Module.name,
      })),
    };
  }

  async function ownNote(userId, id) {
    return Note.findOne({ where: { id: Number(id), user_id: userId } });
  }

  router.get('/', async (req, res, next) => {
    try {
      const notes = await Note.findAll({
        where: { user_id: req.user.id },
        order: [
          ['updated_at', 'DESC'],
          ['id', 'DESC'],
        ],
      });
      res.json(await Promise.all(notes.map((n) => noteWithAttachments(n))));
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

      // The note and its attachments are written across three tables; they
      // commit or roll back together.
      const note = await db.sequelize.transaction(async (transaction) => {
        const created = await Note.create(
          { user_id: req.user.id, title, body },
          { transaction }
        );
        await attach(created.id, modules.ids, components.ids, transaction);
        return created;
      });
      res.status(201).json(await noteWithAttachments(note));
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
      await note.update({ title, body });
      res.json(await noteWithAttachments(note));
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const note = await ownNote(req.user.id, req.params.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });
      await note.destroy();
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

      await db.sequelize.transaction((transaction) =>
        attach(note.id, modules.ids, components.ids, transaction)
      );
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
        await NoteModule.destroy({
          where: { note_id: note.id, module_id: Number(moduleId) },
        });
      } else if (componentId) {
        await NoteComponent.destroy({
          where: { note_id: note.id, component_id: Number(componentId) },
        });
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
