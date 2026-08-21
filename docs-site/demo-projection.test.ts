import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  demoControls,
  isLightingKey,
  isMaterialKey,
  readDemoLabel,
  readDemoLights,
  readDemoOptions,
  readDemoViews,
  substituteDemoValues,
  type DemoControl,
  type DemoValue,
} from './lib/demo-options';
import { angleKeys, buildDemoRequest } from './lib/demo-request';
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

/** A value a control could actually produce, different from the seeded one. */
const perturb = (control: DemoControl, current: DemoValue): DemoValue => {
  if (control.kind === 'range') {
    const next = Number(current) + control.step;
    return next > control.max ? control.min : Number(next.toFixed(2));
  }
  if (control.kind === 'choice') {
    return control.choices.find((choice) => choice !== current) ?? control.choices[0];
  }
  if (control.kind === 'colour') return [0.1, 0.2, 0.3, 1];
  return current !== true;
};

/** A `views: [ … ]` literal, which substitution must leave alone. */
const viewsLiteral = /\bviews\s*:\s*\[[^\]]*\]/u;

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

  it('offers the format control only where the example sets a quality to go with it', () => {
    // Switching format alone changes no pixel, so it is offered where the
    // badge under the image makes the encoder's output visible.
    for (const { path, code } of demos) {
      const keys = demoControls(code).map((control) => control.key);
      expect(keys.includes('format'), `${path} format control`).toBe('quality' in readDemoOptions(code));
    }

    expect(
      demos.some(({ code }) => demoControls(code).some((control) => control.key === 'format')),
      'no wrapped example keeps the format control',
    ).toBe(true);
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
    // The request under test is the one the demo actually sends: the same
    // projection `render-demo.tsx` calls, fed each example's seeded values.
    for (const { path, code } of demos) {
      const seeded = readDemoOptions(code);
      const views = readDemoViews(code);
      const { material, request } = buildDemoRequest(seeded, {
        label: readDemoLabel(code),
        lights: readDemoLights(code),
        size: { height: 720, width: 960 },
        views,
      });

      for (const key of Object.keys(request)) {
        expect(isMaterialKey(key), `${path} sends ${key} as an option`).toBe(false);
        expect(isLightingKey(key), `${path} sends ${key} outside the rig`).toBe(false);
        if (views.length > 0) {
          expect(angleKeys.has(key), `${path} sends ${key} on a batch request`).toBe(false);
        }
      }

      // The factors are routed to the GLB patch rather than dropped.
      for (const key of Object.keys(seeded).filter((seededKey) => isMaterialKey(seededKey))) {
        expect(material[key as keyof typeof material], `${path} drops ${key}`).toBe(seeded[key]);
      }

      // Rig values ride inside `lighting` with the example's lights.
      const lighting = request['lighting'] as Record<string, unknown> | undefined;
      for (const key of Object.keys(seeded).filter((seededKey) => isLightingKey(seededKey))) {
        expect(lighting?.[key], `${path} drops ${key} from the rig`).toBe(seeded[key]);
      }

      // Only the material page's example carries material factors at all.
      if (Object.keys(material).length > 0) {
        expect(path, 'material factors outside the how-it-works page').toContain('how-it-works');
      }
    }
  });

  it('seeds nothing the example does not set', () => {
    for (const { path, code } of demos) {
      const seeded = readDemoOptions(code);
      for (const key of Object.keys(seeded)) {
        expect(code, `${path} seeds ${key} without mentioning it`).toContain(key);
      }
    }
  });

  it('leaves an example alone when the values already match it', () => {
    for (const { path, code } of demos) {
      expect(substituteDemoValues(code, readDemoOptions(code)), path).toBe(code);
    }
  });

  it('reads back every value it writes into an example', () => {
    for (const { path, code } of demos) {
      const seeded = readDemoOptions(code);
      const wanted = Object.fromEntries(
        demoControls(code).map((control) => [control.key, perturb(control, seeded[control.key])]),
      );
      const rewritten = substituteDemoValues(code, wanted);

      // Angles inside a `views: [ … ]` literal belong to one view, not to the
      // shared request, so that span comes through byte-identical.
      expect(viewsLiteral.exec(rewritten)?.[0], path).toBe(viewsLiteral.exec(code)?.[0]);

      const applied = Object.fromEntries(
        Object.entries(wanted).filter(
          ([key, value]) => substituteDemoValues(code, { [key]: value }) !== code,
        ),
      );
      expect(Object.keys(applied).length, `${path} rewrote nothing`).toBeGreaterThan(0);
      expect(readDemoOptions(rewritten), path).toEqual({ ...seeded, ...applied });
    }
  });

  it('reads every declared view out of the example that declares it', () => {
    const sheets = demos.filter(({ code }) => viewsLiteral.test(code));
    expect(sheets.length, 'no wrapped example declares views').toBeGreaterThan(0);

    for (const { path, code } of sheets) {
      const views = readDemoViews(code);
      expect(views.length, `${path} parses no views`).toBeGreaterThan(0);

      for (const view of views) {
        expect(view.id, `${path} view id`).not.toBe('');
        expect(Number.isFinite(view.phi), `${path} ${view.id} phi`).toBe(true);
        expect(Number.isFinite(view.theta), `${path} ${view.id} theta`).toBe(true);
      }

      // Duplicate IDs are rejected by the renderer, so the example must not
      // ship a request that cannot run.
      const ids = views.map((view) => view.id);
      expect(new Set(ids).size, `${path} repeats a view id`).toBe(ids.length);
    }

    // A singular example has no sheet to render, and the demo tells the two
    // apart by this list being empty.
    for (const { path, code } of demos.filter(({ code }) => !viewsLiteral.test(code))) {
      expect(readDemoViews(code), path).toEqual([]);
    }
  });

  it('reads the rig lights out of every example that declares a rig', () => {
    // Rig values (ambient, exposure, environment, space) travel inside
    // `lighting` with the lights the example declares, so an example that
    // offers a rig control must also declare a `lights` literal to carry them.
    const rigs = demos.filter(({ code }) =>
      Object.keys(readDemoOptions(code)).some((key) => isLightingKey(key)),
    );
    expect(rigs.length, 'no wrapped example drives a rig').toBeGreaterThan(0);

    for (const { path, code } of rigs) {
      const lights = readDemoLights(code);
      expect(lights, `${path} offers rig controls without a lights literal`).toBeDefined();
      expect(path, 'rig controls outside the lighting guide').toContain('light-the-subject');
      for (const light of lights ?? []) {
        expect(
          light.direction.some((part) => part !== 0),
          `${path} zero-length direction`,
        ).toBe(true);
        expect(
          light.color.every((part) => part >= 0 && part <= 32),
          `${path} colour outside the range`,
        ).toBe(true);
      }
    }

    // An example without a rig reports no lights at all, and the demo tells
    // "no rig" from "a rig with no lights" by this being undefined.
    for (const { code } of demos.filter(({ code }) => !/\blighting\s*:\s*\{/u.test(code))) {
      expect(readDemoLights(code)).toBeUndefined();
    }
    expect(readDemoLights('lighting: { lights: [], exposure: 1 }')).toEqual([]);
    expect(readDemoLights('lights: [{ direction: [0, 1, 0.4], color: [3, 2.9, 2.7] }]')).toEqual([
      { direction: [0, 1, 0.4], color: [3, 2.9, 2.7] },
    ]);
  });

  it('leaves a batch demo with controls after the angles are dropped', () => {
    // Angles belong to a view in a batch request, so the demo offers only the
    // shared keys; an example that sets nothing else would show no controls.
    for (const { path, code } of demos.filter(({ code }) => viewsLiteral.test(code))) {
      const shared = demoControls(code).filter((control) => control.key !== 'phi' && control.key !== 'theta');
      expect(shared.length, `${path} offers no shared controls`).toBeGreaterThan(0);
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
