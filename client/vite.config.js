import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // The Whisper worker pulls transformers.js in on its own, so it has to be a
  // module worker — the default IIFE format cannot be split into chunks.
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    // jsdom 30 gained PointerEvent, which @vue/test-utils writes to
    // twice; see tests/eventProps.js.
    setupFiles: ['./tests/eventProps.js'],
    // Node 26 ships its own Web Storage, which puts `localStorage` and
    // `sessionStorage` on the global BEFORE jsdom is installed — and vitest
    // leaves a global that already exists alone, so the window's real
    // Storage never lands. `localStorage` is then the undefined a Node
    // started without --localstorage-file hands back, and every test that
    // clears it dies on the dot. Turn Node's off and jsdom's is the only
    // one there is, which is what a browser test means by localStorage.
    // Accepted as far back as Node 22, so it is safe on the whole matrix.
    execArgv: ['--no-experimental-webstorage'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js', 'src/**/*.vue'],
      // Bootstrap file and the Whisper worker (runs off-thread, in a worker
      // context jsdom does not provide).
      exclude: ['src/main.js', 'src/whisperWorker.js', 'src/whisperWorkerFactory.js'],
    },
  },
});
