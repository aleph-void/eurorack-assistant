// One line, its own file. The bundler only recognises a worker when it sees
// `new Worker(new URL(...))` written out literally, and keeping it here means
// whisperInput.js can reach it through a dynamic import — so nothing about
// Whisper is fetched by a rack owner who never turns it on.

export const createWhisperWorker = () =>
  new Worker(new URL('./whisperWorker.js', import.meta.url), { type: 'module' });
