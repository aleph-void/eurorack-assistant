// How the tables are joined.
//
// Split out of db/models.js: the shape of a table and the shape of the graph
// are two different things to read, and the graph is the half that has to be
// read whole.

// AppConfig and OAuthClient stand alone — a key/value table and the one
// registered device client — so neither appears below.
export function associate(m) {
  const {
    User,
    UserLlmAccount,
    Session,
    Module,
    Manual,
    ManualDocument,
    ModuleVideo,
    ModulePanel,
    ModulePanelComponent,
    System,
    Rack,
    RackModule,
    RackRow,
    RackRowModule,
    ModuleComponent,
    ComponentNormalization,
    ModuleExpander,
    ModuleBridge,
    ModuleBridgeJack,
    ModulePathHint,
    ComponentPair,
    ComponentSwitch,
    ComponentSwitchStep,
    ComponentMultGroup,
    ComponentRoute,
    ComponentValue,
    ModuleParameter,
    ModuleParameterOption,
    Patch,
    PatchModule,
    PatchRackRow,
    PatchRackRowModule,
    PatchGroup,
    PatchModulePort,
    PatchModuleLink,
    PatchModuleLinkJack,
    PatchCable,
    PatchSetting,
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
    QuestionAudio,
    QuestionPatch,
    DeviceAuthorization,
    DeviceToken,
    PatchScopeChannel,
    Capture,
    CaptureChannel,
    ScopeClip,
    ScopeClipChannel,
    AudioRecording,
    ResourceLink,
    Share,
    LlmUsage,
    Job,
  } = m;

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

  Module.hasMany(ComponentMultGroup, { foreignKey: 'module_id' });
  ComponentMultGroup.belongsTo(Module, { foreignKey: 'module_id' });
  ComponentMultGroup.belongsTo(ModuleComponent, { foreignKey: 'component_id' });
  ComponentMultGroup.belongsTo(ModuleComponent, {
    foreignKey: 'condition_component_id',
    as: 'MultCondition',
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

  Question.hasMany(QuestionAudio, { foreignKey: 'question_id' });
  QuestionAudio.belongsTo(Question, { foreignKey: 'question_id' });
  QuestionAudio.belongsTo(AudioRecording, { foreignKey: 'audio_id' });

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
  Capture.belongsTo(Module, { foreignKey: 'module_id' });
  Capture.belongsTo(Note, { foreignKey: 'note_id' });
  Capture.hasMany(CaptureChannel, { foreignKey: 'capture_id' });
  CaptureChannel.belongsTo(Capture, { foreignKey: 'capture_id' });

  ScopeClip.belongsTo(User, { foreignKey: 'user_id' });
  ScopeClip.belongsTo(Module, { foreignKey: 'module_id' });
  ScopeClip.belongsTo(Patch, { foreignKey: 'patch_id' });
  ScopeClip.hasMany(ScopeClipChannel, { foreignKey: 'clip_id' });
  ScopeClipChannel.belongsTo(ScopeClip, { foreignKey: 'clip_id' });

  AudioRecording.belongsTo(User, { foreignKey: 'user_id' });
  AudioRecording.belongsTo(Module, { foreignKey: 'module_id' });
  AudioRecording.belongsTo(Patch, { foreignKey: 'patch_id' });

  // A link hangs off exactly one of the four (the CHECK in migration 044),
  // so all four belong-tos are declared and at most one ever resolves.
  ResourceLink.belongsTo(User, { foreignKey: 'user_id' });
  ResourceLink.belongsTo(Module, { foreignKey: 'module_id' });
  ResourceLink.belongsTo(Patch, { foreignKey: 'patch_id' });
  ResourceLink.belongsTo(Rack, { foreignKey: 'rack_id' });
  ResourceLink.belongsTo(System, { foreignKey: 'system_id' });

  Share.belongsTo(User, { foreignKey: 'owner_id', as: 'Owner' });
  Share.belongsTo(User, { foreignKey: 'user_id', as: 'Recipient' });

  LlmUsage.belongsTo(User, { foreignKey: 'user_id' });
  User.hasMany(LlmUsage, { foreignKey: 'user_id' });

  Job.belongsTo(User, { foreignKey: 'user_id' });
  Job.belongsTo(Module, { foreignKey: 'module_id' });
  Job.belongsTo(Question, { foreignKey: 'question_id' });

  return m;
}
