// Minimal PDF writer used to render notes and questions for rack exports:
// plain paragraphs in Helvetica (bold for headings), word-wrapped and
// paginated. Deliberately dependency-free — the only other PDF tooling in the
// image is headless chromium, far too heavy for a few paragraphs of text.

const PAGE_WIDTH = 612; // US letter, in points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const LEADING = 14;
const BODY_FONT = '/F1 11 Tf';
const BOLD_FONT = '/F2 12 Tf';
const MAX_CHARS = 88; // ≈ the 504pt text width in 11pt Helvetica
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LEADING);

// PDF string literal: escape the delimiters and force single-byte WinAnsi —
// the built-in fonts cannot address anything beyond it.
function escapeText(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '(') out += '\\(';
    else if (ch === ')') out += '\\)';
    else if (code < 0x20 || code > 0xff) out += '?';
    else out += ch;
  }
  return out;
}

function wrapLine(line, max = MAX_CHARS) {
  if (line.length <= max) return [line];
  const out = [];
  let current = '';
  for (let word of line.split(' ')) {
    while (word.length > max) {
      if (current) {
        out.push(current);
        current = '';
      }
      out.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= max) current += ` ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out.length ? out : [''];
}

// blocks: [{ text, bold? }] — each block is a paragraph, separated from the
// next by a blank line. Returns the PDF file as a Buffer.
export function textToPdf(blocks) {
  const lines = [];
  for (const block of blocks) {
    const text = String(block?.text ?? '').replace(/\r\n?/g, '\n');
    if (!text.trim()) continue;
    for (const raw of text.split('\n')) {
      for (const wrapped of wrapLine(raw)) lines.push({ text: wrapped, bold: !!block.bold });
    }
    lines.push({ text: '', bold: false });
  }
  while (lines.length && lines[lines.length - 1].text === '') lines.pop();
  if (lines.length === 0) lines.push({ text: '(empty)', bold: false });

  const pages = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }

  // Object numbers: 1 catalog, 2 page tree, 3/4 fonts, then a (page, content
  // stream) pair per page.
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  );
  objects.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  );

  for (const page of pages) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objects.length + 2} 0 R >>`
    );
    const ops = ['BT', `${LEADING} TL`, `1 0 0 1 ${MARGIN} ${PAGE_HEIGHT - MARGIN - LEADING} Tm`];
    let font = null;
    for (const line of page) {
      const wanted = line.bold ? BOLD_FONT : BODY_FONT;
      if (wanted !== font) {
        ops.push(wanted);
        font = wanted;
      }
      ops.push(`(${escapeText(line.text)}) Tj`, 'T*');
    }
    ops.push('ET');
    const stream = ops.join('\n');
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
