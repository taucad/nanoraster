import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  cleanLabel,
  demoAxisVector,
  demoBoundsViolation,
  demoControlTemplates,
  demoControls,
  demoDirectionFromOrbit,
  demoOrbitFromDirection,
  demoPlaneOffset,
  demoPlanePoint,
  isVector,
  readDemoOptions,
  substituteDemoValues,
  type DemoControl,
  type DemoValue,
} from './lib/demo-options';
import { demoModelDiagonal } from './lib/demo-model';
import { buildDemoRequest } from './lib/demo-request';
import { createDemoDescriptor } from './lib/demo-source';
import { llmStringifyMdx } from './lib/llm-stringify-mdx';
import { remarkRenderDemo } from './lib/remark-render-demo';

const docsDir = resolve(import.meta.dirname, 'content/docs');
const demos = globSync('**/*.mdx', { cwd: docsDir }).flatMap((path) => {
  const source = readFileSync(resolve(docsDir, path), 'utf8');
  return [...source.matchAll(/<RenderDemo([^>]*)>\s*```(\w+)\n([\s\S]*?)```\s*<\/RenderDemo>/gu)].map(
    (match) => {
      const model = /model="([^"]+)"/u.exec(match[1])?.[1];
      const diagonal = demoModelDiagonal(model);
      return {
        path,
        lang: match[2],
        code: match[3],
        diagonal,
        descriptor: createDemoDescriptor(match[3], diagonal),
      };
    },
  );
});

/** The gear every demo but the section guide renders. */
const gear = demoModelDiagonal();

const perturb = (control: DemoControl, current: DemoValue): DemoValue => {
  const vector = isVector(current) ? [...current] : [0, 0, 0];
  if (control.kind === 'range')
    return Number(current) === control.max ? control.min : Number(current) + control.step;
  if (control.kind === 'log') return Math.min(control.max, Number(current) * 2);
  if (control.kind === 'choice') return control.choices.find((choice) => choice !== current) ?? current;
  if (control.kind === 'colour') return [0.1, 0.2, 0.3, 1];
  if (control.kind === 'orbit') {
    const orbit = demoOrbitFromDirection(vector);
    return demoDirectionFromOrbit({ ...orbit, azimuth: orbit.azimuth === 90 ? -90 : 90 });
  }
  if (control.kind === 'axis') return demoAxisVector(vector[2] === 1 ? '+x' : '+z');
  if (control.kind === 'offset') return demoPlanePoint(control.max / 2, [1, 0, 0]);
  if (control.kind === 'triple') return vector.map((part) => Math.min(control.max, part + control.step));
  if (control.kind === 'text') return `${String(current)} edited`;
  return current !== true;
};

