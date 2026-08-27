import { readFile } from 'node:fs/promises';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const wasm = await readFile(new URL('../src/wasm/render_wasm_bg.wasm', import.meta.url));
const font = await readFile(new URL('../rust/render-core/assets/geist/Geist-Regular.ttf', import.meta.url));
const sizes = {
  raw: wasm.byteLength,
  gzip9: gzipSync(wasm, { level: 9 }).byteLength,
  brotli11: brotliCompressSync(wasm, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength,
};
// The docs homepage quotes these same bytes; docs-site/scripts/measure-sizes.mjs republishes them.
// Configurable-lighting build (R3/R4): raw 809,035, gzip-9 323,275, brotli-11
// 258,177 on macOS, against 794,292 / 316,050 / 252,493 for the studio-only
// build before it — +14,743 raw (+1.9%), +7,225 gzip-9 (+2.3%). That is the
// `lighting` request struct's serde monomorphisation plus the serde_json
// Value hop the custom Deserialize takes to keep field-level error messages;
// the WGSL source ships verbatim, so the uniform rig itself is ~0.6 KB of it.
// Lossy-encoder-uplift build: raw 875,874, gzip-9 350,646, brotli-11 279,276
// on macOS, against 849,970 / ~339,100 / ~270,300 for the lossy-WebP build —
// +25,904 raw (+3.0%). That is the vendored encoder's RD mode chooser
// (I16 + 4x4 B_PRED search), skip flags, and the quality/filter tables,
// plus ~0.5 KB of review-driven hardening (quality validation as an error,
// overflow-proof quantizer arithmetic).
// The lossy-WebP build before it was +40,591 raw (+5.0%) over the
// configurable-lighting build for the VP8 lossy encoder itself.
// Handles-first build (R1 inversion): raw 918,021, gzip-9 366,752, brotli-11
// 291,416 on macOS, against 875,874 / 350,646 / 279,276 for the
// lossy-encoder-uplift build — +42,147 raw (+4.8%). That is the Renderer
// class surface in wasm-bindgen (class glue, JS result objects, the
// createRenderer request struct's serde), the plan executor with its
// pipelined readback, and per-view override resolution. Pixel and byte
// output are unchanged (verified against the previous build's addon).
// Structured-AdapterInfo build (W5): raw 915,476, gzip-9 366,233, brotli-11
// 289,985 on macOS, against 918,021 / 366,752 / 291,416 for the handles-first
// build — -2,545 raw (-0.3%). The browser reads `navigator.gpu` in TypeScript
// now, so `describe_adapter` and its wasm-bindgen glue are gone from here.
// Bench-feature-gated build (W6): raw 864,783, gzip-9 347,393, brotli-11
// 278,385 on macOS, against 915,476 / 366,233 / 289,985 for the structured-
// AdapterInfo build — -50,693 raw (-5.5%). `bench_codecs`, `bench_multi_view`
// and `codec_conformance` now sit behind the default-off `bench` cargo
// feature, taking their wasm-bindgen glue, the encode-timing loop, the
// six-view comparison harness and its serde_json report building with them.
// Codec-fingerprint build: raw 867,084, gzip-9 348,810, brotli-11 278,640 on
// macOS, against 864,783 / 347,393 / 278,385 for the bench-feature-gated build
// — +2,301 raw (+0.3%) for the restored Huffman tie-break and the conformance
// table's lossy-WebP arm. Measured after the fact, from a rebuild of that
// tree: the wave landed without re-anchoring this log, which is why the next
// entry is stated against this line rather than against W6.
// Raw-output build (X1): raw 857,495, gzip-9 344,892, brotli-11 276,011 on
// macOS, against 867,084 / 348,810 / 278,640 for the codec-fingerprint build
// — -9,589 raw (-1.1%). `format: "raw"` is one identity arm in the encoder, so
// the shrink is the deleted raw-pixels entry points: the wasm-bindgen glue for
// the class method and the free function, their JS result object, and the
// core's format-free pixels request path. Rendered bytes are unchanged.
// Stable-toolchain build: raw 751,233, gzip-9 307,369, brotli-11 249,284 on
// macOS with Rust 1.98.0 / LLVM 22.1.8, wasm-pack 0.15.0, and Binaryen 132
// `-Oz`, against 857,495 / 344,892 / 276,011 from Rust 1.88.0 / LLVM 20.1.5,
// wasm-pack 0.13.1, and its bundled Binaryen 117 — -106,262 raw (-12.4%),
// -37,523 gzip-9 (-10.9%), and -26,727 brotli-11 (-9.7%). wasm-pack 0.15 still
// bundles Binaryen 117, so `scripts/build-wasm.mjs` deliberately skips that
// optimizer and runs the exact-pinned Binaryen development dependency.
// Ceilings are the measured figure plus ~1%. The gate runs on Linux CI, whose
// figure has not been re-measured since the PBR build (315,196 gzip-9 there
// against 312,881 on macOS) — gzip9 carries extra slack until a CI run
// re-anchors it.
const ceilings = { raw: 759_000, gzip9: 311_000, brotli11: 252_000 };

for (const marker of ['fontdue', 'Geist Regular']) {
  if (wasm.includes(Buffer.from(marker))) {
    throw new Error(`render WASM unexpectedly embeds runtime font marker ${JSON.stringify(marker)}`);
  }
}
// A linked full TTF is emitted as a contiguous data segment. Pin a long,
// interior source slice so the ratchet detects that accidental inclusion even
// if compiler metadata strips the font's human-readable name table.
if (wasm.includes(font.subarray(4096, 4224))) {
  throw new Error('render WASM unexpectedly embeds the full Geist TTF');
}

console.log(JSON.stringify({ sizes, ceilings }, null, 2));
for (const [kind, ceiling] of Object.entries(ceilings)) {
  if (sizes[kind] > ceiling) {
    throw new Error(`render WASM ${kind} size ${sizes[kind]} exceeds ${ceiling}`);
  }
}
