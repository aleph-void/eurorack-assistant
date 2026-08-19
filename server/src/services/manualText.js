// Manual text: turn a stored PDF into a markdown document that can be read in
// the browser and searched in the database.
//
// poppler's pdftotext does the extraction (the same poppler-utils package the
// PDF validation and the LLM CLIs already rely on); everything below it is
// structure recovery. A PDF has no headings, lists or paragraphs — it has
// glyphs at coordinates, and pdftotext hands back the lines those glyphs fall
// on. So the text is read back the way a person reads a page: lines that stand
// alone and look like titles become headings, lines that start with a bullet
// become list items, consecutive lines become one paragraph, and the header or
// footer repeated on every page is dropped as furniture.
//
// The result is deliberately deterministic — no model runs. A manual is
// extracted in a second or two, on import and on upload alike, which is what
// makes it affordable to do for every document the app holds.
//
// The exception is the document poppler gets nothing out of: a manual that is
// a scan, or pages drawn as images, has no text layer to recover structure
// from and no amount of heuristics will invent one. Those fall back to asking
// the LLM provider to read the pages (extractWithModel, at the bottom), which
// is the one thing a deterministic path cannot do at any price. The row
// records which of the two it was, in `source`.

import { execFile } from 'node:child_process';
import { findPdftotext } from './pdf.js';

// A 300-page manual runs to a few megabytes of text; the ceiling is here to
// stop a pathological document taking the worker's memory with it.
export const MAX_TEXT_BYTES = 32 * 1024 * 1024;
export const EXTRACT_TIMEOUT_MS = 120_000;

// Below this, "extraction" produced nothing worth storing — the usual cause is
// a manual that is a scan, i.e. page images with no text layer at all.
export const MIN_DOCUMENT_CHARS = 40;

// Read a PDF's text in reading order. Deliberately NOT pdftotext -layout:
// layout mode keeps a two-column page as two columns side by side, which reads
// as interleaved nonsense; the default mode follows the flow of the text.
export async function extractPdfText(filePath, opts = {}) {
  const {
    pdftotextPath = findPdftotext(),
    execImpl = execFile,
    timeoutMs = EXTRACT_TIMEOUT_MS,
  } = opts;
  if (!pdftotextPath) {
    throw new Error('no pdftotext binary on PATH; cannot extract the text of a manual');
  }
  return new Promise((resolve, reject) => {
    execImpl(
      pdftotextPath,
      ['-q', '-enc', 'UTF-8', '-eol', 'unix', filePath, '-'],
      { timeout: timeoutMs, maxBuffer: MAX_TEXT_BYTES },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout || ''));
        // poppler explains itself on stderr ("Syntax Error: ..."); the error
        // object only carries an exit status.
        const detail = String(stderr || '').trim().split('\n')[0] || err.message;
        reject(new Error(`pdftotext could not read the document: ${detail}`));
      }
    );
  });
}

// ---- text normalization ----

const LIGATURES = [
  [/ﬀ/g, 'ff'],
  [/ﬁ/g, 'fi'],
  [/ﬂ/g, 'fl'],
  [/ﬃ/g, 'ffi'],
  [/ﬄ/g, 'ffl'],
  [/ﬅ|ﬆ/g, 'st'],
];

