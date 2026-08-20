---
name: release-nanoraster
description: Audits nanoraster release state or prepares release files locally. Use only when a maintainer explicitly invokes /release-nanoraster.
disable-model-invocation: true
argument-hint: '[status | prepare <version>]'
---

# Release nanoraster

GitHub Actions is the sole owner of npm publication, provenance, tags, and
GitHub Releases. Releases ship through the standing release pull request that
`release-pr.yml` maintains on `release/next`; a maintainer merging it is the
entire release act.

## Modes

- `status`: inspect the fixed package versions, Version Plans, the standing
  release pull request, recent `ci.yml` and `release-pr.yml` runs, npm
  versions and provenance, and GitHub Releases.
- `prepare <version>`: validate and generate release files locally for
  inspection, then stop without committing or pushing. The automation runs the
  same generation as `release:prepare --from-plans`.

Reject other arguments. The former `submit` mode is retired: `release-pr.yml`
regenerates the release pull request on every push to `main`, so there is
nothing to submit. The manual fallback for a broken bot is documented in
`MAINTAINER.md`.

## Prepare

1. Require clean `main`, `HEAD == origin/main`, a Version Plan, stable exact
   SemVer, and that the requested version matches what the plans produce.
2. Confirm npm Trusted Publishers for `nanoraster` and all three platform
   packages point to `taucad/nanoraster` and `.github/workflows/ci.yml`. Never
   replace an existing correct binding.
3. Run `pnpm release:prepare -- <version> --dry-run`, then the real run.
4. Require changes only to `package.json`, `pnpm-lock.yaml`, `CHANGELOG.md`, the
   three `npm/*/package.json` manifests, and consumed
   `.nx/version-plans/*.md` files.
5. Run `pnpm nx run nanoraster:quality`,
   `pnpm nx run nanoraster:docs-prose`, and `git diff --check`, then stop and
   report; discard the working tree rather than committing it.

## Boundaries

- Never run `npm publish`, create tags or releases, add `NPM_TOKEN`, or change
  repository or registry settings.
- Never push to `release/next` or enable auto-merge on the release pull
  request; the bot owns that branch.
- Never merge the release pull request; merging publishes and is the
  maintainer's act.
- Never edit generated changelog text without reconciling the Version Plan.
- Stop if any package name is unavailable or any trusted publisher binding is
  missing; registry ownership is an operator action.
