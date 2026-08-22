import { globSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_PROSE_WORDS, countWords } from './tools/eslint-plugin/prose-rules.js';

const ROOT = resolve(import.meta.dirname);
// Generated output is excluded for the same reason Vale's `git ls-files` never
// sees it: the exported site republishes every page as Markdown, so a docs
// build would otherwise double the corpus and lint a stale copy of prose the
// source has already fixed. The list mirrors `eslint.config.mjs`.
const EXCLUDED_DIRECTORIES = [
  '.nx',
  'coverage',
  'dist',
  'docs-site/.next',
  'docs-site/.source',
  'docs-site/out',
  'node_modules',
  'rust/target',
  'rust/vendor',
  'tests/out',
];
const DOCUMENTS = globSync('**/*.{md,mdx}', {
  cwd: ROOT,
  // A predicate rather than a pattern list: the `exclude` array form needs a
  // newer Node than the 22.13.0 floor, and the predicate prunes these
  // directories instead of merely filtering their files.
  exclude: (entry: string) => {
    const path = entry.replaceAll('\\', '/');
    return EXCLUDED_DIRECTORIES.some((directory) => path === directory || path.startsWith(`${directory}/`));
  },
})
  // Route segments such as `docs-site/app/docs.mdx/` are directories, not documents.
  .filter((path) => statSync(resolve(ROOT, path)).isFile())
  .sort();

// `nx release` copies each pending Version Plan into `CHANGELOG.md` verbatim,
// so a plan's prose is release prose and belongs under the same ceiling. Two
// things hid the plans from the scan above: `**` never descends into a dotted
// directory, and `.nx` is excluded outright. Naming the directory literally
// re-admits the plans without re-admitting the nx cache beside them.
const VERSION_PLANS = globSync('.nx/version-plans/*.md', { cwd: ROOT }).sort();

// The changelog renderer prefixes a plan's first paragraph with `- ` and
// appends the reference for the commit that added the plan, so that paragraph
// has less room than the ceiling alone suggests. The cost is counted from
// rendered references rather than assumed: the bullet marker is punctuation
// and counts for nothing, and both reference shapes cost the same eight words
// — `#40`, `https`, `github`, `com`, `taucad`, `nanoraster`, `pull`, `40`
// against a short SHA, `https`, `github`, `com`, `taucad`, `nanoraster`,
// `commit`, and that SHA again. Later paragraphs render as indented
// continuation blocks and carry no reference.
const PULL_REQUEST_REFERENCE = '([#40](https://github.com/taucad/nanoraster/pull/40))';
const COMMIT_REFERENCE = '([a39d388](https://github.com/taucad/nanoraster/commit/a39d388))';
const RENDERED_REFERENCE_WORDS = countWords(PULL_REQUEST_REFERENCE);

// Blanked rather than dropped so reported line numbers still point at the file.
const withoutFrontMatter = (markdown: string): string =>
  markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, (matched) => matched.replaceAll(/[^\n]/gu, ''));

const SCANNED = [
  ...DOCUMENTS.map((path) => ({ path, isVersionPlan: false })),
  ...VERSION_PLANS.map((path) => ({ path, isVersionPlan: true })),
];

type Block = { readonly line: number; readonly text: string };

const proseBlocks = (markdown: string): Block[] => {
  const blocks: Block[] = [];
  let current: string[] = [];
  let fenced = false;
  let start = 0;
  const flush = (): void => {
    const text = current.join(' ').trim();
    if (text) blocks.push({ line: start + 1, text });
    current = [];
  };

  for (const [index, raw] of markdown.split(/\r?\n/u).entries()) {
    const line = raw.replace(/^\s*>\s?/u, '');
    if (/^\s*(?:`{3,}|~{3,})/u.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^\s*(?:\||<|#)/u.test(line) || line.trim() === '') {
      flush();
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s/u.test(line)) flush();
    if (current.length === 0) start = index;
    current.push(line.trim());
  }
  flush();
  return blocks;
};

describe('prose quality', () => {
  it('should inspect repository prose', () => {
    expect(DOCUMENTS).not.toEqual([]);
  });

  it('should ignore both Markdown fence syntaxes', () => {
    expect(proseBlocks('```ts\nconst backtick = true;\n```\n~~~ts\nconst tilde = true;\n~~~')).toEqual([]);
  });

  it('should charge a Version Plan for the reference the changelog appends', () => {
    const paragraph = 'Add a persistent renderer.';
    expect(countWords(`- ${paragraph} ${PULL_REQUEST_REFERENCE}`)).toBe(
      countWords(paragraph) + RENDERED_REFERENCE_WORDS,
    );
    expect(countWords(COMMIT_REFERENCE)).toBe(RENDERED_REFERENCE_WORDS);
  });

  it('should read a Version Plan past its front matter without shifting line numbers', () => {
    expect(
      proseBlocks(withoutFrontMatter('---\nnanoraster: minor\n---\n\nAdd a persistent renderer.')),
    ).toEqual([{ line: 5, text: 'Add a persistent renderer.' }]);
  });

  it.each(SCANNED)('should keep every block in $path within the word ceiling', ({ path, isVersionPlan }) => {
    const markdown = readFileSync(resolve(ROOT, path), 'utf8');
    const overhead = isVersionPlan ? RENDERED_REFERENCE_WORDS : 0;
    const offenders = proseBlocks(isVersionPlan ? withoutFrontMatter(markdown) : markdown)
      .map((block, index) => ({ block, words: countWords(block.text) + (index === 0 ? overhead : 0) }))
      .filter(({ words }) => words > MAX_PROSE_WORDS)
      .map(({ block, words }) => `${path}:${block.line} — ${words} words`);
    expect(offenders).toEqual([]);
  });
});
