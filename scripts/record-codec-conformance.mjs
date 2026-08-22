#!/usr/bin/env node
//
// Record the codec fingerprint table both the Rust and the browser suites
// assert against. `codecConformance` lives behind the default-off `bench`
// cargo feature, so this reads the sibling addon `pnpm run build:napi:bench`
// produces.
//
// Run it only when a codec change is intended — the table is the gate.

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const native = createRequire(import.meta.url)('../tests/out/native-bench/nanoraster.node');
const path = new URL('../tests/codec-conformance.json', import.meta.url);

writeFileSync(path, `${JSON.stringify(JSON.parse(native.codecConformance()), undefined, 2)}\n`);
process.stdout.write(`wrote ${path.pathname}\n`);
