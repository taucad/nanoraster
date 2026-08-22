import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectPlatformPackages,
  formatCauseChain,
  requireNativeSuffix,
  resolveExpectedRenderFault,
  resolveSmokeMode,
  selectTarballs,
  settleRenderOutcome,
} from '../scripts/test-package.mjs';

const frozen = {
  version: '1.2.3',
  packages: {
    nanoraster: { filename: 'nanoraster-1.2.3.tgz', integrity: 'sha512-root', version: '1.2.3' },
    'nanoraster-example-arch': {
      filename: 'nanoraster-example-arch-1.2.3.tgz',
      integrity: 'sha512-platform',
      version: '1.2.3',
    },
  },
};

describe('native suffix', () => {
  it('should return the suffix the caller named', () => {
    assert.equal(requireNativeSuffix({ NANORASTER_NATIVE_SUFFIX: 'example-arch' }), 'example-arch');
  });

  it('should reject an unset suffix', () => {
    assert.throws(() => requireNativeSuffix({}), {
      name: 'Error',
      message: /NANORASTER_NATIVE_SUFFIX/u,
    });
  });

  it('should reject an empty suffix', () => {
    assert.throws(() => requireNativeSuffix({ NANORASTER_NATIVE_SUFFIX: '' }), {
      message: /NANORASTER_NATIVE_SUFFIX/u,
    });
  });

  it('should reject a suffix that cannot name a platform package', () => {
    assert.throws(() => requireNativeSuffix({ NANORASTER_NATIVE_SUFFIX: 'Example Arch' }), {
      message: /not a platform suffix: Example Arch/u,
    });
  });
});

describe('smoke mode', () => {
  it('should select tarball mode when a tarball directory is named', () => {
    assert.deepEqual(resolveSmokeMode({ NANORASTER_TARBALL_DIR: 'tarballs' }), {
      kind: 'tarball',
      directory: 'tarballs',
    });
  });

  it('should select registry mode when a published version is named', () => {
    assert.deepEqual(resolveSmokeMode({ NANORASTER_REGISTRY_VERSION: '1.2.3' }), {
      kind: 'registry',
      version: '1.2.3',
    });
  });

  it('should reject a run that names neither input', () => {
    assert.throws(() => resolveSmokeMode({}), {
      message: /exactly one of NANORASTER_TARBALL_DIR .+ or NANORASTER_REGISTRY_VERSION/u,
    });
  });

  it('should reject a run that names both inputs', () => {
    assert.throws(
      () => resolveSmokeMode({ NANORASTER_TARBALL_DIR: 'tarballs', NANORASTER_REGISTRY_VERSION: '1.2.3' }),
      { message: /exactly one of NANORASTER_TARBALL_DIR .+ or NANORASTER_REGISTRY_VERSION/u },
    );
  });
});

describe('frozen tarball selection', () => {
  it('should select the root and platform tarballs recorded for the named suffix', () => {
    assert.deepEqual(selectTarballs(frozen, 'example-arch'), {
      platformName: 'nanoraster-example-arch',
      platformTarball: 'nanoraster-example-arch-1.2.3.tgz',
      rootTarball: 'nanoraster-1.2.3.tgz',
      version: '1.2.3',
    });
  });

  it('should reject a manifest with no entry for the named suffix', () => {
    assert.throws(() => selectTarballs(frozen, 'other-arch'), {
      message: /no tarball for nanoraster-other-arch/u,
    });
  });

  it('should reject a platform tarball packed at another version', () => {
    const drifted = {
      ...frozen,
      packages: {
        ...frozen.packages,
        'nanoraster-example-arch': { ...frozen.packages['nanoraster-example-arch'], version: '1.2.4' },
      },
    };
    assert.throws(() => selectTarballs(drifted, 'example-arch'), {
      message: /nanoraster-example-arch is packed at 1\.2\.4, expected 1\.2\.3/u,
    });
  });

  it('should reject an entry with no filename', () => {
    const nameless = {
      ...frozen,
      packages: { ...frozen.packages, nanoraster: { integrity: 'sha512-root', version: '1.2.3' } },
    };
    assert.throws(() => selectTarballs(nameless, 'example-arch'), {
      message: /nanoraster records no tarball filename/u,
    });
  });

  it('should reject a manifest with no version', () => {
    assert.throws(() => selectTarballs({ packages: frozen.packages }, 'example-arch'), {
      message: /records no version/u,
    });
  });

  it('should reject a manifest with no packages', () => {
    assert.throws(() => selectTarballs({ version: '1.2.3' }, 'example-arch'), {
      message: /records no packages/u,
    });
  });
});

