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

Resolve a camera `up` that is collinear with its view direction against the
declared caller world instead of rejecting the request. Such a pair leaves
screen-up undefined — `cross(up, direction)` is zero — so screen-up takes the
first declared world axis that names a roll: `world.forward`, or `world.up`
for a view running along `world.forward`.

A fitted camera at ±90° of elevation renders without spelling an `up` out, and
so does a fixed camera whose `up` runs along its own view direction. Only
requests that raised
`direction and up must not be collinear` change: every request that renders
keeps its bytes. Non-finite or zero-length vectors, and a `position` equal to
its `target`, are rejected as before.

Add `directionFromOrbit` and `orbitFromDirection` with the
`RenderOrbit` type: world-aware conversion between orbit angles and Cartesian
`direction`, azimuth zero on `world.forward`. This convention is the pair's
own, not the removed `phi`/`theta` one.

Raise the section-plane limit from six to eight simultaneous planes.

Build the wasm artifact at full optimization again: the hero render drops
from ~13 ms to ~7 ms (lossless WebP encode 2.6x faster) for ~54 KB more
brotli transfer, with byte-identical output. A CI encode-speed ratchet now
guards the regression class that shipped the slowdown.
