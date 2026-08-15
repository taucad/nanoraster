import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/napi-parity.test.mjs'],
    reporters: ['verbose'],
    testTimeout: 600_000,
  },
});
