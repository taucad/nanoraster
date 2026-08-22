#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readNapiTargets } from './lib/napi-targets.mjs';

const PROVENANCE_TYPE = 'https://slsa.dev/provenance/v1';
const BUILD_TYPE = 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
const BUILDER_ID = 'https://github.com/actions/runner/github-hosted';
const REPOSITORY = 'https://github.com/taucad/nanoraster';
const WORKFLOW = '.github/workflows/ci.yml';

const byText = (left, right) => Number(left > right) - Number(left < right);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const decodeProvenance = (entry) => {
  const attestation = entry.attestationBundles?.find(
    ({ predicateType }) => predicateType === PROVENANCE_TYPE,
  );
  assert(attestation, `${entry.name}@${entry.version} has no verified provenance attestation`);
  return JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
};

const expectedDigest = (integrity) => {
  assert(integrity.startsWith('sha512-'), `unsupported integrity: ${integrity}`);
  return Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
};

const verifyPackage = ({ audit, packed, commit, runId }) => {
  const entry = audit.verified?.find(
    ({ name, version }) => name === packed.name && version === packed.version,
  );
  assert(entry, `${packed.name}@${packed.version} has no verified npm signature`);
  assert(
    entry.attestations?.provenance?.predicateType === PROVENANCE_TYPE,
    `${packed.name} lacks provenance`,
  );

  const statement = decodeProvenance(entry);
  const subject = statement.subject?.find(({ name }) => name === `pkg:npm/${packed.name}@${packed.version}`);
  assert(subject?.digest?.sha512 === expectedDigest(packed.integrity), `${packed.name} digest differs`);

  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  assert(definition?.buildType === BUILD_TYPE, `${packed.name} has the wrong build type`);
  assert(workflow?.repository === REPOSITORY, `${packed.name} has the wrong source repository`);
  assert(workflow?.path === WORKFLOW, `${packed.name} has the wrong source workflow`);
  assert(workflow?.ref === 'refs/heads/main', `${packed.name} was not built from main`);

  const source = definition.resolvedDependencies?.find(
    ({ uri }) => uri === `git+${REPOSITORY}@refs/heads/main`,
  );
  assert(source?.digest?.gitCommit === commit, `${packed.name} has the wrong source commit`);
  assert(
    statement.predicate?.runDetails?.builder?.id === BUILDER_ID,
    `${packed.name} used the wrong builder`,
  );
  // Any attempt of the publishing run is the same commit, workflow and builder,
  // and a partial re-run of `registry-verify` carries a later attempt number than
  // the one that minted the provenance — so bind to the run, not the attempt.
  assert(
    new RegExp(`^${REPOSITORY}/actions/runs/${runId}/attempts/[1-9]\\d*$`, 'u').test(
      statement.predicate?.runDetails?.metadata?.invocationId ?? '',
    ),
    `${packed.name} has the wrong workflow invocation`,
  );
};

const verifyPackageSet = (tarballs, expectedNames) => {
  const packed = Object.keys(tarballs.packages);
  const expected = new Set(expectedNames);
  const missing = [...expected].filter((name) => !packed.includes(name)).sort(byText);
  const extra = packed.filter((name) => !expected.has(name)).sort(byText);
  assert(
    missing.length === 0 && extra.length === 0,
    `packed set differs from the configured target set; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
  );
  for (const [name, entry] of Object.entries(tarballs.packages)) {
    assert(
      entry.version === tarballs.version,
      `${name} is recorded at ${entry.version}, not the release version ${tarballs.version}`,
    );
  }
};

export const verifyReleaseAttestations = ({ audit, commit, expectedNames, runId, tarballs }) => {
  assert((audit.invalid ?? []).length === 0, 'npm reported invalid signatures');
  assert((audit.missing ?? []).length === 0, 'npm reported missing signatures');
  if (expectedNames) verifyPackageSet(tarballs, expectedNames);
  for (const [name, entry] of Object.entries(tarballs.packages)) {
    verifyPackage({ audit, packed: { name, ...entry }, commit, runId });
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [auditPath, tarballsPath, commit, runId] = process.argv.slice(2);
    assert(auditPath && tarballsPath && commit && runId, 'expected audit, tarballs, commit, run');
    const { manifest, packages } = readNapiTargets(new URL('../package.json', import.meta.url));
    verifyReleaseAttestations({
      audit: JSON.parse(readFileSync(auditPath, 'utf8')),
      commit,
      expectedNames: [manifest.name, ...packages.map(({ name }) => name)],
      runId,
      tarballs: JSON.parse(readFileSync(tarballsPath, 'utf8')),
    });
    process.stdout.write('release provenance matches taucad/nanoraster ci.yml\n');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
