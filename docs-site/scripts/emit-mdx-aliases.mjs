// Static export cannot emit `out/docs/tutorial.mdx` directly: `app/docs/[[...slug]]` already owns
// that segment. The generator writes to `out/llms.mdx/<rel>`; this moves each file to the URL the
// site actually advertises, so no host rewrite is needed.
import { existsSync, globSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const out = resolve(import.meta.dirname, '..', 'out');
const generated = join(out, 'llms.mdx');

const relatives = globSync('**/*', { cwd: generated }).filter((relative) =>
  statSync(join(generated, relative)).isFile(),
);
if (relatives.length === 0) throw new Error(`no Markdown projections found in ${generated}`);

for (const relative of relatives) {
  const target = join(out, 'docs', `${relative}.mdx`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(join(generated, relative), target);
}
rmSync(generated, { recursive: true });

const index = join(out, 'docs.mdx');
if (!existsSync(index)) throw new Error(`missing index projection: ${index}`);

console.log(`aliased ${relatives.length} Markdown projections into out/docs/*.mdx`);
