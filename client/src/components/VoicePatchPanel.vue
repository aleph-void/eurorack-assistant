<script setup>
// Patching by voice. "Connect Make Noise Maths out one to 2hp Div clock in",
// and the cable is documented before your hand is back on the case.
//
// The panel is a lid over five small modules that each do one thing:
// speechInput turns a microphone into words, voiceActivation decides when the
// microphone is open, voiceCommand turns words into two jack ids, audioDevices
// says which microphone and which speaker, and patchSounds says whether it
// worked — because you are looking at the rack, not at this screen, and the
// beep is the whole answer.
//
// Every setting here is kept in this browser and under this account's own key.
// A deviceId means nothing on another machine, and a shared studio desktop is
// two people with two headsets — so none of it goes to the server.
//
// Nothing is plugged on a maybe. Below the confidence you set, the panel says
// what it thinks it heard and waits, and the tone it plays for that is not the
// tone it plays for a cable going in.

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { api } from '../api.js';
import { toast } from '../toast.js';
import { useAuthStore } from '../stores/auth.js';
import {
  createSpeechInput,
  engineAvailability,
  ENGINE_UNUSABLE,
  ENGINES,
} from '../speechInput.js';
import { WHISPER_MODELS } from '../whisperInput.js';
import { ACTIVATION_MODES, createVoiceActivation, isContinuous } from '../voiceActivation.js';
import {
  listAudioDevices,
  nameDevices,
  outputRoutingSupported,
  watchAudioDevices,
} from '../audioDevices.js';
import { createPatchSounds } from '../patchSounds.js';
import { parseBestAlternative, pickedOption, describeEndpoint } from '../voiceCommand.js';

const props = defineProps({
  patchId: { type: String, required: true },
  // Each of these is a list, OR a function that builds one when it is
  // wanted. They are every jack and every cable in the patch — thousands of
  // items on a system — and nothing here reads them until somebody speaks, so
  // the patch page hands over the way to build them rather than the lists
  // themselves, and a page with the voice panel closed never pays for them.
  fromCandidates: { type: [Array, Function], default: () => [] },
  toCandidates: { type: [Array, Function], default: () => [] },
  cableCandidates: { type: [Array, Function], default: () => [] },
  vocabulary: { type: [Array, Function], default: () => [] },
});
const emit = defineEmits(['changed']);

// ---- settings ----

const STORAGE_KEY = 'eurorack-assistant.voice';
const DEFAULTS = {
  enabled: false,
  engine: 'webspeech',
  model: 'Xenova/whisper-tiny.en',
  mode: 'ptt',
  key: 'Space',
  wakeWords: 'patch, hey rack',
  connectPhrase: 'create connection between',
  disconnectPhrase: 'disconnect connection between',
  inputDeviceId: '',
  outputDeviceId: '',
  binding: null,
  confirmBelow: 0.75,
  volume: 0.7,
  sounds: true,
  speakErrors: false,
};
const settings = reactive({ ...DEFAULTS });

// One key per account, because a studio machine is logged into by more than
// one person and a microphone is a personal choice. The old shared key is read
// as the starting point so that nobody's settings vanish on the way in, and it
// is never written to again.
const auth = useAuthStore();
const storageKey = () => (auth.user?.id ? `${STORAGE_KEY}.${auth.user.id}` : STORAGE_KEY);

function loadSettings() {
  const read = (key) => {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}');
    } catch {
      return {};
    }
  };
  Object.assign(settings, DEFAULTS, read(STORAGE_KEY), read(storageKey()));
}
function saveSettings() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ ...settings }));
  } catch {
    /* nothing here is worth failing over */
  }
}

// Read back before the watchers below exist, so that restoring a saved setting
// is not mistaken for changing one — otherwise a rack owner who left voice
// switched on gets two microphones opened on the way in.
loadSettings();
const available = ref(engineAvailability());

