import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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

/**
 * Re-mint one package's DSSE payload after mutating the decoded statement, so a
 * rejection case exercises the same base64 decode path the verifier runs.
 */
const auditWithStatement = (name, mutate) => {
  const audit = structuredClone(auditFor(expectedNames));
  const [bundle] = audit.verified.find((entry) => entry.name === name).attestationBundles;
  const statement = JSON.parse(Buffer.from(bundle.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  mutate(statement);
  bundle.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
  return audit;
};

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

  it('should reject provenance minted by another repository, workflow, branch, or builder', () => {
    const forgeries = [
      [
        'nanoraster',
        (statement) => {
          statement.predicate.buildDefinition.externalParameters.workflow.repository =
            'https://github.com/attacker/nanoraster';
        },
        'nanoraster has the wrong source repository',
      ],
      [
        'nanoraster-linux-x64-gnu',
        (statement) => {
          statement.predicate.buildDefinition.externalParameters.workflow.path =
            '.github/workflows/attacker.yml';
        },
        'nanoraster-linux-x64-gnu has the wrong source workflow',
      ],
      [
        'nanoraster-darwin-arm64',
        (statement) => {
          statement.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/attacker';
        },
        'nanoraster-darwin-arm64 was not built from main',
      ],
      [
        'nanoraster-win32-x64-msvc',
        (statement) => {
          statement.predicate.runDetails.builder.id = 'https://github.com/actions/runner/self-hosted';
        },
        'nanoraster-win32-x64-msvc used the wrong builder',
      ],
      [
        'nanoraster-freebsd-x64',
        (statement) => {
          statement.predicate.buildDefinition.buildType = 'https://example.invalid/buildtype/v1';
        },
        'nanoraster-freebsd-x64 has the wrong build type',
      ],
    ];

    for (const [name, mutate, message] of forgeries) {
      assert.throws(
        () => verifyReleaseAttestations({ ...options, audit: auditWithStatement(name, mutate) }),
        { message, name: 'Error' },
        message,
      );
    }
  });

  it('should verify from a checkout that installed no dependencies', () => {
    // `registry-verify` checks the repository out, downloads the frozen
    // tarballs and runs this script against the registry: it builds nothing, so
    // it installs nothing. Copying the scripts and the manifest somewhere with
    // no `node_modules` above them reproduces that resolution exactly, and any
    // dependency anywhere in the module graph fails with ERR_MODULE_NOT_FOUND.
    const root = fileURLToPath(new URL('..', import.meta.url));
    // The script runs its command line only when `process.argv[1]` matches its
    // own resolved URL, and macOS hands out temporary paths behind a symlink.
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'nanoraster-verifier-')));
    try {
      cpSync(join(root, 'scripts'), join(work, 'scripts'), { recursive: true });
      cpSync(join(root, 'package.json'), join(work, 'package.json'));
      writeFileSync(join(work, 'audit.json'), JSON.stringify(options.audit));
      writeFileSync(join(work, 'tarballs.json'), JSON.stringify(options.tarballs));

      const output = execFileSync(
        process.execPath,
        [
          join(work, 'scripts', 'verify-release-attestations.mjs'),
          join(work, 'audit.json'),
          join(work, 'tarballs.json'),
          commit,
          runId,
        ],
        { cwd: work, encoding: 'utf8' },
      );
      assert.equal(output.trim(), 'release provenance matches taucad/nanoraster ci.yml');
    } finally {
      rmSync(work, { force: true, recursive: true });
    }
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
