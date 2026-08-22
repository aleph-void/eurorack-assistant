// The module's front plate, and where its analyzed components sit on it.
//
// The analysis (services/manualAnalyzer.js) turns a manual into a list of
// jacks and controls. That is enough to trace signal, but a patch is a
// physical thing: what you actually do with it is look at the panels and plug
// cables between holes. This service gives the component list a picture to
// hang on, in the order a person would try:
//
//   0. Use the picture the user uploaded, if there is one: a panel someone
//      deliberately supplied outranks anything research can turn up, so it is
//      kept and only re-located on (routes/modules.js POST /:id/panel).
//   1. Research the web for the module's real front-panel image on the
//      manufacturer's own product page (or a retailer's), download it, and ask
//      the LLM to locate every analyzed component on it. What the model says
//      is then measured against the pixels and corrected — see
//      services/panelPixels.js, which is where the accuracy actually comes
//      from.
//   2. Failing that, look the module up on ModularGrid, which is not a source
//      but does have a straight-on panel shot of very nearly everything.
//   3. Failing that — no image found, or none of the components could be
//      located on it — ask the LLM to read the module's LAYOUT out of the
//      manual (how many HP wide, and where each control and jack sits) and
//      draw that layout here as an SVG. A logical stand-in rather than a
//      likeness, but positioned from the same manual, so the diagram still
//      reads as the module.
//   4. Failing even that (no manual, or an answer with nothing usable in it),
//      lay the components out in columns by type, so every jack still has a
//      place a cable can be drawn to.
//
// Positions are stored as fractions of the image, so the client can render
// them at any size (see migration 016).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadImage, panelPath, saveImage } from './image.js';
import { PANEL_MM_HEIGHT } from './panelShapes.js';
import {
  PANEL_RESEARCH_TEMPLATE,
  PANEL_MODULARGRID_TEMPLATE,
  PANEL_MAP_TEMPLATE,
  PANEL_LAYOUT_TEMPLATE,
  answerTally,
} from './panelPrompts.js';
import {
  estimateHp,
  fallbackLayout,
  fillMissingPlacements,
  normalizeCrop,
  normalizeHp,
  normalizePlacements,
  FULL_CROP,
} from './panelPlacements.js';
import { renderPanelSvg } from './panelSvg.js';
import { deletePanelImageIfOrphaned, savePanel } from './panelStore.js';
import { trimIncomingPanel } from './panelTrim.js';
import {
  growBox,
  panelCrop,
  pointInBox,
  readPixels,
  snapPlacements,
  writeCrop,
} from './panelPixels.js';

// Ask the LLM where the components are on an image. Returns null when the
// image turns out not to show this module's panel, or when nothing on it
// could be identified.
//
// `cropped` says the file has already been cut down to the front plate, in
// which case the model is not asked for a panel box (we already know it, and

export async function locateComponentsOnImage(
  backend,
  module,
  components,
  imagePath,
  log,
  { cropped = false, tally = answerTally() } = {}
) {
  let parsed;
  try {
    parsed = await tally.attempt(() =>
      backend.analyzeImage(
        PANEL_MAP_TEMPLATE(module.manufacturer, module.name, components, { cropped }),
        imagePath
      )
    );
  } catch (e) {
    log(`could not map components onto the panel image: ${e.message}`);
    return null;
  }
  if (parsed.is_panel === false) {
    log('the image found is not a straight-on shot of this module\'s panel');
    return null;
  }
  const placements = normalizePlacements(parsed.components, components);
  // A picture with one lucky hit on it is not a mapped panel; the drawn
  // fallback is more useful than a photo with three markers on it.
  const matched = placements.filter((p) => p.component_id).length;
  if (matched < Math.min(3, components.length)) {
    log(`only ${matched} of ${components.length} component(s) could be located on the image`);
    return null;
  }
  return { placements, crop: cropped ? null : normalizeCrop(parsed.panel), matched };
}

// How much backdrop is left around the plate in the picture handed to the
// model: enough that nothing along an edge is cut in half, little enough that
// the panel is still what the picture is of.
const ANALYSIS_MARGIN = 0.03;
// A trim that barely shrinks the frame is not worth a second file on disk.
const WORTH_CROPPING = 0.8;

