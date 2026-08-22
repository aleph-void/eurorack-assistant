// The pixels of a panel photograph: where the front plate actually is in the
// frame, and where each round piece of hardware actually sits on it.
//
// Component positions come from an LLM looking at the picture
// (services/panelImage.js). A model reading a photograph is reliable about
// WHICH control it is looking at and only approximately right about WHERE it
// is. Measured against the first panels captured here, every one of 23
// markers across three modules landed low by 0.016 ± 0.007 of the image's
// height — about 2% of the panel, half an HP — pulled towards the silkscreened
// name printed under the control it belongs to.
//
// A bias that consistent, on an image we hold the bytes of, is one we can
// measure away rather than argue with. So the model's answer is treated as a
// prior and not as an answer:
//
//   1. The front plate is found by trimming the photograph's background,
//      which needs no model at all: these are product shots of one module on
//      a flat backdrop, and the plate is simply everything that is not the
//      backdrop. That crop is both what the client displays and what gets
//      handed to the model, so it is estimating positions on a picture the
//      panel fills rather than on one it is 4% of.
//   2. Every round component is then snapped to the most convincing circular
//      feature near where the model put it — a jack is a dark hole ringed by a
//      bright nut, a knob a dark cap on a bright plate, and both are far more
//      findable than they are describable. "Near" is generous, because a model
//      that has lost its place rather than merely drifted can be a whole
//      component out; what keeps a generous search honest is that travel costs
//      a candidate score, and that no two markers may claim the same hole.
//   3. Whatever the snapped markers moved by is carried into the ones that
//      could not be snapped (LEDs, toggles, anything flat), interpolated from
//      the hardware directly above and below each of them, so a bias that
//      grows down the panel is followed rather than averaged away.
//
// Every step here is optional: if sharp cannot be loaded or the image cannot
// be decoded, each function returns null and the caller keeps what the model

// The three steps are a file each — reading the bytes, finding the plate,
// snapping the markers — and every caller still imports them from here.

export { cropImage, loadSharp, readPixels } from './panelBitmap.js';
export {
  backgroundLevel,
  boxHp,
  growBox,
  panelCrop,
  pointInBox,
  TRIM_TOLERANCE,
  trimBox,
  writeCrop,
} from './panelPlate.js';
export {
  CONFIDENT_SHARE,
  DRAG_PENALTY,
  discCandidates,
  discScore,
  findDisc,
  MIN_CONTRAST,
  RAIL_MM,
  SEARCH_MM,
  SNAP_RADIUS_MM,
  snapPlacements,
} from './panelSnap.js';
