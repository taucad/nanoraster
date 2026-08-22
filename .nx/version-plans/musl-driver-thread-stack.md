---
nanoraster: patch
---

Raise musl's process-wide default thread stack to 8 MiB before requesting an adapter, so a software Vulkan render on Alpine survives shader compilation. Mesa's lavapipe creates its shader-compilation thread with default attributes, and LLVM 22 code generation for AArch64 overruns musl's 128 KiB default; the process default now matches the size glibc gives the same thread.
