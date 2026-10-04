// Handing a whole system from one account to another.
//
// A system is the studio: its racks, the modules racked in them, the patches
// made from it and everything a user wrote down about any of those. An admin
// moving it to another user is moving ALL of that, because a studio whose
// patches stayed behind with the old owner would be a case of empty jacks.
// Nothing is copied — the rows change hands, with their ids, so every soft
// reference inside a patch (module ids, rack ids, system id) keeps resolving.
//
// What goes, and what makes it the system's:
//
// - the system row itself, every rack in it, and everything hanging off a
//   rack by foreign key (its modules, its rows, its exits);
// - every patch of the old owner made from the system or from one of its
//   racks (`patches.system_id` / `patches.rack_id`), with everything under a
//   patch, and every composition whose every mapped patch goes;
// - a MODULE is a shared record with no owner, so what is transferred about
//   one is the old owner's PRIVATE rows on it: notes, questions, uploaded
//   documents, videos, bench captures and clips, recordings, links. Those go
//   when the module stands in the system and in NO rack the old owner keeps
//   — the moment the racks change hands, such a module is out of the old
//   owner's sight, so their notes on it would be stranded; a module they
//   still have racked elsewhere is still theirs to have notes on, and those
//   stay;
// - a note or a question is about several things at once, so it goes when
//   EVERYTHING it is about goes (and it is about at least one thing); one
//   that straddles the line stays whole with the old owner — except that a
//   question asked OF the system or of one of its racks is about the studio,
//   and goes whatever modules were written under it. A question's follow-ups
//   go with their root. A question that moves may still have
//   attached a note, capture, recording, uploaded document or previous
//   answer that stayed behind: those attachment links are cut, because the
//   answer pipeline reads attachments by id with no owner check and a
//   follow-up asked by the new owner would otherwise read the old owner's
//   private note;
// - shares of a moved record are re-owned, and one that shared it WITH the
//   new owner is dropped — they own it now;
// - the jobs of moved questions, and the model's live work on moved patches,
//   change hands so pending work runs on the new owner's LLM account. Finished
//   jobs stay where they were queued: they are history, not state.
//
// Names are per account (racks and patches in the schema, systems and
// compositions by rule), so a moved record whose name the new owner already
// uses takes the next free '<name> 2', the way an imported patch does.

import { MODEL_PATCH_JOB_TYPES } from './patchGenerator.js';

const lower = (value) => String(value ?? '').trim().toLowerCase();

