// How a job is named to the user. Shared by the Jobs page and the toasts a
// job raises when it ends, so the same job is called the same thing wherever
// it is mentioned.

// `analyze_manual` → `Analyze manual`. Job types are named for what they do,
// so the type IS the label once it is spelled like prose.
export function jobTypeLabel(type) {
  const text = String(type || '').replace(/_/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Job';
}

// What the job is about: the module, question, rack or system it names. A job
// carries whichever of those applies to its type.
export function describeJob(job) {
  if (job?.module_name) return `${job.module_manufacturer || ''} ${job.module_name}`.trim();
  if (job?.question_prompt) return job.question_prompt;
  if (job?.rack_name) return job.rack_name;
  if (job?.system_name) return job.system_name;
  return '';
}

// The one-line heading a job gets in a toast: what it was doing, to what.
export function jobHeadline(job) {
  const subject = describeJob(job);
  return subject ? `${jobTypeLabel(job?.type)} — ${subject}` : jobTypeLabel(job?.type);
}
