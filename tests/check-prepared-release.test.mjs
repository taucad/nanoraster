import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { preparedReleaseFindings } from '../scripts/check-prepared-release.mjs';
import { readNapiTargets } from '../scripts/lib/napi-targets.mjs';
import { PACKAGE_FILES } from '../scripts/package-files.mjs';

const { manifest, packages } = readNapiTargets(new URL('../package.json', import.meta.url));
const version = manifest.version;

const platformManifest = (target) => ({
  bugs: manifest.bugs,
  cpu: [target.cpu],
  description: manifest.description,
  engines: manifest.engines,
  files: [target.binary],
  license: manifest.license,
  main: target.binary,
  name: target.name,
  os: [target.os],
  publishConfig: { access: 'public' },
  repository: manifest.repository,
  version,
  ...(target.libc ? { libc: [target.libc] } : {}),
});

const written = [];

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const createPreparedTree = () => {
  const root = mkdtempSync(join(tmpdir(), 'nanoraster-prepared-'));
  written.push(root);
  writeJson(join(root, 'package.json'), {
    ...manifest,
    optionalDependencies: Object.fromEntries(packages.map(({ name }) => [name, version])),
  });
  mkdirSync(join(root, 'dist', 'native'), { recursive: true });
  writeFileSync(join(root, 'dist', 'native', 'index.js'), 'export const nothing = 0;\n');
  for (const target of packages) {
    const directory = join(root, 'npm', target.suffix);
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, 'package.json'), platformManifest(target));
    writeFileSync(join(directory, target.binary), `binary for ${target.suffix}`);
    writeFileSync(join(directory, 'license'), 'Apache License 2.0\n');
    writeFileSync(join(directory, 'README.md'), `# ${target.name}\n`);
  }
  return root;
};

const findingsFor = (root, packedFiles = PACKAGE_FILES) => preparedReleaseFindings({ packedFiles, root });

const patchPlatformManifest = (root, suffix, patch) => {
  const target = packages.find((candidate) => candidate.suffix === suffix);
  writeJson(join(root, 'npm', suffix, 'package.json'), { ...platformManifest(target), ...patch });
};

