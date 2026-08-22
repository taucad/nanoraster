# Maintainer Guide

## Pull requests

Require `ci-gate`, a Version Plan for shipped changes, and reviewable admission
edits for byte or timing regressions. Zero approvals is the solo-maintainer
ruleset; revisit it when a second maintainer joins.

## Release

Version Plans drive releases. `release-pr.yml` maintains a standing release
pull request on `release/next`: every push to `main` with pending plans
regenerates the release commit through `release:prepare --from-plans` and
force-updates the pull request; with none pending it closes the pull request.
Review the standing pull request and merge it — that is the entire release
act. Prefer a squash merge with the title unchanged.

GitHub Actions owns npm OIDC publication, provenance, registry verification,
tags, GitHub Releases, and Vercel deployment. Do not publish from a
workstation, push to `release/next`, or enable auto-merge on the release pull
request.

One root version materializes seventeen registry packages: `nanoraster` and the
sixteen generated platform packages. The release job publishes the platform
packages first and the root last, from a frozen prepared tree it never rebuilds.

Manual fallback when the bot is broken: on a fresh branch off `main`, run
`pnpm release:prepare -- <version> --dry-run` and then the real run, commit
only generated release files as `chore(release): nanoraster v<version>`, and
open the pull request yourself.

## Registry administration

All seventeen packages carry one npm Trusted Publisher binding: repository
`taucad/nanoraster`, workflow `ci.yml`, publish allowed, no GitHub environment.
Merging the release pull request is the release act, and adding an environment
to the claim would mean revoking and recreating all seventeen bindings. Audit
them with `npm trust list <package> --json` (npm 11.15.0 or newer, account 2FA
enabled) and never replace a binding that is already correct.

Each of the seventeen also has "Require two-factor authentication and disallow
tokens" set under Publishing access on npmjs.com. That is a site setting rather
than a CLI one, and OIDC publication keeps working under it.

Reserving a new platform package name is an operator act, done once per name:
publish a reviewed manifest-only `0.0.0` tarball under the `bootstrap` tag, then
bind its trusted publisher. Placeholders never enter git, never carry a binary,
and never take the `latest` tag.

## Release recovery

npm publication is not transactional and npm's publish-time scan can hide a new
version from `npm view` for several minutes, during which `npm deprecate` and
`npm unpublish` do not work either. Re-running the publish job of the same
workflow run resumes a partial publication: the prepared-release archive is
retained for 30 days on release runs, and platform packages already on the
registry are skipped.

Never rebuild or amend a version that is part-published. If the root package
went out while a platform package is missing or wrong, wait for the registry to
serve the version, deprecate that root version, and release a patch carrying a
complete matching set.

## Repository operations

Repository rules, secret scanning, push protection, and private vulnerability
reporting are managed through the `cloud-infra` stack.
