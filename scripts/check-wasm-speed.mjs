// Wasm speed ratchet. `130ce4e` set `profile.release.package.render-core.
// opt-level="z"` in the wasm build and shipped a 2.4x encode regression that
// every byte-for-byte correctness gate in this repository passed, because the
// output never changed — only the time it took. This is the gate that would
// have caught it.
//
// What it measures: the codec stages, on a procedural frame, in plain Node.
// The encoders are the CPU-bound half of a render and the half the build flag
// reached (codec generics monomorphise into `render-core`, and per-crate
// opt-level overrides do not fully apply under fat LTO). Timing them needs no
// adapter, no browser and no GLB, so the numbers carry no GPU noise at all.
// `bench_fixture_encodes` lives behind the default-off `bench` cargo feature,
// so this runs on the sibling build `pnpm run build:wasm:bench` produces —
// same source, same release profile, same optimizer as the shipped artifact.
//
// What it gates: lossless WebP encode time divided by PNG encode time, from
// the same process on the same frame. A ratio, not a stopwatch reading,
// because an absolute cap has to clear the slowest CI runner and by then it is
// too loose to see a 2.4x regression. PNG spends its time inside the `png` and
// `flate2` crates, which the flag did not reach; lossless WebP is the encoder
// whose generics land in `render-core`, and it carries the regression.
//
// Measured 2026-09-01 on an M-series macOS host, seven samples after a
// discarded warmup, `768x432` (this package's default output size):
//
//   O3 (shipped):  webp 2.75-2.80 ms, png 24.1-25.9 ms, ratio 0.108-0.114
//   -Oz (the bug): webp 7.20-7.30 ms, png 23.7-24.3 ms, ratio 0.301-0.303
//
// PNG barely moves between the two, which is what makes it a usable yardstick.
// The 0.20 ceiling sits about 1.7x above the good build and about 1.5x below
// the bad one — headroom for a host whose codec mix weighs differently,
// without giving up the signal. Re-anchor it only against a fresh pair of
// measurements like the ones above, never to make a red build green.
//
//   node scripts/check-wasm-speed.mjs [directory]
//
// `directory` defaults to the bench sibling's output; pass another build's
// output directory to compare two artifacts.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WIDTH = 768;
const HEIGHT = 432;
const WARMUP_SAMPLES = 1;
const SAMPLES = 7;
const CEILING = 0.2;

const directory = resolve(process.argv[2] ?? 'tests/out/wasm-bench');
const glue = await import(pathToFileURL(resolve(directory, 'render_wasm.js')).href);
if (typeof glue.bench_fixture_encodes !== 'function') {
  throw new Error(`${directory} exports no bench_fixture_encodes; build it with --features bench`);
}
// `initSync` takes the bytes directly, so the web-target glue never reaches for
// `fetch`, which has no file:// transport in Node.
glue.initSync({ module: await readFile(resolve(directory, 'render_wasm_bg.wasm')) });

const samples = [];
for (let index = 0; index < WARMUP_SAMPLES + SAMPLES; index += 1) {
  const report = JSON.parse(glue.bench_fixture_encodes(WIDTH, HEIGHT));
  if (index >= WARMUP_SAMPLES) samples.push(report);
}

const distribution = (codec) => {
  const values = samples.map((sample) => sample[codec].ms).sort((left, right) => left - right);
  return { min: values[0], p50: values[values.length >> 1], max: values.at(-1) };
};
const codecs = Object.fromEntries(['png', 'webp', 'jpeg'].map((codec) => [codec, distribution(codec)]));
if (!(codecs.png.p50 > 0)) throw new Error(`png encode measured ${codecs.png.p50}ms; the clock is unusable`);
const ratio = Math.round((codecs.webp.p50 / codecs.png.p50) * 10_000) / 10_000;

console.log(
  JSON.stringify({ frame: [WIDTH, HEIGHT], samples: SAMPLES, codecs, ratio, ceiling: CEILING }, null, 2),
);
if (ratio > CEILING) {
  throw new Error(
    `render WASM lossless-WebP encode is ${ratio} of its PNG encode, above ${CEILING}: ` +
      `webp ${codecs.webp.p50}ms against png ${codecs.png.p50}ms. ` +
      'A size-first optimization level on render-core reads exactly like this.',
  );
}
