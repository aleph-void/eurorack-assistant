// Recordings: the bytes, what ffmpeg measured off them, and the picture that
// makes them answerable.
//
// A recording arrives three ways — an uploaded file, a take recorded in the
// browser, or one asked of the linked oscilloscope's audio interface — and
// all three land here as a buffer whose FORMAT IS DECIDED BY THE BYTES. A
// mislabelled container stored under the wrong extension would be served
// with the wrong type forever, so the claimed format is only ever checked
// against the sniffed one.
//
// The storage rule is the one captures, clips and manuals already follow:
// content-addressed at <capturesDir>/audio/<sha256>.<format>, written to a
// temporary name and renamed, deleted only once no row references the hash.
//
// The measurement is the interesting part. NO LLM BACKEND CAN LISTEN TO A
// WAV. The CLIs read text and look at images, so a recording attached to a
// question would otherwise be a filename and a shrug. Instead every
// recording is turned, once, into the two things a model can use: a PNG of
// its waveform above its spectrogram, and a handful of numbers (duration,
// sample rate, channel count, peak and RMS level in dBFS) — the same bargain
// an oscilloscope capture strikes, where the image is looked at and the
// readings are also written out in words so the answer never depends on the
// model being able to see.
//
// ffmpeg is installed in the server image, but this must not be the thing
// that makes an install without it refuse an upload: every measurement is
// best-effort, and a recording with no numbers and no picture is still
// stored, still played, and still attachable.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { childEnv } from './llm.js';

// An upload arrives as base64 in a JSON body (express is capped at 40mb), and
// a recording is a few minutes of a modular, not an album master.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// A device answers over the same WebSocket as everything else, whose frames
// are capped at 12 MB; base64 inflates by a third.
export const MAX_DEVICE_AUDIO_BYTES = 8 * 1024 * 1024;

// How long the scope may be asked to record for. Longer than a clip (30s) —
// a drone takes a while to say what it is — but bounded, because the answer
// has to fit in one WebSocket frame.
export const MAX_RECORD_SECONDS = 120;
export const DEFAULT_RECORD_SECONDS = 15;

// How much of a long recording is measured and drawn. A twenty-minute
// take's spectrogram is a smear either way, and decoding all of it inside a
// request is not worth the wall clock.
export const MAX_ANALYSIS_SECONDS = 300;

// The containers a recording may be stored in, by what the first bytes say.
// Everything here is something a browser <audio> element plays.
export const AUDIO_FORMATS = {
  wav: { mime: 'audio/wav' },
  mp3: { mime: 'audio/mpeg' },
  flac: { mime: 'audio/flac' },
  ogg: { mime: 'audio/ogg' },
  m4a: { mime: 'audio/mp4' },
  webm: { mime: 'audio/webm' },
};

export const AUDIO_SOURCES = ['upload', 'browser', 'device'];

const RIFF = Buffer.from('RIFF');
const WAVE = Buffer.from('WAVE');
const OGG = Buffer.from('OggS');
const FLAC = Buffer.from('fLaC');
const ID3 = Buffer.from('ID3');
const FTYP = Buffer.from('ftyp');
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

// The format the BYTES are, or null when they are nothing we store.
//
// webm and m4a share their containers with video, and the browser's own
// recorder produces exactly those: a MediaRecorder track is audio/webm even
// though the magic number is the one a video file starts with. Which stream
// is inside is ffprobe's business, not the sniffer's.
export function sniffAudioFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 4).equals(RIFF) && buffer.subarray(8, 12).equals(WAVE)) return 'wav';
  if (buffer.subarray(0, 4).equals(OGG)) return 'ogg';
  if (buffer.subarray(0, 4).equals(FLAC)) return 'flac';
  if (buffer.subarray(0, 4).equals(EBML)) return 'webm';
  if (buffer.subarray(4, 8).equals(FTYP)) return 'm4a';
  if (buffer.subarray(0, 3).equals(ID3)) return 'mp3';
  // A bare MPEG frame: 11 sync bits, with a layer and bitrate that are not
  // the reserved values. Checked last, since it is the loosest test here.
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    const layer = (buffer[1] >> 1) & 0x03;
    const bitrate = (buffer[2] >> 4) & 0x0f;
    if (layer !== 0 && bitrate !== 0x0f) return 'mp3';
  }
  return null;
}

