// Drawing the logical panel.
//
// The last resort of services/panelImage.js: no photograph could be found, so
// the layout read out of the manual is drawn here as an SVG. Deliberately
// built in our own code rather than asked of the model — the drawing and the
// stored positions have to agree, and markup from a model is not something to
// serve from our origin.

import { HP_MM, PANEL_MM_HEIGHT, PX_PER_MM, DEFAULT_HP } from './panelShapes.js';

const xmlEscape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Glyph geometry in millimetres, so a drawn panel is to scale with the real
// thing: a 3.5mm jack sits in an 8mm nut, a standard knob is about 12mm.
const GLYPH_MM = {
  jack: { r: 4 },
  knob: { r: 6 },
  slider: { w: 5, h: 26 },
  button: { w: 6, h: 6 },
  toggle: { w: 4, h: 8 },
  switch: { w: 5, h: 9 },
  display: { w: 22, h: 11 },
  other: { r: 4 },
};

const round = (n) => Math.round(n * 10) / 10;

function glyph(shape, cx, cy, mm) {
  const g = GLYPH_MM[shape] || GLYPH_MM.other;
  if (g.r) {
    const r = g.r * mm;
    if (shape === 'knob') {
      // A knob reads as a knob because of its pointer.
      return (
        `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" class="knob"/>` +
        `<line x1="${round(cx)}" y1="${round(cy)}" x2="${round(cx)}" y2="${round(cy - r * 0.8)}" class="pointer"/>`
      );
    }
    const cls = shape === 'jack' ? 'jack' : 'other';
    return (
      `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" class="${cls}"/>` +
      (shape === 'jack'
        ? `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r * 0.42)}" class="jack-hole"/>`
        : '')
    );
  }
  const w = g.w * mm;
  const h = g.h * mm;
  const cls = shape === 'display' ? 'display' : 'control';
  return (
    `<rect x="${round(cx - w / 2)}" y="${round(cy - h / 2)}" width="${round(w)}" ` +
    `height="${round(h)}" rx="${round(mm)}" class="${cls}"/>`
  );
}

// Draw the panel: an SVG the client renders exactly like a photograph, with
// the same fractional positions overlaid on it. Deliberately built here
// rather than asked of the LLM — the drawing and the stored positions must
// agree, and markup from a model is not something to serve from our origin.
export function renderPanelSvg({ manufacturer, name, hp, placements }) {
  const mm = PX_PER_MM;
  const width = Math.round((hp || DEFAULT_HP) * HP_MM * mm);
  const height = Math.round(PANEL_MM_HEIGHT * mm);
  const label = `${manufacturer} ${name}`.trim();
  const font = round(2.6 * mm);
  const titleFont = round(3.4 * mm);

  const parts = [];
  for (const p of placements) {
    const cx = p.x * width;
    const cy = p.y * height;
    parts.push(`<g><title>${xmlEscape(p.name)}</title>${glyph(p.shape, cx, cy, mm)}</g>`);
    const g = GLYPH_MM[p.shape] || GLYPH_MM.other;
    const below = (g.r ? g.r : g.h / 2) * mm + font;
    parts.push(
      `<text x="${round(cx)}" y="${round(cy + below)}" class="label" font-size="${font}">` +
        `${xmlEscape(p.name)}</text>`
    );
  }

  return {
    width,
    height,
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${xmlEscape(label)} front panel">
  <title>${xmlEscape(label)}</title>
  <style>
    .plate { fill: #1c1c28; stroke: #3a3a52; stroke-width: ${round(0.4 * mm)}; }
    .rail { fill: #2a2a3c; }
    .jack { fill: #0d0d14; stroke: #6d6d8a; stroke-width: ${round(0.35 * mm)}; }
    .jack-hole { fill: #05050a; }
    .knob { fill: #2f2f42; stroke: #8b5cf6; stroke-width: ${round(0.35 * mm)}; }
    .pointer { stroke: #e4e4e7; stroke-width: ${round(0.4 * mm)}; stroke-linecap: round; }
    .control { fill: #2f2f42; stroke: #8b5cf6; stroke-width: ${round(0.3 * mm)}; }
    .display { fill: #0d0d14; stroke: #4ade80; stroke-width: ${round(0.3 * mm)}; }
    .other { fill: #23233a; stroke: #6d6d8a; stroke-width: ${round(0.3 * mm)}; }
    .label { fill: #c8c8d4; font-family: 'Inter', system-ui, sans-serif; text-anchor: middle; }
    .title { fill: #a78bfa; font-family: 'Inter', system-ui, sans-serif; text-anchor: middle; font-weight: 600; }
  </style>
  <rect x="0" y="0" width="${width}" height="${height}" class="plate"/>
  <rect x="0" y="0" width="${width}" height="${round(3 * mm)}" class="rail"/>
  <rect x="0" y="${round(height - 3 * mm)}" width="${width}" height="${round(3 * mm)}" class="rail"/>
  <text x="${round(width / 2)}" y="${round(8 * mm)}" class="title" font-size="${titleFont}">${xmlEscape(
    name
  )}</text>
  ${parts.join('\n  ')}
</svg>
`,
  };
}
