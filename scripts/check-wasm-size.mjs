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
// Stable-toolchain main baseline: raw 751,233, gzip-9 307,369, brotli-11
// 249,284 on macOS with Rust 1.98.0 / LLVM 22.1.8, wasm-pack 0.15.0, and
// Binaryen 132 `-Oz`. This is the recorded main artifact before the camera,
// presentation, and topology programs below; retain it as the long-range base.
// Cartesian-camera build: raw 931,986, gzip-9 369,380, brotli-11 294,978 on
// macOS, against 857,495 / 344,892 / 276,011 for the raw-output build —
// +74,491 raw (+8.7%), +24,488 gzip-9 (+7.1%), +18,967 brotli-11 (+6.9%).
// This is the strict fitted/fixed camera request graph and its perspective,
// orthographic, clipping, and line-width render paths. No post-process pass or
// antialiasing mode was added; native and browser pixels use the existing 4x
// MSAA target. The gates below retain ~1% admission slack.
// Presentation-view build: raw 1,369,523, gzip-9 510,754, brotli-11 396,127 on
// macOS, against 931,986 / 369,380 / 294,978 for the Cartesian-camera build —
// +437,537 raw (+46.9%), +141,374 gzip-9 (+38.3%), +101,149 brotli-11 (+34.3%).
// The increase is the pinned i_triangle/i_overlay exact polygon boolean and
// triangulation path plus source selection, section cap, clipping, and shader
// code. The public facade remains below 0.5 KB Brotli; the WASM stays below
// 400 KB Brotli. Native, WASM, section degeneracy, and route gates cover the
// admitted dependency before this ratchet moves.
// Presentation base after the wide-FOV follow-ups: raw 1,253,048, gzip-9
// 473,792, brotli-11 366,020. Paired-halfedge traversal plus browser-only
// render-core size optimisation: 1,136,902 / 454,642 / 361,654 (-116,146 raw,
// -19,150 gzip-9, -4,366 brotli-11). The Brotli ceiling is the base plus the
// accepted 5 KB P0 budget.
// EXT_mesh_manifold trust-boundary validation: 1,203,046 / 474,602 / 375,135,
// against a paired P0 worktree at 1,136,364 / 454,313 / 361,588 — +66,682 raw,
// +20,289 gzip-9, +13,547 brotli-11. The Brotli ceiling enforces the accepted
// 15 KB P1 budget over that exact base.
// Rust-core closeout hardening: 1,207,761 / 481,705 / 377,159 — +4,715 raw,
// +7,103 gzip-9, +2,024 brotli-11 for bounded topology work, fail-closed shell
// ownership, lazy optional topology, and cap diagnostics. These exact measured
// values replace the former 1,270,000 raw ceiling's 5.6% slack.
// Draw-aware wireframe bias: 1,207,843 / 481,817 / 377,128 — +82 raw for
// keying the surface polygon offset on line geometry actually drawing (model
// edges enabled, or a section boundary) instead of on `options.lines` alone,
// so identical renders of line-free models stay byte-identical.
// Speed-first wasm build (Q1): 1,514,440 / 569,303 / 431,218 — +306,597 raw
// (+25.4%), +87,486 gzip-9 (+18.2%), +54,090 brotli-11 (+14.3%). This entry
// moves the ratchet the wrong way on purpose. `130ce4e` had added
// `--config profile.release.package.render-core.opt-level="z"` to
// `scripts/build-wasm.mjs` on the premise that only optional presentation
// control flow would shrink; the premise was false. Codec generics
// monomorphise into `render-core`, per-crate opt-level overrides do not fully
// apply under fat LTO, and the flag cost 2.4x on lossless-WebP encode and
// about 6.4 ms on the hero render for output that stayed byte-identical —
// which is why every correctness gate here passed it. `rust/Cargo.toml:10-12`
// had already recorded the same measurement for the profile as a whole. The
// flag is gone; these are the O3 bytes, and `scripts/check-wasm-speed.mjs`
// now gates the encode cost this ratchet cannot see.
// Of the increase, 805 raw / 354 brotli-11 is not the opt level: it is the
// section-plane array growing six to eight vec4s (Q6) and the default fit
// direction resolving from a world-relative orbit (D4). An O3 build of the
// tree before those two measured 1,513,635 raw / 430,864 brotli-11.
// Coverage-gate restructures: 1,515,486 / 569,364 / 431,345 — +1,046 raw,
// +61 gzip-9, +127 brotli-11 for making the fail-closed ceilings and ray
// guards in `section.rs`/`glb.rs` reachable by tests (merged work-ceiling
// accumulator, extracted `ray_crosses_triangle`, explicit accessor-total
// bound) with behaviour pinned verbatim by the new tests.
const ceilings = { raw: 1_515_486, gzip9: 569_364, brotli11: 431_345 };

// `raw` is the artifact and is byte-reproducible, so it is enforced exactly.
// The compressed figures are not properties of the artifact alone: they are
// what *this host's* zlib and brotli make of it. A byte-identical wasm
// measures 569,364 gzip-9 under Node 24 and 26 and 569,404 under CI's Node,
// and 431,345 brotli-11 under Node 24/26 against 431,623 under Node 22 — so
// an exact compressed ceiling fails on a build that changed nothing. That is
// not hypothetical: it red-lined CI on the parent commit over a single byte.
// Allow the compressors 0.5% of headroom, which absorbs every version spread
// measured here and still catches the kilobyte-scale growth this ratchet
// exists to police; `raw` keeps that growth honest to the byte regardless.
const compressorTolerance = 0.005;
const allowances = {
  raw: 0,
  gzip9: Math.ceil(ceilings.gzip9 * compressorTolerance),
  brotli11: Math.ceil(ceilings.brotli11 * compressorTolerance),
};

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

console.log(JSON.stringify({ sizes, ceilings, allowances }, null, 2));
for (const [kind, ceiling] of Object.entries(ceilings)) {
  const limit = ceiling + allowances[kind];
  if (sizes[kind] > limit) {
    throw new Error(
      `render WASM ${kind} size ${sizes[kind]} exceeds ${ceiling}` +
        (allowances[kind] === 0 ? '' : ` (+${allowances[kind]} compressor allowance)`),
    );
  }
}
