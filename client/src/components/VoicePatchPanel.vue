<script setup>
// Patching by voice. "Connect Make Noise Maths out one to 2hp Div clock in",
// and the cable is documented before your hand is back on the case.
//
// This is the LISTENER, mounted once over the whole app (App.vue). What it is
// set to is an account setting rather than a page (`voiceSettings.js`, edited
// at /account/voice), and what it acts on is whatever patch diagram is on
// screen (`voicePatchTarget.js`). So it is switched on once and works on
// every patch, instead of being switched on again on each one.
//
// It is a lid over five small modules that each do one thing: speechInput
// turns a microphone into words, voiceActivation decides when the microphone
// is open, voiceCommand turns words into two jack ids, audioDevices says
// which microphone and which speaker, and patchSounds says whether it worked
// — because you are looking at the rack, not at this screen, and the beep is
// the whole answer.
//
// Nothing is plugged on a maybe. Below the confidence set in the settings, the
// bar says what it thinks it heard and waits, and the tone it plays for that
// is not the tone it plays for a cable going in.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { toast } from '../toast.js';
import {
  voiceSettings as settings,
  saveVoiceSettings,
  useWorkingEngine,
} from '../voiceSettings.js';
import {
  voiceTarget,
  voicePatchChanged,
  voicePatchContext,
  voicePatchVocabulary,
} from '../voicePatchTarget.js';
import { createSpeechInput, engineAvailability, ENGINES, ENGINE_UNUSABLE } from '../speechInput.js';
import { createVoiceActivation, isContinuous } from '../voiceActivation.js';
import { createPatchSounds } from '../patchSounds.js';
import { parseBestAlternative, pickedOption, describeEndpoint } from '../voiceCommand.js';

// Voice patching plugs cables into a patch, so the one thing it cannot do is
// run where there is no patch. Said as a toast rather than in the bar,
// because when this is the answer there is no bar on screen to read it in.
const OFF_PATCH =
  'Voice patching only works on the patch diagram view — open a patch to talk to it.';

// A saved engine this browser cannot run is moved to one it can before
// anything is built with it.
useWorkingEngine(engineAvailability(), ENGINES.map((e) => e.value));

// Whether the listener has a patch to talk about at all.
const live = computed(() => settings.enabled && Boolean(voiceTarget.patchId));

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
// The browser's recogniser is present but its service is out of reach — the
// usual answer on a self-hosted box, where Chromium ships without a key for
// Google's speech servers. Whisper is the way out and it is one click away,
// but it fetches a model the first time, so it is offered rather than taken.
const engineUnreachable = ref(false);
const canFallBackToWhisper = computed(
  () => engineUnreachable.value && settings.engine === 'webspeech'
);

let input = null;
let activation = null;
let sounds = null;

const say = (text, kind = 'muted') => {
  message.value = text;
  messageKind.value = kind;
};

function useWhisperInstead() {
  engineUnreachable.value = false;
  settings.engine = 'whisper';
  saveVoiceSettings();
  say('Switched to local Whisper — the model is fetched once, then nothing leaves this machine.');
}

// ---- doing what was said ----

const cablesPath = () => `/api/patches/${voiceTarget.patchId}/cables`;

