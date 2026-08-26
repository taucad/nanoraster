# Breaking changes

## 0.x

The package has no compatibility commitments before its first stable release.

- Top-level `phi`, `theta`, `up`, `projection`, and `margin` are replaced by a
  tagged `camera`. Fitted cameras use Cartesian `direction` and `up`; fixed
  cameras use `position`, `target`, and `up` with field of view or orthographic
  span, zoom, and optional clipping. Each batch view owns an optional complete
  camera. `lineWidth` is now public and measured in output pixels instead of
  scaling with image height; its default is `3`. Removed wire keys fail with
  the replacement path.
- WebP `quality` values below `1` encode lossy instead of being ignored. A
  request that passed an explicit `quality` under a lossless-only release now
  produces a lossy file; drop the option or pass `1` to keep lossless output.
  Lossless WebP bytes also differ from earlier releases: a vendored encoder
  update changed them once, and restoring the fork's deterministic Huffman
  tie-break — which that update had dropped, letting the native and wasm
  artifacts disagree — changed them again. Byte-locked WebP snapshots need
  re-recording; a committed fingerprint table now keeps both artifacts
  identical.
- `renderGlbToImage` and `renderGlbToImages` are now `renderImage` and
  `renderImages`. No aliases are kept. Direct consumers of the native addon
  rename too (`renderImage`/`renderImages`), and every addon render entry now
  returns a Promise instead of blocking; the wasm `Renderer` class exposes
  `render_image`/`render_images`.
- Synthesized filenames are `render.<format>` and `render-<id>.<format>`
  instead of `thumbnail.*`. Match results by their documented order or by the
  `id` you supplied, not by name.
- `createRenderImageOptions` and `createRenderImagesOptions` are deleted.
  Write `{ ... } as const satisfies RenderImageOptions` (or
  `RenderImagesOptions`) on the variable instead: the same literal
  preservation and key checking, with no helper to import. The option type
  itself is still imported:
  `import type { RenderImageOptions } from 'nanoraster'`.
- `includeLabel` is deleted. Setting `label` is what draws it; omit it and no
  label is drawn. In a batch call this is per view, so a sheet can label some
  views and not others. Direct consumers of the native addon or the wasm class
  drop the wire field too.
- `includeAxes` and `includeScale` are now `axes` and `scaleBar`, on the wire
  as well. Same booleans, same `false` defaults. `scaleBar` rather than
  `scale`, because a bare `scale` next to `width` and `height` reads as image
  scaling.
- The `RenderImageFormat`, `RenderUpAxis` and `RenderProjection` type aliases
  are no longer exported. Name the literal unions they stood for:
  `'png' | 'webp' | 'jpeg' | 'jpg' | 'raw'`, `'x' | 'y' | 'z'` and
  `'perspective' | 'orthographic'`.
- A one-shot render now leaves a GPU device alive for the rest of the process
  or worker. The one-shot functions share one renderer, created on the first
  call and never disposed, instead of creating and destroying a device per
  call. Use `createRenderer` when the device's lifetime or power preference
  matters.
- `format` is required on every image request at the wire, not only in
  TypeScript. The render core's `"png"` fallback is deleted, so a request to
  the native addon or the wasm module that names no format fails with
  `parse: format is required`.
- The benchmark surface is gone from the published artifacts. The native
  addon no longer exports `benchCodecs`, `benchMultiView` or
  `codecConformance`, and the wasm module no longer exports `bench_codecs`,
  `bench_multi_view` or `codec_conformance`. They sit behind a default-off
  `bench` cargo feature; build the crates with `--features bench` if you need
  them. Rendered pixels are unchanged; the WebP byte changes are the ones
  documented above.