// Why this browser cannot run each engine, said in terms of what to do about
// it. The answer is a different one for each: Firefox has no recogniser of its
// own, and a page served over plain HTTP is never handed a microphone.
const ENGINE_REFUSALS = {
  webspeech:
    'This browser has no speech recognition of its own. Chrome and Edge do; Firefox does not. ' +
    'Local Whisper runs anywhere a microphone does.',
  whisper:
    'This browser will not hand over a microphone here, and Whisper needs one to listen. A page ' +
    'served over plain HTTP cannot ask for it — reach this app over HTTPS or localhost.',
};

const engineLabel = (value) => ENGINES.find((e) => e.value === value)?.label || value;
const workingEngine = () => ENGINES.map((e) => e.value).find((v) => available.value[v]) || null;

// A setting restored from a browser that cannot run it is quietly moved to one
// that can: nothing has been asked for yet, so there is nothing to report.
if (!available.value[settings.engine]) settings.engine = workingEngine() || settings.engine;

// Both engines are always on offer. An engine this browser cannot run used to
// be a greyed-out line, which says "no" without ever saying why — and the why
// is the whole of what is useful here. So it can be picked, and picking it
// explains itself.
const engineOptions = computed(() =>
  ENGINES.map((e) => ({ ...e, available: available.value[e.value] }))
);

// Choosing an engine this browser cannot run. Said twice — over the page,
// because the choice is made in a fold of settings that is easy to look away
// from, and inline beside the picker that was just used.
watch(
  () => settings.engine,
  (engine, previous) => {
    if (available.value[engine]) return;
    const refusal = `${engineLabel(engine)} is not available in this browser. ${ENGINE_REFUSALS[engine]}`;
    toast.error(refusal);
    say(refusal, 'error');
    // Back to whichever engine does work — the one just left if it still does,
    // otherwise the other one. If neither runs here the choice stands, since
    // moving it would only be swapping one refusal for the other.
    //
    // Put back on the NEXT tick, not this one: a <select> that is corrected
    // inside the same turn as the change event keeps the option the pointer
    // landed on (Vue holds the element while it is assigning), and the picker
    // would then disagree with the engine actually running. A tick later it
    // snaps back, which is also the honest picture — the choice was taken and
    // then refused.
    const fallback = available.value[previous] ? previous : workingEngine();
    if (fallback) nextTick(() => { settings.engine = fallback; });
  }
);

// The browser's recogniser is present but its service is out of reach — the
// usual answer on a self-hosted box, where Chromium ships without a key for
// Google's speech servers. Whisper is the way out and it is one click away,
// but it fetches a model the first time, so it is offered rather than taken.
const engineUnreachable = ref(false);
const canFallBackToWhisper = computed(
  () => engineUnreachable.value && settings.engine === 'webspeech' && available.value.whisper
);

function useWhisperInstead() {
  engineUnreachable.value = false;
  settings.engine = 'whisper';
  say('Switched to local Whisper — the model is fetched once, then nothing leaves this machine.');
}

// ---- which microphone, which speaker ----

// Devices are listed rather than assumed, refreshed when one is plugged in,
// and named only once the microphone has been granted — before that the
// browser hands back a list of blanks, which is what `deviceNames` is for.
const inputs = ref([]);
const outputs = ref([]);
const deviceNames = ref(false);
const canRouteOutput = ref(outputRoutingSupported());
let unwatchDevices = () => {};

async function refreshDevices() {
  const found = await listAudioDevices();
  inputs.value = found.inputs;
  outputs.value = found.outputs;
  deviceNames.value = found.named;
  // A device that has been unplugged since it was chosen would otherwise sit
  // in the picker as a blank line that cannot be selected again.
  if (settings.inputDeviceId && !found.inputs.some((d) => d.deviceId === settings.inputDeviceId))
    settings.inputDeviceId = '';
  if (settings.outputDeviceId && !found.outputs.some((d) => d.deviceId === settings.outputDeviceId))
    settings.outputDeviceId = '';
}

async function askForDeviceNames() {
  if (!(await nameDevices())) return say('The microphone was refused, so its name cannot be read', 'error');
  return refreshDevices();
}

// ---- what is going on right now ----

