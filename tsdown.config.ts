import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = {
  clean: true,
  deps: { neverBundle: [/^\.\/wasm\//u] },
  dts: true,
  entry: ['src/index.ts'],
  format: 'esm',
  minify: true,
  outDir: 'dist',
  sourcemap: false,
  tsconfig: 'tsconfig.build.json',
  unbundle: true,
};

export default defineConfig(config);
