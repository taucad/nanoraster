import { rm, writeFile } from 'node:fs/promises';

const output = new URL('../src/wasm/', import.meta.url);

await Promise.all([
  rm(new URL('.gitignore', output), { force: true }),
  writeFile(new URL('package.json', output), '{"type":"module"}\n'),
]);
