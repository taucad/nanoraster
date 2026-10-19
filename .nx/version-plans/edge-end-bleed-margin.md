---
__default__: patch
---

Wireframe surfaces now give up exactly half the stroke width of depth slope, not half plus one pixel, so a hidden edge that ends on a face's outline (the far flank edges of a gear tooth) no longer shows through as a short tick past it. Visible edges keep their full width.
