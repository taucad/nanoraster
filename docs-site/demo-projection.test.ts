import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { demoControls, readDemoOptions } from './lib/demo-options';
import { llmStringifyMdx } from './lib/llm-stringify-mdx';

const docsDir = resolve(import.meta.dirname, 'content/docs');
const pagePaths = globSync('**/*.mdx', { cwd: docsDir });
const pages = pagePaths.map((path) => ({
  path,
  source: readFileSync(resolve(docsDir, path), 'utf8'),
}));

/** Every fenced example wrapped by a `<RenderDemo>`, with its page. */
const demos = pages.flatMap(({ path, source }) =>
  [...source.matchAll(/<RenderDemo>\s*```(\w+)\n([\s\S]*?)```\s*<\/RenderDemo>/gu)].map(
    (match) => ({ path, lang: match[1], code: match[2] }),
  ),
);

describe('interactive demo projections', () => {
  it('wraps at least one example', () => {
    expect(demos.length).toBeGreaterThan(0);
  });

  it('serialises every demo back to the example it wraps', () => {
    for (const { code, lang } of demos) {
      const output = llmStringifyMdx({
        type: 'mdxJsxFlowElement',
        name: 'RenderDemo',
        attributes: [
          { type: 'mdxJsxAttribute', name: 'code', value: code },
          { type: 'mdxJsxAttribute', name: 'lang', value: lang },
        ],
      });

      // The agent projection must carry the example verbatim, not a summary.
      expect(output).toBe(`\`\`\`${lang}\n${code}\n\`\`\``);
    }
  });

  it('seeds every control from a value the example actually sets', () => {
    for (const { path, code } of demos) {
      const options = readDemoOptions(code);
      const controls = demoControls(code);

      expect(controls.length, `${path} offers no controls`).toBeGreaterThan(0);
      for (const { key } of controls) {
        expect(options[key], `${path} ${key}`).toBeDefined();
      }
    }
  });

  it('keeps every seeded value inside the control it drives', () => {
    for (const { path, code } of demos) {
      const options = readDemoOptions(code);

      for (const control of demoControls(code)) {
        const value = options[control.key];
        if (control.kind === 'colour') {
          expect(Array.isArray(value), `${path} ${control.key}`).toBe(true);
        } else if (control.kind === 'range') {
          expect(typeof value, `${path} ${control.key}`).toBe('number');
          expect(value as number).toBeGreaterThanOrEqual(control.min);
          expect(value as number).toBeLessThanOrEqual(control.max);
        } else if (control.kind === 'choice') {
          expect(control.choices, `${path} ${control.key}`).toContain(value);
        } else {
          expect(typeof value, `${path} ${control.key}`).toBe('boolean');
        }
      }
    }
  });

  it('renders mermaid diagrams back to their fences', () => {
    const charts = pages.flatMap(({ source }) =>
      [...source.matchAll(/```mermaid\n([\s\S]*?)```/gu)].map((match) => match[1]),
    );
    expect(charts.length).toBeGreaterThan(0);

    for (const chart of charts) {
      const output = llmStringifyMdx({
        type: 'mdxJsxFlowElement',
        name: 'Mermaid',
        attributes: [{ type: 'mdxJsxAttribute', name: 'chart', value: chart }],
      });
      expect(output).toBe(`\`\`\`mermaid\n${chart}\n\`\`\``);
    }
  });
});