const status = ref('off'); // off | idle | listening | thinking | working
const partial = ref('');
const heard = ref('');
const message = ref('');
const messageKind = ref('muted'); // muted | ok | error
const options = ref([]);
const pending = ref(null); // the parsed command waiting to be confirmed
const lastCable = ref(null);
const level = ref(0);
// The activation layer is a plain object, so what it knows about being armed
// has to be mirrored into a ref for the template to follow it.
const armed = ref(false);
// The key-phrase listener runs beside the command recogniser and has a state
// of its own — it is downloading a model, or it is listening to the room.
const phraseState = ref('idle');
const phraseIntent = ref('');

let input = null;
let activation = null;
let sounds = null;

const say = (text, kind = 'muted') => {
  message.value = text;
  messageKind.value = kind;
};

// ---- doing what was said ----

const listOf = (value) => (typeof value === 'function' ? value() : value);

const context = computed(() => ({
  from: listOf(props.fromCandidates),
  to: listOf(props.toCandidates),
  cables: listOf(props.cableCandidates),
}));

async function plug(command) {
  status.value = 'working';
  try {
    const cable = await api.post(`/api/patches/${props.patchId}/cables`, {
      from_patch_module_id: command.from.patch_module_id,
      from_component_id: command.from.component_id,
      to_patch_module_id: command.to.patch_module_id,
      to_component_id: command.to.component_id,
      stacked: command.stacked || undefined,
      optional: command.optional || undefined,
    });
    lastCable.value = cable?.id ?? null;
    sounds?.success();
    say(`${describeEndpoint(command.from)} → ${describeEndpoint(command.to)}`, 'ok');
    emit('changed');
  } catch (e) {
    // The server knows things the parser cannot — that this input is already
    // fed, that these two jacks are the same mult. Its refusal is the message.
    sounds?.failure(e.message);
    say(e.message, 'error');
  } finally {
    status.value = armed.value ? 'listening' : 'idle';
  }
}

async function unplug(cable) {
  status.value = 'working';
  try {
    await api.delete(`/api/patches/${props.patchId}/cables/${cable.cable_id}`);
    if (lastCable.value === cable.cable_id) lastCable.value = null;
    sounds?.undo();
    say(`Unplugged ${cable.module_label} → ${cable.jack_name}`, 'ok');
    emit('changed');
  } catch (e) {
    sounds?.failure(e.message);
    say(e.message, 'error');
  } finally {
    status.value = armed.value ? 'listening' : 'idle';
  }
}

async function undoLast() {
  if (!lastCable.value) {
    sounds?.failure('Nothing to undo');
    return say('Nothing to undo', 'error');
  }
  await unplug({ cable_id: lastCable.value, module_label: 'the last cable', jack_name: '' });
}

const clearPending = () => {
  pending.value = null;
  options.value = [];
};

function chooseOption(option) {
  const command = pending.value;
  clearPending();
  if (!command) return;
  // Whichever end was in doubt is the one this fills in.
  if (!command.from) command.from = option;
  else command.to = option;
  if (command.from && command.to) return plug(command);
  say('Still need the other end', 'error');
}

async function handle(transcript, alternatives) {
  heard.value = transcript;
  partial.value = '';

  // Only an utterance that is nothing but an answer counts as one. Saying the
  // whole cable again is a new command, not a pick — see pickedOption.
  if (options.value.length) {
    const index = pickedOption(transcript);
    if (index && options.value[index - 1]) return chooseOption(options.value[index - 1]);
  }

  const command = parseBestAlternative(alternatives?.length ? alternatives : [transcript], context.value);

  if (command.intent === 'cancel') {
    clearPending();
    sounds?.undo();
    return say('Cancelled');
  }
  if (command.intent === 'undo') {
    clearPending();
    return undoLast();
  }
  if (command.intent === 'disconnect') {
    if (command.cable) return unplug(command.cable);
    options.value = command.options;
    pending.value = null;
    sounds?.ambiguous();
    return say(command.error, 'error');
  }
  if (command.intent !== 'connect') {
    sounds?.failure('Did not catch that');
    return say('Did not catch that — say "connect <source> to <destination>"', 'error');
  }
  if (command.error) {
    options.value = command.options || [];
    pending.value = options.value.length ? command : null;
    if (options.value.length) sounds?.ambiguous();
    else sounds?.failure(command.error);
    return say(command.error, 'error');
  }
  // Heard clearly enough to act on, or heard well enough to ask about.
  if (command.confidence < settings.confirmBelow) {
    pending.value = command;
    options.value = [];
    sounds?.ambiguous();
    return say(
      `Did you mean ${describeEndpoint(command.from)} → ${describeEndpoint(command.to)}?`,
      'muted'
    );
  }
  clearPending();
  return plug(command);
}

