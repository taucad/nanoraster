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
const { name: rootName, version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

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

// Platform names are read off the registry rather than listed here. The published root
// manifest's `optionalDependencies` is the only record of which platform packages a released
// nanoraster ships, and `npm/` is generated during release assembly, so neither the source tree
// nor this script can name them. The rule: measure the working version when the registry serves
// it, otherwise the release tagged `latest` — a version bump that has not reached npm keeps
// quoting the last released figures instead of inventing a size for a package nobody can
// install. With no registry reachable the committed figures stand; with neither, this fails.
const registry = async (path) => {
  try {
    const response = await fetch(`https://registry.npmjs.org/${path}`, {
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok ? await response.json() : undefined;
  } catch (error) {
    console.warn(`warning: registry lookup for ${path} failed: ${error.message}`);
    return undefined;
  }
};

const published = (await registry(`${rootName}/${version}`)) ?? (await registry(`${rootName}/latest`));
const native = {};
for (const packageName of Object.keys(published?.optionalDependencies ?? {}).toSorted()) {
  const platform = packageName.slice(`${rootName}-`.length);
  const size = (await registry(`${packageName}/${published.version}`))?.dist?.unpackedSize;
  if (size) native[platform] = size;
  console.log(
    size
      ? `${platform}: ${size} B (registry ${published.version})`
      : `warning: ${packageName}@${published.version} serves no unpacked size; omitting ${platform}`,
  );
}

if (Object.keys(native).length === 0) {
  if (!previous.native) {
    throw new Error(`no native sizes available: ${rootName} is unpublished and none were ever committed`);
  }
  Object.assign(native, previous.native);
  console.log(`kept the committed native sizes for ${Object.keys(native).join(', ')}`);
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
