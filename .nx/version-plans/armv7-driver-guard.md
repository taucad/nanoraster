---
nanoraster: patch
---

Refuse to render on a 32-bit ARM Linux host whose Vulkan driver is mesa's lavapipe from mesa 23 onwards, where the driver faults mid-render and takes the process down. `renderImage` and `createRenderer` now reject with a `RenderError` carrying the new code `driver-unsupported`, whose message names the upstream defect. Older lavapipe releases and every other platform render as before. Set `NANORASTER_ALLOW_UNSUPPORTED_DRIVER=1` to render on a refused driver anyway.
