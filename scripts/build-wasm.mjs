#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const wasmOpt = fileURLToPath(import.meta.resolve('binaryen/bin/wasm-opt'));
// `--bench` builds the feature-enabled sibling the conformance gate runs on,
// into a scratch directory. The shipped artifact never carries that feature.
const bench = process.argv.includes('--bench');
const output = bench ? 'tests/out/wasm-bench' : 'src/wasm';
const wasmPath = resolve(root, output, 'render_wasm_bg.wasm');
const optimizedPath = `${wasmPath}.optimized`;

execFileSync(
  'wasm-pack',
  [
    'build',
    'rust/render-wasm',
    '--release',
    '--target',
    'web',
    '--out-dir',
    `../../${output}`,
    '--no-opt',
    '--',
    // Keep native and codec dependencies at O3. Browser render-core is setup
    // around WebGPU and O3 dependencies; size-optimising only that package
    // keeps optional presentation control flow inside the WASM ratchet.
    '--config',
    'profile.release.package.render-core.opt-level="z"',
    ...(bench ? ['--features', 'bench'] : []),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      RUSTFLAGS: [process.env.RUSTFLAGS, `--remap-path-prefix=${root}=.`].filter(Boolean).join(' '),
    },
    stdio: 'inherit',
  },
);

// wasm-pack 0.15 still bundles Binaryen 117. Run the exact-pinned modern
// Binaryen package instead so local and CI artifacts use the same optimizer.
// Rust emits the three post-MVP features below. Fixed SIMD measured neutral
// for the codecs, while relaxed SIMD would give up the Safari compatibility
// row, so neither belongs in the stable profile.
execFileSync(
  process.execPath,
  [
    wasmOpt,
    wasmPath,
    '-Oz',
    '--enable-bulk-memory',
    '--enable-sign-ext',
    '--enable-nontrapping-float-to-int',
    '-o',
    optimizedPath,
  ],
  { cwd: root, stdio: 'inherit' },
);
copyFileSync(optimizedPath, wasmPath);
rmSync(optimizedPath);

const wasm = readFileSync(wasmPath);
if (wasm.includes(Buffer.from(root))) throw new Error('render WASM embeds the checkout path');