describe('interactive demo projections', () => {
  it('drives directions through the package orbit pair in the declared world', () => {
    // Azimuth zero sits on `world.forward`, so the same angles name the same
    // view of the model whatever axes the caller declares.
    const iso = { azimuth: 45, elevation: 30 };
    expect(demoDirectionFromOrbit(iso)).toEqual([0.6123724357, 0.5, 0.6123724357]);
    const zUp = { up: '+z', forward: '-y' };
    const direction = demoDirectionFromOrbit(iso, zUp);
    expect(direction).toEqual([0.6123724357, -0.6123724357, 0.5]);
    const orbit = demoOrbitFromDirection(direction, zUp);
    expect(orbit.azimuth).toBeCloseTo(45);
    expect(orbit.elevation).toBeCloseTo(30);
  });

  it('maps a plane point to one signed distance along its own normal', () => {
    expect(demoPlaneOffset([0, 0, 0], [-1, 0, 0])).toBe(0);
    expect(demoPlanePoint(0.01, [-2, 0, 0])).toEqual([-0.01, 0, 0]);
    expect(demoPlaneOffset(demoPlanePoint(0.004, [0, 0, 1]), [0, 0, 1])).toBeCloseTo(0.004);
  });

  it('fails the build when an authored literal is outside its own control', () => {
    // The measured defect: `clipping: { far: 1 }` under a slider floored at 2
    // read `2` beside `far: 1`, and the authored value was unreachable.
    const authored = (far: number): string =>
      `const image = await renderImage(glb, {
  format: 'png',
  camera: { framing: 'fixed', clipping: { near: 0.005, far: ${far} } },
});`;
    expect(() => createDemoDescriptor(authored(1), gear)).not.toThrow();
    expect(() => createDemoDescriptor(authored(10_000), gear)).toThrow(/camera\.clipping\.far/u);
    expect(demoBoundsViolation({ kind: 'range', min: 2, max: 1000, step: 1 }, 1)).toContain('outside');
  });

  it('scales every length control to the model on screen', () => {
    for (const { descriptor, diagonal, path } of demos) {
      const templates = demoControlTemplates(descriptor.diagonal);
      expect(descriptor.diagonal, path).toBe(diagonal);
      // One step of a length control is a nudge on this model, not a leap
      // clear of it: the section guide's plane used to move 1.4 model widths.
      const point = templates['point'];
      expect(point.kind === 'offset' && point.step, path).toBeLessThan(diagonal / 100);
    }
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
    for (const { descriptor, diagonal, path } of demos) {
      const seeded = readDemoOptions(descriptor);
      expect(substituteDemoValues(descriptor, seeded), path).toBe(descriptor.code);
      // Every view's group, not just the one the panel opens on.
      for (const viewId of [undefined, ...descriptor.views.map(({ id }) => id)]) {
        for (const control of demoControls(descriptor, viewId)) {
          expect(seeded[control.key], `${path} ${control.key}`).toBeDefined();
          const edited = perturb(control, seeded[control.key]);
          const rewritten = substituteDemoValues(descriptor, { ...seeded, [control.key]: edited });
          const reparsed = createDemoDescriptor(rewritten, diagonal);
          expect(readDemoOptions(reparsed)[control.key], `${path} ${control.key}`).toEqual(edited);
        }
      }
    }
  });

  it('keeps duplicate property names in their declared object scopes', () => {
    const descriptor = createDemoDescriptor(
      `const images = await renderImages(glb, {
  format: 'png',
  camera: { framing: 'fit', direction: [1, 0, 0], up: [0, 1, 0], margin: 0.2 },
  lighting: { lights: [{ direction: [0, 0, 1], color: [1, 1, 1] }], ambient: 0.1 },
  views: [{ id: 'top', camera: { framing: 'fit', direction: [0, 1, 0], up: [0, 0, 1] } }],
});`,
      gear,
    );
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
    const descriptor = createDemoDescriptor(
      `const image = await renderImage(glb, {
  format: 'png',
  camera: { framing: 'fit', direction: [1, 0, 0] },
  sections: {
    planes: [{ point: [0, 0, 0], normal: [1, 0, 0] }],
    clipSurfaces: true,
    clipLines: false,
  },
});`,
      gear,
    );
    expect(readDemoOptions(descriptor)).toMatchObject({
      'camera.direction': [1, 0, 0],
      'sections.planes.0.point': [0, 0, 0],
      'sections.planes.0.normal': [1, 0, 0],
      'sections.clipSurfaces': true,
      'sections.clipLines': false,
    });
  });

  it('removes a first-position view label without producing invalid code', () => {
    const descriptor = createDemoDescriptor(
      `const images = await renderImages(glb, {
  format: 'png',
  views: [{ label: 'Front', id: 'front', camera: { framing: 'fit', direction: [1, 0, 0] } }],
});`,
      gear,
    );
    const rewritten = substituteDemoValues(descriptor, {
      ...readDemoOptions(descriptor),
      'view.front.label': '',
    });
    expect(rewritten).not.toContain('label:');
    expect(createDemoDescriptor(rewritten, gear).views).toEqual([
      { id: 'front', camera: { framing: 'fit', direction: [1, 0, 0] } },
    ]);
  });

  it('injects one serializable build-time descriptor into RenderDemo', () => {
    type Tree = {
      type: string;
      children: {
        type: string;
        name: string;
        attributes?: { type: 'mdxJsxAttribute'; name: string; value?: unknown }[];
        children: { type: string; lang: string; value: string }[];
      }[];
    };
    const authored = (value: string): Tree => ({
      type: 'root',
      children: [
        {
          type: 'mdxJsxFlowElement',
          name: 'RenderDemo',
          children: [{ type: 'code', lang: 'typescript', value }],
        },
      ],
    });
    const tree = authored("renderImage(glb, { format: 'png' })");
    remarkRenderDemo()(tree);
    const attributes = tree.children[0]?.attributes ?? [];
    const descriptorJson = attributes.find(({ name }) => name === 'descriptorJson')?.value;
    expect(JSON.parse(String(descriptorJson))).toMatchObject({
      diagonal: gear,
      request: { format: 'png' },
    });

    // The same pass the docs build runs, so an unreachable literal stops it.
    expect(() => {
      remarkRenderDemo()(
        authored("renderImage(glb, { camera: { framing: 'fixed', clipping: { near: 1, far: 9e9 } } })"),
      );
    }).toThrow(/camera\.clipping\.far/u);
  });

  it('sanitises labels before they can reach a request', () => {
    expect(cleanLabel(`ok\n\u0000µ—−${'x'.repeat(80)}`)).toHaveLength(64);
  });
});
