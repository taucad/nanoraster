import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readNapiTargets } from '../scripts/lib/napi-targets.mjs';
import { verifyReleaseAttestations } from '../scripts/verify-release-attestations.mjs';

const { manifest, packages } = readNapiTargets(new URL('../package.json', import.meta.url));
const expectedNames = [manifest.name, ...packages.map(({ name }) => name)];
const version = '0.1.0';
const commit = 'a'.repeat(40);
const runId = '123';

const byText = (left, right) => Number(left > right) - Number(left < right);
const integrityOf = (name) => `sha512-${Buffer.from(name).toString('base64')}`;

const statementFor = (name, attempt = 1) => ({
  predicate: {
    buildDefinition: {
      buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: {
        workflow: {
          path: '.github/workflows/ci.yml',
          ref: 'refs/heads/main',
          repository: 'https://github.com/taucad/nanoraster',
        },
      },
      resolvedDependencies: [
        {
          digest: { gitCommit: commit },
          uri: 'git+https://github.com/taucad/nanoraster@refs/heads/main',
        },
      ],
    },
    runDetails: {
      builder: { id: 'https://github.com/actions/runner/github-hosted' },
      metadata: {
        invocationId: `https://github.com/taucad/nanoraster/actions/runs/${runId}/attempts/${attempt}`,
      },
    },
  },
  subject: [
    {
      digest: { sha512: Buffer.from(name).toString('hex') },
      name: `pkg:npm/${name}@${version}`,
    },
  ],
});

const verifiedEntry = (name, attempt) => ({
  attestationBundles: [
    {
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(JSON.stringify(statementFor(name, attempt))).toString('base64'),
        },
      },
      predicateType: 'https://slsa.dev/provenance/v1',
    },
  ],
  attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
  name,
  version,
});

const tarballsFor = (names) => ({
  packages: Object.fromEntries(
    [...names]
      .sort(byText)
      .map((name) => [name, { filename: `${name}-${version}.tgz`, integrity: integrityOf(name), version }]),
  ),
  version,
});

const auditFor = (names, attempt) => ({
  invalid: [],
  missing: [],
  verified: names.map((name) => verifiedEntry(name, attempt)),
});

const options = {
  audit: auditFor(expectedNames),
  commit,
  expectedNames,
  runId,
  tarballs: tarballsFor(expectedNames),
};

describe('release attestation verification', () => {
  it('should bind all seventeen packed packages to the repository, workflow, run, commit, and digest', () => {
    assert.equal(Object.keys(options.tarballs.packages).length, 17);
    assert.doesNotThrow(() => verifyReleaseAttestations(options));
    assert.throws(
      () => verifyReleaseAttestations({ ...options, commit: 'b'.repeat(40) }),
      /nanoraster has the wrong source commit/u,
    );
    assert.throws(
      () => verifyReleaseAttestations({ ...options, runId: '456' }),
      /nanoraster has the wrong workflow invocation/u,
    );
  });

  it('should accept any attempt of the publishing run so a partial re-run still verifies', () => {
    assert.doesNotThrow(() => verifyReleaseAttestations({ ...options, audit: auditFor(expectedNames, 3) }));
  });

  it('should reject a packed set that omits a configured target package', () => {
    const names = expectedNames.filter((name) => name !== 'nanoraster-linux-s390x-gnu');
    assert.throws(
      () =>
        verifyReleaseAttestations({
          ...options,
          audit: auditFor(names),
          tarballs: tarballsFor(names),
        }),
      /missing=\[nanoraster-linux-s390x-gnu\] extra=\[\]/u,
    );
  });

  it('should reject a packed set that carries an unconfigured package', () => {
    const names = [...expectedNames, 'nanoraster-linux-riscv64-gnu'];
    assert.throws(
      () =>
        verifyReleaseAttestations({
          ...options,
          audit: auditFor(names),
          tarballs: tarballsFor(names),
        }),
      /missing=\[\] extra=\[nanoraster-linux-riscv64-gnu\]/u,
    );
  });

  it('should reject a packed entry recorded at a different version than the release', () => {
    const tarballs = structuredClone(options.tarballs);
    tarballs.packages['nanoraster-darwin-x64'].version = '0.1.1';
    assert.throws(
      () => verifyReleaseAttestations({ ...options, tarballs }),
      /nanoraster-darwin-x64 is recorded at 0\.1\.1, not the release version 0\.1\.0/u,
    );
  });

  it('should reject a package whose registry digest differs from the packed integrity', () => {
    const tarballs = structuredClone(options.tarballs);
    tarballs.packages['nanoraster-win32-arm64-msvc'].integrity = integrityOf('tampered');
    assert.throws(
      () => verifyReleaseAttestations({ ...options, tarballs }),
      /nanoraster-win32-arm64-msvc digest differs/u,
    );
  });

  it('should reject an audit that reports an unverified or missing signature', () => {
    assert.throws(
      () =>
        verifyReleaseAttestations({
          ...options,
          audit: { ...options.audit, invalid: [{ name: 'nanoraster' }] },
        }),
      /npm reported invalid signatures/u,
    );
    assert.throws(
      () =>
        verifyReleaseAttestations({
          ...options,
          audit: { ...options.audit, missing: [{ name: 'nanoraster-freebsd-x64' }] },
        }),
      /npm reported missing signatures/u,
    );
  });

  it('should reject a package npm never verified', () => {
    const audit = auditFor(expectedNames.filter((name) => name !== 'nanoraster-android-arm64'));
    assert.throws(
      () => verifyReleaseAttestations({ ...options, audit }),
      /nanoraster-android-arm64@0\.1\.0 has no verified npm signature/u,
    );
  });

  it('should reject a package published without a provenance attestation', () => {
    const audit = structuredClone(options.audit);
    const entry = audit.verified.find(({ name }) => name === 'nanoraster-linux-x64-musl');
    entry.attestations = {};
    assert.throws(
      () => verifyReleaseAttestations({ ...options, audit }),
      /nanoraster-linux-x64-musl lacks provenance/u,
    );
  });
});
