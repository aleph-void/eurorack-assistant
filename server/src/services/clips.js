// Short oscilloscope video clips: a few seconds of the chosen panes as the
// device rendered them, attached to a module rather than filed under a patch
// note — "what this module's output looks like doing this" belongs with the
// module, next to its YouTube videos.
//
// The bytes are content-addressed exactly like capture images — sha256,
// stored at <clipsDir>/<hash>.<format> — so two identical clips cost one
// file and a clip can never half-exist under a name that says otherwise.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The device answers over the same WebSocket as everything else, and its
// frames are capped at 12 MB (ws.js). Base64 inflates by a third, so 8 MB of
// video is the most an answer can carry — the same cap as capture images.
export const MAX_VIDEO_BYTES = 8 * 1024 * 1024;

// "Short" is the point: a clip is a look at a waveform moving, not a
// recording session. The device is asked for a bounded duration so a typo
// cannot park the scope recording for an hour.
export const MAX_CLIP_SECONDS = 30;
export const DEFAULT_CLIP_SECONDS = 10;

// webm is an EBML document; mp4 puts 'ftyp' at byte 4. Both are containers
// a <video> tag plays, and both are formats a scope app can plausibly
// encode to, so both are accepted.
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const MP4_FTYP = Buffer.from('ftyp');

export const CLIP_FORMATS = {
  webm: { mime: 'video/webm' },
  mp4: { mime: 'video/mp4' },
};

export function sniffClipFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 4).equals(WEBM_MAGIC)) return 'webm';
  if (buffer.subarray(4, 8).equals(MP4_FTYP)) return 'mp4';
  return null;
}

export function clipPath(clipsDir, hash, format) {
  return path.join(clipsDir, `${hash}.${format}`);
}

// The requested recording length, clamped into [1, MAX_CLIP_SECONDS] with a
// default for a request that names none.
export function clampClipDuration(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CLIP_SECONDS;
  return Math.min(MAX_CLIP_SECONDS, Math.max(1, Math.round(n)));
}

// Writes the video if it is not already there and returns its hash. Written
// to a temporary name first so a crash mid-write cannot leave a truncated
// file sitting under the hash of the whole thing.
export function saveClipVideo(clipsDir, buffer, format) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const target = clipPath(clipsDir, hash, format);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(clipsDir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  }
  return hash;
}

// Deletes the file only once no clip row references the hash any more (the
// same rule capture images follow).
export async function deleteClipVideoIfOrphaned(db, clipsDir, hash, format) {
  if (!hash || !format) return;
  const remaining = await db.models.ScopeClip.count({ where: { video_hash: hash } });
  if (remaining > 0) return;
  const file = clipPath(clipsDir, hash, format);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// One `record` answer from a device, checked and flattened. Throws with a
// user-facing message when the device sent something unusable — the route
// turns that into a 502, since the fault is the device's.
export function parseClipResult(payload = {}) {
  const video = payload.video || {};
  const claimed = String(video.format || '').toLowerCase();
  if (claimed && !CLIP_FORMATS[claimed]) {
    throw new Error(`unsupported video format '${claimed}' (expected webm or mp4)`);
  }
  const data = video.data ?? payload.video_base64;
  if (!data) throw new Error('the device returned no video data');

  const buffer = Buffer.from(String(data), 'base64');
  if (buffer.length === 0) throw new Error('the device returned an empty video');
  if (buffer.length > MAX_VIDEO_BYTES) {
    throw new Error(`video is larger than the ${MAX_VIDEO_BYTES} byte limit`);
  }
  // The bytes decide the format: a mislabeled container would be stored
  // under the wrong extension and served with the wrong type forever.
  const format = sniffClipFormat(buffer);
  if (!format) throw new Error('the video data is not webm or mp4');
  if (claimed && claimed !== format) {
    throw new Error(`the video data is ${format} but was declared '${claimed}'`);
  }

  const channels = Array.isArray(payload.channels) ? payload.channels : [];
  return {
    buffer,
    format,
    width: Number.isFinite(Number(video.width)) ? Number(video.width) : null,
    height: Number.isFinite(Number(video.height)) ? Number(video.height) : null,
    duration_seconds: number(video.duration_seconds ?? payload.duration_seconds),
    captured_at: payload.captured_at ? new Date(payload.captured_at) : new Date(),
    sample_rate: number(payload.sample_rate),
    channels: channels.map((c, i) => ({
      channel_index: Number.isInteger(c?.index) ? c.index : i,
      label: c?.label ? String(c.label).slice(0, 200) : null,
      signal_type: c?.signal_type === 'cv' ? 'cv' : 'audio',
    })),
  };
}

// The response shape for a clip, everywhere one is served (the record
// endpoint, /api/clips and the module detail payload alike).
export function clipJson(clip, channels = []) {
  const plain = clip.get ? clip.get({ plain: true }) : clip;
  return {
    id: plain.id,
    module_id: plain.module_id,
    patch_id: plain.patch_id,
    patch_name: plain.patch_name,
    device_name: plain.device_name,
    audio_device_name: plain.audio_device_name,
    title: plain.title,
    caption: plain.caption,
    video_format: plain.video_format,
    video_width: plain.video_width,
    video_height: plain.video_height,
    video_bytes: plain.video_bytes,
    duration_seconds: plain.duration_seconds,
    sample_rate: plain.sample_rate,
    captured_at: plain.captured_at,
    created_at: plain.created_at,
    channels: channels.map((c) => {
      const row = c.get ? c.get({ plain: true }) : c;
      return {
        id: row.id,
        channel_index: row.channel_index,
        label: row.label,
        signal_type: row.signal_type,
        component_name: row.component_name,
        module_label: row.module_label,
        source_description: row.source_description,
      };
    }),
  };
}