export const audioDir = (capturesDir) => path.join(capturesDir, 'audio');
export const audioPath = (capturesDir, hash, format) =>
  path.join(audioDir(capturesDir), `${hash}.${format}`);
// The rendered picture lives beside the sound it is of, under its own hash
// so two identical recordings share one drawing.
export const waveformPath = (capturesDir, hash) =>
  path.join(audioDir(capturesDir), `${hash}.png`);

export function clampRecordDuration(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RECORD_SECONDS;
  return Math.min(MAX_RECORD_SECONDS, Math.max(1, Math.round(n)));
}

// Writes the bytes if they are not already there and returns their hash. The
// temporary name is what keeps a crash mid-write from leaving a truncated
// file sitting under the hash of the whole thing.
export function saveAudioFile(capturesDir, buffer, format) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const target = audioPath(capturesDir, hash, format);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(audioDir(capturesDir), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  }
  return hash;
}

export function saveWaveformImage(capturesDir, buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const target = waveformPath(capturesDir, hash);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(audioDir(capturesDir), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  }
  return hash;
}

// Both files go only once no recording references those bytes any more — the
// same rule capture images and clip videos follow.
export async function deleteAudioFilesIfOrphaned(db, capturesDir, { audioHash, format, waveformHash }) {
  const { AudioRecording } = db.models;
  if (audioHash && format && AUDIO_FORMATS[format]) {
    const remaining = await AudioRecording.count({ where: { audio_hash: audioHash } });
    if (remaining === 0) {
      const file = audioPath(capturesDir, audioHash, format);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  if (waveformHash) {
    const remaining = await AudioRecording.count({ where: { waveform_hash: waveformHash } });
    if (remaining === 0) {
      const file = waveformPath(capturesDir, waveformHash);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}

// Runs a tool and resolves with BOTH streams, whatever the exit code says.
// ffmpeg writes its measurements to stderr and its progress to stdout, and a
// filter that found nothing to measure is not an error worth failing an
// upload over — the caller decides what a missing number means.
//
// The environment is the allowlisted set the LLM CLIs get (no DATABASE_URL,
// no LLM_TOKEN_KEY): no child of this server carries its secrets.
// Injectable, like the run in videos.js, so tests never shell out.
export function runAudioTool(cmd, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    } catch (e) {
      return resolve({ code: null, stdout: '', stderr: String(e.message), failed: true });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) =>
      resolve({ code: null, stdout, stderr: `${stderr}\n${e.message}`, failed: true })
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, failed: code !== 0 });
    });
  });
}

const finite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// What ffprobe says the file is. Everything is optional: a container ffprobe
// cannot read is still a recording somebody can play.
export async function probeAudio(file, { run = runAudioTool } = {}) {
  const { stdout, failed } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'format=duration:stream=sample_rate,channels,codec_name,duration',
    '-of', 'json',
    file,
  ]);
  if (failed && !stdout.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }
  const stream = parsed?.streams?.[0] ?? {};
  return {
    duration_seconds: finite(parsed?.format?.duration) ?? finite(stream.duration),
    sample_rate: finite(stream.sample_rate),
    channel_count: finite(stream.channels),
    codec: stream.codec_name ? String(stream.codec_name) : null,
  };
}

// Peak and mean level in dBFS, off ffmpeg's volumedetect. "How hot is it"
// answers a whole class of eurorack question — a modular runs at ten volts
// peak-to-peak and an interface expecting line level clips on it — and it is
// the one thing a picture of a waveform states least precisely.
export async function measureLevels(file, { run = runAudioTool } = {}) {
  const { stderr } = await run('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-t', String(MAX_ANALYSIS_SECONDS),
    '-i', file,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ]);
  const peak = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr || '');
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr || '');
  return {
    peak_dbfs: peak ? Number(peak[1]) : null,
    rms_dbfs: mean ? Number(mean[1]) : null,
  };
}

