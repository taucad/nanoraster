import { beforeAll, expect, test } from 'vitest';
import init, { Renderer } from 'nanoraster-wasm-candidate';
import { physicalMaterialGlb } from '../pbr-fixture.mjs';

beforeAll(async () => {
  await init();
});

test('absent clearcoat preserves full-shader pixels and bounded cache reuse across materials', async () => {
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the real device receiver with call() and restore in finally.
  const original = globalThis.GPUDevice.prototype.createRenderPipeline;
  const options = JSON.stringify({ width: 257, height: 192, format: 'raw', ao: {} });
  const materials = [
    {},
    { extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: 0.1 } } },
    {
      extensions: { KHR_materials_sheen: { sheenColorFactor: [0.4, 0.05, 0.2], sheenRoughnessFactor: 0.5 } },
    },
    { extensions: { KHR_materials_iridescence: { iridescenceFactor: 1 } } },
    { extensions: { KHR_materials_transmission: { transmissionFactor: 0.8 } } },
    { alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.6, 0.7, 0.5] } },
    {},
  ];
  const results = [];
  try {
    for (const general of [false, true]) {
      const compiled = [];
      globalThis.GPUDevice.prototype.createRenderPipeline = function (descriptor) {
        if (descriptor.fragment?.entryPoint !== 'fs_mesh') return original.call(this, descriptor);
        compiled.push(descriptor.fragment.constants?.CLEARCOAT);
        return original.call(
          this,
          general
            ? {
                ...descriptor,
                fragment: {
                  ...descriptor.fragment,
                  constants: { ...descriptor.fragment.constants, CLEARCOAT: 1 },
                },
              }
            : descriptor,
        );
      };
      const renderer = await Renderer.create();
      const images = [];
      try {
        for (const material of materials) {
          images.push(await renderer.render_image(physicalMaterialGlb(material), options));
        }
        expect(compiled).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
        expect(images[0]).toEqual(images[6]);
        expect(images[0]).not.toEqual(images[1]);
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
