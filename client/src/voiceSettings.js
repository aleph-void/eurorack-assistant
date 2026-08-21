// What voice patching is set to, for this account, in this browser.
//
// It used to be a fold of one patch's pages: switched on there, listening
// only while that page was open, and switched on again on the next patch.
// But patching by voice is a way of WORKING, not a property of a patch — the
// microphone, the footswitch and the wake word are the same ones whatever is
// on the screen. So it is set once, under the account, and applies to
// whatever patch is displayed (`voicePatchTarget.js`).
//
// None of it goes to the server. A deviceId means nothing on another machine,
// and a shared studio desktop is two people with two headsets — so every
// setting is kept in this browser, under this account's own key. The old
// shared key is read as the starting point so that nobody's settings vanish
// on the way in, and it is never written to again.

import { reactive } from 'vue';

const STORAGE_KEY = 'eurorack-assistant.voice';

export const VOICE_DEFAULTS = Object.freeze({
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
});

// One object for the whole app: the settings page writes it and the listener
// over the patch diagram reads it, and neither has to tell the other.
export const voiceSettings = reactive({ ...VOICE_DEFAULTS });

// Whose settings are loaded. Loading is idempotent per account, so every
// consumer can ask on the way in without reading the same keys four times.
let loadedFor;

const storageKey = (userId) => (userId ? `${STORAGE_KEY}.${userId}` : STORAGE_KEY);

const read = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch {
    return {};
  }
};

export function loadVoiceSettings(userId, { force = false } = {}) {
  const id = userId ?? null;
  if (!force && loadedFor === id) return voiceSettings;
  loadedFor = id;
  Object.assign(voiceSettings, VOICE_DEFAULTS, read(STORAGE_KEY), read(storageKey(id)));
  return voiceSettings;
}

// A setting restored from a browser that cannot run it is quietly moved to
// one that can: nothing has been asked for yet, so there is nothing to
// report. Asked for by the two components that load the speech engines
// rather than done here, so that this module — which App.vue reads on every
// page, to know whether to fetch the listener at all — pulls in nothing.
export function useWorkingEngine(available, engines) {
  if (available[voiceSettings.engine]) return;
  voiceSettings.engine = engines.find((value) => available[value]) || voiceSettings.engine;
}

export function saveVoiceSettings() {
  try {
    localStorage.setItem(storageKey(loadedFor), JSON.stringify({ ...voiceSettings }));
  } catch {
    /* nothing here is worth failing over */
  }
}

// Signing out and back in as somebody else must not leave the first person's
// microphone selected — and must not carry their 'on' into the second
// person's session either.
export function resetVoiceSettings() {
  loadedFor = undefined;
  Object.assign(voiceSettings, VOICE_DEFAULTS);
}
