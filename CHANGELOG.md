## 0.4.0 (2026-08-22)

### 🚀 Features

- Uplift the vendored lossy WebP encoder: per-macroblock intra mode selection (16×16 and 4×4) chosen by rate-distortion cost, skip flags, a rounding quantizer, a nonlinear quality-to-quantizer curve, and quality-proportional loop filtering. On the ten-example corpus at quality 0.9, lossy output is 41 percent smaller than lossless, versus 10 percent with the previous encoder; a 292-byte wordmark whose lossless encoding is already tiny is the one exception. Lossless output is byte-identical. ([#28](https://github.com/taucad/nanoraster/pull/28))
- Add a persistent renderer. `createRenderer` returns a `Renderer` that keeps the GPU device, shader, and pipelines alive across calls, with `dispose()` and `using` support, transparent device-loss recovery, and output byte-identical to the one-shot functions. The one-shot functions themselves now share one renderer per process instead of creating and destroying a device per call: the first call pays the bring-up and later calls reuse it (27 ms then 3.4 ms at 768×576 on an Apple M2 Pro), calls run in call order so `Promise.all` over one-shot renders no longer races several devices, and render targets above 2048² are dropped after each call. That shared renderer uses the default `'high-performance'` power preference and lives until the process or worker exits; hold a `createRenderer` handle to control either. ([#34](https://github.com/taucad/nanoraster/pull/34))

  Plan entries in `renderImages` gain per-view `width`, `height`, `format`, and `quality` overrides that flow into per-entry filenames and literal MIME types. `timings: true` attaches stage timings (`parse`, `setup`, and per-view `render`, `overlay`, `encode`, all in milliseconds) to the result as `RenderTimings`. `describeAdapter` returns an `AdapterInfo` (`{ backend, name, deviceType }`), resolves `undefined` when no adapter is available rather than rejecting, takes the same `CreateRendererOptions` as `createRenderer` so a `'low-power'` adapter can be described, and in browsers reads `navigator.gpu` directly. The native addon's `describeAdapter` returns `null` for the same case. `RenderError` keeps the value it wraps as its `cause`. `RenderedImagesResult` and `StrictRenderImagesOptions` are exported so the `Renderer` type's parameter and return types can be named.

  Add raw output. `format: 'raw'` skips the encoder and returns the frame itself as an ordinary `RenderedImageFile`: `bytes` is straight-alpha, sRGB-encoded RGBA8, exactly `width * height * 4` bytes, row-major with the top row first and no padding, named `render.raw` or `render-<id>.raw` with `imageMimeTypes.raw` (`application/octet-stream`). It can be set per view, so a plan can mix raw frames with encoded views, and `quality` is ignored for it as for PNG. Every `RenderedImageFile` now carries the `width` and `height` the request resolved to.

  Rename the public API (breaking, under the prerelease policy, with no aliases kept). `renderGlbToImage` and `renderGlbToImages` are `renderImage` and `renderImages`; synthesized filenames are `render.<format>` and `render-<id>.<format>` instead of `thumbnail.*`; the `createRenderImageOptions` and `createRenderImagesOptions` helpers are deleted in favour of `{ … } as const satisfies RenderImageOptions` and `{ … } as const satisfies RenderImagesOptions`. `includeLabel` is deleted — setting `label` is what draws it, per view in a batch — and `includeAxes` and `includeScale` are `axes` and `scaleBar`. Rendered bytes are unchanged by any rename.

  Change the native addon and wasm module contracts (breaking for direct consumers of those artifacts). Render entries are named `renderImage`/`renderImages` and `render_image`/`render_images`, return Promises (the addon renders on the libuv thread pool), take `axes`/`scaleBar`/`label`/`timings`/`format: "raw"` on the wire, and require `format` — the render core's `"png"` fallback is deleted, so a request naming no format fails with `parse: format is required`. The benchmark entry points (`benchCodecs`, `benchMultiView`, `codecConformance` and their wasm equivalents) move behind a default-off `bench` cargo feature and are no longer in any published artifact; the wasm module also drops `describe_adapter`. The shipped wasm shrinks by about 62 KB raw overall.

  Gate codec bytes between artifacts. The vendored image-webp update that added lossy encoding had also dropped this fork's deterministic Huffman tie-break, so lossless WebP bytes differed between the native addon and the wasm module. The tie-break is restored — lossless WebP bytes change once more, and the two artifacts agree again — and both the render core's suite and the three-browser suite now assert against one committed fingerprint table, which also gains a lossy-WebP entry per fixture. PNG, JPEG, and every rendered pixel are unchanged.

- Add lossy WebP encoding. `quality: 1` — the WebP default — stays lossless, and any lower value encodes lossy VP8 with a losslessly coded alpha channel, following Chrome's canvas `toBlob` semantics. An explicit `quality` below 1 on a WebP request changes its output from lossless to lossy, and lossless bytes differ slightly from earlier releases after the vendored encoder update. ([#28](https://github.com/taucad/nanoraster/pull/28))

### 🩹 Fixes

- Credit only people in the changelog's Thank You section, leaving the release bot, Dependabot and coding assistants to the commit trailers that record them. ([#32](https://github.com/taucad/nanoraster/pull/32))
- Point the README's quick start at the tutorial and guides rather than back at itself, and keep the dead-link checker's decoded targets inside the exported site. ([5039161](https://github.com/taucad/nanoraster/commit/5039161))
- Assert worktree cleanliness when release preparation starts rather than after the quality gate has regenerated committed artifacts, so the automated release pull request can generate in CI. ([a39d388](https://github.com/taucad/nanoraster/commit/a39d388))
- Maintain the release pull request automatically: `release-pr.yml` regenerates `release/next` from pending Version Plans on every push to `main`, and `release:prepare` gains a `--from-plans` mode that derives the version the plans dictate. ([20be631](https://github.com/taucad/nanoraster/commit/20be631))
- Verify published provenance against the workflow run that minted it rather than the current retry attempt, so re-running the release verification after a transient registry failure can succeed. ([#27](https://github.com/taucad/nanoraster/pull/27))

### ❤️ Thank You

- Richard Fontein @rifont

## 0.3.0 (2026-08-19)

### 🚀 Features

- Retune the studio preset (ACES tone map, diffuse environment irradiance, warmer rig) to match the Tau viewer, and add a `lighting` option: the `'studio'` preset or a custom rig of up to 8 directional lights with ambient, environment, space, and exposure. Every default render changes appearance. ([#23](https://github.com/taucad/nanoraster/pull/23))
- Inline the option literal unions at their property sites. `RenderImageFormat`, `RenderUpAxis` and `RenderProjection` are no longer exported: `format`, `up` and `projection` now read as `'png' | 'webp' | 'jpeg' | 'jpg'`, `'x' | 'y' | 'z'` and `'perspective' | 'orthographic'` in editors, in the generated type tables and in the reference. Code that named an alias should name the literal union instead; every object type and `RenderFailureCode` keep their exports. Breaking under the prerelease policy documented in the README section "Versioning and stability". ([5497050](https://github.com/taucad/nanoraster/commit/5497050))

### 🩹 Fixes

- Publish complete field documentation for public render options, image results, and typed errors. ([#17](https://github.com/taucad/nanoraster/pull/17))

### ❤️ Thank You

- Claude Fable 5
- Richard Fontein @rifont

## 0.2.0 (2026-08-15)

### 🚀 Features

- Add factor-only glTF metallic-roughness PBR rendering. ([#8](https://github.com/taucad/nanoraster/pull/8))

### ❤️ Thank You

- Richard Fontein @rifont

## 0.1.0 (2026-08-15)

### 🚀 Features

- Publish the initial nanoraster package with WebGPU wasm and native Node artifacts for macOS arm64, Linux x64 glibc, and Windows x64 MSVC. ([#14](https://github.com/taucad/nanoraster/pull/14))

### ❤️ Thank You

- Richard Fontein @rifont

# Changelog

All notable changes to nanoraster are recorded here.

## Unreleased

- Extract the renderer into its standalone package.
