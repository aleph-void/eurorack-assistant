// YouTube videos attached to a module: parsing the pasted link, downloading
// the video with yt-dlp, and turning it into something a text-and-image model
// can actually watch — frames sampled with ffmpeg plus the caption track
// flattened to a transcript. The video file itself is deleted the moment the
// frames are out of it; the frames and transcript live in a per-video work
// directory until the analysis has read them (services/videoAnalyzer.js).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { childEnv } from './llm.js';

// Everything a /api/modules response says about a video goes through this,
// so a video serializes identically on every endpoint.
export const videoJson = (v) => ({
  id: v.id,
  module_id: v.module_id,
  user_id: v.user_id,
  video_id: v.video_id,
  url: v.url,
  title: v.title,
  channel: v.channel,
  duration_seconds: v.duration_seconds,
  status: v.status,
  summary: v.summary,
  error: v.error,
  created_at: v.created_at,
  updated_at: v.updated_at,
});

// Nothing the user typed ever reaches yt-dlp: the pasted link is reduced to
// the 11-character video id, and the canonical URL is rebuilt from that. A
// link that is not recognizably a YouTube video yields null.
export function parseYoutubeId(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  const id = (value) => (/^[A-Za-z0-9_-]{11}$/.test(value ?? '') ? value : null);
  if (host === 'youtu.be') return id(parsed.pathname.split('/')[1]);
  if (host !== 'youtube.com' && host !== 'music.youtube.com') return null;
  const [, kind, rest] = parsed.pathname.split('/');
  if (kind === 'watch') return id(parsed.searchParams.get('v'));
  if (kind === 'shorts' || kind === 'live' || kind === 'embed' || kind === 'v') return id(rest);
  return null;
}

export const youtubeUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

// Each video's work files (frames, transcript) live in a directory named by
// the row id, so two users attaching the same video never share files.
export const videoWorkDir = (videosDir, video) => path.join(videosDir, String(video.id));

export function removeVideoFiles(videosDir, video) {
  fs.rmSync(videoWorkDir(videosDir, video), { recursive: true, force: true });
}

// A feature-length video is not a patch demo, and downloading one would tie
// a runner up for most of an attempt's time limit.
export const MAX_VIDEO_SECONDS = 2 * 60 * 60;

// How many frames the analysis looks at, spread evenly across the runtime.
export const FRAME_COUNT = 16;

// Runs `cmd args...` and resolves with stdout. The environment is the same
// allowlisted set the LLM CLIs get (no DATABASE_URL, no LLM_TOKEN_KEY) — not
// because yt-dlp reads untrusted instructions, but because no child of this
// server should carry its secrets. Injectable for tests, like llm.js's run.
export function runCommand(cmd, args, { cwd = undefined, timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd, env: childEnv() });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to run ${cmd}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      const said = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').trim();
      const detail = said.length > 800 ? `…${said.slice(-800)}` : said;
      reject(new Error(`${cmd} failed (exit ${code})${detail ? `:\n${detail}` : ''}`));
    });
  });
}

// The video's own metadata, without downloading it. Also the existence check:
// a dead or private link fails here, before any bytes move.
export async function fetchVideoMetadata(videoId, { run = runCommand } = {}) {
  const stdout = await run(
    'yt-dlp',
    ['--dump-single-json', '--no-download', '--no-playlist', '--no-warnings', youtubeUrl(videoId)],
    { timeoutMs: 2 * 60 * 1000 }
  );
  let meta;
  try {
    meta = JSON.parse(String(stdout).trim());
  } catch {
    throw new Error('yt-dlp returned unreadable video metadata');
  }
  return {
    title: String(meta.title ?? '').trim() || null,
    channel: String(meta.channel ?? meta.uploader ?? '').trim() || null,
    duration_seconds: Number.isFinite(Number(meta.duration))
      ? Math.round(Number(meta.duration))
      : null,
  };
}

