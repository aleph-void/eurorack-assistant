// What the model is asked when a module needs a front plate, and how many of
// those asks came back readable.
//
// Four prompts, in the order services/panelImage.js tries them: find the
// manufacturer's own product shot, fall back to ModularGrid, locate the
// analyzed components on whichever picture turned up, and — failing every
// picture — read the LAYOUT out of the manual so a plate can be drawn from it.

import { extractJsonObject } from './json.js';
import { PANEL_SHAPES } from './panelShapes.js';

export const PANEL_RESEARCH_TEMPLATE = (manufacturer, name) =>
  `You are researching the eurorack modular synthesizer module: "${manufacturer} ${name}"

Task: find a picture of this module's FRONT PANEL — the flat face of the
module as it appears in a rack, photographed or rendered straight on.

1. Search the manufacturer's official product page for this module, then
   retailers who sell it. Use the maker's own page in preference to anyone
   else's, and do not use rack-planning sites such as ModularGrid.
2. Collect direct links to the image FILES (URLs ending in .jpg, .jpeg, .png
   or .webp), not the pages holding them.
3. Also note how wide the module is in HP, if the page states it.

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{"image_urls": ["https://..."], "page_url": "https://...", "hp": 8}

Rules:
- "image_urls": up to 4 candidate direct image URLs, best first. Prefer a
  complete, straight-on FRONT view of the panel alone, with the camera square
  to the plate (no perspective or visible side edge), on a plain background,
  at the largest resolution offered. Reject every other view: rear/PCB,
  side/top/bottom, three-quarter or tilted "hero" shots, a module installed
  among other rack modules, packaging, product collages, or lifestyle photos.
  Use [] if you cannot find a usable front view.
- "page_url": the page the image was found on, or null.
- "hp": the panel width in HP as a number, or null if it is not stated.
`;

// Asked only when the search above came back with nothing usable. ModularGrid
// is a rack planner rather than a source: its pages are user-maintained, and
// the picture on one is whoever's photograph of whatever they had. But every
// module in it is shown the same way — one panel, straight on, cropped to the
// plate — which is exactly the shape this needs, and a real picture of the
// right module beats the drawing we would otherwise fall back to.
export const PANEL_MODULARGRID_TEMPLATE = (manufacturer, name) =>
  `You are looking for a picture of the front panel of the eurorack modular
synthesizer module "${manufacturer} ${name}". The manufacturer's own site and
the retailers did not have one.

Task: find this module's page on ModularGrid (modulargrid.net) and collect the
direct URL of the panel image shown on it.

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{"image_urls": ["https://..."], "page_url": "https://...", "hp": 8}

Rules:
- "image_urls": up to 4 direct image FILE URLs (ending .jpg, .jpeg, .png or
  .webp), best first. The image must show the complete FRONT plate square on:
  no side edge, perspective, rear/PCB, packaging or rack/lifestyle image.
  ModularGrid serves these from its own image host; give the largest version
  offered. Use [] if you cannot find the module's page or it has no usable
  front-panel picture.
- Make sure the page really is THIS module by THIS manufacturer. ModularGrid
  holds many modules with the same short name, and a picture of the wrong one
  is worse than no picture at all.
- "page_url": the ModularGrid page for the module, or null.
- "hp": the panel width in HP as a number, or null if the page does not say.
`;

const componentList = (components) =>
  components.map((c) => `- ${c.name} (${c.type})`).join('\n');

