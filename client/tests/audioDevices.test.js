import { describe, it, expect, vi } from 'vitest';
import {
  listAudioDevices,
  microphoneConstraints,
  nameDevices,
  outputRoutingSupported,
  routeOutput,
  watchAudioDevices,
} from '../src/audioDevices.js';

const device = (kind, deviceId, label = '') => ({ kind, deviceId, label });

describe('listing the audio devices', () => {
  it('splits them by direction and says whether they are named yet', async () => {
    const mediaDevices = {
      enumerateDevices: async () => [
        device('audioinput', 'mic-1', 'Scarlett 2i2'),
        device('audiooutput', 'out-1', 'Studio monitors'),
        device('videoinput', 'cam-1', 'Webcam'),
      ],
    };
    const found = await listAudioDevices({ mediaDevices });
    expect(found.inputs).toEqual([{ deviceId: 'mic-1', label: 'Scarlett 2i2' }]);
    expect(found.outputs).toEqual([{ deviceId: 'out-1', label: 'Studio monitors' }]);
    expect(found.named).toBe(true);
  });

  // Before the microphone has ever been granted, every label is blank — which
  // is a list of nothing rather than a list of devices, so it is numbered and
  // the caller is told to offer the "show me their names" button.
  it('numbers them while the browser is still withholding their names', async () => {
    const mediaDevices = {
      enumerateDevices: async () => [device('audioinput', 'a'), device('audioinput', 'b')],
    };
    const found = await listAudioDevices({ mediaDevices });
    expect(found.inputs.map((d) => d.label)).toEqual(['Microphone 1', 'Microphone 2']);
    expect(found.named).toBe(false);
  });

  it('is empty rather than broken where the browser has no device list at all', async () => {
    expect(await listAudioDevices({ mediaDevices: null })).toEqual({
      inputs: [],
      outputs: [],
      named: false,
    });
    const refuses = { enumerateDevices: async () => { throw new Error('no'); } };
    expect((await listAudioDevices({ mediaDevices: refuses })).inputs).toEqual([]);
  });
});

describe('asking for the names', () => {
  it('opens the microphone and closes it again — it is a question, not a recording', async () => {
    const track = { stop: vi.fn() };
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
    expect(await nameDevices({ mediaDevices: { getUserMedia } })).toBe(true);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('says no when the microphone is refused', async () => {
    const getUserMedia = async () => {
      throw new Error('denied');
    };
    expect(await nameDevices({ mediaDevices: { getUserMedia } })).toBe(false);
  });
});

describe('the constraints a microphone is asked for with', () => {
  it('asks for the chosen device exactly, so a wrong room is never recorded silently', () => {
    expect(microphoneConstraints('mic-1').deviceId).toEqual({ exact: 'mic-1' });
    expect(microphoneConstraints('')).not.toHaveProperty('deviceId');
    expect(microphoneConstraints('').echoCancellation).toBe(true);
  });
});

describe('sending the cues to a chosen speaker', () => {
  it('routes the context when the browser can', async () => {
    const setSinkId = vi.fn(async () => {});
    expect(await routeOutput({ setSinkId }, 'out-1')).toBe(true);
    expect(setSinkId).toHaveBeenCalledWith('out-1');
  });

  it('leaves the system default alone', async () => {
    const setSinkId = vi.fn();
    expect(await routeOutput({ setSinkId }, '')).toBe(false);
    expect(setSinkId).not.toHaveBeenCalled();
  });

  // A speaker that has been unplugged is a reason to hear the beep somewhere
  // else, never a reason for the beep to throw.
  it('shrugs off a browser that cannot, and a device that has gone', async () => {
    expect(await routeOutput({}, 'out-1')).toBe(false);
    expect(await routeOutput({ setSinkId: async () => { throw new Error('gone'); } }, 'out-1')).toBe(
      false
    );
    expect(outputRoutingSupported({ AudioContextImpl: null })).toBe(false);
    expect(outputRoutingSupported({ AudioContextImpl: class { setSinkId() {} } })).toBe(true);
  });
});

describe('watching for an interface being switched on', () => {
  it('subscribes and hands back the way to stop', () => {
    const handlers = new Map();
    const mediaDevices = {
      addEventListener: (type, fn) => handlers.set(type, fn),
      removeEventListener: (type) => handlers.delete(type),
    };
    const stop = watchAudioDevices(() => {}, { mediaDevices });
    expect(handlers.has('devicechange')).toBe(true);
    stop();
    expect(handlers.has('devicechange')).toBe(false);
    expect(() => watchAudioDevices(() => {}, { mediaDevices: null })()).not.toThrow();
  });
});
