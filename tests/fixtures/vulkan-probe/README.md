# Standalone Vulkan probe

`probe.c` is a dependency-free Vulkan client. It creates an instance and a
device on the first adapter, uploads a three-vertex buffer, builds a graphics
pipeline from the two shaders beside it, binds the vertex buffer with
`vkCmdBindVertexBuffers`, draws into a 64x64 offscreen image, copies that image
into a host-visible buffer, and prints the centre pixel. It links the Vulkan
headers and the loader, nothing else: no SDK helpers, no nanoraster, no wgpu, no
Rust.

The program exists for attribution. On 32-bit ARM hosts whose Vulkan
implementation is mesa's software driver, a nanoraster render kills the consumer
process with `SIGSEGV` inside `libvulkan_lvp.so`. This program issues the same
command sequence with none of that stack underneath it, so its outcome separates
a driver defect from a defect in nanoraster.

It ships in no package (the `files` list in `package.json` covers `dist` and the
top-level documents only) and no continuous integration job runs it. Rebuild it
by hand when the question comes up again.

## What it mirrors

The vendored wgpu Vulkan backend binds vertex buffers with plain
`vkCmdBindVertexBuffers`, never the `2` variant, so no stride pointer leaves the
caller. The probe copies that call and the pipeline state around it: one binding
of stride 8 with one `R32G32_SFLOAT` attribute, triangle-list topology, no
culling, no depth attachment, a render pass object rather than dynamic
rendering, and the four dynamic states wgpu declares (viewport, scissor, blend
constants, stencil reference).

Two differences are deliberate. The probe enables no device extensions, where
wgpu takes `VK_EXT_robustness2` when the adapter offers it, and the probe makes
one queue submission instead of driving wgpu's encoder. Neither difference
changes the outcome below.

## Exit codes

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| 0    | the centre pixel holds the fragment colour                    |
| 1    | a Vulkan call failed; the step and the `VkResult` are printed |
| 2    | the centre pixel holds a different colour                     |
| 134  | the shell's report of a process killed by `SIGABRT`           |
| 139  | the shell's report of a process killed by `SIGSEGV`           |

Every call prints a line before it runs, so a crash log names the last call the
program reached.

## Build and run

```sh
# Alpine
apk add --no-cache vulkan-loader vulkan-loader-dev mesa-vulkan-swrast \
  vulkan-headers gcc musl-dev

# Debian
apt-get install -y libvulkan-dev mesa-vulkan-drivers gcc libc6-dev
# The 32-bit loader cannot read the driver directory under emulation:
export VK_DRIVER_FILES=$(ls /usr/share/vulkan/icd.d/lvp_icd*.json)

gcc -O1 -g -std=c11 -Wall -Wextra -Werror probe.c -lvulkan -o probe
./probe
```

`run.sh` drives the whole image matrix through Docker and prints one row per
image. It mounts the directory holding the script and nothing else.

```sh
./run.sh                                   # every image
./run.sh alpine:3.21                       # one image, matched as a substring
PROBE_BACKTRACE=1 ./run.sh alpine:3.21     # add a debugger backtrace
```

## Results

| Image                  | Platform       | mesa   | Exit | Last call            | Centre pixel |
| ---------------------- | -------------- | ------ | ---- | -------------------- | ------------ |
| `alpine:3.21`          | `linux/arm/v7` | 24.2.8 | 139  | `vkQueueWaitIdle`    | none         |
| `alpine:3.19`          | `linux/arm/v7` | 23.3.6 | 139  | `vkQueueWaitIdle`    | none         |
| `alpine:3.18`          | `linux/arm/v7` | 23.0.4 | 139  | `vkQueueWaitIdle`    | none         |
| `debian:trixie-slim`   | `linux/arm/v7` | 25.0.7 | 134  | `vkCmdEndRenderPass` | none         |
| `debian:bookworm-slim` | `linux/arm/v7` | 22.3.6 | 0    | `teardown`           | `00ff00ff`   |
| `alpine:3.24`          | `linux/arm64`  | 26.1.6 | 139  | `vkQueueWaitIdle`    | none         |
| `debian:trixie-slim`   | `linux/arm64`  | 25.0.7 | 0    | `teardown`           | `00ff00ff`   |

