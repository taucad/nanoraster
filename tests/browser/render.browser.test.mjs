import { beforeAll, expect, test } from 'vitest';
import init, {
  Renderer,
  codec_conformance,
  describe_adapter,
  render_glb_to_image,
} from 'nanoraster-wasm-candidate';

import { withPbrFactors } from '../pbr-fixture.mjs';

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

test('a warm renderer produces byte-identical output and disposes cleanly', async () => {
  const options = JSON.stringify({ width: 192, height: 192, format: 'png' });
  const oneShot = await render_glb_to_image(glb, options);
  const renderer = await Renderer.create();
  const first = await renderer.render_glb_to_image(glb, options);
  const second = await renderer.render_glb_to_image(glb, options);
  expect(first).toEqual(oneShot);
  expect(second).toEqual(oneShot);

  const batch = await renderer.render_glb_to_images(
    glb,
    JSON.stringify({
      width: 192,
      height: 192,
      format: 'png',
      profile: true,
      views: [
        { id: 'front', phi: 90, theta: 0 },
        { id: 'big', phi: 90, theta: 0, width: 256, height: 256 },
      ],
    }),
  );
  expect(batch.images).toHaveLength(2);
  const profile = JSON.parse(batch.profile ?? '{}');
  expect(profile.adapterDeviceRequests).toBe(0);
  expect(profile.views).toHaveLength(2);

  const pixels = await renderer.render_glb_to_pixels(glb, JSON.stringify({ width: 64, height: 48 }));
  expect(pixels.width).toBe(64);
  expect(pixels.height).toBe(48);
  expect(pixels.rgba.byteLength).toBe(64 * 48 * 4);

  renderer.dispose();
  await expect(renderer.render_glb_to_image(glb, options)).rejects.toThrow('gpu: renderer disposed');
});

test('overlapping calls on one raw renderer reject busy', async () => {
  // The contract the docs demo queue exists for: the raw wasm class refuses
  // concurrency outright, so anything sharing one handle must serialize.
  const options = JSON.stringify({ width: 192, height: 192, format: 'png' });
  const renderer = await Renderer.create();
  const settled = await Promise.allSettled([
    renderer.render_glb_to_image(glb, options),
    renderer.render_glb_to_image(glb, options),
  ]);
  expect(settled[0].status).toBe('fulfilled');
  expect(settled[1].status).toBe('rejected');
  expect(String(settled[1].reason)).toContain('gpu: renderer busy');
  renderer.dispose();
});

test('PBR factors produce deterministic and distinguishable renders', async () => {
  const options = JSON.stringify({ width: 192, height: 192, format: 'png' });
  const matte = withPbrFactors(glb, { metallic: 0, roughness: 0.85 });
  const metal = withPbrFactors(glb, { metallic: 1, roughness: 0.05 });
  const matteFirst = await render_glb_to_image(matte, options);
  const matteSecond = await render_glb_to_image(matte, options);
  const metalFirst = await render_glb_to_image(metal, options);
  const metalSecond = await render_glb_to_image(metal, options);

  expect(matteFirst).toEqual(matteSecond);
  expect(metalFirst).toEqual(metalSecond);
  expect(matteFirst).not.toEqual(metalFirst);
});
