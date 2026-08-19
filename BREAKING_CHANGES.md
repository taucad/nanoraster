# Breaking changes

## 0.x

The package has no compatibility commitments before its first stable release.

- The `RenderImageFormat`, `RenderUpAxis` and `RenderProjection` type aliases are
  no longer exported. Name the literal unions they stood for:
  `'png' | 'webp' | 'jpeg' | 'jpg'`, `'x' | 'y' | 'z'` and
  `'perspective' | 'orthographic'`.
