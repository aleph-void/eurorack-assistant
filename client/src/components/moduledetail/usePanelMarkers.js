import { ref } from 'vue';
import { api } from '../../api.js';
import { placementFraction } from '../../panelLayout.js';

// A marker whose stored position falls outside the front plate. Positions are
// fractions of the WHOLE image and the plate is the crop within it, so a
// re-crop (or a bad guess from the analysis) can leave one off the picture
// altogether — drawn pinned to an edge, or not drawn at all in the diagram
// and the rack rows, and in no case where the hardware is.
export function outOfFrame(panel, placement) {
  const { fx, fy } = placementFraction(panel, placement);
  return !(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1);
}

// Dragging a marker onto the hardware it names. Both pages that draw the
// front plate — the module's own page and the components page, where a
// marker is arranged beside the row it belongs to — save it the same way.
export function usePanelMarkers(module, moduleId, reload) {
  const panelError = ref('');
  const panelStatus = ref('');

  // Saved where it was dropped: the position is only ever an estimate, and
  // someone looking at the picture has better evidence than the estimate did.
  // The panel comes back from the save so the marker settles on exactly what
  // was stored rather than on where the pointer happened to be.
  async function movePanelMarker({ id, name, x, y }) {
    panelError.value = '';
    panelStatus.value = '';
    try {
      const { panel } = await api.patch(
        `/api/modules/${moduleId.value}/panel/components/${id}`,
        { x, y }
      );
      if (panel && module.value) module.value = { ...module.value, panel };
      panelStatus.value = `Moved ${name}.`;
    } catch (e) {
      panelError.value = e.message;
      // The save failed, so the marker must go back to where it really is
      // rather than sit where it was dropped.
      await reload();
    }
  }

  return { panelError, panelStatus, movePanelMarker };
}
