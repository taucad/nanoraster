// The homepage size strip quotes measured bytes, never hand-typed ones. This measures the
// artefacts the site itself ships and writes lib/sizes.json, which is checked in so a build
// makes drift show up as a diff. The wasm figures cover the same bytes that
// ../../scripts/check-wasm-size.mjs ratchets, so a ceiling bump lands here too.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const site = new URL('../', import.meta.url);
const root = new URL('../../', import.meta.url);
const target = new URL('lib/sizes.json', site);
const previous = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : {};
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

const wasm = readFileSync(new URL('public/demo/render_wasm_bg.wasm', site));
const shipped = new URL('src/wasm/render_wasm_bg.wasm', root);
if (existsSync(shipped) && !readFileSync(shipped).equals(wasm)) {
  console.warn(
    `warning: public/demo/render_wasm_bg.wasm (${wasm.byteLength} B) differs from the built ` +
      `src/wasm copy (${statSync(shipped).size} B); run \`pnpm run build\` to resync the demo copy`,
  );
}

const distribution = new URL('dist/index.mjs', root);
if (!existsSync(distribution)) {
  execFileSync('pnpm', ['--dir', '..', 'exec', 'tsdown'], { cwd: fileURLToPath(site), stdio: 'inherit' });
}
const javascript = readFileSync(distribution);

const platforms = ['darwin-arm64', 'linux-x64-gnu', 'win32-x64-msvc'];
const nativeSize = async (platform) => {
  const manifest = JSON.parse(readFileSync(new URL(`npm/${platform}/package.json`, root), 'utf8'));
  try {
    const response = await fetch(`https://registry.npmjs.org/${manifest.name}/${version}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const published = response.ok ? await response.json() : undefined;
    if (published?.dist?.unpackedSize) return [published.dist.unpackedSize, `registry ${version}`];
  } catch (error) {
    console.warn(`warning: registry lookup for ${manifest.name} failed: ${error.message}`);
  }

  const binary = new URL(`npm/${platform}/${manifest.main}`, root);
  if (existsSync(binary)) return [statSync(binary).size, 'local binary'];
  if (previous.native?.[platform]) return [previous.native[platform], 'previously committed'];
  throw new Error(`no size available for ${manifest.name}: unpublished, unbuilt, and never committed`);
};

const native = {};
for (const platform of platforms) {
  const [size, source] = await nativeSize(platform);
  native[platform] = size;
  console.log(`${platform}: ${size} B (${source})`);
}

const measured = {
  version,
  wasm: {
    raw: wasm.byteLength,
    gzip: gzipSync(wasm, { level: 9 }).byteLength,
    brotli: brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
  },
  js: { raw: javascript.byteLength, gzip: gzipSync(javascript, { level: 9 }).byteLength },
  native,
};

// Restamping on every build would make `sizes.json` churn in every diff, which is the
// opposite of what checking it in is for.
const { measuredAt = new Date().toISOString(), ...committed } = previous;
const unchanged = JSON.stringify(committed) === JSON.stringify(measured);
const sizes = {
  version,
  measuredAt: unchanged ? measuredAt : new Date().toISOString(),
  wasm: measured.wasm,
  js: measured.js,
  native: measured.native,
};

writeFileSync(target, `${JSON.stringify(sizes, null, 2)}\n`);
console.log(`wrote lib/sizes.json${unchanged ? ' (unchanged)' : ''}`);
