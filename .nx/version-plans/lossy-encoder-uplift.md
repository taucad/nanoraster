---
nanoraster: minor
---

Uplift the vendored lossy WebP encoder: per-macroblock intra mode selection (16×16 and 4×4) chosen by rate-distortion cost, skip flags, a rounding quantizer, a nonlinear quality-to-quantizer curve, and quality-proportional loop filtering. On the ten-example corpus at quality 0.9, lossy output is 41 percent smaller than lossless, versus 10 percent with the previous encoder; a 292-byte wordmark whose lossless encoding is already tiny is the one exception. Lossless output is byte-identical.
