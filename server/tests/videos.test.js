import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createTestApp, createTestDb, createUser, insertModule, fakeBackend } from './helpers.js';
import {
  parseYoutubeId,
  youtubeUrl,
  videoWorkDir,
  vttToTranscript,
  downloadVideoForModule,
  fetchVideoMetadata,
  MAX_VIDEO_SECONDS,
  FRAME_COUNT,
} from '../src/services/videos.js';
import { analyzeVideoForModule, buildVideoPrompt } from '../src/services/videoAnalyzer.js';
import { createWorker, enqueueVideoJob, resetJobTarget } from '../src/jobs/worker.js';

const YT_ID = 'dQw4w9WgXcQ';

describe('parseYoutubeId', () => {
  it('reads every common YouTube link shape', () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${YT_ID}`,
      `https://youtube.com/watch?v=${YT_ID}&t=120s`,
      `https://m.youtube.com/watch?v=${YT_ID}`,
      `https://youtu.be/${YT_ID}`,
      `https://youtu.be/${YT_ID}?si=share-junk`,
      `https://www.youtube.com/shorts/${YT_ID}`,
      `https://www.youtube.com/live/${YT_ID}`,
      `https://www.youtube.com/embed/${YT_ID}`,
      `http://music.youtube.com/watch?v=${YT_ID}`,
    ]) {
      expect(parseYoutubeId(url), url).toBe(YT_ID);
    }
  });

  it('rejects everything that is not a YouTube video link', () => {
    for (const url of [
      'https://vimeo.com/12345',
      'https://example.com/watch?v=' + YT_ID,
      'https://evil.com/youtube.com/watch?v=' + YT_ID,
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/watch?v=too-short',
      `ftp://youtube.com/watch?v=${YT_ID}`,
      'not a url at all',
      '',
      null,
    ]) {
      expect(parseYoutubeId(url), String(url)).toBeNull();
    }
  });
});

describe('vttToTranscript', () => {
  it('strips the header, cue timings and tags, and deduplicates rolling lines', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      'Language: en',
      '',
      '00:00:00.000 --> 00:00:02.000 align:start position:0%',
      'patch<00:00:01.000><c> the</c><c> output</c>',
      '',
      '00:00:02.000 --> 00:00:04.000',
      'patch the output',
      'into channel one',
      '',
      '2',
      '00:00:04.000 --> 00:00:06.000',
      'into channel one',
      'turn up rise',
    ].join('\n');
    expect(vttToTranscript(vtt)).toBe('patch the output\ninto channel one\nturn up rise');
  });
});

