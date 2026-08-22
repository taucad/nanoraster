import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const docsDir = resolve(import.meta.dirname, 'content/docs');

/** Whitespace-separated tokens, fences included: the `wc -w` figure the docs budget has always used. */
const countWords = (source: string): number => source.split(/\s+/u).filter(Boolean).length;

// Ceilings only move down. A raise is a reviewed diff that names the feature
// paying for it here; a new page needs a row before it can ship. Measured
// 2026-08-22 after the docs-slimming pass; untouched pages carry their
// measured count plus a little slack.
//
// `install.mdx` and the site ceiling were raised for the sixteen-target native
// matrix: sixteen platform-package rows in place of three, the `node` export
// condition and server-bundler externalization, and cross-platform installs
// through `supportedArchitectures`.
const pageCeilings: Readonly<Record<string, number>> = {
  'api.mdx': 2_320,
  'guides/format-and-annotate.mdx': 750,
  'guides/frame-the-model.mdx': 620,
  'guides/handle-render-failures.mdx': 560,
  'guides/light-the-subject.mdx': 650,
  'guides/render-for-llms.mdx': 500,
  'guides/render-in-the-browser.mdx': 660,
  'guides/render-multiple-views.mdx': 660,
  'guides/reuse-the-renderer.mdx': 650,
  'guides/work-with-raw-pixels.mdx': 700,
  'how-it-works.mdx': 1_150,
  'index.mdx': 330,
  'install.mdx': 740,
  'tutorial.mdx': 600,
};
const siteCeiling = 10_700;

const pages = globSync('**/*.mdx', { cwd: docsDir })
  .toSorted()
  .map((path) => ({ path, words: countWords(readFileSync(resolve(docsDir, path), 'utf8')) }));

describe('docs word budget', () => {
  it('lists a ceiling for every page and no page that does not exist', () => {
    expect(pages.map(({ path }) => path)).toEqual(Object.keys(pageCeilings).toSorted());
  });

  it.each(pages)('keeps $path within its ceiling', ({ path, words }) => {
    expect(words).toBeLessThanOrEqual(pageCeilings[path] ?? 0);
  });

  it('keeps the site within its ceiling', () => {
    expect(pages.reduce((sum, { words }) => sum + words, 0)).toBeLessThanOrEqual(siteCeiling);
  });
});
