import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { userHasModule } from '../services/racks.js';
import { readableResource, removeShares } from '../services/sharing.js';
import { asyncHandler } from './asyncHandler.js';

// Per-user notes, attachable to any number of the user's modules, module
// components and patches. Attachments can be added or removed after creation
// so one note can be reused across all three.
//
// Patch attachments are what waveform captures hang off: a capture is stored
// against a note, and that note is what makes it part of the patch.
export function noteRoutes(db) {
  const { Note, NoteModule, NoteComponent, NotePatch, Module, ModuleComponent, Patch, Capture } =
    db.models;
  const router = Router();
  router.use(requireAuth(db));

  // Module ids from the user's racks only.
  async function validModuleIds(userId, ids) {
    const out = [];
    for (const raw of ids || []) {
      const id = Number(raw);
      if (!(await userHasModule(db, userId, id))) {
        return { error: `Module ${raw} is not in your system` };
      }
      out.push(id);
    }
    return { ids: out };
  }

  // Component ids whose parent module is in one of the user's racks.
  async function validComponentIds(userId, ids) {
    const out = [];
    for (const raw of ids || []) {
      const id = Number(raw);
      const component = await ModuleComponent.findByPk(id);
      if (!component || !(await userHasModule(db, userId, component.module_id))) {
        return { error: `Component ${raw} is not in your system` };
      }
      out.push(id);
    }
    return { ids: out };
  }

  // Patches are strictly private, so "the user's own" is the whole check.
  async function validPatchIds(userId, ids) {
    const out = [];
    for (const raw of ids || []) {
      const id = Number(raw);
      const patch = await Patch.findOne({ where: { id, user_id: userId } });
      if (!patch) return { error: `Patch ${raw} is not yours` };
      out.push(id);
    }
    return { ids: out };
  }

  async function attach(noteId, moduleIds, componentIds, patchIds, transaction) {
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
    for (const id of patchIds || []) {
      const existing = await NotePatch.findOne({
        where: { note_id: noteId, patch_id: id },
        transaction,
      });
      if (!existing) await NotePatch.create({ note_id: noteId, patch_id: id }, { transaction });
    }
  }

  // `includePrivate` is false when the note is being served to someone it was
  // shared with rather than its owner. A note's linked patches and waveform
  // captures are the owner's own private records (patches and captures are
  // never shareable in their own right), so they must not ride out on a note
  // share — only the note's text and the global hardware facts it references
  // (modules, components) do.
  //
  // The list is served whole, so the four link tables are read once for all
  // of its notes and dealt out in JS — four queries per note was eight
  // hundred fired at once for a notebook of two hundred.
  async function notesWithAttachments(notes, { includePrivate = true } = {}) {
    if (notes.length === 0) return [];
    const ids = notes.map((note) => note.id);
    const [moduleLinks, componentLinks, patchLinks, captures] = await Promise.all([
      NoteModule.findAll({
        where: { note_id: ids },
        include: Module,
        order: [
          [Module, 'manufacturer', 'ASC'],
          [Module, 'name', 'ASC'],
        ],
      }),
      NoteComponent.findAll({
        where: { note_id: ids },
        include: [{ model: ModuleComponent, include: [Module] }],
        order: [[ModuleComponent, 'id', 'ASC']],
      }),
      includePrivate
        ? NotePatch.findAll({
            where: { note_id: ids },
            include: Patch,
            order: [[Patch, 'id', 'ASC']],
          })
        : [],
      // Waveform captures filed under a note travel with it — but only for
      // the owner; a share recipient never sees them.
      includePrivate
        ? Capture.findAll({
            where: { note_id: ids },
            order: [['id', 'ASC']],
          })
        : [],
    ]);
    // Dealt out per note in the order the query sorted them, which a filter
    // keeps.
    const byNote = (rows) => {
      const map = new Map();
      for (const row of rows) {
        if (!map.has(row.note_id)) map.set(row.note_id, []);
        map.get(row.note_id).push(row);
      }
      return (noteId) => map.get(noteId) ?? [];
    };
    const modulesOf = byNote(moduleLinks);
    const componentsOf = byNote(componentLinks);
    const patchesOf = byNote(patchLinks);
    const capturesOf = byNote(captures);
    return notes.map((note) => ({
      ...(typeof note.get === 'function' ? note.get({ plain: true }) : note),
      modules: modulesOf(note.id).map(({ Module: m }) => ({
        id: m.id,
        manufacturer: m.manufacturer,
        name: m.name,
      })),
      components: componentsOf(note.id).map(({ ModuleComponent: mc }) => ({
        id: mc.id,
        name: mc.name,
        type: mc.type,
        module_id: mc.module_id,
        module_manufacturer: mc.Module.manufacturer,
        module_name: mc.Module.name,
      })),
      patches: patchesOf(note.id).map(({ Patch: p }) => ({
        id: p.id,
        name: p.name,
        rack_name: p.rack_name,
      })),
      captures: capturesOf(note.id).map((c) => ({
        id: c.id,
        title: c.title,
        caption: c.caption,
        patch_id: c.patch_id,
        image_hash: c.image_hash,
        image_width: c.image_width,
        image_height: c.image_height,
        captured_at: c.captured_at,
      })),
    }));
  }

  async function noteWithAttachments(note, options) {
    return (await notesWithAttachments([note], options))[0];
  }

  async function ownNote(userId, id) {
    return Note.findOne({ where: { id: Number(id), user_id: userId } });
  }

  // Optional ?patch_id= narrows the list to one patch's notes (what the patch
  // page shows).
  router.get('/', asyncHandler(async (req, res) => {
    const where = { user_id: req.user.id };
    if (req.query.patch_id) {
      const links = await NotePatch.findAll({
        where: { patch_id: Number(req.query.patch_id) || 0 },
      });
      where.id = links.map((l) => l.note_id);
    }
    const notes = await Note.findAll({
      where,
      order: [
        ['updated_at', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    res.json(await notesWithAttachments(notes));
  }));

  // Body: { body, title?, module_ids?, component_ids?, patch_ids? }
  router.post('/', asyncHandler(async (req, res) => {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'body is required' });
    const title = req.body?.title ? String(req.body.title).trim() : null;

    const modules = await validModuleIds(req.user.id, req.body?.module_ids);
    if (modules.error) return res.status(400).json({ error: modules.error });
    const components = await validComponentIds(req.user.id, req.body?.component_ids);
    if (components.error) return res.status(400).json({ error: components.error });
    const patches = await validPatchIds(req.user.id, req.body?.patch_ids);
    if (patches.error) return res.status(400).json({ error: patches.error });

    // The note and its attachments are written across four tables; they
    // commit or roll back together.
    const note = await db.sequelize.transaction(async (transaction) => {
      const created = await Note.create(
        { user_id: req.user.id, title, body },
        { transaction }
      );
      await attach(created.id, modules.ids, components.ids, patches.ids, transaction);
      return created;
    });
    res.status(201).json(await noteWithAttachments(note));
  }));

  // One note: yours, or one somebody shared with you (which is read-only —
  // every other route here finds the note under its owner and nowhere else).
  router.get('/:id', asyncHandler(async (req, res) => {
    const found = await readableResource(db, req.user.id, 'note', req.params.id);
    if (!found) return res.status(404).json({ error: 'Note not found' });
    const owner = found.shared ? await db.models.User.findByPk(found.row.user_id) : null;
    res.json({
      ...(await noteWithAttachments(found.row, { includePrivate: !found.shared })),
      shared: found.shared,
      owner_username: owner?.username ?? req.user.username,
    });
  }));

  router.put('/:id', asyncHandler(async (req, res) => {
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
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const note = await ownNote(req.user.id, req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    await note.destroy();
    await removeShares(db, 'note', note.id);
    res.json({ ok: true });
  }));

  // Attach an existing note to more modules/components/patches.
  // Body: { module_ids?, component_ids?, patch_ids? }
  router.post('/:id/attach', asyncHandler(async (req, res) => {
    const note = await ownNote(req.user.id, req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });

    const modules = await validModuleIds(req.user.id, req.body?.module_ids);
    if (modules.error) return res.status(400).json({ error: modules.error });
    const components = await validComponentIds(req.user.id, req.body?.component_ids);
    if (components.error) return res.status(400).json({ error: components.error });
    const patches = await validPatchIds(req.user.id, req.body?.patch_ids);
    if (patches.error) return res.status(400).json({ error: patches.error });
    if (modules.ids.length === 0 && components.ids.length === 0 && patches.ids.length === 0) {
      return res.status(400).json({ error: 'module_ids, component_ids or patch_ids required' });
    }

    await db.sequelize.transaction((transaction) =>
      attach(note.id, modules.ids, components.ids, patches.ids, transaction)
    );
    res.json(await noteWithAttachments(note));
  }));

  // Detach from one module, component or patch.
  // Body: { module_id? , component_id?, patch_id? }
  router.post('/:id/detach', asyncHandler(async (req, res) => {
    const note = await ownNote(req.user.id, req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    const { module_id: moduleId, component_id: componentId, patch_id: patchId } = req.body || {};
    if (moduleId) {
      await NoteModule.destroy({
        where: { note_id: note.id, module_id: Number(moduleId) },
      });
    } else if (componentId) {
      await NoteComponent.destroy({
        where: { note_id: note.id, component_id: Number(componentId) },
      });
    } else if (patchId) {
      await NotePatch.destroy({
        where: { note_id: note.id, patch_id: Number(patchId) },
      });
    } else {
      return res.status(400).json({ error: 'module_id, component_id or patch_id required' });
    }
    res.json(await noteWithAttachments(note));
  }));

  return router;
}
