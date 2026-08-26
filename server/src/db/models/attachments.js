// What you attach to a record that is not a fact about the hardware: a
// recording of what it sounds like, and an address on the internet where the
// rest of the story is.
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function defineAttachmentsModels(define) {
  // A recording of a module or a patch (migration 043): uploaded, recorded in
  // the browser, or asked of the linked oscilloscope's audio interface. The
  // bytes are content-addressed; everything measured off them is stored
  // beside the row so a question can be answered without decoding the file
  // again.
  const AudioRecording = define(
    'AudioRecording',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      // Exactly one of these (the CHECK in migration 043): a bench take is a
      // module's, a take made on a patch page is the patch's.
      module_id: { type: DataTypes.INTEGER },
      patch_id: { type: DataTypes.INTEGER },
      patch_name: { type: DataTypes.TEXT },
      source: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'upload' },
      device_token_id: { type: DataTypes.INTEGER },
      device_name: { type: DataTypes.TEXT },
      audio_device_id: { type: DataTypes.TEXT },
      audio_device_name: { type: DataTypes.TEXT },
      title: { type: DataTypes.TEXT },
      caption: { type: DataTypes.TEXT },
      original_name: { type: DataTypes.TEXT },
      audio_hash: { type: DataTypes.TEXT },
      audio_format: { type: DataTypes.TEXT },
      audio_bytes: { type: DataTypes.INTEGER },
      duration_seconds: { type: DataTypes.REAL },
      sample_rate: { type: DataTypes.REAL },
      channel_count: { type: DataTypes.INTEGER },
      peak_dbfs: { type: DataTypes.REAL },
      rms_dbfs: { type: DataTypes.REAL },
      waveform_hash: { type: DataTypes.TEXT },
      recorded_at: { type: DataTypes.DATE },
    },
    { tableName: 'audio_recordings', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // A link on exactly one of a module, patch, rack or system (migration 044).
  const ResourceLink = define(
    'ResourceLink',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      module_id: { type: DataTypes.INTEGER },
      patch_id: { type: DataTypes.INTEGER },
      rack_id: { type: DataTypes.INTEGER },
      system_id: { type: DataTypes.INTEGER },
      url: { type: DataTypes.TEXT, allowNull: false },
      title: { type: DataTypes.TEXT },
      description: { type: DataTypes.TEXT },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'resource_links', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  return { AudioRecording, ResourceLink };
}