// The waveform over the spectrogram, as one PNG.
//
// Two pictures rather than one because they answer different questions: the
// wave says the shape of the envelope and whether it clips, the spectrogram
// says what the sound is MADE of — which harmonic the filter is sitting on,
// whether that buzz is aliasing or the oscillator, whether the noise floor
// is hum at 50 Hz. Both are stacked into a single image because a question
// carries one picture per recording and every image costs tokens.
//
// Both halves are scaled to the same width before stacking: showspectrumpic
// with a legend comes out wider than the size it was asked for, and vstack
// refuses two inputs of different widths.
export async function renderWaveform(file, out, { run = runAudioTool } = {}) {
  const filter = [
    '[0:a]aformat=channel_layouts=mono,asplit=2[a1][a2]',
    '[a1]showwavespic=s=1200x300:colors=0x4aa3ff,scale=1200:-2,format=rgb24[w]',
    '[a2]showspectrumpic=s=1200x420:legend=1,scale=1200:-2,format=rgb24[s]',
    '[w][s]vstack=inputs=2[out]',
  ].join(';');
  const { failed } = await run('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-t', String(MAX_ANALYSIS_SECONDS),
    '-i', file,
    '-filter_complex', filter,
    '-map', '[out]',
    '-frames:v', '1',
    out,
  ]);
  if (failed || !fs.existsSync(out)) return null;
  const stat = fs.statSync(out);
  return stat.size > 0 ? out : null;
}

