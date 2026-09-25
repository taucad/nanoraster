import { materialErrors } from './material-parity.mjs';
import { createRenderer, renderImage } from '#index.node.js';
import { physicalMaterialGlb, physicalMaterial } from './pbr-fixture.mjs';
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const parityRoot = new URL('./fixtures/material-parity/', import.meta.url);
const references = JSON.parse(readFileSync(new URL('reference.json', parityRoot), 'utf8'));

test.each(references)('$id matches the Three.js material matrix', async (reference) => {
  const base = reference.sourceId ? references.find((entry) => entry.id === reference.sourceId) : reference;
  expect(base).toBeDefined();
  const glb = gunzipSync(readFileSync(new URL(`${reference.sourceId ?? reference.id}.glb.gz`, parityRoot)));
  const expected = gunzipSync(readFileSync(new URL(`${reference.id}.rgba.gz`, parityRoot)));
  expect(createHash('sha256').update(glb).digest('hex')).toBe(base.sha256);
  expect(createHash('sha256').update(expected).digest('hex')).toBe(reference.referenceSha256);
  const actual = await renderImage(glb, {
    width: base.width,
    height: base.height,
    format: 'raw',
    world: { up: '+z', forward: '-y', unit: 'meter' },
    lines: false,
    camera: base.camera,
    ao: reference.ao,
  });
  for (const error of materialErrors(base, actual.bytes, expected)) {
    expect(error.mae, `${reference.id} row ${error.row} roughness ${error.roughness}`).toBeLessThan(2);
    expect(error.alphaMae).toBeLessThan(2);
  }
});

test('AO changes contact shading, intensity zero preserves pixels, and warm batch output is stable', async () => {
  const glb = readFileSync(new URL('./fixtures/gear-12.glb', import.meta.url));
  const renderer = await createRenderer();
  try {
    const options = { width: 256, height: 256, format: 'raw', lines: false };
    const off = await renderer.renderImage(glb, options);
    const zero = await renderer.renderImage(glb, { ...options, ao: { intensity: 0 } });
    const on = await renderer.renderImage(glb, { ...options, ao: {} });
    expect(zero.bytes).toEqual(off.bytes);
    expect(on.bytes).not.toEqual(off.bytes);
    const batch = await renderer.renderImages(glb, { ...options, ao: {}, views: [{ id: 'iso' }] });
    expect(batch[0].file.bytes).toEqual(on.bytes);
    expect((await renderer.renderImage(glb, { ...options, ao: {} })).bytes).toEqual(on.bytes);
  } finally {
    renderer.dispose();
  }
});

test('native singular and batch renders are byte-identical across all 336 cases', async () => {
  await import('./napi-parity.mjs');
});

test('physical material layers render through the native facade and repeat exactly', async () => {
  const options = { width: 128, height: 128, format: 'raw', background: '#FFFFFF', lines: false };
  const bytes = physicalMaterialGlb(physicalMaterial);
  const first = await renderImage(bytes, options);
  expect(first.bytes).toEqual((await renderImage(bytes, options)).bytes);
  expect(first.bytes).not.toEqual(
    (await renderImage(physicalMaterialGlb({ ...physicalMaterial, extensions: {} }), options)).bytes,
  );
  const unlit = await renderImage(
    physicalMaterialGlb({
      pbrMetallicRoughness: { baseColorFactor: [0.18, 0.4, 0.7, 1] },
      extensions: { KHR_materials_unlit: {} },
    }),
    options,
  );
  const center = (64 * 128 + 64) * 4;
  expect(Array.from(unlit.bytes.subarray(center, center + 4))).toEqual([105, 162, 212, 255]);
  const translucent = await renderImage(
    physicalMaterialGlb({
      pbrMetallicRoughness: { baseColorFactor: [0.18, 0.4, 0.7, 0.5] },
      alphaMode: 'BLEND',
      extensions: { KHR_materials_unlit: {} },
    }),
    { ...options, background: undefined },
  );
  for (const [channel, expected] of [105, 162, 212, 128].entries()) {
    expect(Math.abs(translucent.bytes[center + channel] - expected)).toBeLessThanOrEqual(2);
  }
  await expect(
    renderImage(
      physicalMaterialGlb({ extensions: { KHR_materials_anisotropy: { anisotropyStrength: 2 } } }),
      options,
    ),
  ).rejects.toThrow(/anisotropyStrength/);
});
