#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readNapiTargets } from './lib/napi-targets.mjs';
import { validatePackageFiles } from './package-files.mjs';

const LOADER = 'dist/native/index.js';
const LOADER_DECLARATIONS = 'dist/native/index.d.ts';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const platformFindings = ({ directory, npmDir, rootManifest, target }) => {
  const findings = [];
  const relative = `${npmDir}/${target.suffix}`;
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) {
    return [`${target.suffix}: ${relative}/package.json is missing`];
  }

  const note = (message) => findings.push(`${target.suffix}: ${message}`);
  const manifest = readJson(manifestPath);
  const rootVersion = rootManifest.version;
  if (manifest.name !== target.name) {
    note(`expected name ${target.name}, found ${manifest.name}`);
  }
  if (manifest.version !== rootVersion) {
    note(`expected version ${rootVersion}, found ${manifest.version}`);
  }
  if (!same(manifest.os, [target.os])) {
    note(`expected os ${JSON.stringify([target.os])}, found ${JSON.stringify(manifest.os)}`);
  }
  if (!same(manifest.cpu, [target.cpu])) {
    note(`expected cpu ${JSON.stringify([target.cpu])}, found ${JSON.stringify(manifest.cpu)}`);
  }
  if (target.libc && !same(manifest.libc, [target.libc])) {
    note(`expected libc ${JSON.stringify([target.libc])}, found ${JSON.stringify(manifest.libc)}`);
  }
  if (!target.libc && manifest.libc !== undefined) {
    note(`expected no libc selector, found ${JSON.stringify(manifest.libc)}`);
  }
  if (!same(manifest.engines, rootManifest.engines)) {
    note(
      `expected engines ${JSON.stringify(rootManifest.engines)}, found ${JSON.stringify(manifest.engines)}`,
    );
  }
  if (manifest.main !== target.binary) {
    note(`expected main ${target.binary}, found ${manifest.main}`);
  }
  if (!same(manifest.files, [target.binary])) {
    note(`expected files ${JSON.stringify([target.binary])}, found ${JSON.stringify(manifest.files)}`);
  }
  if (manifest.license !== rootManifest.license) {
    note(`expected license ${rootManifest.license}, found ${manifest.license}`);
  }

  const entries = readdirSync(directory);
  if (!entries.includes(target.binary)) {
    note(`${relative}/${target.binary} is missing`);
  }
  for (const entry of entries.filter((name) => name.endsWith('.node') && name !== target.binary)) {
    note(`${relative}/${entry} is not the ${target.suffix} binary`);
  }
  if (!entries.includes('license')) {
    note(`${relative}/license is missing`);
  }
  return findings;
};

const optionalDependencyFindings = (packages, declared, rootVersion) => {
  const findings = [];
  const expected = new Map(packages.map((target) => [target.name, rootVersion]));
  for (const [name] of expected) {
    if (!(name in declared)) {
      findings.push(`root optionalDependencies: ${String(name)} is missing`);
    }
  }
  for (const name of Object.keys(declared)) {
    if (!expected.has(name)) {
      findings.push(`root optionalDependencies: ${name} is not a configured target package`);
    }
  }
  for (const [name, version] of Object.entries(declared)) {
    if (expected.has(name) && version !== rootVersion) {
      findings.push(`root optionalDependencies: expected ${name}@${rootVersion}, found ${String(version)}`);
    }
  }
  return findings;
};

const rootPackFindings = (packedFiles) => {
  const findings = packedFiles
    .filter((file) => file.endsWith('.node'))
    .map((file) => `root pack: ${file} is a native binary`);
  try {
    validatePackageFiles(packedFiles);
  } catch (error) {
    findings.push(`root pack: ${error instanceof Error ? error.message : String(error)}`);
  }
  return findings;
};

/**
 * Assert that an assembled release tree is complete: sixteen generated platform
 * packages that match `package.json.napi.targets`, a root manifest whose
 * optional dependencies were materialized for exactly those packages, the
 * generated loader shipped without its declarations, and a root tarball that
 * still matches the file contract and carries no addon.
 */
export const preparedReleaseFindings = ({ npmDir = 'npm', packedFiles, root }) => {
  const rootDirectory = resolve(root);
  const { manifest, packages } = readNapiTargets(join(rootDirectory, 'package.json'));
  const npmDirectory = join(rootDirectory, npmDir);
  const findings = [];

  const configured = new Set(packages.map((target) => target.suffix));
  const present = existsSync(npmDirectory) ? readdirSync(npmDirectory).sort() : [];
  for (const entry of present.filter((name) => !configured.has(name))) {
    findings.push(`${npmDir}/${entry} is not a configured target package`);
  }

  for (const target of [...packages].sort((a, b) => (a.suffix < b.suffix ? -1 : 1))) {
    findings.push(
      ...platformFindings({
        directory: join(npmDirectory, target.suffix),
        npmDir,
        rootManifest: manifest,
        target,
      }),
    );
  }

  findings.push(
    ...optionalDependencyFindings(packages, manifest.optionalDependencies ?? {}, manifest.version),
  );

  if (!existsSync(join(rootDirectory, LOADER))) {
    findings.push(`${LOADER} is missing`);
  }
  if (existsSync(join(rootDirectory, LOADER_DECLARATIONS))) {
    findings.push(`${LOADER_DECLARATIONS} is a build input and must not ship`);
  }

  findings.push(...rootPackFindings(packedFiles));
  return findings;
};

const packRoot = (rootDirectory) => {
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: rootDirectory,
      encoding: 'utf8',
    }),
  );
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error('npm pack must describe exactly one root tarball');
  }
  return packed[0].files.map(({ path }) => path.replaceAll('\\', '/'));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'npm-dir': { default: 'npm', type: 'string' },
      root: { default: '.', type: 'string' },
    },
  });
  try {
    const root = resolve(values.root);
    const findings = preparedReleaseFindings({
      npmDir: values['npm-dir'],
      packedFiles: packRoot(root),
      root,
    });
    for (const finding of findings) {
      process.stderr.write(`::error::${finding}\n`);
    }
    if (findings.length > 0) {
      process.stderr.write(`${findings.length} prepared release findings\n`);
      process.exit(1);
    }
    process.stdout.write('prepared release tree is complete\n');
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
