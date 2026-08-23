# Compatibility

Every mark in the tables below names the job in `.github/workflows/ci.yml` that
proves it. `✅` means a render on that host is required before a release.
`Pending` means the package is built, inspected and published, and the named
render job promotes it on its first green run. `Partial` means the named job
proves the install, the load and the adapter, and a driver defect outside this
package blocks the render itself. `Experimental` means the package is built and
its binary inspected, with no render evidence.

## Runtimes

| Host          | Support | CI evidence          |
| ------------- | ------- | -------------------- |
| Node.js 22.13 | ✅      | `node (22.13.0)`     |
| Node.js 26    | ✅      | `node (26)`          |
| Chromium      | ✅      | `browser (chromium)` |
| Firefox       | ✅      | `browser (firefox)`  |
| WebKit        | ✅      | `browser (webkit)`   |

## Native hosts

Each release publishes sixteen platform packages; a package manager installs
the one whose `os`, `cpu` and `libc` match the host, and the native loader picks
the binary out of it.

| Platform package                  | Host                          | Support      | CI evidence                             |
| --------------------------------- | ----------------------------- | ------------ | --------------------------------------- |
| `nanoraster-darwin-arm64`         | macOS on Apple Silicon        | ✅           | `smoke (darwin-arm64, 26)`              |
| `nanoraster-darwin-x64`           | macOS on Intel                | ✅           | `smoke (darwin-x64, 26)`                |
| `nanoraster-linux-x64-gnu`        | Linux x64, glibc              | ✅           | `smoke (linux-x64-gnu, 26)`             |
| `nanoraster-linux-x64-musl`       | Linux x64, musl               | ✅           | `smoke (linux-x64-musl, 26)`            |
| `nanoraster-linux-arm64-gnu`      | Linux arm64, glibc            | ✅           | `smoke (linux-arm64-gnu, 26)`           |
| `nanoraster-linux-arm64-musl`     | Linux arm64, musl             | ✅           | `smoke (linux-arm64-musl, 26)`          |
| `nanoraster-linux-arm-gnueabihf`  | Linux armv7 hard-float, glibc | ✅           | `smoke (linux-arm-gnueabihf, 22.13.0)`  |
| `nanoraster-linux-arm-musleabihf` | Linux armv7 hard-float, musl  | ✅           | `smoke (linux-arm-musleabihf, 22.13.0)` |
| `nanoraster-linux-ppc64-gnu`      | Linux ppc64le, glibc          | ✅           | `smoke (linux-ppc64-gnu, 26)`           |
| `nanoraster-linux-s390x-gnu`      | Linux s390x, glibc            | ✅           | `smoke (linux-s390x-gnu, 26)`           |
| `nanoraster-win32-x64-msvc`       | Windows on x64                | ✅           | `smoke (win32-x64-msvc, 26)`            |
| `nanoraster-win32-arm64-msvc`     | Windows on arm64              | ✅           | `smoke (win32-arm64-msvc, 26)`          |
| `nanoraster-win32-ia32-msvc`      | Windows on x86                | ✅           | `smoke (win32-ia32-msvc, 22)`           |
| `nanoraster-freebsd-x64`          | FreeBSD on x64                | ✅           | `smoke (freebsd-x64, 22)`               |
| `nanoraster-android-arm64`        | Android on arm64              | Experimental | `build (aarch64-linux-android)`         |
| `nanoraster-android-arm-eabi`     | Android on armv7              | Experimental | `build (armv7-linux-androideabi)`       |

### Node.js line per host

The floor is Node.js 22.13.0. Node.js 24 and 26 publish no official
`linux-armv7l` or `win-x86` build, so `nanoraster-linux-arm-gnueabihf`,
`nanoraster-linux-arm-musleabihf` and `nanoraster-win32-ia32-msvc` are exercised
on the Node.js 22 line and inherit its 2027-04-30 end of life. Every other host
runs the Node.js 22.13 and Node.js 26 lanes. A later line that restores those
downloads extends the three rows; without one they retire with Node.js 22.

The official Node.js binaries link `libatomic` from Node.js 26 on, as the
Node.js 22 armv7 build already does. Every published `node` image carries that
library and a bare `ubuntu:24.04` does not, so a container that unpacks the
tarball itself, as the ppc64le and s390x smoke rows do, installs `libatomic1`
beside it.

