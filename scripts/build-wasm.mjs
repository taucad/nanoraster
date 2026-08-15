#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

execFileSync(
  'wasm-pack',
  ['build', 'rust/render-wasm', '--release', '--target', 'web', '--out-dir', '../../src/wasm'],
  {
    cwd: root,
    env: {
      ...process.env,
      RUSTFLAGS: [process.env.RUSTFLAGS, `--remap-path-prefix=${root}=.`].filter(Boolean).join(' '),
    },
    stdio: 'inherit',
  },
);

const wasm = readFileSync(new URL('../src/wasm/render_wasm_bg.wasm', import.meta.url));
if (wasm.includes(Buffer.from(root))) throw new Error('render WASM embeds the checkout path');
