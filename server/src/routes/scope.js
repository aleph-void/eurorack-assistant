// The browser's side of a connected oscilloscope: what each pane is looking
// at, and asking the device for a waveform.
//
// The mapping between scope channels and patch jacks is worked out from the
// patch itself (services/scopeMapping.js) and stored per patch, so a capture
// taken weeks later still says which jack it came from. A channel the user
// set by hand is never overwritten by a re-map.

import path from 'node:path';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { loadPatchDetail } from '../services/patchDetail.js';
import { buildScopeChannelMap } from '../services/scopeMapping.js';
import {
  captureNoteBody,
  parseCaptureResult,
  saveCaptureImage,
} from '../services/captures.js';
import { clampClipDuration, clipJson, parseClipResult, saveClipVideo } from '../services/clips.js';
import { userModule } from './modules/helpers.js';
import { asyncHandler } from './asyncHandler.js';

export function scopeRoutes(db, { hub = null, capturesDir = process.env.CAPTURES_DIR || '/data/captures' } = {}) {
  const {
    Patch,
    PatchScopeChannel,
    Capture,
    CaptureChannel,
    Note,
    NotePatch,
    NoteComponent,
    ScopeClip,
    ScopeClipChannel,
  } = db.models;
  const clipsDir = path.join(capturesDir, 'clips');
  const router = Router();
  router.use(requireAuth(db));

  function ownPatch(userId, id) {
    return Patch.findOne({ where: { id: Number(id) || 0, user_id: userId } });
  }

  const channelJson = (row) => ({
    id: row.id,
    channel_index: row.channel_index,
    audio_device_id: row.audio_device_id,
    patch_module_id: row.patch_module_id,
    component_id: row.component_id,
    component_name: row.component_name,
    label: row.label,
    signal_type: row.signal_type,
    source: row.source,
    updated_at: row.updated_at,
  });

  const storedChannels = async (patchId) => {
    const rows = await PatchScopeChannel.findAll({
      where: { patch_id: patchId },
      order: [['channel_index', 'ASC']],
    });
    return rows.map(channelJson);
  };

  // The device this request is about: the one named, or the only one
  // connected. Returns null when the user has no scope on the line.
  const pickDevice = (userId, connectionId) => (hub ? hub.pick(userId, connectionId) : null);

  // What the scope should call each pane, in the device's own message shape.
  const labelPayload = (channels) => ({
    channels: channels
      .filter((c) => c.label)
      .map((c) => ({
        index: c.channel_index,
        label: c.label,
        signal_type: c.signal_type || undefined,
      })),
  });

  // Current map + what is connected + what an automap would produce.
  router.get('/patches/:id', asyncHandler(async (req, res) => {
    const patch = await ownPatch(req.user.id, req.params.id);
    if (!patch) return res.status(404).json({ error: 'Patch not found' });
    const devices = hub ? hub.list(req.user.id) : [];
    const device = pickDevice(req.user.id, req.query.connection_id);
    let suggestion = null;
    if (device) {
      const { json } = await loadPatchDetail(db, patch);
      suggestion = buildScopeChannelMap({ detail: json, device: hub.summarize(device) });
    }
    res.json({
      patch_id: patch.id,
      channels: await storedChannels(patch.id),
      devices,
      suggestion,
    });
  }));

  // Derive the map from the patch and store it. Channels the user set by hand
  // keep their setting unless ?overwrite=1 says otherwise.
  router.post('/patches/:id/automap', asyncHandler(async (req, res) => {
    const patch = await ownPatch(req.user.id, req.params.id);
    if (!patch) return res.status(404).json({ error: 'Patch not found' });
    const device = pickDevice(req.user.id, req.body?.connection_id);
    if (!device) return res.status(409).json({ error: 'No oscilloscope is connected' });

    const state = hub.summarize(device);
    const { json } = await loadPatchDetail(db, patch);
    const map = buildScopeChannelMap({ detail: json, device: state });
    const overwriteManual = Boolean(req.body?.overwrite);

    // The map is written row by row across one table, but a half-applied
    // map would leave panes pointing at the wrong jacks.
    await db.sequelize.transaction(async (transaction) => {
      for (const channel of map.channels) {
        const existing = await PatchScopeChannel.findOne({
          where: { patch_id: patch.id, channel_index: channel.channel_index },
          transaction,
        });
        if (existing && existing.source === 'manual' && !overwriteManual) continue;
        const values = {
          patch_id: patch.id,
          channel_index: channel.channel_index,
          audio_device_id: state.audio_device?.id ?? null,
          patch_module_id: channel.patch_module_id,
          component_id: channel.component_id,
          component_name: channel.component_name,
          label: channel.label,
          signal_type: channel.signal_type,
          source: 'auto',
        };
        if (existing) await existing.update(values, { transaction });
        else await PatchScopeChannel.create(values, { transaction });
      }
    });

    const channels = await storedChannels(patch.id);
    // Push the names down so the panes on the bench read the same as the
    // ones on screen. A device that does not implement it is no failure, and
    // a map that named nothing has nothing to push.
    const labels = labelPayload(channels);
    let labelsPushed = false;
    if (labels.channels.length > 0) {
      try {
        await hub.request(device, 'set_labels', labels, { timeoutMs: 5000 });
        labelsPushed = true;
      } catch {
        /* the map is stored either way */
      }
    }

    res.json({
      patch_id: patch.id,
      matched_by: map.matched_by,
      interface: map.interface,
      labels_pushed: labelsPushed,
      channels,
    });
  }));

  // Body: { patch_module_id, component_id, component_name?, label?, signal_type? }
  router.put('/patches/:id/channels/:index', asyncHandler(async (req, res) => {
    const patch = await ownPatch(req.user.id, req.params.id);
    if (!patch) return res.status(404).json({ error: 'Patch not found' });
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) {
      return res.status(400).json({ error: 'channel index must be a non-negative integer' });
    }

    const { json } = await loadPatchDetail(db, patch);
    const patchModuleId = req.body?.patch_module_id ? Number(req.body.patch_module_id) : null;
    const componentId = req.body?.component_id ? Number(req.body.component_id) : null;
    let componentName = req.body?.component_name ? String(req.body.component_name) : null;

    if (patchModuleId !== null) {
      const instance = json.modules.find((m) => m.id === patchModuleId);
      if (!instance) return res.status(400).json({ error: 'That module is not in this patch' });
      if (componentId !== null) {
        const component = instance.components.find((c) => c.id === componentId);
        if (!component) {
          return res.status(400).json({ error: 'That jack is not on that module' });
        }
        componentName = component.name;
      }
    }

    const values = {
      patch_id: patch.id,
      channel_index: index,
      patch_module_id: patchModuleId,
      component_id: componentId,
      component_name: componentName,
      label: req.body?.label ? String(req.body.label).slice(0, 200) : null,
      signal_type: req.body?.signal_type === 'cv' ? 'cv' : 'audio',
      source: 'manual',
    };
    // A manual channel with no label still deserves a name; the jack it
    // watches is the obvious one.
    if (!values.label && componentName) {
      const instance = json.modules.find((m) => m.id === patchModuleId);
      const owner = instance ? instance.label || `${instance.manufacturer} ${instance.module_name}` : null;
      values.label = owner ? `${owner} — ${componentName}` : componentName;
    }

    const existing = await PatchScopeChannel.findOne({
      where: { patch_id: patch.id, channel_index: index },
    });
    const row = existing
      ? await existing.update(values)
      : await PatchScopeChannel.create(values);
    res.json(channelJson(row));
  }));

  // Forget one channel's mapping (the next automap will fill it in again).
  router.delete('/patches/:id/channels/:index', asyncHandler(async (req, res) => {
    const patch = await ownPatch(req.user.id, req.params.id);
    if (!patch) return res.status(404).json({ error: 'Patch not found' });
    await PatchScopeChannel.destroy({
      where: { patch_id: patch.id, channel_index: Number(req.params.index) },
    });
    res.json({ ok: true });
  }));

  // Push the stored labels to the scope without re-deriving them.
  router.post('/patches/:id/labels', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const device = pickDevice(req.user.id, req.body?.connection_id);
      if (!device) return res.status(409).json({ error: 'No oscilloscope is connected' });
      const channels = await storedChannels(patch.id);
      await hub.request(device, 'set_labels', labelPayload(channels), { timeoutMs: 5000 });
      res.json({ ok: true, channels });
    } catch (e) {
      // A device that is connected but not answering is its problem, not a
      // server fault — say so rather than returning a 500.
      if (/did not answer|disconnected/.test(e.message)) {
        return res.status(504).json({ error: e.message });
      }
      next(e);
    }
  });

  // A live tuner reading, not stored: what the scope hears right now.
  router.post('/patches/:id/tuner', async (req, res, next) => {
    try {
      const patch = await ownPatch(req.user.id, req.params.id);
      if (!patch) return res.status(404).json({ error: 'Patch not found' });
      const device = pickDevice(req.user.id, req.body?.connection_id);
      if (!device) return res.status(409).json({ error: 'No oscilloscope is connected' });
      const channels = await storedChannels(patch.id);
      const requested = Array.isArray(req.body?.channels) ? req.body.channels.map(Number) : null;
      const payload = await hub.request(device, 'tuner', {
        channels: requested ?? channels.map((c) => c.channel_index),
      });
      res.json({ patch_id: patch.id, channels: payload?.channels ?? [] });
    } catch (e) {
      if (/did not answer|disconnected/.test(e.message)) {
        return res.status(504).json({ error: e.message });
      }
      next(e);
    }
  });

  // Ask the scope for a waveform image (plus the tuner reading taken with it)
  // and file it under a note on this patch.
  //
  // Body: { connection_id?, channels?, include_tuner?, note_id?, title?,
  //         caption?, width?, height? }
  router.post('/patches/:id/captures', asyncHandler(async (req, res) => {
    const patch = await ownPatch(req.user.id, req.params.id);
    if (!patch) return res.status(404).json({ error: 'Patch not found' });
    const device = pickDevice(req.user.id, req.body?.connection_id);
    if (!device) return res.status(409).json({ error: 'No oscilloscope is connected' });

    const existingNoteId = req.body?.note_id ? Number(req.body.note_id) : null;
    let note = null;
    if (existingNoteId) {
      note = await Note.findOne({ where: { id: existingNoteId, user_id: req.user.id } });
      if (!note) return res.status(404).json({ error: 'Note not found' });
    }

    const mapped = await storedChannels(patch.id);
    const byIndex = new Map(mapped.map((c) => [c.channel_index, c]));
    const state = hub.summarize(device);
    const requested = Array.isArray(req.body?.channels)
      ? req.body.channels.map(Number).filter((n) => Number.isInteger(n) && n >= 0)
      : null;
    const indices =
      requested && requested.length > 0
        ? requested
        : (mapped.length > 0 ? mapped : state.channels).map((c) =>
            c.channel_index === undefined ? c.index : c.channel_index
          );

    // The source of each channel, as the patch reads right now — stored
    // with the capture so it still explains itself after the patch changes.
    const { json: detail } = await loadPatchDetail(db, patch);
    const map = buildScopeChannelMap({ detail, device: state });
    const derivedByIndex = new Map(map.channels.map((c) => [c.channel_index, c]));

    let payload;
    try {
      payload = await hub.request(device, 'capture', {
        channels: indices.map((index) => {
          const channel = byIndex.get(index);
          return {
            index,
            label: channel?.label ?? undefined,
            signal_type: channel?.signal_type ?? undefined,
          };
        }),
        include_tuner: req.body?.include_tuner !== false,
        image: {
          width: Number(req.body?.width) || undefined,
          height: Number(req.body?.height) || undefined,
        },
      });
    } catch (e) {
      return res.status(504).json({ error: e.message });
    }

    let parsed;
    try {
      parsed = parseCaptureResult(payload);
    } catch (e) {
      return res.status(502).json({ error: `The oscilloscope sent an unusable capture: ${e.message}` });
    }

    // The file lands first: an image with no row is reaped later, but a row
    // pointing at a missing file is a broken capture forever.
    const hash = saveCaptureImage(capturesDir, parsed.buffer);

    const channelRows = (parsed.channels.length > 0
      ? parsed.channels
      : indices.map((index) => ({ channel_index: index, signal_type: 'audio' }))
    ).map((c) => {
      const stored = byIndex.get(c.channel_index);
      const derived = derivedByIndex.get(c.channel_index);
      const instance = detail.modules.find(
        (m) => m.id === (stored?.patch_module_id ?? derived?.patch_module_id)
      );
      return {
        ...c,
        label: c.label || stored?.label || derived?.label || null,
        signal_type: c.signal_type || stored?.signal_type || derived?.signal_type || null,
        patch_module_id: stored?.patch_module_id ?? derived?.patch_module_id ?? null,
        component_id: stored?.component_id ?? derived?.component_id ?? null,
        component_name: stored?.component_name ?? derived?.component_name ?? null,
        module_label: instance
          ? instance.label || `${instance.manufacturer} ${instance.module_name}`
          : null,
        source_description: derived?.source_description ?? null,
      };
    });

    const title = req.body?.title ? String(req.body.title).slice(0, 200) : null;
    const caption = req.body?.caption ? String(req.body.caption).slice(0, 2000) : null;

    // Capture, channels and the note it is filed under are one write.
    const capture = await db.sequelize.transaction(async (transaction) => {
      const created = await Capture.create(
        {
          user_id: req.user.id,
          patch_id: patch.id,
          note_id: note ? note.id : null,
          device_token_id: device.tokenId,
          device_name: device.name,
          audio_device_id: state.audio_device?.id ?? null,
          audio_device_name: state.audio_device?.name ?? null,
          title,
          caption,
          image_hash: hash,
          image_width: parsed.width,
          image_height: parsed.height,
          image_bytes: parsed.buffer.length,
          sample_rate: parsed.sample_rate ?? state.audio_device?.sample_rate ?? null,
          captured_at: parsed.captured_at,
        },
        { transaction }
      );
      for (const channel of channelRows) {
        await CaptureChannel.create({ ...channel, capture_id: created.id }, { transaction });
      }

      // Captures live in the patch's notes, so one is created when the user
      // did not name an existing note to file this under.
      if (!note) {
        note = await Note.create(
          {
            user_id: req.user.id,
            title: title || `Waveform — ${patch.name}`,
            body: captureNoteBody({ ...created.get({ plain: true }), title }, channelRows, {
              patchName: patch.name,
            }),
          },
          { transaction }
        );
        await created.update({ note_id: note.id }, { transaction });
      }
      const linked = await NotePatch.findOne({
        where: { note_id: note.id, patch_id: patch.id },
        transaction,
      });
      if (!linked) {
        await NotePatch.create({ note_id: note.id, patch_id: patch.id }, { transaction });
      }
      // Also hang the note off the jacks it is about, so it surfaces on the
      // module pages and in question scoping.
      for (const componentId of new Set(
        channelRows.map((c) => c.component_id).filter((id) => Number.isInteger(id))
      )) {
        const already = await NoteComponent.findOne({
          where: { note_id: note.id, component_id: componentId },
          transaction,
        });
        if (!already) {
          await NoteComponent.create(
            { note_id: note.id, component_id: componentId },
            { transaction }
          );
        }
      }
      return created;
    });

    const channels = await CaptureChannel.findAll({
      where: { capture_id: capture.id },
      order: [['channel_index', 'ASC']],
    });
    res.status(201).json({
      ...capture.get({ plain: true }),
      note_id: note.id,
      channels: channels.map((c) => c.get({ plain: true })),
    });
  }));

  // Ask the scope to record a short video clip of the chosen panes and
  // attach it to a MODULE — the one whose signal the panes are showing, or
  // the one the body names. A clip lands on the module's videos page rather
  // than in the patch's notes: what a module's output looks like moving is
  // a fact about the module, whatever patch it was recorded during.
  //
  // Body: { connection_id?, channels?, duration_seconds?, module_id?,
  //         title?, caption? }
  router.post('/patches/:id/clips', asyncHandler(async (req, res) => {
    const patch = await ownPatch(req.user.id, req.params.id);
    if (!patch) return res.status(404).json({ error: 'Patch not found' });
    const device = pickDevice(req.user.id, req.body?.connection_id);
    if (!device) return res.status(409).json({ error: 'No oscilloscope is connected' });
    const state = hub.summarize(device);
    // A device that announced its capabilities and left recording out gets a
    // clear refusal now, not a silent 30-second timeout.
    if (Array.isArray(state.capabilities) && !state.capabilities.includes('record')) {
      return res
        .status(409)
        .json({ error: 'The connected oscilloscope does not support recording clips' });
    }

    const mapped = await storedChannels(patch.id);
    const byIndex = new Map(mapped.map((c) => [c.channel_index, c]));
    const requested = Array.isArray(req.body?.channels)
      ? req.body.channels.map(Number).filter((n) => Number.isInteger(n) && n >= 0)
      : null;
    const indices =
      requested && requested.length > 0
        ? requested
        : (mapped.length > 0 ? mapped : state.channels).map((c) =>
            c.channel_index === undefined ? c.index : c.channel_index
          );

    const { json: detail } = await loadPatchDetail(db, patch);
    const map = buildScopeChannelMap({ detail, device: state });
    const derivedByIndex = new Map(map.channels.map((c) => [c.channel_index, c]));

    // The module the clip attaches to: the one named, or the one feeding the
    // first recorded pane (falling back to the pane's own jack — an
    // unpatched input is showing the interface itself).
    let module = null;
    if (req.body?.module_id) {
      module = await userModule(db, req.user.id, req.body.module_id);
      if (!module) return res.status(404).json({ error: 'Module not found' });
    } else {
      for (const index of indices) {
        const derived = derivedByIndex.get(index);
        const stored = byIndex.get(index);
        const instance =
          detail.modules.find((m) => m.id === derived?.source_patch_module_id) ??
          detail.modules.find((m) => m.id === (stored?.patch_module_id ?? derived?.patch_module_id));
        if (!instance?.module_id) continue;
        module = await userModule(db, req.user.id, instance.module_id);
        if (module) break;
      }
      if (!module) {
        return res.status(400).json({
          error:
            'No module to attach the clip to — the recorded panes are not mapped to any module in your racks, so name one with module_id',
        });
      }
    }

    const duration = clampClipDuration(req.body?.duration_seconds);
    let payload;
    try {
      payload = await hub.request(
        device,
        'record',
        {
          channels: indices.map((index) => {
            const channel = byIndex.get(index);
            return {
              index,
              label: channel?.label ?? undefined,
              signal_type: channel?.signal_type ?? undefined,
            };
          }),
          duration_seconds: duration,
        },
        // The device cannot answer before the recording ends, so the usual
        // timeout starts counting after the requested duration.
        { timeoutMs: duration * 1000 + 30000 }
      );
    } catch (e) {
      return res.status(504).json({ error: e.message });
    }

    let parsed;
    try {
      parsed = parseClipResult(payload);
    } catch (e) {
      return res.status(502).json({ error: `The oscilloscope sent an unusable clip: ${e.message}` });
    }

    // The file lands first: a video with no row is reaped later, but a row
    // pointing at a missing file is a broken clip forever.
    const hash = saveClipVideo(clipsDir, parsed.buffer, parsed.format);

    const fromDevice = new Map(parsed.channels.map((c) => [c.channel_index, c]));
    const channelRows = indices.map((index) => {
      const answered = fromDevice.get(index);
      const stored = byIndex.get(index);
      const derived = derivedByIndex.get(index);
      const instance = detail.modules.find(
        (m) => m.id === (stored?.patch_module_id ?? derived?.patch_module_id)
      );
      return {
        channel_index: index,
        label: answered?.label || stored?.label || derived?.label || null,
        signal_type: answered?.signal_type || stored?.signal_type || derived?.signal_type || null,
        patch_module_id: stored?.patch_module_id ?? derived?.patch_module_id ?? null,
        component_id: stored?.component_id ?? derived?.component_id ?? null,
        component_name: stored?.component_name ?? derived?.component_name ?? null,
        module_label: instance
          ? instance.label || `${instance.manufacturer} ${instance.module_name}`
          : null,
        source_description: derived?.source_description ?? null,
      };
    });

    const clip = await db.sequelize.transaction(async (transaction) => {
      const created = await ScopeClip.create(
        {
          user_id: req.user.id,
          module_id: module.id,
          patch_id: patch.id,
          patch_name: patch.name,
          device_token_id: device.tokenId,
          device_name: device.name,
          audio_device_id: state.audio_device?.id ?? null,
          audio_device_name: state.audio_device?.name ?? null,
          title: req.body?.title ? String(req.body.title).slice(0, 200) : null,
          caption: req.body?.caption ? String(req.body.caption).slice(0, 2000) : null,
          video_hash: hash,
          video_format: parsed.format,
          video_width: parsed.width,
          video_height: parsed.height,
          video_bytes: parsed.buffer.length,
          duration_seconds: parsed.duration_seconds ?? duration,
          sample_rate: parsed.sample_rate ?? state.audio_device?.sample_rate ?? null,
          captured_at: parsed.captured_at,
        },
        { transaction }
      );
      for (const channel of channelRows) {
        await ScopeClipChannel.create({ ...channel, clip_id: created.id }, { transaction });
      }
      return created;
    });

    const channels = await ScopeClipChannel.findAll({
      where: { clip_id: clip.id },
      order: [['channel_index', 'ASC']],
    });
    res.status(201).json(clipJson(clip, channels));
  }));

  return router;
}
