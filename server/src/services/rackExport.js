// Rack export: everything the user has about a rack's modules — manual PDFs,
// their notes and their questions (with answers) rendered to PDF — zipped as
//   <manufacturer>/<module>/{manuals,notes,questions}/
//     <manufacturer>_<module>_<kind>_<dbId>.pdf
// Runs inside the job worker (export_rack jobs); the finished zip is written
// to EXPORTS_DIR and served once by the exports route, which deletes it after
// a successful download.

import fs from 'node:fs';
import path from 'node:path';
import { Op } from 'sequelize';
import { manualPath } from './pdf.js';
import { textToPdf } from './textPdf.js';
import { createZip } from './zip.js';

// Zips are deleted as soon as they are downloaded; the prune catches the ones
// nobody ever came back for.
export const EXPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function exportFilePath(exportsDir, jobId) {
  return path.join(exportsDir, `rack-export-${Number(jobId)}.zip`);
}

// One path segment inside the zip (same character class safeManualName
// allows for download filenames).
export function safeSegment(value) {
  const cleaned = String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'unknown';
}

// Collects the zip entries for a rack. Only documents the user may see go
// in: the shared auto-found manuals plus their own uploads, and strictly
// their own notes and questions (which qualify via a link to the module
// itself or to one of its jacks).
export async function buildRackExport(db, userId, rack, { manualsDir, log = () => {} } = {}) {
  const {
    RackModule,
    Module,
    Manual,
    ModuleComponent,
    Note,
    NoteModule,
    NoteComponent,
    Question,
    QuestionModule,
    QuestionComponent,
  } = db.models;

  const mappings = await RackModule.findAll({
    where: { rack_id: rack.id },
    include: Module,
    order: [
      [Module, 'manufacturer', 'ASC'],
      [Module, 'name', 'ASC'],
    ],
  });
  const modules = mappings.map((m) => m.Module).filter(Boolean);
  if (modules.length === 0) throw new Error(`rack '${rack.name}' has no modules to export`);

  const entries = [];
  for (const module of modules) {
    const mfr = safeSegment(module.manufacturer);
    const mod = safeSegment(module.name);
    const entryName = (kind, id) => `${mfr}/${mod}/${kind}/${mfr}_${mod}_${kind}_${id}.pdf`;

    const manuals = await Manual.findAll({
      where: { module_id: module.id, [Op.or]: [{ user_id: null }, { user_id: userId }] },
      order: [['id', 'ASC']],
    });
    for (const manual of manuals) {
      const file = manualPath(manualsDir, manual.hash);
      if (!fs.existsSync(file)) {
        log(`skipping '${manual.name}' of ${module.manufacturer} ${module.name}: file missing`);
        continue;
      }
      entries.push({ name: entryName('manuals', manual.id), data: fs.readFileSync(file) });
    }

    const componentIds = (await ModuleComponent.findAll({ where: { module_id: module.id } })).map(
      (c) => c.id
    );

    const notes = new Map();
    for (const link of await NoteModule.findAll({
      where: { module_id: module.id },
      include: [{ model: Note, where: { user_id: userId } }],
    })) {
      notes.set(link.Note.id, link.Note);
    }
    if (componentIds.length) {
      for (const link of await NoteComponent.findAll({
        where: { component_id: componentIds },
        include: [{ model: Note, where: { user_id: userId } }],
      })) {
        notes.set(link.Note.id, link.Note);
      }
    }
    for (const note of [...notes.values()].sort((a, b) => a.id - b.id)) {
      entries.push({
        name: entryName('notes', note.id),
        data: textToPdf([
          { text: note.title || `Note ${note.id}`, bold: true },
          { text: note.body },
        ]),
      });
    }

    const questions = new Map();
    for (const link of await QuestionModule.findAll({
      where: { module_id: module.id },
      include: [{ model: Question, where: { user_id: userId } }],
    })) {
      questions.set(link.Question.id, link.Question);
    }
    if (componentIds.length) {
      for (const link of await QuestionComponent.findAll({
        where: { component_id: componentIds },
        include: [{ model: Question, where: { user_id: userId } }],
      })) {
        questions.set(link.Question.id, link.Question);
      }
    }
    for (const question of [...questions.values()].sort((a, b) => a.id - b.id)) {
      entries.push({
        name: entryName('questions', question.id),
        data: textToPdf([
          { text: 'Question', bold: true },
          { text: question.prompt },
          { text: 'Answer', bold: true },
          { text: question.answer || `(not answered — status: ${question.status})` },
        ]),
      });
    }
  }
  return entries;
}

// Builds the zip and writes it next to any other pending exports. Returns
// the file path and how many documents went in.
export async function writeRackExport(
  db,
  userId,
  rack,
  jobId,
  { manualsDir, exportsDir, log = () => {} } = {}
) {
  const entries = await buildRackExport(db, userId, rack, { manualsDir, log });
  fs.mkdirSync(exportsDir, { recursive: true });
  pruneOldExports(exportsDir, { log });
  const file = exportFilePath(exportsDir, jobId);
  fs.writeFileSync(file, createZip(entries));
  return { file, entryCount: entries.length };
}

export function pruneOldExports(exportsDir, { now = Date.now(), log = () => {} } = {}) {
  let names;
  try {
    names = fs.readdirSync(exportsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^rack-export-\d+\.zip$/.test(name)) continue;
    const file = path.join(exportsDir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > EXPORT_MAX_AGE_MS) {
        fs.rmSync(file, { force: true });
        log(`pruned stale export ${name}`);
      }
    } catch {
      // raced with a concurrent download; the file is gone either way
    }
  }
}
