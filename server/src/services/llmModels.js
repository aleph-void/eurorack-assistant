// Which providers there are, which models each offers, and which jobs need
// one at all.
//
// Kept apart from the backends themselves (services/llm.js) because the
// routes and the settings page validate against this list without ever
// spawning a CLI.

export const PROVIDERS = ['claude', 'codex'];

export const KNOWN_MODELS = {
  claude: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  codex: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1', 'gpt-5-codex', 'gpt-5'],
};

export const DEFAULT_MODELS = { claude: 'claude-fable-5', codex: 'gpt-5.1-codex' };

// A model name is written straight into the agent CLI's argv (`--model <name>`
// / `-m <name>`). A value beginning with '-' would be read by the CLI as a
// flag rather than the model, letting a user turn on options the server
// deliberately never passes (a permission or sandbox bypass). So the name is
// held to a conservative shape: it must start with an alphanumeric and contain
// only alphanumerics, dot, underscore and dash. Free-form (not an allowlist)
// so a newly released model still works, but never flag-shaped. Returns an
// error string, or null when the name is acceptable. Blank is allowed by
// callers separately (it means "use the configured default").
export function modelNameProblem(value) {
  const v = String(value);
  if (v.length > 64) return 'model name must be at most 64 characters';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) {
    return 'model name may only contain letters, digits, dot, underscore and dash';
  }
  return null;
}

// Job types that invoke an LLM backend and accept a per-type model override.
// (import and export_rack never call the LLM.)
//
// extract_manual is on the list for a fallback rather than for its job: it
// reads a PDF with pdftotext and no model at all, and only asks one when that
// comes back empty — a manual that is a scan. Worth its own override for
// exactly that reason: transcribing page images is the cheapest thing here to
// point at a small model.
export const LLM_JOB_TYPES = [
  'find_manual',
  'analyze_manual',
  'extract_manual',
  'panel_image',
  'describe_components',
  'find_parameters',
  'analyze_video',
  'scope_question',
  'answer_question',
];
