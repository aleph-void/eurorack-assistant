// Search snippets arrive with the matched words wrapped in [[ ]] by postgres'
// ts_headline (see server/src/routes/manuals.js). They are a fragment of the
// manual's own text, so they are never injected as markup: this splits the
// snippet into plain and matched runs, and the view renders each as an
// element.

const HIGHLIGHT_RE = /\[\[([\s\S]*?)\]\]/g;

export function splitSnippet(snippet) {
  const text = String(snippet ?? '');
  const parts = [];
  let last = 0;
  let match;
  HIGHLIGHT_RE.lastIndex = 0;
  while ((match = HIGHLIGHT_RE.exec(text)) !== null) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), hit: false });
    if (match[1]) parts.push({ text: match[1], hit: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}
