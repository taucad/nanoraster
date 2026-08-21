import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareBenchmark } from '../scripts/compare-benchmark.mjs';

const base = {
  name: 'gear-v1',
  medianMs: 100,
  outputBytes: 10,
  outputFnv: 'abc',
  codecConformance: { base: { png: { fnv: 'def' } } },
};

describe('benchmark admission', () => {
  it('allows noise through 10% and rejects larger timing regressions', () => {
    assert.equal(compareBenchmark({ ...base, medianMs: 110 }, base).failed, false);
    assert.equal(compareBenchmark({ ...base, medianMs: 110.001 }, base).failed, true);
  });

  it('rejects byte drift even when timing improves', () => {
    assert.equal(compareBenchmark({ ...base, medianMs: 50, outputFnv: 'changed' }, base).failed, true);
    const codecConformance = { base: { png: { fnv: 'changed' } } };
    assert.equal(compareBenchmark({ ...base, medianMs: 50, codecConformance }, base).failed, true);
  });

  it('treats a renamed benchmark as explicit admission', () => {
    assert.equal(compareBenchmark({ ...base, name: 'gear-v2' }, base).failed, false);
  });
});
