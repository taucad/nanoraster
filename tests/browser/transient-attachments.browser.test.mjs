import { beforeAll, expect, test } from 'vitest';
import init, { Renderer } from 'nanoraster-wasm-candidate';
import { physicalMaterial, physicalMaterialGlb } from '../pbr-fixture.mjs';

beforeAll(async () => {
  await init();
});

// Inspect the real initialized device, not the browser version or an API name.
async function supportsTransientAttachments() {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  for (const [format, sampleCount] of [
    ['rgba8unorm-srgb', 4],
    ['rgba16float', 4],
    ['depth32float', 1],
  ]) {
    device.createTexture({ size: [4, 4], format, sampleCount, usage: 48 }).destroy();
  }
  const error = await device.popErrorScope();
  device.destroy();
  return error === null;
}

test('pass-local browser attachments preserve exact output through capability fallback and resizing', async () => {
  const supported = await supportsTransientAttachments();
  // oxlint-disable-next-line typescript/unbound-method -- The wrapper supplies the original device receiver with call() and restores this method in finally.
  const original = globalThis.GPUDevice.prototype.createTexture;
  const gear = new Uint8Array(
    await (await fetch(new URL('../fixtures/gear-12.glb', import.meta.url))).arrayBuffer(),
  );
  const transparent = physicalMaterialGlb({
    alphaMode: 'BLEND',
    pbrMetallicRoughness: { baseColorFactor: [0.5, 0.6, 0.7, 0.5] },
  });
  const transmission = physicalMaterialGlb(physicalMaterial);
  const outputs = [];
  try {
    for (const reject of [false, true]) {
      const descriptors = [];
      let probes = 0;
      globalThis.GPUDevice.prototype.createTexture = function (descriptor) {
        const probe = descriptor.label === 'transient capability probe';
        if (probe) probes++;
        else descriptors.push({ label: descriptor.label, usage: descriptor.usage });
        // Produce a real scoped validation error, without poisoning the device.
        return original.call(this, probe && reject ? { ...descriptor, usage: 0 } : descriptor);
      };
      const renderer = await Renderer.create();
      const images = [];
      try {
        for (const [scene, width] of [
          [gear, 192],
          [transparent, 192],
          [gear, 192],
          [transmission, 192],
          [gear, 257],
          [gear, 192],
        ]) {
          images.push(
            await renderer.render_image(scene, JSON.stringify({ width, height: 192, format: 'raw', ao: {} })),
          );
        }
        expect(probes).toBe(3); // Once per device, never once per request.
        const local = descriptors.filter(({ label }) =>
          ['msaa', 'AO depth test', 'HDR multisample'].includes(label),
        );
        expect(local.length).toBeGreaterThan(3);
        expect(local.some(({ usage }) => (usage & 32) !== 0)).toBe(supported && !reject);
        expect(descriptors.filter(({ label }) => label === 'depth').every(({ usage }) => usage === 16)).toBe(
          true,
        );
        const hdr = descriptors.filter(({ label }) => label === 'HDR multisample');
        expect(hdr.some(({ usage }) => usage === 16)).toBe(true); // Transparency loads opaque samples.
        expect(images[0]).toEqual(images[5]);
      } finally {
        renderer.dispose();
        renderer.free();
      }
      outputs.push(images);
    }
    expect(outputs[0]).toEqual(outputs[1]);
  } finally {
    globalThis.GPUDevice.prototype.createTexture = original;
  }
});
