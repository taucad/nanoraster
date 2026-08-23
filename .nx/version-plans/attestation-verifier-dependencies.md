---
nanoraster: patch
---

Derive the platform-package contract from `package.json.napi` without importing the NAPI-RS CLI. The job that verifies published provenance checks the repository out and reads the registry, so it installs nothing, and the development dependency behind the target parser left it unable to load the verifier at all. The derivation is held to the CLI's own parser by a unit test, and to the generated `npm/` tree by the assembly check that compares them.
