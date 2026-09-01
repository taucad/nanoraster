---
__default__: minor
---

BREAKING: Replace top-level `phi`, `theta`, `up`, `projection`, and `margin`
with a Cartesian `camera` whose `framing` is `fit` or `fixed`. Fitted cameras
take `direction` and `up`; fixed cameras take `position`, `target`, and `up`
with an explicit perspective or orthographic projection.

To preserve an old `(phi, theta, up)` fitted view, convert the angles from
degrees to `p` and `t` radians and use the matching `direction`:

- X-up: `[cos(p), sin(p) * cos(t), sin(p) * sin(t)]`
- Y-up: `[sin(p) * cos(t), cos(p), -sin(p) * sin(t)]`
- Z-up: `[sin(p) * cos(t), sin(p) * sin(t), cos(p)]`

Use the corresponding positive unit axis as camera `up`. At or near a pole
(`abs(dot(direction, up)) >= 0.999`), use positive Z for legacy Y-up and
positive Y for legacy X-up or Z-up. Batch views now carry an optional complete
`camera`.

`lineWidth` is public, measured in output pixels, and defaults to a flat `3`
at every image size rather than scaling with image height.
