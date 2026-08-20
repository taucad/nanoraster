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
// Handles-first build (R1 inversion): raw 918,110, gzip-9 366,755, brotli-11
// 291,245 on macOS, against 875,874 / 350,646 / 279,276 for the
// lossy-encoder-uplift build — +42,236 raw (+4.8%). That is the Renderer
// class surface in wasm-bindgen (class glue, JS result objects, the
// createRenderer request struct's serde), the plan executor with its
// pipelined readback, and per-view override resolution. Pixel and byte
// output are unchanged (verified against the previous build's addon).
// Ceilings are the measured figure plus ~1%. The gate runs on Linux CI, whose
// figure has not been re-measured since the PBR build (315,196 gzip-9 there
// against 312,881 on macOS) — gzip9 carries extra slack until a CI run
// re-anchors it.
const ceilings = { raw: 927_000, gzip9: 370_500, brotli11: 294_200 };

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
