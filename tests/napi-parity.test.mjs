import { renderImage } from '#index.node.js';
import { physicalMaterialGlb, physicalMaterial } from './pbr-fixture.mjs';
import { expect, test } from 'vitest';

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
  expect(Array.from(unlit.bytes.subarray(center, center + 4))).toEqual([118, 170, 218, 255]);
  const translucent = await renderImage(
    physicalMaterialGlb({
      pbrMetallicRoughness: { baseColorFactor: [0.18, 0.4, 0.7, 0.5] },
      alphaMode: 'BLEND',
      extensions: { KHR_materials_unlit: {} },
    }),
    { ...options, background: undefined },
  );
  for (const [channel, expected] of [118, 170, 218, 128].entries()) {
    expect(Math.abs(translucent.bytes[center + channel] - expected)).toBeLessThanOrEqual(2);
  }
  await expect(
    renderImage(
      physicalMaterialGlb({ extensions: { KHR_materials_anisotropy: { anisotropyStrength: 2 } } }),
      options,
    ),
  ).rejects.toThrow(/anisotropyStrength/);
});
