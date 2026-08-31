import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  cleanLabel,
  demoAnglesFromDirection,
  demoControls,
  demoDirectionFromAngles,
  readDemoOptions,
  substituteDemoValues,
  type DemoControl,
  type DemoValue,
} from './lib/demo-options';
import { buildDemoRequest } from './lib/demo-request';
import { createDemoDescriptor } from './lib/demo-source';
import { llmStringifyMdx } from './lib/llm-stringify-mdx';
import { remarkRenderDemo } from './lib/remark-render-demo';

const docsDir = resolve(import.meta.dirname, 'content/docs');
const demos = globSync('**/*.mdx', { cwd: docsDir }).flatMap((path) => {
  const source = readFileSync(resolve(docsDir, path), 'utf8');
  return [...source.matchAll(/<RenderDemo>\s*```(\w+)\n([\s\S]*?)```\s*<\/RenderDemo>/gu)].map((match) => ({
    path,
    lang: match[1],
    code: match[2],
    descriptor: createDemoDescriptor(match[2]),
  }));
});

const perturb = (control: DemoControl, current: DemoValue): DemoValue => {
  if (control.kind === 'range')
    return Number(current) === control.max ? control.min : Number(current) + control.step;
  if (control.kind === 'choice') return control.choices.find((choice) => choice !== current) ?? current;
  if (control.kind === 'colour') return [0.1, 0.2, 0.3, 1];
  if (control.kind === 'vector') {
    const value: number[] = Array.isArray(current) ? current.map((part: number) => part) : [0, 0, 0];
    value[0] = value[0] + control.step;
    return value;
  }
  if (control.kind === 'text') return `${String(current)} edited`;
  return current !== true;
};

