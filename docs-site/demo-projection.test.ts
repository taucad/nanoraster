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
  demoQuantize,
  demoUpClear,
  isVector,
  readDemoOptions,
  substituteDemoValues,
  type DemoControl,
  type DemoValue,
  type DemoVector3,
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

const perturb = (control: DemoControl, current: DemoValue, world?: unknown): DemoValue => {
  const vector = isVector(current) ? [...current] : [0, 0, 0];
  if (control.kind === 'range')
    return Number(current) === control.max ? control.min : Number(current) + control.step;
  if (control.kind === 'log') return Math.min(control.max, Number(current) * 2);
  if (control.kind === 'choice') return control.choices.find((choice) => choice !== current) ?? current;
  if (control.kind === 'colour') return [0.1, 0.2, 0.3, 1];
  if (control.kind === 'orbit') {
    // The angles the sliders hand over: whole degrees, read in the demo's own
    // world, which is the pair the substituted helper call has to reproduce.
    const orbit = demoOrbitFromDirection(vector, world);
    const azimuth = Math.round(orbit.azimuth) === 90 ? -90 : 90;
    return demoDirectionFromOrbit({ azimuth, elevation: Math.round(orbit.elevation) }, world);
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

  it('authors every angle-driven demo vector through the exported orbit helper', () => {
    // A float triple on an angle-driven line teaches nothing and changes width
    // on every drag, which is what makes the block's scrollbar flicker.
    for (const { descriptor, path } of demos) {
      const templates = demoControlTemplates(descriptor.diagonal);
      for (const binding of descriptor.bindings) {
        if (templates[binding.control].kind !== 'orbit') continue;
        expect(binding.orbit, `${path} ${binding.key} is a raw vector`).toBeDefined();
        expect(descriptor.code.slice(binding.valueSpan.start, binding.valueSpan.end)).toMatch(
          /^renderDirectionFromOrbit\(\{ azimuth: -?\d+, elevation: -?\d+ \}(, \w+)?\)$/u,
        );
      }
      // Copy-pasteable: a fence that imports from the package and calls the
      // helper names the helper in that import.
      if (/^import \{/mu.test(descriptor.code) && descriptor.code.includes('renderDirectionFromOrbit(')) {
        expect(descriptor.code, path).toMatch(
          /import \{[^}]*renderDirectionFromOrbit[^}]*\} from 'nanoraster'/u,
        );
      }
    }
  });

  it('rewrites an orbit edit as whole degrees in the world the example declares', () => {
    const world = { up: '+z', forward: '-y', unit: 'meter' } as const;
    const descriptor = createDemoDescriptor(
      `const world = { up: '+z', forward: '-y', unit: 'meter' } as const;

const image = await renderImage(glb, {
  format: 'png',
  world,
  camera: {
    framing: 'fit',
    direction: renderDirectionFromOrbit({ azimuth: 45, elevation: 30 }, world),
  },
});`,
      gear,
    );
    // The world reaches the request through the shared constant, and the
    // helper is evaluated here: what travels to the renderer is Cartesian.
    expect(descriptor.request['world']).toEqual(world);
    expect(descriptor.bindings.find(({ key }) => key === 'camera.direction')?.value).toEqual(
      demoDirectionFromOrbit({ azimuth: 45, elevation: 30 }, world),
    );

    const seeded = readDemoOptions(descriptor);
    const moved = demoDirectionFromOrbit({ azimuth: -98, elevation: 28 }, world);
    const rewritten = substituteDemoValues(descriptor, { ...seeded, 'camera.direction': moved });
    expect(rewritten).toContain(
      'direction: renderDirectionFromOrbit({ azimuth: -98, elevation: 28 }, world),',
    );
    const recovered = demoOrbitFromDirection(moved, world);
    expect(recovered.azimuth).toBeCloseTo(-98);
    expect(recovered.elevation).toBeCloseTo(28);
    // Reparsing the rewritten example lands on the same Cartesian vector.
    expect(readDemoOptions(createDemoDescriptor(rewritten, gear))['camera.direction']).toEqual(moved);
  });

  it('keeps a direction no whole-degree orbit names as a Cartesian literal', () => {
    // The XYZ escape hatch can reach directions the two sliders cannot, and a
    // rounded helper call would then show a request the renderer never ran.
    const descriptor = createDemoDescriptor(
      `const image = await renderImage(glb, {
  format: 'png',
  camera: { framing: 'fit', direction: renderDirectionFromOrbit({ azimuth: 45, elevation: 30 }) },
});`,
      gear,
    );
    const typed = [0.1234, 0.5678, 0.9];
    const rewritten = substituteDemoValues(descriptor, {
      ...readDemoOptions(descriptor),
      'camera.direction': typed,
    });
    expect(rewritten).toContain('direction: [0.1234, 0.5678, 0.9]');
    expect(readDemoOptions(createDemoDescriptor(rewritten, gear))['camera.direction']).toEqual(typed);
  });

  it('writes no more decimals than a control step can express', () => {
    // A vector printed to ten places changes the width of its line on every
    // drag; the control's own step is what bounds it.
    expect(demoQuantize({ kind: 'offset', min: -1, max: 1, step: 0.001 }, [0.0070710678, 0.5, 0])).toEqual([
      0.0071, 0.5, 0,
    ]);
    expect(demoQuantize({ kind: 'range', min: 0, max: 0.5, step: 0.01 }, 0.123456789)).toBe(0.123);
    // Orbit vectors carry no step: their two angles are what the reader moves.
    expect(demoQuantize({ kind: 'orbit' }, [0.6123724357, 0.5, 0.6123724357])).toEqual([
      0.6123724357, 0.5, 0.6123724357,
    ]);
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

  it('bounds a plane point by its signed offset, not its distance from the origin', () => {
    const offset = { kind: 'offset', min: -1, max: 1, step: 0.01 } as const;
    const normal = [1, 0, 0];
    // A legal plane: 100 units of tangential slide names the same plane as the
    // origin does, so the offset control seeds it at 0 and nothing is lost.
    expect(demoBoundsViolation(offset, [0, 100, 0], normal)).toBeUndefined();
    expect(demoPlaneOffset([0, 100, 0], normal)).toBe(0);
    // A genuinely unreachable offset still fails the build.
    expect(demoBoundsViolation(offset, [2, 100, 0], normal)).toContain('outside');
    expect(demoBoundsViolation(offset, [-2, 0, 0], normal)).toContain('outside');
  });

  it('re-quotes a label that carries the quote it is wrapped in', () => {
    // A reader typing an apostrophe into the label control produced `'O'Brien'`,
    // which is not a TypeScript literal and no longer parses back.
    const descriptor = createDemoDescriptor(
      `const image = await renderImage(glb, {
  format: 'png',
  label: 'part',
});`,
      gear,
    );
    for (const label of ["O'Brien", 'back\\slash', "both\\'"]) {
      const rewritten = substituteDemoValues(descriptor, { ...readDemoOptions(descriptor), label });
      expect(readDemoOptions(createDemoDescriptor(rewritten, gear))['label']).toBe(label);
    }
  });

  it('refuses the camera directions the renderer rejects as collinear', () => {
    // The measured defect: elevation ±90 puts a fitted direction on the world
    // pole, where an undeclared `up` already sits, and the panel recovered
    // only through "reset to the example".
    const at = (elevation: number, world?: unknown): DemoVector3 =>
      demoDirectionFromOrbit({ azimuth: 0, elevation }, world);
    for (const elevation of [90, -90]) {
      expect(demoUpClear(at(elevation), undefined)).toBe(false);
      expect(demoUpClear(at(elevation), [0, 1, 0])).toBe(false);
      // The tutorial's top view declares its way out of the collision.
      expect(demoUpClear(at(elevation), [0, 0, 1])).toBe(true);
    }
    // Which is why that view has the pair one bearing into the track instead,
    // where no slider min or max can exclude it.
    expect(demoUpClear(at(0), [0, 0, 1])).toBe(false);
    expect(demoUpClear(at(1), [0, 0, 1])).toBe(true);
    expect(demoUpClear(at(-1), [0, 0, 1])).toBe(true);
    // A Z-up caller world swaps which axis the poles sit on.
    const zUp = { up: '+z', forward: '-y' };
    expect(demoUpClear(at(90, zUp), [0, 0, 1], zUp)).toBe(false);
    expect(demoUpClear(at(90, zUp), [0, 1, 0], zUp)).toBe(true);
    // Magnitude is not a degree of freedom, and neither vector may be zero.
    expect(demoUpClear(at(90), [0, 7, 0])).toBe(false);
    expect(demoUpClear([0, 0, 0], [0, 0, 1])).toBe(false);
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
          const edited = perturb(control, seeded[control.key], descriptor.request['world']);
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
