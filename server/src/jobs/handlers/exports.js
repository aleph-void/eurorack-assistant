// Taking a rack away with you.
//
//   export_rack — zip a rack's manuals, notes and questions into a one-shot
//                 download served by the exports route
//
// One of the groups composed by jobs/handlers.js. Every handler takes
// (job, backend, progress); the queue mechanics are jobs/worker.js.

import { safeSegment, writeRackExport } from '../../services/rackExport.js';

export function createExportsHandlers(db, { manualsDir, exportsDir }) {
  async function handleExportRack(job, backend, progress) {
    const payload = JSON.parse(job.payload || '{}');
    const rack = await db.models.Rack.findOne({
      where: { id: payload.rack_id, user_id: job.user_id },
    });
    if (!rack) throw new Error(`Rack ${payload.rack_id} no longer exists`);
    progress(`collecting documents for rack '${rack.name}'`);
    const { entryCount } = await writeRackExport(db, job.user_id, rack, job.id, {
      manualsDir,
      exportsDir,
      log: progress,
    });
    // The 'completed' event carries the link (via jobSummary); the client
    // auto-downloads it, and the exports route deletes the file once served.
    await db.models.Job.update(
      {
        payload: JSON.stringify({
          ...payload,
          filename: `${safeSegment(rack.name)}.zip`,
          download: `/api/exports/${job.id}`,
        }),
      },
      { where: { id: job.id } }
    );
    progress(`zipped ${entryCount} document(s)`);
  }

  return {
    export_rack: handleExportRack,
  };
}