export const PANEL_MAP_TEMPLATE = (manufacturer, name, components, { cropped = false } = {}) =>
  `You are looking at a photograph of the front panel of the eurorack module
"${manufacturer} ${name}". Locate each of its components on the image.

These are the components the manual describes:

${componentList(components)}

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{
  "is_panel": true,${cropped ? '' : '\n  "panel": { "x": 0.12, "y": 0.02, "w": 0.5, "h": 0.96 },'}
  "components": [
    { "name": "1V/OCT", "x": 0.312, "y": 0.824, "w": 0.14, "h": 0.05 }
  ]
}

Rules:
- ALL coordinates are fractions of the WHOLE image, with 0,0 at the top left
  and 1,1 at the bottom right. "x"/"y" are the CENTRE of the thing, "w"/"h"
  its size. Give "x" and "y" to three decimal places.
- "is_panel" is true ONLY for the complete front face of this exact module,
  viewed square-on as if the panel were flat against the image plane. It is
  false for a different module, rear/PCB shot, side/top/bottom view, ANY
  three-quarter, tilted, or perspective photo (even if the front is visible),
  a rack full of modules, packaging, a product collage, a logo, or a
  placeholder. Say so honestly and return [] for "components": a wrong
  picture is worse than none, and there is a fallback that does not need one.
${
  cropped
    ? `- The image has already been cropped to this module's front plate, so the
  panel fills the frame edge to edge. Every component is somewhere on it.`
    : `- "panel" is the bounding box of this module's front plate within the image,
  excluding background, packaging, other modules and rack rails. Use
  {"x": 0.5, "y": 0.5, "w": 1, "h": 1} if the panel fills the image.`
}
- List one entry per component you can actually see, using the component's
  EXACT name from the list above. Omit the ones you cannot find rather than
  guessing at a position — an unplaced jack is fine, a jack placed on top of
  the wrong hole is not.
- Jacks are the round sockets a patch cable plugs into; knobs are the larger
  round controls with a pointer or indent; sliders are the long slots; the
  small rectangles are buttons and toggles.
- Give the centre of the HARDWARE ITSELF: the middle of a jack's hole, the
  middle of a knob's cap. A panel's silkscreened names are printed a few
  millimetres above or below the things they name, and are NOT part of them.
  Read the name to work out WHICH control you are looking at, then give the
  position of that control alone — a centre that has drifted towards the
  lettering is the one mistake worth taking care over here.
`;

export const PANEL_LAYOUT_TEMPLATE = (manufacturer, name, components) =>
  `You are a eurorack modular synthesizer expert. Using the attached user
manual for "${manufacturer} ${name}", describe the LAYOUT of the module's
front panel, so it can be drawn as a diagram.

These are the components the manual describes:

${componentList(components)}

Respond with ONLY a JSON object, no prose and no code fences, shaped exactly like:

{
  "hp": 8,
  "components": [
    { "name": "1V/OCT", "shape": "jack", "x": 0.3, "y": 0.82 },
    { "name": "FREQ", "shape": "knob", "x": 0.5, "y": 0.18 }
  ]
}

Rules:
- "hp" is the panel width in HP (1HP = 5.08mm) as a number. Give the width the
  manual states; if it states none, estimate it from the panel drawing or the
  number of controls.
- "x" and "y" place the CENTRE of each component on the panel as fractions of
  the panel's own width and height, with 0,0 at the top left of the panel and
  1,1 at the bottom right.
- Follow the panel drawing in the manual: the real positions, in the real
  order, with jacks generally along the bottom and the controls they belong to
  above them. Keep 0.04 clear of every edge, and do not stack two components
  on the same spot.
- "shape" is one of: ${PANEL_SHAPES.join(', ')}. It says how the component is
  drawn, and should follow the component's type from the list above.
- Include EVERY component in the list, using its exact name. Components the
  manual shows on a different panel (an expander) are not part of this one and
  are not in the list — leave them out.
`;

// How many of this job's LLM calls came back with something readable.
//
// Every step below treats an unreadable answer as "nothing found", because
// usually that is what it is: a model that could not find a panel image says
// so, and the drawn panel exists for exactly that case. But a provider that
// is not answering at all fails every call identically — an expired
// subscription, an exhausted quota, a CLI that prints an apology and exits 0 —
// and then "nothing found" is a lie that costs the rack every photographed
// panel it had, replaced by drawings and its images deleted as orphans.
//
// So the two are counted apart. A job where nothing answered is a failed job,
// which leaves the panel the module already has exactly where it is.
// The call has to be counted BEFORE it is made, not after it returns: the
// commonest way for a provider to be down is the CLI exiting non-zero, which
// throws rather than returning anything to read. Counting on the way back
// misses exactly the case this is for.
export function answerTally() {
  return {
    asked: 0,
    answered: 0,
    // One call: counted going in, counted as answered only if it came back
    // and held a JSON object. Throws what the call or the parse throws, which
    // every caller already handles as "this step found nothing".
    async attempt(call) {
      this.asked += 1;
      const value = extractJsonObject(await call());
      this.answered += 1;
      return value;
    },
    silent() {
      return this.asked > 0 && this.answered === 0;
    },
  };
}