// A caption track (WebVTT) flattened to plain text. Auto-generated captions
// roll: each cue repeats the previous line before adding the next, and words
// arrive wrapped in per-word timing tags — both are stripped so the
// transcript reads as prose rather than as a stutter.
export function vttToTranscript(vtt) {
  const lines = [];
  let inHeader = true;
  for (const raw of String(vtt ?? '').split('\n')) {
    const line = raw
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (inHeader) {
      // The header ends at the first blank line; everything in it (WEBVTT,
      // Kind:, Language:) is not speech.
      if (line === '') inHeader = false;
      continue;
    }
    if (line === '' || line.includes('-->') || /^\d+$/.test(line)) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(line)) continue;
    if (line !== lines[lines.length - 1]) lines.push(line);
  }
  return lines.join('\n').trim();
}

// Download one attached video and reduce it to what the analysis reads:
// frame-NN.jpg stills plus transcript.txt in the video's work directory. The
// video file itself is deleted here, as soon as the frames are out — it is by
// far the largest artifact and nothing else ever needs it.
//
// Returns { title, channel, duration_seconds, frames, transcriptChars }.
export async function downloadVideoForModule(video, videosDir, { run = runCommand, log = () => {} } = {}) {
  const meta = await fetchVideoMetadata(video.video_id, { run });
  if (meta.duration_seconds && meta.duration_seconds > MAX_VIDEO_SECONDS) {
    const hours = (meta.duration_seconds / 3600).toFixed(1);
    const error = new Error(
      `video is ${hours} hours long — only videos up to ${MAX_VIDEO_SECONDS / 3600} hours are analyzed`
    );
    // No retry will make the video shorter.
    error.permanent = true;
    throw error;
  }
  log(`video found: '${meta.title ?? video.video_id}' (${meta.channel ?? 'unknown channel'})`);

  // A retry starts clean rather than on top of a half-download.
  const dir = videoWorkDir(videosDir, video);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Capped at 480p: the frames are downscaled to 640px anyway, and the
  // download is the slow part. English captions (hand-written or
  // auto-generated) ride along when the video has them.
  log('downloading video and captions');
  await run(
    'yt-dlp',
    [
      '--no-playlist',
      '--no-warnings',
      '-f', 'bv*[height<=480]+ba/b[height<=480]/b',
      '-o', 'video.%(ext)s',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', 'en.*,en',
      '--sub-format', 'vtt',
      youtubeUrl(video.video_id),
    ],
    { cwd: dir }
  );
  const files = fs.readdirSync(dir);
  const media = files.find((f) => f.startsWith('video.') && !f.endsWith('.vtt'));
  if (!media) throw new Error('yt-dlp finished without producing a video file');

  const caption = files.find((f) => f.endsWith('.vtt'));
  let transcriptChars = 0;
  if (caption) {
    const transcript = vttToTranscript(fs.readFileSync(path.join(dir, caption), 'utf-8'));
    if (transcript) {
      fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript);
      transcriptChars = transcript.length;
    }
    fs.rmSync(path.join(dir, caption), { force: true });
  }
  log(
    transcriptChars > 0
      ? `transcript saved: ${transcriptChars} characters`
      : 'no English captions on this video; the analysis works from the frames alone'
  );

  // FRAME_COUNT stills, evenly spaced. Without a known duration, one frame
  // every 30 seconds until the cap is a serviceable guess.
  const interval = Math.max(
    1,
    meta.duration_seconds ? Math.floor(meta.duration_seconds / FRAME_COUNT) || 1 : 30
  );
  await run(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel', 'error',
      '-y',
      '-i', media,
      '-vf', `fps=1/${interval},scale=640:-2`,
      '-frames:v', String(FRAME_COUNT),
      '-q:v', '3',
      'frame-%02d.jpg',
    ],
    { cwd: dir }
  );
  fs.rmSync(path.join(dir, media), { force: true });
  const frames = fs
    .readdirSync(dir)
    .filter((f) => /^frame-\d+\.jpg$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
  if (frames.length === 0 && transcriptChars === 0) {
    throw new Error('the video yielded neither frames nor a transcript to analyze');
  }
  log(`sampled ${frames.length} frame(s), one every ${interval}s; video file deleted`);
  return { ...meta, frames, transcriptChars };
}
