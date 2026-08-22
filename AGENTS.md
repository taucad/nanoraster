# AGENTS.md

## Commands

```bash
pnpm nx run nanoraster:quality
pnpm nx run nanoraster:test
pnpm nx run nanoraster:build
pnpm nx run nanoraster:validate-pack
pnpm run build:napi
```

## Architecture

`src/` is the ESM TypeScript facade. Its Node entry sits behind the `node`
export condition and loads the native addon; the default entry is the wasm
WebGPU binding and imports no Node builtin. `rust/render-core` owns GLB
parsing, rendering, annotations, and encoding; `render-napi` and `render-wasm`
are host shells. `docs-site/` is a static Fumadocs site generated from public
TypeScript exports.

`package.json`'s `napi.targets` is the only architecture list: the sixteen
target triples there produce the sixteen platform packages, their npm selectors,
and the root `optionalDependencies` of a release. `pnpm run build:napi` writes
the generated loader and host addon into `src/native/`, and release assembly
generates `npm/` from the same target list. Both directories are build output,
ignored by git, and never hand-edited.

The benchmark and codec-conformance entry points sit behind render-core's
default-off `bench` cargo feature, which `render-napi` and `render-wasm`
forward. Published artifacts never carry them. `pnpm run build:napi:bench` and
`pnpm run build:wasm:bench` build feature-enabled siblings of the same source
under `tests/out/`, which is where the gated benchmark and the browser
conformance test read them from.

## Conventions

- ESM-only public API through package exports.
- Keep `unbundle: true`; binary URL resolution depends on relative output.
- Public exports require stable JSDoc and consumer-shape tests.
- Options are flat by default; nest only value objects, tagged unions, or
  co-varying subsystems. When a feature needs configuration, widen its own key
  so the object's presence is the flag. Revisit at more than five annotations,
  or once two of them each carry three or more configuration fields.
- GitHub Actions is the sole npm publisher.
- Every compatibility check mark maps to a CI job.
- Admission changes are explicit budget or benchmark-identity diffs.

## Skills

| Skill                | When to use                                      |
| -------------------- | ------------------------------------------------ |
| `release-nanoraster` | Auditing or preparing a reviewed package release |
