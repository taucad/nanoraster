import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { demoControls, isMaterialKey, readDemoOptions, toRequestOptions } from './lib/demo-options';
import { llmStringifyMdx } from './lib/llm-stringify-mdx';

const docsDir = resolve(import.meta.dirname, 'content/docs');
const pagePaths = globSync('**/*.mdx', { cwd: docsDir });
const pages = pagePaths.map((path) => ({
  path,
  source: readFileSync(resolve(docsDir, path), 'utf8'),
}));

/** Every fenced example wrapped by a `<RenderDemo>`, with its page. */
const demos = pages.flatMap(({ path, source }) =>
  [...source.matchAll(/<RenderDemo>\s*```(\w+)\n([\s\S]*?)```\s*<\/RenderDemo>/gu)].map((match) => ({
    path,
    lang: match[1],
    code: match[2],
  })),
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

  it('keeps material factors out of the render request', () => {
    // A material key reaching the options JSON is rejected by the renderer as
    // an unknown field, which is how this broke the camera and framing demos.
    for (const { path, code } of demos) {
      const seeded = readDemoOptions(code);
      const optionKeys = Object.keys(seeded).filter((key) => !isMaterialKey(key));

      for (const key of optionKeys) {
        expect(isMaterialKey(key), `${path} sends ${key} as an option`).toBe(false);
      }

      // Only the material page's example carries material factors at all.
      const materialKeys = Object.keys(seeded).filter((key) => isMaterialKey(key));
      if (materialKeys.length > 0) {
        expect(path, 'material factors outside the material page').toContain('material-model');
      }
    }
  });

  it('expands every lighting choice into a rig the renderer would accept', () => {
    const control = demoControls("lighting: 'studio'").find(({ key }) => key === 'lighting');
    expect(control?.kind).toBe('choice');
    const choices = control?.kind === 'choice' ? control.choices : [];
    expect(choices).toContain('studio');

    for (const choice of choices) {
      const { lighting } = toRequestOptions({ lighting: choice });
      if (choice === 'studio') {
        expect(lighting).toBe('studio');
        continue;
      }

      // Mirrors renderImageMaxLights and renderImageLightColorRange, so a
      // control can never produce a rig the validator rejects.
      const rig = lighting as { lights: readonly { direction: number[]; color: number[] }[] };
      expect(rig.lights.length, choice).toBeLessThanOrEqual(8);
      for (const { direction, color } of rig.lights) {
        expect(direction, choice).toHaveLength(3);
        expect(Math.hypot(...direction), choice).toBeGreaterThan(0);
        expect(color, choice).toHaveLength(3);
        for (const channel of color) expect(channel).toBeGreaterThanOrEqual(0);
        for (const channel of color) expect(channel).toBeLessThanOrEqual(32);
      }
    }
  });

  it('drops material factors from the request and passes everything else through', () => {
    expect(toRequestOptions({ phi: 30, metallicFactor: 1, lighting: 'environment-only' })).toEqual({
      phi: 30,
      lighting: { lights: [] },
    });
  });

  it('seeds nothing the example does not set', () => {
    for (const { path, code } of demos) {
      const seeded = readDemoOptions(code);
      for (const key of Object.keys(seeded)) {
        expect(code, `${path} seeds ${key} without mentioning it`).toContain(key);
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
