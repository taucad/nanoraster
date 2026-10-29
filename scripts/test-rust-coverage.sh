#!/usr/bin/env bash
#
# Enforce zero uncovered first-party Rust source lines with the RQ4 carve-outs.
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
#   0  No source lines or functions are uncovered.
#   1  Tests fail or first-party source lines/functions are uncovered.
#   3  cargo-llvm-cov is unavailable.

set -euo pipefail

command -v cargo >/dev/null || { printf '%s\n' 'ERROR: cargo is required' >&2; exit 3; }
cargo llvm-cov --version >/dev/null 2>&1 || {
  printf '%s\n' 'ERROR: cargo-llvm-cov is required' >&2
  exit 3
}

REPO_ROOT="$(git rev-parse --show-toplevel)"

# -- reason: third-party image-webp source is tested through nanoraster's codec conformance oracle.
# -- reason: vendored wgpu-hal (one DX12 alignment patch) is exercised by the Windows smoke rows, not unit tests.
# -- reason: render-wasm is a wasm-bindgen macro shell covered by the three-browser wasm smoke.
# -- reason: render-napi is a napi macro shell covered by the native singular/batch parity suite.
IGNORE_PATHS='vendor/image-webp|vendor/wgpu-hal|render-wasm|render-napi'

cd "$REPO_ROOT"
# --all-features keeps the default-off `bench` surface measured rather than
# silently uncompiled: its code counts, and its tests run.
# Tests share the CI GPU. Bound simultaneous shader compilation by serializing
# separate cases; explicit concurrency inside individual tests remains.
# Exercise native opt-in timing/ledger collection. Its regression also runs an
# independent query-free child to verify that instrumentation changes no pixels.
# LLVM's aggregate summary can count phantom missed lines although its source
# report has none (cargo-llvm-cov#380). Use the supported source-line check,
# not a percentage tolerance or new exclusion; keep function coverage strict.
# https://github.com/taiki-e/cargo-llvm-cov/pull/277
NANORASTER_GPU_PROFILE=1 cargo llvm-cov \
  --manifest-path rust/Cargo.toml \
  --workspace \
  --all-features \
  --ignore-filename-regex "$IGNORE_PATHS" \
  --fail-uncovered-lines 0 \
  --fail-under-functions 100 \
  --show-missing-lines \
  --summary-only \
  -- --test-threads=1

printf '%s\n' '✓ No uncovered Rust source lines; function coverage is 100%'
