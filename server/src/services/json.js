// Tolerant JSON extraction from LLM responses (ports of the helpers in
// eurorack-processor's ask.py / find_manuals.py): accepts code fences and
// surrounding prose.

function extract(text, open, close) {
  text = text.trim();
  const fenceRe = new RegExp('```(?:json)?\\s*(\\' + open + '[\\s\\S]*?\\' + close + ')\\s*```');
  const fenced = text.match(fenceRe);
  if (fenced) {
    return JSON.parse(fenced[1]);
  }
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON ${open === '[' ? 'array' : 'object'} found in response:\n${text}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

export function extractJsonArray(text) {
  const value = extract(text, '[', ']');
  if (!Array.isArray(value)) throw new Error('Extracted JSON is not an array');
  return value;
}

export function extractJsonObject(text) {
  const value = extract(text, '{', '}');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Extracted JSON is not an object');
  }
  return value;
}
