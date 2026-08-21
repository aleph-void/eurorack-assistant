import { computed } from 'vue';
import { isPatchPoint } from '../../panelLayout.js';

// A mult's bidirectional jacks can sit at either end of a cable: plugging
// into one makes it the group's input, the rest carry copies out.
export const FROM_TYPES = ['output_jack', 'bidirectional_jack'];
export const TO_TYPES = ['input_jack', 'bidirectional_jack'];

export const portKindLabel = (kind) => (kind ? kind.replace(/_/g, ' ') : null);

// Which connectors a patch may offer is one rule, kept where the diagram
// keeps it (an expander's ribbon header, a USB socket) so the pickers and the
// picture agree on what is patchable.
export { isPatchPoint };

// A routing switch's jacks are bidirectional too, and calling them mults is
// the one thing a picker must not do: a mult COPIES to its siblings, a switch
// SELECTS the other side of its section. Which a jack is belongs to the patch
// rather than to the component (a switch section is resolved onto instances),
// so the caller passes the role it got from switchRoleOf.
export function jackLabel(c, switchRole = null) {
  const port = portKindLabel(c.port_kind);
  let suffix = '';
  if (c.type === 'bidirectional_jack') {
    if (switchRole === 'common') suffix = ' (switch common)';
    else if (switchRole === 'step') suffix = ' (switch step)';
    else suffix = ` (mult${c.group_label ? ` ${c.group_label}` : ''})`;
  }
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

// How many instances of the same module the patch holds. Counted ONCE per
// payload rather than scanned per call: a studio is two hundred instances and
// naming them all used to be two hundred scans of two hundred, which is most
// of what made the voice pickers take a tenth of a second to build.
const twinKey = (pm) => (pm.module_id === null ? `name:${pm.module_name}` : `id:${pm.module_id}`);
const twinCounts = computed(() => {
  const counts = new Map();
  for (const pm of modules.value) counts.set(twinKey(pm), (counts.get(twinKey(pm)) || 0) + 1);
  return counts;
});

// "Make Noise Maths", plus "#2" when the rack held several of the module and
// the role this instance plays in the patch when one has been recorded.
function moduleLabel(pm) {
  if (!pm) return '(removed module)';
  const twins = twinCounts.value.get(twinKey(pm)) || 0;
  const base = `${pm.manufacturer} ${pm.module_name}`.trim();
  const numbered = twins > 1 ? `${base} #${pm.instance}` : base;
  const named = pm.label ? `${numbered} (${pm.label})` : numbered;
  // Across a system, the rack is part of the name: on the diagram and in the
  // cable list it is what tells two identical modules in two cases apart.
  return multiRack.value && pm.rack_name ? `${named} · ${pm.rack_name}` : named;
}

const cables = computed(() => patch.value?.cables || []);
// An input takes exactly one cable, so the cable in a jack is a lookup rather
// than a search — which matters because the pickers ask it once per jack, and
// a studio has six thousand of them.
const cableByDestination = computed(() => {
  const map = new Map();
  for (const c of cables.value) map.set(`${c.to_patch_module_id}:${c.to_component_id}`, c);
  return map;
});
const cableInto = (pmId, componentId) =>
  cableByDestination.value.get(`${pmId}:${componentId}`) ?? null;
const cablesOutOf = (pmId, componentId) =>
  cables.value.filter(
    (c) => c.from_patch_module_id === pmId && c.from_component_id === componentId
  );

// ---- routing switches ----
// A switch SELECTS one of its connections where a mult COPIES to all of them,
// so a cable into a switch jack means something else entirely: it comes out
// at the OTHER side of the section, not at its siblings. This says which
// jacks are in a section and which side of it each one is, so nothing offers
// a switch step as a copy of the step next to it.
const switchRoles = computed(() => {
  const roles = new Map();
  for (const section of patch.value?.switches || []) {
    roles.set(`${section.common_patch_module_id}:${section.common_component_id}`, 'common');
    for (const step of section.steps || []) {
      roles.set(`${step.patch_module_id}:${step.component_id}`, 'step');
    }
  }
  return roles;
});
const switchRoleOf = (pmId, componentId) => switchRoles.value.get(`${pmId}:${componentId}`) ?? null;

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
// Built for the quick-cable line and the voice listener, both of which want
// every jack in the patch at once. Everything it needs per jack is a map
// lookup or better: the label is named once per instance rather than once per
// jack, and whether a destination is taken comes out of the index above.
const jackCandidates = (types, forDestination) => {
  const taken = forDestination ? cableByDestination.value : null;
  const out = [];
  for (const pm of modules.value) {
    const label = moduleLabel(pm);
    const seen = new Map();
    for (const c of pm.components) {
      if (!types.includes(c.type) || !isPatchPoint(c)) continue;
      const index = (seen.get(c.type) || 0) + 1;
      seen.set(c.type, index);
      out.push({
        patch_module_id: pm.id,
        component_id: c.id,
        module_label: label,
        jack_name: c.name,
        jack_type: c.type,
        jack_index: index,
        disabled: taken ? taken.has(`${pm.id}:${c.id}`) : false,
      });
    }
  }
  return out;
};

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
    switchRoleOf,
    jackCandidates,
    conditionText,
  };
}
