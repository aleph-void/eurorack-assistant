// Sequelize models for the schema in migrations/. The migrations remain
// the source of truth for the schema (models are never sync()ed); attribute
// and column names are kept in snake_case so model JSON matches the API's
// existing response shapes.

import { DataTypes } from 'sequelize';

const id = { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true };

export function defineModels(sequelize) {
  const define = (name, attributes, options) =>
    sequelize.define(name, attributes, { freezeTableName: true, ...options });

  const User = define(
    'User',
    {
      id,
      username: { type: DataTypes.TEXT, allowNull: false, unique: true },
      password_hash: { type: DataTypes.TEXT, allowNull: false },
      is_admin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      must_change_password: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // Token allowance per budget window (migration 021). NULL takes the
      // configured default; 0 lifts the ceiling for this user alone.
      token_budget: { type: DataTypes.BIGINT },
      // The user's own LLM provider/model choice (migration 023). Blank falls
      // back to the admin-configured default. llm_models is a JSON object of
      // per-job-type model overrides ({"extract_manual": "claude-haiku-4-5"}).
      llm_provider: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      llm_model: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      llm_models: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
    },
    { tableName: 'users', createdAt: 'created_at', updatedAt: false }
  );

  // One user's authorization of one LLM provider (migration 023).
  // `credentials` is encrypted JSON — services/llmAccounts.js holds the key
  // and is the only reader.
  const UserLlmAccount = define(
    'UserLlmAccount',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      provider: { type: DataTypes.TEXT, allowNull: false },
      kind: { type: DataTypes.TEXT, allowNull: false },
      credentials: { type: DataTypes.TEXT, allowNull: false },
      expires_at: { type: DataTypes.DATE },
      paused_until: { type: DataTypes.DATE },
      paused_reason: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    },
    { tableName: 'user_llm_accounts', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  const Session = define(
    'Session',
    {
      id,
      token: { type: DataTypes.TEXT, allowNull: false, unique: true },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
    },
    { tableName: 'sessions', createdAt: 'created_at', updatedAt: false }
  );

  const AppConfig = define(
    'AppConfig',
    {
      key: { type: DataTypes.TEXT, primaryKey: true },
      value: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'app_config', timestamps: false }
  );

  const Module = define(
    'Module',
    {
      id,
      manufacturer: { type: DataTypes.TEXT, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      manual_status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      analysis_status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      // Progress of the front-panel picture: found/drawn or not (migration
      // 016). Independent of the analysis, which it runs after.
      panel_status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      // Whether the module's MENU has been read out of its documents
      // (migration 037). 'complete' as soon as the pass has run, whether or
      // not it found anything: most modules keep nothing in a menu, and
      // "found none" has to be distinguishable from "never looked" or the
      // fill-the-blanks sweep asks about every module in the rack forever.
      parameters_status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      // Panel width in HP, where the import stated it or the panel job worked
      // it out (migration 017). Null until something knows it.
      hp: { type: DataTypes.REAL },
      summary: { type: DataTypes.TEXT },
    },
    { tableName: 'modules', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  const Manual = define(
    'Manual',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      user_id: { type: DataTypes.INTEGER },
      hash: { type: DataTypes.TEXT, allowNull: false },
      // 'manual' marks the manual proper; user uploads carry a distinct
      // user-chosen label.
      name: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'manual' },
      original_name: { type: DataTypes.TEXT },
      source: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'found' },
      // Submitted alongside the manual when the module is (re)analyzed
      // (migration 024). Vendor pages are marked automatically when saved.
      analysis_scope: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: 'manuals', createdAt: 'created_at', updatedAt: false }
  );

  // A manual's text, extracted from the PDF and stored as markdown so it can
  // be searched and read (migration 018). One row per Manual row, and it
  // inherits that row's visibility: user_id NULL is the shared manual's text,
  // seen by everyone; a user_id is an upload's text, seen by its owner alone.
  const ManualDocument = define(
    'ManualDocument',
    {
      id,
      manual_id: { type: DataTypes.INTEGER, allowNull: false },
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      user_id: { type: DataTypes.INTEGER },
      hash: { type: DataTypes.TEXT, allowNull: false },
      title: { type: DataTypes.TEXT },
      content: { type: DataTypes.TEXT, allowNull: false },
      pages: { type: DataTypes.INTEGER },
      chars: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      source: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pdftotext' },
    },
    { tableName: 'manual_documents', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // A YouTube video a user attached to a module (migration 026). The video
  // file itself is transient — downloaded, analyzed, deleted — so the row
  // holds what survives: the link, the video's metadata and the techniques
  // summary the analysis wrote. Owned by (and visible to) the attaching user.
  const ModuleVideo = define(
    'ModuleVideo',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      // The 11-character YouTube id; `url` is rebuilt from it (services/
      // videos.js), so yt-dlp is only ever pointed at a real YouTube video.
      video_id: { type: DataTypes.TEXT, allowNull: false },
      url: { type: DataTypes.TEXT, allowNull: false },
      title: { type: DataTypes.TEXT },
      channel: { type: DataTypes.TEXT },
      duration_seconds: { type: DataTypes.INTEGER },
      // pending → downloading → downloaded → analyzing → complete / failed
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      summary: { type: DataTypes.TEXT },
      error: { type: DataTypes.TEXT },
    },
    { tableName: 'module_videos', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // The module's front plate: either a real image found on the web or the
  // logical panel the server draws from the layout the LLM read out of the
  // manual (migration 016). The file itself is content-addressed in
  // PANELS_DIR, like manuals and captures.
  const ModulePanel = define(
    'ModulePanel',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      // 'image' (found on the web), 'generated' (drawn from the manual), or
      // 'upload' (a picture a user supplied; migration 017).
      source: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'generated' },
      source_url: { type: DataTypes.TEXT },
      image_hash: { type: DataTypes.TEXT, allowNull: false },
      image_ext: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'svg' },
      width: { type: DataTypes.INTEGER, allowNull: false },
      height: { type: DataTypes.INTEGER, allowNull: false },
      // The front plate's box within the image, as fractions of the whole.
      crop_x: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
      crop_y: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
      crop_w: { type: DataTypes.REAL, allowNull: false, defaultValue: 1 },
      crop_h: { type: DataTypes.REAL, allowNull: false, defaultValue: 1 },
      hp: { type: DataTypes.REAL },
      description: { type: DataTypes.TEXT },
      // The file has already been cut down to the front plate (migration
      // 031), so there is nothing left for Trim to take off.
      trimmed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: 'module_panels', createdAt: 'created_at', updatedAt: false }
  );

  // Where one analyzed component sits on the panel image: x/y/w/h are
  // fractions of the whole image.
  const ModulePanelComponent = define(
    'ModulePanelComponent',
    {
      id,
      panel_id: { type: DataTypes.INTEGER, allowNull: false },
      component_id: { type: DataTypes.INTEGER },
      name: { type: DataTypes.TEXT, allowNull: false },
      shape: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'other' },
      x: { type: DataTypes.REAL, allowNull: false },
      y: { type: DataTypes.REAL, allowNull: false },
      w: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
      h: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'module_panel_components', timestamps: false }
  );

  // A user's racks; modules are mapped into racks, not directly onto users.
  // A collection of racks patched together as one instrument (migration
  // 028): the studio, or the live case plus the skiff that travels with it.
  const System = define(
    'System',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
      // The size of the floor plan the racks are arranged on (migration
      // 029), in the units the rack coordinates use: HP across, U down.
      floor_width: { type: DataTypes.REAL, allowNull: false, defaultValue: 140 },
      floor_height: { type: DataTypes.REAL, allowNull: false, defaultValue: 9 },
    },
    { tableName: 'systems', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  const Rack = define(
    'Rack',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      // Which system this rack is part of, and where it stands on that
      // system's floor plan (migration 028). Coordinates are HP across and
      // rack-units down; position is the tie-breaking order.
      system_id: { type: DataTypes.INTEGER },
      system_x: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
      system_y: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
      system_position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'racks', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  const RackModule = define(
    'RackModule',
    {
      rack_id: { type: DataTypes.INTEGER, primaryKey: true },
      module_id: { type: DataTypes.INTEGER, primaryKey: true },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    { tableName: 'rack_modules', createdAt: 'created_at', updatedAt: false }
  );

  const RackRow = define(
    'RackRow',
    {
      id,
      rack_id: { type: DataTypes.INTEGER, allowNull: false },
      unit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
      hp: { type: DataTypes.REAL, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'rack_rows', createdAt: 'created_at', updatedAt: false }
  );

  const RackRowModule = define(
    'RackRowModule',
    {
      id,
      row_id: { type: DataTypes.INTEGER, allowNull: false },
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'rack_row_modules', createdAt: 'created_at', updatedAt: false }
  );

  const ModuleComponent = define(
    'ModuleComponent',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      type: { type: DataTypes.TEXT, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
      voltage_min: { type: DataTypes.REAL },
      voltage_max: { type: DataTypes.REAL },
      polarity: { type: DataTypes.TEXT },
      // Which mult section a bidirectional jack belongs to (see migration
      // 005); null on other component types and on single-group mults.
      group_label: { type: DataTypes.TEXT },
      // The physical connector when it is not an ordinary 3.5mm eurorack
      // patch point: 'midi_din', 'usb', 'spdif', 'microphone', ... (see
      // migration 009). Cables only join ports of the same kind.
      port_kind: { type: DataTypes.TEXT },
    },
    { tableName: 'module_components', createdAt: 'created_at', updatedAt: false }
  );

  // A normalled connection extracted from the manual: the target component
  // (an input jack) receives the source's signal while nothing is patched
  // into it. kind 'input' = normalled to another input jack, 'output' = to an
  // output jack's signal, 'internal' = to an internal signal with no panel
  // component (named by source_label).
  const ComponentNormalization = define(
    'ComponentNormalization',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      target_component_id: { type: DataTypes.INTEGER, allowNull: false },
      source_component_id: { type: DataTypes.INTEGER },
      source_label: { type: DataTypes.TEXT },
      kind: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'internal' },
      // Only live while this control sits at this value (migration 008) —
      // switch-selected normals like Atlantix's PWM Source. Rows sharing an
      // alt_group are alternatives: at most one at a time, so they render as
      // a selection rather than as signals summing.
      condition_component_id: { type: DataTypes.INTEGER },
      condition_value: { type: DataTypes.TEXT },
      alt_group: { type: DataTypes.TEXT },
      // Which jack's cable breaks this normal, and how (migration 011). NULL
      // break_component_id means the target itself; break_on is 'cable_in'
      // (a cable arriving) or 'cable_out' (a cable leaving, as on Vhikk X's
      // L output normalled to its R output).
      break_component_id: { type: DataTypes.INTEGER },
      break_on: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'cable_in' },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'component_normalizations', createdAt: 'created_at', updatedAt: false }
  );

  // A host module and one of its expanders: two panels joined by a ribbon
  // cable that behave as one instrument, so routes and normalizations
  // declared on the host may reference the expander's jacks.
  const ModuleExpander = define(
    'ModuleExpander',
    {
      id,
      host_module_id: { type: DataTypes.INTEGER, allowNull: false },
      expander_module_id: { type: DataTypes.INTEGER, allowNull: false },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'module_expanders', createdAt: 'created_at', updatedAt: false }
  );

  // Two panels of ONE product joined by a link cable rather than by patch
  // cables (Omnitone 7Path's ethernet pair, migration 033). Neither side is
  // the host: jack N of one panel is wired to jack N of the other, and those
  // jacks are bidirectional — the end a cable is patched into is the input,
  // and the matching jack on the opposite panel is the output. Both columns
  // may name the SAME module: a dual imported once with quantity 2 pairs its
  // two instances up.
  const ModuleBridge = define(
    'ModuleBridge',
    {
      id,
      a_module_id: { type: DataTypes.INTEGER, allowNull: false },
      b_module_id: { type: DataTypes.INTEGER, allowNull: false },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'module_bridges', createdAt: 'created_at', updatedAt: false }
  );

  // Which jack on one panel of a dual is the same wire as which jack on the
  // other. Only needed when the two panels label the same wire differently: a
  // pair with no rows pairs its jacks by name.
  const ModuleBridgeJack = define(
    'ModuleBridgeJack',
    {
      id,
      bridge_id: { type: DataTypes.INTEGER, allowNull: false },
      a_component_id: { type: DataTypes.INTEGER, allowNull: false },
      b_component_id: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'module_bridge_jacks', timestamps: false }
  );

  // Something a manual states that could not be stored as a row yet: a signal
  // path running to another panel, or the name of an expander whose module
  // record does not exist or is not linked. Kept by name and materialized
  // once resolution becomes possible (see migration 012).
  const ModulePathHint = define(
    'ModulePathHint',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      kind: { type: DataTypes.TEXT, allowNull: false },
      payload: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'module_path_hints', createdAt: 'created_at', updatedAt: false }
  );

  // Two jacks that are the two halves of one signal (a stereo L/R pair).
  const ComponentPair = define(
    'ComponentPair',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      a_component_id: { type: DataTypes.INTEGER, allowNull: false },
      b_component_id: { type: DataTypes.INTEGER, allowNull: false },
      kind: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'stereo' },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'component_pairs', createdAt: 'created_at', updatedAt: false }
  );

  // A routing switch section: the common jack connects to exactly one of the
  // step jacks at a time. Direction (1→N, N→1, or either on bidirectional
  // switches) is decided by how a patch cables the jacks.
  const ComponentSwitch = define(
    'ComponentSwitch',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT },
      common_component_id: { type: DataTypes.INTEGER, allowNull: false },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'component_switches', createdAt: 'created_at', updatedAt: false }
  );

  const ComponentSwitchStep = define(
    'ComponentSwitchStep',
    {
      switch_id: { type: DataTypes.INTEGER, primaryKey: true },
      component_id: { type: DataTypes.INTEGER, primaryKey: true },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'component_switch_steps', timestamps: false }
  );

  // An internal signal path: the input jack's signal (possibly processed)
  // appears at the output jack. Output jacks no route feeds are signal
  // generators. Extracted from the manual; users may add/remove rows.
  const ComponentRoute = define(
    'ComponentRoute',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      input_component_id: { type: DataTypes.INTEGER, allowNull: false },
      output_component_id: { type: DataTypes.INTEGER, allowNull: false },
      // Only live while this control sits at this value; rows sharing an
      // alt_group are mutually exclusive (migration 008) — Levit8's MIX
      // switches turning OUT 4 from a pass-through into a 4-channel mix.
      condition_component_id: { type: DataTypes.INTEGER },
      condition_value: { type: DataTypes.TEXT },
      alt_group: { type: DataTypes.TEXT },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'component_routes', createdAt: 'created_at', updatedAt: false }
  );

  // A valid value for a component: the 'min'/'max' ends of a continuous
  // range, or one 'enum' row per discrete position. Extracted from the manual
  // during analysis; users may add/edit/delete rows.
  const ComponentValue = define(
    'ComponentValue',
    {
      id,
      component_id: { type: DataTypes.INTEGER, allowNull: false },
      type: { type: DataTypes.TEXT, allowNull: false },
      value: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'component_values', createdAt: 'created_at', updatedAt: false }
  );

  // A menu parameter: a setting the module holds behind an encoder and a
  // display rather than under a control of its own. component_id is the panel
  // thing it configures — usually an output jack, whose clock division,
  // waveform and level are all parameters of it — and is null for a parameter
  // of the whole module. Extracted from the manual by the find_parameters
  // job; users may add/edit/delete rows.
  const ModuleParameter = define(
    'ModuleParameter',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      component_id: { type: DataTypes.INTEGER },
      // The component's name, kept beside its id: a re-analysis destroys and
      // recreates every module_components row, and this is what the parameter
      // is put back onto the new one by.
      component_name: { type: DataTypes.TEXT },
      name: { type: DataTypes.TEXT, allowNull: false },
      group_label: { type: DataTypes.TEXT },
      value_type: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'enum' },
      unit: { type: DataTypes.TEXT },
      value_min: { type: DataTypes.TEXT },
      value_max: { type: DataTypes.TEXT },
      default_value: { type: DataTypes.TEXT },
      description: { type: DataTypes.TEXT },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'module_parameters', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // One selectable setting of an 'enum' parameter, in menu order.
  const ModuleParameterOption = define(
    'ModuleParameterOption',
    {
      id,
      parameter_id: { type: DataTypes.INTEGER, allowNull: false },
      value: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'module_parameter_options', createdAt: 'created_at', updatedAt: false }
  );

  // A user's patch: cables + settings against a snapshot of a rack. rack_id
  // and the module/component ids on the snapshot tables are soft references
  // (no FK): the patch keeps rendering from its denormalized name columns
  // after modules move racks, get re-analyzed or get deleted.
  const Patch = define(
    'Patch',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      rack_id: { type: DataTypes.INTEGER },
      rack_name: { type: DataTypes.TEXT, allowNull: false },
      // Set instead of rack_id when the patch was built from a whole system
      // (migration 028), and soft like it: the patch outlives the system.
      system_id: { type: DataTypes.INTEGER },
      system_name: { type: DataTypes.TEXT },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'patches', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // One row per module instance in the rack at patch creation (quantity 2 →
  // instance 1 and instance 2).
  const PatchModule = define(
    'PatchModule',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      module_id: { type: DataTypes.INTEGER },
      manufacturer: { type: DataTypes.TEXT, allowNull: false },
      module_name: { type: DataTypes.TEXT, allowNull: false },
      instance: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      // Which rack this copy was snapshotted from (migration 028), so a
      // system patch spanning several racks can group its instances and
      // match each to the right rack's physical rows. Soft, like module_id.
      rack_id: { type: DataTypes.INTEGER },
      rack_name: { type: DataTypes.TEXT },
      // What this instance does in this patch ("snare voice"), and which
      // named bus/layer it belongs to (soft reference into patch_groups).
      label: { type: DataTypes.TEXT },
      group_id: { type: DataTypes.INTEGER },
      // Off-rack gear (a DAW, a MIDI interface, the PA) rather than a module.
      // Both external gear and modules the rack does not hold declare their
      // connection points in patch_module_ports.
      external: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    { tableName: 'patch_modules', createdAt: 'created_at', updatedAt: false }
  );

  // The physical arrangement the patch was built from (migration 030): the
  // rows of every rack it snapshotted, copied INTO the patch so the diagram
  // keeps drawing the studio as it stood, however the racks are reorganised
  // afterwards. Soft references, like the rest of a patch snapshot.
  const PatchRackRow = define(
    'PatchRackRow',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      rack_id: { type: DataTypes.INTEGER },
      rack_name: { type: DataTypes.TEXT },
      rack_position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // Where the rack stood on the system's floor plan when the patch was
      // made: x in HP, y in rack units (migration 034).
      rack_x: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
      rack_y: { type: DataTypes.REAL, allowNull: false, defaultValue: 0 },
      unit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
      hp: { type: DataTypes.REAL, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'patch_rack_rows', createdAt: 'created_at', updatedAt: false }
  );

  // One module standing in one of those rows, in the order it stands.
  const PatchRackRowModule = define(
    'PatchRackRowModule',
    {
      id,
      row_id: { type: DataTypes.INTEGER, allowNull: false },
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'patch_rack_row_modules', createdAt: 'created_at', updatedAt: false }
  );

  // A named bus or layer within a patch ("Rhythm", "Granular bus").
  const PatchGroup = define(
    'PatchGroup',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'patch_groups', createdAt: 'created_at', updatedAt: false }
  );

  // A connection point declared inside the patch, for an instance with no
  // analyzed component list behind it: external gear, or a module the rack
  // does not hold. Cables address these exactly like components — the
  // patch_module at each end says which of the two namespaces the id is in.
  const PatchModulePort = define(
    'PatchModulePort',
    {
      id,
      patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      type: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'input_jack' },
      port_kind: { type: DataTypes.TEXT },
      description: { type: DataTypes.TEXT },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'patch_module_ports', createdAt: 'created_at', updatedAt: false }
  );

  // Two instances wired together without patch cables: kind 'expander' (host
  // + expander panel, one instrument) or 'bridge' (a pair like Omnitone
  // 7Path carrying signals between two points over one non-patch link).
  const PatchModuleLink = define(
    'PatchModuleLink',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      a_patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      b_patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      kind: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'expander' },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'patch_module_links', createdAt: 'created_at', updatedAt: false }
  );

  // Which jack on side A of a bridge carries the same signal as which jack
  // on side B.
  const PatchModuleLinkJack = define(
    'PatchModuleLinkJack',
    {
      id,
      link_id: { type: DataTypes.INTEGER, allowNull: false },
      a_component_id: { type: DataTypes.INTEGER },
      a_component_name: { type: DataTypes.TEXT, allowNull: false },
      b_component_id: { type: DataTypes.INTEGER },
      b_component_name: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'patch_module_link_jacks', createdAt: 'created_at', updatedAt: false }
  );

  const PatchCable = define(
    'PatchCable',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      from_patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      from_component_id: { type: DataTypes.INTEGER },
      from_component_name: { type: DataTypes.TEXT, allowNull: false },
      to_patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      to_component_id: { type: DataTypes.INTEGER },
      to_component_name: { type: DataTypes.TEXT, allowNull: false },
      note: { type: DataTypes.TEXT },
      // Provisional ("add the distortion layer later"), one of several
      // alternatives (same alt_group), or physically stacked onto the source
      // jack with a stackcable / passive mult.
      optional: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      stacked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      alt_group: { type: DataTypes.TEXT },
    },
    { tableName: 'patch_cables', createdAt: 'created_at', updatedAt: false }
  );

  const PatchSetting = define(
    'PatchSetting',
    {
      id,
      patch_id: { type: DataTypes.INTEGER, allowNull: false },
      patch_module_id: { type: DataTypes.INTEGER, allowNull: false },
      component_id: { type: DataTypes.INTEGER },
      // Null on a setting of a module-wide menu parameter, which sits on no
      // component at all.
      component_name: { type: DataTypes.TEXT },
      // Soft reference to a module_parameters row, with its name snapshotted
      // beside it: one component may carry a dozen of these (an output jack's
      // division, wave and level) where a knob carries exactly one value.
      parameter_id: { type: DataTypes.INTEGER },
      parameter_name: { type: DataTypes.TEXT },
      value: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'patch_settings', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  const Note = define(
    'Note',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      title: { type: DataTypes.TEXT },
      body: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'notes', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  const NoteModule = define(
    'NoteModule',
    {
      note_id: { type: DataTypes.INTEGER, primaryKey: true },
      module_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'note_modules', timestamps: false }
  );

  const NoteComponent = define(
    'NoteComponent',
    {
      note_id: { type: DataTypes.INTEGER, primaryKey: true },
      component_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'note_components', timestamps: false }
  );

  const NotePatch = define(
    'NotePatch',
    {
      note_id: { type: DataTypes.INTEGER, primaryKey: true },
      patch_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'note_patches', timestamps: false }
  );

  const Question = define(
    'Question',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      prompt: { type: DataTypes.TEXT, allowNull: false },
      answer: { type: DataTypes.TEXT },
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      error: { type: DataTypes.TEXT },
      answered_at: { type: DataTypes.DATE },
    },
    { tableName: 'questions', createdAt: 'created_at', updatedAt: false }
  );

  const QuestionModule = define(
    'QuestionModule',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      module_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_modules', timestamps: false }
  );

  const QuestionComponent = define(
    'QuestionComponent',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      component_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_components', timestamps: false }
  );

  const QuestionManual = define(
    'QuestionManual',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      manual_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_manuals', timestamps: false }
  );

  const QuestionAnswer = define(
    'QuestionAnswer',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      source_question_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_answers', timestamps: false }
  );

  const QuestionNote = define(
    'QuestionNote',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      note_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_notes', timestamps: false }
  );

  const QuestionCapture = define(
    'QuestionCapture',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      capture_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_captures', timestamps: false }
  );

  // A patch a question is about: it brings the patch's modules into scope and
  // rides along as a document describing the whole patch.
  const QuestionPatch = define(
    'QuestionPatch',
    {
      question_id: { type: DataTypes.INTEGER, primaryKey: true },
      patch_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'question_patches', timestamps: false }
  );

  // An application allowed to obtain a device token. Public clients only —
  // see migration 013.
  const OAuthClient = define(
    'OAuthClient',
    {
      id,
      client_id: { type: DataTypes.TEXT, allowNull: false, unique: true },
      name: { type: DataTypes.TEXT, allowNull: false },
      scopes: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'oscilloscope' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'oauth_clients', createdAt: 'created_at', updatedAt: false }
  );

  // One in-flight device authorization grant (RFC 8628).
  const DeviceAuthorization = define(
    'DeviceAuthorization',
    {
      id,
      client_id: { type: DataTypes.TEXT, allowNull: false },
      device_code_hash: { type: DataTypes.TEXT, allowNull: false, unique: true },
      user_code: { type: DataTypes.TEXT, allowNull: false, unique: true },
      scopes: { type: DataTypes.TEXT, allowNull: false },
      device_name: { type: DataTypes.TEXT },
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      user_id: { type: DataTypes.INTEGER },
      interval_seconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
      last_polled_at: { type: DataTypes.DATE },
      expires_at: { type: DataTypes.DATE, allowNull: false },
    },
    { tableName: 'device_authorizations', createdAt: 'created_at', updatedAt: false }
  );

  // An issued device credential; token values are stored hashed.
  const DeviceToken = define(
    'DeviceToken',
    {
      id,
      user_id: { type: DataTypes.INTEGER, allowNull: false },
      client_id: { type: DataTypes.TEXT, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      access_token_hash: { type: DataTypes.TEXT, allowNull: false, unique: true },
      refresh_token_hash: { type: DataTypes.TEXT, unique: true },
      scopes: { type: DataTypes.TEXT, allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      revoked_at: { type: DataTypes.DATE },
      last_seen_at: { type: DataTypes.DATE },
    },
    { tableName: 'device_tokens', createdAt: 'created_at', updatedAt: false }
  );

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

  // One record shown to one other user, or to everyone when user_id is NULL
  // (migration 019). Read access only: an owner shares what they made, and
  // stays the only one who can change it. resource_id is a soft reference into
  // whichever table resource_type names.
  const Share = define(
    'Share',
    {
      id,
      resource_type: { type: DataTypes.TEXT, allowNull: false },
      resource_id: { type: DataTypes.INTEGER, allowNull: false },
      owner_id: { type: DataTypes.INTEGER, allowNull: false },
      user_id: { type: DataTypes.INTEGER },
    },
    { tableName: 'shares', createdAt: 'created_at', updatedAt: false }
  );

  // One model run and what it spent (migration 021). job_id is a soft
  // reference: jobs are deleted, the spending stays.
  const LlmUsage = define(
    'LlmUsage',
    {
      id,
      user_id: { type: DataTypes.INTEGER },
      job_id: { type: DataTypes.INTEGER },
      job_type: { type: DataTypes.TEXT },
      provider: { type: DataTypes.TEXT, allowNull: false },
      model: { type: DataTypes.TEXT },
      input_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cache_read_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cache_write_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      output_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      total_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cost_usd: { type: DataTypes.DOUBLE },
    },
    { tableName: 'llm_usage', createdAt: 'created_at', updatedAt: false }
  );

  const Job = define(
    'Job',
    {
      id,
      type: { type: DataTypes.TEXT, allowNull: false },
      user_id: { type: DataTypes.INTEGER },
      module_id: { type: DataTypes.INTEGER },
      question_id: { type: DataTypes.INTEGER },
      payload: { type: DataTypes.TEXT },
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      error: { type: DataTypes.TEXT },
      // Lease held by the worker that claimed the job: heartbeat_at is
      // refreshed while it runs, so a job orphaned by a killed process can be
      // recognised and requeued (see reclaimStaleJobs in jobs/worker.js).
      started_at: { type: DataTypes.DATE },
      heartbeat_at: { type: DataTypes.DATE },
      worker_id: { type: DataTypes.TEXT },
    },
    { tableName: 'jobs', createdAt: 'created_at', updatedAt: 'updated_at' }
  );

  // Associations. pg-mem (the test database) cannot parse the parenthesized
  // joins Sequelize emits for belongsToMany eager loads, so link tables are
  // modeled explicitly and traversed with hasMany/belongsTo include chains,
  // which produce flat joins.
  Session.belongsTo(User, { foreignKey: 'user_id' });

  UserLlmAccount.belongsTo(User, { foreignKey: 'user_id' });
  User.hasMany(UserLlmAccount, { foreignKey: 'user_id' });

  Rack.belongsTo(User, { foreignKey: 'user_id' });
  User.hasMany(Rack, { foreignKey: 'user_id' });

  Rack.hasMany(RackModule, { foreignKey: 'rack_id' });
  RackModule.belongsTo(Rack, { foreignKey: 'rack_id' });
  Module.hasMany(RackModule, { foreignKey: 'module_id' });
  RackModule.belongsTo(Module, { foreignKey: 'module_id' });
  Rack.hasMany(RackRow, { foreignKey: 'rack_id' });
  RackRow.belongsTo(Rack, { foreignKey: 'rack_id' });
  RackRow.hasMany(RackRowModule, { foreignKey: 'row_id' });
  RackRowModule.belongsTo(RackRow, { foreignKey: 'row_id' });
  Module.hasMany(RackRowModule, { foreignKey: 'module_id' });
  RackRowModule.belongsTo(Module, { foreignKey: 'module_id' });

  Module.hasMany(Manual, { foreignKey: 'module_id' });
  Manual.belongsTo(Module, { foreignKey: 'module_id' });

  Manual.hasOne(ManualDocument, { foreignKey: 'manual_id' });
  ManualDocument.belongsTo(Manual, { foreignKey: 'manual_id' });
  Module.hasMany(ManualDocument, { foreignKey: 'module_id' });
  ManualDocument.belongsTo(Module, { foreignKey: 'module_id' });

  Module.hasMany(ModuleVideo, { foreignKey: 'module_id' });
  ModuleVideo.belongsTo(Module, { foreignKey: 'module_id' });
  ModuleVideo.belongsTo(User, { foreignKey: 'user_id' });

  Module.hasMany(ModuleComponent, { foreignKey: 'module_id' });
  ModuleComponent.belongsTo(Module, { foreignKey: 'module_id' });

  Module.hasOne(ModulePanel, { foreignKey: 'module_id' });
  ModulePanel.belongsTo(Module, { foreignKey: 'module_id' });
  ModulePanel.hasMany(ModulePanelComponent, { foreignKey: 'panel_id' });
  ModulePanelComponent.belongsTo(ModulePanel, { foreignKey: 'panel_id' });
  ModulePanelComponent.belongsTo(ModuleComponent, { foreignKey: 'component_id' });

  Module.hasMany(ComponentNormalization, { foreignKey: 'module_id' });
  ComponentNormalization.belongsTo(Module, { foreignKey: 'module_id' });
  ComponentNormalization.belongsTo(ModuleComponent, {
    foreignKey: 'target_component_id',
    as: 'Target',
  });
  ComponentNormalization.belongsTo(ModuleComponent, {
    foreignKey: 'source_component_id',
    as: 'Source',
  });

  Module.hasMany(ComponentSwitch, { foreignKey: 'module_id' });
  ComponentSwitch.belongsTo(Module, { foreignKey: 'module_id' });
  ComponentSwitch.belongsTo(ModuleComponent, { foreignKey: 'common_component_id', as: 'Common' });
  ComponentSwitch.hasMany(ComponentSwitchStep, { foreignKey: 'switch_id' });
  ComponentSwitchStep.belongsTo(ComponentSwitch, { foreignKey: 'switch_id' });
  ComponentSwitchStep.belongsTo(ModuleComponent, { foreignKey: 'component_id' });

  ComponentNormalization.belongsTo(ModuleComponent, {
    foreignKey: 'condition_component_id',
    as: 'Condition',
  });
  ComponentNormalization.belongsTo(ModuleComponent, {
    foreignKey: 'break_component_id',
    as: 'Break',
  });

  Module.hasMany(ModulePathHint, { foreignKey: 'module_id' });
  ModulePathHint.belongsTo(Module, { foreignKey: 'module_id' });

  Module.hasMany(ModuleExpander, { foreignKey: 'host_module_id', as: 'Expanders' });
  ModuleExpander.belongsTo(Module, { foreignKey: 'host_module_id', as: 'Host' });
  ModuleExpander.belongsTo(Module, { foreignKey: 'expander_module_id', as: 'Expander' });

  ModuleBridge.belongsTo(Module, { foreignKey: 'a_module_id', as: 'PanelA' });
  ModuleBridge.belongsTo(Module, { foreignKey: 'b_module_id', as: 'PanelB' });
  ModuleBridge.hasMany(ModuleBridgeJack, { foreignKey: 'bridge_id' });
  ModuleBridgeJack.belongsTo(ModuleBridge, { foreignKey: 'bridge_id' });

  Module.hasMany(ComponentPair, { foreignKey: 'module_id' });
  ComponentPair.belongsTo(Module, { foreignKey: 'module_id' });
  ComponentPair.belongsTo(ModuleComponent, { foreignKey: 'a_component_id', as: 'A' });
  ComponentPair.belongsTo(ModuleComponent, { foreignKey: 'b_component_id', as: 'B' });

  Module.hasMany(ComponentRoute, { foreignKey: 'module_id' });
  ComponentRoute.belongsTo(Module, { foreignKey: 'module_id' });
  ComponentRoute.belongsTo(ModuleComponent, { foreignKey: 'input_component_id', as: 'Input' });
  ComponentRoute.belongsTo(ModuleComponent, { foreignKey: 'output_component_id', as: 'Output' });

  ModuleComponent.hasMany(ComponentValue, { foreignKey: 'component_id' });
  ComponentValue.belongsTo(ModuleComponent, { foreignKey: 'component_id' });

  Module.hasMany(ModuleParameter, { foreignKey: 'module_id' });
  ModuleParameter.belongsTo(Module, { foreignKey: 'module_id' });
  ModuleParameter.belongsTo(ModuleComponent, { foreignKey: 'component_id' });
  ModuleParameter.hasMany(ModuleParameterOption, { foreignKey: 'parameter_id' });
  ModuleParameterOption.belongsTo(ModuleParameter, { foreignKey: 'parameter_id' });

  System.belongsTo(User, { foreignKey: 'user_id' });
  User.hasMany(System, { foreignKey: 'user_id' });
  System.hasMany(Rack, { foreignKey: 'system_id' });
  Rack.belongsTo(System, { foreignKey: 'system_id' });

  Patch.belongsTo(User, { foreignKey: 'user_id' });
  Patch.hasMany(PatchModule, { foreignKey: 'patch_id' });
  PatchModule.belongsTo(Patch, { foreignKey: 'patch_id' });
  PatchModule.belongsTo(Module, { foreignKey: 'module_id' });
  Patch.hasMany(PatchCable, { foreignKey: 'patch_id' });
  PatchCable.belongsTo(Patch, { foreignKey: 'patch_id' });
  Patch.hasMany(PatchSetting, { foreignKey: 'patch_id' });
  PatchSetting.belongsTo(Patch, { foreignKey: 'patch_id' });
  Patch.hasMany(PatchGroup, { foreignKey: 'patch_id' });
  PatchGroup.belongsTo(Patch, { foreignKey: 'patch_id' });
  Patch.hasMany(PatchRackRow, { foreignKey: 'patch_id' });
  PatchRackRow.belongsTo(Patch, { foreignKey: 'patch_id' });
  PatchRackRow.hasMany(PatchRackRowModule, { foreignKey: 'row_id' });
  PatchRackRowModule.belongsTo(PatchRackRow, { foreignKey: 'row_id' });
  PatchModule.hasMany(PatchModulePort, { foreignKey: 'patch_module_id' });
  PatchModulePort.belongsTo(PatchModule, { foreignKey: 'patch_module_id' });
  Patch.hasMany(PatchModuleLink, { foreignKey: 'patch_id' });
  PatchModuleLink.belongsTo(Patch, { foreignKey: 'patch_id' });
  PatchModuleLink.belongsTo(PatchModule, { foreignKey: 'a_patch_module_id', as: 'A' });
  PatchModuleLink.belongsTo(PatchModule, { foreignKey: 'b_patch_module_id', as: 'B' });
  PatchModuleLink.hasMany(PatchModuleLinkJack, { foreignKey: 'link_id' });
  PatchModuleLinkJack.belongsTo(PatchModuleLink, { foreignKey: 'link_id' });

  Note.hasMany(NoteModule, { foreignKey: 'note_id' });
  NoteModule.belongsTo(Note, { foreignKey: 'note_id' });
  NoteModule.belongsTo(Module, { foreignKey: 'module_id' });

  Note.hasMany(NoteComponent, { foreignKey: 'note_id' });
  NoteComponent.belongsTo(Note, { foreignKey: 'note_id' });
  NoteComponent.belongsTo(ModuleComponent, { foreignKey: 'component_id' });

  Question.hasMany(QuestionModule, { foreignKey: 'question_id' });
  QuestionModule.belongsTo(Question, { foreignKey: 'question_id' });
  QuestionModule.belongsTo(Module, { foreignKey: 'module_id' });

  Question.hasMany(QuestionComponent, { foreignKey: 'question_id' });
  QuestionComponent.belongsTo(Question, { foreignKey: 'question_id' });
  QuestionComponent.belongsTo(ModuleComponent, { foreignKey: 'component_id' });

  Question.hasMany(QuestionManual, { foreignKey: 'question_id' });
  QuestionManual.belongsTo(Question, { foreignKey: 'question_id' });
  QuestionManual.belongsTo(Manual, { foreignKey: 'manual_id' });

  Question.hasMany(QuestionAnswer, { foreignKey: 'question_id' });
  QuestionAnswer.belongsTo(Question, { foreignKey: 'question_id' });
  QuestionAnswer.belongsTo(Question, { foreignKey: 'source_question_id', as: 'SourceQuestion' });

  Question.hasMany(QuestionNote, { foreignKey: 'question_id' });
  QuestionNote.belongsTo(Question, { foreignKey: 'question_id' });
  QuestionNote.belongsTo(Note, { foreignKey: 'note_id' });

  Note.hasMany(NotePatch, { foreignKey: 'note_id' });
  NotePatch.belongsTo(Note, { foreignKey: 'note_id' });
  NotePatch.belongsTo(Patch, { foreignKey: 'patch_id' });

  Question.hasMany(QuestionCapture, { foreignKey: 'question_id' });
  QuestionCapture.belongsTo(Question, { foreignKey: 'question_id' });
  QuestionCapture.belongsTo(Capture, { foreignKey: 'capture_id' });

  Question.hasMany(QuestionPatch, { foreignKey: 'question_id' });
  QuestionPatch.belongsTo(Question, { foreignKey: 'question_id' });
  QuestionPatch.belongsTo(Patch, { foreignKey: 'patch_id' });

  DeviceToken.belongsTo(User, { foreignKey: 'user_id' });
  User.hasMany(DeviceToken, { foreignKey: 'user_id' });
  DeviceAuthorization.belongsTo(User, { foreignKey: 'user_id' });

  Patch.hasMany(PatchScopeChannel, { foreignKey: 'patch_id' });
  PatchScopeChannel.belongsTo(Patch, { foreignKey: 'patch_id' });

  Capture.belongsTo(User, { foreignKey: 'user_id' });
  Capture.belongsTo(Patch, { foreignKey: 'patch_id' });
  Capture.belongsTo(Note, { foreignKey: 'note_id' });
  Capture.hasMany(CaptureChannel, { foreignKey: 'capture_id' });
  CaptureChannel.belongsTo(Capture, { foreignKey: 'capture_id' });

  Share.belongsTo(User, { foreignKey: 'owner_id', as: 'Owner' });
  Share.belongsTo(User, { foreignKey: 'user_id', as: 'Recipient' });

  LlmUsage.belongsTo(User, { foreignKey: 'user_id' });
  User.hasMany(LlmUsage, { foreignKey: 'user_id' });

  Job.belongsTo(User, { foreignKey: 'user_id' });
  Job.belongsTo(Module, { foreignKey: 'module_id' });
  Job.belongsTo(Question, { foreignKey: 'question_id' });

  return {
    User,
    Session,
    UserLlmAccount,
    AppConfig,
    Module,
    Manual,
    ManualDocument,
    ModuleVideo,
    System,
    Rack,
    RackModule,
    RackRow,
    RackRowModule,
    ModuleComponent,
    ModulePanel,
    ModulePanelComponent,
    ComponentNormalization,
    ComponentRoute,
    ComponentSwitch,
    ComponentSwitchStep,
    ComponentValue,
    ComponentPair,
    ModuleParameter,
    ModuleParameterOption,
    ModuleExpander,
    ModuleBridge,
    ModuleBridgeJack,
    ModulePathHint,
    Patch,
    PatchModule,
    PatchCable,
    PatchSetting,
    PatchGroup,
    PatchModulePort,
    PatchModuleLink,
    PatchModuleLinkJack,
    PatchRackRow,
    PatchRackRowModule,
    Note,
    NoteModule,
    NoteComponent,
    NotePatch,
    Question,
    QuestionModule,
    QuestionComponent,
    QuestionManual,
    QuestionAnswer,
    QuestionNote,
    QuestionCapture,
    QuestionPatch,
    OAuthClient,
    DeviceAuthorization,
    DeviceToken,
    PatchScopeChannel,
    Capture,
    CaptureChannel,
    Share,
    LlmUsage,
    Job,
  };
}
