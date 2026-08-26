import { beforeAll, expect, test } from 'vitest';
import * as candidate from 'nanoraster-wasm-candidate';
import init, { Renderer, render_image } from 'nanoraster-wasm-candidate';
import initBench, { codec_conformance, render_image as renderImageBench } from 'nanoraster-wasm-bench';
import { RenderError, renderImage } from 'nanoraster';

import { describeAdapter } from '../../src/describe-adapter.ts';
import { withPbrFactors } from '../pbr-fixture.mjs';

let glb;

beforeAll(async () => {
  expect(navigator.gpu, 'WebGPU must be enabled for every supported browser').toBeDefined();
  await init();
  await initBench();
  const response = await fetch(new URL('../fixtures/gear-12.glb', import.meta.url));
  expect(response.ok).toBe(true);
  glb = new Uint8Array(await response.arrayBuffer());
});

test('the façade describes the adapter without loading the wasm', async () => {
  // Pure TypeScript over `navigator.gpu`: no browser tells us the device
  // class, so only a fallback adapter (Chromium under --enable-unsafe-webgpu)
  // may report `cpu`.
  // Having no adapter is a value rather than a throw, so a browser that hands
  // one out must still describe it in the published shape.
  for (const options of [undefined, { powerPreference: 'low-power' }]) {
    const adapter = await describeAdapter(options);
    if (adapter === undefined) continue;
    expect(adapter.backend).toBe('webgpu');
    expect(typeof adapter.name).toBe('string');
    expect(['cpu', 'unknown']).toContain(adapter.deviceType);
  }
});

test('the shipped wasm drops the bench surface and renders as its sibling does', async () => {
  // Q4's accepted trade: the fingerprints come from a `bench`-enabled sibling
  // build, so the shipped artifact must both lack that surface and produce the
  // same bytes as the build the gate measures.
  for (const gated of ['bench_codecs', 'bench_multi_view', 'codec_conformance']) {
    expect(candidate[gated], `shipped wasm exports the gated ${gated}`).toBeUndefined();
  }

  // The other half of the native↔wasm byte-identity gate: the same committed
  // table `render-core`'s own suite asserts against, so a codec that drifts on
  // either artifact fails CI rather than being asserted in a comment.
  const expected = await (await fetch(new URL('../codec-conformance.json', import.meta.url))).json();
  expect(JSON.parse(codec_conformance())).toEqual(expected);

  const options = JSON.stringify({ width: 192, height: 192, format: 'png' });
  expect(await render_image(glb, options)).toEqual(await renderImageBench(glb, options));
});

test('wasm shell renders a deterministic 192x192 PNG', async () => {
  const options = { width: 192, height: 192, format: 'png' };
  const png = await render_image(glb, JSON.stringify(options));
  expect(png).toEqual(await render_image(glb, JSON.stringify({ ...options, lineWidth: 2 })));
  expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect(view.getUint32(16)).toBe(192);
  expect(view.getUint32(20)).toBe(192);
  expect(png.byteLength).toBeGreaterThan(1_000);
});

test('fitted perspective keeps field of view effective above sixty degrees', async () => {
  const renderAt = (verticalFieldOfView) =>
    render_image(
      glb,
      JSON.stringify({
        width: 192,
        height: 192,
        format: 'raw',
        camera: {
          framing: 'fit',
          direction: [0.6123724357, 0.5, 0.6123724357],
          projection: { kind: 'perspective', verticalFieldOfView },
        },
      }),
    );

  expect(await renderAt(120)).not.toEqual(await renderAt(60));
});

