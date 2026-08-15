# nanoraster

[![npm](https://img.shields.io/npm/v/nanoraster)](https://www.npmjs.com/package/nanoraster)
[![CI](https://github.com/taucad/nanoraster/actions/workflows/ci.yml/badge.svg)](https://github.com/taucad/nanoraster/actions/workflows/ci.yml)
[![Part of the Tau ecosystem](https://img.shields.io/badge/Tau-ecosystem-6d28d9)](https://tau.new)

Tiny headless WebGPU GLTF renderer for deterministic PNG, WebP, and JPEG output.

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
