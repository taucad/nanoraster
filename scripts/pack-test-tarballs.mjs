#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { readNapiTargets } from './lib/napi-targets.mjs';

const MANIFEST = 'test-tarballs.json';

/** Pack one package directory into `destination` and report what npm wrote. */
export const npmPack = (directory, destination) => {
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
      cwd: directory,
      encoding: 'utf8',
    }),
  );
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error(`npm pack must describe exactly one tarball in ${directory}`);
  }
  const { filename, integrity, name, version } = packed[0];
  return { filename, integrity, name, version };
};

/**
 * Pack the root package and every generated platform package into one
 * directory and record the integrity npm computed for each. Runtime jobs
 * install these exact tarballs, and `registry-verify` later proves the registry
 * serves the same bytes, so the manifest also travels inside the frozen tree.
 */
export const packTestTarballs = ({ npmDir = 'npm', out, pack = npmPack, root }) => {
  const rootDirectory = resolve(root);
  const outDirectory = resolve(out);
  const { manifest, packages } = readNapiTargets(join(rootDirectory, 'package.json'));
  mkdirSync(outDirectory, { recursive: true });

  const sources = [
    { directory: rootDirectory, name: manifest.name },
    ...packages.map((target) => ({
      directory: join(rootDirectory, npmDir, target.suffix),
      name: target.name,
    })),
  ];

  const packed = sources.map(({ directory, name }) => {
    const entry = pack(directory, outDirectory);
    if (entry.name !== name) {
      throw new Error(`${directory} packed ${entry.name}, expected ${name}`);
    }
    if (entry.version !== manifest.version) {
      throw new Error(`${entry.name} packed version ${entry.version}, expected ${manifest.version}`);
    }
    return entry;
  });

  const output = {
    packages: Object.fromEntries(
      packed
        .sort((left, right) => (left.name < right.name ? -1 : 1))
        .map(({ filename, integrity, name, version }) => [name, { filename, integrity, version }]),
    ),
    version: manifest.version,
  };

  const json = `${JSON.stringify(output, null, 2)}\n`;
  writeFileSync(join(outDirectory, MANIFEST), json);
  writeFileSync(join(rootDirectory, MANIFEST), json);
  return output;
};

const extractTarball = (tarball, destination) => {
  execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', destination]);
};

/**
 * Expand a frozen tarball set into publish-shaped package directories.
 *
 * pkg.pr.new cannot rewrite versions or sibling dependencies in prebuilt
 * tarballs. Expanding the already-tested tarballs lets it repack the same file
 * payload while rewriting the complete package graph in one invocation.
 */
export const extractPreviewPackages = ({ extract = extractTarball, from, out }) => {
  const sourceDirectory = resolve(from);
  const outDirectory = resolve(out);
  const manifest = JSON.parse(readFileSync(join(sourceDirectory, MANIFEST), 'utf8'));
  const entries = Array.isArray(manifest.packages)
    ? manifest.packages
    : Object.entries(manifest.packages ?? {}).map(([name, entry]) => ({ name, ...entry }));
  if (entries.length === 0) throw new Error(`${MANIFEST} names no packages`);
  if (existsSync(outDirectory) && readdirSync(outDirectory).length > 0) {
    throw new Error(`${outDirectory} must be empty`);
  }
  mkdirSync(outDirectory, { recursive: true });

  const names = new Set();
  return entries.map(({ filename, name, version }, index) => {
    if (typeof name !== 'string' || name.length === 0 || names.has(name)) {
      throw new Error(`invalid or duplicate package name: ${name}`);
    }
    names.add(name);
    if (typeof filename !== 'string' || basename(filename) !== filename || !filename.endsWith('.tgz')) {
      throw new Error(`unsafe tarball filename for ${name}: ${filename}`);
    }
    const tarball = join(sourceDirectory, filename);
    if (!existsSync(tarball)) throw new Error(`missing tarball for ${name}: ${filename}`);

    const destination = join(outDirectory, String(index).padStart(2, '0'));
    mkdirSync(destination);
    extract(tarball, destination);
    const extracted = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
    if (extracted.name !== name || extracted.version !== version) {
      throw new Error(
        `${filename} extracted ${extracted.name}@${extracted.version}, expected ${name}@${version}`,
      );
    }
    return destination;
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'npm-dir': { default: 'npm', type: 'string' },
      'extract-from': { type: 'string' },
      out: { type: 'string' },
      root: { default: '.', type: 'string' },
    },
  });
  try {
    if (!values.out) throw new Error('expected --out <directory>');
    if (values['extract-from']) {
      const directories = extractPreviewPackages({ from: values['extract-from'], out: values.out });
      process.stdout.write(`${directories.join('\n')}\n`);
      process.exit(0);
    }
    const output = packTestTarballs({
      npmDir: values['npm-dir'],
      out: values.out,
      root: values.root,
    });
    process.stdout.write(`packed ${Object.keys(output.packages).length} tarballs at ${output.version}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
