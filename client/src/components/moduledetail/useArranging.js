// Putting one marker right, wherever the front plate is drawn.
//
// Arranging is a MODE over the picture: one component is picked, only its
// marker is shown, and it is dragged onto the hardware it names. It started
// as something the components page did, but the page a marker is wrong on is
// whichever page is showing the plate — the module's own page, and each of
// the jack pages — so the state and the two awkward cases live here and every
// one of them shares them.
//
// The awkward cases are both about having something to take hold of: a
// component the panel has no placement for at all is given one, and a marker
// whose stored position falls outside the crop is moved to the middle of the
// plate first. Arranging is how a marker is put right, so it has to start
// somewhere it can be reached.

import { computed, nextTick, ref } from 'vue';
import { api } from '../../api.js';
import { outOfFrame, usePanelMarkers } from './usePanelMarkers.js';

export function useArranging(module, moduleId, reload) {
  const { panelError, panelStatus, movePanelMarker } = usePanelMarkers(module, moduleId, reload);
  const arrangedComponentId = ref(null);
  const arrangeError = ref('');

  const arrangedComponent = computed(
    () =>
      (module.value?.components || []).find((c) => c.id === arrangedComponentId.value) || null
  );

  const stopArranging = () => {
    arrangedComponentId.value = null;
  };

  // Picking the same component again puts the picture back the way it was, so
  // the button is a toggle and nothing has to be dismissed.
  async function arrange(component, { onArranged } = {}) {
    if (arrangedComponentId.value === component.id) return stopArranging();
    arrangeError.value = '';
    try {
      const placement = (module.value?.panel?.components || []).find(
        (row) => row.component_id === component.id
      );
      if (module.value?.panel && !placement) {
        const { panel } = await api.post(`/api/modules/${moduleId.value}/panel/components`, {
          component_id: component.id,
        });
        if (panel && module.value) module.value = { ...module.value, panel };
      } else if (module.value?.panel && outOfFrame(module.value.panel, placement)) {
        const crop = module.value.panel.crop || {};
        await movePanelMarker({
          id: placement.id,
          name: placement.name,
          x: (crop.x ?? 0) + (crop.w || 1) / 2,
          y: (crop.y ?? 0) + (crop.h || 1) / 2,
        });
      }
      arrangedComponentId.value = component.id;
      await nextTick();
      onArranged?.(component);
    } catch (e) {
      arrangeError.value = e.message;
    }
  }

  return {
    arrangedComponentId,
    arrangedComponent,
    arrange,
    stopArranging,
    arrangeError,
    movePanelMarker,
    panelError,
    panelStatus,
  };
}
