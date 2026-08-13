// Eurorack panel geometry, in real millimetres: 1HP is 5.08mm and a 3U panel
// is 128.5mm tall. Its own module because both halves of the panel work need
// it — services/panelImage.js draws a panel to this scale, and
// services/panelPixels.js measures a photographed one against it — and they
// import each other's other half.

export const HP_MM = 5.08;
export const PANEL_MM_HEIGHT = 128.5;

// Generated panels are drawn at this many SVG units per millimetre, so every
// glyph on one can be sized in millimetres.
export const PX_PER_MM = 8;

export const DEFAULT_HP = 8;
