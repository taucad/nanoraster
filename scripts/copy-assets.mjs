import { cp, mkdir } from 'node:fs/promises';

const source = new URL('../src/wasm/', import.meta.url);
const destination = new URL('../dist/wasm/', import.meta.url);
const files = ['render_wasm.js', 'render_wasm.d.ts', 'render_wasm_bg.wasm', 'render_wasm_bg.wasm.d.ts'];
const demo = new URL('../docs-site/public/demo/', import.meta.url);
const demoFiles = ['render_wasm.js', 'render_wasm.d.ts', 'render_wasm_bg.wasm'];
// The NAPI-RS loader is generated into `src/native/` because tsdown's `clean`
// wipes `dist/` first. Its declarations are a build input and the addon binary
// belongs to the platform packages, so neither is copied.
const native = new URL('../dist/native/', import.meta.url);

await mkdir(destination, { recursive: true });
await mkdir(native, { recursive: true });
await Promise.all([
  ...files.map((file) => cp(new URL(file, source), new URL(file, destination))),
  ...demoFiles.map((file) => cp(new URL(file, source), new URL(file, demo))),
  cp(new URL('../src/native/index.js', import.meta.url), new URL('index.js', native)),
  cp(new URL('../src/cjs-error.cjs', import.meta.url), new URL('../dist/cjs-error.cjs', import.meta.url)),
  cp(new URL('../src/cjs-error.d.cts', import.meta.url), new URL('../dist/cjs-error.d.cts', import.meta.url)),
]);
