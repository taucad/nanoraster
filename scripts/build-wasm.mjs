#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// `--bench` builds the feature-enabled sibling the conformance gate runs on,
// into a scratch directory. The shipped artifact never carries that feature.
const bench = process.argv.includes('--bench');
const output = bench ? 'tests/out/wasm-bench' : 'src/wasm';

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
    ...(bench ? ['--', '--features', 'bench'] : []),
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

const wasm = readFileSync(new URL(`../${output}/render_wasm_bg.wasm`, import.meta.url));
if (wasm.includes(Buffer.from(root))) throw new Error('render WASM embeds the checkout path');
