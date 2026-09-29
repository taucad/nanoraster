import { expect, test } from 'vitest';
import { createRenderer } from 'nanoraster';

test('WASM per-view part selection matches independent renders with one scene upload', async () => {
  const glb = new Uint8Array(
    await (await fetch(new URL('../fixtures/planetary.glb', import.meta.url))).arrayBuffer(),
  );
  const renderer = await createRenderer();
  const views = [0, 1, 2].map((index) => ({
    id: `part-${index}`,
    visiblePrimitives: [{ nodeIndex: index, meshIndex: index, primitiveIndex: 0 }],
  }));
  const options = { width: 128, height: 128, format: 'png', timings: true };
  try {
    const separate = [];
    for (const view of views)
      separate.push((await renderer.renderImages(glb, { ...options, views: [view] }))[0].file.bytes);
    const batch = await renderer.renderImages(glb, { ...options, views });
    expect(batch.map((image) => image.file.bytes)).toEqual(separate);
    expect(batch.timings.glbParses).toBe(1);
    expect(batch.timings.sceneUploads).toBe(1);
    expect(separate[0]).not.toEqual(separate[1]);
    await expect(
      renderer.renderImages(glb, { ...options, views: [{ id: 'empty', visiblePrimitives: [] }] }),
    ).rejects.toThrow('fitted camera has no eligible geometry to frame');
  } finally {
    renderer.dispose();
  }
});
