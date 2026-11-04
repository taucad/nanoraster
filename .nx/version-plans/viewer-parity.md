---
__default__: minor
---

Match the Tau viewer's ambient occlusion: a port of three's GTAO with edge-aware denoise and guided upsample replaces the hemisphere estimator, and the AO defaults become intensity 0.75 and distance falloff 1. AO intensity now scales the occlusion estimate the way the viewer does, so existing explicit intensities render differently.

Add `lineColor` to replace every authored line colour with one sRGB colour.
