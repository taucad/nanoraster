import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['api-coverage.test.ts', 'demo-projection.test.ts', 'sizes.test.ts', 'components/**/*.test.ts'],
  },
});