// The first name of this shape not in `taken` (compared case-insensitively,
// the way rack and system names are told apart): the one wanted, then
// '<name> 2', '<name> 3' ... Always terminates — an account holds finitely
// many names.
export function freeName(taken, wanted) {
  const has = (name) => taken.has(lower(name));
  if (!has(wanted)) return wanted;
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted} ${n}`;
    if (!has(candidate)) return candidate;
  }
}

const ids = (rows, key = 'id') => [...new Set(rows.map((row) => Number(row[key])))];

// Every row's `key` is in `allowed`, and there is at least one row.
const allIn = (rows, key, allowed) => rows.length > 0 && rows.every((row) => allowed.has(row[key]));

// Move `rows` (model instances of the old owner) to the new owner. Returns
// how many went.
async function reown(Model, rowIds, toUserId, transaction, extra = {}) {
  if (rowIds.length === 0) return 0;
  const [count] = await Model.update(
    { user_id: toUserId, ...extra },
    { where: { id: rowIds }, transaction }
  );
  return count;
}

// Rename the rows of `Model` that would collide with a name the new owner
// already has, recording each rename. `taken` is the new owner's names,
// lowercased; it grows as names are handed out so two movers cannot both
// take the same free one.
async function renameColliding(Model, rows, taken, kind, renamed, transaction) {
  for (const row of rows) {
    const from = row.name;
    const name = freeName(taken, from);
    if (name !== from) {
      await row.update({ name }, { transaction });
      renamed.push({ kind, id: row.id, from, to: name });
    }
    taken.add(lower(name));
  }
}

const namesOf = (rows) => new Set(rows.map((row) => lower(row.name)));

// Transfer `system` (a System row) from its owner to `toUserId`. The caller
// has established that the recipient exists and is a different user.
export async function transferSystem(db, system, toUserId) {
  const m = db.models;
  const fromUserId = system.user_id;
  const renamed = [];

  return db.sequelize.transaction(async (transaction) => {
    // Lock the system against a layout save or a rack joining mid-transfer.
    const locked = await m.System.findOne({
      where: { id: system.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!locked || locked.user_id !== fromUserId) return null;

    // ---- the hardware: racks, and which modules are the system's alone ----
    const racks = await m.Rack.findAll({ where: { system_id: system.id }, transaction });
    const rackIds = ids(racks);
    const keptRacks = (await m.Rack.findAll({ where: { user_id: fromUserId }, transaction })).filter(
      (rack) => !rackIds.includes(rack.id)
    );
    const inSystem = rackIds.length
      ? await m.RackModule.findAll({ where: { rack_id: rackIds }, transaction })
      : [];
    const keptElsewhere = keptRacks.length
      ? await m.RackModule.findAll({ where: { rack_id: ids(keptRacks) }, transaction })
      : [];
    const keptModuleIds = new Set(ids(keptElsewhere, 'module_id'));
    const systemModuleIds = new Set(ids(inSystem, 'module_id'));
    const moduleIds = new Set([...systemModuleIds].filter((id) => !keptModuleIds.has(id)));
    const moduleList = [...moduleIds];
    // A component is its module's, so a row linked to a component follows
    // the module rule.
    const components = moduleList.length
      ? await m.ModuleComponent.findAll({
          where: { module_id: moduleList },
          attributes: ['id', 'module_id'],
          transaction,
        })
      : [];
    const componentIds = new Set(ids(components));

    // ---- the patches made from it ----
    const ownPatches = await m.Patch.findAll({ where: { user_id: fromUserId }, transaction });
    const patches = ownPatches.filter(
      (patch) => patch.system_id === system.id || (patch.rack_id !== null && rackIds.includes(patch.rack_id))
    );
    const patchIds = new Set(ids(patches));
    const patchList = [...patchIds];

    // A composition goes when every patch it is mapped onto goes.
    const ownCompositions = await m.Composition.findAll({ where: { user_id: fromUserId }, transaction });
    const pairs = ownCompositions.length
      ? await m.CompositionPatch.findAll({
          where: { composition_id: ids(ownCompositions) },
          transaction,
        })
      : [];
    const compositions = ownCompositions.filter((composition) =>
      allIn(pairs.filter((pair) => pair.composition_id === composition.id), 'patch_id', patchIds)
    );
    const compositionIds = ids(compositions);

    // ---- what was written about any of that ----
    const ownNotes = await m.Note.findAll({ where: { user_id: fromUserId }, attributes: ['id'], transaction });
    const noteIdList = ids(ownNotes);
    const noteModules = noteIdList.length
      ? await m.NoteModule.findAll({ where: { note_id: noteIdList }, transaction })
      : [];
    const noteComponents = noteIdList.length
      ? await m.NoteComponent.findAll({ where: { note_id: noteIdList }, transaction })
      : [];
    const notePatches = noteIdList.length
      ? await m.NotePatch.findAll({ where: { note_id: noteIdList }, transaction })
      : [];
    const noteIds = new Set(
      noteIdList.filter((noteId) => {
        const links = [
          ...noteModules.filter((l) => l.note_id === noteId).map((l) => moduleIds.has(l.module_id)),
          ...noteComponents.filter((l) => l.note_id === noteId).map((l) => componentIds.has(l.component_id)),
          ...notePatches.filter((l) => l.note_id === noteId).map((l) => patchIds.has(l.patch_id)),
        ];
        return links.length > 0 && links.every(Boolean);
      })
    );

    const ownQuestions = await m.Question.findAll({
      where: { user_id: fromUserId },
      attributes: ['id', 'parent_id'],
      transaction,
    });
    const rootIdList = ids(ownQuestions.filter((q) => q.parent_id === null));
    const linkRows = async (Model) =>
      rootIdList.length ? Model.findAll({ where: { question_id: rootIdList }, transaction }) : [];
    const [qSystems, qRacks, qPatches, qModules, qComponents] = await Promise.all([
      linkRows(m.QuestionSystem),
      linkRows(m.QuestionRack),
      linkRows(m.QuestionPatch),
      linkRows(m.QuestionModule),
      linkRows(m.QuestionComponent),
    ]);
    const rackIdSet = new Set(rackIds);
    const rootIds = new Set(
      rootIdList.filter((questionId) => {
        const of = (rows) => rows.filter((l) => l.question_id === questionId);
        // A question asked OF the system or of one of its racks is about the
        // studio itself: the module links written under it are the inventory
        // at the time of asking, not subjects of their own, so a module the
        // old owner also keeps elsewhere does not hold it back.
        if (
          of(qSystems).some((l) => l.system_id === system.id) ||
          of(qRacks).some((l) => rackIdSet.has(l.rack_id))
        ) {
          return true;
        }
        const links = [
          ...of(qSystems).map(() => false),
          ...of(qRacks).map(() => false),
          ...of(qPatches).map((l) => patchIds.has(l.patch_id)),
          ...of(qModules).map((l) => moduleIds.has(l.module_id)),
          ...of(qComponents).map((l) => componentIds.has(l.component_id)),
        ];
        return links.length > 0 && links.every(Boolean);
      })
    );
    // Follow-ups go with their root.
    const questionIds = new Set([
      ...rootIds,
      ...ids(ownQuestions.filter((q) => q.parent_id !== null && rootIds.has(q.parent_id))),
    ]);
    const questionList = [...questionIds];

    // The old owner's private rows on the modules and patches: captures and
    // clips from the bench or the patch, recordings, uploaded documents,
    // videos, links.
    const byOwner = (Model, attributes) =>
      Model.findAll({ where: { user_id: fromUserId }, attributes, transaction });
    const onMovingModuleOrPatch = (row) =>
      (row.module_id !== null && row.module_id !== undefined && moduleIds.has(row.module_id)) ||
      (row.patch_id !== null && row.patch_id !== undefined && patchIds.has(row.patch_id));

    const captures = (await byOwner(m.Capture, ['id', 'module_id', 'patch_id'])).filter(onMovingModuleOrPatch);
    const clips = (await byOwner(m.ScopeClip, ['id', 'module_id', 'patch_id'])).filter(onMovingModuleOrPatch);
    const recordings = (await byOwner(m.AudioRecording, ['id', 'module_id', 'patch_id'])).filter(
      onMovingModuleOrPatch
    );
    const links = (
      await byOwner(m.ResourceLink, ['id', 'module_id', 'patch_id', 'rack_id', 'system_id'])
    ).filter(
      (link) =>
        onMovingModuleOrPatch(link) ||
        link.system_id === system.id ||
        (link.rack_id !== null && rackIdSet.has(link.rack_id))
    );
    const documents = (await byOwner(m.Manual, ['id', 'module_id'])).filter((manual) =>
      moduleIds.has(manual.module_id)
    );
    // A video is one row per (module, user, video): one the new owner already
    // attached themselves is not moved onto theirs — it stays where it was.
    const ownVideos = (await byOwner(m.ModuleVideo, ['id', 'module_id', 'video_id'])).filter((video) =>
      moduleIds.has(video.module_id)
    );
    const theirVideos = ownVideos.length
      ? await m.ModuleVideo.findAll({
          where: { user_id: toUserId, module_id: ids(ownVideos, 'module_id') },
          attributes: ['module_id', 'video_id'],
          transaction,
        })
      : [];
    const theirs = new Set(theirVideos.map((v) => `${v.module_id}:${v.video_id}`));
    const videos = ownVideos.filter((v) => !theirs.has(`${v.module_id}:${v.video_id}`));

    // ---- names the new owner already uses ----
    const theirSystems = await m.System.findAll({ where: { user_id: toUserId }, attributes: ['name'], transaction });
    const theirRacks = await m.Rack.findAll({ where: { user_id: toUserId }, attributes: ['name'], transaction });
    const theirPatches = await m.Patch.findAll({ where: { user_id: toUserId }, attributes: ['name'], transaction });
    const theirCompositions = await m.Composition.findAll({
      where: { user_id: toUserId },
      attributes: ['name'],
      transaction,
    });
    await renameColliding(m.System, [locked], namesOf(theirSystems), 'system', renamed, transaction);
    await renameColliding(m.Rack, racks, namesOf(theirRacks), 'rack', renamed, transaction);
    await renameColliding(m.Patch, patches, namesOf(theirPatches), 'patch', renamed, transaction);
    await renameColliding(
      m.Composition,
      compositions,
      namesOf(theirCompositions),
      'composition',
      renamed,
      transaction
    );
    // A patch snapshots the names of the system and rack it was made from;
    // a rename of either is a fact about the studio the patch should follow.
    for (const entry of renamed) {
      if (!patchList.length) break;
      if (entry.kind === 'system') {
        await m.Patch.update(
          { system_name: entry.to },
          { where: { id: patchList, system_id: system.id }, transaction }
        );
      }
      if (entry.kind === 'rack') {
        await m.Patch.update(
          { rack_name: entry.to },
          { where: { id: patchList, rack_id: entry.id }, transaction }
        );
      }
    }

    // ---- change hands ----
    await locked.update({ user_id: toUserId }, { transaction });
    const moved = {
      racks: await reown(m.Rack, rackIds, toUserId, transaction),
      modules: moduleList.length,
      patches: await reown(m.Patch, patchList, toUserId, transaction),
      compositions: await reown(m.Composition, compositionIds, toUserId, transaction),
      notes: await reown(m.Note, [...noteIds], toUserId, transaction),
      questions: await reown(m.Question, questionList, toUserId, transaction),
      captures: await reown(m.Capture, ids(captures), toUserId, transaction),
      clips: await reown(m.ScopeClip, ids(clips), toUserId, transaction),
      recordings: await reown(m.AudioRecording, ids(recordings), toUserId, transaction),
      links: await reown(m.ResourceLink, ids(links), toUserId, transaction),
      videos: await reown(m.ModuleVideo, ids(videos), toUserId, transaction),
      documents: await reown(m.Manual, ids(documents), toUserId, transaction),
      shares: 0,
      jobs: 0,
    };
    // A document's extracted text inherits the document's visibility.
    if (documents.length) {
      await m.ManualDocument.update(
        { user_id: toUserId },
        { where: { manual_id: ids(documents) }, transaction }
      );
    }

    // A moved question's attachments that stayed behind are cut (see the
    // header): notes, captures, recordings, uploaded documents and previous
    // answers of the old owner's that did not move.
    if (questionList.length) {
      const stayed = async (Model, key, movedSet, ownedRows) => {
        const rows = await Model.findAll({ where: { question_id: questionList }, transaction });
        const owned = new Set(ownedRows);
        const cut = rows.filter((row) => owned.has(row[key]) && !movedSet.has(row[key]));
        for (const row of cut) {
          await Model.destroy({ where: { question_id: row.question_id, [key]: row[key] }, transaction });
        }
      };
      await stayed(m.QuestionNote, 'note_id', noteIds, noteIdList);
      await stayed(
        m.QuestionCapture,
        'capture_id',
        new Set(ids(captures)),
        ids(await byOwner(m.Capture, ['id']))
      );
      await stayed(
        m.QuestionAudio,
        'audio_id',
        new Set(ids(recordings)),
        ids(await byOwner(m.AudioRecording, ['id']))
      );
      await stayed(
        m.QuestionManual,
        'manual_id',
        new Set(ids(documents)),
        ids(await byOwner(m.Manual, ['id']))
      );
      await stayed(m.QuestionAnswer, 'source_question_id', questionIds, ids(ownQuestions));
    }

    // Shares of what moved are the new owner's to hand out; one that shared
    // the record with them is spent.
    const shareable = [
      ['note', [...noteIds]],
      ['patch', patchList],
      ['question', questionList],
      ['rack', rackIds],
      ['document', ids(documents)],
    ];
    for (const [type, resourceIds] of shareable) {
      if (resourceIds.length === 0) continue;
      moved.shares += await m.Share.destroy({
        where: { resource_type: type, resource_id: resourceIds, user_id: toUserId },
        transaction,
      });
      const [count] = await m.Share.update(
        { owner_id: toUserId },
        { where: { resource_type: type, resource_id: resourceIds, owner_id: fromUserId }, transaction }
      );
      moved.shares += count;
    }

    // Pending work on what moved runs on the new owner's account from here.
    if (questionList.length) {
      const [count] = await m.Job.update(
        { user_id: toUserId },
        { where: { user_id: fromUserId, question_id: questionList }, transaction }
      );
      moved.jobs += count;
    }
    if (patchList.length) {
      const live = await m.Job.findAll({
        where: { user_id: fromUserId, type: MODEL_PATCH_JOB_TYPES, status: ['pending', 'running'] },
        attributes: ['id', 'payload'],
        transaction,
      });
      const about = live.filter((job) => {
        try {
          return patchIds.has(Number(JSON.parse(job.payload || '{}').patch_id));
        } catch {
          return false;
        }
      });
      if (about.length) {
        const [count] = await m.Job.update(
          { user_id: toUserId },
          { where: { id: ids(about) }, transaction }
        );
        moved.jobs += count;
      }
    }

    return {
      system: { id: locked.id, name: locked.name },
      from_user_id: fromUserId,
      to_user_id: toUserId,
      moved,
      // Modules standing in the system AND in a rack the old owner keeps:
      // racked over, but the old owner's notes on them stayed.
      kept_modules: [...systemModuleIds].filter((id) => keptModuleIds.has(id)).length,
      renamed,
    };
  });
}

// What an admin sees of a user's systems before moving one: each with how
// much hangs off it.
export async function userSystemsSummary(db, userId) {
  const { System, Rack, RackModule, Patch } = db.models;
  const systems = await System.findAll({
    where: { user_id: userId },
    order: [
      ['name', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  if (systems.length === 0) return [];
  const racks = await Rack.findAll({ where: { user_id: userId }, attributes: ['id', 'system_id'] });
  const mappings = racks.length
    ? await RackModule.findAll({ where: { rack_id: ids(racks) }, attributes: ['rack_id'] })
    : [];
  const patches = await Patch.findAll({
    where: { user_id: userId },
    attributes: ['id', 'rack_id', 'system_id'],
  });
  return systems.map((system) => {
    const own = racks.filter((rack) => rack.system_id === system.id);
    const rackIds = new Set(ids(own));
    return {
      id: system.id,
      name: system.name,
      rack_count: own.length,
      module_count: mappings.filter((mapping) => rackIds.has(mapping.rack_id)).length,
      patch_count: patches.filter(
        (patch) => patch.system_id === system.id || (patch.rack_id !== null && rackIds.has(patch.rack_id))
      ).length,
    };
  });
}
