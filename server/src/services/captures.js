// Waveform captures: the image a scope renders, the tuner reading taken with
// it, and the shapes both get turned into (a note the user can read, a text
// document the LLM can read).
//
// Images are content-addressed exactly like manuals — sha256 of the bytes,
// stored at CAPTURES_DIR/<hash>.png — so two identical captures cost one file
// and a capture can never half-exist under a name that says otherwise.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function capturePath(capturesDir, hash) {
  return path.join(capturesDir, `${hash}.png`);
}

export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_MAGIC);
}

// Writes the image if it is not already there and returns its hash. Written
// to a temporary name first so a crash mid-write cannot leave a truncated
// file sitting under the hash of the whole thing.
export function saveCaptureImage(capturesDir, buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const target = capturePath(capturesDir, hash);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(capturesDir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  }
  return hash;
}

// Deletes the file only once no capture row references the hash any more
// (the same rule manual deletion follows).
export async function deleteCaptureImageIfOrphaned(db, capturesDir, hash) {
  if (!hash) return;
  const remaining = await db.models.Capture.count({ where: { image_hash: hash } });
  if (remaining > 0) return;
  const file = capturePath(capturesDir, hash);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// The tuner reading for one channel, accepting either the flat form or a
// nested `tuning` object, and either spelling of the note/midi fields.
export function normalizeTuning(raw = {}) {
  const tuning = raw.tuning ?? raw;
  const note = tuning.note_name ?? tuning.note ?? tuning.display ?? null;
  return {
    note_name: note === null || note === undefined ? null : String(note).slice(0, 16),
    midi_note: Number.isFinite(Number(tuning.midi_note ?? tuning.midi))
      ? Math.round(Number(tuning.midi_note ?? tuning.midi))
      : null,
    cents: number(tuning.cents),
    frequency: number(tuning.frequency ?? tuning.hz),
    confidence: number(tuning.confidence),
    voltage: number(tuning.voltage ?? tuning.volts),
  };
}

// One `result` payload from a device, checked and flattened. Throws with a
// user-facing message when the device sent something unusable — the route
// turns that into a 502, since the fault is the device's.
export function parseCaptureResult(payload = {}) {
  const image = payload.image || {};
  const format = String(image.format || 'png').toLowerCase();
  if (format !== 'png') throw new Error(`unsupported image format '${format}' (expected png)`);
  const data = image.data ?? payload.image_base64;
  if (!data) throw new Error('the device returned no image data');

  const buffer = Buffer.from(String(data), 'base64');
  if (buffer.length === 0) throw new Error('the device returned an empty image');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`image is larger than the ${MAX_IMAGE_BYTES} byte limit`);
  }
  if (!isPng(buffer)) throw new Error('the image data is not a PNG');

  const channels = Array.isArray(payload.channels) ? payload.channels : [];
  return {
    buffer,
    width: Number.isFinite(Number(image.width)) ? Number(image.width) : null,
    height: Number.isFinite(Number(image.height)) ? Number(image.height) : null,
    captured_at: payload.captured_at ? new Date(payload.captured_at) : new Date(),
    sample_rate: number(payload.sample_rate),
    channels: channels.map((c, i) => ({
      channel_index: Number.isInteger(c?.index) ? c.index : i,
      label: c?.label ? String(c.label).slice(0, 200) : null,
      signal_type: c?.signal_type === 'cv' ? 'cv' : 'audio',
      vertical_range: number(c?.vertical_range),
      vertical_offset: number(c?.vertical_offset),
      time_base: number(c?.time_base),
      ...normalizeTuning(c),
    })),
  };
}

