import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Tests must never write into the developer's real DevPilot home, so every run gets a
 * throwaway DEVPILOT_HOME. Integration tests spawn `dist/index.js`, which inherits it.
 */
export default defineConfig(() => ({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    env: {
      DEVPILOT_HOME: path.join(os.tmpdir(), `devpilot-test-home-${process.pid}`),
    },
  },
}));
