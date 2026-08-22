import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { waitForRegistry } from '../scripts/registry-wait.mjs';

const tarballs = {
  packages: {
    nanoraster: { filename: 'nanoraster-1.0.0.tgz', integrity: 'sha512-root', version: '1.0.0' },
    'nanoraster-darwin-arm64': {
      filename: 'nanoraster-darwin-arm64-1.0.0.tgz',
      integrity: 'sha512-darwin',
      version: '1.0.0',
    },
  },
  version: '1.0.0',
};

const published = (integrity) => ({
  dist: { attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations' }, integrity },
});

const harness = ({ view }) => {
  const logged = [];
  const sleeps = [];
  let clock = 0;
  return {
    logged,
    options: {
      log: (message) => logged.push(message),
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      tarballs,
      view,
    },
    sleeps,
  };
};

describe('bounded registry visibility wait', () => {
  it('should resolve once every package serves an integrity and an attestation', async () => {
    let attempt = 0;
    const { logged, options, sleeps } = harness({
      view: (name) => {
        attempt += 1;
        if (attempt < 4) return null;
        return published(name === 'nanoraster' ? 'sha512-root' : 'sha512-darwin');
      },
    });

    await waitForRegistry(options);

    assert.deepEqual(sleeps, [30_000, 30_000]);
    assert.equal(logged.at(-1), 'all 2 packages are visible with matching integrity');
    assert.match(logged[0], /^attempt 1 after 0s: 0\/2 packages available$/u);
  });

  it('should stop polling a package that is already visible', async () => {
    const seen = [];
    const { options } = harness({
      view: (name) => {
        seen.push(name);
        if (name === 'nanoraster') return published('sha512-root');
        return seen.filter((entry) => entry === name).length > 1 ? published('sha512-darwin') : null;
      },
    });

    await waitForRegistry(options);

    assert.deepEqual(seen, ['nanoraster', 'nanoraster-darwin-arm64', 'nanoraster-darwin-arm64']);
  });

  it('should reject when the registry serves a different integrity than the packed tarball', async () => {
    const { options } = harness({ view: () => published('sha512-tampered') });

    await assert.rejects(waitForRegistry(options), (error) => {
      assert.equal(error.name, 'Error');
      assert.equal(
        error.message,
        'nanoraster@1.0.0: registry integrity sha512-tampered differs from the packed sha512-root',
      );
      return true;
    });
  });

  it('should reject on timeout, naming every package that never became visible', async () => {
    const { options, sleeps } = harness({
      view: (name) => (name === 'nanoraster' ? published('sha512-root') : null),
    });

    await assert.rejects(
      waitForRegistry(options),
      /timed out after 30 minutes; unavailable: nanoraster-darwin-arm64 \(not published\)/u,
    );
    assert.equal(sleeps.length, 60);
    assert.deepEqual(new Set(sleeps), new Set([30_000]));
  });

  it('should keep waiting for a published package whose attestations are missing', async () => {
    const { options } = harness({
      view: (name) =>
        name === 'nanoraster' ? published('sha512-root') : { dist: { integrity: 'sha512-darwin' } },
    });

    await assert.rejects(
      waitForRegistry(options),
      /unavailable: nanoraster-darwin-arm64 \(no attestations\)/u,
    );
  });

  it('should honour a shortened interval and timeout', async () => {
    const { options, sleeps } = harness({ view: () => null });

    await assert.rejects(
      waitForRegistry({ ...options, intervalMs: 5_000, timeoutMs: 20_000 }),
      /timed out after 0\.3 minutes/u,
    );
    assert.deepEqual(sleeps, [5_000, 5_000, 5_000, 5_000]);
  });
});
