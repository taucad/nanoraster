---
nanoraster: patch
---

The compatibility table no longer holds a row waiting for a promotion its render job already earned. Nine rows read `Pending` although the 0.4.0 release run rendered on each of them, because the legend's promotion rule had no enforcement behind it. A row that stays `Pending` while a release requires the job it cites now fails the compatibility test, so the table cannot lag the release it shipped.
