<p align="center">
  <img src="images/banner.svg" alt="nanoraster" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/nanoraster"><img src="https://img.shields.io/npm/v/nanoraster?logo=npm&logoColor=white&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://github.com/taucad/nanoraster/actions/workflows/ci.yml"><img src="https://github.com/taucad/nanoraster/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://tau.new"><img src="https://img.shields.io/badge/Tau-ecosystem-6d28d9" alt="Part of the Tau ecosystem"></a>
</p>

Tiny headless WebGPU GLTF renderer for deterministic PNG, WebP, and JPEG output.

[![PBR helical gear rendered to WebP by nanoraster](https://nanoraster.xyz/demo/helical-gear-pbr.webp)](https://nanoraster.xyz/#live-demo)

The [live camera demo](https://nanoraster.xyz/#live-demo) lets you orbit a GLB
in Three.js, then passes that camera to nanoraster for a browser WebGPU capture.

[![Three.js live camera and matching nanoraster WebP capture](https://nanoraster.xyz/demo/live-camera-capture.png)](https://nanoraster.xyz/#live-demo)

| I want to…               | Start here                                                          |
| ------------------------ | ------------------------------------------------------------------- |
| Install the package      | [Install](#install)                                                 |
| Run the smallest example | [Quick start](#quick-start)                                         |
| Choose a supported host  | [Compatibility](#compatibility)                                     |
| Contribute or release    | [CONTRIBUTING.md](CONTRIBUTING.md) / [MAINTAINER.md](MAINTAINER.md) |

## Install

```bash
npm install nanoraster
```

```bash
pnpm add nanoraster
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

## Documentation

- [Documentation](https://nanoraster.xyz)
- [Source](https://github.com/taucad/nanoraster)
- [Changelog](CHANGELOG.md)
- [Issues](https://github.com/taucad/nanoraster/issues)

## License

Apache-2.0. See [license](license) and [NOTICE](NOTICE) for bundled materials.

Part of the [Tau ecosystem](https://tau.new).
