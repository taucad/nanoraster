import { rm, writeFile } from 'node:fs/promises';

// `--bench` cleans the feature-enabled sibling build instead of the shipped one.
const output = process.argv.includes('--bench') ? '../tests/out/wasm-bench/' : '../src/wasm/';
const directory = new URL(output, import.meta.url);

await Promise.all([
  rm(new URL('.gitignore', directory), { force: true }),
  writeFile(new URL('package.json', directory), '{"type":"module"}\n'),
]);