describe('installed platform packages', () => {
  const configured = ['nanoraster', 'nanoraster-first-arch', 'nanoraster-second-arch'];

  it('should return every installed platform package in sorted order', () => {
    assert.deepEqual(
      detectPlatformPackages(
        ['nanoraster-second-arch', '.package-lock.json', 'nanoraster-first-arch'],
        configured,
      ),
      ['nanoraster-first-arch', 'nanoraster-second-arch'],
    );
  });

  it('should ignore the root package and unrelated dependencies', () => {
    assert.deepEqual(detectPlatformPackages(['nanoraster', '.bin'], configured), []);
  });

  it('should ignore an installed dependency that only shares the root prefix', () => {
    // `nanoraster-adjacent-tool` reads like a platform package and is not one:
    // counting it would report two platform packages and fail a clean smoke.
    assert.deepEqual(
      detectPlatformPackages(['nanoraster-adjacent-tool', 'nanoraster-first-arch'], configured),
      ['nanoraster-first-arch'],
    );
  });

  it('should return no platform package when the release configures none', () => {
    assert.deepEqual(detectPlatformPackages(['nanoraster-first-arch'], ['nanoraster']), []);
  });
});

describe('expected render fault', () => {
  const reason = 'the driver faults on this host';

  it('should read the reason the row named', () => {
    assert.equal(resolveExpectedRenderFault({ NANORASTER_SMOKE_EXPECT_RENDER_FAULT: ` ${reason} ` }), reason);
  });

  it('should expect no fault when the row names none', () => {
    assert.equal(resolveExpectedRenderFault({}), undefined);
  });

  it('should expect no fault when the row names a blank reason', () => {
    assert.equal(resolveExpectedRenderFault({ NANORASTER_SMOKE_EXPECT_RENDER_FAULT: '  ' }), undefined);
  });

  it('should report the exit status and signal of an expected fault', () => {
    assert.equal(
      settleRenderOutcome(reason, { status: null, signal: 'SIGSEGV' }),
      `expected render fault (${reason}): child exit status=null signal=SIGSEGV`,
    );
  });

  it('should demand the expectation be lifted once the render succeeds', () => {
    assert.throws(() => settleRenderOutcome(reason, undefined), {
      message: new RegExp(`render succeeded .+\\(${reason}\\).+NANORASTER_SMOKE_EXPECT_RENDER_FAULT`, 'su'),
    });
  });

  it('should rethrow a fault no row expected', () => {
    const failure = new Error('the consumer died');

    assert.throws(() => settleRenderOutcome(undefined, failure), failure);
  });

  it('should report nothing when an unexpecting row rendered', () => {
    assert.equal(settleRenderOutcome(undefined, undefined), undefined);
  });
});

describe('cause chain formatting', () => {
  it('should print the message and stack of every error in the chain', () => {
    const root = new Error('native binding missing');
    const middle = new Error('cannot find native binding', { cause: root });
    const top = new Error('adapter unavailable', { cause: middle });

    const report = formatCauseChain(top);

    assert.match(report, /^error: adapter unavailable$/mu);
    assert.match(report, /^cause 1: cannot find native binding$/mu);
    assert.match(report, /^cause 2: native binding missing$/mu);
    assert.ok(report.includes(root.stack), 'the deepest stack is reported');
  });

  it('should print a cause that is not an error', () => {
    const report = formatCauseChain(new Error('adapter unavailable', { cause: 'ENOENT' }));

    assert.match(report, /^cause 1: ENOENT$/mu);
  });

  it('should stop at a cause cycle', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;

    const report = formatCauseChain(second);

    assert.equal(report.match(/^cause \d+: /gmu)?.length, 1);
    assert.match(report, /^cause 1: first$/mu);
  });

  it('should print a thrown value that is not an error', () => {
    assert.match(formatCauseChain('exploded'), /^error: exploded$/mu);
  });
});
