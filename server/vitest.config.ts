import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many tests spawn real svn/git subprocesses; the 5s default flaked
    // under full-suite parallel load (different cases each run).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
