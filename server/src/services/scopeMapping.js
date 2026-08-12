// Working out which oscilloscope pane is looking at what.
//
// A scope sees numbered inputs of an audio interface. A patch knows which
// module instance that interface is, which of its input jacks each channel
// corresponds to, and — through the cables — what is plugged into them. Put
// those together and every pane can name itself: "Make Noise Maths — EOR"
// instead of "CH 3".
//
// All of this is pure: it takes the patch detail the API already builds and
// the state a device announced, and returns rows. The database side lives in
// routes/scope.js.

// Modules that are the audio interface rather than something patched into it.
// The device name usually gives it away ("ES-9"), but a scope reporting a
// generic endpoint name still maps correctly if the patch holds exactly one
// of these.
const INTERFACE_PATTERNS = [
  /\bes-?\d+\b/i, // Expert Sleepers ES-3 / ES-6 / ES-8 / ES-9 / ES-40
  /\bexpert\s*sleepers\b/i,
  /\baudio\s*interface\b/i,
  /\binterface\b/i,
  /\bsoundcard\b/i,
];

// Words that mean a jack carries control voltage rather than audio. Used only
// to pre-set the pane's signal type — the user can always change it, and a
// wrong guess costs a knob turn, not a wrong reading.
const CV_HINTS = [
  'cv',
  'gate',
  'trig',
  'trigger',
  'clock',
  'clk',
  'reset',
  'env',
  'envelope',
  'eoc',
  'eor',
  'eof',
  'lfo',
  'v/oct',
  'voct',
  'pitch',
  'velocity',
  'random',
  'sequence',
  'step',
];

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const squash = (s) => norm(s).replace(/\s+/g, '');

export function looksLikeInterface(manufacturer, name) {
  const full = `${manufacturer ?? ''} ${name ?? ''}`;
  return INTERFACE_PATTERNS.some((re) => re.test(full));
}

// How strongly a patch instance looks like the audio device the scope is
// reading. Higher wins; 0 means "not this one".
export function interfaceMatchScore(patchModule, audioDevice = {}) {
  const deviceText = squash(`${audioDevice.name ?? ''} ${audioDevice.id ?? ''}`);
  const moduleName = squash(patchModule.module_name);
  const manufacturer = squash(patchModule.manufacturer);
  const label = squash(patchModule.label);

  let score = 0;
  // The device name containing the module's name is the strongest signal we
  // can get without asking the user ("ES-9" in "ES-9 (Expert Sleepers)").
  if (moduleName && deviceText.includes(moduleName)) score += 100 + moduleName.length;
  if (manufacturer && deviceText.includes(manufacturer)) score += 40;
  if (label && deviceText.includes(label)) score += 30;
  // The user may have named the instance after the interface in the patch.
  if (looksLikeInterface(patchModule.manufacturer, patchModule.module_name)) score += 20;
  if (score === 0) return 0;
  // An instance with no input jacks cannot be what the scope is reading.
  return inputJacks(patchModule).length === 0 ? 0 : score;
}

function inputJacks(patchModule) {
  return (patchModule.components || []).filter(
    (c) => c.type === 'input_jack' || c.type === 'bidirectional_jack'
  );
}