// Where this module's components are on a panel photograph, in the fractions
// of the whole image the client renders from — the model's reading of the
// picture, corrected against the picture itself.
//
// The plate is found by trimming the backdrop rather than by asking, the
// model is then shown the plate on its own rather than a module 4% of the way
// across a press shot, and every round component it places is finally snapped
// onto the hardware it names. Each of those steps is skipped silently if the
// image cannot be decoded, leaving exactly the single unrefined LLM pass this
// used to be.
export async function mapPanelImage(backend, module, components, file, deps = {}) {
  const { hp = null, log = () => {}, tmpdir = os.tmpdir, tally = answerTally() } = deps;
  const pixels = await readPixels(file);
  const plate = pixels ? panelCrop(pixels, { hp }) : null;

  // The box the model's answer will be relative to: the crop we hand it, or
  // the whole image when there is no crop to hand it.
  let analysisBox = null;
  let analysisFile = file;
  let scratch = null;
  try {
    if (plate && plate.w * plate.h < WORTH_CROPPING) {
      const box = growBox(plate, ANALYSIS_MARGIN);
      scratch = fs.mkdtempSync(path.join(tmpdir(), 'panel-crop-'));
      const written = await writeCrop(file, box, path.join(scratch, 'panel.png'));
      if (written) {
        analysisBox = box;
        analysisFile = written;
        log(
          `cropped the front plate out of the ${pixels.width}x${pixels.height} image ` +
            `(${Math.round(plate.w * 100)}% of its width) before mapping`
        );
      }
    }

    const located = await locateComponentsOnImage(backend, module, components, analysisFile, log, {
      cropped: analysisBox !== null,
      tally,
    });
    if (!located) return null;

    let placements = located.placements;
    if (analysisBox) {
      placements = placements.map((p) => ({
        ...p,
        ...pointInBox(analysisBox, p.x, p.y),
        w: p.w * analysisBox.w,
        h: p.h * analysisBox.h,
      }));
    }

    const crop = plate
      ? { crop_x: plate.x, crop_y: plate.y, crop_w: plate.w, crop_h: plate.h }
      : located.crop ?? { ...FULL_CROP };

    if (pixels) {
      const snap = snapPlacements(pixels, placements, {
        x: crop.crop_x,
        y: crop.crop_y,
        w: crop.crop_w,
        h: crop.crop_h,
      });
      placements = snap.placements;
      if (snap.snapped > 0) {
        // A fraction of the image's height is that many 128.5mm plates.
        const mm = (Math.abs(snap.shift.y) * PANEL_MM_HEIGHT) / crop.crop_h;
        log(
          `snapped ${snap.snapped} of ${placements.length} marker(s) onto the hardware` +
            (snap.shifted
              ? `, and carried the other ${snap.shifted} ${snap.shift.y < 0 ? 'up' : 'down'} ` +
                `with them (${mm.toFixed(1)}mm at the middle of the panel)`
              : '')
        );
      }
    }

    return { placements, crop, matched: located.matched };
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Ask the LLM to read the panel layout out of the manual, for the case where
// no usable photograph exists.
export async function layoutFromManual(
  backend,
  module,
  components,
  manualFile,
  log,
  { tally = answerTally() } = {}
) {
  if (!manualFile || !fs.existsSync(manualFile)) return null;
  let parsed;
  try {
    parsed = await tally.attempt(() =>
      backend.analyzeDocument(
        PANEL_LAYOUT_TEMPLATE(module.manufacturer, module.name, components),
        manualFile
      )
    );
  } catch (e) {
    log(`could not read a panel layout out of the manual: ${e.message}`);
    return null;
  }
  const placements = normalizePlacements(parsed.components, components);
  if (placements.length === 0) return null;
  return { placements, hp: normalizeHp(parsed.hp) };
}

// One research prompt: ask, then download the first candidate that turns out
// to be an image we serve. Returns { image, hp, page_url }, image null when
// the search found nothing or none of what it found could be fetched.
async function researchPanelImage(
  backend,
  template,
  module,
  panelsDir,
  { fetchImpl, log, tally = answerTally(), acceptImage = null }
) {
  let info;
  try {
    info = await tally.attempt(() =>
      backend.completeTextWithSearch(template(module.manufacturer, module.name))
    );
  } catch (e) {
    log(`panel image research failed: ${e.message}`);
    return { image: null, hp: null, page_url: null };
  }
  const hp = normalizeHp(info.hp);
  const page_url = info.page_url ? String(info.page_url).trim() : null;
  const urls = (Array.isArray(info.image_urls) ? info.image_urls : [info.image_urls])
    .filter(Boolean)
    .map((u) => String(u).trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 4);
  for (const url of urls) {
    log(`trying panel image: ${url}`);
    const image = await downloadImage(url, { fetchImpl, log });
    if (!image) continue;
    const hash = saveImage(panelsDir, image.buffer, image.ext);
    const candidate = {
      image: { ...image, hash, path: panelPath(panelsDir, hash, image.ext) },
      hp,
      page_url,
    };
    if (!acceptImage) return candidate;

    // Downloading an image only establishes that it is a decodable raster.
    // Before choosing it as a panel, inspect it to make sure it is actually a
    // square-on front view. This also lets us continue through a product
    // page's alternates (and then ModularGrid) when its first image is a
    // tempting but unusable angled hero shot.
    let accepted = null;
    try {
      accepted = await acceptImage(candidate);
    } catch (e) {
      log(`could not validate panel image: ${e.message}`);
    }
    if (accepted) return { ...candidate, located: accepted };
    log('rejected candidate: it is not a usable straight-on front panel view');
    // This candidate was only just written and has not been referenced by a
    // panel record, so deleting this exact file is safe.
    fs.rmSync(candidate.image.path, { force: true });
  }
  return { image: null, hp, page_url };
}

// Research and download a front-panel photograph. The maker's own page and
// the retailers first; ModularGrid only if that turns up nothing, since it is
// a rack planner whose pictures are contributed rather than published. A
// width learnt from either search is kept even when neither yields a picture,
// because a module with no recorded HP still wants one.
export async function findPanelImage(backend, module, panelsDir, deps = {}) {
  const { fetchImpl = fetch, log = () => {}, tally = answerTally(), acceptImage = null } = deps;
  const options = { fetchImpl, log, tally, acceptImage };
  const first = await researchPanelImage(backend, PANEL_RESEARCH_TEMPLATE, module, panelsDir, options);
  if (first.image) return first;

  log('no panel image from the manufacturer or a retailer; trying ModularGrid');
  const second = await researchPanelImage(
    backend,
    PANEL_MODULARGRID_TEMPLATE,
    module,
    panelsDir,
    options
  );
  return {
    image: second.image,
    hp: (second.image ? second.hp ?? first.hp : first.hp ?? second.hp) ?? null,
    page_url: (second.image ? second.page_url : first.page_url ?? second.page_url) ?? null,
    ...(second.image ? { located: second.located } : {}),
  };
}

// Replace the module's panel record and its component positions, and mark the
// module's panel status complete. One transaction: a half-written panel whose
// markers point at the previous image would be worse than none.
//
// A width the panel step worked out also fills in the module's own hp when
// nothing has recorded one yet (migration 017) — but never overwrites a width
// that is already there, which came from the manual or from the import and is
// the better source.

// Place this module's components on a panel image that is already stored —
// the picture a user uploaded (routes/modules.js POST /:id/panel). The image
// itself is never in question here: it is kept whatever the mapping says,
// because someone chose it deliberately. Only the markers are (re)derived,
// which is also what puts them back after a re-analysis has replaced every
// component row the previous markers pointed at.
//
// Returns null when the file has gone missing, so the caller can fall back to
// building a panel from scratch.
export async function locateOnUploadedPanel(db, backend, module, panel, components, panelsDir, deps = {}) {
  const { log = () => {}, tally = answerTally() } = deps;
  const file = panelPath(panelsDir, panel.image_hash, panel.image_ext);
  if (!fs.existsSync(file)) return null;
  log(`locating components on the uploaded ${panel.width}x${panel.height} image`);
  const located = await mapPanelImage(backend, module, components, file, {
    hp: module.hp ?? panel.hp ?? null,
    log,
    tally,
  });
  // Stripping the markers off a picture the user chose, because the provider
  // is not answering, would be worse than doing nothing at all.
  if (tally.silent()) throw silentModel(module, tally);
  if (!located) {
    log('no component could be located on the uploaded image; keeping it unmarked');
  }
  // The mapping above spends its time in an LLM call, and the panel is live
  // while it runs: a trim (or another upload) can replace the picture under
  // it. Saving would then resurrect this job's stale snapshot — a row
  // pointing at an image file the replacement already deleted, which is a
  // broken panel no button can repair. The newer picture wins; the markers
  // worked out against the old bytes go with the old bytes.
  const current = await db.models.ModulePanel.findOne({ where: { module_id: module.id } });
  if (!current || current.image_hash !== panel.image_hash) {
    log('the panel picture changed while the components were being located; keeping the newer picture');
    return current
      ? {
          panel: current.get({ plain: true }),
          placements: (
            await db.models.ModulePanelComponent.findAll({ where: { panel_id: current.id } })
          ).map((row) => row.get({ plain: true })),
        }
      : null;
  }
  return savePanel(
    db,
    module,
    {
      source: 'upload',
      source_url: panel.source_url ?? null,
      image_hash: panel.image_hash,
      image_ext: panel.image_ext,
      width: panel.width,
      height: panel.height,
      // A picture that has already been cut down to the plate stays marked as
      // such, or a re-locate would re-arm the Trim button against an image
      // with no backdrop left to lose.
      trimmed: Boolean(panel.trimmed),
      // ... and a picture that IS the plate is never cropped again: the crop
      // a fresh reading of it suggests would only shave the hardware.
      ...(panel.trimmed ? { ...FULL_CROP } : located?.crop ?? { ...FULL_CROP }),
      hp: module.hp ?? panel.hp ?? null,
      description: located
        ? `Uploaded panel image — ${located.matched} of ${components.length} component(s) located on it.`
        : 'Uploaded panel image. The components on it could not be located automatically.',
    },
    located?.placements ?? []
  );
}

const silentModel = (module, tally) =>
  new Error(
    `${module.manufacturer} ${module.name}: none of the ${tally.asked} model request(s) this ` +
      'panel needed came back readable, so there is nothing to tell a panel from. Check the ' +
      'provider CLI is logged in and has quota; the panel this module already had is untouched'
  );

// The whole pipeline for one module: an uploaded picture if there is one,
// then a researched image, then a drawn panel, then columns by type. Always
// produces a panel — a module with an analysis but no picture is exactly the
// case this exists to remove — unless the model answered nothing at all, in
// which case it produces nothing rather than a drawing standing in for a
// photograph that is still perfectly findable.
export async function buildPanelForModule(db, backend, module, panelsDir, deps = {}) {
  const {
    fetchImpl = fetch,
    log = () => {},
    manualFile = null,
    findImages = true,
    tally = answerTally(),
  } = deps;
  const components = (
    await db.models.ModuleComponent.findAll({
      where: { module_id: module.id },
      order: [['id', 'ASC']],
    })
  ).map((c) => c.get({ plain: true }));
  if (components.length === 0) {
    throw new Error(
      `${module.manufacturer} ${module.name} has no analyzed components to place on a panel`
    );
  }

  const previous = await db.models.ModulePanel.findOne({ where: { module_id: module.id } });

  // A panel someone uploaded is the panel. Research would only replace a
  // deliberate choice with a guess, so the picture stays and its markers are
  // worked out again on it.
  //
  // Checked against the stored row rather than once at the top, because this
  // job spends minutes in LLM calls and an upload can land in the middle of
  // one: the answer to "is there an uploaded panel" has to be the answer at
  // the moment of saving, or the upload is silently thrown away.
  const uploadedPanel = async () => {
    const current = await db.models.ModulePanel.findOne({ where: { module_id: module.id } });
    if (current?.source !== 'upload') return null;
    return locateOnUploadedPanel(db, backend, module, current.get({ plain: true }), components, panelsDir, {
      log,
      tally,
    });
  };

  const uploaded = await uploadedPanel();
  if (uploaded) return uploaded;
  if (previous?.source === 'upload') {
    log('the uploaded panel image is no longer on disk; building one instead');
  }

  let researched = { image: null, hp: null, page_url: null };
  if (findImages) {
    log('researching a front panel image');
    researched = await findPanelImage(backend, module, panelsDir, {
      fetchImpl,
      log,
      tally,
      acceptImage: (candidate) =>
        mapPanelImage(backend, module, components, candidate.image.path, {
          hp: module.hp ?? candidate.hp ?? null,
          log,
          tally,
        }),
    });
  }

  if (researched.image) {
    const located = researched.located;
    if (located) {
      log(`panel image mapped: ${located.matched} of ${components.length} component(s) located`);
      const landed = await uploadedPanel();
      if (landed) {
        log('a panel picture was uploaded while this ran; keeping that instead');
        await deletePanelImageIfOrphaned(db, panelsDir, researched.image.hash, researched.image.ext);
        return landed;
      }
      // Cut the plate out of the downloaded picture as it lands, rather than
      // storing a press shot and leaving a Trim button for someone to press:
      // what the research found is a photograph, and what a panel is drawn
      // from should be the module.
      const plate = {
        x: located.crop.crop_x,
        y: located.crop.crop_y,
        w: located.crop.crop_w,
        h: located.crop.crop_h,
      };
      const cut = await trimIncomingPanel(researched.image.path, plate, {
        ext: researched.image.ext,
        markers: located.placements,
      });
      if (cut) {
        log(
          'cut the panel out of the downloaded image: ' +
            `${researched.image.width}x${researched.image.height} to ${cut.width}x${cut.height}`
        );
      }
      const stored = cut
        ? {
            hash: saveImage(panelsDir, cut.buffer, cut.ext),
            ext: cut.ext,
            width: cut.width,
            height: cut.height,
          }
        : researched.image;
      const saved = await savePanel(
        db,
        module,
        {
          source: 'image',
          source_url: researched.image.url,
          image_hash: stored.hash,
          image_ext: stored.ext,
          width: stored.width,
          height: stored.height,
          ...(cut ? { ...FULL_CROP } : located.crop),
          trimmed: Boolean(cut),
          hp: researched.hp,
          description: researched.page_url ? `Found on ${researched.page_url}` : null,
        },
        cut ? cut.markers : located.placements
      );
      if (cut) {
        await deletePanelImageIfOrphaned(
          db,
          panelsDir,
          researched.image.hash,
          researched.image.ext
        );
      }
      if (previous) {
        await deletePanelImageIfOrphaned(db, panelsDir, previous.image_hash, previous.image_ext);
      }
      return saved;
    }
    // The image is of no use to us; do not leave its bytes on disk.
    await deletePanelImageIfOrphaned(
      db,
      panelsDir,
      researched.image.hash,
      researched.image.ext
    );
  }

  log('drawing a logical panel from the manual');
  const layout = await layoutFromManual(backend, module, components, manualFile, log, { tally });
  // Everything above came up empty. That is a real answer when the model gave
  // one — plenty of modules have no findable photograph — and no answer at all
  // when it did not, and a drawing saved on the strength of no answer would
  // replace this module's picture with a column of circles and delete it.
  if (tally.silent()) throw silentModel(module, tally);
  const placements = fillMissingPlacements(
    layout?.placements ?? fallbackLayout(components),
    components
  );
  // The module's own width (from its manual, or from the imported list) beats
  // anything worked out while drawing.
  const hp = module.hp ?? layout?.hp ?? researched.hp ?? estimateHp(components);
  const { svg, width, height } = renderPanelSvg({
    manufacturer: module.manufacturer,
    name: module.name,
    hp,
    placements,
  });
  const landed = await uploadedPanel();
  if (landed) {
    log('a panel picture was uploaded while this ran; keeping that instead');
    return landed;
  }
  const hash = saveImage(panelsDir, Buffer.from(svg, 'utf-8'), 'svg');
  log(
    layout
      ? `logical panel drawn from the manual: ${hp}HP, ${placements.length} component(s)`
      : `logical panel drawn from the component list: ${hp}HP, ${placements.length} component(s)`
  );
  const saved = await savePanel(
    db,
    module,
    {
      source: 'generated',
      source_url: null,
      image_hash: hash,
      image_ext: 'svg',
      width,
      height,
      crop_x: 0,
      crop_y: 0,
      crop_w: 1,
      crop_h: 1,
      hp,
      description: layout
        ? 'Drawn from the panel layout described in the manual.'
        : 'Drawn from the analyzed component list; no panel layout was available.',
    },
    placements
  );
  if (previous) {
    await deletePanelImageIfOrphaned(db, panelsDir, previous.image_hash, previous.image_ext);
  }
  return saved;
}
