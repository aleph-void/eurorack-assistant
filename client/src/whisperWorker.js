// Whisper in a worker. It holds one pipeline for the life of the page, so the
// model is fetched and compiled once and every command after the first is
// quick.
//
// transformers.js is imported here and nowhere else, and this file is only
// ever loaded when someone actually picks Whisper — so a rack owner using the
// browser recogniser never downloads any of it.

let pipelinePromise = null;
let loadedModel = null;

async function getPipeline(model) {
  if (pipelinePromise && loadedModel === model) return pipelinePromise;
  loadedModel = model;
  pipelinePromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // Self-hosting the weights: drop the model folder under the client's
    // public/ directory and set VITE_WHISPER_MODEL_PATH, and nothing is
    // fetched from the internet at all.
    const localPath = import.meta.env?.VITE_WHISPER_MODEL_PATH;
    if (localPath) {
      env.allowRemoteModels = false;
      env.localModelPath = localPath;
    }
    return pipeline('automatic-speech-recognition', model, { dtype: 'q8' });
  })();
  return pipelinePromise;
}

self.onmessage = async ({ data }) => {
  const { id, model, samples } = data || {};
  try {
    const transcriber = await getPipeline(model || 'Xenova/whisper-tiny.en');
    const output = await transcriber(samples, { chunk_length_s: 30, return_timestamps: false });
    self.postMessage({ id, text: (output?.text || '').trim() });
  } catch (e) {
    self.postMessage({ id, error: e?.message || 'Whisper failed' });
  }
};