The `driverName` string is `llvmpipe` on every row. The `driverInfo` strings,
verbatim, are `Mesa 24.2.8 (LLVM 19.1.4)`, `Mesa 23.3.6 (LLVM 17.0.5)`,
`Mesa 23.0.4 (LLVM 15.0.7)`, `Mesa 25.0.7-2+deb13u1 (LLVM 19.1.7)`,
`Mesa 22.3.6 (LLVM 15.0.6)` and `Mesa 26.1.6 (LLVM 22.1.3)`. Debian's build
appends a package revision to the version, and every driver reports a
`driverVersion` of `0.0.1` apart from the Alpine 3.24 build, so `driverInfo` is
the only field that carries a usable version.

The 64-bit Alpine row fails for an unrelated reason: musl's 128 KiB default
thread stack overflows inside mesa's worker threads. With an `LD_PRELOAD`
constructor raising the default to 8 MiB, that row renders `00ff00ff`. The same
constructor on the 32-bit Alpine rows changes nothing, which separates the two
defects. The 64-bit Debian row is the clean control: the same mesa 25.0.7 that
kills the 32-bit run renders on 64 bits.

## The faulting frame

An `LD_PRELOAD` signal interposer on Alpine 3.21 reports the fault at
`libvulkan_lvp.so+0x69c08` with an unmapped-address signal code and `r3` holding
the bad pointer. Alpine's `mesa-dbg` package resolves the addresses:

```
0x69c08  handle_vertex_buffers2   lvp_execute.c:1177
0x6acc3  handle_graphics_pipeline lvp_execute.c:825
0x6d717  lvp_execute_cmd_buffer   lvp_execute.c:4874
0x6e92b  lvp_execute_cmds         lvp_execute.c:5264
```

Every frame is inside the driver. That is the same address and the same symbol
the nanoraster crash reports.

The 32-bit Debian row shows the other half of the story. glibc's allocator
detects a corrupted heap during recording, one call after the vertex-buffer
bind, and aborts with `malloc(): invalid size (unsorted)` before the queue ever
runs. musl's allocator does not check, so the corruption survives to replay and
surfaces as the bad pointer above.

## Verdict

The fault reproduces without nanoraster, without wgpu and without Rust, in the
same driver function, from a program that passes no strides. The defect belongs
to mesa's software Vulkan driver on 32-bit ARM. mesa 22.3.6 renders; 23.0.4 is
the lowest version observed to fail, and every version from there through 25.0.7
fails. The trigger sits in command-buffer recording around
`vkCmdBindVertexBuffers` and the draw that follows it, and the crash a consumer
sees depends on which allocator the host carries.

## Emulation caveat

Every 32-bit row above ran under `qemu-user` on a 64-bit ARM host. No 32-bit ARM
hardware executed any of it. The fault reads as a genuine 32-bit defect — a bad
pointer in the driver's own command replay, in a driver that renders the same
scene on 64 bits — but an emulator is not a machine, and a hardware run could
narrow or overturn the boundary recorded here.

## Regenerating the shaders

`shaders.h` holds the compiled SPIR-V for `triangle.vert` and `solid.frag` as
`uint32_t` arrays. The header's own comment carries the `glslang` command that
produced the two `.spv` files. Turn a `.spv` file back into an array with:

```sh
node -e '
const fs = require("node:fs");
const buf = fs.readFileSync(process.argv[1]);
const words = [];
for (let i = 0; i < buf.length; i += 4) {
  words.push("0x" + buf.readUInt32LE(i).toString(16).padStart(8, "0"));
}
console.log(words.join(", "));
' triangle.vert.spv
```
