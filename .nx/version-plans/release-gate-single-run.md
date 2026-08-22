---
nanoraster: patch
---

Gate a release on one quality run over the committed tree. `release:prepare` runs the gate itself instead of handing it to nx as `preVersionCommand`, which nx executes on every `releaseVersion` call — twice per preparation, the second time over a tree the first has already regenerated — and runs with piped stdio, reporting only the child's stderr, so a gate that reports findings on stdout failed the release with nothing printed. The two targets that scan the whole tree, `check:dead-code` and `format`, now wait for `build` rather than reading files while it rewrites them.
