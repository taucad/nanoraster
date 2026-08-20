#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { releaseChangelog, releaseVersion } from 'nx/release/index.js';
import semver from 'semver';

const PACKAGE_PATHS = [
  new URL('../package.json', import.meta.url),
  new URL('../npm/darwin-arm64/package.json', import.meta.url),
  new URL('../npm/linux-x64-gnu/package.json', import.meta.url),
  new URL('../npm/win32-x64-msvc/package.json', import.meta.url),
];
const PROJECTS = [
  'nanoraster',
  'nanoraster-darwin-arm64',
  'nanoraster-linux-x64-gnu',
  'nanoraster-win32-x64-msvc',
];
const PLATFORM_PACKAGES = PROJECTS.slice(1);
const GIT_OPTIONS = {
  gitCommit: false,
  gitPush: false,
  gitTag: false,
  stageChanges: false,
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const packageVersions = () => PACKAGE_PATHS.map((path) => JSON.parse(readFileSync(path, 'utf8')).version);

const syncOptionalDependencies = (version) => {
  const path = PACKAGE_PATHS[0];
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const name of PLATFORM_PACKAGES) manifest.optionalDependencies[name] = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
};

const assertClean = () => {
  const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  assert(status.length === 0, 'release preparation requires a clean worktree');
};

/** The one version every pending Version Plan agrees on, for `--from-plans` runs. */
export const versionFromPlans = (plannedVersions) => {
  assert(
    plannedVersions.length > 0 && plannedVersions.every(Boolean),
    'no pending Version Plan affects the fixed release group',
  );
  assert(new Set(plannedVersions).size === 1, 'Version Plans did not produce one fixed version');
  return plannedVersions[0];
};

export const validateRequestedVersion = ({
  currentVersions,
  optionalDependencyVersions,
  plannedVersions,
  requestedVersion,
}) => {
  assert(
    currentVersions.every((version) => semver.valid(version)),
    'invalid package version',
  );
  assert(new Set(currentVersions).size === 1, 'fixed release packages have different versions');
  assert(
    optionalDependencyVersions.every((version) => version === currentVersions[0]),
    'native optional dependency versions do not match the fixed release group',
  );
  assert(
    plannedVersions.every((version) => semver.valid(version)),
    'invalid Version Plan result',
  );
  assert(new Set(plannedVersions).size === 1, 'Version Plans did not produce one fixed version');
  assert(semver.valid(requestedVersion), `invalid requested version: ${requestedVersion}`);
  assert(semver.prerelease(requestedVersion) === null, 'routine releases require stable SemVer');
  assert(
    plannedVersions[0] === requestedVersion,
    `requested ${requestedVersion} does not match Version Plans (${plannedVersions[0]})`,
  );
  assert(
    semver.gt(requestedVersion, currentVersions[0]),
    `${requestedVersion} must be newer than ${currentVersions[0]}`,
  );
  return requestedVersion;
};

const prepare = async ({ dryRun, requestedVersion }) => {
  const currentVersions = packageVersions();
  const rootManifest = JSON.parse(readFileSync(PACKAGE_PATHS[0], 'utf8'));
  const optionalDependencyVersions = PLATFORM_PACKAGES.map((name) => rootManifest.optionalDependencies[name]);
  const preview = await releaseVersion({
    ...GIT_OPTIONS,
    deleteVersionPlans: false,
    dryRun: true,
  });
  const plannedVersions = PROJECTS.map((project) => preview.projectsVersionData[project]?.newVersion);
  assert(plannedVersions.every(Boolean), 'no pending Version Plan affects the fixed release group');
  const version = requestedVersion ?? versionFromPlans(plannedVersions);
  validateRequestedVersion({
    currentVersions,
    optionalDependencyVersions,
    plannedVersions,
    requestedVersion: version,
  });

  await releaseChangelog({
    ...GIT_OPTIONS,
    createRelease: false,
    deleteVersionPlans: true,
    dryRun: true,
    releaseGraph: preview.releaseGraph,
    version,
  });
  if (dryRun) return version;

  assertClean();
  await releaseVersion({
    ...GIT_OPTIONS,
    deleteVersionPlans: true,
    version,
  });
  syncOptionalDependencies(version);
  execFileSync('pnpm', ['install', '--lockfile-only'], { stdio: 'inherit' });
  await releaseChangelog({
    ...GIT_OPTIONS,
    createRelease: false,
    deleteVersionPlans: false,
    releaseGraph: preview.releaseGraph,
    version,
  });
  assert(
    packageVersions().every((prepared) => prepared === version),
    `fixed release did not prepare every package at ${version}`,
  );
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
