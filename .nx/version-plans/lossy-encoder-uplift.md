---
nanoraster: minor
---

Uplift the vendored lossy WebP encoder: per-macroblock intra mode selection (16×16 and 4×4) chosen by rate-distortion cost, skip flags, a rounding quantizer, a nonlinear quality-to-quantizer curve, and quality-proportional loop filtering. Lossy output at a given quality is smaller and higher-fidelity than earlier lossless-only releases' lossy output; lossless output is unchanged.
