## 0.4.1 (2026-08-23)

### 🩹 Fixes

- The release smoke now accepts both 32-bit ARM platform packages. The hard-float ABI carries no libc selector, so npm installs the pair on an armv7 host and the loader picks one; the smoke reads the loaded shared objects to prove it picked the one under test. A rule derived from the configured targets still rejects any other pairing, and an emulated armv7 row joins the registry smoke so a release exercises it. ([#53](https://github.com/taucad/nanoraster/pull/53))
- Refuse to render on a 32-bit ARM Linux host whose Vulkan driver is mesa's lavapipe from mesa 23 onwards, where the driver faults mid-render and takes the process down. `renderImage` and `createRenderer` now reject with a `RenderError` carrying the new code `driver-unsupported`, whose message names the upstream defect. Older lavapipe releases and every other platform render as before. Set `NANORASTER_ALLOW_UNSUPPORTED_DRIVER=1` to render on a refused driver anyway. ([#54](https://github.com/taucad/nanoraster/pull/54))
- The compatibility table no longer holds a row waiting for a promotion its render job already earned. Nine rows read `Pending` although the 0.4.0 release run rendered on each of them, because the legend's promotion rule had no enforcement behind it. A row that stays `Pending` while a release requires the job it cites now fails the compatibility test, so the table cannot lag the release it shipped. ([#51](https://github.com/taucad/nanoraster/pull/51))
- Derive the platform-package contract from `package.json.napi` without importing the NAPI-RS CLI. The job that verifies published provenance checks the repository out and reads the registry, so it installs nothing, and the development dependency behind the target parser left it unable to load the verifier at all. The derivation is held to the CLI's own parser by a unit test, and to the generated `npm/` tree by the assembly check that compares them. ([#48](https://github.com/taucad/nanoraster/pull/48))
- Verify every continuous integration artifact download landed before its consumer runs, and retry the download once when it did not, so a silently empty download fails at the boundary that caused it rather than as an unrelated missing-file error minutes later. ([#47](https://github.com/taucad/nanoraster/pull/47))

### ❤️ Thank You

- Richard Fontein @rifont

## 0.4.0 (2026-08-22)

### 🚀 Features

- Uplift the vendored lossy WebP encoder: per-macroblock intra mode selection (16×16 and 4×4) chosen by rate-distortion cost, skip flags, a rounding quantizer, a nonlinear quality-to-quantizer curve, and quality-proportional loop filtering. On the ten-example corpus at quality 0.9, lossy output is 41 percent smaller than lossless, versus 10 percent with the previous encoder; a 292-byte wordmark whose lossless encoding is already tiny is the one exception. Lossless output is byte-identical. ([#28](https://github.com/taucad/nanoraster/pull/28))
- Add a persistent renderer. `createRenderer` returns a `Renderer` that keeps the GPU device, shader, and pipelines alive across calls, with `dispose()` and `using` support, transparent device-loss recovery, and output byte-identical to the one-shot functions. ([#34](https://github.com/taucad/nanoraster/pull/34))

  The one-shot functions themselves now share one renderer per process instead of creating and destroying a device per call: the first call pays the bring-up and later calls reuse it (27 ms then 3.4 ms at 768×576 on an Apple M2 Pro), calls run in call order so `Promise.all` over one-shot renders no longer races several devices, and render targets above 2048² are dropped after each call. That shared renderer uses the default `'high-performance'` power preference and lives until the process or worker exits; hold a `createRenderer` handle to control either.

  Plan entries in `renderImages` gain per-view `width`, `height`, `format`, and `quality` overrides that flow into per-entry filenames and literal MIME types. `timings: true` attaches stage timings (`parse`, `setup`, and per-view `render`, `overlay`, `encode`, all in milliseconds) to the result as `RenderTimings`. `describeAdapter` returns an `AdapterInfo` (`{ backend, name, deviceType }`), resolves `undefined` when no adapter is available rather than rejecting, takes the same `CreateRendererOptions` as `createRenderer` so a `'low-power'` adapter can be described, and in browsers reads `navigator.gpu` directly. The native addon's `describeAdapter` returns `null` for the same case. `RenderError` keeps the value it wraps as its `cause`. `RenderedImagesResult` and `StrictRenderImagesOptions` are exported so the `Renderer` type's parameter and return types can be named.

  Add raw output. `format: 'raw'` skips the encoder and returns the frame itself as an ordinary `RenderedImageFile`: `bytes` is straight-alpha, sRGB-encoded RGBA8, exactly `width * height * 4` bytes, row-major with the top row first and no padding, named `render.raw` or `render-<id>.raw` with `imageMimeTypes.raw` (`application/octet-stream`). It can be set per view, so a plan can mix raw frames with encoded views, and `quality` is ignored for it as for PNG. Every `RenderedImageFile` now carries the `width` and `height` the request resolved to.

  Rename the public API (breaking, under the prerelease policy, with no aliases kept). `renderGlbToImage` and `renderGlbToImages` are `renderImage` and `renderImages`; synthesized filenames are `render.<format>` and `render-<id>.<format>` instead of `thumbnail.*`; the `createRenderImageOptions` and `createRenderImagesOptions` helpers are deleted in favour of `{ … } as const satisfies RenderImageOptions` and `{ … } as const satisfies RenderImagesOptions`. `includeLabel` is deleted — setting `label` is what draws it, per view in a batch — and `includeAxes` and `includeScale` are `axes` and `scaleBar`. Rendered bytes are unchanged by any rename.

  Change the native addon and wasm module contracts (breaking for direct consumers of those artifacts). Render entries are named `renderImage`/`renderImages` and `render_image`/`render_images`, return Promises (the addon renders on the libuv thread pool), take `axes`/`scaleBar`/`label`/`timings`/`format: "raw"` on the wire, and require `format` — the render core's `"png"` fallback is deleted, so a request naming no format fails with `parse: format is required`. The benchmark entry points (`benchCodecs`, `benchMultiView`, `codecConformance` and their wasm equivalents) move behind a default-off `bench` cargo feature and are no longer in any published artifact; the wasm module also drops `describe_adapter`. The shipped wasm shrinks by about 62 KB raw overall.

  Gate codec bytes between artifacts. The vendored image-webp update that added lossy encoding had also dropped this fork's deterministic Huffman tie-break, so lossless WebP bytes differed between the native addon and the wasm module. The tie-break is restored — lossless WebP bytes change once more, and the two artifacts agree again — and both the render core's suite and the three-browser suite now assert against one committed fingerprint table, which also gains a lossy-WebP entry per fixture. PNG, JPEG, and every rendered pixel are unchanged.

- Publish native addons for sixteen targets. Alongside the existing `nanoraster-darwin-arm64`, `nanoraster-linux-x64-gnu`, and `nanoraster-win32-x64-msvc`, the root package now declares `nanoraster-darwin-x64`, `nanoraster-win32-arm64-msvc`, `nanoraster-win32-ia32-msvc`, `nanoraster-linux-arm64-gnu`, `nanoraster-linux-arm-gnueabihf`, `nanoraster-linux-ppc64-gnu` (little-endian), `nanoraster-linux-s390x-gnu`, `nanoraster-linux-x64-musl`, `nanoraster-linux-arm64-musl`, `nanoraster-linux-arm-musleabihf`, `nanoraster-freebsd-x64`, and the experimental `nanoraster-android-arm64` and `nanoraster-android-arm-eabi` as optional dependencies, so `npm install nanoraster` installs exactly one matching addon on each of those hosts. ([#40](https://github.com/taucad/nanoraster/pull/40))

  Platform selection moves to the NAPI-RS generated loader (including musl detection and the optional `NAPI_RS_ENFORCE_VERSION_CHECK`), and every platform package is built, inspected, and published with npm provenance from the same CI run as the root.

  Add a `node` export condition. Node.js, Bun, and server bundlers resolve `dist/index.node.mjs`, which loads the native addon; every other environment resolves the wasm-only `dist/index.mjs`, whose import graph contains no Node.js builtins, so browser bundlers never see the native loader. `RenderError` raised for an unavailable addon now carries the loader's full `cause` chain.

  Lower the Node.js floor to 22.13.0. Node 24 and later ship no official Linux armv7 or Windows x86 binaries, so those two targets are supported through Node 22's lifetime; every other target is tested on Node 22.13.0 and 26.

- Add lossy WebP encoding. `quality: 1` — the WebP default — stays lossless, and any lower value encodes lossy VP8 with a losslessly coded alpha channel, following Chrome's canvas `toBlob` semantics. An explicit `quality` below 1 on a WebP request changes its output from lossless to lossy, and lossless bytes differ slightly from earlier releases after the vendored encoder update. ([#28](https://github.com/taucad/nanoraster/pull/28))

### 🩹 Fixes

- Credit only people in the changelog's Thank You section, leaving the release bot, Dependabot and coding assistants to the commit trailers that record them. ([#32](https://github.com/taucad/nanoraster/pull/32))
- Point the README's quick start at the tutorial and guides rather than back at itself, and keep the dead-link checker's decoded targets inside the exported site. ([5039161](https://github.com/taucad/nanoraster/commit/5039161))
- Assert worktree cleanliness when release preparation starts rather than after the quality gate has regenerated committed artifacts, so the automated release pull request can generate in CI. ([a39d388](https://github.com/taucad/nanoraster/commit/a39d388))
- Maintain the release pull request automatically: `release-pr.yml` regenerates `release/next` from pending Version Plans on every push to `main`, and `release:prepare` gains a `--from-plans` mode that derives the version the plans dictate. ([20be631](https://github.com/taucad/nanoraster/commit/20be631))
- Gate a release on one quality run over the committed tree. `release:prepare` runs the gate itself instead of handing it to nx as `preVersionCommand`, which nx executes on every `releaseVersion` call — twice per preparation, the second time over a tree the first has already regenerated — and runs with piped stdio, reporting only the child's stderr, so a gate that reports findings on stdout failed the release with nothing printed. The two targets that scan the whole tree, `check:dead-code` and `format`, now wait for `build` rather than reading files while it rewrites them. ([#45](https://github.com/taucad/nanoraster/pull/45))
- Verify published provenance against the workflow run that minted it rather than the current retry attempt, so re-running the release verification after a transient registry failure can succeed. ([#27](https://github.com/taucad/nanoraster/pull/27))
- Raise musl's process-wide default thread stack to 8 MiB before requesting an adapter, so a software Vulkan render on Alpine survives shader compilation. Mesa's lavapipe creates its shader-compilation thread with default attributes, and LLVM 22 code generation for AArch64 overruns musl's 128 KiB default; the process default now matches the size glibc gives the same thread. ([#40](https://github.com/taucad/nanoraster/pull/40))

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
