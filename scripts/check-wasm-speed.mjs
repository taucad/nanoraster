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
//
// The ratio is steadier than either timing, but it is not architecture-free:
// the two codecs lean on SIMD differently, so the same good artifact reads
// 0.11 on arm64 macOS and 0.207 on CI's x86_64 Linux runner (png 41.71 ms,
// webp 8.65 ms). That spread is as wide as the regression itself, so a single
// global ceiling cannot separate both hosts: anything loose enough to pass a
// good Linux build (0.207) would also pass a bad macOS one (0.30). The
// ceiling is therefore calibrated per platform, against measurements taken on
// that platform, and an unmeasured host falls back to the loosest known bound
// — still a gate, just a weaker one, and better than a false red on a machine
// nobody has characterised. Re-anchor an entry only against a fresh good/bad
// pair measured on that platform, never to make a red build green.
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
// Measured good build → nearest bad build, per platform. Each ceiling sits
// roughly midway in log terms: ~1.7x above the good reading, ~1.5x below the
// bad one. `linux-x64`'s bad figure is projected from the 2.6x WebP-side cost
// measured on `darwin-arm64`, since the `-Oz` artifact was only ever built
// here; tighten it once a bad build is measured on that runner.
const CEILINGS = {
  'darwin-arm64': 0.2, // good 0.11, bad 0.30 (both measured)
  'linux-x64': 0.35, // good 0.207 (measured), bad ~0.54 (projected)
};
const platform = `${process.platform}-${process.arch}`;
const CEILING = CEILINGS[platform] ?? Math.max(...Object.values(CEILINGS));

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
// The raw ratio decides; only the log is rounded, so 0.20004 cannot round its
// way under its ceiling.
const ratio = codecs.webp.p50 / codecs.png.p50;
const reported = Math.round(ratio * 10_000) / 10_000;

console.log(
  JSON.stringify(
    { frame: [WIDTH, HEIGHT], platform, samples: SAMPLES, codecs, ratio: reported, ceiling: CEILING },
    null,
    2,
  ),
);
if (ratio > CEILING) {
  throw new Error(
    `render WASM lossless-WebP encode is ${reported} of its PNG encode, above ${CEILING}: ` +
      `webp ${codecs.webp.p50}ms against png ${codecs.png.p50}ms. ` +
      'A size-first optimization level on render-core reads exactly like this.',
  );
}
