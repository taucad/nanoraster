---
nanoraster: minor
---

Add lossy WebP encoding. `quality: 1` — the WebP default — stays lossless, and any lower value encodes lossy VP8 with a losslessly coded alpha channel, following Chrome's canvas `toBlob` semantics. An explicit `quality` below 1 on a WebP request changes its output from lossless to lossy, and lossless bytes differ slightly from earlier releases after the vendored encoder update.
