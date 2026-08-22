# Contributing

1. Fork or branch from `main`.
2. Install with `pnpm install --frozen-lockfile`.
3. Add tests that assert the changed public behavior.
4. Run `pnpm nx run nanoraster:quality`.
5. Add a Version Plan with `pnpm nx release plan` when package behavior or
   shipped artifacts change. Pending plans feed an automated release pull
   request; a maintainer merges it to publish.
6. Update a byte budget in the causing pull request when the larger artifact is
   intentional. Explain the measured origin beside the threshold.
7. Rename the gated benchmark when its semantics change; do not overwrite its
   identity to hide a new workload. Build the addon it reads with
   `pnpm run build:napi:bench`: the benchmark surface is behind the default-off
   `bench` cargo feature, so no published artifact carries it.
8. Open a pull request with commands and results.

Only GitHub Actions publishes npm packages, creates tags or releases, and
deploys documentation. Never run `npm publish` from a workstation.
