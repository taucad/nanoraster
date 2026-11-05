---
__default__: minor
---

Render like the Tau viewer by default, and expose the viewer's ambient occlusion, light rig and tone mapping as options. Default images change, and AO `intensity` and `distanceFalloff` change meaning; [BREAKING_CHANGES.md](https://github.com/taucad/nanoraster/blob/main/BREAKING_CHANGES.md) has the migration.

Ambient occlusion ports three.js 0.184's GTAO with the viewer's edge-aware denoise and a depth- and normal-guided upsample, replacing the hemisphere estimator. The AO depth pass also writes view-space mesh normals, which every AO pass reads as the viewer's normal render target provides them. The defaults are the viewer's: intensity 0.75, distance falloff 1, half-resolution estimate. `ao.thicknessRatio`, `ao.denoiseDepthTolerance`, `ao.samples` and `ao.resolutionScale` tune the estimator and its filters.

The studio preset is the viewer's dark-scheme rig: the neutral room, a camera-relative `lighting.headlamp` and ambient `0.1 × 1.15 / π`. `lighting.environment: { cards, intensity }` prefilters rectangular light cards into the environment, as the viewer prefilters its Lightformers, or scales the room. A rig may omit `lights`; one that sets `lights` without `headlamp` still renders without the headlamp.

Add `toneMapping`: `'neutral'` (the default, unchanged), `'aces'`, `'linear'` or `'none'`, matching three.js's operators.

Add `lineColor` to replace every authored line colour with one sRGB colour.

Surfaces render single-sample and take the viewer's FXAA, and edges draw after it with the viewer's exact square-pixel coverage, flat ends and surface depth margin (half the stroke plus half a pixel); edges no longer write depth. This replaces 4x multisampling, so silhouette and edge pixels change. A `background` is blended in sRGB, as the viewer's page shows its canvas, instead of in linear light.

Drop the N8AO blue-noise texture that the GTAO port left unused: the WASM shrinks by 66,148 bytes (65,524 Brotli-compressed) and the Linux x64 native addon by 66,520 bytes.
