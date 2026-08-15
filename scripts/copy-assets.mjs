import { cp, mkdir } from 'node:fs/promises';

const source = new URL('../src/wasm/', import.meta.url);
const destination = new URL('../dist/wasm/', import.meta.url);
const files = ['render_wasm.js', 'render_wasm.d.ts', 'render_wasm_bg.wasm', 'render_wasm_bg.wasm.d.ts'];

await mkdir(destination, { recursive: true });
await Promise.all([
  ...files.map((file) => cp(new URL(file, source), new URL(file, destination))),
  cp(new URL('../src/cjs-error.cjs', import.meta.url), new URL('../dist/cjs-error.cjs', import.meta.url)),
  cp(new URL('../src/cjs-error.d.cts', import.meta.url), new URL('../dist/cjs-error.d.cts', import.meta.url)),
]);
