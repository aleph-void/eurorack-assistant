// Hard deletion of module records and everything hanging off them. Module
// rows are shared across users, so callers only invoke this once a module is
// no longer mapped into any rack — at that point the record belongs to no
// account and removing it is safe. Deleting a module takes with it:
//   - its components and manual records (DB cascade), plus manual PDF files
//     once no other record references the same content hash
//   - the *requesting user's* questions and notes attached to the module or
//     one of its components. Other users' questions and notes are never
//     deleted on someone else's action — they only lose their link rows to
//     the removed module (DB cascade)
//   - remaining link tables and jobs, via the schema's ON DELETE CASCADE

import fs from 'node:fs';
import { manualPath } from './pdf.js';
import { panelPath } from './image.js';
import { removeShares } from './sharing.js';

export async function deleteModulesDeep(
  db,
  userId,
  moduleIds,
  { manualsDir, panelsDir = process.env.PANELS_DIR || '/data/panels' }
) {
  const {
    Module,
    ModuleComponent,
    ModulePanel,
    Manual,
    Question,
    QuestionModule,
    QuestionComponent,
    Note,
    NoteModule,
    NoteComponent,
  } = db.models;
  if (moduleIds.length === 0) return { modules: 0, questions: 0, notes: 0 };

  const components = await ModuleComponent.findAll({
    where: { module_id: moduleIds },
    attributes: ['id'],
  });
  const componentIds = components.map((c) => c.id);

  // The user's own questions/notes that reference the doomed modules,
  // directly or via one of their components.
  const ownQuestion = { model: Question, where: { user_id: userId }, attributes: ['id'] };
  const ownNote = { model: Note, where: { user_id: userId }, attributes: ['id'] };
  const questionIds = new Set();
  const noteIds = new Set();
  for (const qm of await QuestionModule.findAll({
    where: { module_id: moduleIds },
    include: [ownQuestion],
  })) {
    questionIds.add(qm.question_id);
  }
  for (const nm of await NoteModule.findAll({
    where: { module_id: moduleIds },
    include: [ownNote],
  })) {
    noteIds.add(nm.note_id);
  }
  if (componentIds.length > 0) {
    for (const qc of await QuestionComponent.findAll({
      where: { component_id: componentIds },
      include: [ownQuestion],
    })) {
      questionIds.add(qc.question_id);
    }
    for (const nc of await NoteComponent.findAll({
      where: { component_id: componentIds },
      include: [ownNote],
    })) {
      noteIds.add(nc.note_id);
    }
  }

  const manuals = await Manual.findAll({
    where: { module_id: moduleIds },
    attributes: ['id', 'hash'],
  });
  const hashes = [...new Set(manuals.map((m) => m.hash))];
  const panels = await ModulePanel.findAll({
    where: { module_id: moduleIds },
    attributes: ['image_hash', 'image_ext'],
  });

  await db.sequelize.transaction(async (transaction) => {
    if (questionIds.size > 0) {
      await Question.destroy({ where: { id: [...questionIds] }, transaction });
    }
    if (noteIds.size > 0) {
      await Note.destroy({ where: { id: [...noteIds] }, transaction });
    }
    await Module.destroy({ where: { id: moduleIds }, transaction });
    // Shares point at their record by id with no foreign key to cascade
    // through, so the records that go here take their shares by hand.
    for (const id of questionIds) await removeShares(db, 'question', id, { transaction });
    for (const id of noteIds) await removeShares(db, 'note', id, { transaction });
    for (const manual of manuals) await removeShares(db, 'document', manual.id, { transaction });
  });

  // Manual files are content-addressed and shared by every record with the
  // same hash (other modules, other users' uploads); only remove a file once
  // its last database reference is gone.
  for (const hash of hashes) {
    if ((await Manual.count({ where: { hash } })) === 0) {
      fs.rmSync(manualPath(manualsDir, hash), { force: true });
    }
  }
  // Panel images follow the same rule: the row cascaded away with the module,
  // the file goes once nothing else points at those bytes.
  for (const panel of panels) {
    if ((await ModulePanel.count({ where: { image_hash: panel.image_hash } })) === 0) {
      fs.rmSync(panelPath(panelsDir, panel.image_hash, panel.image_ext), { force: true });
    }
  }
  return { modules: moduleIds.length, questions: questionIds.size, notes: noteIds.size };
}
