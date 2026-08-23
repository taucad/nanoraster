#!/usr/bin/env bash
# Runs probe.c across the image matrix that bounds the 32-bit ARM lavapipe
# fault and prints one row per image. Every 32-bit row runs under qemu-user
# through Docker's binfmt handler; see README.md for the caveat.
#
#   ./run.sh                 # the whole matrix
#   ./run.sh alpine:3.21     # one image, matched as a substring
#   PROBE_BACKTRACE=1 ./run.sh alpine:3.21   # add a gdb backtrace
#
# Only the directory holding this script is mounted, so keep the checkout under
# $HOME when the Docker daemon restricts mounts to the home tree.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
filter="${1:-}"
backtrace="${PROBE_BACKTRACE:-0}"

alpine_setup='
apk add --no-cache vulkan-loader mesa-vulkan-swrast vulkan-headers gcc musl-dev >/dev/null 2>&1
apk add --no-cache vulkan-loader-dev >/dev/null 2>&1 || ln -sf /usr/lib/libvulkan.so.1 /usr/lib/libvulkan.so
'

# shellcheck disable=SC2016 # the container shell expands this, not this one.
debian_setup='
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq libvulkan-dev mesa-vulkan-drivers gcc libc6-dev >/dev/null 2>&1
# The 32-bit Vulkan loader cannot read the ICD directory under qemu-user, so
# name the lavapipe manifest directly.
export VK_DRIVER_FILES=$(ls /usr/share/vulkan/icd.d/lvp_icd*.json 2>/dev/null | head -1)
'

run_probe='
cp /probe/probe.c /probe/shaders.h /tmp/ && cd /tmp
gcc -O1 -g -std=c11 -Wall -Wextra -Werror probe.c -lvulkan -o probe || { echo "BUILD_FAILED"; exit 90; }
./probe
echo "EXIT=$?"
'

backtrace_probe='
if command -v apk >/dev/null 2>&1; then apk add --no-cache gdb mesa-dbg >/dev/null 2>&1 || apk add --no-cache gdb >/dev/null 2>&1
else apt-get install -y -qq gdb >/dev/null 2>&1; fi
gdb -batch -ex "handle SIGILL nostop noprint pass" -ex run -ex "bt 25" --args /tmp/probe 2>&1 | tail -40
'

rows=(
  "alpine:3.21|linux/arm/v7|alpine"
  "alpine:3.19|linux/arm/v7|alpine"
  "alpine:3.18|linux/arm/v7|alpine"
  "debian:trixie-slim|linux/arm/v7|debian"
  "debian:bookworm-slim|linux/arm/v7|debian"
  "alpine:3.24|linux/arm64|alpine"
  "debian:trixie-slim|linux/arm64|debian"
)

printf '%-20s %-14s %-14s %-6s %-34s %s\n' IMAGE PLATFORM MESA EXIT "LAST STEP" PIXEL
for row in "${rows[@]}"; do
  IFS='|' read -r image platform family <<<"$row"
  if [ -n "$filter" ] && [[ "$image" != *"$filter"* ]]; then continue; fi

  setup="$alpine_setup"
  [ "$family" = debian ] && setup="$debian_setup"
  script="$setup$run_probe"
  [ "$backtrace" = 1 ] && script="$script$backtrace_probe"

  log=$(docker run --rm --platform "$platform" -v "$here:/probe:ro" \
    "$image" sh -c "$script" 2>&1)

  # driverInfo is the driver's own version string, so it beats a package query.
  mesa=$(printf '%s\n' "$log" | sed -n 's/^driverInfo: Mesa //p' | sed 's/ (LLVM.*//' | head -1)
  exit_code=$(printf '%s\n' "$log" | sed -n 's/^EXIT=//p' | head -1)
  [ -z "$exit_code" ] && exit_code=SIGNAL
  last_step=$(printf '%s\n' "$log" | sed -n 's/^step: //p' | tail -1)
  pixel=$(printf '%s\n' "$log" | sed -n 's/^centre pixel: //p' | head -1)
  [ -z "$pixel" ] && pixel="-"

  printf '%-20s %-14s %-14s %-6s %-34s %s\n' \
    "$image" "$platform" "${mesa:-?}" "$exit_code" "${last_step:-none}" "$pixel"
  printf '%s\n' "$log" | sed 's/^/    | /'
done