function confirmPending() {
  const command = pending.value;
  clearPending();
  if (command?.from && command?.to) plug(command);
}

// ---- wiring the microphone up ----

function teardown() {
  activation?.detach();
  input?.close();
  activation = null;
  input = null;
  status.value = 'off';
  level.value = 0;
  armed.value = false;
  phraseState.value = 'idle';
  phraseIntent.value = '';
}

// The phrases the key-phrase listener is waiting for, and what each of them
// means. Several of either can be given, comma separated — a room hears
// "create" as "great" often enough that a second spelling is worth having.
const phraseList = (text, intent) =>
  String(text || '')
    .split(',')
    .map((phrase) => phrase.trim())
    .filter(Boolean)
    .map((phrase) => ({ phrase, intent }));
const keyPhrases = computed(() => [
  ...phraseList(settings.connectPhrase, 'connect'),
  ...phraseList(settings.disconnectPhrase, 'disconnect'),
]);
const firstPhrase = computed(() => keyPhrases.value[0]?.phrase || '');

function build() {
  teardown();
  if (!settings.enabled) return;
  const continuous = isContinuous(settings.mode);

  input = createSpeechInput({
    engine: settings.engine,
    model: settings.model,
    deviceId: settings.inputDeviceId,
    continuous,
    vocabulary: listOf(props.vocabulary),
    onPartial: (text) => {
      partial.value = text;
    },
    onResult: ({ transcript, alternatives }) => {
      // What counts as a command is the activation layer's to say: in wake-word
      // mode the sentence only starts at the wake word, and in key-phrase mode
      // the phrase already said whether this is a cable going in or coming out.
      // Every reading survives that, because the parser is the better judge of
      // which of them names a real cable.
      const command = activation?.commandFrom(transcript, alternatives);
      if (!command) return;
      handle(command.transcript, command.alternatives);
    },
    onError: (text, code) => {
      // An engine that cannot reach its service will fail this way every time,
      // not once, so it is worth saying over the page as well as beside the
      // picker. Repeats count up on the toast already there.
      if (ENGINE_UNUSABLE.includes(code)) {
        engineUnreachable.value = true;
        toast.error(text);
      }
      sounds?.failure(text);
      say(text, 'error');
    },
    onState: (next) => {
      if (status.value === 'working') return;
      status.value = next;
      if (next === 'listening') sounds?.listening();
    },
    onLevel: (value) => {
      level.value = value;
    },
  });

  activation = createVoiceActivation({
    mode: settings.mode,
    input,
    key: settings.key,
    binding: settings.binding,
    wakeWords: settings.wakeWords.split(',').map((w) => w.trim()).filter(Boolean),
    keyPhrases: keyPhrases.value,
    // The room is listened to all evening in this mode, so what listens is
    // Whisper — on this machine, whatever the command recogniser is set to.
    createPhraseInput: (options) =>
      createSpeechInput({
        engine: 'whisper',
        model: settings.model,
        deviceId: settings.inputDeviceId,
        onState: (next) => {
          phraseState.value = next;
        },
        onPartial: () => {},
        onLevel: (value) => {
          level.value = value;
        },
        ...options,
      }),
    onPhrase: (intent, rest) => {
      phraseIntent.value = intent;
      partial.value = '';
      clearPending();
      sounds?.listening();
      say(
        rest
          ? `Heard the phrase — reading “${rest}”`
          : `Heard the phrase — say the ${intent === 'disconnect' ? 'cable to pull out' : 'cable'}`
      );
    },
    // Said in one breath, so the browser's recogniser never heard the cable
    // and what Whisper already transcribed is the whole command.
    onCommand: (text, readings) => handle(text, readings),
    onArm: () => {
      armed.value = true;
    },
    onDisarm: () => {
      armed.value = false;
      phraseIntent.value = '';
    },
    onBinding: (binding) => {
      settings.binding = binding;
      saveSettings();
      say(`Bound to ${binding.type.toUpperCase()} ${binding.number} on channel ${binding.channel}`);
    },
    onError: (text) => say(text, 'error'),
  });
  // Set before attaching, because an always-listening mode arms itself on the
  // way in and its 'listening' must not be written back over.
  status.value = 'idle';
  activation.attach();
}