describe('interactive demo projections', () => {
  it('round-trips spherical controls through caller-world Cartesian directions', () => {
    expect(demoDirectionFromAngles(60, -45)).toEqual([0.6123724357, 0.5, 0.6123724357]);
    const zUp = { up: '+z', forward: '-y' };
    const direction = demoDirectionFromAngles(60, -45, zUp);
    expect(direction).toEqual([0.6123724357, -0.6123724357, 0.5]);
    const angles = demoAnglesFromDirection(direction, zUp);
    expect(angles.phi).toBeCloseTo(60);
    expect(angles.theta).toBeCloseTo(-45);
  });

  it('builds every authored demo and keeps its agent projection verbatim', () => {
    expect(demos.length).toBeGreaterThan(0);
    for (const { code, descriptor, lang, path } of demos) {
      expect(descriptor.code, path).toBe(code);
      expect(demoControls(descriptor).length, `${path} offers no controls`).toBeGreaterThan(0);
      expect(
        llmStringifyMdx({
          type: 'mdxJsxFlowElement',
          name: 'RenderDemo',
          attributes: [
            { type: 'mdxJsxAttribute', name: 'code', value: code },
            { type: 'mdxJsxAttribute', name: 'lang', value: lang },
          ],
        }),
      ).toBe(`\`\`\`${lang}\n${code}\n\`\`\``);
    }
  });

  it('executes the same scoped request that the example displays', () => {
    for (const { descriptor, path } of demos) {
      const values = readDemoOptions(descriptor);
      const { request } = buildDemoRequest(descriptor, values, { height: 720, width: 960 });
      const authored = { ...descriptor.request };
      delete authored['background'];
      expect(request, path).toMatchObject({ ...authored, height: 720, width: 960 });
      for (const removedTopLevel of ['direction', 'margin', 'position', 'target', 'up']) {
        expect(request, `${path} leaked ${removedTopLevel}`).not.toHaveProperty(removedTopLevel);
      }
    }
  });

  it('seeds controls from their exact literal and reads back every edit', () => {
    for (const { descriptor, path } of demos) {
      const seeded = readDemoOptions(descriptor);
      expect(substituteDemoValues(descriptor, seeded), path).toBe(descriptor.code);
      for (const control of demoControls(descriptor)) {
        expect(seeded[control.key], `${path} ${control.key}`).toBeDefined();
        const edited = perturb(control, seeded[control.key]);
        const rewritten = substituteDemoValues(descriptor, { ...seeded, [control.key]: edited });
        const reparsed = createDemoDescriptor(rewritten);
        expect(readDemoOptions(reparsed)[control.key], `${path} ${control.key}`).toEqual(edited);
      }
    }
  });

  it('keeps duplicate property names in their declared object scopes', () => {
    const descriptor = createDemoDescriptor(`const images = await renderImages(glb, {
  format: 'png',
  camera: { framing: 'fit', direction: [1, 0, 0], up: [0, 1, 0], margin: 0.2 },
  lighting: { lights: [{ direction: [0, 0, 1], color: [1, 1, 1] }], ambient: 0.1 },
  views: [{ id: 'top', camera: { framing: 'fit', direction: [0, 1, 0], up: [0, 0, 1] } }],
});`);
    expect(readDemoOptions(descriptor)).toMatchObject({
      'camera.direction': [1, 0, 0],
      'camera.margin': 0.2,
      'camera.up': [0, 1, 0],
      'lighting.ambient': 0.1,
      'view.top.camera.direction': [0, 1, 0],
      'view.top.camera.up': [0, 0, 1],
    });
    const { request } = buildDemoRequest(descriptor, readDemoOptions(descriptor), {
      height: 720,
      width: 960,
    });
    expect(request).not.toHaveProperty('direction');
    expect(request).not.toHaveProperty('up');
    expect(request).not.toHaveProperty('margin');
  });

  it('binds nested section planes without leaking their vectors to camera controls', () => {
    const descriptor = createDemoDescriptor(`const image = await renderImage(glb, {
  format: 'png',
  camera: { framing: 'fit', direction: [1, 0, 0] },
  sections: {
    planes: [{ point: [0, 0, 0], normal: [1, 0, 0] }],
    clipSurfaces: true,
    clipLines: false,
  },
});`);
    expect(readDemoOptions(descriptor)).toMatchObject({
      'camera.direction': [1, 0, 0],
      'sections.planes.0.point': [0, 0, 0],
      'sections.planes.0.normal': [1, 0, 0],
      'sections.clipSurfaces': true,
      'sections.clipLines': false,
    });
  });

  it('removes a first-position view label without producing invalid code', () => {
    const descriptor = createDemoDescriptor(`const images = await renderImages(glb, {
  format: 'png',
  views: [{ label: 'Front', id: 'front', camera: { framing: 'fit', direction: [1, 0, 0] } }],
});`);
    const rewritten = substituteDemoValues(descriptor, {
      ...readDemoOptions(descriptor),
      'view.front.label': '',
    });
    expect(rewritten).not.toContain('label:');
    expect(createDemoDescriptor(rewritten).views).toEqual([
      { id: 'front', camera: { framing: 'fit', direction: [1, 0, 0] } },
    ]);
  });

  it('injects one serializable build-time descriptor into RenderDemo', () => {
    const tree: {
      type: string;
      children: {
        type: string;
        name: string;
        attributes?: { type: 'mdxJsxAttribute'; name: string; value?: unknown }[];
        children: { type: string; lang: string; value: string }[];
      }[];
    } = {
      type: 'root',
      children: [
        {
          type: 'mdxJsxFlowElement',
          name: 'RenderDemo',
          children: [{ type: 'code', lang: 'typescript', value: "renderImage(glb, { format: 'png' })" }],
        },
      ],
    };
    remarkRenderDemo()(tree);
    const attributes = tree.children[0]?.attributes ?? [];
    const descriptorJson = attributes.find(({ name }) => name === 'descriptorJson')?.value;
    expect(JSON.parse(String(descriptorJson))).toMatchObject({ request: { format: 'png' } });
  });

  it('sanitises labels before they can reach a request', () => {
    expect(cleanLabel(`ok\n\u0000µ—−${'x'.repeat(80)}`)).toHaveLength(64);
  });
});
