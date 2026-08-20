---
nanoraster: patch
---

Maintain the release pull request automatically: `release-pr.yml` regenerates `release/next` from pending Version Plans on every push to `main`, and `release:prepare` gains a `--from-plans` mode that derives the version the plans dictate.
