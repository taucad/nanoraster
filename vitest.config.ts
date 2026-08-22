import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'tests/import-graph.test.mjs',
      'tests/packaging.test.mjs',
      'prose-quality.test.ts',
      'readme-shape.test.ts',
    ],
    coverage: {
      exclude: ['src/**/*.{test,spec}.ts', 'src/native/**', 'src/wasm/**', '**/*.test-d.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
    environment: 'node',
    reporters: ['verbose'],
    typecheck: {
      enabled: true,
      include: ['src/**/*.test-d.ts'],
    },
  },
});
