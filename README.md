<h1 align="center">
  <img src="images/banner.svg" alt="nanoraster" width="100%">
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/nanoraster"><img src="https://img.shields.io/npm/v/nanoraster?logo=npm&logoColor=white&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://github.com/taucad/nanoraster/actions/workflows/ci.yml"><img src="https://github.com/taucad/nanoraster/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://tau.new"><img src="https://img.shields.io/badge/Tau-ecosystem-6d28d9" alt="Part of the Tau ecosystem"></a>
</p>

Tiny headless WebGPU glTF renderer for deterministic PNG, WebP, and JPEG output.
Runs on a native binary in Node.js and on WebGPU in the browser, from one Rust
render core.

[![PBR spur gear rendered to WebP by nanoraster](https://nanoraster.xyz/demo/helical-gear-pbr.webp)](https://nanoraster.xyz/#live-demo)

Try the [live demo](https://nanoraster.xyz/#live-demo), then read the
[docs](https://nanoraster.xyz/docs): quick start, guides and the API reference,
also served as Markdown for agents at
[nanoraster.xyz/llms.txt](https://nanoraster.xyz/llms.txt).

## Install

```bash
npm install nanoraster
```

## Quick start

```typescript
import { renderGlbToImage } from 'nanoraster';

import { readFile, writeFile } from 'node:fs/promises';

const glb = Uint8Array.from(await readFile('model.glb'));
const image = await renderGlbToImage(glb, {
  format: 'png',
  width: 512,
  height: 512,
});
await writeFile(image.name, image.bytes);
```

Same request, same pixels: the camera, lighting and encoder are fixed for a
given request, so a render can serve as evidence. Continue with the
[tutorial and guides](https://nanoraster.xyz/docs).

## Reuse the renderer

The one-shot calls already share one renderer per process, so only the first
pays the GPU bring-up. Hold a renderer of your own when the device's lifetime
or power preference matters, and declare a known set of outputs as one call —
per-view `width`, `height`, `format` and `quality` overrides turn a resolution
ladder into a single crossing, measured three times faster than six separate
renders on an Apple M2 Pro:

```typescript
import { createRenderer } from 'nanoraster';

using renderer = await createRenderer({ powerPreference: 'low-power' });

const [card, og, print] = await renderer.renderGlbToImages(glb, {
  format: 'webp',
  width: 768,
  height: 576,
  views: [
    { id: 'card', phi: 60, theta: -45 },
    { id: 'og', phi: 60, theta: -45, width: 1536, height: 804 },
    { id: 'print', phi: 60, theta: -45, width: 1536, height: 804, format: 'png' },
  ],
});
// renderer.dispose() runs automatically at scope exit via `using`.
```

Pixels are byte-identical to the one-shot calls on the same adapter. See
[Reuse the renderer](https://nanoraster.xyz/docs/guides/reuse-the-renderer).

## Compatibility

See [compatibility.md](compatibility.md). Every check mark in that table maps
to a named job in `.github/workflows/ci.yml`.

## Versioning and stability

Versions follow Semantic Versioning. Before 1.0, a minor release may contain a
breaking API change; each major line records those changes in
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
