<script setup>
// How voice patching is set up, for this account, in this browser.
//
// It used to be a fold of one patch's pages, which made it a property of that
// patch: switched on there, and switched on again on the next one. The
// microphone, the footswitch and the wake word are the same ones whatever is
// on the screen, so they are set here, once — and the listener itself runs
// over whatever patch diagram is open (`VoicePatchPanel.vue`, mounted in
// App.vue).
//
// Every setting here is kept in this browser and under this account's own
// key. A deviceId means nothing on another machine, and a shared studio
// desktop is two people with two headsets — so none of it goes to the server.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { toast } from '../toast.js';
import {
  voiceSettings as settings,
  saveVoiceSettings,
  useWorkingEngine,
} from '../voiceSettings.js';
import { voiceTarget } from '../voicePatchTarget.js';
import { engineAvailability, ENGINES } from '../speechInput.js';
import { WHISPER_MODELS } from '../whisperInput.js';
import { ACTIVATION_MODES, createVoiceActivation } from '../voiceActivation.js';
import {
  listAudioDevices,
  nameDevices,
  outputRoutingSupported,
  watchAudioDevices,
} from '../audioDevices.js';
import { createPatchSounds } from '../patchSounds.js';

const available = ref(engineAvailability());
// A saved engine this browser cannot run is moved quietly, before any of the
// watchers below exist: nothing has been asked for yet.
useWorkingEngine(available.value, ENGINES.map((e) => e.value));
const message = ref('');
const messageKind = ref('muted');
const say = (text, kind = 'muted') => {
  message.value = text;
  messageKind.value = kind;
};

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

// ---- which microphone, which speaker ----

// Devices are listed rather than assumed, refreshed when one is plugged in,
// and named only once the microphone has been granted — before that the
// browser hands back a list of blanks, which is what `deviceNames` is for.
const inputs = ref([]);
const outputs = ref([]);
const deviceNames = ref(false);
const canRouteOutput = ref(outputRoutingSupported());
let unwatchDevices = () => {};
let sounds = null;

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

// ---- the footswitch ----
// Learning a binding needs the MIDI layer but not the microphone, so this
// makes one on its own and lets it go the moment a switch is pressed. The
// listener that actually patches is somewhere else entirely, and may not even
// be running while this page is open.
const learning = ref(false);
let learner = null;

function stopLearning() {
  learner?.detach();
  learner = null;
  learning.value = false;
}

async function learnFootswitch() {
  stopLearning();
  learning.value = true;
  learner = createVoiceActivation({
    mode: 'midi',
    // Never armed from here: this is a binding being learned, not a cable
    // being said. The stub is what keeps arming harmless if one arrives.
    input: { start() {}, stop() {}, close() {} },
    binding: settings.binding,
    onBinding: (binding) => {
      settings.binding = binding;
      saveVoiceSettings();
      say(`Bound to ${binding.type.toUpperCase()} ${binding.number} on channel ${binding.channel}`, 'ok');
      stopLearning();
    },
    onError: (text) => {
      say(text, 'error');
      stopLearning();
    },
  });
  // Held locally as well as on `learner`: attaching a browser with no Web
  // MIDI (or one that refuses it) calls onError, which stops the learning and
  // puts `learner` back to null — and reading learnBinding off it then is a
  // TypeError thrown out of a click handler, on top of the message the user
  // has already been given. A second press while this one is still attaching
  // replaces `learner` too, and that one is not ours to drive either.
  const mine = learner;
  await mine.attach();
  if (learner === mine) await mine.learnBinding();
}

const bindingText = computed(() =>
  settings.binding
    ? `${settings.binding.type.toUpperCase()} ${settings.binding.number} · channel ${settings.binding.channel}`
    : 'nothing bound yet'
);

// ---- keeping it ----

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
});
onBeforeUnmount(() => {
  stopLearning();
  unwatchDevices();
  sounds?.close();
});

// Every setting is written the moment it changes: this page has no Save
// button because there is nothing here the browser cannot keep itself.
watch(
  () => ({ ...settings }),
  () => {
    saveVoiceSettings();
    sounds?.update({
      volume: settings.volume,
      enabled: settings.sounds,
      speakErrors: settings.speakErrors,
      outputDeviceId: settings.outputDeviceId,
    });
  }
);

const talkingTo = computed(() => voiceTarget.label || null);
</script>

<template>
  <h1>Patching by voice</h1>
  <p class="muted">
    Say the cable the way you would say it to someone stood next to the case — "connect make noise
    maths out one to 2hp div clock in". Both ends are matched against the jacks in the patch you are
    looking at, and a tone tells you whether it went in, so you never have to look at the screen.
  </p>
  <p class="muted">
    Switch it on here and it stays on: it listens over the
    <RouterLink to="/patches">patch diagram</RouterLink> of whatever patch you open, and does
    nothing anywhere else. Allow microphone access when your browser asks, then choose how you want
    to activate it.
  </p>

  <div class="panel">
    <div class="panel-body">
      <div class="row">
        <div class="shrink">
          <label for="voice-enabled">Voice patching</label>
          <input
            id="voice-enabled"
            v-model="settings.enabled"
            type="checkbox"
            data-test="voice-enabled"
          />
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

      <p v-if="settings.enabled" class="muted" data-test="voice-where">
        <template v-if="talkingTo">Listening over '{{ talkingTo }}'.</template>
        <template v-else>
          Nothing is being listened to right now — open a patch and it starts by itself.
        </template>
      </p>

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
          <button type="button" style="margin: 0" data-test="voice-learn" @click="learnFootswitch">
            {{ learning ? 'Press the switch now…' : 'Learn: press the switch now' }}
          </button>
        </div>
      </div>

      <p v-if="message" :class="messageKind" data-test="voice-message">{{ message }}</p>

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
  </div>
</template>
