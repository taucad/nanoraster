#!/usr/bin/env node

/**
 * Clean-room runtime evidence for one platform package.
 *
 * Tarball mode (`NANORASTER_TARBALL_DIR`) installs the frozen root tarball plus
 * the frozen `nanoraster-<suffix>` tarball; registry mode
 * (`NANORASTER_REGISTRY_VERSION`) installs the published root the way a
 * consumer does and proves npm selected that one platform package. The caller
 * always names the suffix in `NANORASTER_NATIVE_SUFFIX`: this script holds no
 * host-to-target map, because the generated loader owns selection.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

const ROOT_PACKAGE = 'nanoraster';
const SUFFIX_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const INSTALL_FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'];

/**
 * Read the platform suffix the caller named, for example the `<suffix>` in
 * `nanoraster-<suffix>`.
 *
 * @param {Record<string, string | undefined>} environment - Process environment.
 * @returns {string} The validated suffix.
 */
export const requireNativeSuffix = (environment) => {
  const suffix = environment['NANORASTER_NATIVE_SUFFIX'];
  if (typeof suffix !== 'string' || suffix.length === 0) {
    throw new Error('NANORASTER_NATIVE_SUFFIX must name the suffix of the platform package to smoke');
  }
  if (!SUFFIX_PATTERN.test(suffix)) {
    throw new Error(`NANORASTER_NATIVE_SUFFIX is not a platform suffix: ${suffix}`);
  }
  return suffix;
};

/**
 * Decide which package source this run installs from.
 *
 * @param {Record<string, string | undefined>} environment - Process environment.
 * @returns {{ kind: 'tarball', directory: string } | { kind: 'registry', version: string }} The mode.
 */
export const resolveSmokeMode = (environment) => {
  const directory = environment['NANORASTER_TARBALL_DIR'];
  const version = environment['NANORASTER_REGISTRY_VERSION'];
  const named = [directory, version].filter((value) => typeof value === 'string' && value.length > 0);
  if (named.length !== 1) {
    throw new Error(
      'set exactly one of NANORASTER_TARBALL_DIR (frozen tarballs) or NANORASTER_REGISTRY_VERSION (published release)',
    );
  }
  return directory !== undefined && directory.length > 0
    ? { kind: 'tarball', directory }
    : { kind: 'registry', version: /** @type {string} */ (version) };
};

/**
 * Look up the frozen root and platform tarballs recorded for one suffix.
 *
 * @param {{ version?: unknown, packages?: unknown }} manifest - Parsed `test-tarballs.json`.
 * @param {string} suffix - Platform suffix the caller named.
 * @returns {{ platformName: string, platformTarball: string, rootTarball: string, version: string }} Selection.
 */
export const selectTarballs = (manifest, suffix) => {
  const { packages, version } = manifest;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('the frozen tarball manifest records no version');
  }
  if (typeof packages !== 'object' || packages === null) {
    throw new Error('the frozen tarball manifest records no packages');
  }
  const filenameOf = (name) => {
    const entry = /** @type {Record<string, { filename?: unknown, version?: unknown }>} */ (packages)[name];
    if (entry === undefined) {
      throw new Error(`the frozen tarball manifest has no tarball for ${name}`);
    }
    if (typeof entry.filename !== 'string' || entry.filename.length === 0) {
      throw new Error(`${name} records no tarball filename`);
    }
    if (entry.version !== version) {
      throw new Error(`${name} is packed at ${String(entry.version)}, expected ${version}`);
    }
    return entry.filename;
  };
  const platformName = `${ROOT_PACKAGE}-${suffix}`;
  return {
    platformName,
    platformTarball: filenameOf(platformName),
    rootTarball: filenameOf(ROOT_PACKAGE),
    version,
  };
};

/**
 * Pick the configured platform packages out of an installed dependency listing.
 *
 * Only names the release itself configures count: a dependency that merely
 * shares the root prefix, such as an adjacent `nanoraster-*` tool, is not a
 * platform package and must not make the smoke report two of them. The clean
 * room resolves no repository dependency, so the configured set comes from the
 * frozen tarball manifest (tarball mode) or the installed root's optional
 * dependencies (registry mode) rather than from a triple parser.
 *
 * @param {string[]} entries - Directory entry names of a `node_modules` directory.
 * @param {Iterable<string>} configuredNames - Every package name the release configures.
 * @returns {string[]} Sorted platform package names.
 */
export const detectPlatformPackages = (entries, configuredNames) => {
  const platforms = new Set(
    [...configuredNames].filter((name) => name.startsWith(`${ROOT_PACKAGE}-`) && SUFFIX_PATTERN.test(name)),
  );
  return entries.filter((entry) => platforms.has(entry)).sort();
};

/**
 * Render a thrown value and every `cause` beneath it as message and stack.
 *
 * @param {unknown} error - The thrown value.
 * @returns {string} One report line group per link in the chain.
 */
export const formatCauseChain = (error) => {
  const lines = [];
  const seen = new Set();
  let current = error;
  let depth = 0;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const label = depth === 0 ? 'error' : `cause ${depth}`;
    if (current instanceof Error) {
      lines.push(`${label}: ${current.message}`);
      if (typeof current.stack === 'string') lines.push(current.stack);
      current = current.cause;
    } else {
      lines.push(`${label}: ${typeof current === 'string' ? current : inspect(current)}`);
      current = undefined;
    }
    depth += 1;
  }
  return lines.join('\n');
};