// A scripted stand-in for yt-dlp + ffmpeg: metadata answers come from `meta`,
// the download drops the named files into cwd, and the frame extraction
// writes `frames` stills.
function fakeRun({ meta = {}, subtitles = 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello patching\n', frames = 3 } = {}) {
  const calls = [];
  const run = async (cmd, args, { cwd } = {}) => {
    calls.push({ cmd, args, cwd });
    if (cmd === 'yt-dlp' && args.includes('--dump-single-json')) {
      return JSON.stringify({ title: 'Maths tricks', channel: 'Synth Channel', duration: 300, ...meta });
    }
    if (cmd === 'yt-dlp') {
      fs.writeFileSync(path.join(cwd, 'video.mp4'), 'not really a video');
      if (subtitles !== null) fs.writeFileSync(path.join(cwd, 'video.en.vtt'), subtitles);
      return '';
    }
    if (cmd === 'ffmpeg') {
      for (let i = 1; i <= frames; i += 1) {
        fs.writeFileSync(path.join(cwd, `frame-${String(i).padStart(2, '0')}.jpg`), `frame ${i}`);
      }
      return '';
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  run.calls = calls;
  return run;
}

describe('downloadVideoForModule', () => {
  let videosDir;
  beforeEach(() => {
    videosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videos-'));
  });
  afterEach(() => {
    fs.rmSync(videosDir, { recursive: true, force: true });
  });

  const video = { id: 7, video_id: YT_ID };

  it('downloads, samples frames, writes the transcript and deletes the video file', async () => {
    const run = fakeRun({ frames: 4 });
    const result = await downloadVideoForModule(video, videosDir, { run });
    expect(result.title).toBe('Maths tricks');
    expect(result.channel).toBe('Synth Channel');
    expect(result.duration_seconds).toBe(300);
    expect(result.frames).toHaveLength(4);
    const dir = videoWorkDir(videosDir, video);
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['frame-01.jpg', 'frame-02.jpg', 'frame-03.jpg', 'frame-04.jpg', 'transcript.txt']);
    expect(fs.readFileSync(path.join(dir, 'transcript.txt'), 'utf-8')).toBe('hello patching');
    // Only the canonical URL, rebuilt from the id, ever reaches yt-dlp.
    for (const call of run.calls.filter((c) => c.cmd === 'yt-dlp')) {
      expect(call.args[call.args.length - 1]).toBe(youtubeUrl(YT_ID));
    }
    // The frame rate is spread across the runtime: 300s / 16 frames.
    const ffmpeg = run.calls.find((c) => c.cmd === 'ffmpeg');
    expect(ffmpeg.args).toContain(`fps=1/${Math.floor(300 / FRAME_COUNT)},scale=640:-2`);
  });

  it('carries on without captions', async () => {
    const run = fakeRun({ subtitles: null });
    const result = await downloadVideoForModule(video, videosDir, { run });
    expect(result.transcriptChars).toBe(0);
    expect(fs.existsSync(path.join(videoWorkDir(videosDir, video), 'transcript.txt'))).toBe(false);
    expect(result.frames.length).toBeGreaterThan(0);
  });

  it('permanently refuses a feature-length video before downloading it', async () => {
    const run = fakeRun({ meta: { duration: MAX_VIDEO_SECONDS + 1 } });
    const error = await downloadVideoForModule(video, videosDir, { run }).catch((e) => e);
    expect(error.message).toMatch(/hours long/);
    expect(error.permanent).toBe(true);
    expect(run.calls).toHaveLength(1); // metadata only, no download
  });

  it('fails when the run yields neither frames nor a transcript', async () => {
    const run = fakeRun({ subtitles: null, frames: 0 });
    await expect(downloadVideoForModule(video, videosDir, { run })).rejects.toThrow(
      /neither frames nor a transcript/
    );
  });
});

describe('fetchVideoMetadata', () => {
  it('rejects unreadable metadata', async () => {
    const run = async () => 'not json';
    await expect(fetchVideoMetadata(YT_ID, { run })).rejects.toThrow(/unreadable/);
  });
});

describe('analyzeVideoForModule', () => {
  let videosDir;
  beforeEach(() => {
    videosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videos-'));
  });
  afterEach(() => {
    fs.rmSync(videosDir, { recursive: true, force: true });
  });

  async function fixture(db, { frames = 2, transcript = 'turn up the rise knob' } = {}) {
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, {});
    const video = (
      await db.models.ModuleVideo.create({
        module_id: module.id,
        user_id: user.id,
        video_id: YT_ID,
        url: youtubeUrl(YT_ID),
        title: 'Maths tricks',
        channel: 'Synth Channel',
        duration_seconds: 300,
        status: 'downloaded',
      })
    ).get({ plain: true });
    const dir = videoWorkDir(videosDir, video);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= frames; i += 1) {
      fs.writeFileSync(path.join(dir, `frame-0${i}.jpg`), `frame ${i}`);
    }
    if (transcript) fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript);
    return { user, module, video };
  }

  it('asks the model with the frames and stores the summary', async () => {
    const db = await createTestDb();
    const { module, video } = await fixture(db);
    const backend = fakeBackend({ analyzeImages: '## Slew-limited plucks\n\nPatch...' });
    const result = await analyzeVideoForModule(db, backend, module, video, videosDir);
    expect(result.summary).toContain('Slew-limited plucks');
    expect(backend.calls.analyzeImages).toHaveLength(1);
    const [prompt, framePaths] = backend.calls.analyzeImages[0];
    expect(framePaths).toHaveLength(2);
    expect(prompt).toContain('Make Noise Maths');
    expect(prompt).toContain('Maths tricks');
    expect(prompt).toContain('turn up the rise knob');
    const row = await db.models.ModuleVideo.findByPk(video.id);
    expect(row.status).toBe('complete');
    expect(row.summary).toContain('Slew-limited plucks');
  });

  it('falls back to a text-only ask when there are no frames', async () => {
    const db = await createTestDb();
    const { module, video } = await fixture(db, { frames: 0 });
    const backend = fakeBackend({ completeText: 'summary from the transcript' });
    await analyzeVideoForModule(db, backend, module, video, videosDir);
    expect(backend.calls.completeText).toHaveLength(1);
    expect(backend.calls.analyzeImages).toHaveLength(0);
  });

  it('fails when the work files are gone', async () => {
    const db = await createTestDb();
    const { module, video } = await fixture(db, { frames: 0, transcript: null });
    const backend = fakeBackend({});
    await expect(analyzeVideoForModule(db, backend, module, video, videosDir)).rejects.toThrow(
      /run the download again/
    );
  });

  it('rejects an empty answer', async () => {
    const db = await createTestDb();
    const { module, video } = await fixture(db);
    const backend = fakeBackend({ analyzeImages: '   ' });
    await expect(analyzeVideoForModule(db, backend, module, video, videosDir)).rejects.toThrow(
      /empty summary/
    );
  });

  it('says in the prompt when the video has no transcript', () => {
    const prompt = buildVideoPrompt(
      { manufacturer: 'Make Noise', name: 'Maths', summary: null },
      { title: 'demo', url: youtubeUrl(YT_ID), channel: null, duration_seconds: null },
      { frameCount: 3, transcript: '' }
    );
    expect(prompt).toContain('it has no transcript');
  });
});