afterEach(() => {
  for (const directory of written.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('prepared release completeness gate', () => {
  it('should accept a tree with sixteen generated packages and a matching root manifest', () => {
    assert.deepEqual(findingsFor(createPreparedTree()), []);
  });

  it('should reject an unknown directory inside the generated npm directory', () => {
    const root = createPreparedTree();
    mkdirSync(join(root, 'npm', 'linux-riscv64-gnu'));
    assert.deepEqual(findingsFor(root), ['npm/linux-riscv64-gnu is not a configured target package']);
  });

  it('should reject a missing target package', () => {
    const root = createPreparedTree();
    rmSync(join(root, 'npm', 'freebsd-x64'), { recursive: true });
    assert.deepEqual(findingsFor(root), ['freebsd-x64: npm/freebsd-x64/package.json is missing']);
  });

  it('should reject a wrong package name or version', () => {
    const root = createPreparedTree();
    patchPlatformManifest(root, 'linux-x64-gnu', { name: '@nanoraster/linux-x64-gnu' });
    patchPlatformManifest(root, 'darwin-arm64', { version: '9.9.9' });
    assert.deepEqual(findingsFor(root), [
      `darwin-arm64: expected version ${version}, found 9.9.9`,
      'linux-x64-gnu: expected name nanoraster-linux-x64-gnu, found @nanoraster/linux-x64-gnu',
    ]);
  });

  it('should reject a wrong os, cpu, or libc selector', () => {
    const root = createPreparedTree();
    patchPlatformManifest(root, 'linux-arm64-musl', { libc: ['glibc'] });
    patchPlatformManifest(root, 'win32-ia32-msvc', { cpu: ['x64'] });
    patchPlatformManifest(root, 'android-arm64', { os: ['linux'] });
    assert.deepEqual(findingsFor(root), [
      'android-arm64: expected os ["android"], found ["linux"]',
      'linux-arm64-musl: expected libc ["musl"], found ["glibc"]',
      'win32-ia32-msvc: expected cpu ["ia32"], found ["x64"]',
    ]);
  });

  it('should reject a libc selector on a target that carries none', () => {
    const root = createPreparedTree();
    patchPlatformManifest(root, 'linux-arm-gnueabihf', { libc: ['glibc'] });
    assert.deepEqual(findingsFor(root), ['linux-arm-gnueabihf: expected no libc selector, found ["glibc"]']);
  });

  it('should reject a wrong engine range, entry point, or file list', () => {
    const root = createPreparedTree();
    patchPlatformManifest(root, 'linux-x64-musl', { engines: { node: '>=18' } });
    patchPlatformManifest(root, 'linux-s390x-gnu', { main: 'index.js' });
    patchPlatformManifest(root, 'linux-ppc64-gnu', { files: [] });
    assert.deepEqual(findingsFor(root), [
      'linux-ppc64-gnu: expected files ["nanoraster.linux-ppc64-gnu.node"], found []',
      'linux-s390x-gnu: expected main nanoraster.linux-s390x-gnu.node, found index.js',
      `linux-x64-musl: expected engines ${JSON.stringify(manifest.engines)}, found {"node":">=18"}`,
    ]);
  });

  it('should reject a missing or mis-suffixed native binary', () => {
    const root = createPreparedTree();
    rmSync(join(root, 'npm', 'darwin-x64', 'nanoraster.darwin-x64.node'));
    writeFileSync(join(root, 'npm', 'darwin-x64', 'nanoraster.darwin-arm64.node'), 'wrong slice');
    assert.deepEqual(findingsFor(root), [
      'darwin-x64: npm/darwin-x64/nanoraster.darwin-x64.node is missing',
      'darwin-x64: npm/darwin-x64/nanoraster.darwin-arm64.node is not the darwin-x64 binary',
    ]);
  });

  it('should reject a package without a license field or a physical license file', () => {
    const root = createPreparedTree();
    patchPlatformManifest(root, 'win32-arm64-msvc', { license: undefined });
    rmSync(join(root, 'npm', 'linux-arm-musleabihf', 'license'));
    assert.deepEqual(findingsFor(root), [
      'linux-arm-musleabihf: npm/linux-arm-musleabihf/license is missing',
      `win32-arm64-msvc: expected license ${manifest.license}, found undefined`,
    ]);
  });

  it('should reject root optional dependencies that drift from the target set', () => {
    const root = createPreparedTree();
    const optionalDependencies = Object.fromEntries(packages.map(({ name }) => [name, version]));
    delete optionalDependencies['nanoraster-linux-x64-gnu'];
    optionalDependencies['nanoraster-linux-riscv64-gnu'] = version;
    optionalDependencies['nanoraster-darwin-arm64'] = '0.0.1';
    writeJson(join(root, 'package.json'), { ...manifest, optionalDependencies });
    assert.deepEqual(findingsFor(root), [
      'root optionalDependencies: nanoraster-linux-x64-gnu is missing',
      'root optionalDependencies: nanoraster-linux-riscv64-gnu is not a configured target package',
      `root optionalDependencies: expected nanoraster-darwin-arm64@${version}, found 0.0.1`,
    ]);
  });

  it('should reject a tree whose generated loader is missing', () => {
    const root = createPreparedTree();
    rmSync(join(root, 'dist', 'native', 'index.js'));
    assert.deepEqual(findingsFor(root), ['dist/native/index.js is missing']);
  });

  it('should reject a tree that ships the loader declarations', () => {
    const root = createPreparedTree();
    writeFileSync(join(root, 'dist', 'native', 'index.d.ts'), 'export {};\n');
    assert.deepEqual(findingsFor(root), ['dist/native/index.d.ts is a build input and must not ship']);
  });

  it('should reject a root pack that carries a native binary', () => {
    const root = createPreparedTree();
    const findings = findingsFor(root, [...PACKAGE_FILES, 'nanoraster.darwin-arm64.node']);
    assert.equal(findings.length, 2);
    assert.equal(findings[0], 'root pack: nanoraster.darwin-arm64.node is a native binary');
    assert.match(findings[1], /^root pack: npm package mismatch;/u);
  });

  it('should reject a root pack that drops a contracted file', () => {
    const root = createPreparedTree();
    const findings = findingsFor(
      root,
      PACKAGE_FILES.filter((file) => file !== 'package.json'),
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0], /^root pack: npm package mismatch;.*missing=\[package\.json\]/u);
  });
});
