// Per-job-type handlers for the queue worker. Each handler receives
// (job, backend, progress) and does the actual work of one job type.
//
// The types are grouped one file per stage of the pipeline under handlers/,
// because a job type is only ever read beside the ones it queues and is
// queued by:
//
//   handlers/manuals.js   — import, find_manual, extract_manual,
//                           analyze_manual, reanalyze_components,
//                           describe_components, find_parameters
//   handlers/panels.js    — panel_image, trim_panels
//   handlers/videos.js    — download_video, analyze_video
//   handlers/questions.js — scope_question, answer_question
//   handlers/exports.js   — export_rack
//
// The queue mechanics (claiming, leases, retries, pauses) live in worker.js.

import { renderPageToPdf } from '../services/pdf.js';
import { extractManualDocument } from '../services/manualText.js';
import { downloadVideoForModule } from '../services/videos.js';
import { analyzeVideoForModule } from '../services/videoAnalyzer.js';
import { createManualsHandlers } from './handlers/manuals.js';
import { createPanelsHandlers } from './handlers/panels.js';
import { createVideosHandlers } from './handlers/videos.js';
import { createQuestionsHandlers } from './handlers/questions.js';
import { createExportsHandlers } from './handlers/exports.js';

export function createHandlers(
  db,
  {
    manualsDir,
    exportsDir,
    capturesDir,
    panelsDir,
    videosDir,
    fetchImpl = fetch,
    renderImpl = renderPageToPdf,
    extractImpl = extractManualDocument,
    downloadVideoImpl = downloadVideoForModule,
    analyzeVideoImpl = analyzeVideoForModule,
  }
) {
  return {
    ...createManualsHandlers(db, { manualsDir, fetchImpl, renderImpl, extractImpl }),
    ...createPanelsHandlers(db, { manualsDir, panelsDir, fetchImpl }),
    ...createVideosHandlers(db, { videosDir, downloadVideoImpl, analyzeVideoImpl }),
    ...createQuestionsHandlers(db, { manualsDir, capturesDir }),
    ...createExportsHandlers(db, { manualsDir, exportsDir }),
  };
}
