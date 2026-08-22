---
nanoraster: minor
---

Publish native addons for sixteen targets. Alongside the existing `nanoraster-darwin-arm64`, `nanoraster-linux-x64-gnu`, and `nanoraster-win32-x64-msvc`, the root package now declares `nanoraster-darwin-x64`, `nanoraster-win32-arm64-msvc`, `nanoraster-win32-ia32-msvc`, `nanoraster-linux-arm64-gnu`, `nanoraster-linux-arm-gnueabihf`, `nanoraster-linux-ppc64-gnu` (little-endian), `nanoraster-linux-s390x-gnu`, `nanoraster-linux-x64-musl`, `nanoraster-linux-arm64-musl`, `nanoraster-linux-arm-musleabihf`, `nanoraster-freebsd-x64`, and the experimental `nanoraster-android-arm64` and `nanoraster-android-arm-eabi` as optional dependencies, so `npm install nanoraster` installs exactly one matching addon on each of those hosts. Platform selection moves to the NAPI-RS generated loader (including musl detection and the optional `NAPI_RS_ENFORCE_VERSION_CHECK`), and every platform package is built, inspected, and published with npm provenance from the same CI run as the root.

Add a `node` export condition. Node.js, Bun, and server bundlers resolve `dist/index.node.mjs`, which loads the native addon; every other environment resolves the wasm-only `dist/index.mjs`, whose import graph contains no Node.js builtins, so browser bundlers never see the native loader. `RenderError` raised for an unavailable addon now carries the loader's full `cause` chain.

Lower the Node.js floor to 22.13.0. Node 24 and later ship no official Linux armv7 or Windows x86 binaries, so those two targets are supported through Node 22's lifetime; every other target is tested on Node 22.13.0 and 26.