// Everything that follows assumes lines separated by \n, pages separated by
// \f, and no other control characters or exotic spaces in the way.
export function normalizeText(raw) {
  let text = String(raw ?? '').replace(/\r\n?/g, '\n');
  for (const [pattern, replacement] of LIGATURES) text = text.replace(pattern, replacement);
  return text
    // Zero-width and directional marks: invisible, and they break word
    // matching. The soft hyphen goes with them: it marks where a word MAY be
    // split, so a PDF that split one leaves it behind in the middle of a word.
    .replace(/[\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    // Control characters other than the newline and the page break.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '')
    // Any remaining exotic whitespace (nbsp, thin space, tab) is just a space.
    .replace(/[^\S\n\f]/g, ' ')
    .replace(/ +$/gm, '');
}

// The pages of an extracted document. pdftotext writes a form feed after every
// page, so the split leaves an empty tail segment.
export function splitPages(text) {
  const pages = text.split('\f');
  if (pages.length > 1 && pages[pages.length - 1].trim() === '') pages.pop();
  return pages;
}

// ---- page furniture ----

// A line that is only a page number, in the shapes manuals write them:
// "7", "- 7 -", "Page 7", "7 of 40", "7/40".
const PAGE_NUMBER_RE =
  /^(?:[-–—]\s*)?(?:page\s*)?\d{1,4}(?:\s*(?:\/|of)\s*\d{1,4})?(?:\s*[-–—])?$/i;

export const isPageNumberLine = (line) => PAGE_NUMBER_RE.test(line.trim());

// How many lines at the top and bottom of a page count as its edges — where a
// running header or footer lives.
const EDGE_LINES = 2;

// Furniture is short — a module name, a chapter title, a page number. The
// ceilings matter because dropping a line that is really part of the manual is
// far worse than leaving a header in: a long line has to repeat *exactly* to
// count, and only a short one may repeat with its digits wildcarded (which is
// what makes "Maths manual — page 4" the same line as "…— page 5").
const FURNITURE_MAX_CHARS = 60;
const NUMBERED_FURNITURE_MAX_CHARS = 40;

const furnitureKey = (line) => {
  const text = line.trim().toLowerCase();
  if (!text || text.length > FURNITURE_MAX_CHARS) return '';
  return text.length <= NUMBERED_FURNITURE_MAX_CHARS ? text.replace(/\d+/g, '#') : text;
};

function edgeIndexes(lines) {
  const filled = lines.map((line, i) => [line, i]).filter(([line]) => line.trim() !== '');
  return new Set([
    ...filled.slice(0, EDGE_LINES).map(([, i]) => i),
    ...filled.slice(-EDGE_LINES).map(([, i]) => i),
  ]);
}

// Drop the module name, chapter title or page number that sits at the top or
// bottom of every page. Left in, they interrupt the text at every page
// boundary — and, worse, they turn into a heading roughly once per page.
export function stripPageFurniture(pages) {
  const scanned = pages.map((page) => {
    const lines = page.split('\n');
    return { lines, edges: edgeIndexes(lines) };
  });

  const counts = new Map();
  for (const { lines, edges } of scanned) {
    const seen = new Set();
    for (const i of edges) {
      const key = furnitureKey(lines[i]);
      // A line only counts once per page, so a header repeated within one page
      // cannot pass for one repeated across the document.
      if (!key || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  // On at least half the pages, and never on the strength of one or two.
  const threshold = Math.max(3, Math.ceil(pages.length / 2));
  const repeated = new Set(
    [...counts].filter(([, n]) => n >= threshold).map(([key]) => key)
  );

  return scanned.map(({ lines, edges }) =>
    lines
      .filter((line, i) => {
        if (!edges.has(i)) return true;
        const key = furnitureKey(line);
        return !((key && repeated.has(key)) || isPageNumberLine(line));
      })
      .join('\n')
  );
}

// ---- block structure ----

// A hyphen at the end of a line is usually a word broken across the line, not
// a hyphenated word — rejoin it. A capital after the break means it was a real
// hyphen ("MIDI-Sync"), so only lowercase continuations are glued.
export function joinWrapped(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (/[a-z]-$/.test(left) && /^[a-z]/.test(right)) return left.slice(0, -1) + right;
  return `${left} ${right}`;
}

const BULLET_RE = /^\s*([•‣▪◦●○·*+]|[-–—])\s+(?=\S)/;
const ORDERED_RE = /^\s*(\d{1,3})[.)]\s+(?=\S)/;
// A numbered section title: "3 Oscillators", "3.1 The sine core".
const SECTION_RE = /^\s*(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(\S.*)$/;

// Text laid out in columns: a spec table, a pinout, a patch-idea grid. Three
// or more spaces inside a line is pdftotext's way of showing that gap, and the
// alignment is the information — so those blocks are kept verbatim rather than
// reflowed into a paragraph.
const COLUMNAR_RE = /\S {3,}\S/;

function isPreformatted(lines) {
  if (lines.length < 2) return false;
  const columnar = lines.filter((line) => COLUMNAR_RE.test(line)).length;
  return columnar >= Math.ceil(lines.length / 2);
}

// How prominent a lone line is as a heading, or 0 when it is ordinary text.
export function headingLevel(line) {
  const text = line.trim();
  if (!text || text.length > 80) return 0;
  // A bullet is a list item however title-like it reads.
  if (BULLET_RE.test(text)) return 0;
  // Prose, not a title.
  if (/[.,;:!?]$/.test(text)) return 0;

  const words = text.split(/\s+/);
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (!letters) return 0;
  // A word long enough to be a word rather than a unit: without one, the line
  // is a measurement ("20 HP", "60 mA") or a code, not a title — including
  // when it reads like a numbered section.
  const longestWord = Math.max(...words.map((w) => w.replace(/[^A-Za-z]/g, '').length));
  if (longestWord < 3) return 0;

  const section = SECTION_RE.exec(text);
  if (section && section[2].length <= 70) {
    return Math.min(4, section[1].split('.').length + 1);
  }

  // A SHOUTED line is how most manuals write a section title.
  if (text === text.toUpperCase() && words.length <= 12) return 2;
  // Title Case: every word long enough to be a real word is capitalized. A
  // lone short word is far more often a table cell than a title, so a
  // one-word heading has to be a long one.
  const significant = words.filter((w) => w.replace(/[^A-Za-z]/g, '').length >= 4);
  if (
    words.length <= 8 &&
    significant.length > 0 &&
    (words.length >= 2 || letters.length >= 8) &&
    significant.every((w) => /^[^A-Za-z]*[A-Z]/.test(w))
  ) {
    return 3;
  }
  return 0;
}

// Markdown constructs the source text did not mean: a paragraph that happens
// to start with '#' is not a heading, and one that starts with '>' is not a
// quote. Only the start of a line can begin a construct, and blocks are joined
// into single lines before this runs.
function escapeBlockStart(text) {
  return text.replace(/^([#>])/, '\\$1');
}

function fence(lines) {
  const longest = Math.max(0, ...lines.map((line) => (/^`+/.exec(line.trim()) || [''])[0].length));
  const marker = '`'.repeat(Math.max(3, longest + 1));
  return `${marker}\n${lines.join('\n')}\n${marker}`;
}

function renderList(lines) {
  const items = [];
  for (const line of lines) {
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet ? null : ORDERED_RE.exec(line);
    const match = bullet || ordered;
    if (match) {
      items.push({
        marker: ordered ? `${ordered[1]}.` : '-',
        text: line.slice(match[0].length).trim(),
      });
    } else if (items.length > 0) {
      // A wrapped continuation of the item above it.
      const item = items[items.length - 1];
      item.text = joinWrapped(item.text, line.trim());
    } else {
      items.push({ marker: '-', text: line.trim() });
    }
  }
  return items.map((item) => `${item.marker} ${item.text}`.trimEnd()).join('\n');
}

function renderBlock(lines) {
  if (isPreformatted(lines)) return fence(lines);
  if (lines.length === 1) {
    const level = headingLevel(lines[0]);
    if (level > 0) return `${'#'.repeat(level)} ${lines[0].trim()}`;
  }
  if (BULLET_RE.test(lines[0]) || ORDERED_RE.test(lines[0])) return renderList(lines);
  return escapeBlockStart(lines.reduce((text, line) => joinWrapped(text, line.trim()), ''));
}

// Consecutive non-blank lines, which is as much of a paragraph as a PDF says.
function splitBlocks(text) {
  const blocks = [];
  let current = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

// Blocks are only as good as the blank lines the PDF happens to have, and
// plenty of documents have none at all — every line of a page arrives as one
// run, title and body and list together. Line LENGTH is the signal that
// survives: a line in the middle of a wrapped paragraph reaches the right
// margin, so a line that falls well short of it is the end of something.
// Titles and the last line of a paragraph are short; body lines are not.
const isMarkerLine = (line) => BULLET_RE.test(line) || ORDERED_RE.test(line);

// Below this the text is too narrow (a column, a table, a title page) for line
// length to mean anything, and the block is left as it came.
const MIN_REFLOW_WIDTH = 40;
const SHORT_LINE_RATIO = 0.65;

// Whether the list item on `previous` is over, so `line` starts something new
// rather than continuing it: the item stopped short of the margin, and either
// it closed a sentence or the new line runs the full width.
function endsItem(previous, isShort, line) {
  if (!isShort(previous)) return false;
  return /[.!?]$/.test(previous.trimEnd()) || !isShort(line);
}

export function reflowBlock(lines) {
  if (lines.length < 3) return [lines];
  const lengths = lines.map((line) => line.trimEnd().length).sort((a, b) => a - b);
  // The right margin, read off the lines themselves rather than assumed. The
  // 90th percentile rather than the longest, so one runaway line cannot set it.
  const width = lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.9))];
  if (width < MIN_REFLOW_WIDTH) return [lines];
  const cut = width * SHORT_LINE_RATIO;
  const isShort = (line) => line.trimEnd().length < cut;

  const blocks = [];
  let current = [];
  const close = () => {
    if (current.length > 0) blocks.push(current);
    current = [];
  };
  for (const line of lines) {
    const inList = current.length > 0 && isMarkerLine(current[0]);
    if (current.length > 0) {
      // Prose giving way to a list.
      if (!inList && isMarkerLine(line)) close();
      // A list giving way back to prose. A line with no marker belongs to the
      // item above it only as a wrapped continuation — and a continuation
      // cannot follow an item that already ended, which is what a short line
      // finishing on a full stop means.
      else if (inList && !isMarkerLine(line) && endsItem(current.at(-1), isShort, line)) close();
    }
    current.push(line);
    // Inside a list every item ends short, which says nothing about where the
    // list ends — so the short-line rule only closes prose.
    if (!isMarkerLine(current[0]) && isShort(line)) close();
  }
  close();
  return blocks;
}

// The whole conversion: extracted text in, markdown out. `title` becomes the
// document's H1 — the module it belongs to, which is also what makes a search
// for a module's name find its manual.
export function pdfTextToMarkdown(raw, { title = null } = {}) {
  const pages = stripPageFurniture(splitPages(normalizeText(raw)));
  const parts = [];
  const heading = String(title ?? '').trim();
  if (heading) parts.push(`# ${heading}`);
  for (const block of splitBlocks(pages.join('\n\n'))) {
    // A columnar block is structure in its own right and is never reflowed —
    // the alignment is what it is saying.
    const pieces = isPreformatted(block) ? [block] : reflowBlock(block);
    for (const piece of pieces) {
      const rendered = renderBlock(piece);
      if (rendered.trim()) parts.push(rendered);
    }
  }
  return parts.length > 0 ? `${parts.join('\n\n')}\n` : '';
}

// How the document names itself. The shared manual is the module's own
// document, so it is titled after the module; an upload carries the label its
// owner gave it, since a module may have several.
export function manualDocumentTitle(module, manual) {
  const moduleName = `${module.manufacturer || ''} ${module.name || ''}`.trim() || 'Module';
  const label = String(manual?.name || '').trim();
  return !label || label.toLowerCase() === 'manual' ? moduleName : `${moduleName} — ${label}`;
}

// ---- the fallback, for the PDFs poppler cannot read ----

// Asked only when pdftotext came back with nothing: a manual that is page
// images with no text layer, or a file poppler refuses outright. The model
// reads the pages the way a person would, which is the one thing the
// deterministic path cannot do at any price.
export const MANUAL_TEXT_TEMPLATE = (manufacturer, name) =>
  `The attached PDF is the user manual for the eurorack modular synthesizer
module "${manufacturer} ${name}". Its text cannot be extracted mechanically —
it is most likely a scan, or pages drawn as images.

Task: transcribe the whole document into Markdown, so it can be read and
searched as text.

Rules:
- Reproduce what the manual SAYS, in the order it says it, from the first page
  to the last. This is a transcription, not a summary: do not shorten, skip,
  reorder or explain anything, and do not add anything the pages do not say.
- Use Markdown for the structure that is visibly there: "#"/"##"/"###" for the
  headings, "-" for bulleted lists, "1." for numbered ones, tables as Markdown
  tables. Ordinary prose becomes ordinary paragraphs.
- Leave out page furniture — the header, footer and page number repeated on
  every page.
- Where a page is genuinely unreadable, write "> [unreadable page]" on its own
  line and carry on. Do not guess at what it might have said.
- Do not start with a title heading; one is added afterwards.
- Answer with the Markdown ALONE. No preamble, no commentary, no code fences
  around the whole thing.
`;

// The model's answer as a document body: the fence it may have wrapped
// everything in, and any title of its own, both removed — the H1 is ours, and
// is what tells the reader which manual this is.
export function cleanModelMarkdown(answer) {
  let text = String(answer ?? '').trim();
  const fenced = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1].trim();
  return text.replace(/^# .*\n+/, '').trim();
}

export async function extractWithModel(backend, module, manual, filePath, log = () => {}) {
  log('the PDF has no text layer; asking the model to read it instead');
  const answer = await backend.analyzeDocument(
    MANUAL_TEXT_TEMPLATE(module.manufacturer, module.name),
    filePath
  );
  const body = cleanModelMarkdown(answer);
  if (body.replace(/\s+/g, ' ').trim().length < MIN_DOCUMENT_CHARS) {
    throw new Error('the model read nothing out of the PDF either');
  }
  return body;
}

// Extract one document's text and record it. The row is keyed on the manual,
// so re-extracting (a re-import, a manual replaced by a newer revision)
// rewrites the text in place rather than accumulating copies.
//
// pdftotext first, always: it is free, deterministic and takes a second, which
// is what makes extracting every document the app holds affordable. A model is
// asked only where that produces nothing — a scanned manual, or a PDF poppler
// will not open — and only when the caller supplied a backend to ask.
export async function extractManualDocument(db, manual, module, filePath, deps = {}) {
  const { log = () => {}, backend = null, ...extractOpts } = deps;
  const { ManualDocument } = db.models;

  const title = manualDocumentTitle(module, manual);
  let raw = null;
  let body = null;
  let source = 'pdftotext';
  let failure = null;

  try {
    raw = await extractPdfText(filePath, extractOpts);
    const markdown = pdfTextToMarkdown(raw, { title });
    // The H1 is ours, so it does not count towards "did this PDF have any
    // text".
    const stripped = markdown.replace(/^# .*\n/, '').trim();
    if (stripped.replace(/\s+/g, ' ').length >= MIN_DOCUMENT_CHARS) body = stripped;
    else failure = new Error('the PDF has no text to extract (it is most likely a scan)');
  } catch (e) {
    failure = e;
  }

  if (!body) {
    if (!backend) {
      throw new Error(`${failure.message}, and there is no model configured to read it instead`);
    }
    log(failure.message);
    try {
      body = await extractWithModel(backend, module, manual, filePath, log);
      source = 'llm';
    } catch (e) {
      // Both roads are closed; the deterministic failure is the one that
      // explains the document, so it leads.
      throw new Error(`${failure.message}. Reading it with the model failed too: ${e.message}`);
    }
  }

  const content = `# ${title}\n\n${body}\n`;
  const pages = raw ? splitPages(normalizeText(raw)).length : null;
  log(
    `extracted ${pages ?? 'an unknown number of'} page(s), ${content.length} characters of ` +
      `markdown${source === 'llm' ? ' (read by the model)' : ''}`
  );

  const fields = {
    manual_id: manual.id,
    module_id: module.id,
    user_id: manual.user_id ?? null,
    hash: manual.hash,
    title,
    content,
    pages,
    chars: content.length,
    source,
  };
  const existing = await ManualDocument.findOne({ where: { manual_id: manual.id } });
  const row = existing ? await existing.update(fields) : await ManualDocument.create(fields);
  return row.get({ plain: true });
}