async function plug(command) {
  status.value = 'working';
  try {
    const cable = await api.post(cablesPath(), {
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
    voicePatchChanged();
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
    await api.delete(`${cablesPath()}/${cable.cable_id}`);
    if (lastCable.value === cable.cable_id) lastCable.value = null;
    sounds?.undo();
    say(`Unplugged ${cable.module_label} → ${cable.jack_name}`, 'ok');
    voicePatchChanged();
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

  const command = parseBestAlternative(
    alternatives?.length ? alternatives : [transcript],
    voicePatchContext()
  );

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
  clearPending();
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
  // No patch on screen is not an error here — it is simply nothing to listen
  // for. The error is raised where somebody ASKS for it (`askedOffPatch`).
  if (!live.value) return;
  const continuous = isContinuous(settings.mode);
  input = createSpeechInput({
    engine: settings.engine,
    model: settings.model,
    deviceId: settings.inputDeviceId,
    continuous,
    vocabulary: voicePatchVocabulary(),
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
      // not once, so it is worth saying over the page as well as in the bar.
      // Repeats count up on the toast already there.
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
      saveVoiceSettings();
      say(`Bound to ${binding.type.toUpperCase()} ${binding.number} on channel ${binding.channel}`);
    },
    onError: (text) => say(text, 'error'),
  });
  // Set before attaching, because an always-listening mode arms itself on the
  // way in and its 'listening' must not be written back over.
  status.value = 'idle';
  activation.attach();
}

// ---- asked for where it cannot work ----
// Voice patching switched on and no patch on screen looks exactly like voice
// patching that is broken. So the moment somebody asks for it — the moment
// they switch it on, and every time they reach for the key they hold to talk
// — it says where it does work.
function askedOffPatch() {
  toast.error(OFF_PATCH, { title: 'No patch on screen' });
  return false;
}

// The key held to talk, listened for only while there is no patch to talk to:
// with one on screen this is the activation layer's own key and it must not be
// heard twice.
function onOffPatchKey(event) {
  if (event.repeat || event.code !== settings.key) return;
  const el = event.target;
  // Not while something is being typed into.
  if (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))
    return;
  event.preventDefault();
  askedOffPatch();
}

let keyListening = false;
function watchForOffPatchKey(wanted) {
  if (wanted === keyListening || typeof window === 'undefined') return;
  keyListening = wanted;
  if (wanted) window.addEventListener('keydown', onOffPatchKey);
  else window.removeEventListener('keydown', onOffPatchKey);
}

onMounted(() => {
  sounds = createPatchSounds({
    volume: settings.volume,
    enabled: settings.sounds,
    speakErrors: settings.speakErrors,
    outputDeviceId: settings.outputDeviceId,
  });
  if (live.value) build();
  watchForOffPatchKey(settings.enabled && !voiceTarget.patchId);
});
onBeforeUnmount(() => {
  teardown();
  watchForOffPatchKey(false);
  sounds?.close();
});

// Anything that changes the shape of the microphone rebuilds it — including
// the patch going away under it, which is what leaving the diagram is.
watch(
  () => [
    live.value,
    settings.enabled,
    voiceTarget.patchId,
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
    build();
    watchForOffPatchKey(settings.enabled && !voiceTarget.patchId);
  }
);
// Switched on where it cannot run: say so once, there and then, rather than
// leaving somebody holding a key that does nothing.
watch(
  () => settings.enabled,
  (enabled) => {
    if (enabled && !voiceTarget.patchId) askedOffPatch();
  }
);
// Anything that only changes what it sounds like does not rebuild anything.
watch(
  () => [
    settings.volume,
    settings.sounds,
    settings.speakErrors,
    settings.outputDeviceId,
  ],
  () => {
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
</script>

<template>
  <div v-if="live" class="voice-bar" data-test="voice">
    <button
      type="button"
      class="voice-talk"
      data-test="voice-talk"
      @pointerdown="pointerDown"
      @pointerup="pointerUp"
      @pointerleave="pointerUp"
    >
      🎙 {{ holdLabel }}
    </button>
    <div class="voice-said">
      <p class="muted voice-line" data-test="voice-status">{{ statusText }}</p>
      <p v-if="partial" class="muted voice-line" data-test="voice-partial">“{{ partial }}”</p>
      <p v-else-if="heard" class="muted voice-line" data-test="voice-heard">Heard: “{{ heard }}”</p>
      <p v-if="message" class="voice-line" :class="messageKind" data-test="voice-message">
        {{ message }}
      </p>
    </div>

    <div v-if="pending && !options.length" class="voice-actions" data-test="voice-confirm-row">
      <button type="button" data-test="voice-confirm" @click="confirmPending">Yes — plug it in</button>
      <button type="button" class="secondary" data-test="voice-reject" @click="clearPending">
        No
      </button>
    </div>

    <div v-if="options.length" class="voice-actions" data-test="voice-options">
      <button
        v-for="(option, index) in options"
        :key="option.component_id ?? option.cable_id"
        type="button"
        class="secondary"
        :data-test="`voice-option-${index + 1}`"
        @click="option.cable_id ? unplug(option) : chooseOption(option)"
      >
        {{ index + 1 }}. {{ option.module_label }} — {{ option.jack_name }}
      </button>
    </div>

    <button
      v-if="canFallBackToWhisper"
      type="button"
      class="secondary"
      data-test="voice-use-whisper"
      @click="useWhisperInstead"
    >
      Use local Whisper instead
    </button>

    <RouterLink class="voice-settings-link" to="/account/voice" data-test="voice-settings-link">
      Voice settings
    </RouterLink>
  </div>
</template>
