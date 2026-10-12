import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves the app from https://<user>.github.io/evenly/
  base: '/evenly/',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
