---
nanoraster: minor
---

Never refuse a section cap. A source that does not certify as closed manifold shells (an open surface, a crack, a non-manifold edge or vertex, a sliver triangle) is sliced directly: every closed loop is filled and every open chain is outlined in `#DD003F`. Timed calls report each cut source's loop and chain counts in `timings.sections`, and cap construction no longer certifies sources that no plane reaches.