// npm is a `.cmd` shim on Windows, which `execFileSync` can only start through
// a shell; quoting is ours to do once the shell parses the command line.
const windows = process.platform === 'win32';
const quoteForShell = (value) => (windows && /[\s&|<>^"]/u.test(value) ? `"${value}"` : value);
const runNpm = (arguments_, cwd) =>
  execFileSync(windows ? 'npm.cmd' : 'npm', arguments_.map(quoteForShell), {
    cwd,
    shell: windows,
    stdio: 'inherit',
  });

const installedPlatformPackages = (work, configuredNames) =>
  detectPlatformPackages(
    [
      ...readdirSync(join(work, 'node_modules')),
      ...(existsSync(join(work, 'node_modules', ROOT_PACKAGE, 'node_modules'))
        ? readdirSync(join(work, 'node_modules', ROOT_PACKAGE, 'node_modules'))
        : []),
    ],
    configuredNames,
  );

const consumerSource = (helperUrl) => `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { formatCauseChain } from ${JSON.stringify(helperUrl)};

let api;
try {
  api = await import('nanoraster');
  // The published wasm asset is packed beside the native loader; a consumer
  // bundling for browsers resolves exactly these bytes.
  await WebAssembly.compile(await readFile(new URL(import.meta.resolve('nanoraster/wasm'))));
  const glb = await readFile(process.argv[2]);
  const image = await api.renderImage(new Uint8Array(glb), { format: 'png', width: 64, height: 64 });
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.name, 'render.png');
  assert.deepEqual([...image.bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
} catch (error) {
  if (api !== undefined) {
    try {
      console.error('adapter:', await api.describeAdapter());
    } catch (adapterError) {
      console.error(\`adapter unavailable:\\n\${formatCauseChain(adapterError)}\`);
    }
  }
  console.error(formatCauseChain(error));
  process.exit(1);
}
`;

const cjsProbeSource = `'use strict';
const assert = require('node:assert/strict');
assert.throws(() => require('nanoraster'), /nanoraster is ESM-only; use import\\("nanoraster"\\) from CommonJS\\./u);
`;

const main = () => {
  const suffix = requireNativeSuffix(process.env);
  const mode = resolveSmokeMode(process.env);
  const platformName = `${ROOT_PACKAGE}-${suffix}`;
  const fixture = fileURLToPath(new URL('../tests/fixtures/gear-12.glb', import.meta.url));
  const work = mkdtempSync(join(tmpdir(), 'nanoraster-package-'));

  try {
    writeFileSync(join(work, 'package.json'), '{"private":true,"type":"module"}\n');
    let version;
    let configuredNames;
    if (mode.kind === 'tarball') {
      const frozen = JSON.parse(readFileSync(resolve(mode.directory, 'test-tarballs.json'), 'utf8'));
      const selection = selectTarballs(frozen, suffix);
      version = selection.version;
      configuredNames = Object.keys(frozen.packages);
      const tarballs = [selection.rootTarball, selection.platformTarball].map((filename) =>
        resolve(mode.directory, filename),
      );
      for (const tarball of tarballs) {
        if (!existsSync(tarball)) throw new Error(`frozen tarball missing: ${tarball}`);
      }
      // The frozen tarballs are the only bytes under test, so the root's
      // optional dependencies must not pull sibling platforms off the registry.
      runNpm(['install', ...INSTALL_FLAGS, '--omit=optional', ...tarballs], work);
    } else {
      version = mode.version;
      runNpm(['install', ...INSTALL_FLAGS, `${ROOT_PACKAGE}@${version}`], work);
    }

    const installedManifest = JSON.parse(
      readFileSync(join(work, 'node_modules', ROOT_PACKAGE, 'package.json'), 'utf8'),
    );
    // A published root names its platform packages in `optionalDependencies`;
    // that is the registry's own record of the configured set.
    configuredNames ??= Object.keys(installedManifest.optionalDependencies ?? {});

    const installed = installedPlatformPackages(work, configuredNames);
    if (installed.length !== 1 || installed[0] !== platformName) {
      throw new Error(
        `expected exactly one platform package, ${platformName}, but installed: ${installed.join(', ') || 'none'}`,
      );
    }
    console.log(`installed platform package: ${installed[0]}`);

    writeFileSync(join(work, 'consumer.mjs'), consumerSource(import.meta.url));
    execFileSync(process.execPath, ['consumer.mjs', fixture], {
      cwd: work,
      // The loader's version check is a runtime opt-in; a published release is
      // where a drifted platform package could actually reach a consumer.
      env: { ...process.env, ...(mode.kind === 'registry' ? { NAPI_RS_ENFORCE_VERSION_CHECK: '1' } : {}) },
      stdio: 'inherit',
    });

    writeFileSync(join(work, 'consumer.cjs'), cjsProbeSource);
    execFileSync(process.execPath, ['consumer.cjs'], { cwd: work, stdio: 'inherit' });

    if (installedManifest.version !== version) {
      throw new Error(`installed ${ROOT_PACKAGE}@${installedManifest.version}, expected ${version}`);
    }
    console.log(
      `clean-room ${mode.kind} smoke passed: ${ROOT_PACKAGE}@${version} through ${platformName} on ${process.platform}-${process.arch}`,
    );
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(formatCauseChain(error));
    process.exit(1);
  }
}
