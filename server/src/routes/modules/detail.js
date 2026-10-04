import { Router } from 'express';
import { Op } from 'sequelize';
import { loadPanels } from '../../services/panelJson.js';
import { unlinkedExpanderHints } from '../../services/moduleLinks.js';
import { readableIds } from '../../services/sharing.js';
import { videoJson } from '../../services/videos.js';
import { clipJson } from '../../services/clips.js';
import { parametersByModule } from '../../services/moduleParameters.js';
import { requireOwnedModule } from './helpers.js';
import {
  componentJson,
  multGroupJson,
  normalizationJson,
  pairJson,
  routeJson,
  switchJson,
  valueJson,
} from '../../services/moduleJson.js';
import { asyncHandler } from '../asyncHandler.js';

// GET /:id — everything the module page shows, assembled in one response.
export function moduleDetailRoutes(db) {
  const {
    Module,
    ModuleComponent,
    ComponentNormalization,
    ComponentRoute,
    ComponentSwitch,
    ComponentSwitchStep,
    ComponentMultGroup,
    ComponentValue,
    ComponentPair,
    ModuleExpander,
    ModuleBridge,
    ModuleBridgeJack,
    Manual,
    ManualDocument,
    ModuleVideo,
    ScopeClip,
    ScopeClipChannel,
    Capture,
    CaptureChannel,
    Note,
    NoteModule,
    NoteComponent,
    User,
  } = db.models;
  const router = Router();

  router.get('/:id', requireOwnedModule(db), asyncHandler(async (req, res) => {
    const module = req.module;
    // The page is twenty-odd reads, nearly all of them about the module
    // alone: those go out together, and the handful that need one of their
    // answers (a component's values, an expander's partner) follow in a
    // second wave. Each is cheap; one after the other they were twenty
    // round trips to the database for one page.
    const [
      components,
      // The settings the module keeps in its menu rather than under a
      // control of its own — each one hanging off the jack or knob it
      // configures, or off nothing at all when it belongs to the whole
      // module.
      parametersByModuleId,
      // Normalled connections between the module's components (from the
      // manual analysis); target/source ids reference the components above.
      normalizations,
      // Internal signal paths (input jack → output jack); output jacks that
      // appear in no route are signal generators.
      routes,
      // Which mult section a bidirectional jack joins in one position of a
      // control — a switched multiple's per-jack bus toggles. A jack with
      // none of these takes its unconditional group_label instead.
      multGroups,
      // Jacks that carry the two halves of one signal (a stereo L/R pair).
      pairs,
      // Expander panels wired to this module (and hosts it expands): their
      // jacks may appear at either end of this module's signal paths.
      expanderRows,
      // Dual panels: two panels of one product joined by a link cable, jack
      // for jack (migration 033). Unlike an expander neither side is the
      // host, so the pair reads the same from either panel — and a dual
      // racked as one record with quantity 2 is declared against ITSELF.
      bridgeRows,
      // Routing switch sections (common jack ↔ one step jack at a time).
      switchRows,
      // Documents: the shared auto-found manual, this user's own uploads,
      // and any upload another user shared with them. A module carries a
      // handful of these, so the three-way visibility test is a filter in
      // JS rather than an OR the query planner (and pg-mem) would have to
      // untangle.
      sharedDocumentIdList,
      allManualRows,
      // The requesting user's attached YouTube videos and their analysis
      // summaries. Like uploads, a video (and what the model wrote about it)
      // belongs to whoever attached it.
      videoRows,
      // The requesting user's oscilloscope clips of this module — recordings
      // of their own bench, private like their notes.
      clipRows,
      // The waveform captures the user took of this module at the bench
      // (migration 042) — the still image beside the moving one, private
      // the same way.
      captureRows,
      // The requesting user's notes attached to this module (component_id
      // NULL) or to one of its components. Notes are strictly private per
      // user.
      moduleNotes,
      componentNotes,
      // The front plate and where each component sits on it, so the module
      // page can show the picture the patch diagram draws from.
      panels,
      // Panels this module's manual named that are not linked to a module
      // record — usually because the expander has not been imported yet.
      expanderSuggestions,
    ] = await Promise.all([
      ModuleComponent.findAll({
        where: { module_id: module.id },
        attributes: [
          'id',
          'type',
          'name',
          'description',
          'voltage_min',
          'voltage_max',
          'polarity',
          'group_label',
          'port_kind',
        ],
        order: [
          ['type', 'ASC'],
          ['id', 'ASC'],
        ],
      }),
      parametersByModule(db, [module.id]),
      ComponentNormalization.findAll({
        where: { module_id: module.id },
        attributes: [
          'id',
          'target_component_id',
          'source_component_id',
          'source_label',
          'kind',
          'condition_component_id',
          'condition_value',
          'alt_group',
          'break_component_id',
          'break_on',
          'description',
        ],
        order: [['id', 'ASC']],
      }),
      ComponentRoute.findAll({
        where: { module_id: module.id },
        attributes: [
          'id',
          'input_component_id',
          'output_component_id',
          'condition_component_id',
          'condition_value',
          'alt_group',
          'description',
        ],
        order: [['id', 'ASC']],
      }),
      ComponentMultGroup.findAll({
        where: { module_id: module.id },
        attributes: [
          'id',
          'component_id',
          'group_label',
          'condition_component_id',
          'condition_value',
          'description',
        ],
        order: [['id', 'ASC']],
      }),
      ComponentPair.findAll({
        where: { module_id: module.id },
        attributes: ['id', 'a_component_id', 'b_component_id', 'kind', 'description'],
        order: [['id', 'ASC']],
      }),
      ModuleExpander.findAll({
        where: { [Op.or]: [{ host_module_id: module.id }, { expander_module_id: module.id }] },
        order: [['id', 'ASC']],
      }),
      ModuleBridge.findAll({
        where: { [Op.or]: [{ a_module_id: module.id }, { b_module_id: module.id }] },
        order: [['id', 'ASC']],
      }),
      ComponentSwitch.findAll({
        where: { module_id: module.id },
        order: [['id', 'ASC']],
      }),
      readableIds(db, req.user.id, 'document'),
      Manual.findAll({
        where: { module_id: module.id },
        attributes: [
          'id',
          'hash',
          'name',
          'original_name',
          'source',
          'user_id',
          'created_at',
          'analysis_scope',
        ],
        order: [['id', 'ASC']],
      }),
      ModuleVideo.findAll({
        where: { module_id: module.id, user_id: req.user.id },
        order: [['id', 'ASC']],
      }),
      ScopeClip.findAll({
        where: { module_id: module.id, user_id: req.user.id },
        order: [['id', 'DESC']],
      }),
      Capture.findAll({
        where: { module_id: module.id, user_id: req.user.id },
        order: [['id', 'DESC']],
      }),
      NoteModule.findAll({
        where: { module_id: module.id },
        include: [{ model: Note, where: { user_id: req.user.id } }],
        order: [[Note, 'id', 'ASC']],
      }),
      NoteComponent.findAll({
        include: [
          { model: Note, where: { user_id: req.user.id } },
          { model: ModuleComponent, where: { module_id: module.id }, attributes: [] },
        ],
        order: [[Note, 'id', 'ASC']],
      }),
      loadPanels(db, [module.id]),
      unlinkedExpanderHints(db, module),
    ]);
    const parameters = parametersByModuleId.get(module.id) ?? [];
    const sharedDocumentIds = new Set(sharedDocumentIdList);
    const manualRows = allManualRows.filter(
      (m) => m.user_id === null || m.user_id === req.user.id || sharedDocumentIds.has(m.id)
    );
    const partnerIds = expanderRows.map((e) =>
      e.host_module_id === module.id ? e.expander_module_id : e.host_module_id
    );
    const bridgePartnerIds = bridgeRows.map((b) =>
      b.a_module_id === module.id ? b.b_module_id : b.a_module_id
    );
    // Who to credit for a document that is neither the shared manual nor
    // yours — it is on this page because somebody handed it to you.
    const documentOwnerIds = [
      ...new Set(
        manualRows
          .filter((m) => m.user_id !== null && m.user_id !== req.user.id)
          .map((m) => m.user_id)
      ),
    ];

    // The second wave: what the first one's answers point at.
    const [
      // Each component's valid values ('min'/'max' range ends or 'enum'
      // positions), grouped in JS (pg-mem-friendly flat query).
      valueRows,
      partners,
      // The components of the expander panels, so the GUI can offer them
      // when recording a signal path that crosses the ribbon cable.
      partnerComponents,
      bridgeJackRows,
      bridgePartners,
      switchSteps,
      documentOwnerRows,
      // Which of the documents have had their text extracted, so the page
      // can offer to read the manual rather than only to download it.
      extracted,
      clipChannels,
      captureChannels,
    ] = await Promise.all([
      components.length === 0
        ? []
        : ComponentValue.findAll({
            where: { component_id: components.map((c) => c.id) },
            attributes: ['id', 'component_id', 'type', 'value', 'description'],
            order: [['id', 'ASC']],
          }),
      partnerIds.length
        ? Module.findAll({
            where: { id: partnerIds },
            attributes: ['id', 'manufacturer', 'name'],
          })
        : [],
      partnerIds.length
        ? ModuleComponent.findAll({
            where: { module_id: partnerIds },
            attributes: ['id', 'module_id', 'type', 'name', 'group_label', 'port_kind'],
            order: [['id', 'ASC']],
          })
        : [],
      bridgeRows.length
        ? ModuleBridgeJack.findAll({
            where: { bridge_id: bridgeRows.map((b) => b.id) },
            order: [['id', 'ASC']],
          })
        : [],
      bridgePartnerIds.length
        ? Module.findAll({
            where: { id: bridgePartnerIds },
            attributes: ['id', 'manufacturer', 'name'],
          })
        : [],
      switchRows.length === 0
        ? []
        : ComponentSwitchStep.findAll({
            where: { switch_id: switchRows.map((s) => s.id) },
            order: [
              ['position', 'ASC'],
              ['component_id', 'ASC'],
            ],
          }),
      documentOwnerIds.length
        ? User.findAll({
            where: { id: documentOwnerIds },
            attributes: ['id', 'username'],
          })
        : [],
      manualRows.length === 0
        ? []
        : ManualDocument.findAll({
            where: { manual_id: manualRows.map((m) => m.id) },
            attributes: ['manual_id', 'pages', 'chars'],
          }),
      clipRows.length === 0
        ? []
        : ScopeClipChannel.findAll({
            where: { clip_id: clipRows.map((c) => c.id) },
            order: [['channel_index', 'ASC']],
          }),
      captureRows.length === 0
        ? []
        : CaptureChannel.findAll({
            where: { capture_id: captureRows.map((c) => c.id) },
            order: [['channel_index', 'ASC']],
          }),
    ]);

    const valuesByComponent = new Map();
    for (const v of valueRows) {
      if (!valuesByComponent.has(v.component_id)) valuesByComponent.set(v.component_id, []);
      valuesByComponent.get(v.component_id).push(valueJson(v));
    }
    const componentsJson = components.map((c) =>
      componentJson(c, { values: valuesByComponent.get(c.id) ?? [] })
    );
    const partnerById = new Map(partners.map((m) => [m.id, m]));
    const expanders = expanderRows.map((e) => {
      const isHost = e.host_module_id === module.id;
      const partner = partnerById.get(isHost ? e.expander_module_id : e.host_module_id);
      return {
        id: e.id,
        // 'expander' — the partner expands this module; 'host' — this
        // module is the expander and the partner is its host.
        role: isHost ? 'expander' : 'host',
        module_id: partner?.id ?? null,
        manufacturer: partner?.manufacturer ?? null,
        name: partner?.name ?? null,
        description: e.description,
      };
    });
    const bridgePartnerById = new Map(bridgePartners.map((m) => [m.id, m]));
    const bridges = bridgeRows.map((b) => {
      const partnerId = b.a_module_id === module.id ? b.b_module_id : b.a_module_id;
      const partner = bridgePartnerById.get(partnerId);
      return {
        id: b.id,
        module_id: partnerId,
        manufacturer: partner?.manufacturer ?? null,
        name: partner?.name ?? null,
        // Both halves are this same module record, racked twice.
        self: b.a_module_id === b.b_module_id,
        description: b.description,
        jacks: bridgeJackRows
          .filter((j) => j.bridge_id === b.id)
          .map((j) => ({ a_component_id: j.a_component_id, b_component_id: j.b_component_id })),
      };
    });
    const switches = switchRows.map((s) =>
      switchJson(
        s,
        switchSteps.filter((st) => st.switch_id === s.id).map((st) => st.component_id)
      )
    );
    const documentOwners = new Map(documentOwnerRows.map((u) => [u.id, u.username]));
    const textByManual = new Map(extracted.map((d) => [d.manual_id, d]));
    const manuals = manualRows.map((m) => {
      const text = textByManual.get(m.id);
      return {
        ...m.get({ plain: true }),
        has_text: Boolean(text),
        text_pages: text?.pages ?? null,
        text_chars: text?.chars ?? null,
        shared_by: documentOwners.get(m.user_id) ?? null,
      };
    });
    const noteJson = (note, componentId) => ({
      id: note.id,
      title: note.title,
      body: note.body,
      updated_at: note.updated_at,
      component_id: componentId,
    });
    res.json({
      ...module,
      panel: panels.get(module.id) ?? null,
      components: componentsJson,
      parameters,
      normalizations: normalizations.map(normalizationJson),
      routes: routes.map(routeJson),
      switches,
      mult_groups: multGroups.map(multGroupJson),
      pairs: pairs.map(pairJson),
      expanders,
      expander_components: partnerComponents,
      // The other half of a dual — two panels of one product joined by a
      // link cable, whose jacks pair up one to one.
      bridges,
      expander_suggestions: expanderSuggestions,
      manuals,
      videos: videoRows.map(videoJson),
      clips: clipRows.map((clip) =>
        clipJson(
          clip,
          clipChannels.filter((c) => c.clip_id === clip.id)
        )
      ),
      captures: captureRows.map((capture) => ({
        ...capture.get({ plain: true }),
        channels: captureChannels
          .filter((c) => c.capture_id === capture.id)
          .map((c) => c.get({ plain: true })),
      })),
      notes: [
        ...moduleNotes.map((nm) => noteJson(nm.Note, null)),
        ...componentNotes.map((nc) => noteJson(nc.Note, nc.component_id)),
      ],
    });
  }));

  return router;
}
