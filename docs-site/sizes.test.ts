import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { formatSize } from './components/size-strip';
import sizes from './lib/sizes.json';

const ROOT = resolve(import.meta.dirname, '..');
/** Platform suffixes the repository's compatibility matrix documents; prose repeats some names. */
const documentedPlatforms = [
  ...new Set(
    [...readFileSync(resolve(ROOT, 'compatibility.md'), 'utf8').matchAll(/`nanoraster-([\w-]+)`/gu)].map(
      ([, platform]) => platform,
    ),
  ),
];
const wasm = readFileSync(resolve(import.meta.dirname, 'public/demo/render_wasm_bg.wasm'));
const distribution = resolve(ROOT, 'dist/index.mjs');
// The JS figure needs a built entrypoint; `pnpm run build` at the repo root produces one.
const distributionTest = existsSync(distribution) ? it : it.skip;

describe('published size figures', () => {
  it('quotes the wasm payload the site actually serves', () => {
    expect(sizes.wasm).toEqual({
      raw: wasm.byteLength,
      gzip: gzipSync(wasm, { level: 9 }).byteLength,
      brotli: brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
    });
  });

  distributionTest('quotes the built JavaScript entrypoint, when dist/index.mjs exists', () => {
    const javascript = readFileSync(distribution);
    expect(sizes.js).toEqual({
      raw: javascript.byteLength,
      gzip: gzipSync(javascript, { level: 9 }).byteLength,
    });
  });

  // `measure-sizes.mjs` derives these keys from the published root manifest's optional
  // dependencies, so they trail the registry: a subset of the documented platforms until a
  // release publishes them all, and the whole set afterwards. Either way the site never quotes
  // a platform the compatibility matrix does not document.
  it('carries a plausible native footprint for every published platform', () => {
    const measured = Object.keys(sizes.native).toSorted();
    expect(measured).toEqual(
      documentedPlatforms.filter((platform) => measured.includes(platform)).toSorted(),
    );
    expect(measured).not.toEqual([]);
    for (const bytes of Object.values(sizes.native)) expect(bytes).toBeGreaterThan(1_000_000);
  });

  it('measures the platform the size strip quotes', () => {
    expect(sizes.native).toHaveProperty('darwin-arm64');
  });

  it('formats bytes as the strip prints them', () => {
    expect([252_013, 7_020_882, 325].map(formatSize)).toEqual(['252 KB', '7.0 MB', '0.3 KB']);
  });
});

const staticOutputTest = process.env['VERIFY_STATIC_OUTPUT'] === 'true' ? it : it.skip;

describe('static homepage', () => {
  staticOutputTest('prints the measured sizes', () => {
    const html = readFileSync(resolve(import.meta.dirname, 'out/index.html'), 'utf8');
    const figures = [
      formatSize(sizes.wasm.brotli),
      formatSize(sizes.native['darwin-arm64']),
      formatSize(sizes.js.gzip),
    ];
    for (const figure of figures) expect(html).toContain(figure);
  });
});
