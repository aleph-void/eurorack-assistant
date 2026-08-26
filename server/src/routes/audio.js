// Stored recordings. Strictly private, like captures and clips: a recording
// is the sound of the user's own rack, so every lookup is scoped to the
// owner — the module it hangs off may be shared, the recording never is.
//
// The bytes arrive here two of the three ways a recording is made: an
// uploaded file and a take recorded in the browser both POST base64 to this
// router (they differ only in what `source` says and what the browser calls
// the file). The third way — asking the linked oscilloscope to record — is
// in routes/scope.js, where the device hub is.

import fs from 'node:fs';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { STORED_FILE_POLICY } from '../csp.js';
import {
  AUDIO_FORMATS,
  AUDIO_SOURCES,
  MAX_AUDIO_BYTES,
  analyzeRecording,
  audioJson,
  audioPath,
  deleteAudioFilesIfOrphaned,
  saveAudioFile,
  sniffAudioFormat,
  waveformPath,
} from '../services/audio.js';
import { userHasModule } from '../services/racks.js';
import { asyncHandler } from './asyncHandler.js';

// Content-addressed bytes never change under their row, so the same
// immutable policy the panels, captures and clips are served under holds.
const IMMUTABLE = 'private, max-age=31536000, immutable';

export function audioRoutes(
  db,
  { capturesDir = process.env.CAPTURES_DIR || '/data/captures', runImpl = undefined } = {}
) {
  const { AudioRecording, Patch } = db.models;
  const router = Router();
  router.use(requireAuth(db));

  const analyzeOptions = runImpl ? { run: runImpl } : {};

  const ownRecording = (userId, id) =>
    AudioRecording.findOne({ where: { id: Number(id) || 0, user_id: userId } });

  // Optional filters: ?module_id= / ?patch_id=. Newest first — the take you
  // just made is the one you are looking for.
  router.get('/', asyncHandler(async (req, res) => {
    const where = { user_id: req.user.id };
    if (req.query.module_id) where.module_id = Number(req.query.module_id) || 0;
    if (req.query.patch_id) where.patch_id = Number(req.query.patch_id) || 0;
    const rows = await AudioRecording.findAll({ where, order: [['id', 'DESC']] });
    res.json(rows.map((row) => audioJson(row)));
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const recording = await ownRecording(req.user.id, req.params.id);
    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    res.json(audioJson(recording));
  }));

  // The sound itself. Range requests are answered because this is what an
  // <audio> element is pointed at: without them a browser can play a
  // recording but not scrub through one, and scrubbing is most of listening
  // to a five-minute take for the one bar that buzzes.
  router.get('/:id/file', asyncHandler(async (req, res) => {
    const recording = await ownRecording(req.user.id, req.params.id);
    if (!recording || !recording.audio_hash || !AUDIO_FORMATS[recording.audio_format]) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    const file = audioPath(capturesDir, recording.audio_hash, recording.audio_format);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Recording file not found' });
    const size = fs.statSync(file).size;

    res.set('Content-Type', AUDIO_FORMATS[recording.audio_format].mime);
    res.set('Content-Security-Policy', STORED_FILE_POLICY);
    res.set('Cache-Control', IMMUTABLE);
    res.set('Accept-Ranges', 'bytes');

    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range) {
      const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (!Number.isFinite(start) || start >= size || end < start) {
        res.set('Content-Range', `bytes */${size}`);
        return res.status(416).end();
      }
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${size}`);
      res.set('Content-Length', String(end - start + 1));
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.set('Content-Length', String(size));
    fs.createReadStream(file).pipe(res);
  }));

  // The drawing of it: the waveform above the spectrogram, as rendered when
  // the bytes arrived.
  router.get('/:id/waveform', asyncHandler(async (req, res) => {
    const recording = await ownRecording(req.user.id, req.params.id);
    if (!recording?.waveform_hash) return res.status(404).json({ error: 'No waveform image' });
    const file = waveformPath(capturesDir, recording.waveform_hash);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'No waveform image' });
    res.set('Content-Type', 'image/png');
    res.set('Content-Security-Policy', STORED_FILE_POLICY);
    res.set('Cache-Control', IMMUTABLE);
    fs.createReadStream(file).pipe(res);
  }));

  // Body: { module_id?, patch_id?, filename?, data_base64, source?, title?,
  //         caption? }. Exactly one of module_id/patch_id: a recording of
  //         nothing in particular has no page to live on, and one of two
  //         things at once has no page that is really about it.
  router.post('/', asyncHandler(async (req, res) => {
    const moduleId = req.body?.module_id ? Number(req.body.module_id) : null;
    const patchId = req.body?.patch_id ? Number(req.body.patch_id) : null;
    if (!moduleId && !patchId) {
      return res.status(400).json({ error: 'Name what the recording is of: module_id or patch_id' });
    }
    if (moduleId && patchId) {
      return res
        .status(400)
        .json({ error: 'A recording is of a module or of a patch, not both' });
    }
    if (moduleId && !(await userHasModule(db, req.user.id, moduleId))) {
      return res.status(404).json({ error: 'Module not found' });
    }
    let patch = null;
    if (patchId) {
      patch = await Patch.findOne({ where: { id: patchId, user_id: req.user.id } });
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
    }

    const dataBase64 = req.body?.data_base64;
    if (!dataBase64) return res.status(400).json({ error: 'data_base64 is required' });
    let data;
    try {
      data = Buffer.from(String(dataBase64), 'base64');
    } catch {
      return res.status(400).json({ error: 'data_base64 is not valid base64' });
    }
    if (data.length === 0) return res.status(400).json({ error: 'the recording is empty' });
    if (data.length > MAX_AUDIO_BYTES) {
      return res
        .status(400)
        .json({ error: `recordings are limited to ${Math.round(MAX_AUDIO_BYTES / (1024 * 1024))}MB` });
    }
    // The bytes decide: a file named .wav that is really something else
    // would be served with the wrong type for good.
    const format = sniffAudioFormat(data);
    if (!format) {
      return res.status(400).json({
        error: `that file is not audio this app stores (${Object.keys(AUDIO_FORMATS).join(', ')})`,
      });
    }

    const source = AUDIO_SOURCES.includes(req.body?.source) && req.body.source !== 'device'
      ? req.body.source
      : 'upload';

    // The file lands first: bytes with no row are reaped, but a row pointing
    // at a missing file is a broken recording forever.
    const hash = saveAudioFile(capturesDir, data, format);
    const measured = await analyzeRecording(capturesDir, hash, format, analyzeOptions);

    const recording = await AudioRecording.create({
      user_id: req.user.id,
      module_id: moduleId,
      patch_id: patchId,
      patch_name: patch?.name ?? null,
      source,
      title: req.body?.title ? String(req.body.title).trim().slice(0, 200) : null,
      caption: req.body?.caption ? String(req.body.caption).trim().slice(0, 2000) : null,
      original_name: req.body?.filename ? String(req.body.filename).trim().slice(0, 255) : null,
      audio_hash: hash,
      audio_format: format,
      audio_bytes: data.length,
      recorded_at: new Date(),
      ...measured,
    });
    res.status(201).json(audioJson(recording));
  }));

  // Body: { title?, caption? }. The sound is what it is; only what you call
  // it and what you say about it can change.
  router.put('/:id', asyncHandler(async (req, res) => {
    const recording = await ownRecording(req.user.id, req.params.id);
    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    const values = {};
    if (req.body?.title !== undefined) {
      values.title = String(req.body.title).trim().slice(0, 200) || null;
    }
    if (req.body?.caption !== undefined) {
      values.caption = String(req.body.caption).trim().slice(0, 2000) || null;
    }
    await recording.update(values);
    res.json(audioJson(recording));
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const recording = await ownRecording(req.user.id, req.params.id);
    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    const audioHash = recording.audio_hash;
    const format = recording.audio_format;
    const waveformHash = recording.waveform_hash;
    await recording.destroy();
    // The files go only once nothing else points at those bytes.
    await deleteAudioFilesIfOrphaned(db, capturesDir, { audioHash, format, waveformHash });
    res.json({ ok: true });
  }));

  return router;
}
