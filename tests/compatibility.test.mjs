// `compatibility.md` is the support claim consumers read, so every check mark in it has to be
// backed by a CI job that has to pass before a release. This test is that binding: it reads the
// target list out of `package.json`, the rows out of `compatibility.md`, and the job identifiers
// and gate list out of `ci.yml`, and refuses a claim no job proves.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseTriple } from '@napi-rs/cli';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const COMPATIBILITY = read('../compatibility.md');
const WORKFLOW = read('../.github/workflows/ci.yml');
const TARGETS = JSON.parse(read('../package.json')).napi.targets;

/** Platform-package suffixes NAPI-RS derives from the configured target triples. */
const SUFFIXES = TARGETS.map((triple) => parseTriple(triple).platformArchABI);

/** Support markers a row may carry. Anything else is a claim nobody defined. */
const MARKERS = ['✅', 'Pending', 'Experimental'];

/** Every `| … |` row of every table, as trimmed cells, header and separator rows dropped. */
const rows = COMPATIBILITY.split('\n')
  .filter((line) => line.trimStart().startsWith('|'))
  .map((line) =>
    line
      .trim()
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim()),
  )
  .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/u.test(cell)));

/** Host rows carry a support marker in the second-to-last cell; the render profile does not. */
const hostRows = rows
  .filter((cells) => MARKERS.includes(cells.at(-2)))
  .map((cells) => ({ evidence: cells.at(-1), name: cells[0], support: cells.at(-2) }));

/** `` `smoke (linux-x64-musl, 26)` `` → `{ job: 'smoke', parameters: ['linux-x64-musl', '26'] }`. */
const parseEvidence = (cell) => {
  const match = /^`([\w-]+)(?:\s+\(([^)]*)\))?`$/u.exec(cell);
  assert.ok(match, `CI evidence ${cell} is not a single backticked job display name`);
  return {
    job: match[1],
    parameters: match[2] === undefined ? [] : match[2].split(',').map((value) => value.trim()),
  };
};

/** Job identifiers declared at the workflow's job indentation. */
const declaredJobs = new Set([...WORKFLOW.matchAll(/^ {2}([a-z][\w-]*):$/gmu)].map((match) => match[1]));

/**
 * Job identifiers `ci-gate` demands, including the ones it adds only for a release run: a row may
 * claim support on a slow lane that runs at the main/release cadence, but not on an ungated one.
 */
const requiredJobs = new Set(
  [
    ...WORKFLOW.slice(WORKFLOW.indexOf('\n  ci-gate:')).matchAll(
      /required(?:\s*=\s*\[|\.push\()([^\]);]*)/gu,
    ),
  ].flatMap((match) => [...match[1].matchAll(/'([\w-]+)'/gu)].map((name) => name[1])),
);

describe('compatibility matrix', () => {
  it('should carry a row for every configured native target', () => {
    const documented = SUFFIXES.filter((suffix) =>
      hostRows.some(({ name }) => name === `\`nanoraster-${suffix}\``),
    );
    assert.deepEqual(documented, SUFFIXES);
  });

  it('should list only rows a defined support marker describes', () => {
    const undefinedMarkers = rows
      .filter((cells) => cells.at(-1)?.startsWith('`') && !MARKERS.includes(cells.at(-2)))
      .map((cells) => cells.join(' | '));
    assert.deepEqual(undefinedMarkers, []);
  });

  it('should name a declared CI job as the evidence for every row', () => {
    const undeclared = hostRows
      .map(({ evidence, name }) => ({ job: parseEvidence(evidence).job, name }))
      .filter(({ job }) => !declaredJobs.has(job))
      .map(({ job, name }) => `${name} cites ${job}, which .github/workflows/ci.yml does not declare`);
    assert.deepEqual(undeclared, []);
  });

  it('should back every supported host with a release-required CI job', () => {
    const unproven = hostRows
      .filter(({ support }) => support === '✅')
      .map(({ evidence, name }) => ({ evidence: parseEvidence(evidence), name }))
      .filter(({ evidence }) => !requiredJobs.has(evidence.job))
      .map(
        ({ evidence, name }) => `${name} claims support from ${evidence.job}, which ci-gate does not require`,
      );
    assert.deepEqual(unproven, []);
  });

  it('should cite a job parameter the workflow actually configures', () => {
    // A `smoke` claim names one matrix row, so both halves have to belong to
    // the same row: a suffix on one lane and a lane on another suffix are two
    // substrings the workflow contains and one row it never runs.
    const smokeRow = (suffix, lane) =>
      new RegExp(`\\{[^}]*suffix: '${suffix}'[^}]*lane: '${lane}'[^}]*\\}`, 'u').test(WORKFLOW);

    const unconfigured = hostRows.flatMap(({ evidence, name }) => {
      const { job, parameters } = parseEvidence(evidence);
      if (job === 'smoke') {
        const [suffix, lane] = parameters;
        return smokeRow(suffix, lane)
          ? []
          : [`${name} cites smoke (${suffix}, ${lane}), which the ci.yml smoke matrix does not configure`];
      }
      return parameters
        .filter((parameter) => !WORKFLOW.includes(parameter))
        .map((parameter) => `${name} cites job parameter ${parameter}, absent from ci.yml`);
    });
    assert.deepEqual(unconfigured, []);

    // The negative control: the suffix and the lane are each present in the
    // workflow, and the pair is not a row.
    assert.equal(smokeRow('darwin-arm64', '22'), false);
  });

  it('should keep both Android rows on build evidence alone', () => {
    const android = hostRows.filter(({ name }) => name.includes('nanoraster-android-'));
    assert.equal(android.length, 2);
    for (const { evidence, support } of android) {
      assert.equal(support, 'Experimental');
      assert.equal(parseEvidence(evidence).job, 'build');
    }
  });

  it('should record the Node 22 end-of-life horizon the 32-bit rows inherit', () => {
    assert.match(COMPATIBILITY, /2027-04-30/u);
    for (const suffix of ['linux-arm-gnueabihf', 'linux-arm-musleabihf', 'win32-ia32-msvc']) {
      assert.match(COMPATIBILITY, new RegExp(`\`nanoraster-${suffix}\``, 'u'));
    }
  });
});
