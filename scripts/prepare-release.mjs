#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { releaseChangelog, releaseVersion } from 'nx/release/index.js';
import semver from 'semver';

/**
 * The root package is the only released project: NAPI-RS generates the sixteen
 * platform packages during release assembly and `napi pre-publish` copies this
 * version into every one of them.
 */
const PROJECT = 'nanoraster';
const PACKAGE_PATH = new URL('../package.json', import.meta.url);
const GIT_OPTIONS = {
  gitCommit: false,
  gitPush: false,
  gitTag: false,
  stageChanges: false,
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const CHANGELOG_PATH = new URL('../CHANGELOG.md', import.meta.url);
const THANK_YOU = '### ❤️ Thank You';
/**
 * Authors that are not people: the `tau-release-bot` that commits the release
 * itself, Dependabot, and the coding assistants whose `Co-Authored-By` trailer
 * nx reads as an author.
 */
const NON_HUMAN_AUTHOR = /^- (?:claude\b|.*\[bot\])/iu;

/**
 * Drop non-human authors from the newest changelog entry's Thank You list.
 *
 * The commit trailer records who and what produced a change, which is where
 * that provenance belongs. This section credits people, so it follows the
 * usual release-note convention of leaving bots out of the thanks. Published
 * entries are left untouched — they are the record of what shipped.
 */
export const withoutNonHumanAuthors = (changelog) => {
  const lines = changelog.split('\n');
  const nextEntry = lines.findIndex((line, index) => index > 0 && line.startsWith('## '));
  const limit = nextEntry === -1 ? lines.length : nextEntry;
  const heading = lines.findIndex((line, index) => index < limit && line === THANK_YOU);
  if (heading === -1) return changelog;

  let end = heading + 1;
  while (end < limit && lines[end] === '') end += 1;
  const authors = [];
  while (end < limit && lines[end].startsWith('- ')) {
    authors.push(lines[end]);
    end += 1;
  }

  const people = authors.filter((author) => !NON_HUMAN_AUTHOR.test(author));
  if (people.length === authors.length) return changelog;

  // With nobody left to thank the heading goes too, along with the blank line
  // that separated it from the entry above.
  const start = people.length > 0 || lines[heading - 1] !== '' ? heading : heading - 1;
  const kept = people.length > 0 ? [THANK_YOU, '', ...people] : [];
  return [...lines.slice(0, start), ...kept, ...lines.slice(end)].join('\n');
};

const packageVersion = () => JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).version;

const assertClean = () => {
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  assert(status.length === 0, 'release preparation requires a clean worktree');
};

/** The version the pending Version Plans dictate, for `--from-plans` runs. */
export const versionFromPlans = (plannedVersion) => {
  assert(Boolean(plannedVersion), `no pending Version Plan affects ${PROJECT}`);
  return plannedVersion;
};

export const validateRequestedVersion = ({ currentVersion, plannedVersion, requestedVersion }) => {
  assert(semver.valid(currentVersion), `invalid package version: ${currentVersion}`);
  assert(semver.valid(plannedVersion), `invalid Version Plan result: ${plannedVersion}`);
  assert(semver.valid(requestedVersion), `invalid requested version: ${requestedVersion}`);
  assert(semver.prerelease(requestedVersion) === null, 'routine releases require stable SemVer');
  assert(
    plannedVersion === requestedVersion,
    `requested ${requestedVersion} does not match Version Plans (${plannedVersion})`,
  );
  assert(
    semver.gt(requestedVersion, currentVersion),
    `${requestedVersion} must be newer than ${currentVersion}`,
  );
  return requestedVersion;
};

const prepare = async ({ dryRun, requestedVersion }) => {
  // Asserted on entry: the quality gate `preVersionCommand` runs regenerates
  // committed artifacts (docs-site/lib/sizes.json), so the tree cannot stay
  // clean once preparation starts. Release-commit purity is enforced by the
  // caller staging only release files, and by the CI release policy.
  if (!dryRun) assertClean();
  const currentVersion = packageVersion();
  const preview = await releaseVersion({
    ...GIT_OPTIONS,
    deleteVersionPlans: false,
    dryRun: true,
  });
  const plannedVersion = versionFromPlans(preview.projectsVersionData[PROJECT]?.newVersion);
  const version = requestedVersion ?? plannedVersion;
  validateRequestedVersion({ currentVersion, plannedVersion, requestedVersion: version });

  await releaseChangelog({
    ...GIT_OPTIONS,
    createRelease: false,
    deleteVersionPlans: true,
    dryRun: true,
    releaseGraph: preview.releaseGraph,
    version,
  });
  if (dryRun) return version;

  await releaseVersion({
    ...GIT_OPTIONS,
    deleteVersionPlans: true,
    version,
  });
  await releaseChangelog({
    ...GIT_OPTIONS,
    createRelease: false,
    deleteVersionPlans: false,
    releaseGraph: preview.releaseGraph,
    version,
  });
  writeFileSync(CHANGELOG_PATH, withoutNonHumanAuthors(readFileSync(CHANGELOG_PATH, 'utf8')));
  assert(packageVersion() === version, `release preparation did not leave ${PROJECT} at ${version}`);
  return version;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requestedVersion = process.argv.slice(2).find((value) => !value.startsWith('-'));
  const dryRun = process.argv.includes('--dry-run');
  const fromPlans = process.argv.includes('--from-plans');

  try {
    assert(
      fromPlans ? !requestedVersion : requestedVersion,
      'usage: pnpm release:prepare -- <version> [--dry-run], or pnpm release:prepare -- --from-plans [--dry-run]',
    );
    const version = await prepare({ dryRun, requestedVersion });
    console.log(`${dryRun ? 'Would prepare' : 'Prepared'} nanoraster v${version}`);
    if (!dryRun) {
      console.log(`Commit generated release files as: chore(release): nanoraster v${version}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
