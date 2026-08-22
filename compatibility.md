# Compatibility

Every mark in the tables below names the job in `.github/workflows/ci.yml` that
proves it. `✅` means a render on that host is required before a release.
`Pending` means the package is built, inspected and published, and the named
render job promotes it on its first green run. `Experimental` means the package
is built and its binary inspected, with no render evidence.

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

| Platform package                  | Host                          | Support      | CI evidence                        |
| --------------------------------- | ----------------------------- | ------------ | ---------------------------------- |
| `nanoraster-darwin-arm64`         | macOS on Apple Silicon        | ✅           | `smoke (darwin-arm64, 26)`         |
| `nanoraster-darwin-x64`           | macOS on Intel                | Pending      | `smoke (darwin-x64, 26)`           |
| `nanoraster-linux-x64-gnu`        | Linux x64, glibc              | ✅           | `smoke (linux-x64-gnu, 26)`        |
| `nanoraster-linux-x64-musl`       | Linux x64, musl               | Pending      | `smoke (linux-x64-musl, 26)`       |
| `nanoraster-linux-arm64-gnu`      | Linux arm64, glibc            | Pending      | `smoke (linux-arm64-gnu, 26)`      |
| `nanoraster-linux-arm64-musl`     | Linux arm64, musl             | Pending      | `smoke (linux-arm64-musl, 26)`     |
| `nanoraster-linux-arm-gnueabihf`  | Linux armv7 hard-float, glibc | Pending      | `smoke (linux-arm-gnueabihf, 22)`  |
| `nanoraster-linux-arm-musleabihf` | Linux armv7 hard-float, musl  | Pending      | `smoke (linux-arm-musleabihf, 22)` |
| `nanoraster-linux-ppc64-gnu`      | Linux ppc64le, glibc          | Pending      | `smoke (linux-ppc64-gnu, 26)`      |
| `nanoraster-linux-s390x-gnu`      | Linux s390x, glibc            | Pending      | `smoke (linux-s390x-gnu, 26)`      |
| `nanoraster-win32-x64-msvc`       | Windows on x64                | ✅           | `smoke (win32-x64-msvc, 26)`       |
| `nanoraster-win32-arm64-msvc`     | Windows on arm64              | Pending      | `smoke (win32-arm64-msvc, 26)`     |
| `nanoraster-win32-ia32-msvc`      | Windows on x86                | Pending      | `smoke (win32-ia32-msvc, 22)`      |
| `nanoraster-freebsd-x64`          | FreeBSD on x64                | Pending      | `smoke (freebsd-x64, 22)`          |
| `nanoraster-android-arm64`        | Android on arm64              | Experimental | `build (aarch64-linux-android)`    |
| `nanoraster-android-arm-eabi`     | Android on armv7              | Experimental | `build (armv7-linux-androideabi)`  |

### Node.js line per host

The floor is Node.js 22.13.0. Node.js 24 and 26 publish no official
`linux-armv7l` or `win-x86` build, so `nanoraster-linux-arm-gnueabihf`,
`nanoraster-linux-arm-musleabihf` and `nanoraster-win32-ia32-msvc` are exercised
on the Node.js 22 line and inherit its 2027-04-30 end of life. Every other host
runs the Node.js 22.13 and Node.js 26 lanes. A later line that restores those
downloads extends the three rows; without one they retire with Node.js 22.

### glibc, musl and endianness

Linux packages declare `libc`, so a package manager on Alpine takes the musl
package and one on Debian or Ubuntu takes the glibc package. Yarn classic
ignores `libc` and installs both; the loader still probes the host and loads the
matching binary. The glibc packages link against symbols up to `GLIBC_2.17`.

npm's `cpu: ppc64` selector does not distinguish endianness, and the package
holds a little-endian `powerpc64le` binary, so a big-endian ppc64 host is
rejected with a `RenderError` carrying code `adapter-unavailable` rather than
loading a binary it cannot run. `nanoraster-linux-s390x-gnu` is the big-endian
package, and its render job is what proves the encoders produce identical bytes
there.

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
