// A module and every hardware fact analysis or a person records about it.
//
// One of the domain groups composed by db/models.js, which is the only thing
// that calls this. `define` is that file's sequelize.define wrapper; the
// models are returned rather than exported, so every group is defined against
// one sequelize instance.

import { DataTypes } from 'sequelize';
import { id } from './columns.js';

export function defineModulesModels(define) {
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

  // A switched mult group: which section a bidirectional jack joins while a
  // control sits at one position (Doepfer A-182-1's per-jack bus toggles).
  // A jack with no rows here takes its unconditional group_label instead.
  const ComponentMultGroup = define(
    'ComponentMultGroup',
    {
      id,
      module_id: { type: DataTypes.INTEGER, allowNull: false },
      component_id: { type: DataTypes.INTEGER, allowNull: false },
      // NULL is a real answer: in this position the jack is on no bus.
      group_label: { type: DataTypes.TEXT },
      condition_component_id: { type: DataTypes.INTEGER },
      condition_value: { type: DataTypes.TEXT },
      description: { type: DataTypes.TEXT },
    },
    { tableName: 'component_mult_groups', createdAt: 'created_at', updatedAt: false }
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

  return { Module, Manual, ManualDocument, ModuleVideo, ModulePanel, ModulePanelComponent, ModuleComponent, ComponentNormalization, ModuleExpander, ModuleBridge, ModuleBridgeJack, ModulePathHint, ComponentPair, ComponentSwitch, ComponentSwitchStep, ComponentMultGroup, ComponentRoute, ComponentValue, ModuleParameter, ModuleParameterOption };
}
