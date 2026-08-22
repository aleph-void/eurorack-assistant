// Token accounting.
//
// Both CLIs report what a run cost, in different shapes and with different
// completeness, and neither reports anything unless asked. What comes back is
// normalized to one record; a run whose accounting cannot be read is still a
// run that happened, so a missing usage record is never an error.

// Token accounting
//
// Both CLIs report what a run cost, in different shapes and with different
// completeness, and neither reports anything unless asked. What comes back is
// normalized to one record; a run whose accounting cannot be read is still a
// run that happened, so a missing usage record is never an error.
const tokens = (value) =>
  Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;

const usageRecord = (provider, model, counts) => {
  const record = {
    provider,
    model: model || null,
    input_tokens: tokens(counts.input),
    cache_read_tokens: tokens(counts.cacheRead),
    cache_write_tokens: tokens(counts.cacheWrite),
    output_tokens: tokens(counts.output),
    cost_usd: typeof counts.cost === 'number' && Number.isFinite(counts.cost) ? counts.cost : null,
  };
  record.total_tokens =
    record.input_tokens +
    record.cache_read_tokens +
    record.cache_write_tokens +
    record.output_tokens;
  return record;
};

// `claude -p --output-format json` prints one object: the answer under
// `result`, the totals under `usage`, and a per-model breakdown under
// `modelUsage` — which is the one to read, because a run that delegated to
// subagents spent tokens on models the top-level total does not name.
//
// An older CLI that does not know the flag prints the answer as plain text.
// That still works; it just goes unaccounted.
export function parseClaudeResult(stdout, model = null) {
  const raw = String(stdout ?? '').trim();
  if (!raw.startsWith('{')) return { text: raw, usage: null, isError: false };
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { text: raw, usage: null, isError: false };
  }
  if (typeof json?.result !== 'string') return { text: raw, usage: null, isError: false };

  const entries = Object.entries(json.modelUsage ?? {});
  const counts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: json.total_cost_usd };
  let primary = model;
  let mostOutput = -1;
  for (const [name, used] of entries) {
    counts.input += tokens(used?.inputTokens);
    counts.cacheRead += tokens(used?.cacheReadInputTokens);
    counts.cacheWrite += tokens(used?.cacheCreationInputTokens);
    counts.output += tokens(used?.outputTokens);
    // The model that wrote the most is the one the run is attributed to.
    if (tokens(used?.outputTokens) > mostOutput) {
      mostOutput = tokens(used?.outputTokens);
      primary = used?.canonicalModel || name;
    }
  }
  if (entries.length === 0 && json.usage) {
    counts.input = json.usage.input_tokens;
    counts.cacheRead = json.usage.cache_read_input_tokens;
    counts.cacheWrite = json.usage.cache_creation_input_tokens;
    counts.output = json.usage.output_tokens;
  }
  const usage = usageRecord('claude', primary, counts);
  return {
    text: json.result.trim(),
    usage: usage.total_tokens > 0 || usage.cost_usd !== null ? usage : null,
    isError: Boolean(json.is_error),
  };
}

// `codex exec --json` prints JSONL, and the turn's totals arrive on the last
// `turn.completed` event. Codex counts cached input inside `input_tokens`
// rather than beside it, so the cached part is subtracted back out to keep
// one meaning of "input" across providers. No cost is reported.
export function parseCodexUsage(stdout, model = null) {
  const lines = String(stdout ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event?.usage || !String(event.type || '').startsWith('turn.')) continue;
    const cacheRead = tokens(event.usage.cached_input_tokens);
    const usage = usageRecord('codex', model, {
      input: Math.max(0, tokens(event.usage.input_tokens) - cacheRead),
      cacheRead,
      cacheWrite: event.usage.cache_write_input_tokens,
      output: event.usage.output_tokens,
      cost: null,
    });
    return usage.total_tokens > 0 ? usage : null;
  }
  return null;
}

// Accounting must never be the reason a job fails: the work is done and the
// tokens are spent whether or not the row lands.
export function reportUsage(onUsage, usage) {
  if (!onUsage || !usage) return;
  try {
    Promise.resolve(onUsage(usage)).catch(() => {});
  } catch {
    // a synchronous sink that threw
  }
}
