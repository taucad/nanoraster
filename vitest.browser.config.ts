import { resolve } from 'node:path';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const providers = {
  chromium: {
    browser: 'chromium',
    headless: true,
    provider: playwright({
      launchOptions: { args: ['--enable-unsafe-webgpu'] },
    }),
  },
  firefox: {
    browser: 'firefox',
    headless: false,
    provider: playwright({
      launchOptions: {
        firefoxUserPrefs: {
          'dom.webgpu.enabled': true,
          'gfx.webgpu.force-enabled': true,
        },
      },
    }),
  },
  webkit: { browser: 'webkit', headless: false },
} as const;

const requestedBrowser = process.env['BROWSER'];
if (requestedBrowser && !(requestedBrowser in providers)) {
  throw new Error(`unsupported BROWSER: ${requestedBrowser}`);
}
const instances = requestedBrowser
  ? [providers[requestedBrowser as keyof typeof providers]]
  : [providers.chromium, providers.firefox, providers.webkit];

export default defineConfig({
  resolve: {
    alias: {
      'nanoraster-wasm-candidate': resolve(
        process.env['NANORASTER_WASM_MODULE'] ?? 'src/wasm/render_wasm.js',
      ),
      // The `bench` cargo feature is default-off, so the codec-conformance
      // export exists only on this sibling build of the same source
      // (`pnpm run build:wasm:bench`; CI builds and uploads it alongside the
      // candidate).
      'nanoraster-wasm-bench': resolve(
        process.env['NANORASTER_BENCH_WASM_MODULE'] ?? 'tests/out/wasm-bench/render_wasm.js',
      ),
    },
  },
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances,
    },
    hookTimeout: 120_000,
    include: ['tests/browser/**/*.browser.test.mjs'],
    reporters: ['verbose'],
    testTimeout: 120_000,
  },
});
