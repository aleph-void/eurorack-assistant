// Enqueue helpers for the DB-backed job queue. Shared by the routes (which
// queue work on user actions) and the handlers (which chain the pipeline:
// import -> find_manual -> analyze_manual -> panel_image).

export async function enqueueJob(db, type, { userId = null, moduleId = null, questionId = null, payload = null } = {}) {
  const job = await db.models.Job.create({
    type,
    user_id: userId,
    module_id: moduleId,
    question_id: questionId,
    payload: payload ? JSON.stringify(payload) : null,
    status: 'pending',
  });
  return job.get({ plain: true });
}

// Queue a per-module job unless one of the same type is already live for that
// module — the chained pipeline (find_manual → analyze_manual → panel_image)
// and the "re-analyze everything" action both have to be safe to trigger
// twice. The job is owned by (and visible to) the user who caused it.
export async function enqueueModuleJob(db, type, module, userId, payload = null) {
  const pending = await db.models.Job.findOne({
    where: { module_id: module.id, type, status: ['pending', 'running'] },
  });
  if (pending) return null;
  return enqueueJob(db, type, { moduleId: module.id, userId, payload });
}

// Imports always re-try retrieval from the internet — an unchanged manual
// dedupes by content hash against the existing document record.
export const enqueueFindManual = (db, module, userId) =>
  enqueueModuleJob(db, 'find_manual', module, userId);

// Queue the text extraction of ONE document. Unlike the other per-module jobs
// a module may legitimately have several of these in flight at once (its
// shared manual and two uploads are three different documents), so the dedupe
// is on the document rather than on the module.
export async function enqueueExtractManual(db, manual, userId) {
  const live = await db.models.Job.findAll({
    where: { module_id: manual.module_id, type: 'extract_manual', status: ['pending', 'running'] },
  });
  const queued = live.some((job) => {
    try {
      return JSON.parse(job.payload || '{}').manual_id === manual.id;
    } catch {
      return false;
    }
  });
  if (queued) return null;
  return enqueueJob(db, 'extract_manual', {
    moduleId: manual.module_id,
    userId,
    payload: { manual_id: manual.id },
  });
}

// Queue a job about ONE attached video (download_video / analyze_video).
// Like extract_manual, a module may have several videos in flight at once,
// so the dedupe is on the video row named in the payload.
export async function enqueueVideoJob(db, type, video, userId) {
  const live = await db.models.Job.findAll({
    where: { module_id: video.module_id, type, status: ['pending', 'running'] },
  });
  const queued = live.some((job) => {
    try {
      return JSON.parse(job.payload || '{}').video_id === video.id;
    } catch {
      return false;
    }
  });
  if (queued) return null;
  return enqueueJob(db, type, {
    moduleId: video.module_id,
    userId,
    payload: { video_id: video.id },
  });
}
