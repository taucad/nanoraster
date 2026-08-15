#!/usr/bin/env bash
#
# Enforce 100% first-party Rust line coverage with the RQ4 carve-outs.
#
# The carve-out shape is ruled in docs/research/create-repo-skill-nanoraster-blueprint.md.
#
# Required env vars:
#   None.
# Optional env vars:
#   None.
#
# Usage:
#   scripts/test-rust-coverage.sh
#
# Exit codes:
#   0  Coverage is exactly 100%.
#   1  Tests fail or first-party coverage is below 100%.
#   3  cargo-llvm-cov is unavailable.

set -euo pipefail

command -v cargo >/dev/null || { printf '%s\n' 'ERROR: cargo is required' >&2; exit 3; }
cargo llvm-cov --version >/dev/null 2>&1 || {
  printf '%s\n' 'ERROR: cargo-llvm-cov is required' >&2
  exit 3
}

REPO_ROOT="$(git rev-parse --show-toplevel)"

# -- reason: third-party image-webp source is tested through nanoraster's codec conformance oracle.
# -- reason: render-wasm is a wasm-bindgen macro shell covered by the three-browser wasm smoke.
# -- reason: render-napi is a napi macro shell covered by the native singular/batch parity suite.
IGNORE_PATHS='vendor/image-webp|render-wasm|render-napi'

cd "$REPO_ROOT"
cargo llvm-cov \
  --manifest-path rust/Cargo.toml \
  --workspace \
  --ignore-filename-regex "$IGNORE_PATHS" \
  --fail-under-lines 100 \
  --summary-only

printf '%s\n' '✓ Rust line coverage is 100%'
