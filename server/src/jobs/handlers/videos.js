// Attached YouTube videos.
//
//   download_video — yt-dlp the video, sample frames and pull the caption
//                    track, delete the video file, then queue analyze_video.
//                    No LLM involved
//   analyze_video  — LLM summary of the techniques the video demonstrates,
//                    written to the video row; the frames and transcript are
//                    deleted once it lands
//
// One of the groups composed by jobs/handlers.js. Every handler takes
// (job, backend, progress); the queue mechanics are jobs/worker.js.

import { downloadVideoForModule, removeVideoFiles } from '../../services/videos.js';
import { analyzeVideoForModule } from '../../services/videoAnalyzer.js';
import { enqueueVideoJob } from '../enqueue.js';

export function createVideosHandlers(db, {
    videosDir,
    downloadVideoImpl = downloadVideoForModule,
    analyzeVideoImpl = analyzeVideoForModule,
  }) {
  // The video row a video job is about. Both video handlers walk the row's
  // own status, like the question handlers walk the question's.
  async function jobVideo(job) {
    const payload = JSON.parse(job.payload || '{}');
    const record = await db.models.ModuleVideo.findByPk(payload.video_id);
    if (!record) throw new Error(`Video ${payload.video_id} no longer exists`);
    return record.get({ plain: true });
  }

  async function handleDownloadVideo(job, backend, progress) {
    const { ModuleVideo } = db.models;
    const video = await jobVideo(job);
    await ModuleVideo.update({ status: 'downloading', error: null }, { where: { id: video.id } });
    try {
      progress(`downloading video: ${video.url}`);
      const result = await downloadVideoImpl(video, videosDir, { log: progress });
      await ModuleVideo.update(
        {
          title: result.title,
          channel: result.channel,
          duration_seconds: result.duration_seconds,
          status: 'downloaded',
        },
        { where: { id: video.id } }
      );
    } catch (e) {
      await ModuleVideo.update(
        { status: 'failed', error: e.message },
        { where: { id: video.id } }
      );
      throw e;
    }
    // The analysis needs the frames and transcript this job just wrote, so it
    // is chained rather than run alongside.
    if (await enqueueVideoJob(db, 'analyze_video', video, job.user_id)) {
      progress('queued video analysis');
    }
  }

  async function handleAnalyzeVideo(job, backend, progress) {
    const { Module, ModuleVideo } = db.models;
    const video = await jobVideo(job);
    const record = await Module.findByPk(video.module_id);
    if (!record) throw new Error(`Module ${video.module_id} no longer exists`);
    const module = record.get({ plain: true });
    await ModuleVideo.update({ status: 'analyzing', error: null }, { where: { id: video.id } });
    progress(`analyzing video: '${video.title || video.url}'`);
    try {
      await analyzeVideoImpl(db, backend, module, video, videosDir, { log: progress });
    } catch (e) {
      await ModuleVideo.update(
        { status: 'failed', error: e.message },
        { where: { id: video.id } }
      );
      throw e;
    }
    // What the user keeps is the row: the link and the summary. The frames
    // and transcript have served their purpose (kept until now so a failed
    // attempt could retry without re-downloading).
    removeVideoFiles(videosDir, video);
    progress('summary saved; the downloaded video files are deleted');
  }

  return {
    download_video: handleDownloadVideo,
    analyze_video: handleAnalyzeVideo,
  };
}
