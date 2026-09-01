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
const { name: rootName } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  name: string;
};
const distribution = resolve(ROOT, 'dist/index.mjs');
// The JS figure needs a built entrypoint; `pnpm run build` at the repo root produces one.
const distributionTest = existsSync(distribution) ? it : it.skip;

type PublishedManifest = { optionalDependencies?: Record<string, string> };

/**
 * Read one registry document the way `scripts/measure-sizes.mjs` does, returning `undefined`
 * when the registry is unreachable or serves no such version, so an offline run skips the
 * coverage assertion rather than failing it.
 */
const registry = async (path: string): Promise<PublishedManifest | undefined> => {
  try {
    const response = await fetch(`https://registry.npmjs.org/${path}`, {
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok ? ((await response.json()) as PublishedManifest) : undefined;
  } catch {
    return undefined;
  }
};

describe('published size figures', () => {
  it('quotes the wasm payload the site actually serves', () => {
    expect(sizes.wasm).toEqual({
      raw: wasm.byteLength,
      gzip: gzipSync(wasm, { level: 9 }).byteLength,
      brotli: brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
    });
  }, 15_000);

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
  it('should quote only platforms compatibility.md documents', () => {
    const measured = Object.keys(sizes.native).toSorted();
    expect(measured).toEqual(
      documentedPlatforms.filter((platform) => measured.includes(platform)).toSorted(),
    );
    expect(measured).not.toEqual([]);
    for (const bytes of Object.values(sizes.native)) expect(bytes).toBeGreaterThan(1_000_000);
  });

  // Documenting a subset is only correct while the release itself ships that subset. Once
  // `sizes.json` names a published version, its keys must be that release's own optional
  // dependencies — no platform quoted that the release never published, and none of its
  // platforms silently dropped.
  it('should measure every platform its recorded release published', async ({ skip }) => {
    const published = await registry(`${rootName}/${sizes.version}`);
    if (published === undefined) {
      skip(`registry did not serve ${rootName}@${sizes.version}; nothing to compare the keys against`);
      return;
    }

    const prefix = `${rootName}-`;
    const expected = Object.keys(published.optionalDependencies ?? {})
      .map((name) => name.slice(prefix.length))
      .toSorted();

    expect(expected).not.toEqual([]);
    expect(Object.keys(sizes.native).toSorted()).toEqual(expected);
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
