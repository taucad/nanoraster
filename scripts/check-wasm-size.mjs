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
// Lossy-WebP build: raw 849,626, gzip-9 339,013, brotli-11 270,244 on macOS,
// against 809,035 / 323,275 / 258,177 for the configurable-lighting build —
// +40,591 raw (+5.0%), +15,738 gzip-9 (+4.9%). That is the vendored
// image-webp main VP8 lossy encoder (linked even for lossless requests: the
// runtime `use_lossy` branch keeps it reachable) plus its lossless-encoder
// refactors.
// Ceilings are the measured figure plus ~1%. The gate runs on Linux CI, whose
// figure has not been re-measured since the PBR build (315,196 gzip-9 there
// against 312,881 on macOS) — gzip9 carries extra slack until a CI run
// re-anchors it.
const ceilings = { raw: 858_000, gzip9: 343_000, brotli11: 273_000 };

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