// The instance the scope is plugged into: the best name match, or — when the
// device name says nothing useful — the only interface-looking module in the
// patch.
export function findInterfaceInstance(modules = [], audioDevice = {}) {
  let best = null;
  let bestScore = 0;
  for (const m of modules) {
    const score = interfaceMatchScore(m, audioDevice);
    if (score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  if (best && bestScore >= 100) return { module: best, matched_by: 'device_name' };

  const candidates = modules.filter(
    (m) => looksLikeInterface(m.manufacturer, m.module_name) && inputJacks(m).length > 0
  );
  if (candidates.length === 1) return { module: candidates[0], matched_by: 'known_interface' };
  if (best) return { module: best, matched_by: 'partial_name' };
  return { module: null, matched_by: 'none' };
}

// The number printed on a jack ("Input 3" -> 3), and what is left once it is
// removed ("input"), so jacks of one panel section can be grouped.
function jackNumber(name) {
  const digits = String(name ?? '').match(/\d+/g);
  if (!digits || digits.length === 0) return null;
  return Number(digits[digits.length - 1]);
}

function jackStem(name) {
  return norm(String(name ?? '').replace(/\d+/g, ' '));
}

// The interface's inputs in channel order.
//
// An ES-9 has "Input 1".."Input 8" but also a headphone jack and other odds
// and ends, so the largest group of same-named numbered jacks wins and the
// numbers decide the order. Falling back on declaration order keeps a module
// whose jacks carry no numbers usable.
export function orderedInputJacks(patchModule, channelCount = 0) {
  const jacks = inputJacks(patchModule);
  if (jacks.length === 0) return [];

  const groups = new Map();
  for (const jack of jacks) {
    const number = jackNumber(jack.name);
    if (number === null) continue;
    const stem = jackStem(jack.name);
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push({ jack, number });
  }

  let bestGroup = null;
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    const covers = channelCount > 0 ? Math.min(entries.length, channelCount) : entries.length;
    const bestCovers =
      bestGroup === null
        ? -1
        : channelCount > 0
          ? Math.min(bestGroup.length, channelCount)
          : bestGroup.length;
    if (covers > bestCovers) bestGroup = entries;
  }

  if (!bestGroup) return jacks;
  const sorted = [...bestGroup].sort((a, b) => a.number - b.number);
  // Numbers usually start at 1, so index 0 of the sorted list is channel 0.
  return sorted.map((e) => e.jack);
}

function isCvName(...parts) {
  const text = ` ${norm(parts.filter(Boolean).join(' '))} `;
  return CV_HINTS.some((hint) => text.includes(` ${norm(hint)} `));
}

// What is arriving at one input jack of the interface, followed back through
// the patch: a cable from somewhere, an active normalled connection, or
// nothing.
export function describeSource(detail, patchModuleId, componentId) {
  const modules = detail.modules || [];
  const moduleById = new Map(modules.map((m) => [m.id, m]));
  const instanceName = (pmId) => {
    const m = moduleById.get(pmId);
    if (!m) return 'unknown module';
    const base = m.label || `${m.manufacturer} ${m.module_name}`;
    // Two of the same module in one patch need telling apart.
    const siblings = modules.filter(
      (o) => o.manufacturer === m.manufacturer && o.module_name === m.module_name
    );
    return !m.label && siblings.length > 1 ? `${base} #${m.instance}` : base;
  };

  const cable = (detail.cables || []).find(
    (c) => c.to_patch_module_id === patchModuleId && c.to_component_id === componentId
  );
  if (cable) {
    const from = instanceName(cable.from_patch_module_id);
    return {
      kind: 'cable',
      source_patch_module_id: cable.from_patch_module_id,
      source_component_id: cable.from_component_id,
      label: `${from} — ${cable.from_component_name}`,
      description: `patched from ${from} ${cable.from_component_name}`,
      signal_type: isCvName(cable.from_component_name) ? 'cv' : 'audio',
    };
  }

  // No cable: an active normalled connection may still be feeding the jack.
  const normal = (detail.normalizations || []).find(
    (n) =>
      n.target_patch_module_id === patchModuleId &&
      n.target_component_id === componentId &&
      n.active &&
      (n.signals || []).length > 0
  );
  if (normal) {
    const signal = normal.signals.find((s) => s.kind !== 'none') || normal.signals[0];
    if (signal?.kind === 'cable') {
      const from = instanceName(signal.from_patch_module_id);
      return {
        kind: 'normal',
        source_patch_module_id: signal.from_patch_module_id,
        source_component_id: signal.from_component_id,
        label: `${from} — ${signal.from_component_name} (normalled)`,
        description: `normalled from ${from} ${signal.from_component_name}`,
        signal_type: isCvName(signal.from_component_name) ? 'cv' : 'audio',
      };
    }
    if (signal?.kind === 'output') {
      const from = instanceName(signal.patch_module_id);
      return {
        kind: 'normal',
        source_patch_module_id: signal.patch_module_id,
        source_component_id: signal.component_id,
        label: `${from} — ${signal.component_name} (normalled)`,
        description: `normalled from ${from} ${signal.component_name}`,
        signal_type: isCvName(signal.component_name) ? 'cv' : 'audio',
      };
    }
    if (signal?.kind === 'internal') {
      return {
        kind: 'normal',
        source_patch_module_id: null,
        source_component_id: null,
        label: `${signal.label} (normalled)`,
        description: `normalled from ${signal.label}`,
        signal_type: isCvName(signal.label) ? 'cv' : 'audio',
      };
    }
  }

  return {
    kind: 'none',
    source_patch_module_id: null,
    source_component_id: null,
    label: null,
    description: 'nothing patched',
    signal_type: null,
  };
}

// The whole map: one row per scope channel, in channel order.
//
// `channels` from the device is only used for its count and its existing
// names — the mapping itself comes from the patch.
export function buildScopeChannelMap({ detail, device = {} } = {}) {
  const audioDevice = device.audio_device || {};
  const channelCount = Math.max(
    Number(audioDevice.channel_count) || 0,
    (device.channels || []).length
  );
  const { module: iface, matched_by: matchedBy } = findInterfaceInstance(
    detail?.modules || [],
    audioDevice
  );
  if (!iface || channelCount === 0) {
    return { matched_by: matchedBy, interface: null, channels: [] };
  }

  const jacks = orderedInputJacks(iface, channelCount);
  const channels = [];
  for (let index = 0; index < channelCount; index++) {
    const jack = jacks[index];
    if (!jack) {
      // More scope channels than the interface has inputs — leave the extras
      // unmapped rather than inventing a jack for them.
      channels.push({
        channel_index: index,
        patch_module_id: null,
        component_id: null,
        component_name: null,
        label: null,
        signal_type: null,
        source_description: null,
      });
      continue;
    }
    const source = describeSource(detail, iface.id, jack.id);
    channels.push({
      channel_index: index,
      patch_module_id: iface.id,
      component_id: jack.id,
      component_name: jack.name,
      // The pane is named after what it is SHOWING, falling back to the jack
      // it is reading when nothing is patched there.
      label: source.label || `${jack.name} (unpatched)`,
      signal_type: source.signal_type,
      source_description: source.description,
      source_patch_module_id: source.source_patch_module_id,
      source_component_id: source.source_component_id,
    });
  }

  return {
    matched_by: matchedBy,
    interface: {
      patch_module_id: iface.id,
      manufacturer: iface.manufacturer,
      module_name: iface.module_name,
      instance: iface.instance,
      label: iface.label ?? null,
    },
    channels,
  };
}