describe('video routes', () => {
  it('attaches a video, queues the download job, and lists it on the module', async () => {
    const { db, app, aliceCookie } = await createTestApp();
    const alice = await db.models.User.findOne({ where: { username: 'alice' } });
    const module = await insertModule(db, alice.id, {});

    const res = await request(app)
      .post(`/api/modules/${module.id}/videos`)
      .set('Cookie', aliceCookie)
      .send({ url: `https://youtu.be/${YT_ID}` });
    expect(res.status).toBe(201);
    expect(res.body.video_id).toBe(YT_ID);
    expect(res.body.url).toBe(youtubeUrl(YT_ID));
    expect(res.body.status).toBe('pending');
    expect(res.body.job_id).toBeTruthy();

    const job = await db.models.Job.findByPk(res.body.job_id);
    expect(job.type).toBe('download_video');
    expect(job.module_id).toBe(module.id);
    expect(JSON.parse(job.payload).video_id).toBe(res.body.id);

    const detail = await request(app)
      .get(`/api/modules/${module.id}`)
      .set('Cookie', aliceCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.videos).toHaveLength(1);
    expect(detail.body.videos[0].video_id).toBe(YT_ID);
  });

  it('rejects links that are not YouTube videos', async () => {
    const { db, app, aliceCookie } = await createTestApp();
    const alice = await db.models.User.findOne({ where: { username: 'alice' } });
    const module = await insertModule(db, alice.id, {});
    const res = await request(app)
      .post(`/api/modules/${module.id}/videos`)
      .set('Cookie', aliceCookie)
      .send({ url: 'https://vimeo.com/12345' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YouTube/);
  });

  it('refuses to attach the same video twice, but re-queues a failed one', async () => {
    const { db, app, aliceCookie } = await createTestApp();
    const alice = await db.models.User.findOne({ where: { username: 'alice' } });
    const module = await insertModule(db, alice.id, {});
    const url = youtubeUrl(YT_ID);

    const first = await request(app)
      .post(`/api/modules/${module.id}/videos`)
      .set('Cookie', aliceCookie)
      .send({ url });
    expect(first.status).toBe(201);

    const dup = await request(app)
      .post(`/api/modules/${module.id}/videos`)
      .set('Cookie', aliceCookie)
      .send({ url });
    expect(dup.status).toBe(409);

    await db.models.ModuleVideo.update(
      { status: 'failed', error: 'boom' },
      { where: { id: first.body.id } }
    );
    // The stale queued job would block a new one; drop it as the worker
    // would have on failure.
    await db.models.Job.update({ status: 'failed' }, { where: { id: first.body.job_id } });

    const retry = await request(app)
      .post(`/api/modules/${module.id}/videos`)
      .set('Cookie', aliceCookie)
      .send({ url });
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.status).toBe('pending');
    expect(retry.body.job_id).toBeTruthy();
  });

  it("keeps one user's videos out of another user's module page", async () => {
    const { db, app, adminCookie, aliceCookie } = await createTestApp();
    const alice = await db.models.User.findOne({ where: { username: 'alice' } });
    const admin = await db.models.User.findOne({ where: { username: 'admin' } });
    const module = await insertModule(db, alice.id, {});
    const { mapModule } = await import('./helpers.js');
    await mapModule(db, admin.id, module.id);

    await request(app)
      .post(`/api/modules/${module.id}/videos`)
      .set('Cookie', aliceCookie)
      .send({ url: youtubeUrl(YT_ID) });

    const detail = await request(app)
      .get(`/api/modules/${module.id}`)
      .set('Cookie', adminCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.videos).toEqual([]);
  });

  it('deletes a video row and its work files', async () => {
    const { db, app, aliceCookie, videosDir } = await createTestApp();
    const alice = await db.models.User.findOne({ where: { username: 'alice' } });
    const module = await insertModule(db, alice.id, {});
    const res = await request(app)
      .post(`/api/modules/${module.id}/videos`)
      .set('Cookie', aliceCookie)
      .send({ url: youtubeUrl(YT_ID) });
    const dir = path.join(videosDir, String(res.body.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'frame-01.jpg'), 'x');

    const del = await request(app)
      .delete(`/api/modules/${module.id}/videos/${res.body.id}`)
      .set('Cookie', aliceCookie);
    expect(del.status).toBe(200);
    expect(await db.models.ModuleVideo.findByPk(res.body.id)).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("will not delete another user's video", async () => {
    const { db, app, adminCookie, aliceCookie } = await createTestApp();
    const alice = await db.models.User.findOne({ where: { username: 'alice' } });
    const admin = await db.models.User.findOne({ where: { username: 'admin' } });
    const module = await insertModule(db, alice.id, {});
    const { mapModule } = await import('./helpers.js');
    await mapModule(db, admin.id, module.id);
    const res = await request(app)
      .post(`/api/modules/${module.id}/videos`)
      .set('Cookie', aliceCookie)
      .send({ url: youtubeUrl(YT_ID) });
    const del = await request(app)
      .delete(`/api/modules/${module.id}/videos/${res.body.id}`)
      .set('Cookie', adminCookie);
    expect(del.status).toBe(404);
    expect(await db.models.ModuleVideo.findByPk(res.body.id)).not.toBeNull();
  });
});

describe('video jobs', () => {
  let videosDir;
  beforeEach(() => {
    videosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videos-'));
  });
  afterEach(() => {
    fs.rmSync(videosDir, { recursive: true, force: true });
  });

  async function fixture(db) {
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, {});
    const video = (
      await db.models.ModuleVideo.create({
        module_id: module.id,
        user_id: user.id,
        video_id: YT_ID,
        url: youtubeUrl(YT_ID),
        status: 'pending',
      })
    ).get({ plain: true });
    return { user, module, video };
  }

  function makeWorker(db, backend, options = {}) {
    return createWorker(db, {
      manualsDir: videosDir, // unused by these jobs; any dir will do
      videosDir,
      backendFactory: () => backend,
      renderImpl: async () => false,
      log: () => {},
      ...options,
    });
  }

  it('download_video updates the row, then chains analyze_video, which stores the summary and deletes the files', async () => {
    const db = await createTestDb();
    const { user, module, video } = await fixture(db);
    const backend = fakeBackend({ analyzeImages: '## Techniques\n\n- ...' });
    const dir = videoWorkDir(videosDir, video);
    const worker = makeWorker(db, backend, {
      downloadVideoImpl: async (v, dirRoot) => {
        const d = videoWorkDir(dirRoot, v);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'frame-01.jpg'), 'f');
        fs.writeFileSync(path.join(d, 'transcript.txt'), 'hello');
        return { title: 'T', channel: 'C', duration_seconds: 60, frames: [path.join(d, 'frame-01.jpg')], transcriptChars: 5 };
      },
    });
    await enqueueVideoJob(db, 'download_video', video, user.id);

    const downloaded = await worker.tick();
    expect(downloaded.type).toBe('download_video');
    expect(downloaded.status).toBe('complete');
    let row = await db.models.ModuleVideo.findByPk(video.id);
    expect(row.status).toBe('downloaded');
    expect(row.title).toBe('T');
    expect(row.duration_seconds).toBe(60);

    const analyzed = await worker.tick();
    expect(analyzed.type).toBe('analyze_video');
    expect(analyzed.status).toBe('complete');
    expect(analyzed.module_id).toBe(module.id);
    row = await db.models.ModuleVideo.findByPk(video.id);
    expect(row.status).toBe('complete');
    expect(row.summary).toContain('Techniques');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('download_video runs without an LLM account; analyze_video requires one', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'noaccount', llmAccount: false });
    const module = await insertModule(db, user.id, {});
    const video = (
      await db.models.ModuleVideo.create({
        module_id: module.id,
        user_id: user.id,
        video_id: YT_ID,
        url: youtubeUrl(YT_ID),
        status: 'pending',
      })
    ).get({ plain: true });
    const worker = makeWorker(db, fakeBackend(), {
      downloadVideoImpl: async (v, dirRoot) => {
        const d = videoWorkDir(dirRoot, v);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'frame-01.jpg'), 'f');
        return { title: 'T', channel: null, duration_seconds: 10, frames: ['frame-01.jpg'], transcriptChars: 0 };
      },
    });
    await enqueueVideoJob(db, 'download_video', video, user.id);
    const downloaded = await worker.tick();
    expect(downloaded.status).toBe('complete');

    // The chained analysis needs a model and this user has no account.
    const analyzed = await worker.tick();
    expect(analyzed.type).toBe('analyze_video');
    expect(analyzed.status).toBe('failed');
    expect(analyzed.error).toMatch(/no claude account/);
  });

  it('a failed download marks the video failed and keeps the error', async () => {
    const db = await createTestDb();
    const { user, video } = await fixture(db);
    const worker = makeWorker(db, fakeBackend(), {
      downloadVideoImpl: async () => {
        throw new Error('yt-dlp failed (exit 1): video unavailable');
      },
    });
    await enqueueVideoJob(db, 'download_video', video, user.id);
    const job = await worker.tick();
    expect(job.status).toBe('pending'); // retried
    const row = await db.models.ModuleVideo.findByPk(video.id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/video unavailable/);
  });

  it('a permanent download error fails the job on the first attempt', async () => {
    const db = await createTestDb();
    const { user, video } = await fixture(db);
    const worker = makeWorker(db, fakeBackend(), {
      downloadVideoImpl: async () => {
        const error = new Error('video is 3.0 hours long');
        error.permanent = true;
        throw error;
      },
    });
    await enqueueVideoJob(db, 'download_video', video, user.id);
    const job = await worker.tick();
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(1);
  });

  it('runs downloads one at a time while other job types keep flowing', async () => {
    const db = await createTestDb();
    const user = await createUser(db, { username: 'u' });
    const module = await insertModule(db, user.id, {});
    const mkVideo = async (videoId) =>
      (
        await db.models.ModuleVideo.create({
          module_id: module.id,
          user_id: user.id,
          video_id: videoId,
          url: youtubeUrl(videoId),
          status: 'pending',
        })
      ).get({ plain: true });
    const video1 = await mkVideo('AAAAAAAAAA1');
    const video2 = await mkVideo('AAAAAAAAAA2');

    // The first download parks on this gate so the queue state is stable
    // while the lane is probed.
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let concurrent = 0;
    let maxConcurrent = 0;
    const worker = makeWorker(db, fakeBackend(), {
      downloadVideoImpl: async (v, dirRoot) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate;
        concurrent -= 1;
        const d = videoWorkDir(dirRoot, v);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'frame-01.jpg'), 'f');
        return { title: 'T', channel: 'C', duration_seconds: 10, frames: [path.join(d, 'frame-01.jpg')], transcriptChars: 0 };
      },
      analyzeVideoImpl: async () => {},
    });
    await enqueueVideoJob(db, 'download_video', video1, user.id);
    await enqueueVideoJob(db, 'download_video', video2, user.id);
    // An unrelated job type queued behind both downloads.
    await enqueueVideoJob(db, 'analyze_video', video1, user.id);

    const first = worker.tick(); // claims video1's download and blocks in it
    for (let i = 0; i < 200; i += 1) {
      if (await db.models.Job.findOne({ where: { type: 'download_video', status: 'running' } })) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // The second download is held back while the first is live, but the
    // analyze job behind it still gets a worker.
    const other = await worker.tick();
    expect(other.type).toBe('analyze_video');
    expect(
      (await db.models.Job.findOne({ where: { type: 'download_video', status: 'pending' } })).id
    ).toBeTruthy();
    expect(await worker.tick()).toBeNull();

    release();
    expect((await first).status).toBe('complete');
    // With the lane free again the second download runs.
    const second = await worker.tick();
    expect(second.type).toBe('download_video');
    expect(second.status).toBe('complete');
    expect(maxConcurrent).toBe(1);
  });

  it('does not queue a second job for the same video while one is live', async () => {
    const db = await createTestDb();
    const { user, video } = await fixture(db);
    expect(await enqueueVideoJob(db, 'download_video', video, user.id)).not.toBeNull();
    expect(await enqueueVideoJob(db, 'download_video', video, user.id)).toBeNull();
    // A different type is fine.
    expect(await enqueueVideoJob(db, 'analyze_video', video, user.id)).not.toBeNull();
  });

  it('resetJobTarget walks the video status back with the job', async () => {
    const db = await createTestDb();
    const { user, video } = await fixture(db);
    await db.models.ModuleVideo.update({ status: 'analyzing' }, { where: { id: video.id } });
    const job = {
      type: 'analyze_video',
      payload: JSON.stringify({ video_id: video.id }),
      module_id: video.module_id,
      user_id: user.id,
    };
    await resetJobTarget(db, job, 'pending', 'requeued');
    let row = await db.models.ModuleVideo.findByPk(video.id);
    expect(row.status).toBe('downloaded');
    await resetJobTarget(db, job, 'cancelled', 'stopped by hand');
    row = await db.models.ModuleVideo.findByPk(video.id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('stopped by hand');
  });
});
