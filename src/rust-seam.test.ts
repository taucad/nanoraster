/**
 * Seam guard for the rules that exist twice: once in `src/options.ts` as the
 * caller-facing precheck, once in `rust/render-core` as the authority. Editing
 * one side and not the other is the defect class this file exists to catch, so
 * these assertions read the Rust source rather than restating its values.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { RenderImageOptions } from '#options.js';
import { directionFromOrbit, renderImageMaxSections, toImageRequestJson } from '#options.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const renderCoreLib = read('rust/render-core/src/lib.rs');
const renderCoreOptions = read('rust/render-core/src/options.rs');
const optionsSource = read('src/options.ts');

const capture = (source: string, pattern: RegExp, what: string): string => {
  const match = pattern.exec(source);
  if (!match?.[1]) {
    throw new Error(`could not locate ${what}; re-pin this seam against the current source`);
  }
  return match[1];
};

/** The default fit orbit, read from render-core rather than restated. */
const defaultFitOrbit = {
  azimuth: Number(
    capture(
      renderCoreOptions,
      /const DEFAULT_FIT_AZIMUTH_DEG: f64 = ([\d.]+);/u,
      'DEFAULT_FIT_AZIMUTH_DEG in rust/render-core/src/options.rs',
    ),
  ),
  elevation: Number(
    capture(
      renderCoreOptions,
      /const DEFAULT_FIT_ELEVATION_DEG: f64 = ([\d.]+);/u,
      'DEFAULT_FIT_ELEVATION_DEG in rust/render-core/src/options.rs',
    ),
  ),
};

describe('TypeScript mirrors of render-core rules', () => {
  it('pins the section-plane limit to render-core MAX_SECTION_PLANES', () => {
    const limit = capture(
      renderCoreLib,
      /pub const MAX_SECTION_PLANES: usize = (\d+);/u,
      'MAX_SECTION_PLANES in rust/render-core/src/lib.rs',
    );
    expect(renderImageMaxSections).toBe(Number(limit));
    expect(renderImageMaxSections).toBe(8);
  });

  it('emits render-core world messages verbatim for the same inputs', () => {
    const messages = [...renderCoreOptions.matchAll(/"(world\.up and world\.forward must [^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(messages).toEqual([
      'world.up and world.forward must be provided together',
      'world.up and world.forward must name different axes',
    ]);
    const [together, different] = messages;
    const reject =
      (world: unknown): (() => string) =>
      () =>
        toImageRequestJson({ format: 'png', world } as RenderImageOptions);
    expect(reject({ up: '-x' })).toThrow(together);
    expect(reject({ forward: '-x' })).toThrow(together);
    expect(reject({ up: '+z', forward: '-z' })).toThrow(different);
    // Neither rule bans a left-handed-looking pair: render-core has none.
    expect(reject({ up: '+z', forward: '+y' })).not.toThrow();
  });

  it('leaves a degenerate camera up to render-core, which substitutes an axis', () => {
    // render-core resolves an `up` collinear with the view against the
    // declared world instead of refusing it, so no camera rule here may reject
    // the pair. The substitution itself is render-core's alone: this seam pins
    // that the rejection is absent and that the two fallback axes are the
    // declared world's own.
    expect(renderCoreOptions).not.toContain('and up must not be collinear');
    expect(
      capture(
        renderCoreOptions,
        /let forward = (world\.direction\(world\.caller_forward\));/u,
        'the first screen-up fallback in rust/render-core/src/options.rs',
      ),
    ).toBe('world.direction(world.caller_forward)');
    const world = { up: '+z', forward: '-y' } as const;
    const fit =
      (camera: unknown): (() => string) =>
      () =>
        toImageRequestJson({ format: 'png', world, camera } as RenderImageOptions);
    // Along the declared up, along the declared forward, and a contradictory
    // explicit pair: every one of them is render-core's to resolve.
    expect(fit({ framing: 'fit', direction: [0, 0, 1] })).not.toThrow();
    expect(fit({ framing: 'fit', direction: [0, -1, 0], up: [0, -2, 0] })).not.toThrow();
    expect(fit({ framing: 'fit', up: directionFromOrbit(defaultFitOrbit, world) })).not.toThrow();
  });

  it('derives the documented fit-direction default from render-core orbit angles', () => {
    // Both sides build the default fit direction from an orbit rather than a
    // literal, so the seam is the pair of angles plus the documented result.
    expect(defaultFitOrbit).toEqual({ azimuth: 45, elevation: 30 });
    const documented = capture(
      optionsSource,
      /Direction from the subject[^*]*@default \[([^\]]+)\]/u,
      'the fit-direction @default tag in src/options.ts',
    )
      .split(',')
      .map(Number);
    expect(documented).toHaveLength(3);
    for (const [index, component] of directionFromOrbit(defaultFitOrbit).entries()) {
      expect(documented[index]).toBeCloseTo(component, 9);
    }
  });
});
