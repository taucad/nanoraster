## 0.3.0 (2026-08-19)

### 🚀 Features

- Retune the studio preset (ACES tone map, diffuse environment irradiance, warmer rig) to match the Tau viewer, and add a `lighting` option: the `'studio'` preset or a custom rig of up to 8 directional lights with ambient, environment, space, and exposure. Every default render changes appearance. ([#23](https://github.com/taucad/nanoraster/pull/23))
- Inline the option literal unions at their property sites. `RenderImageFormat`, `RenderUpAxis` and `RenderProjection` are no longer exported: `format`, `up` and `projection` now read as `'png' | 'webp' | 'jpeg' | 'jpg'`, `'x' | 'y' | 'z'` and `'perspective' | 'orthographic'` in editors, in the generated type tables and in the reference. Code that named an alias should name the literal union instead; every object type and `RenderFailureCode` keep their exports. Breaking under the prerelease policy documented in the README section "Versioning and stability". ([5497050](https://github.com/taucad/nanoraster/commit/5497050))

### 🩹 Fixes

- Publish complete field documentation for public render options, image results, and typed errors. ([#17](https://github.com/taucad/nanoraster/pull/17))

### ❤️ Thank You

- Claude Fable 5
- Richard Fontein @rifont

## 0.2.0 (2026-08-15)

### 🚀 Features

- Add factor-only glTF metallic-roughness PBR rendering. ([#8](https://github.com/taucad/nanoraster/pull/8))

### ❤️ Thank You

- Richard Fontein @rifont

## 0.1.0 (2026-08-15)

### 🚀 Features

- Publish the initial nanoraster package with WebGPU wasm and native Node artifacts for macOS arm64, Linux x64 glibc, and Windows x64 MSVC. ([#14](https://github.com/taucad/nanoraster/pull/14))

### ❤️ Thank You

- Richard Fontein @rifont

# Changelog

All notable changes to nanoraster are recorded here.

## Unreleased

- Extract the renderer into its standalone package.