onMounted(() => {
  sounds = createPatchSounds({
    volume: settings.volume,
    enabled: settings.sounds,
    speakErrors: settings.speakErrors,
    outputDeviceId: settings.outputDeviceId,
  });
  refreshDevices();
  // An interface switched on halfway through a session is a device that was
  // not in the list when the page loaded.
  unwatchDevices = watchAudioDevices(refreshDevices);
  if (settings.enabled) build();
});
onBeforeUnmount(() => {
  teardown();
  unwatchDevices();
  sounds?.close();
});

// Anything that changes the shape of the microphone rebuilds it; anything that
// only changes what it sounds like does not.
watch(
  () => [
    settings.enabled,
    settings.engine,
    settings.mode,
    settings.model,
    settings.wakeWords,
    settings.connectPhrase,
    settings.disconnectPhrase,
    settings.inputDeviceId,
    settings.key,
  ],
  () => {
    saveSettings();
    build();
  }
);
watch(
  () => [
    settings.volume,
    settings.sounds,
    settings.speakErrors,
    settings.confirmBelow,
    settings.outputDeviceId,
  ],
  () => {
    saveSettings();
    sounds?.update({
      volume: settings.volume,
      enabled: settings.sounds,
      speakErrors: settings.speakErrors,
      outputDeviceId: settings.outputDeviceId,
    });
  }
);

// In key-phrase mode there are two recognisers and the honest answer is
// whichever of them the room is being heard by: until the phrase is said, what
// is going on is Whisper listening for it.
const statusText = computed(() => {
  const plain =
    {
      off: 'Off',
      idle: 'Ready',
      listening: 'Listening…',
      thinking: 'Working out what you said…',
      working: 'Plugging it in…',
    }[status.value] || status.value;
  if (settings.mode !== 'phrase' || status.value === 'off' || status.value === 'working')
    return plain;
  if (armed.value) return phraseIntent.value === 'disconnect' ? 'Which cable?' : 'Say the cable…';
  if (phraseState.value === 'thinking') return 'Listening for the phrase…';
  if (phraseState.value === 'listening') return `Waiting for “${firstPhrase.value}”`;
  return 'Starting Whisper…';
});
const holdLabel = computed(() =>
  ({
    ptt: `Hold to talk (or hold ${settings.key === 'Space' ? 'the space bar' : settings.key})`,
    toggle: armed.value ? 'Stop patch mode' : 'Start patch mode',
    wake: 'Listening for the wake word',
    phrase: armed.value ? 'Say the cable' : `Or hold this instead of saying “${firstPhrase.value}”`,
    midi: 'Waiting for the footswitch',
  })[settings.mode]
);
// The button only lets go of what it took hold of: in wake mode, and while the
// space bar is doing the holding, a mouse crossing the button must not close
// the microphone.
const pointerHeld = ref(false);
function pointerDown() {
  if (settings.mode === 'toggle') return activation?.toggle();
  pointerHeld.value = true;
  activation?.press();
}
function pointerUp() {
  if (!pointerHeld.value) return;
  pointerHeld.value = false;
  activation?.release();
}

const bindingText = computed(() =>
  settings.binding
    ? `${settings.binding.type.toUpperCase()} ${settings.binding.number} · channel ${settings.binding.channel}`
    : 'nothing bound yet'
);
</script>

