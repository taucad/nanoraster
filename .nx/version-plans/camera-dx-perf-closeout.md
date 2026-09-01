---
__default__: minor
---

BREAKING: The default fitted camera is now measured in the declared caller
world — 45° azimuth from `world.forward` toward the caller's right and 30°
elevation above the horizontal plane, with `up` defaulting to `world.up`.
Renders that declared a non-default `world` and omitted `camera.direction`
change framing (0.4.x framed a +Z-up caller at ~37.8° elevation); renders in
the default world stay byte-identical. To keep the 0.4.x framing, pass
`direction: [0.6123724357, 0.5, 0.6123724357]` explicitly.

Add `directionFromOrbit` and `orbitFromDirection` with the
`RenderOrbit` type: world-aware conversion between orbit angles and Cartesian
`direction`, azimuth zero on `world.forward`. This convention is the pair's
own, not the removed `phi`/`theta` one.

Raise the section-plane limit from six to eight simultaneous planes.

Build the wasm artifact at full optimization again: the hero render drops
from ~13 ms to ~7 ms (lossless WebP encode 2.6x faster) for ~54 KB more
brotli transfer, with byte-identical output. A CI encode-speed ratchet now
guards the regression class that shipped the slowdown.
