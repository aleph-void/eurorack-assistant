// Reading 'you are out of tokens' out of what a CLI printed.
//
// Neither agent CLI has an exit code for it: an exhausted subscription looks
// like any other non-zero exit, with the real story on STDOUT. The worker
// pauses the account (or the whole queue) on the strength of what this
// recognises, so a miss costs a rack's worth of jobs their panels and a false
// positive stops work that would have run.

// When the limit lifts, if the CLI says so. Understood forms, in order:
// `usage limit reached|1893456000` (Claude's epoch stamp, seconds or ms),
// `try again in 25 minutes`, and `resets 3am` / `resets at 3:30 PM` (local
// time, the next time the clock reads that).
// An exhausted subscription is not a failure of the job: every other job in
// the queue is about to hit the same wall, and each one burns three attempts
// finding that out. These recognize the message the CLI prints so the worker
// can stop the queue instead (jobs/worker.js).
//
// Both CLIs say it in prose on stdout, so the text is all there is to go on.
const QUOTA_PATTERNS = [
  /usage limit reached/i,
  /(hit|reached) your usage limit/i,
  /out of usage credits/i,
  /credit balance is too low/i,
  /insufficient[_ ]quota/i,
  /(quota|rate limit) exceeded/i,
  /exceeded your current quota/i,
  /upgrade to increase your usage limit/i,
];

export function parseQuotaResetAt(text, now = Date.now()) {
  const said = String(text || '');

  const stamp = /usage limit reached\s*\|\s*(\d{9,13})/i.exec(said);
  if (stamp) {
    const value = Number(stamp[1]);
    const ms = value < 1e11 ? value * 1000 : value;
    if (ms > now) return ms;
  }

  const relative = /try again in\s+(?:about\s+)?(\d+)\s*(second|minute|hour)s?/i.exec(said);
  if (relative) {
    const unit = { second: 1000, minute: 60 * 1000, hour: 60 * 60 * 1000 }[
      relative[2].toLowerCase()
    ];
    return now + Number(relative[1]) * unit;
  }

  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(said);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    const meridiem = (clock[3] || '').toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour < 24 && minute < 60) {
      const at = new Date(now);
      at.setHours(hour, minute, 0, 0);
      // A time that has already passed today is tomorrow's.
      if (at.getTime() <= now) at.setDate(at.getDate() + 1);
      return at.getTime();
    }
  }

  return null;
}

// `{ message, resetAt }` if `text` is a provider saying the subscription is
// out of tokens, otherwise null. resetAt is null when it does not say when.
export function detectQuotaExhaustion(text, now = Date.now()) {
  const said = String(text || '');
  if (!QUOTA_PATTERNS.some((pattern) => pattern.test(said))) return null;
  // The quotable part is the line that matched, not the whole transcript.
  const line =
    said
      .split('\n')
      .map((l) => l.trim())
      .find((l) => QUOTA_PATTERNS.some((pattern) => pattern.test(l))) || said.trim();
  return { message: line.slice(0, 300), resetAt: parseQuotaResetAt(said, now) };
}

// The most recent quota exhaustion any CLI run has reported, held here rather
// than raised through the caller because it does not always survive the trip:
// find_manual, for one, catches a failed research call and carries on with
// the archive.org fallback, so the job can succeed (or fail for an unrelated
// reason) with the subscription nonetheless exhausted. The worker drains this
// after every job.
let quotaExhaustion = null;

export function noteQuotaExhaustion(detail) {
  if (!detail) return;
  // Concurrent runners all hit the wall at once; keep the latest reset time,
  // and a known one over an unknown one.
  if (quotaExhaustion) {
    const known = quotaExhaustion.resetAt ?? 0;
    const incoming = detail.resetAt ?? 0;
    if (incoming <= known) return;
  }
  quotaExhaustion = detail;
}

export function takeQuotaExhaustion() {
  const detail = quotaExhaustion;
  quotaExhaustion = null;
  return detail;
}
