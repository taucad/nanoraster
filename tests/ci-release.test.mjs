import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { deriveRelease } from '../scripts/ci-release.mjs';
import { validateRequestedVersion, versionFromPlans } from '../scripts/prepare-release.mjs';

const SHA = 'a'.repeat(40);
const stable = {
  event: 'push',
  ref: 'refs/heads/main',
  sha: SHA,
  packageVersion: '0.1.0',
  subject: 'chore(release): nanoraster v0.1.0',
  changedFiles: [
    '.nx/version-plans/initial-release.md',
    'CHANGELOG.md',
    'npm/darwin-arm64/package.json',
    'npm/linux-x64-gnu/package.json',
    'npm/win32-x64-msvc/package.json',
    'package.json',
    'pnpm-lock.yaml',
  ],
  changelog: '## 0.1.0\n',
};

describe('CI release policy', () => {
  it('publishes candidate tarballs through explicit relative paths', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    assert(workflow.includes('npm publish "./candidate/$filename" --access public --provenance'));
  });

  it('publishes one exact fixed-group release commit on main', () => {
    assert.deepEqual(deriveRelease(stable), {
      kind: 'release',
      npmPublish: true,
      releaseTag: 'v0.1.0',
      version: '0.1.0',
    });
  });

  it('validates but never publishes a release pull request', () => {
    assert.deepEqual(deriveRelease({ ...stable, event: 'pull_request', ref: 'refs/pull/1/merge' }), {
      kind: 'release-pull-request',
      npmPublish: false,
      version: '0.1.0',
    });
  });

  it('does not publish an ordinary main commit', () => {
    assert.deepEqual(
      deriveRelease({
        ...stable,
        subject: 'fix: ordinary change',
        changedFiles: ['src/index.ts'],
      }),
      { kind: 'main', npmPublish: false, version: '0.1.0' },
    );
  });

  it('rejects incomplete or impure release commits', () => {
    assert.throws(
      () => deriveRelease({ ...stable, changedFiles: stable.changedFiles.slice(1) }),
      /Version Plan/u,
    );
    assert.throws(
      () => deriveRelease({ ...stable, changedFiles: [...stable.changedFiles, 'src/index.ts'] }),
      /unexpected files/u,
    );
    assert.throws(() => deriveRelease({ ...stable, ref: 'refs/heads/release' }), /protected main/u);
  });
});

describe('fixed release version validation', () => {
  it('accepts one planned stable version for all four packages', () => {
    assert.equal(
      validateRequestedVersion({
        currentVersions: Array(4).fill('0.0.0'),
        optionalDependencyVersions: Array(3).fill('0.0.0'),
        plannedVersions: Array(4).fill('0.1.0'),
        requestedVersion: '0.1.0',
      }),
      '0.1.0',
    );
  });

  it('rejects drift inside the fixed release group', () => {
    assert.throws(
      () =>
        validateRequestedVersion({
          currentVersions: ['0.0.0', '0.0.1', '0.0.0', '0.0.0'],
          optionalDependencyVersions: Array(3).fill('0.0.0'),
          plannedVersions: Array(4).fill('0.1.0'),
          requestedVersion: '0.1.0',
        }),
      /different versions/u,
    );
  });

  it('rejects native optional dependency drift', () => {
    assert.throws(
      () =>
        validateRequestedVersion({
          currentVersions: Array(4).fill('0.0.0'),
          optionalDependencyVersions: ['0.0.0', '0.0.1', '0.0.0'],
          plannedVersions: Array(4).fill('0.1.0'),
          requestedVersion: '0.1.0',
        }),
      /native optional dependency versions do not match/u,
    );
  });
});

describe('version derivation from plans', () => {
  it('derives the one version every plan agrees on', () => {
    assert.equal(versionFromPlans(Array(4).fill('0.4.0')), '0.4.0');
  });

  it('rejects an empty or partial fixed group', () => {
    assert.throws(() => versionFromPlans([]), /no pending Version Plan/u);
    assert.throws(() => versionFromPlans(['0.4.0', undefined, '0.4.0', '0.4.0']), /no pending Version Plan/u);
  });

  it('rejects plans that disagree on the version', () => {
    assert.throws(
      () => versionFromPlans(['0.4.0', '0.5.0', '0.4.0', '0.4.0']),
      /did not produce one fixed version/u,
    );
  });

  it('rejects a derived prerelease through the shared validation', () => {
    const planned = Array(4).fill('0.4.0-rc.1');
    assert.throws(
      () =>
        validateRequestedVersion({
          currentVersions: Array(4).fill('0.3.0'),
          optionalDependencyVersions: Array(3).fill('0.3.0'),
          plannedVersions: planned,
          requestedVersion: versionFromPlans(planned),
        }),
      /stable SemVer/u,
    );
  });
});
