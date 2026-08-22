// How a component is DRAWN on a panel, and how wide a panel with no stated
// width is guessed to be.
//
// A shape is not a component type: three kinds of jack are one hole, and the
// picture only ever needs to know the hole. Split out of panelImage.js because
// the prompts, the placement maths and the SVG renderer all need it and none
// of them needs the other two.

import { HP_MM, PANEL_MM_HEIGHT, PX_PER_MM, DEFAULT_HP } from './panelGeometry.js';

// How a marker is drawn. Derived from the component's analyzed type, or
// stated by the LLM when it places something the analysis did not list.
export const PANEL_SHAPES = [
  'jack',
  'knob',
  'slider',
  'button',
  'toggle',
  'switch',
  'display',
  'other',
];

const SHAPE_FOR_TYPE = {
  input_jack: 'jack',
  output_jack: 'jack',
  bidirectional_jack: 'jack',
  knob: 'knob',
  slider: 'slider',
  button: 'button',
  toggle: 'toggle',
  switch: 'switch',
  display: 'display',
};

export const shapeForComponent = (component) => SHAPE_FOR_TYPE[component?.type] || 'other';

const MIN_HP = 2;
const MAX_HP = 84;

// A component list this long stops fitting a single narrow column, so an
// unstated width is guessed from it rather than left at DEFAULT_HP.
const HP_PER_COMPONENT = 1.2;

// Geometry passes straight through: every renderer that needs a shape needs
// the millimetre scale it is drawn at.
export { HP_MM, PANEL_MM_HEIGHT, PX_PER_MM, DEFAULT_HP };
export { MIN_HP, MAX_HP, HP_PER_COMPONENT };
