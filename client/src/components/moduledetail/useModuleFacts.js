import { computed } from 'vue';

// Derived facts about a loaded /api/modules/:id payload, shared by the module
// detail page and its sections. `module` is a ref (or prop ref) holding the
// payload, or null while it loads.
export function useModuleFacts(module) {
  // An expander's jacks live on its own module record but take part in this
  // module's signal paths, so both sets are offered wherever a path is
  // recorded — an expander jack is shown with the panel it sits on.
  const linkedComponents = computed(() => module.value?.expander_components || []);
  function panelName(moduleId) {
    const partner = (module.value?.expanders || []).find((e) => e.module_id === moduleId);
    return partner ? `${partner.manufacturer} ${partner.name}` : 'linked panel';
  }
  const patchableComponents = computed(() => [
    ...(module.value?.components || []),
    ...linkedComponents.value.map((c) => ({ ...c, panel: panelName(c.module_id) })),
  ]);
  const componentLabel = (c) => (c.panel ? `${c.name} — ${c.panel}` : c.name);

  function componentName(componentId) {
    const own = module.value?.components?.find((c) => c.id === componentId);
    if (own) return own.name;
    // A jack on a linked expander panel, named with the panel it sits on.
    const linked = linkedComponents.value.find((c) => c.id === componentId);
    if (linked) return `${linked.name} (${panelName(linked.module_id)})`;
    return `#${componentId}`;
  }

  // "MODE = LP", the control position a signal path depends on.
  function conditionText(row) {
    if (!row.condition_component_id) return null;
    return `${componentName(row.condition_component_id)} = ${row.condition_value}`;
  }

  // Controls (anything that isn't a jack) can gate a signal path, and their
  // recorded positions become the values to choose from.
  const controls = computed(
    () => module.value?.components?.filter((c) => !c.type.endsWith('_jack')) || []
  );
  function controlValues(componentId) {
    const control = controls.value.find((c) => c.id === Number(componentId));
    return (control?.values || []).filter((v) => v.type === 'enum');
  }

  // A normalled signal usually lands on an input, but an output normalled to
  // another output is just as real, so every jack is offered as a target.
  const inputJacks = computed(
    () => patchableComponents.value.filter((c) => c.type === 'input_jack') || []
  );
  const outputJacks = computed(
    () => patchableComponents.value.filter((c) => c.type === 'output_jack') || []
  );
  const jacks = computed(() => patchableComponents.value.filter((c) => c.type.endsWith('_jack')));
  const ownJacks = computed(
    () => module.value?.components?.filter((c) => c.type.endsWith('_jack')) || []
  );

  return {
    componentLabel,
    componentName,
    conditionText,
    controls,
    controlValues,
    inputJacks,
    outputJacks,
    jacks,
    ownJacks,
  };
}

// The condition and alternative-group fields shared by normalizations and
// routes: a path that only exists in one position of a control.
export function conditionPayload(control, value, altGroup) {
  const payload = {};
  if (control) {
    payload.condition_component_id = Number(control);
    payload.condition_value = value.trim();
  }
  if (altGroup.trim()) payload.alt_group = altGroup.trim();
  return payload;
}
