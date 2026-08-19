// Video analysis: submit an attached YouTube video — as the frames and
// transcript the download job left in the work directory — to the LLM
// backend, and store a markdown summary of the techniques it demonstrates on
// the module's video row. The work files are the caller's to delete once
// this has succeeded (jobs/handlers.js does, so retries can re-read them).

import fs from 'node:fs';
import path from 'node:path';
import { videoWorkDir } from './videos.js';

// A transcript longer than this is cut. Frames still cover the whole runtime,
// so the summary loses wording, not coverage.
export const MAX_TRANSCRIPT_CHARS = 60000;

const minutes = (seconds) =>
  Number.isFinite(Number(seconds)) && seconds > 0 ? `${Math.round(seconds / 60)} minute` : null;

export function buildVideoPrompt(module, video, { frameCount, transcript }) {
  const length = minutes(video.duration_seconds);
  let prompt =
    `You are analyzing a YouTube video about a Eurorack modular synthesizer ` +
    `module: ${module.manufacturer} ${module.name}.\n` +
    `Video: "${video.title || video.url}"` +
    (video.channel ? ` by ${video.channel}` : '') +
    (length ? ` (about ${length}s long)` : '') +
    `.\n`;
  if (module.summary) {
    prompt += `\nWhat the module does, from its manual:\n${module.summary}\n`;
  }
  prompt +=
    `\nThe video is attached as ${frameCount} still frame(s) sampled evenly across ` +
    `its runtime, in chronological order` +
    (transcript ? `, together with its spoken transcript below` : '; it has no transcript') +
    `.\n\n` +
    `Write a markdown summary of the techniques the video demonstrates on this ` +
    `module. For each distinct technique or patch shown:\n` +
    `- give it a short heading,\n` +
    `- describe the patch: which of the module's jacks and controls are used, ` +
    `what is connected where, and roughly what settings are dialed in,\n` +
    `- say what the technique achieves musically and why it works.\n` +
    `Describe only what the video actually shows or says — do not pad the list ` +
    `with generic uses of the module. If the video turns out not to feature ` +
    `this module, say so plainly instead of inventing techniques. Output only ` +
    `the markdown summary, with no preamble.\n`;
  if (transcript) {
    prompt += `\n--- Transcript ---\n\n${transcript}\n`;
  }
  return prompt;
}

// Read the work files, ask the model, and persist the summary on the video
// row (status 'complete'). Returns { summary, frames }.
export async function analyzeVideoForModule(db, backend, module, video, videosDir, { log = () => {} } = {}) {
  const dir = videoWorkDir(videosDir, video);
  const frames = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /^frame-\d+\.jpg$/.test(f))
        .sort()
        .map((f) => path.join(dir, f))
    : [];
  const transcriptPath = path.join(dir, 'transcript.txt');
  let transcript = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, 'utf-8') : '';
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n[transcript cut here]`;
  }
  if (frames.length === 0 && !transcript) {
    throw new Error(
      'the downloaded video files are gone — run the download again to re-fetch them'
    );
  }

  log(
    `asking the model about ${frames.length} frame(s)` +
      (transcript ? ` and a ${transcript.length}-character transcript` : '')
  );
  const prompt = buildVideoPrompt(module, video, { frameCount: frames.length, transcript });
  // A video with no usable frames (an audio-only upload) is analyzed from
  // the transcript alone.
  const answer =
    frames.length > 0
      ? await backend.analyzeImages(prompt, frames)
      : await backend.completeText(prompt);
  const summary = String(answer ?? '').trim();
  if (!summary) throw new Error('LLM video analysis returned an empty summary');

  await db.models.ModuleVideo.update(
    { summary, status: 'complete', error: null },
    { where: { id: video.id } }
  );
  return { summary, frames: frames.length };
}
