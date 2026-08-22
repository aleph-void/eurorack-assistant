// Drawing a module as a chip in the rack organizer: the picture at the size
// it is actually painted, and the markers on it.
//
// Split out of RacksView.vue, which is otherwise the organizer itself. Both
// halves here are the same measured regression: a stored panel is the
// multi-megabyte file the manufacturer published, and a rack of two hundred
// of them was fetching every one at 512px whether it was drawn at 180 or at
// 36 — and rebuilding six thousand marker objects on every frame of a drag.

import { ref } from 'vue';
import { componentColor } from '../../componentTypes.js';
import { panelThumbUrl, placementFraction } from '../../panelLayout.js';

export function usePanelChips() {
  // The jacks and controls marked on each panel in the rows, in the colours
  // every other picture of a panel uses (componentTypes.js) — so a rack being
  // built can be read as hardware and not just as blocks of the right width.
  // Off by a tick for anyone who wants the plain pictures back; the inventory
  // chips above are drawn too small for a marker to mean anything, so they
  // never carry them.
  const showMarkers = ref(true);

  // How wide a module is DRAWN in the organizer, which is what its picture is
  // asked for at. The two numbers are the ones in this file's stylesheet
  // (`--hp-px`, `--chip-scale`) — a stored panel is the multi-megabyte file the
  // manufacturer published, and a rack of two hundred of them was fetching
  // every one at 512px whether it was drawn at 180 or at 36.
  const HP_PX = 9;
  const CHIP_SCALE = 0.42;
  const density = () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  const drawnHp = (module) => Math.max(2, Number(module.hp) || 4);
  const panelUrl = (module, scale = 1) =>
    panelThumbUrl(module.panel, drawnHp(module) * HP_PX * scale, density());

  // Worked out ONCE per panel rather than on every render. A drag redraws this
  // view on every frame, and this is called for every module in every row: a
  // two-hundred-module rack rebuilt six thousand marker objects per frame, and
  // re-diffed that many spans, for a picture that had not changed.
  const markerCache = new WeakMap();
  function panelMarkers(panel) {
    if (!showMarkers.value || !panel) return [];
    const cached = markerCache.get(panel);
    if (cached) return cached;
    const markers = buildMarkers(panel);
    markerCache.set(panel, markers);
    return markers;
  }

  function buildMarkers(panel) {
    return (panel.components ?? [])
      .map((placement) => {
        const { fx, fy } = placementFraction(panel, placement);
        // A component the picture places outside the front plate is out of
        // frame, exactly as in the patch diagram: not drawn rather than pinned
        // to an edge it does not sit on.
        if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
        if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
        return {
          key: placement.id ?? `${placement.name}-${fx}-${fy}`,
          fx,
          fy,
          name: placement.name,
          color: componentColor(placement.type),
        };
      })
      .filter(Boolean);
  }

  return { showMarkers, CHIP_SCALE, panelUrl, panelMarkers };
}
