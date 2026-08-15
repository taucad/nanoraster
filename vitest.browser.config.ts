import { resolve } from 'node:path';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const providers = {
  chromium: {
    browser: 'chromium',
    provider: playwright({
      launchOptions: { args: ['--enable-unsafe-webgpu'] },
    }),
  },
  firefox: {
    browser: 'firefox',
    provider: playwright({
      launchOptions: {
        firefoxUserPrefs: {
          'dom.webgpu.enabled': true,
          'gfx.webgpu.force-enabled': true,
        },
      },
    }),
  },
  webkit: { browser: 'webkit' },
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
