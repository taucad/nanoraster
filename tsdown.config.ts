import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = {
  clean: true,
  deps: { neverBundle: [/^\.\/native\//u, /^\.\/wasm\//u] },
  dts: true,
  entry: ['src/index.node.ts', 'src/index.ts'],
  format: 'esm',
  minify: true,
  outDir: 'dist',
  sourcemap: false,
  tsconfig: 'tsconfig.build.json',
  unbundle: true,
};

export default defineConfig(config);
