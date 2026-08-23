#!/usr/bin/env node

/**
 * Clean-room runtime evidence for one platform package.
 *
 * Tarball mode (`NANORASTER_TARBALL_DIR`) installs the frozen root tarball plus
 * the frozen `nanoraster-<suffix>` tarball; registry mode
 * (`NANORASTER_REGISTRY_VERSION`) installs the published root the way a
 * consumer does, proves npm's selectors kept only the packages they can keep,
 * and proves the loader opened the named one. The caller always names the
 * suffix in `NANORASTER_NATIVE_SUFFIX`: this script holds no host-to-target
 * map, because the generated loader owns selection.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { readNapiTargets } from './lib/napi-targets.mjs';

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
 * Read `test-tarballs.json` out of the directory `NANORASTER_TARBALL_DIR` named.
 *
 * A silently empty artifact download leaves the directory absent or bare, and
 * reading straight through it reports an ENOENT against a path the operator
 * still has to trace back to the download. Name the directory instead, and say
 * what it actually holds.
 *
 * @param {string} directory - Directory the caller named.
 * @returns {Record<string, unknown>} Parsed manifest.
 */
export const readFrozenManifest = (directory) => {
  const resolved = resolve(directory);
  if (!existsSync(resolved)) throw new Error(`no tarball directory: ${resolved}`);
  const landed = readdirSync(resolved);
  if (landed.length === 0) throw new Error(`the tarball directory ${resolved} is empty`);
  const manifest = join(resolved, 'test-tarballs.json');
  if (!existsSync(manifest)) {
    throw new Error(`no test-tarballs.json in ${resolved}, which holds: ${landed.join(', ')}`);
  }
  return JSON.parse(readFileSync(manifest, 'utf8'));
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
 * Name the platform package this run expects, and the ones npm legitimately
 * installs beside it.
 *
 * NAPI-RS writes a `libc` selector for the `gnu` and `musl` ABIs only, so the
 * two armv7 `eabihf` packages carry none: npm keeps both on an armv7 host and
 * the generated loader probes the runtime to pick one. Every other `os`/`cpu`
 * pair is split by `libc`, so npm resolves it to a single package. The rule
 * reads that property off the configured targets rather than naming any
 * package, so a change to `napi.targets` moves it without an edit here.
 *
 * @param {string} suffix - Platform suffix the caller named.
 * @param {Array<{ cpu: string, libc?: string | undefined, name: string, os: string, suffix: string }>} targets - Configured platform packages.
 * @returns {{ expected: string, siblings: string[] }} Expected package and the siblings no selector excludes.
 */
export const expectedPlatformPackageSet = (suffix, targets) => {
  const expected = targets.find((target) => target.suffix === suffix);
  if (expected === undefined) {
    throw new Error(`${ROOT_PACKAGE}.napi.targets configures no ${ROOT_PACKAGE}-${suffix}`);
  }
  return {
    expected: expected.name,
    siblings: targets
      .filter(
        (target) =>
          target.name !== expected.name &&
          target.libc === undefined &&
          target.os === expected.os &&
          target.cpu === expected.cpu,
      )
      .map((target) => target.name)
      .sort(),
  };
};

/**
 * Settle an installed platform package listing against that rule.
 *
 * @param {string[]} installed - Configured platform packages the install holds.
 * @param {{ expected: string, siblings: string[] }} rule - Expected package and its siblings.
 * @returns {string} The evidence line naming what npm installed.
 */
export const checkInstalledPlatformPackages = (installed, { expected, siblings }) => {
  const allowed = new Set([expected, ...siblings]);
  if (!installed.includes(expected) || installed.some((name) => !allowed.has(name))) {
    const beside = siblings.length === 0 ? '' : `, optionally beside ${siblings.join(', ')}`;
    throw new Error(
      `expected the platform package ${expected}${beside}, but installed: ${installed.join(', ') || 'none'}`,
    );
  }
  const beside = installed.filter((name) => name !== expected);
  return beside.length === 0 ? expected : `${expected} beside ${beside.join(', ')}`;
};

/**
 * Name every platform package whose native binding the process has open.
 *
 * `process.report` lists the shared objects the process loaded, the addon among
 * them, which is the only builtin-only way to prove which of two installed
 * packages the generated loader actually selected. Module paths are matched by
 * directory name so a Windows path reads the same as a POSIX one.
 *
 * @param {readonly string[]} sharedObjects - `process.report.getReport().sharedObjects`.
 * @param {Iterable<string>} platformNames - Platform package names to look for.
 * @returns {string[]} Sorted names whose binding is loaded.
 */
export const selectedPlatformPackages = (sharedObjects, platformNames) => {
  const wanted = new Set(platformNames);
  /** @type {Set<string>} */
  const loaded = new Set();
  for (const object of sharedObjects) {
    const path = String(object).replaceAll('\\', '/');
    if (!path.endsWith('.node')) continue;
    for (const segment of path.split('/')) if (wanted.has(segment)) loaded.add(segment);
  }
  return [...loaded].sort();
};

/**
 * Settle which platform binding the generated loader opened.
 *
 * A binding from any other installed package is always wrong. An absent
 * listing is another matter: Windows reports no addon among its shared objects
 * before Node 22.14, and 22.13.0 is the supported floor. That only costs
 * evidence where npm resolved a single package, because the install listing
 * already proves which package the loader had to open; where npm kept more
 * than one, nothing else proves the choice, so an absent listing fails.
 *
 * @param {string[]} loaded - Platform packages whose binding is open.
 * @param {string} expected - Platform package this run smokes.
 * @param {string[]} installed - Configured platform packages the install holds.
 * @returns {string} The evidence line.
 */
export const settleLoaderSelection = (loaded, expected, installed) => {
  const strays = loaded.filter((name) => name !== expected);
  if (strays.length > 0) {
    throw new Error(`the loader opened ${strays.join(', ')}, expected ${expected}`);
  }
  if (loaded.includes(expected)) return `loader selected: ${expected}`;
  if (installed.length > 1) {
    throw new Error(
      `the loader opened no platform binding out of ${installed.join(', ')}, so nothing proves it selected ${expected}`,
    );
  }
  return `loader selection unproven: this runtime lists no addon among its shared objects, and ${expected} is the only platform package installed`;
};

/**
 * Read the `RenderFailureCode` a smoke row expects its render to reject with.
 *
 * A row names one only where the package itself refuses to render — a host
 * driver defect it guards against — and the refusal is then the evidence.
 * Every other stage of the smoke still has to pass on such a row, and a crash
 * never satisfies it.
 *
 * @param {Record<string, string | undefined>} environment - Process environment.
 * @returns {string | undefined} The expected code, or `undefined` when a render is required.
 */
export const resolveExpectedRenderError = (environment) => {
  const code = environment['NANORASTER_SMOKE_EXPECT_RENDER_ERROR'];
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : undefined;
};

/**
 * Settle what the render produced against what the row expects of it.
 *
 * The render phase classifies its own rejection with the package's exported
 * `RenderError.from`, so this reads a code and a message rather than a child
 * process's exit status: a row is satisfied by a typed refusal, never by a
 * process that died.
 *
 * @param {string | undefined} expected - The code this row expects, when it expects one.
 * @param {{ code: string, message: string } | undefined} refusal - The classified rejection, or `undefined` when the render succeeded.
 * @returns {string | undefined} The evidence line for an expected refusal.
 */
export const settleRenderError = (expected, refusal) => {
  if (refusal === undefined) {
    if (expected === undefined) return undefined;
    throw new Error(
      `the render succeeded although this row expects \`${expected}\`; the host condition is gone, so lift expectRenderError from the row in .github/workflows/ci.yml and update compatibility.md`,
    );
  }
  if (refusal.code !== expected) {
    throw new Error(
      `the render failed with \`${refusal.code}\` where this row expects \`${String(expected)}\`: ${refusal.message}`,
      { cause: refusal },
    );
  }
  return `render refused: ${refusal.code}: ${refusal.message}`;
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

// Two phases, run as two processes: a driver fault during the render takes the
// process down with it, so the load and adapter evidence has to come from a
// child that has already exited rather than from output the render may swallow.
// The render phase settles its own outcome, because only it holds both the
// package's classifier and the rejection to classify.
const consumerSource = (helperUrl) => `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  formatCauseChain,
  resolveExpectedRenderError,
  selectedPlatformPackages,
  settleLoaderSelection,
  settleRenderError,
} from ${JSON.stringify(helperUrl)};

const [phase, fixture] = process.argv.slice(2);
try {
  const api = await import('nanoraster');
  if (phase === 'adapter') {
    // The published wasm asset is packed beside the native loader; a consumer
    // bundling for browsers resolves exactly these bytes.
    await WebAssembly.compile(await readFile(new URL(import.meta.resolve('nanoraster/wasm'))));
    // \`describeAdapter\` resolves \`undefined\` rather than rejecting when no
    // adapter is available, so an absent one is this assertion, not the catch.
    const adapter = await api.describeAdapter();
    assert.ok(adapter, 'no Vulkan adapter is available to render on');
    console.log('adapter:', adapter);
    // The addon is open by now, so the loaded shared objects say which of the
    // installed platform packages the generated loader chose. On a host where
    // npm installs more than one, this is the only proof it chose right.
    const installed = JSON.parse(process.env['NANORASTER_SMOKE_INSTALLED']);
    const expected = process.env['NANORASTER_SMOKE_EXPECTED'];
    const loaded = selectedPlatformPackages(process.report.getReport().sharedObjects, installed);
    console.log(settleLoaderSelection(loaded, expected, installed));
  } else {
    const expected = resolveExpectedRenderError(process.env);
    const glb = await readFile(fixture);
    let image;
    let refusal;
    try {
      image = await api.renderImage(new Uint8Array(glb), { format: 'png', width: 64, height: 64 });
    } catch (error) {
      // Only a row that expects a refusal classifies one; anywhere else the
      // thrown value goes on with its whole cause chain intact.
      if (expected === undefined) throw error;
      refusal = api.RenderError.from(error);
    }
    const evidence = settleRenderError(expected, refusal);
    if (evidence === undefined) {
      assert.equal(image.mimeType, 'image/png');
      assert.equal(image.name, 'render.png');
      assert.deepEqual([...image.bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    } else {
      console.log(evidence);
    }
  }
} catch (error) {
  console.error(\`\${phase} phase failed:\`);
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
  // The rule comes off this checkout's `napi.targets`, which is what the
  // release under test was configured from; `readNapiTargets` resolves no
  // package, so the clean room stays dependency-free.
  const rule = expectedPlatformPackageSet(
    suffix,
    readNapiTargets(new URL('../package.json', import.meta.url)).packages,
  );
  const platformName = rule.expected;
  const fixture = fileURLToPath(new URL('../tests/fixtures/gear-12.glb', import.meta.url));
  const work = mkdtempSync(join(tmpdir(), 'nanoraster-package-'));

  try {
    writeFileSync(join(work, 'package.json'), '{"private":true,"type":"module"}\n');
    let version;
    let configuredNames;
    if (mode.kind === 'tarball') {
      const frozen = readFrozenManifest(mode.directory);
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
    console.log(`installed platform packages: ${checkInstalledPlatformPackages(installed, rule)}`);

    writeFileSync(join(work, 'consumer.mjs'), consumerSource(import.meta.url));
    const runConsumer = (...phase) =>
      execFileSync(process.execPath, ['consumer.mjs', ...phase], {
        cwd: work,
        env: {
          ...process.env,
          NANORASTER_SMOKE_EXPECTED: platformName,
          NANORASTER_SMOKE_INSTALLED: JSON.stringify(installed),
          // The loader's version check is a runtime opt-in; a published release
          // is where a drifted platform package could actually reach a consumer.
          ...(mode.kind === 'registry' ? { NAPI_RS_ENFORCE_VERSION_CHECK: '1' } : {}),
        },
        stdio: 'inherit',
      });
    runConsumer('adapter');
    // The render child settles the row's expectation itself and exits non-zero
    // when it is not met, so a crash reaches here as the failure it is.
    runConsumer('render', fixture);

    writeFileSync(join(work, 'consumer.cjs'), cjsProbeSource);
    execFileSync(process.execPath, ['consumer.cjs'], { cwd: work, stdio: 'inherit' });

    if (installedManifest.version !== version) {
      throw new Error(`installed ${ROOT_PACKAGE}@${installedManifest.version}, expected ${version}`);
    }
    const expected = resolveExpectedRenderError(process.env);
    const evidence =
      expected === undefined ? '' : ` (render refused: ${expected} — documented host condition)`;
    console.log(
      `clean-room ${mode.kind} smoke passed${evidence}: ${ROOT_PACKAGE}@${version} through ${platformName} on ${process.platform}-${process.arch}`,
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
    // A consumer that died without output: the exit status and the signal
    // (a SIGSEGV/SIGABRT inside the addon prints nothing) are the only clues.
    if (error !== null && typeof error === 'object' && ('status' in error || 'signal' in error)) {
      console.error(`child exit: status=${String(error.status)} signal=${String(error.signal)}`);
    }
    process.exit(1);
  }
}
