import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { deriveRelease, RELEASE_FILES } from '../scripts/ci-release.mjs';
import {
  validateRequestedVersion,
  versionFromPlans,
  withoutNonHumanAuthors,
} from '../scripts/prepare-release.mjs';

const SHA = 'a'.repeat(40);
const stable = {
  event: 'push',
  ref: 'refs/heads/main',
  sha: SHA,
  packageVersion: '0.1.0',
  subject: 'chore(release): nanoraster v0.1.0',
  changedFiles: ['.nx/version-plans/initial-release.md', 'CHANGELOG.md', 'package.json'],
  changelog: '## 0.1.0\n',
};

describe('CI release policy', () => {
  it('should publish one root release commit on main', () => {
    assert.deepEqual(deriveRelease(stable), {
      kind: 'release',
      npmPublish: true,
      releaseTag: 'v0.1.0',
      version: '0.1.0',
    });
  });

  it('should validate but never publish a release pull request', () => {
    assert.deepEqual(deriveRelease({ ...stable, event: 'pull_request', ref: 'refs/pull/1/merge' }), {
      kind: 'release-pull-request',
      npmPublish: false,
      version: '0.1.0',
    });
  });

  it('should not publish an ordinary main commit', () => {
    assert.deepEqual(
      deriveRelease({
        ...stable,
        subject: 'fix: ordinary change',
        changedFiles: ['src/index.ts'],
      }),
      { kind: 'main', npmPublish: false, version: '0.1.0' },
    );
  });

  it('should accept a release commit that also updates the lockfile', () => {
    assert.deepEqual(deriveRelease({ ...stable, changedFiles: [...stable.changedFiles, 'pnpm-lock.yaml'] }), {
      kind: 'release',
      npmPublish: true,
      releaseTag: 'v0.1.0',
      version: '0.1.0',
    });
  });

  it('should reject a release commit that leaves a root release file unchanged', () => {
    assert.throws(
      () =>
        deriveRelease({ ...stable, changedFiles: ['.nx/version-plans/initial-release.md', 'package.json'] }),
      /release commit must change CHANGELOG\.md/u,
    );
    assert.throws(
      () =>
        deriveRelease({ ...stable, changedFiles: ['.nx/version-plans/initial-release.md', 'CHANGELOG.md'] }),
      /release commit must change package\.json/u,
    );
  });

  it('should reject a release commit that consumes no Version Plan', () => {
    assert.throws(
      () => deriveRelease({ ...stable, changedFiles: ['CHANGELOG.md', 'package.json'] }),
      /must consume a Version Plan/u,
    );
  });

  it('should reject a generated platform manifest in a release commit', () => {
    assert.throws(
      () =>
        deriveRelease({
          ...stable,
          changedFiles: [...stable.changedFiles, 'npm/linux-x64-gnu/package.json'],
        }),
      /unexpected files: npm\/linux-x64-gnu\/package\.json/u,
    );
  });

  it('should reject a release commit that carries source changes', () => {
    assert.throws(
      () => deriveRelease({ ...stable, changedFiles: [...stable.changedFiles, 'src/index.ts'] }),
      /unexpected files: src\/index\.ts/u,
    );
  });

  it('should reject a release from anything but protected main', () => {
    assert.throws(() => deriveRelease({ ...stable, ref: 'refs/heads/release' }), /protected main/u);
  });

  it('should reject a malformed release subject on main', () => {
    assert.throws(
      () => deriveRelease({ ...stable, subject: 'chore(release): nanoraster v' }),
      /malformed release subject/u,
    );
  });

  it('should reject a release subject that disagrees with the package version', () => {
    assert.throws(
      () => deriveRelease({ ...stable, subject: 'chore(release): nanoraster v0.2.0' }),
      /does not match 0\.1\.0/u,
    );
  });

  it('should reject a prerelease version', () => {
    assert.throws(
      () =>
        deriveRelease({
          ...stable,
          packageVersion: '0.1.0-rc.1',
          subject: 'chore(release): nanoraster v0.1.0-rc.1',
        }),
      /not stable SemVer/u,
    );
  });

  it('should reject a release whose changelog has no section for the version', () => {
    assert.throws(() => deriveRelease({ ...stable, changelog: '## 0.0.9\n' }), /no 0\.1\.0 section/u);
  });
});

