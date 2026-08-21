# AGENTS.md

## Commands

```bash
pnpm nx run nanoraster:quality
pnpm nx run nanoraster:test
pnpm nx run nanoraster:build
pnpm nx run nanoraster:validate-pack
```

## Architecture

`src/` is the ESM TypeScript facade. It validates requests and selects a napi
binding in Node.js or the wasm WebGPU binding in browsers. `rust/render-core`
owns GLB parsing, rendering, annotations, and encoding; `render-napi` and
`render-wasm` are host shells. `npm/` holds the three native platform packages.
`docs-site/` is a static Fumadocs site generated from public TypeScript exports.

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
