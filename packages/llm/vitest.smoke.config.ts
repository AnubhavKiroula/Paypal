import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['smoke/**/*.smoke.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
