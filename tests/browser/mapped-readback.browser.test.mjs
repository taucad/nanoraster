import { beforeAll, expect, test } from 'vitest';
import init, { Renderer } from 'nanoraster-wasm-candidate';

let wasm;
let glb;
beforeAll(async () => {
  wasm = await init();
  glb = new Uint8Array(
    await (await fetch(new URL('../fixtures/replicad-planetary-pbr.glb', import.meta.url))).arrayBuffer(),
  );
});

test('should copy only image bytes from padded mappings and retain owned images across reuse and memory growth', async () => {
  const mapped = new WeakSet();
  const copies = [];
  // oxlint-disable-next-line typescript/unbound-method -- Forward with the original receiver and restore in finally.
  const getMappedRange = globalThis.GPUBuffer.prototype.getMappedRange;
  // oxlint-disable-next-line typescript/unbound-method -- Forward with the original receiver and restore in finally.
  const set = Uint8Array.prototype.set;
  globalThis.GPUBuffer.prototype.getMappedRange = function (...args) {
    const buffer = getMappedRange.apply(this, args);
    if (this.usage & globalThis.GPUBufferUsage.MAP_READ) mapped.add(buffer);
    return buffer;
  };
  Uint8Array.prototype.set = function (source, offset) {
    if (mapped.has(source.buffer)) copies.push(source.byteLength);
    return set.call(this, source, offset);
  };
  let renderer;
  const retained = [];
  try {
    renderer = await Renderer.create();
    for (const alpha of [1, 0.5, 0]) {
      const options = { width: 129, height: 85, format: 'raw', background: [1, 1, 1, alpha], ao: {} };
      copies.length = 0;
      const image = await renderer.render_image(glb, JSON.stringify(options));
      expect(image.length).toBe(129 * 85 * 4);
      // Padding belongs to the mapped transport, not an intermediate image copy.
      expect(copies.reduce((sum, size) => sum + size, 0)).toBe(image.length);
      expect(Math.max(...copies)).toBeLessThanOrEqual(129 * 4);
      expect(image.buffer).not.toBe(wasm.memory.buffer);
      retained.push({ image, reference: image.slice() });
      const batch = await renderer.render_images(
        glb,
        JSON.stringify({ ...options, views: [{ id: 'first' }, { id: 'second' }] }),
      );
      expect(batch.images[0]).toEqual(image);
      expect(batch.images[1]).toEqual(image);
      batch.images[0].fill(17);
      expect(batch.images[1]).toEqual(image);
    }
    // Force a detached old WASM buffer, then grow targets and reuse the renderer.
    wasm.memory.grow(1);
    await renderer.render_image(glb, JSON.stringify({ width: 768, height: 432, format: 'raw' }));
    renderer.dispose();
    for (const { image, reference } of retained) expect(image).toEqual(reference);
  } finally {
    renderer?.dispose();
    renderer?.free();
    globalThis.GPUBuffer.prototype.getMappedRange = getMappedRange;
    Uint8Array.prototype.set = set;
  }
});
