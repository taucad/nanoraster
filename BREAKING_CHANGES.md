# Breaking changes

## 0.x

The package has no compatibility commitments before its first stable release.

- WebP `quality` values below `1` encode lossy instead of being ignored. A
  request that passed an explicit `quality` under a lossless-only release now
  produces a lossy file; drop the option or pass `1` to keep lossless output.
  Lossless bytes also differ slightly from earlier releases after a vendored
  encoder update, so byte-locked WebP snapshots need re-recording. That update
  had also dropped the fork's deterministic Huffman tie-break, which let
  lossless WebP bytes differ between the native addon and the wasm module;
  restoring it changes lossless bytes once more and makes the two agree again.
  A committed fingerprint table now gates both artifacts against each other.
- `renderGlbToImage`, `renderGlbToImages` and `renderGlbToPixels` are now
  `renderImage`, `renderImages` and `renderPixels`, as free functions and as
  `Renderer` methods. No aliases are kept. Direct consumers of the native addon
  or the wasm class rename too: the addon exports `renderImage`/`renderImages`/
  `renderPixels` and the wasm `Renderer` class exposes
  `render_image`/`render_images`/`render_pixels`.
- Synthesized filenames are `render.<format>` and `render-<id>.<format>` instead
  of `thumbnail.*`. Match results by their documented order, or by the `id` you
  supplied, rather than by name.
- `createRenderImageOptions` and `createRenderImagesOptions` are deleted. Write
  `{ ... } as const satisfies RenderImageOptions` (or `RenderImagesOptions`) on
  the variable instead: same literal preservation and key checking, no import.
- `includeLabel` is deleted. A `label`'s presence is now the switch: set one and
  it is drawn, omit it and it is not. Drop the flag and keep the label. On a
  batch call this is per view — labelling every view is no longer required, so
  a sheet can label some views and not others. Direct consumers of the native
  addon or the wasm class drop the wire field too.
- `includeAxes` and `includeScale` are now `axes` and `scaleBar` (`axes` and
  `scaleBar` on the wire as well). Same booleans, same `false` defaults;
  `scaleBar` rather than `scale` because a bare `scale` beside `width` and
  `height` reads as image scaling.
- The `RenderImageFormat`, `RenderUpAxis` and `RenderProjection` type aliases are
  no longer exported. Name the literal unions they stood for:
  `'png' | 'webp' | 'jpeg' | 'jpg'`, `'x' | 'y' | 'z'` and
  `'perspective' | 'orthographic'`.
- `describeAdapter` returns an `AdapterInfo` object with `backend`, `name` and
  `deviceType` instead of a string such as
  `"Metal / Apple M2 Pro (IntegratedGpu)"`. Replace an `adapter.includes('(Cpu)')`
  check with `adapter.deviceType === 'cpu'`. It also accepts the
  `CreateRendererOptions` that `createRenderer` accepts, so a `low-power`
  renderer's adapter can be described; passing nothing keeps describing the
  `high-performance` adapter the one-shot functions bind. The wasm artifact no
  longer exports `describe_adapter` at all — browsers read `navigator.gpu`
  directly — and the native addon's `describeAdapter` takes an optional options
  JSON string and returns JSON.
- The `profile` option and the `profile` result property are now `timings`, and
  the `RenderProfile` / `RenderViewProfile` types are `RenderTimings` /
  `RenderViewTimings`. Every duration field drops its unit suffix: `parseMs` and
  `setupMs` are `parse` and `setup`; a view's `renderMs`, `overlayMs` and
  `encodeMs` are `render`, `overlay` and `encode`. The values are unchanged —
  still milliseconds. Direct consumers of the native addon or the wasm class
  rename the wire fields too.
- The benchmark surface is gone from the published artifacts. The native addon
  no longer exports `benchCodecs`, `benchMultiView` or `codecConformance`, and
  the wasm module no longer exports `bench_codecs`, `bench_multi_view` or
  `codec_conformance`; they live behind a default-off `bench` cargo feature and
  are development instrumentation, never part of the package API. Build the
  crates yourself with `--features bench` if you need them. Rendered bytes are
  unchanged.
- `format` is required on every image request at the wire, not only in
  TypeScript. The render core's `"png"` fallback is deleted, so a request to
  the native addon or the wasm module that names no format fails with
  `parse: format is required` instead of producing a PNG.
- `renderPixels` is deleted, and with it `Renderer.renderPixels`,
  `RenderPixelsOptions` and `RenderedPixels`. Raw output is now the fourth
  value of `format`: `renderImage(glb, { format: 'raw', ... })` replaces the
  singular call, `renderImages` with a raw view replaces it in a plan, and a
  view may set `format: 'raw'` beside encoded ones. The result is an ordinary
  `RenderedImageFile` — `bytes` instead of `rgba`, `render.raw` /
  `render-<id>.raw` as the name, `application/octet-stream` as the MIME type
  (`imageMimeTypes.raw`) — with the same straight-alpha, sRGB, tightly packed
  `width * height * 4` layout as before.
- `quality` is ignored for raw exactly as PNG ignores it, so no new validation
  rule applies. Direct consumers of the native addon or the wasm class drop
  `renderPixels` / `render_pixels` too and pass `"format":"raw"` to
  `renderImage` / `render_image` instead. Rendered bytes are unchanged.
- `RenderedImageFile` gains `width` and `height` for every format. They are
  resolved from the request (a per-view override, else the shared value, else
  the 768×432 defaults), so nothing on the wire changed; code that spread a
  result into a fixed object literal now carries two more properties.
