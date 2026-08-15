import path from 'node:path';

// Initial 0.1.0 package contract measured on 2026-08-15; changes require explicit admission.
const PACKAGE_FILE_COUNT_CEILING = 25;

export const PACKAGE_FILES = [
  'BREAKING_CHANGES.md',
  'CHANGELOG.md',
  'NOTICE',
  'README.md',
  'dist/cjs-error.cjs',
  'dist/cjs-error.d.cts',
  'dist/image-file.d.mts',
  'dist/image-file.mjs',
  'dist/index.d.mts',
  'dist/index.mjs',
  'dist/options.d.mts',
  'dist/options.mjs',
  'dist/render-error.d.mts',
  'dist/render-error.mjs',
  'dist/render-glb-to-image.d.mts',
  'dist/render-glb-to-image.mjs',
  'dist/render-glb-to-images.d.mts',
  'dist/render-glb-to-images.mjs',
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
  const forbidden = normalized.filter(
    (file) => file.endsWith('.rs') || file.endsWith('.d.ts.map') || file.includes('/target/'),
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
