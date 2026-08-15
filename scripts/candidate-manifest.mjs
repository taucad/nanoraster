#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const candidateDirectory = resolve(process.argv[2] ?? 'candidate');
const packagePaths = [
  'npm/darwin-arm64/package.json',
  'npm/linux-x64-gnu/package.json',
  'npm/win32-x64-msvc/package.json',
  'package.json',
];

const tarballName = ({ name, version }) => `${name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`;

const packages = packagePaths.map((path) => {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const filename = tarballName(manifest);
  const tarball = resolve(candidateDirectory, filename);
  if (!existsSync(tarball)) throw new Error(`missing candidate tarball: ${filename}`);
  const digest = createHash('sha512').update(readFileSync(tarball)).digest('base64');
  return {
    name: manifest.name,
    version: manifest.version,
    filename,
    integrity: `sha512-${digest}`,
  };
});

const versions = new Set(packages.map(({ version }) => version));
if (versions.size !== 1) throw new Error('candidate package versions differ');

const root = packages.at(-1);
const output = { packages, version: root.version };
writeFileSync(resolve(candidateDirectory, 'manifest.json'), `${JSON.stringify(output, null, 2)}\n`);

if (process.env['GITHUB_OUTPUT']) {
  appendFileSync(
    process.env['GITHUB_OUTPUT'],
    `filename=${root.filename}\nintegrity=${root.integrity}\nversion=${root.version}\n`,
  );
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
