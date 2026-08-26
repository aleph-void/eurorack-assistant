// The hardware oscilloscope: which channel watches which jack, and what it caught.
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function defineScopeModels(define) {
  // Which scope channel watches which jack, per patch. component_id and
  // patch_module_id are soft references (see migration 013).
  const PatchScopeChannel = define(
    'PatchScopeChannel',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      channel_index: { type: DataTypes.INTEGER, allowNull: false },
      audio_device_id: { type: DataTypes.TEXT },
      patch_module_id: { type: DataTypes.INTEGER },
      component_id: { type: DataTypes.INTEGER },
      component_name: { type: DataTypes.TEXT },
      label: { type: DataTypes.TEXT },
      signal_type: { type: DataTypes.TEXT },
      source: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'auto' },
    },
    { tableName: 'patch_scope_channels', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // A waveform image plus the tuner reading taken with it, filed under a
  // note on the patch it was taken from or on the module it is of.
  const Capture = define(
    'Capture',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      // At most one of these: patch_id for a capture taken while patching,
      // module_id for one taken at the bench (migration 042).
      patch_id: { type: DataTypes.INTEGER },
      module_id: { type: DataTypes.INTEGER },
      note_id: { type: DataTypes.INTEGER },
      device_token_id: { type: DataTypes.INTEGER },
      device_name: { type: DataTypes.TEXT },
      audio_device_id: { type: DataTypes.TEXT },
      audio_device_name: { type: DataTypes.TEXT },
      title: { type: DataTypes.TEXT },
      caption: { type: DataTypes.TEXT },
      image_hash: { type: DataTypes.TEXT },
      image_width: { type: DataTypes.INTEGER },
      image_height: { type: DataTypes.INTEGER },
      image_bytes: { type: DataTypes.INTEGER },
      sample_rate: { type: DataTypes.REAL },
      captured_at: { type: DataTypes.DATE },
    },
    { tableName: 'captures', createdAt: 'created_at', updatedAt: false }
  );

  const CaptureChannel = define(
    'CaptureChannel',
    {
      id,
      capture_id: { type: DataTypes.INTEGER, allowNull: false },
      channel_index: { type: DataTypes.INTEGER, allowNull: false },
      label: { type: DataTypes.TEXT },
      signal_type: { type: DataTypes.TEXT },
      patch_module_id: { type: DataTypes.INTEGER },
      component_id: { type: DataTypes.INTEGER },
      component_name: { type: DataTypes.TEXT },
      module_label: { type: DataTypes.TEXT },
      source_description: { type: DataTypes.TEXT },
      note_name: { type: DataTypes.TEXT },
      midi_note: { type: DataTypes.INTEGER },
      cents: { type: DataTypes.REAL },
      frequency: { type: DataTypes.REAL },
      confidence: { type: DataTypes.REAL },
      voltage: { type: DataTypes.REAL },
      vertical_range: { type: DataTypes.REAL },
      vertical_offset: { type: DataTypes.REAL },
      time_base: { type: DataTypes.REAL },
    },
    { tableName: 'capture_channels', createdAt: 'created_at', updatedAt: false }
  );

  // A short video of the panes, attached to a module (migration 040). The
  // patch it was recorded during is kept softly — id nulled when the patch
  // goes, name kept as text — because the clip belongs to the module.
  const ScopeClip = define(
    'ScopeClip',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      patch_id: { type: DataTypes.INTEGER },
      patch_name: { type: DataTypes.TEXT },
      device_token_id: { type: DataTypes.INTEGER },
      device_name: { type: DataTypes.TEXT },
      audio_device_id: { type: DataTypes.TEXT },
      audio_device_name: { type: DataTypes.TEXT },
      title: { type: DataTypes.TEXT },
      caption: { type: DataTypes.TEXT },
      video_hash: { type: DataTypes.TEXT },
      video_format: { type: DataTypes.TEXT },
      video_width: { type: DataTypes.INTEGER },
      video_height: { type: DataTypes.INTEGER },
      video_bytes: { type: DataTypes.INTEGER },
      duration_seconds: { type: DataTypes.REAL },
      sample_rate: { type: DataTypes.REAL },
      captured_at: { type: DataTypes.DATE },
    },
    { tableName: 'scope_clips', createdAt: 'created_at', updatedAt: false }
  );

  const ScopeClipChannel = define(
    'ScopeClipChannel',
    {
      id,
      clip_id: { type: DataTypes.INTEGER, allowNull: false },
      channel_index: { type: DataTypes.INTEGER, allowNull: false },
      label: { type: DataTypes.TEXT },
      signal_type: { type: DataTypes.TEXT },
      patch_module_id: { type: DataTypes.INTEGER },
      component_id: { type: DataTypes.INTEGER },
      component_name: { type: DataTypes.TEXT },
      module_label: { type: DataTypes.TEXT },
      source_description: { type: DataTypes.TEXT },
    },
    { tableName: 'scope_clip_channels', createdAt: 'created_at', updatedAt: false }
  );

  return { PatchScopeChannel, Capture, CaptureChannel, ScopeClip, ScopeClipChannel };
}
