import { beforeAll, expect, test } from 'vitest';
import init, { Renderer } from 'nanoraster-wasm-candidate';
import { physicalMaterialGlb } from '../pbr-fixture.mjs';

let fallback;
beforeAll(async () => {
  await init();
  const adapter = await globalThis.navigator.gpu.requestAdapter();
  fallback = adapter.info.isFallbackAdapter;
});

test('absent physical features preserve exact output and active features across cache reuse', async () => {
  // oxlint-disable-next-line typescript/unbound-method -- Retain the real device receiver with call() and restore in finally.
  const original = globalThis.GPUDevice.prototype.createRenderPipeline;
  const base = { pbrMetallicRoughness: { metallicFactor: 0.8, roughnessFactor: 0.2 } };
  const materials = [
    base,
    {
      ...base,
      extensions: { KHR_materials_anisotropy: { anisotropyStrength: 0.8, anisotropyRotation: 0.4 } },
    },
    { ...base, extensions: { KHR_materials_iridescence: { iridescenceFactor: 1 } } },
    {
      ...base,
      extensions: { KHR_materials_sheen: { sheenColorFactor: [0.4, 0.05, 0.2], sheenRoughnessFactor: 0.5 } },
    },
    { ...base, extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1 } } },
    { ...base, extensions: { KHR_materials_transmission: { transmissionFactor: 0.8 } } },
    base,
  ];
  const results = [];
  try {
    for (const general of [false, true]) {
      const compiled = [];
      globalThis.GPUDevice.prototype.createRenderPipeline = function (descriptor) {
        if (descriptor.fragment?.entryPoint !== 'fs_mesh') return original.call(this, descriptor);
        compiled.push(descriptor.fragment.constants?.ANISOTROPY_SHEEN);
        return original.call(
          this,
          general
            ? {
                ...descriptor,
                fragment: {
                  ...descriptor.fragment,
                  constants: { ...descriptor.fragment.constants, ANISOTROPY_SHEEN: 1 },
                },
              }
            : descriptor,
        );
      };
      const renderer = await Renderer.create();
      const images = [];
      try {
        for (const material of materials)
          images.push(
            await renderer.render_image(
              physicalMaterialGlb(material),
              JSON.stringify({ width: 257, height: 192, format: 'raw', ao: {} }),
            ),
          );
        expect(compiled).toEqual(fallback ? Array(8).fill(1) : [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]);
        expect(images[0]).toEqual(images[6]);
        for (const index of [1, 2, 3, 4, 5]) expect(images[index]).not.toEqual(images[0]);
      } finally {
        renderer.dispose();
        renderer.free();
      }
      results.push(images);
    }
    expect(results[0]).toEqual(results[1]);
  } finally {
    globalThis.GPUDevice.prototype.createRenderPipeline = original;
  }
});

test('Replicad metallic planetary assembly matches the general physical shader at thumbnail and 5K sizes', async () => {
  const glb = new Uint8Array(
    await (await fetch(new URL('../fixtures/replicad-planetary-pbr.glb', import.meta.url))).arrayBuffer(),
  );
  const documentLength = new DataView(glb.buffer).getUint32(12, true);
  const document = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + documentLength)));
  const surfaces = document.materials.filter((material) => !material.extensions?.KHR_materials_unlit);
  expect(surfaces.length).toBeGreaterThan(0);
  expect(surfaces.every((material) => material.pbrMetallicRoughness.metallicFactor >= 0.65)).toBe(true);
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the real device receiver with call() and restore in finally.
  const original = globalThis.GPUDevice.prototype.createRenderPipeline;
  const results = [];
  try {
    for (const general of [false, true]) {
      globalThis.GPUDevice.prototype.createRenderPipeline = function (descriptor) {
        if (!general || descriptor.fragment?.entryPoint !== 'fs_mesh') return original.call(this, descriptor);
        return original.call(this, {
          ...descriptor,
          fragment: {
            ...descriptor.fragment,
            constants: { ...descriptor.fragment.constants, ANISOTROPY_SHEEN: 1 },
          },
        });
      };
      const renderer = await Renderer.create();
      const hashes = [];
      try {
        for (const [width, height] of [
          [768, 432],
          [5120, 2880],
        ]) {
          const image = await renderer.render_image(
            glb,
            JSON.stringify({ width, height, format: 'raw', ao: {} }),
          );
          expect(image.length).toBe(width * height * 4);
          hashes.push(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', image))));
        }
      } finally {
        renderer.dispose();
        renderer.free();
      }
      results.push(hashes);
    }
    expect(results[0]).toEqual(results[1]);
  } finally {
    globalThis.GPUDevice.prototype.createRenderPipeline = original;
  }
});

test('physical maps retain active features and zero-factor maps still match the general shader', async () => {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = canvas.height = 2;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff8040';
  context.fillRect(0, 0, 2, 2);
  context.fillStyle = '#4080ff';
  context.fillRect(0, 0, 1, 1);
  const textureBytes = new Uint8Array(await (await fetch(canvas.toDataURL('image/png'))).arrayBuffer());
  const materials = [0, 0.001, 1].map((factor) => ({
    pbrMetallicRoughness: { metallicFactor: 0.6, roughnessFactor: 0.25 },
    extensions: {
      KHR_materials_anisotropy: { anisotropyStrength: factor, anisotropyTexture: { index: 0 } },
      KHR_materials_iridescence: {
        iridescenceFactor: factor,
        iridescenceTexture: { index: 0 },
        iridescenceThicknessTexture: { index: 0 },
      },
      KHR_materials_sheen: {
        sheenColorFactor: [factor, factor, factor],
        sheenColorTexture: { index: 0 },
        sheenRoughnessTexture: { index: 0 },
        sheenRoughnessFactor: 0.5,
      },
    },
  }));
  // oxlint-disable-next-line typescript/unbound-method -- Call on the original device and restore in finally.
  const original = globalThis.GPUDevice.prototype.createRenderPipeline;
  const results = [];
  try {
    for (const general of [false, true]) {
      const compiled = [];
      globalThis.GPUDevice.prototype.createRenderPipeline = function (descriptor) {
        if (descriptor.fragment?.entryPoint !== 'fs_mesh') return original.call(this, descriptor);
        compiled.push(descriptor.fragment.constants.ANISOTROPY_SHEEN);
        return original.call(
          this,
          general
            ? {
                ...descriptor,
                fragment: {
                  ...descriptor.fragment,
                  constants: { ...descriptor.fragment.constants, ANISOTROPY_SHEEN: 1 },
                },
              }
            : descriptor,
        );
      };
      const renderer = await Renderer.create();
      const images = [];
      try {
        for (const material of [...materials, materials[0]])
          images.push(
            await renderer.render_image(
              physicalMaterialGlb(material, textureBytes),
              JSON.stringify({ width: 257, height: 192, format: 'raw' }),
            ),
          );
        expect(compiled).toEqual(fallback ? Array(4).fill(1) : [0, 0, 0, 0, 1, 1, 1, 1]);
        expect(images[0]).toEqual(images[3]);
        expect(images[2]).not.toEqual(images[0]);
      } finally {
        renderer.dispose();
        renderer.free();
      }
      results.push(images);
    }
    expect(results[0]).toEqual(results[1]);
  } finally {
    globalThis.GPUDevice.prototype.createRenderPipeline = original;
  }
});
