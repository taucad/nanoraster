import { beforeAll, expect, test } from 'vitest';
import init, { codec_conformance, describe_adapter, render_glb_to_image } from 'nanoraster-wasm-candidate';

let glb;

beforeAll(async () => {
  expect(navigator.gpu, 'WebGPU must be enabled for every supported browser').toBeDefined();
  await init();
  const response = await fetch(new URL('../fixtures/gear-12.glb', import.meta.url));
  expect(response.ok).toBe(true);
  glb = new Uint8Array(await response.arrayBuffer());
});

test('wasm shell reports a real adapter and stable codec fingerprints', async () => {
  expect(await describe_adapter()).toContain('/');
  const report = JSON.parse(codec_conformance());
  expect(report).toHaveProperty('base.png.fnv');
  expect(report).toHaveProperty('base.webp.fnv');
  expect(report).toHaveProperty('base.jpeg.fnv');
});

test('wasm shell renders a deterministic 192x192 PNG', async () => {
  const png = await render_glb_to_image(glb, JSON.stringify({ width: 192, height: 192, format: 'png' }));
  expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(view.getUint32(16)).toBe(192);
  expect(view.getUint32(20)).toBe(192);
  expect(png.byteLength).toBeGreaterThan(1_000);
});
