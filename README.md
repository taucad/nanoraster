<h1 align="center">
  <img src="images/banner.svg" alt="nanoraster" width="100%">
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/nanoraster"><img src="https://img.shields.io/npm/v/nanoraster?logo=npm&logoColor=white&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://github.com/taucad/nanoraster/actions/workflows/ci.yml"><img src="https://github.com/taucad/nanoraster/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://tau.new"><img src="https://img.shields.io/badge/Tau-ecosystem-6d28d9" alt="Part of the Tau ecosystem"></a>
</p>

Tiny headless WebGPU glTF renderer for deterministic PNG, WebP, JPEG, and raw RGBA output.
One Rust core runs native in Node.js and on WebGPU in the browser.

[![PBR spur gear rendered to WebP by nanoraster](https://nanoraster.xyz/demo/helical-gear-pbr.webp)](https://nanoraster.xyz/#live-demo)

Try the [live demo](https://nanoraster.xyz/#live-demo), then the
[docs](https://nanoraster.xyz/docs) — served as Markdown for agents at
[nanoraster.xyz/llms.txt](https://nanoraster.xyz/llms.txt).

## Install

```bash
npm install nanoraster
```

## Quick start

```typescript
import { renderImage } from 'nanoraster';

import { readFile, writeFile } from 'node:fs/promises';

const glb = Uint8Array.from(await readFile('model.glb'));
const image = await renderImage(glb, {
  format: 'webp',
  width: 512,
  height: 512,
});
await writeFile(image.name, image.bytes);
```

Same request, same pixels: a render can serve as evidence. `format: 'raw'`
returns the RGBA frame for pixel diffs, video frames and textures
([Work with raw pixels](https://nanoraster.xyz/docs/guides/work-with-raw-pixels)).

Spatial values are Cartesian, defaulting to glTF's +Y-up, +Z-forward, metre
world; declare `world` when the caller uses another convention:

```typescript
const image = await renderImage(glb, {
  format: 'webp',
  world: { up: '+z', forward: '-y', unit: 'millimeter' },
  camera: {
    framing: 'fit',
    direction: [1, 1, 1],
  },
  lineWidth: 3,
});
```

`framing: 'fit'` solves placement and clipping around the subject;
`framing: 'fixed'` preserves an explicit Cartesian `position`/`target`/`up`
pose and projection. Edge lines are a flat 3 output pixels. See
[Frame the model](https://nanoraster.xyz/docs/guides/frame-the-model) and
[Place the camera](https://nanoraster.xyz/docs/guides/place-the-camera).

## Reuse the renderer

One-shot calls share one renderer per process; create your own to control
lifetime and power preference. Declaring all outputs in one `renderImages`
call with per-view overrides is about three times faster:

```typescript
import { createRenderer } from 'nanoraster';

using renderer = await createRenderer({ powerPreference: 'low-power' });

const [card, og] = await renderer.renderImages(glb, {
  format: 'webp',
  views: [
    { id: 'card', width: 768, height: 576 },
    { id: 'og', width: 1536, height: 804, format: 'png' },
  ],
});
```

See [Reuse the renderer](https://nanoraster.xyz/docs/guides/reuse-the-renderer).

## Compatibility

See [compatibility.md](compatibility.md); every check mark maps to a named job
in `.github/workflows/ci.yml`.

## Versioning and stability

Semantic Versioning; before 1.0 a minor release may break the API — see
[BREAKING_CHANGES.md](BREAKING_CHANGES.md).

## Security and provenance

Report vulnerabilities through GitHub private vulnerability reporting. Verify
registry signatures with `npm audit signatures`.

## Links

[Changelog](CHANGELOG.md) · [Issues](https://github.com/taucad/nanoraster/issues) ·
[Contributing](CONTRIBUTING.md) · [Maintaining](MAINTAINER.md)

## License

Apache-2.0. See [license](license) and [NOTICE](NOTICE) for bundled materials.

Part of the [Tau ecosystem](https://tau.new).
