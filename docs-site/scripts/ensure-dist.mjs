// The site consumes nanoraster through its package exports, so `source.config.ts`, the pages
// and the tests all resolve to ../dist rather than ../src. A clean checkout has no dist yet, and
// fumadocs-mdx then fails with ERR_MODULE_NOT_FOUND on dist/index.node.mjs. tsdown alone emits
// every JavaScript entry and declaration in a few seconds; the native addon and wasm are not
// needed to load the facade, so the full `pnpm run build` stays the caller's choice.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const site = new URL('../', import.meta.url);
const root = new URL('../../', import.meta.url);
const entries = ['dist/index.mjs', 'dist/index.node.mjs', 'dist/index.d.mts', 'dist/options.mjs'];

if (entries.some((entry) => !existsSync(new URL(entry, root)))) {
  execFileSync('pnpm', ['--dir', '..', 'exec', 'tsdown'], { cwd: fileURLToPath(site), stdio: 'inherit' });
}