// How a tuner reading reads to a person: "A4 +7¢ (441.8 Hz)", or the voltage
// for a CV channel, or nothing at all when the detector did not lock on.
export function tuningLabel(channel = {}) {
  const parts = [];
  if (channel.note_name) {
    const cents = channel.cents === null || channel.cents === undefined ? null : Math.round(channel.cents);
    parts.push(cents === null ? channel.note_name : `${channel.note_name} ${cents >= 0 ? '+' : ''}${cents}¢`);
  }
  if (channel.frequency) parts.push(`${channel.frequency.toFixed(2)} Hz`);
  if (channel.signal_type === 'cv' && channel.voltage !== null && channel.voltage !== undefined) {
    parts.push(`${channel.voltage.toFixed(3)} V`);
  }
  if (channel.confidence !== null && channel.confidence !== undefined && channel.signal_type !== 'cv') {
    parts.push(`confidence ${(channel.confidence * 100).toFixed(0)}%`);
  }
  return parts.length === 0 ? 'no pitch detected' : parts.join(', ');
}

// Where a capture was taken, as one phrase: the patch it was taken on, or —
// for a bench capture — the module it is of.
const takenOn = ({ patchName, moduleName }) => {
  if (patchName) return ` on patch **${patchName}**`;
  if (moduleName) return ` of **${moduleName}**`;
  return '';
};

// The markdown body of the note a capture is filed under. This is what the
// user reads in the patch, and (via question_notes / question_captures) part
// of what the LLM is given.
export function captureNoteBody(
  capture,
  channels,
  { patchName = null, moduleName = null } = {}
) {
  const lines = [];
  lines.push(
    `Waveform captured${takenOn({ patchName, moduleName })} at ${new Date(
      capture.captured_at
    ).toISOString()}${capture.device_name ? ` from ${capture.device_name}` : ''}.`
  );
  if (capture.audio_device_name) lines.push(`Audio input: ${capture.audio_device_name}.`);
  lines.push('');
  lines.push('| Channel | Signal | Reading |');
  lines.push('| --- | --- | --- |');
  for (const c of channels) {
    const what = c.label || c.component_name || `Channel ${c.channel_index + 1}`;
    const source = c.source_description ? ` (${c.source_description})` : '';
    lines.push(
      `| ${c.channel_index + 1} | ${what}${source} | ${tuningLabel(c)} |`
    );
  }
  return lines.join('\n');
}

// The same information as a plain-text document for the LLM, which gets the
// PNG as well but should never have to depend on reading it: everything the
// image shows in numbers is written out here.
export function captureTextDocument(
  capture,
  channels,
  { patchName = null, moduleName = null } = {}
) {
  const lines = [];
  lines.push(`Oscilloscope capture #${capture.id}${capture.title ? ` — ${capture.title}` : ''}`);
  if (patchName) lines.push(`Patch: ${patchName}`);
  if (moduleName) lines.push(`Module: ${moduleName}`);
  lines.push(`Captured at: ${new Date(capture.captured_at).toISOString()}`);
  if (capture.audio_device_name) lines.push(`Audio interface: ${capture.audio_device_name}`);
  if (capture.sample_rate) lines.push(`Sample rate: ${capture.sample_rate} Hz`);
  if (capture.caption) lines.push(`User caption: ${capture.caption}`);
  lines.push('');
  lines.push('Channels (each is one pane of the attached waveform image, in order):');
  for (const c of channels) {
    const bits = [`  ${c.channel_index + 1}. ${c.label || c.component_name || 'unnamed channel'}`];
    if (c.source_description) bits.push(`— ${c.source_description}`);
    lines.push(bits.join(' '));
    lines.push(`     signal type: ${c.signal_type || 'unknown'}`);
    lines.push(`     tuner: ${tuningLabel(c)}`);
    const scale = [];
    if (c.vertical_range !== null && c.vertical_range !== undefined) {
      scale.push(`vertical range ${c.vertical_range}`);
    }
    if (c.time_base !== null && c.time_base !== undefined) scale.push(`time base ${c.time_base}s`);
    if (scale.length > 0) lines.push(`     display: ${scale.join(', ')}`);
  }
  return lines.join('\n');
}