### glibc, musl and endianness

Linux x64, arm64, ppc64le and s390x packages declare `libc`, so a package
manager on Alpine takes the musl package and one on Debian or Ubuntu takes the
glibc package. NAPI-RS emits no `libc` selector for the two armv7 packages, and
Yarn classic ignores `libc` everywhere; in both cases both packages install and
the loader probes the host and loads the matching binary. The glibc packages link against symbols up to `GLIBC_2.17`.

npm's `cpu: ppc64` selector does not distinguish endianness, and the package
holds a little-endian `powerpc64le` binary, so a big-endian ppc64 host is
rejected with a `RenderError` carrying code `adapter-unavailable` rather than
loading a binary it cannot run. `nanoraster-linux-s390x-gnu` is the big-endian
package, and its render job is what proves the encoders produce identical bytes
there.

### Alpine and other musl hosts

A software Vulkan render on musl needs more thread stack than musl's 128 KiB
default. Mesa's lavapipe compiles a shader variant on a driver thread it creates
with default attributes, and LLVM 22 code generation for AArch64 overruns
anything below 512 KiB, taking the host process down with it. The first adapter
request raises the process-wide default to 8 MiB, the size glibc gives the same
thread. That default reaches every thread the process creates after it with
default attributes; threads that carry an explicit stack size, including
Node.js's own worker pool and every thread Rust spawns, keep theirs.

### armv7 hard-float

Both armv7 packages behave the same way, and the host's Vulkan driver decides
what happens. Lavapipe from mesa 23 onwards crashes in `handle_vertex_buffers2`,
in `src/gallium/frontends/lavapipe/lvp_execute.c`, on 32-bit ARM, replaying a
vertex-buffer bind through a stride pointer it never wrote. On a 32-bit ARM
Linux host nanoraster reads the adapter's driver version before it creates a
device, and refuses such a driver with a `RenderError` carrying code
`driver-unsupported`.
The refusal names the defect, and it holds until mesa ships a fix.

Below the break both packages render. `smoke (linux-arm-gnueabihf, 22.13.0)`
renders on Debian bookworm and its mesa 22.3.6, and
`smoke (linux-arm-musleabihf, 22.13.0)` renders on Alpine with lavapipe pinned to
the Alpine 3.17 repository, whose mesa 22.2.5 is the last release before the
break. Above it, `smoke (linux-arm-gnueabihf, 22)` on Debian trixie and
`smoke (linux-arm-musleabihf, 22)` on current Alpine assert the refusal instead.

`NANORASTER_ALLOW_UNSUPPORTED_DRIVER=1` skips the refusal and creates the device
anyway, which is what 0.4.0 did: on every host measured so far the render then
dies inside mesa. Set it on a mesa build that carries a fix, or on a host that
proves the guard wrong.

Every armv7 row runs under `qemu-user` on hosted x64 runners. Those rows name
the lavapipe ICD in `VK_DRIVER_FILES` because the emulated 32-bit Vulkan loader
finds no driver when it scans the manifest directory itself, which is an
emulation artefact rather than something a real armv7 host asks of a consumer.
Neither package is verified on real armv7 hardware, or against a hardware Vulkan
driver, so the guard may refuse a driver that would have worked.

### FreeBSD and Android

FreeBSD installs from npm like any other host and needs a Vulkan driver on the
system (`graphics/mesa-dri` plus `vulkan-loader`, with `VK_DRIVER_FILES` naming
the lavapipe ICD when there is no hardware driver).

The Android packages carry inspected ELF binaries with the same selectors as
every other row, and hosted runners have no ARM GPU device to render on. They
become supported when a required job renders through the public API on real
arm64 and armv7 hardware.

## Render profile

| glTF 2.0 feature                                                   | Supported |
| ------------------------------------------------------------------ | --------- |
| Factor-only `baseColorFactor`, `metallicFactor`, `roughnessFactor` | Yes       |
| All texture-backed PBR materials                                   | No        |
| Surface-less WebGPU rendering                                      | Yes       |

Factor-only metallic-roughness materials use deterministic analytic studio
lighting. Texture-backed materials return a parse error.
