import { materialErrors } from './material-parity.mjs';
import { renderImage } from '#index.node.js';
import { physicalMaterialGlb, physicalMaterial } from './pbr-fixture.mjs';
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const parityRoot = new URL('./fixtures/material-parity/', import.meta.url);
const references = JSON.parse(readFileSync(new URL('reference.json', parityRoot), 'utf8'));

test.each(references)('$id matches the Three.js material matrix', async (reference) => {
  const glb = gunzipSync(readFileSync(new URL(`${reference.id}.glb.gz`, parityRoot)));
  const expected = gunzipSync(readFileSync(new URL(`${reference.id}.rgba.gz`, parityRoot)));
  expect(createHash('sha256').update(glb).digest('hex')).toBe(reference.sha256);
  expect(createHash('sha256').update(expected).digest('hex')).toBe(reference.referenceSha256);
  const actual = await renderImage(glb, {
    width: reference.width,
    height: reference.height,
    format: 'raw',
    world: { up: '+z', forward: '-y', unit: 'meter' },
    lines: false,
    camera: reference.camera,
  });
  for (const error of materialErrors(reference, actual.bytes, expected)) {
    expect(error.mae, `${reference.id} row ${error.row} roughness ${error.roughness}`).toBeLessThan(2);
    expect(error.alphaMae).toBeLessThan(2);
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
