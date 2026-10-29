import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/napi-parity.test.mjs', 'tests/exits-cleanly.test.mjs'],
    reporters: ['verbose'],
    // Separate suites share one CI GPU; explicit concurrent-call tests remain.
    fileParallelism: false,
    testTimeout: 600_000,
  },
});
