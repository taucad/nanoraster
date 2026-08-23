---
nanoraster: patch
---

The release smoke now accepts both 32-bit ARM platform packages. The hard-float ABI carries no libc selector, so npm installs the pair on an armv7 host and the loader picks one; the smoke reads the loaded shared objects to prove it picked the one under test. A rule derived from the configured targets still rejects any other pairing, and an emulated armv7 row joins the registry smoke so a release exercises it.
