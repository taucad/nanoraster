---
nanoraster: patch
---

Verify every continuous integration artifact download landed before its consumer runs, and retry the download once when it did not, so a silently empty download fails at the boundary that caused it rather than as an unrelated missing-file error minutes later.
