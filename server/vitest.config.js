import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js'],
      // Process entry point and one-shot operator scripts: no behaviour of
      // their own worth asserting, and they exit/listen on import.
      exclude: ['src/index.js', 'scripts/**'],
    },
  },
});
