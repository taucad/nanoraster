# Breaking changes

## 0.x

The package has no compatibility commitments before its first stable release.

- WebP `quality` values below `1` encode lossy instead of being ignored. A
  request that passed an explicit `quality` under a lossless-only release now
  produces a lossy file; drop the option or pass `1` to keep lossless output.
  Lossless bytes also differ slightly from earlier releases after a vendored
  encoder update, so byte-locked WebP snapshots need re-recording.
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
- The `RenderImageFormat`, `RenderUpAxis` and `RenderProjection` type aliases are
  no longer exported. Name the literal unions they stood for:
  `'png' | 'webp' | 'jpeg' | 'jpg'`, `'x' | 'y' | 'z'` and
  `'perspective' | 'orthographic'`.
