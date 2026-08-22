import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePackageFiles } from './package-files.mjs';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const candidateDirectory = process.env.NANORASTER_CANDIDATE_DIR;
const platformDirectory = {
  'darwin-arm64': 'darwin-arm64',
  'linux-x64': 'linux-x64-gnu',
  'win32-x64': 'win32-x64-msvc',
}[`${process.platform}-${process.arch}`];
if (platformDirectory === undefined)
  throw new Error(`unsupported package smoke host: ${process.platform}-${process.arch}`);

const work = mkdtempSync(join(tmpdir(), 'nanoraster-package-'));
const pack = (cwd) => {
  const result = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], {
      cwd,
      encoding: 'utf8',
    }),
  );
  if (!Array.isArray(result) || result.length !== 1)
    throw new Error(`npm pack returned ${result.length} candidates`);
  return result[0];
};

try {
  const rootCandidate = candidateDirectory ? undefined : pack(root);
  if (rootCandidate) validatePackageFiles(rootCandidate.files.map(({ path }) => path));
  const platformCandidate = candidateDirectory
    ? undefined
    : pack(new URL(`../npm/${platformDirectory}/`, import.meta.url));
  const rootTarball = candidateDirectory
    ? resolve(candidateDirectory, `nanoraster-${manifest.version}.tgz`)
    : join(work, rootCandidate.filename);
  const platformTarball = candidateDirectory
    ? resolve(candidateDirectory, `nanoraster-${platformDirectory}-${manifest.version}.tgz`)
    : join(work, platformCandidate.filename);
  if (!existsSync(rootTarball) || !existsSync(platformTarball)) {
    throw new Error(`candidate tarballs missing for ${process.platform}-${process.arch}`);
  }

  writeFileSync(join(work, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      rootTarball,
      platformTarball,
    ],
    { cwd: work, stdio: 'inherit' },
  );

  const fixture = resolve(fileURLToPath(new URL('../tests/fixtures/gear-12.glb', import.meta.url)));
  writeFileSync(
    join(work, 'consumer.mjs'),
    `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderImage } from 'nanoraster';

const wasm = await readFile(new URL(import.meta.resolve('nanoraster/wasm')));
await WebAssembly.compile(wasm);
const glb = await readFile(process.argv[2]);
const image = await renderImage(new Uint8Array(glb), { format: 'png', width: 64, height: 64 });
assert.equal(image.mimeType, 'image/png');
assert.deepEqual([...image.bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
`,
  );
  execFileSync(process.execPath, ['consumer.mjs', fixture], { cwd: work, stdio: 'inherit' });

  writeFileSync(
    join(work, 'consumer.cjs'),
    `'use strict';
const assert = require('node:assert/strict');
assert.throws(() => require('nanoraster'), /nanoraster is ESM-only; use import\\("nanoraster"\\) from CommonJS\\./u);
`,
  );
  execFileSync(process.execPath, ['consumer.cjs'], { cwd: work, stdio: 'inherit' });

  const installedManifest = JSON.parse(
    readFileSync(join(work, 'node_modules/nanoraster/package.json'), 'utf8'),
  );
  if (installedManifest.version !== manifest.version) throw new Error('installed package version mismatch');
  console.log(`clean-room package smoke passed for ${process.platform}-${process.arch}`);
} finally {
  rmSync(work, { force: true, recursive: true });
}
