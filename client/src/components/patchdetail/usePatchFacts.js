import { computed } from 'vue';

// A mult's bidirectional jacks can sit at either end of a cable: plugging
// into one makes it the group's input, the rest carry copies out.
export const FROM_TYPES = ['output_jack', 'bidirectional_jack'];
export const TO_TYPES = ['input_jack', 'bidirectional_jack'];

export const portKindLabel = (kind) => (kind ? kind.replace(/_/g, ' ') : null);

// An EXPANSION HEADER is the ribbon connector an expander's cable plugs into,
// behind the panel rather than on it. It carries signal between two modules,
// but never a signal a person patches — the pair is declared an expander
// instead — so a patch never offers one.
export const isPatchPoint = (component) => component?.port_kind !== 'ribbon';

export function jackLabel(c) {
  const port = portKindLabel(c.port_kind);
  const suffix = c.type === 'bidirectional_jack' ? ` (mult${c.group_label ? ` ${c.group_label}` : ''})` : '';
  return `${c.name}${suffix}${port ? ` [${port}]` : ''}`;
}

// Derived facts about a loaded /api/patches/:id payload, shared by the patch
// detail page and its sections. `patch` is a ref (or prop ref) holding the
// payload, or null while it loads.
export function usePatchFacts(patch) {
const modules = computed(() => patch.value?.modules || []);
const modulesById = computed(() => new Map(modules.value.map((m) => [m.id, m])));
const groups = computed(() => patch.value?.groups || []);
const groupsById = computed(() => new Map(groups.value.map((g) => [g.id, g])));

// A patch built from a system spans several racks, and then which rack a
// module stands in is part of knowing which module it is.
const multiRack = computed(
  () => new Set(modules.value.map((pm) => pm.rack_name).filter(Boolean)).size > 1
);

// "Make Noise Maths", plus "#2" when the rack held several of the module and
// the role this instance plays in the patch when one has been recorded.
function moduleLabel(pm) {
  if (!pm) return '(removed module)';
  const twins =
    pm.module_id === null
      ? modules.value.filter((m) => m.module_id === null && m.module_name === pm.module_name).length
      : modules.value.filter((m) => m.module_id === pm.module_id).length;
  const base = `${pm.manufacturer} ${pm.module_name}`.trim();
  const numbered = twins > 1 ? `${base} #${pm.instance}` : base;
  const named = pm.label ? `${numbered} (${pm.label})` : numbered;
  // Across a system, the rack is part of the name: on the diagram and in the
  // cable list it is what tells two identical modules in two cases apart.
  return multiRack.value && pm.rack_name ? `${named} · ${pm.rack_name}` : named;
}

const cables = computed(() => patch.value?.cables || []);
const cableInto = (pmId, componentId) =>
  cables.value.find((c) => c.to_patch_module_id === pmId && c.to_component_id === componentId) ??
  null;
const cablesOutOf = (pmId, componentId) =>
  cables.value.filter(
    (c) => c.from_patch_module_id === pmId && c.from_component_id === componentId
  );

// ---- what the pickers offer ----
// Options are searched on their hint as well as their label, so a module can
// also be found by the role the patch gives it and a jack by what is already
// plugged into it.
const moduleOptions = (list) =>
  list.map((pm) => ({
    value: pm.id,
    label: moduleLabel(pm),
    hint: pm.live
      ? multiRack.value && pm.rack_name
        ? pm.rack_name
        : undefined
      : pm.external
        ? 'off-rack gear'
        : 'not in this rack',
  }));

// "only with MODE set to LP" / "MODE is set to BP, so this default is one of
// several alternatives" — why a default may or may not be live.
function conditionText(condition) {
  if (!condition) return null;
  if (condition.state === 'selected') return `${condition.component_name} is set to ${condition.value}`;
  if (condition.state === 'unset') {
    return `only with ${condition.component_name} set to ${condition.value} — not recorded in this patch`;
  }
  return `only with ${condition.component_name} set to ${condition.value}`;
}


// jack_index is where this jack sits among the module's jacks of the same
// kind, counting from one. Typing never needs it, but "out one" said out loud
// on a module whose outputs are unnamed has to land somewhere.
const jackCandidates = (types, forDestination) =>
  modules.value.flatMap((pm) => {
    const wanted = pm.components.filter((c) => types.includes(c.type) && isPatchPoint(c));
    const seen = new Map();
    return wanted.map((c) => {
      const index = (seen.get(c.type) || 0) + 1;
      seen.set(c.type, index);
      return {
        patch_module_id: pm.id,
        component_id: c.id,
        module_label: moduleLabel(pm),
        jack_name: c.name,
        jack_type: c.type,
        jack_index: index,
        disabled: forDestination ? Boolean(cableInto(pm.id, c.id)) : false,
      };
    });
  });

  return {
    modules,
    modulesById,
    groups,
    groupsById,
    multiRack,
    moduleLabel,
    moduleOptions,
    cables,
    cableInto,
    cablesOutOf,
    jackCandidates,
    conditionText,
  };
}
