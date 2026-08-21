// The patch voice patching is talking about: whatever patch DIAGRAM is on
// screen.
//
// The listener is mounted once, over the whole app (App.vue), because the
// setting that turns it on is an account setting rather than a page. What it
// needs from the page is the patch — its id, the jacks either end of a cable
// may name, the cables already in it, and the words this rack uses. The patch
// diagram registers those on the way in and gives them up on the way out, and
// the listener follows.
//
// The lists are handed over as FUNCTIONS, never as lists. They are every jack
// and every cable in the patch — thousands of items on a system — and nothing
// reads them until somebody speaks, so a patch page nobody talks to never
// pays for them.
//
// Claims are counted rather than named because a route swap mounts the
// arriving page BEFORE unmounting the departing one, and both are patch
// diagrams: comparing ids would have the patch being left blank out the patch
// being arrived at. A page only ever gives up the claim it was granted.

import { reactive } from 'vue';

export const voiceTarget = reactive({ patchId: null, label: '', claim: 0 });

// Kept out of the reactive object: they are closures over a patch payload,
// nothing renders them, and making them reactive would have every render of
// the bar hold the whole studio.
let sources = null;

export function setVoicePatch(patchId, { label = '', from, to, cables, vocabulary, onChanged } = {}) {
  voiceTarget.claim += 1;
  voiceTarget.patchId = patchId == null ? null : String(patchId);
  voiceTarget.label = label;
  sources = { from, to, cables, vocabulary, onChanged };
  return voiceTarget.claim;
}

export function clearVoicePatch(claim) {
  if (claim !== voiceTarget.claim) return;
  voiceTarget.patchId = null;
  voiceTarget.label = '';
  sources = null;
}

const listOf = (source) => {
  const value = typeof source === 'function' ? source() : source;
  return Array.isArray(value) ? value : [];
};

// Everything the parser matches what was said against, built at the moment it
// is needed and thrown away again.
export function voicePatchContext() {
  return {
    from: listOf(sources?.from),
    to: listOf(sources?.to),
    cables: listOf(sources?.cables),
  };
}

export const voicePatchVocabulary = () => listOf(sources?.vocabulary);

// A cable went in or came out: the page that registered the patch reloads it.
export const voicePatchChanged = () => sources?.onChanged?.();
