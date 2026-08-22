import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { plugin } from './tools/eslint-plugin/index.js';

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'docs-site/.next/**',
      'docs-site/.source/**',
      'docs-site/out/**',
      'docs-site/public/demo/render_wasm.d.ts',
      'docs-site/public/demo/render_wasm.js',
      'node_modules/**',
      'npm/**',
      'rust/target/**',
      // Third-party crates vendored with a nanoraster patch; their prose is upstream's.
      'rust/vendor/**',
      'src/native/**',
      'src/wasm/**',
      // Generated build outputs: the bench-enabled wasm sibling lands here.
      'tests/out/**',
    ],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.{cjs,js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['tests/browser/render.browser.test.mjs', 'tests/browser/worker.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: tseslint.configs.strictTypeChecked,
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test-d.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.{cjs,js,mjs,ts,tsx}'],
    plugins: { nanoraster: plugin },
    rules: { 'nanoraster/jsdoc-quality': 'error' },
  },
);
