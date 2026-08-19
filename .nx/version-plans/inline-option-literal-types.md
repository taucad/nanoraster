---
nanoraster: minor
---

Inline the option literal unions at their property sites. `RenderImageFormat`, `RenderUpAxis` and `RenderProjection` are no longer exported: `format`, `up` and `projection` now read as `'png' | 'webp' | 'jpeg' | 'jpg'`, `'x' | 'y' | 'z'` and `'perspective' | 'orthographic'` in editors, in the generated type tables and in the reference. Code that named an alias should name the literal union instead; every object type and `RenderFailureCode` keep their exports. Breaking under the prerelease policy documented in the README section "Versioning and stability".
