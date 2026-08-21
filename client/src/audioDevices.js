// Which microphone, and which speaker.
//
// A studio has more than one of each: an interface with eight inputs, a USB
// headset, the laptop's own microphone pointing at the fan. The browser picks
// the system default and never asks, which is the wrong answer in a room where
// the default input is the one recording the rack. So the choice is the rack
// owner's, and it is kept in this browser rather than on the server — a
// deviceId means nothing on another machine, and a person patching from the
// studio desktop and from a laptop wants a different microphone on each.
//
// Two things here are worth knowing before the settings are believed:
//
//   * The browser's own recogniser CANNOT be pointed at a device. Web Speech
//     opens the system default microphone itself and offers no way in. The
//     input choice therefore reaches Whisper only, which is also why Whisper
//     is what listens for the key phrase.
//   * Choosing an output needs `setSinkId` on the AudioContext (Chrome 110
//     and up). Where it is missing, the cues play wherever the system sends
//     them, and speech synthesis ignores it everywhere.

export const SYSTEM_DEFAULT = '';

const emptyList = () => ({ inputs: [], outputs: [], named: false });

const defaultMediaDevices = () =>
  typeof navigator !== 'undefined' ? navigator.mediaDevices : null;

// Every audio device this browser will admit to. Labels are blank until the
// microphone has been granted once — `named` is how the caller knows to offer
// the "let me see their names" button rather than a list of "Input 2".
export async function listAudioDevices({ mediaDevices = defaultMediaDevices() } = {}) {
  if (!mediaDevices?.enumerateDevices) return emptyList();
  let devices;
  try {
    devices = await mediaDevices.enumerateDevices();
  } catch {
    return emptyList();
  }
  if (!Array.isArray(devices)) return emptyList();
  const of = (kind, fallback) =>
    devices
      .filter((device) => device?.kind === kind)
      .map((device, index) => ({
        deviceId: device.deviceId ?? '',
        label: device.label || `${fallback} ${index + 1}`,
      }));
  return {
    inputs: of('audioinput', 'Microphone'),
    outputs: of('audiooutput', 'Output'),
    named: devices.some((device) => device?.kind?.startsWith('audio') && device.label),
  };
}

// Asking for the microphone once, purely so that enumerateDevices starts
// naming things. The stream is closed again immediately — this is a question
// about the hardware, not a recording.
export async function nameDevices({ mediaDevices = defaultMediaDevices() } = {}) {
  if (!mediaDevices?.getUserMedia) return false;
  try {
    const stream = await mediaDevices.getUserMedia({ audio: true });
    stream.getTracks?.().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

// A device that has been unplugged since it was chosen would make getUserMedia
// refuse outright with `exact`, and a refused microphone reads as "permission
// denied" to everybody looking at it. So the chosen device is asked for
// exactly — anything else silently records the wrong room — and the caller
// retries without it, which is what `microphoneConstraints()` returns for the
// system default.
export function microphoneConstraints(deviceId) {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
}

export const outputRoutingSupported = ({
  AudioContextImpl = typeof window !== 'undefined'
    ? window.AudioContext || window.webkitAudioContext
    : null,
} = {}) => typeof AudioContextImpl?.prototype?.setSinkId === 'function';

// Sends an AudioContext's cues to the chosen speaker. Never throws: an output
// that has gone away is a reason to hear the beep somewhere else, not a reason
// for the beep to fail.
export async function routeOutput(context, deviceId) {
  if (!deviceId || typeof context?.setSinkId !== 'function') return false;
  try {
    await context.setSinkId(deviceId);
    return true;
  } catch {
    return false;
  }
}

// A device list goes stale the moment an interface is switched on. Returns the
// way to stop watching.
export function watchAudioDevices(handler, { mediaDevices = defaultMediaDevices() } = {}) {
  if (!mediaDevices?.addEventListener) return () => {};
  mediaDevices.addEventListener('devicechange', handler);
  return () => mediaDevices.removeEventListener?.('devicechange', handler);
}
