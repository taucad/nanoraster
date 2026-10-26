import { beforeAll, expect, test } from 'vitest';
import init, { Renderer } from 'nanoraster-wasm-candidate';
import { physicalMaterialGlb } from '../pbr-fixture.mjs';

beforeAll(async () => {
  await init();
});

test('reused multi-view requests preserve lighting, owned images and cached pipelines', async () => {
  const glb = physicalMaterialGlb({ pbrMetallicRoughness: { metallicFactor: 0.8, roughnessFactor: 0.2 } });
  const light = { direction: [1, 1, 1], color: [1.5, 1.5, 1.5] };
  const requests = [1, 0, 2, 1].map((count) =>
    JSON.stringify({
      width: 257,
      height: 192,
      format: 'raw',
      ao: {},
      views: [{ id: 'iso' }, { id: 'front' }],
      lighting: { lights: Array.from({ length: count }, () => light) },
    }),
  );
  // oxlint-disable-next-line typescript/unbound-method -- Forward the real device receiver and restore in finally.
  const original = globalThis.GPUDevice.prototype.createRenderPipeline;
  let compiled = 0;
  globalThis.GPUDevice.prototype.createRenderPipeline = function (descriptor) {
    compiled++;
    return original.call(this, descriptor);
  };
  let renderer;
  try {
    renderer = await Renderer.create();
    const images = [];
    for (const request of requests) images.push((await renderer.render_images(glb, request)).images);
    expect(images[0]).toEqual(images[3]);
    expect(images[0]).not.toEqual(images[1]);
    expect(images[0]).not.toEqual(images[2]);
    const count = compiled;
    expect((await renderer.render_images(glb, requests[0])).images).toEqual(images[0]);
    expect(compiled).toBe(count);

    // Fresh renderers independently establish each result after mixed-light history.
    for (const [index, request] of requests.entries()) {
      const fresh = await Renderer.create();
      try {
        expect((await fresh.render_images(glb, request)).images).toEqual(images[index]);
      } finally {
        fresh.dispose();
        fresh.free();
      }
    }
  } finally {
    renderer?.dispose();
    renderer?.free();
    globalThis.GPUDevice.prototype.createRenderPipeline = original;
  }
});