describe('release pull request staging', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release-pr.yml', import.meta.url), 'utf8');

  /** The `allowed` guard the release-pr job greps its staged file list against. */
  const allowed = (() => {
    const declaration = /^\s*allowed='([^']+)'$/mu.exec(workflow);
    assert(declaration, 'release-pr.yml must declare the allowed staged-file pattern');
    return new RegExp(declaration[1], 'u');
  })();

  /** The paths the job stages explicitly, from its single `git add` invocation. */
  const staged = (() => {
    const command = /^\s*git add (.+)$/mu.exec(workflow);
    assert(command, 'release-pr.yml must stage the release files explicitly');
    return command[1].trim().split(/\s+/u);
  })();

  it('should admit every file a root release rewrites', () => {
    // The two guards are one contract: what `ci.yml` demands of a release
    // commit is exactly what the bot is allowed to stage into one.
    for (const file of RELEASE_FILES) {
      assert(allowed.test(file), `release-pr.yml rejects the required release file ${file}`);
      assert(staged.includes(file), `release-pr.yml never stages the required release file ${file}`);
    }
    assert(allowed.test('.nx/version-plans/initial-release.md'), 'a consumed Version Plan is allowed');
  });

  it('should refuse a generated platform manifest in the release commit', () => {
    assert(!allowed.test('npm/linux-x64-gnu/package.json'));
    assert(!staged.includes('npm'));
    assert(!allowed.test('pnpm-lock.yaml'), 'a lockfile change is never staged by the bot');
  });
});

describe('root release version validation', () => {
  const planned = { currentVersion: '0.3.0', plannedVersion: '0.4.0', requestedVersion: '0.4.0' };

  it('should accept a stable requested version the plans agree on', () => {
    assert.equal(validateRequestedVersion(planned), '0.4.0');
  });

  it('should reject a requested version the plans did not produce', () => {
    assert.throws(
      () => validateRequestedVersion({ ...planned, requestedVersion: '0.5.0' }),
      /requested 0\.5\.0 does not match Version Plans \(0\.4\.0\)/u,
    );
  });

  it('should reject a requested version that is not newer than the current one', () => {
    assert.throws(
      () =>
        validateRequestedVersion({
          currentVersion: '0.4.0',
          plannedVersion: '0.4.0',
          requestedVersion: '0.4.0',
        }),
      /0\.4\.0 must be newer than 0\.4\.0/u,
    );
  });

  it('should reject a prerelease version', () => {
    assert.throws(
      () =>
        validateRequestedVersion({
          currentVersion: '0.3.0',
          plannedVersion: '0.4.0-rc.1',
          requestedVersion: '0.4.0-rc.1',
        }),
      /stable SemVer/u,
    );
  });

  it('should reject an unreadable current or requested version', () => {
    assert.throws(
      () => validateRequestedVersion({ ...planned, currentVersion: 'nightly' }),
      /invalid package version: nightly/u,
    );
    assert.throws(
      () => validateRequestedVersion({ ...planned, plannedVersion: undefined, requestedVersion: '0.4.0' }),
      /invalid Version Plan result/u,
    );
  });
});

describe('version derivation from plans', () => {
  it('should return the version the pending plans dictate', () => {
    assert.equal(versionFromPlans('0.4.0'), '0.4.0');
  });

  it('should reject a release with no pending Version Plan', () => {
    assert.throws(() => versionFromPlans(undefined), /no pending Version Plan/u);
  });
});

describe('changelog thank you section', () => {
  const entry = (authors) =>
    [
      '## 0.3.1 (2026-08-20)',
      '',
      '### 🩹 Fixes',
      '',
      '- a fix',
      '',
      '### ❤️ Thank You',
      '',
      ...authors,
      '',
    ].join('\n');
  const published = ['## 0.3.0 (2026-08-19)', '', '### ❤️ Thank You', '', '- Claude Fable 5', ''].join('\n');

  it('should keep people and drop assistants and bots', () => {
    const changelog = `${entry(['- Claude Fable 5', '- Richard Fontein @rifont', '- dependabot[bot]'])}\n${published}`;
    const rendered = withoutNonHumanAuthors(changelog);

    assert.match(rendered, /### ❤️ Thank You\n\n- Richard Fontein @rifont\n/u);
    assert.doesNotMatch(rendered.split('## 0.3.0')[0], /Claude|\[bot\]/u);
  });

  it('should leave published entries untouched', () => {
    const changelog = `${entry(['- Claude Fable 5', '- Richard Fontein @rifont'])}\n${published}`;
    assert(withoutNonHumanAuthors(changelog).endsWith(published));
  });

  it('should remove the heading when nobody is left to thank', () => {
    const rendered = withoutNonHumanAuthors(entry(['- dependabot[bot]']));

    assert.doesNotMatch(rendered, /Thank You/u);
    assert.match(rendered, /- a fix\n$/u);
  });

  it('should leave a changelog without the section alone', () => {
    const changelog = '## 0.3.1 (2026-08-20)\n\n### 🩹 Fixes\n\n- a fix\n';
    assert.equal(withoutNonHumanAuthors(changelog), changelog);
  });

  it('should leave an already-filtered changelog unchanged', () => {
    const changelog = entry(['- Claude Fable 5', '- Richard Fontein @rifont']);
    const once = withoutNonHumanAuthors(changelog);
    assert.equal(withoutNonHumanAuthors(once), once);
  });
});
