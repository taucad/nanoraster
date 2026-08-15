---
name: release-nanoraster
description: Audits or prepares reviewed nanoraster releases. Use only when a maintainer explicitly invokes /release-nanoraster.
disable-model-invocation: true
argument-hint: '[status | prepare <version> | submit <version>]'
---

# Release nanoraster

GitHub Actions is the sole owner of npm publication, provenance, tags, and
GitHub Releases.

## Modes

- `status`: inspect the fixed package versions, Version Plans, open release
  pull requests, recent `ci.yml` runs, npm versions and provenance, and GitHub
  Releases.
- `prepare <version>`: validate and generate release files locally, then stop
  without committing or pushing.
- `submit <version>`: prepare on `release/nanoraster-v<version>`, validate,
  commit, push, and open one pull request.

Reject other arguments.

## Prepare or submit

1. Require clean `main`, `HEAD == origin/main`, a Version Plan, stable exact
   SemVer, and no conflicting open release pull request.
2. Confirm npm Trusted Publishers for `nanoraster` and all three platform
   packages point to `taucad/nanoraster` and `.github/workflows/ci.yml`. Never
   replace an existing correct binding.
3. Run `pnpm release:prepare -- <version> --dry-run`.
4. For submit, create `release/nanoraster-v<version>`.
5. Run `pnpm release:prepare -- <version>`.
6. Require changes only to `package.json`, `pnpm-lock.yaml`, `CHANGELOG.md`, the
   three `npm/*/package.json` manifests, and consumed
   `.nx/version-plans/*.md` files.
7. Run `pnpm nx run nanoraster:quality`,
   `pnpm nx run nanoraster:docs-prose`, and `git diff --check`. The dry-run
   proves the Version Plan before generation; the release policy validates
   that the generated commit consumes it.
8. For submit, commit exactly `chore(release): nanoraster v<version>`, push,
   and open a pull request describing the fixed package group, version, plan,
   and validations.

## Boundaries

- Never run `npm publish`, create tags or releases, add `NPM_TOKEN`, or change
  repository or registry settings.
- Never mix source changes into a release pull request.
- Never publish from a feature branch or force-push `main`.
- Never edit generated changelog text without reconciling the Version Plan.
- Stop before submission if any package name is unavailable or any trusted
  publisher binding is missing; registry ownership is an operator action.