// Everything measurable about a stored recording, plus the drawing of it.
// Called once, when the bytes arrive. A failure anywhere leaves the field
// null: the recording is stored either way, and a null here is the honest
// answer to "what does the server know about this file".
export async function analyzeRecording(capturesDir, hash, format, { run = runAudioTool, log = () => {} } = {}) {
  const file = audioPath(capturesDir, hash, format);
  if (!fs.existsSync(file)) return {};
  let probed = {};
  let levels = {};
  try {
    probed = await probeAudio(file, { run });
    levels = await measureLevels(file, { run });
  } catch (e) {
    log(`could not measure the recording: ${e.message}`);
  }

  let waveformHash = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-waveform-'));
  try {
    const out = path.join(dir, 'waveform.png');
    const rendered = await renderWaveform(file, out, { run });
    if (rendered) waveformHash = saveWaveformImage(capturesDir, fs.readFileSync(rendered));
    else log('could not draw the waveform (is ffmpeg installed?)');
  } catch (e) {
    log(`could not draw the waveform: ${e.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return {
    duration_seconds: probed.duration_seconds ?? null,
    sample_rate: probed.sample_rate ?? null,
    channel_count: probed.channel_count ?? null,
    peak_dbfs: levels.peak_dbfs ?? null,
    rms_dbfs: levels.rms_dbfs ?? null,
    waveform_hash: waveformHash,
  };
}

// One `record_audio` answer from a device, checked and flattened. Throws with
// a user-facing message when the device sent something unusable — the route
// turns that into a 502, since the fault is the device's.
export function parseAudioResult(payload = {}) {
  const audio = payload.audio || {};
  const claimed = String(audio.format || '').toLowerCase();
  if (claimed && !AUDIO_FORMATS[claimed]) {
    throw new Error(
      `unsupported audio format '${claimed}' (expected ${Object.keys(AUDIO_FORMATS).join(', ')})`
    );
  }
  const data = audio.data ?? payload.audio_base64;
  if (!data) throw new Error('the device returned no audio data');

  const buffer = Buffer.from(String(data), 'base64');
  if (buffer.length === 0) throw new Error('the device returned an empty recording');
  if (buffer.length > MAX_DEVICE_AUDIO_BYTES) {
    throw new Error(`the recording is larger than the ${MAX_DEVICE_AUDIO_BYTES} byte limit`);
  }
  const format = sniffAudioFormat(buffer);
  if (!format) throw new Error('the audio data is not a format this app stores');
  if (claimed && claimed !== format) {
    throw new Error(`the audio data is ${format} but was declared '${claimed}'`);
  }

  return {
    buffer,
    format,
    duration_seconds: finite(audio.duration_seconds ?? payload.duration_seconds),
    sample_rate: finite(audio.sample_rate ?? payload.sample_rate),
    channel_count: finite(audio.channels ?? payload.channel_count),
    recorded_at: payload.captured_at ? new Date(payload.captured_at) : new Date(),
  };
}

const SOURCE_LABELS = {
  upload: 'uploaded file',
  browser: 'recorded in the browser',
  device: 'recorded from the oscilloscope',
};

// The response shape for a recording, everywhere one is served.
export function audioJson(recording, extra = {}) {
  const plain = recording.get ? recording.get({ plain: true }) : recording;
  return {
    id: plain.id,
    module_id: plain.module_id,
    patch_id: plain.patch_id,
    patch_name: plain.patch_name,
    source: plain.source,
    device_name: plain.device_name,
    audio_device_name: plain.audio_device_name,
    title: plain.title,
    caption: plain.caption,
    original_name: plain.original_name,
    audio_format: plain.audio_format,
    audio_bytes: plain.audio_bytes,
    duration_seconds: plain.duration_seconds,
    sample_rate: plain.sample_rate,
    channel_count: plain.channel_count,
    peak_dbfs: plain.peak_dbfs,
    rms_dbfs: plain.rms_dbfs,
    // What to play and what to draw. Both are served by /api/audio, which is
    // where the ownership check is.
    url: `/api/audio/${plain.id}/file`,
    waveform_url: plain.waveform_hash ? `/api/audio/${plain.id}/waveform` : null,
    recorded_at: plain.recorded_at,
    created_at: plain.created_at,
    ...extra,
  };
}

const seconds = (value) =>
  value == null ? null : `${Number(value).toFixed(Number(value) < 10 ? 2 : 1)}s`;

// A recording written out in words, for the backend that cannot hear it.
// Everything the picture shows is stated here as well, the way a capture's
// readings are: an agent that cannot open a PNG still knows how long the
// take is, how hot it runs, and what the user said it was.
export function audioTextDocument(recording, { moduleName = null, patchName = null } = {}) {
  const plain = recording.get ? recording.get({ plain: true }) : recording;
  const lines = [`# Audio recording: ${plain.title || plain.original_name || `recording ${plain.id}`}`, ''];
  lines.push(`- Source: ${SOURCE_LABELS[plain.source] || plain.source}`);
  if (moduleName) lines.push(`- Recorded from the module: ${moduleName}`);
  if (patchName || plain.patch_name) {
    lines.push(`- Recorded from the patch: ${patchName || plain.patch_name}`);
  }
  if (plain.device_name) lines.push(`- Oscilloscope: ${plain.device_name}`);
  if (plain.audio_device_name) lines.push(`- Audio interface: ${plain.audio_device_name}`);
  if (plain.recorded_at) lines.push(`- Recorded at: ${new Date(plain.recorded_at).toISOString()}`);
  if (plain.duration_seconds != null) lines.push(`- Duration: ${seconds(plain.duration_seconds)}`);
  if (plain.sample_rate != null) lines.push(`- Sample rate: ${Math.round(plain.sample_rate)} Hz`);
  if (plain.channel_count != null) {
    lines.push(
      `- Channels: ${plain.channel_count}${plain.channel_count === 1 ? ' (mono)' : plain.channel_count === 2 ? ' (stereo)' : ''}`
    );
  }
  if (plain.peak_dbfs != null) {
    lines.push(
      `- Peak level: ${plain.peak_dbfs.toFixed(1)} dBFS` +
        (plain.peak_dbfs >= -0.1
          ? ' (at or above full scale — this recording is clipping)'
          : plain.peak_dbfs < -30
            ? ' (very quiet)'
            : '')
    );
  }
  if (plain.rms_dbfs != null) lines.push(`- Mean (RMS) level: ${plain.rms_dbfs.toFixed(1)} dBFS`);
  if (plain.audio_format) lines.push(`- Format: ${plain.audio_format}`);
  if (plain.caption) {
    lines.push('', '## What the user says about it', '', plain.caption);
  }
  if (plain.waveform_hash) {
    lines.push(
      '',
      'An image of this recording is attached: the waveform of the whole take on top ' +
        '(amplitude against time) and its spectrogram underneath (frequency against time, ' +
        'brighter is louder, with the frequency scale in the legend). Read the harmonic ' +
        'content, the noise floor and the envelope off that picture; the numbers above are ' +
        'measured from the audio itself.'
    );
  } else {
    lines.push(
      '',
      'No picture of this recording could be rendered, so judge it from the measurements above ' +
        'and what the user said about it.'
    );
  }
  return lines.join('\n');
}
