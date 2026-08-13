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
  },
});
