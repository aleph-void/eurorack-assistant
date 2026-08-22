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

  // A waveform image plus the tuner reading taken with it.
  const Capture = define(
    'Capture',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      patch_id: { type: DataTypes.INTEGER },
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

  return { PatchScopeChannel, Capture, CaptureChannel };
}
