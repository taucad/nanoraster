import path from 'node:path';

// Initial 0.1.0 package contract measured on 2026-08-15; changes require
// explicit admission. 2026-08-20: +6 for the handles-first surface
// (create-renderer, raw-pixels, describe-adapter modules). 2026-08-22: -2 as
// `format: 'raw'` folded the raw-pixels module into the image paths.
// 2026-08-22: +4 for the Node entry point behind the `node` export condition
// (index.node.mjs, its declarations, native-backend.mjs) and the generated
// NAPI-RS loader it imports (native/index.js).
const PACKAGE_FILE_COUNT_CEILING = 34;

export const PACKAGE_FILES = [
  'BREAKING_CHANGES.md',
  'CHANGELOG.md',
  'NOTICE',
  'README.md',
  'compatibility.md',
  'dist/cjs-error.cjs',
  'dist/cjs-error.d.cts',
  'dist/create-renderer.d.mts',
  'dist/create-renderer.mjs',
  'dist/describe-adapter.d.mts',
  'dist/describe-adapter.mjs',
  'dist/image-file.d.mts',
  'dist/image-file.mjs',
  'dist/index.d.mts',
  'dist/index.mjs',
  'dist/index.node.d.mts',
  'dist/index.node.mjs',
  'dist/native-backend.mjs',
  'dist/native/index.js',
  'dist/options.d.mts',
  'dist/options.mjs',
  'dist/render-error.d.mts',
  'dist/render-error.mjs',
  'dist/render-image.d.mts',
  'dist/render-image.mjs',
  'dist/render-images.d.mts',
  'dist/render-images.mjs',
  'dist/renderer.mjs',
  'dist/wasm/render_wasm.d.ts',
  'dist/wasm/render_wasm.js',
  'dist/wasm/render_wasm_bg.wasm',
  'dist/wasm/render_wasm_bg.wasm.d.ts',
  'license',
  'package.json',
].sort();

export const validatePackageFiles = (files) => {
  const normalized = files.map((file) => file.replaceAll(path.sep, '/')).sort();
  const missing = PACKAGE_FILES.filter((file) => !normalized.includes(file));
  const extra = normalized.filter((file) => !PACKAGE_FILES.includes(file));
  // `napi artifacts` copies every addon into the package root as well as into
  // its platform directory, and the generated loader declarations are a build
  // input: neither may ever reach the root tarball.
  const forbidden = normalized.filter(
    (file) =>
      file.endsWith('.rs') ||
      file.endsWith('.node') ||
      file.endsWith('.d.ts.map') ||
      file === 'dist/native/index.d.ts' ||
      file.includes('/target/'),
  );

  if (
    normalized.length > PACKAGE_FILE_COUNT_CEILING ||
    missing.length > 0 ||
    extra.length > 0 ||
    forbidden.length > 0
  ) {
    throw new Error(
      `npm package mismatch; count=${normalized.length}/${PACKAGE_FILE_COUNT_CEILING} ` +
        `missing=[${missing.join(', ')}] extra=[${extra.join(', ')}] forbidden=[${forbidden.join(', ')}]`,
    );
  }

  return normalized;
};
