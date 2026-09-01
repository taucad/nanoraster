---
__default__: minor
---

BREAKING: Add a shared `world` declaration for camera, section, world-light,
axes, and scale-bar values. Spatial request values are interpreted in that
caller coordinate system; omitting `world` preserves glTF +Y-up, +Z-forward,
metre semantics. Submitted GLB bytes are not rewritten.

BREAKING: Expand `RenderTimings` from `{ parse, setup, views }` to stage and
resource evidence: `parse`, `setup`, `capBuild`, `upload`,
`peakReadbackBytes`, `glbParses`, `adapterDeviceRequests`, `pipelineSets`,
`presentationBuilds`, `sceneUploads`, `targetAllocations`, and `views`.
`setup` now covers renderer acquisition plus presentation and upload work.

Also add renderer-neutral surface and authored-line switches, exact glTF
primitive selection, and deterministic multi-plane section views with striped
caps.