<template>
  <details open class="panel" data-test="voice">
    <summary>
      <h2>Patch by voice</h2>
      <span class="summary-count">{{ statusText }}</span>
    </summary>
    <div class="panel-body">
      <p class="muted" style="margin-top: 0">
        Say the cable the way you would say it to someone stood next to the case — "connect make
        noise maths out one to 2hp div clock in". Both ends are matched against the jacks in this
        patch, and a tone tells you whether it went in, so you never have to look over here.
        Enable Voice patching below, allow microphone access when your browser asks, then choose how
        you want to activate it.
      </p>

      <div class="row">
        <div class="shrink">
          <label for="voice-enabled">Voice patching</label>
          <input id="voice-enabled" v-model="settings.enabled" type="checkbox" data-test="voice-enabled" />
        </div>
        <div>
          <label for="voice-engine">Recognition</label>
          <select id="voice-engine" v-model="settings.engine" data-test="voice-engine">
            <option v-for="option in engineOptions" :key="option.value" :value="option.value">
              {{ option.label }}{{ option.available ? '' : ' — not available here' }}
            </option>
          </select>
        </div>
        <div v-if="settings.engine === 'whisper' || settings.mode === 'phrase'">
          <label for="voice-model">Whisper model</label>
          <select id="voice-model" v-model="settings.model" data-test="voice-model">
            <option v-for="option in WHISPER_MODELS" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </div>
        <div>
          <label for="voice-mode">Activation</label>
          <select id="voice-mode" v-model="settings.mode" data-test="voice-mode">
            <option v-for="option in ACTIVATION_MODES" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </div>
      </div>

      <div v-if="settings.mode === 'wake'" class="row">
        <div>
          <label for="voice-wake">Wake words (comma separated)</label>
          <input id="voice-wake" v-model="settings.wakeWords" data-test="voice-wake" />
        </div>
      </div>
      <template v-if="settings.mode === 'phrase'">
        <div class="row">
          <div>
            <label for="voice-connect-phrase">Phrase to plug a cable in (comma separated)</label>
            <input
              id="voice-connect-phrase"
              v-model="settings.connectPhrase"
              data-test="voice-connect-phrase"
            />
          </div>
          <div>
            <label for="voice-disconnect-phrase">Phrase to pull one out (comma separated)</label>
            <input
              id="voice-disconnect-phrase"
              v-model="settings.disconnectPhrase"
              data-test="voice-disconnect-phrase"
            />
          </div>
        </div>
        <p class="muted" data-test="voice-phrase-help">
          Whisper listens to the room on this machine and does nothing until it hears one of these
          phrases; the cable that follows is transcribed by
          {{ engineLabel(settings.engine) }}. Say it in one breath — "create connection between
          maths out one and 2hp div clock" — or say the phrase, wait for the blip, then say the
          cable. Nothing but the phrase leaves the room either way, and nothing at all leaves it
          while the recognition setting is Local Whisper.
        </p>
      </template>
      <div v-if="settings.mode === 'midi'" class="row">
        <div>
          <label>Footswitch — {{ bindingText }}</label>
          <button type="button" style="margin: 0" data-test="voice-learn" @click="activation?.learnBinding()">
            Learn: press the switch now
          </button>
        </div>
      </div>

      <div class="row">
        <div class="shrink">
          <button
            type="button"
            style="margin: 0"
            :disabled="!settings.enabled"
            data-test="voice-talk"
            @pointerdown="pointerDown"
            @pointerup="pointerUp"
            @pointerleave="pointerUp"
          >
            🎙 {{ holdLabel }}
          </button>
        </div>
        <div>
          <p class="muted" style="margin: 0.4rem 0 0" data-test="voice-status">{{ statusText }}</p>
        </div>
      </div>

      <p v-if="partial" class="muted" data-test="voice-partial">“{{ partial }}”</p>
      <p v-if="heard" class="muted" data-test="voice-heard">Heard: “{{ heard }}”</p>
      <p v-if="message" :class="messageKind" data-test="voice-message">{{ message }}</p>
      <p v-if="canFallBackToWhisper">
        <button
          type="button"
          style="margin: 0"
          data-test="voice-use-whisper"
          @click="useWhisperInstead"
        >
          Use local Whisper instead
        </button>
      </p>

      <div v-if="pending && !options.length" class="row" data-test="voice-confirm-row">
        <div class="shrink">
          <button type="button" style="margin: 0" data-test="voice-confirm" @click="confirmPending">
            Yes — plug it in
          </button>
        </div>
        <div class="shrink">
          <button type="button" style="margin: 0" data-test="voice-reject" @click="clearPending">
            No
          </button>
        </div>
      </div>

      <div v-if="options.length" data-test="voice-options">
        <p class="muted" style="margin-bottom: 0.3rem">
          Say the number, or pick one:
        </p>
        <button
          v-for="(option, index) in options"
          :key="option.component_id ?? option.cable_id"
          type="button"
          style="margin: 0 0.4rem 0.4rem 0"
          :data-test="`voice-option-${index + 1}`"
          @click="option.cable_id ? unplug(option) : chooseOption(option)"
        >
          {{ index + 1 }}. {{ option.module_label }} — {{ option.jack_name }}
        </button>
      </div>

      <details class="subpanel">
        <summary>Microphone and speaker</summary>
        <div class="row">
          <div>
            <label for="voice-input-device">Microphone</label>
            <select
              id="voice-input-device"
              v-model="settings.inputDeviceId"
              data-test="voice-input-device"
            >
              <option value="">System default</option>
              <option v-for="device in inputs" :key="device.deviceId" :value="device.deviceId">
                {{ device.label }}
              </option>
            </select>
          </div>
          <div>
            <label for="voice-output-device">Cues play through</label>
            <select
              id="voice-output-device"
              v-model="settings.outputDeviceId"
              data-test="voice-output-device"
              :disabled="!canRouteOutput"
            >
              <option value="">System default</option>
              <option v-for="device in outputs" :key="device.deviceId" :value="device.deviceId">
                {{ device.label }}
              </option>
            </select>
          </div>
          <div class="shrink">
            <label>&nbsp;</label>
            <button
              type="button"
              style="margin: 0"
              data-test="voice-devices-refresh"
              @click="deviceNames ? refreshDevices() : askForDeviceNames()"
            >
              {{ deviceNames ? 'Refresh list' : 'Show device names' }}
            </button>
          </div>
        </div>
        <p class="muted" data-test="voice-device-help">
          Kept in this browser under your account and never sent to the server — a device id means
          nothing on another machine. The microphone reaches Local Whisper only: the browser's own
          recogniser opens the system default itself and offers no way to point it elsewhere, which
          is another reason the key phrase is listened for by Whisper.
          <span v-if="!canRouteOutput">
            This browser cannot choose an output either, so the cues play wherever the system sends
            them.
          </span>
          Errors read out loud always follow the system output.
        </p>
      </details>

      <details class="subpanel">
        <summary>Sound and confidence</summary>
        <div class="row">
          <div class="shrink">
            <label for="voice-sounds">Tones</label>
            <input id="voice-sounds" v-model="settings.sounds" type="checkbox" data-test="voice-sounds" />
          </div>
          <div>
            <label for="voice-volume">Volume</label>
            <input
              id="voice-volume"
              v-model.number="settings.volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              data-test="voice-volume"
              @change="sounds?.preview('success')"
            />
          </div>
          <div>
            <label for="voice-confirm">Ask before plugging below {{ Math.round(settings.confirmBelow * 100) }}% sure</label>
            <input
              id="voice-confirm"
              v-model.number="settings.confirmBelow"
              type="range"
              min="0.5"
              max="0.95"
              step="0.05"
              data-test="voice-confirm-threshold"
            />
          </div>
          <div class="shrink">
            <label for="voice-speak">Read errors out loud</label>
            <input id="voice-speak" v-model="settings.speakErrors" type="checkbox" data-test="voice-speak" />
          </div>
        </div>
        <p class="muted">
          Rising fifth: the cable is in. Three level pips: heard you, needs one more word. Low buzz:
          nothing was plugged. Falling fifth: a cable came back out.
        </p>
      </details>
    </div>
  </details>
</template>
