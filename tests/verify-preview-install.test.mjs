import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { verifyPreviewInstall } from '../scripts/verify-preview-install.mjs';

const written = [];

const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'nanoraster-preview-consumer-'));
  written.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of written.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('hosted preview consumer', () => {
  it('should install only roots and verify rewritten sibling previews', () => {
    const sha = 'abc1234abc1234abc1234abc1234abc1234abc12';
    const source = temporaryDirectory();
    const root = join(source, '00');
    const native = join(source, '01');
    const metadata = join(source, 'preview.json');
    mkdirSync(root);
    mkdirSync(native);
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'nanoraster', optionalDependencies: { 'nanoraster-linux-x64-gnu': '1.0.0' } })}\n`,
    );
    writeFileSync(join(native, 'package.json'), `${JSON.stringify({ name: 'nanoraster-linux-x64-gnu' })}\n`);
    writeFileSync(
      metadata,
      `${JSON.stringify({
        packages: [
          { name: 'nanoraster', url: `https://pkg.pr.new/nanoraster@${sha}` },
          { name: 'nanoraster-linux-x64-gnu', url: `https://pkg.pr.new/nanoraster-linux-x64-gnu@${sha}` },
        ],
      })}\n`,
    );

    const calls = [];
    const result = verifyPreviewInstall({
      from: source,
      metadata,
      sha,
      install(command, args, options) {
        calls.push([command, args]);
        if (args[0] !== 'install') return;
        const modules = join(options.cwd, 'node_modules');
        mkdirSync(join(modules, 'nanoraster'), { recursive: true });
        mkdirSync(join(modules, 'nanoraster-linux-x64-gnu'), { recursive: true });
        writeFileSync(
          join(modules, 'nanoraster', 'package.json'),
          `${JSON.stringify({
            name: 'nanoraster',
            version: '0.0.0-preview-abc1234',
            optionalDependencies: {
              'nanoraster-linux-x64-gnu': `https://pkg.pr.new/nanoraster-linux-x64-gnu@${sha}`,
            },
          })}\n`,
        );
        writeFileSync(
          join(modules, 'nanoraster-linux-x64-gnu', 'package.json'),
          `${JSON.stringify({ name: 'nanoraster-linux-x64-gnu', version: '0.0.0-preview-abc1234' })}\n`,
        );
      },
    });

    assert.deepEqual(result, { installed: 2, roots: ['nanoraster'] });
    assert.deepEqual(calls[1][1], ['install', '--ignore-scripts', `https://pkg.pr.new/nanoraster@${sha}`]);
  });

  // The 0.5.0 break was a native sibling that still pointed at npm. A preview
  // that leaves one unrewritten must fail here, not in a consumer's install.
  it('should reject a sibling the preview never rewrote', () => {
    const sha = 'abc1234abc1234abc1234abc1234abc1234abc12';
    const source = temporaryDirectory();
    const root = join(source, '00');
    const native = join(source, '01');
    const metadata = join(source, 'preview.json');
    mkdirSync(root);
    mkdirSync(native);
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'nanoraster', optionalDependencies: { 'nanoraster-linux-x64-gnu': '1.0.0' } })}\n`,
    );
    writeFileSync(join(native, 'package.json'), `${JSON.stringify({ name: 'nanoraster-linux-x64-gnu' })}\n`);
    writeFileSync(
      metadata,
      `${JSON.stringify({
        packages: [
          { name: 'nanoraster', url: `https://pkg.pr.new/nanoraster@${sha}` },
          { name: 'nanoraster-linux-x64-gnu', url: `https://pkg.pr.new/nanoraster-linux-x64-gnu@${sha}` },
        ],
      })}\n`,
    );

    assert.throws(
      () =>
        verifyPreviewInstall({
          from: source,
          metadata,
          sha,
          install(command, args, options) {
            if (args[0] !== 'install') return;
            const modules = join(options.cwd, 'node_modules');
            mkdirSync(join(modules, 'nanoraster'), { recursive: true });
            mkdirSync(join(modules, 'nanoraster-linux-x64-gnu'), { recursive: true });
            writeFileSync(
              join(modules, 'nanoraster', 'package.json'),
              `${JSON.stringify({
                name: 'nanoraster',
                version: '0.0.0-preview-abc1234',
                optionalDependencies: { 'nanoraster-linux-x64-gnu': '0.5.1' },
              })}\n`,
            );
            writeFileSync(
              join(modules, 'nanoraster-linux-x64-gnu', 'package.json'),
              `${JSON.stringify({ name: 'nanoraster-linux-x64-gnu', version: '0.0.0-preview-abc1234' })}\n`,
            );
          },
        }),
      /keeps an unpublished optionalDependencies reference to nanoraster-linux-x64-gnu/u,
    );
  });

  it('should reject untrusted or stale metadata before invoking npm', () => {
    const source = temporaryDirectory();
    const root = join(source, '00');
    const metadata = join(source, 'preview.json');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'nanoraster' })}\n`);

    for (const url of ['https://example.com/nanoraster@abc1234', 'https://pkg.pr.new/nanoraster@stale00']) {
      writeFileSync(metadata, `${JSON.stringify({ packages: [{ name: 'nanoraster', url }] })}\n`);
      let installs = 0;
      assert.throws(
        () =>
          verifyPreviewInstall({
            from: source,
            metadata,
            sha: 'abc1234',
            install: () => {
              installs += 1;
            },
          }),
        /untrusted or stale/u,
      );
      assert.equal(installs, 0);
    }
  });
});
