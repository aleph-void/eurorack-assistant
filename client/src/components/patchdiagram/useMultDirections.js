// Which way a mult runs, once something is plugged into it.
//
// Split out of PatchDiagram.vue because it is the one piece of the picture
// that is pure reasoning about the patch rather than about drawing: given the
// sections and the cables, what is each bidirectional jack IN THIS PATCH.
// The same question the server answers for the cable rules
// (routes/patches/helpers.js) and the tracer (services/patchFlow.js).

import { computed } from 'vue';

// `props` is the diagram's own props (cables, mults, switches); `componentAt`
// resolves an instance id + component id to the component behind the marker.
export function useMultDirections(props, componentAt) {
  // ---- which way a mult runs, once something is plugged into it ----
  // The jacks of a mult section are interchangeable HARDWARE: any of them can
  // be the input. A patch decides which — the one a cable is plugged into is
  // the input, and every other jack in the section carries a copy out — and
  // that is the same rule the server patches by (routes/patches/helpers.js).
  // So once a mult is fed, the picture stops calling its jacks bidirectional
  // and draws the fed one as an input and the rest as outputs: in the type's
  // own colour, offered for dragging the way an output is, and refused as a
  // destination the way an output is.
  //
  // A section is: same instance, same group — the server resolves which jacks
  // those are (services/patchTopology.js), because on a switched multiple the
  // answer depends on the control positions the patch records.
  const BIDIRECTIONAL = 'bidirectional_jack';
  const jackKey = (patchModuleId, componentId) => `${patchModuleId}:${componentId}`;
  // jack → the sections it stands in, and section → its jacks. A jack is in
  // exactly one on ordinary hardware, and in each bus it might be on while a
  // switched multiple's toggle goes unrecorded.
  const multSectionsByJack = computed(() => {
    const map = new Map();
    for (const section of props.mults) {
      for (const j of section.jacks ?? []) {
        const key = jackKey(j.patch_module_id, j.component_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(section.key);
      }
    }
    return map;
  });
  const multJacksBySection = computed(() => {
    const map = new Map();
    for (const section of props.mults) {
      map.set(
        section.key,
        (section.jacks ?? []).map((j) => jackKey(j.patch_module_id, j.component_id))
      );
    }
    return map;
  });

  // The jacks a cable is plugged into, and the jacks a cable LEAVES FROM. Both
  // point a bidirectional jack: signal arriving at one makes it an input, and
  // signal leaving one makes it an output. Reading only the arriving end left a
  // switch whose common is patched onward — the many-to-one direction, four
  // steps feeding one output — with every jack of it still drawn as undecided.
  const fedJacks = computed(
    () => new Set(props.cables.map((c) => jackKey(c.to_patch_module_id, c.to_component_id)))
  );
  const sourcedJacks = computed(
    () => new Set(props.cables.map((c) => jackKey(c.from_patch_module_id, c.from_component_id)))
  );

  // A ROUTING SWITCH is not a mult, and the difference is the whole of this
  // section: a switch SELECTS one of its steps, where a mult COPIES to all of
  // them. So a Doepfer A-151's four step jacks are four alternative ends of ONE
  // connection to the common jack, and cabling one of them says which way the
  // whole section runs: a cable into a step makes every step an input and the
  // common the output (many-to-one, one live at a time), a cable into the
  // common makes the common the input and every step an output (one-to-many).
  // It never makes the OTHER steps outputs — the signal does not come back out
  // of them, and the mult rule below would say it did.
  const switchSections = computed(() =>
    props.switches.map((section) => ({
      common: jackKey(section.common_patch_module_id, section.common_component_id),
      steps: (section.steps ?? []).map((step) => jackKey(step.patch_module_id, step.component_id)),
    }))
  );
  // Every jack that belongs to one, so the mult rule leaves them alone — the
  // same exclusion the server's tracer makes (services/patchFlow.js).
  const switchJackKeys = computed(() => {
    const keys = new Set();
    for (const section of switchSections.value) {
      keys.add(section.common);
      for (const step of section.steps) keys.add(step);
    }
    return keys;
  });

  // What each bidirectional jack IS in this patch, once the cables have pointed
  // it one way: switch sections first, then the mult groups that are left.
  const multDirections = computed(() => {
    const directions = new Map();
    const fed = fedJacks.value;
    const sourced = sourcedJacks.value;
    // Only a jack the hardware leaves open is given a direction; one the panel
    // already calls an input or an output is what it says it is.
    const points = (key, type) => {
      const [patchModuleId, componentId] = key.split(':').map(Number);
      if (componentAt(patchModuleId, componentId)?.type !== BIDIRECTIONAL) return;
      directions.set(key, type);
    };

    // A switch section runs ONE way, and either end of it can be the cable that
    // says which: signal arriving at the common (or leaving a step) runs
    // common → steps, and signal leaving the common (or arriving at a step)
    // runs steps → common. So a common patched into somebody's input is the
    // section's output and its four steps become inputs, which is the
    // many-to-one half of what a routing switch is for.
    for (const section of switchSections.value) {
      const commonIsInput =
        fed.has(section.common) || section.steps.some((step) => sourced.has(step));
      const commonIsOutput =
        sourced.has(section.common) || section.steps.some((step) => fed.has(step));
      // Nothing patched yet, or driven at both ends: the section says nothing
      // about which way it runs, so its jacks stay bidirectional.
      if (commonIsInput === commonIsOutput) continue;
      points(section.common, commonIsInput ? 'input_jack' : 'output_jack');
      for (const step of section.steps) points(step, commonIsInput ? 'output_jack' : 'input_jack');
    }

    const multFed = new Map();
    for (const cable of props.cables) {
      const key = jackKey(cable.to_patch_module_id, cable.to_component_id);
      if (switchJackKeys.value.has(key)) continue;
      const component = componentAt(cable.to_patch_module_id, cable.to_component_id);
      if (component?.type !== BIDIRECTIONAL) continue;
      for (const sectionKey of multSectionsByJack.value.get(key) ?? []) {
        multFed.set(sectionKey, key);
      }
    }
    // A mult jack a cable LEAVES is carrying a copy out, so it is an output
    // whether or not the patch has said yet which of its siblings the copy is
    // of. The siblings stay bidirectional: a mult takes its input at exactly
    // one of them and nothing here knows which, and a second copy may still be
    // dragged out of any of the others.
    for (const key of sourced) {
      if (switchJackKeys.value.has(key)) continue;
      points(key, 'output_jack');
    }
    if (multFed.size === 0) return directions;
    for (const [sectionKey, inputKey] of multFed) {
      for (const key of multJacksBySection.value.get(sectionKey) ?? []) {
        if (switchJackKeys.value.has(key)) continue;
        points(key, key === inputKey ? 'input_jack' : 'output_jack');
      }
    }
    return directions;
  });

  return { jackKey, switchJackKeys, multDirections };
}