test('a warm renderer produces byte-identical output and disposes cleanly', async () => {
  const options = JSON.stringify({ width: 192, height: 192, format: 'png' });
  const oneShot = await render_image(glb, options);
  const renderer = await Renderer.create();
  const first = await renderer.render_image(glb, options);
  const second = await renderer.render_image(glb, options);
  expect(first).toEqual(oneShot);
  expect(second).toEqual(oneShot);

  const batch = await renderer.render_images(
    glb,
    JSON.stringify({
      width: 192,
      height: 192,
      format: 'png',
      timings: true,
      views: [
        { id: 'front', camera: { framing: 'fit', direction: [1, 0, 0] } },
        { id: 'big', camera: { framing: 'fit', direction: [1, 0, 0] }, width: 256, height: 256 },
      ],
    }),
  );
  expect(batch.images).toHaveLength(2);
  const timings = JSON.parse(batch.timings ?? '{}');
  expect(timings.adapterDeviceRequests).toBe(0);
  expect(timings.views).toHaveLength(2);
  expect(typeof timings.parse).toBe('number');
  expect(typeof timings.views[0].encode).toBe('number');

  // The one-shot façade's retention guard: trimming keeps the device warm and
  // changes no pixels, whether or not anything was retained.
  renderer.trim_targets();
  expect(await renderer.render_image(glb, options)).toEqual(oneShot);

  // `format: 'raw'` is the fourth output format rather than a separate entry
  // point: the bytes are the frame itself, so their length is the shape times
  // four channels, and a mixed plan carries one of each kind.
  const raw = await renderer.render_image(glb, JSON.stringify({ width: 64, height: 48, format: 'raw' }));
  expect(raw.byteLength).toBe(64 * 48 * 4);
  const mixed = await renderer.render_images(
    glb,
    JSON.stringify({
      width: 64,
      height: 48,
      format: 'webp',
      quality: 1,
      views: [{ id: 'thumb' }, { id: 'frame', format: 'raw' }],
    }),
  );
  expect(mixed.images).toHaveLength(2);
  expect([...mixed.images[0].subarray(0, 4)]).toEqual([...new TextEncoder().encode('RIFF')]);
  expect(mixed.images[1]).toEqual(raw);

  renderer.dispose();
  await expect(renderer.render_image(glb, options)).rejects.toThrow('gpu: renderer disposed');
});

test('overlapping calls on one raw renderer reject busy', async () => {
  // The contract the docs demo queue exists for: the raw wasm class refuses
  // concurrency outright, so anything sharing one handle must serialize.
  const options = JSON.stringify({ width: 192, height: 192, format: 'png' });
  const renderer = await Renderer.create();
  const settled = await Promise.allSettled([
    renderer.render_image(glb, options),
    renderer.render_image(glb, options),
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
  const matteFirst = await render_image(matte, options);
  const matteSecond = await render_image(matte, options);
  const metalFirst = await render_image(metal, options);
  const metalSecond = await render_image(metal, options);

  expect(matteFirst).toEqual(matteSecond);
  expect(metalFirst).toEqual(metalSecond);
  expect(matteFirst).not.toEqual(metalFirst);
});

test('should render deterministically through the packed public façade', async () => {
  // `vitest.browser.config.ts` aliases `nanoraster` straight at the frozen
  // tarball's `dist/index.mjs` — the universal entry a browser bundler picks —
  // so this runs the shipped bytes and proves they carry no Node builtin a
  // browser cannot load.
  const options = { width: 192, height: 192, format: 'png' };
  const first = await renderImage(glb, options);
  const second = await renderImage(glb, options);

  expect(first.name).toBe('render.png');
  expect(first.mimeType).toBe('image/png');
  expect(first.width).toBe(192);
  expect(first.height).toBe(192);
  expect([...first.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(second.bytes).toEqual(first.bytes);
});

test('should reject a malformed GLB with a parse error through the packed public façade', async () => {
  const notAGlb = new Uint8Array([1, 2, 3, 4]);

  try {
    await renderImage(notAGlb, { width: 64, height: 64, format: 'png' });
    expect.fail('a malformed GLB must not render');
  } catch (error) {
    expect(error).toBeInstanceOf(RenderError);
    expect(error.code).toBe('parse');
    expect(error.isGpuFault).toBe(false);
  }
});
