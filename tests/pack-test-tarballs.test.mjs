import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { readNapiTargets } from '../scripts/lib/napi-targets.mjs';
import { npmPack, packTestTarballs } from '../scripts/pack-test-tarballs.mjs';

const { manifest, packages } = readNapiTargets(new URL('../package.json', import.meta.url));
const written = [];

const temporaryDirectory = (prefix) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  written.push(directory);
  return directory;
};

const createTree = () => {
  const root = temporaryDirectory('nanoraster-tarballs-');
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const target of packages) {
    mkdirSync(join(root, 'npm', target.suffix), { recursive: true });
  }
  return root;
};

// Names the packed directory so the assertions can prove every configured
// package was packed exactly once, in place of a real 17-way `npm pack`.
const recordingPack = (overrides = {}) => {
  const calls = [];
  const pack = (directory, destination) => {
    calls.push({ destination, directory });
    const suffix = directory.split(/[/\\]/u).at(-1);
    const target = packages.find((candidate) => candidate.suffix === suffix);
    const name = target ? target.name : manifest.name;
    return {
      filename: `${name}-${manifest.version}.tgz`,
      integrity: `sha512-${Buffer.from(name).toString('base64')}`,
      name,
      version: manifest.version,
      ...overrides[name],
    };
  };
  return { calls, pack };
};

afterEach(() => {
  for (const directory of written.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('frozen test tarball manifest', () => {
  it('should record one entry per generated package plus the root, sorted by name', () => {
    const root = createTree();
    const out = join(root, 'tarballs');
    const { calls, pack } = recordingPack();

    const result = packTestTarballs({ out, pack, root });

    assert.equal(calls.length, 17);
    assert.deepEqual(new Set(calls.map(({ destination }) => destination)), new Set([out]));
    const names = Object.keys(result.packages);
    assert.equal(names.length, 17);
    assert.deepEqual(names, [...names].sort());
    assert.deepEqual(names.slice(0, 2), ['nanoraster', 'nanoraster-android-arm-eabi']);
    assert.equal(result.version, manifest.version);
    assert.deepEqual(result.packages['nanoraster-linux-s390x-gnu'], {
      filename: `nanoraster-linux-s390x-gnu-${manifest.version}.tgz`,
      integrity: `sha512-${Buffer.from('nanoraster-linux-s390x-gnu').toString('base64')}`,
      version: manifest.version,
    });
  });

  it('should write the same manifest beside the tarballs and into the frozen tree', () => {
    const root = createTree();
    const out = join(root, 'tarballs');
    const { pack } = recordingPack();

    const result = packTestTarballs({ out, pack, root });

    const beside = readFileSync(join(out, 'test-tarballs.json'), 'utf8');
    const frozen = readFileSync(join(root, 'test-tarballs.json'), 'utf8');
    assert.equal(beside, frozen);
    assert.deepEqual(JSON.parse(frozen), result);
    assert.equal(beside.at(-1), '\n');
  });

  it('should reject a package whose packed version differs from the root version', () => {
    const root = createTree();
    const { pack } = recordingPack({ 'nanoraster-win32-ia32-msvc': { version: '0.0.1' } });

    assert.throws(
      () => packTestTarballs({ out: join(root, 'tarballs'), pack, root }),
      /nanoraster-win32-ia32-msvc packed version 0\.0\.1, expected /u,
    );
  });

  it('should reject a package whose packed name is not the configured one', () => {
    const root = createTree();
    const { pack } = recordingPack({
      'nanoraster-freebsd-x64': { name: 'nanoraster-freebsd-arm64' },
    });

    assert.throws(
      () => packTestTarballs({ out: join(root, 'tarballs'), pack, root }),
      /packed nanoraster-freebsd-arm64, expected nanoraster-freebsd-x64/u,
    );
  });

  it('should pack a real directory and report its name, version, filename, and integrity', () => {
    const source = temporaryDirectory('nanoraster-pack-source-');
    const destination = temporaryDirectory('nanoraster-pack-out-');
    writeFileSync(
      join(source, 'package.json'),
      `${JSON.stringify({ files: ['index.js'], name: 'nanoraster-linux-x64-gnu', private: false, version: '9.9.9' }, null, 2)}\n`,
    );
    writeFileSync(join(source, 'index.js'), 'export const nothing = 0;\n');

    const packed = npmPack(source, destination);

    assert.equal(packed.name, 'nanoraster-linux-x64-gnu');
    assert.equal(packed.version, '9.9.9');
    assert.equal(packed.filename, 'nanoraster-linux-x64-gnu-9.9.9.tgz');
    assert.match(packed.integrity, /^sha512-[\w+/=]+$/u);
    assert.equal(readFileSync(join(destination, packed.filename)).length > 0, true);
  });
});
