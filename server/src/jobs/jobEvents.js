// Who hears about a job, and in what shape.
//
// Every job is stamped with the user who caused it at enqueue time; job
// status and progress events are visible to that user ALONE (the module or
// question the job is about is updated for everyone). The queue's own state
// is the exception — one exhausted subscription stops it for everybody — and
// goes to every connected user.
//
// Split out of jobs/worker.js, which is the queue engine itself.

// The job types whose payload names what the job is about — export_rack its
// rack and, once complete, the download link; trim_panels the system it
// sweeps; generate_patch and patch_turn the patch they are wiring up. Every
// other type's payload is read by its handler alone, and an import's is the
// whole pasted file.
const LABELLED_JOB_TYPES = new Set(['export_rack', 'trim_panels', 'generate_patch', 'patch_turn']);

const NO_LABELS = Object.freeze({
  rack_name: null,
  system_name: null,
  patch_id: null,
  patch_name: null,
  download: null,
});

// What a job's payload says about its target, in the shape the jobs API and
// the job events both carry. An import emits hundreds of progress lines and
// every one of them used to parse the whole payload again, so the last
// payload parsed is remembered: the same string answers the same way.
let lastPayload = null;
let lastLabels = NO_LABELS;
export function payloadLabels(job) {
  if (!job.payload || !LABELLED_JOB_TYPES.has(job.type)) return NO_LABELS;
  if (job.payload === lastPayload) return lastLabels;
  let labels = NO_LABELS;
  try {
    const payload = JSON.parse(job.payload);
    labels = {
      rack_name: payload.rack_name ?? null,
      system_name: payload.system_name ?? null,
      patch_id: payload.patch_id ?? null,
      patch_name: payload.patch_name ?? null,
      download: payload.download ?? null,
    };
  } catch {
    // payload is not JSON (never the case for export, trim or patch jobs)
  }
  lastPayload = job.payload;
  lastLabels = labels;
  return labels;
}

export function createJobEvents(db, { bus = null, log = () => {} } = {}) {
  // The user a job belongs to. Every job is stamped with the user who caused
  // it at enqueue time; job status and progress events are visible to that
  // user only (module/question state itself is updated for everyone).
  async function jobOwners(job) {
    if (job.user_id) return [job.user_id];
    if (job.question_id) {
      const question = await db.models.Question.findByPk(job.question_id);
      return question ? [question.user_id] : [];
    }
    return [];
  }

  // What the job is about, in the same shape the jobs API returns — the
  // client renders WebSocket job events directly, so without these fields a
  // job that first appears over the socket would have no target label.
  async function jobLabels(job) {
    const labels = { module_manufacturer: null, module_name: null, question_prompt: null };
    if (job.module_id) {
      const module = await db.models.Module.findByPk(job.module_id);
      if (module) {
        labels.module_manufacturer = module.manufacturer;
        labels.module_name = module.name;
      }
    }
    if (job.question_id) {
      const question = await db.models.Question.findByPk(job.question_id);
      if (question) labels.question_prompt = question.prompt;
    }
    return labels;
  }

  function jobSummary(job) {
    const {
      id,
      type,
      module_id,
      question_id,
      status,
      attempts,
      error,
      module_manufacturer = null,
      module_name = null,
      question_prompt = null,
    } = job;
    const { rack_name, system_name, patch_id, patch_name, download } = payloadLabels(job);
    return {
      id,
      type,
      module_id,
      question_id,
      status,
      attempts,
      error,
      module_manufacturer,
      module_name,
      question_prompt,
      rack_name,
      system_name,
      patch_id,
      patch_name,
      download,
    };
  }

  function publish(userIds, event, job, message) {
    log(`job ${job.id} (${job.type}) ${event}${message ? `: ${message}` : ''}`);
    if (!bus) return;
    for (const userId of userIds) {
      bus.publish(userId, { kind: 'job', event, job: jobSummary(job), message });
    }
  }

  // The queue is a shared resource — one exhausted subscription stops it for
  // everyone — so its state goes to every connected user rather than to the
  // owner of whichever job happened to hit the wall.
  function publishQueue(event, pause) {
    if (!bus?.publishAll) return;
    bus.publishAll({
      kind: 'queue',
      event,
      paused: Boolean(pause.paused),
      until: pause.until ?? null,
      reason: pause.reason ?? '',
    });
  }

  return { jobOwners, jobLabels, jobSummary, publish, publishQueue };
}
