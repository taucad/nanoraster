import { describe, expect, it } from 'vitest';

import type { WasmRendererHandle } from './wasm-renderer';
import { serializeRenders } from './wasm-renderer';

/**
 * A stand-in enforcing the wasm renderer's real contract: overlapping calls
 * on one handle reject (rust/render-wasm `Shared::checkout`).
 */
const busyHandle = (): WasmRendererHandle => {
  let busy = false;
  const run = async <Value>(result: Value): Promise<Value> => {
    if (busy) {
      throw new Error('gpu: renderer busy: calls on one renderer must be awaited in sequence');
    }
    busy = true;
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
    busy = false;
    return result;
  };
  return {
    render_glb_to_image: () => run(new Uint8Array([1])),
    render_glb_to_images: () => run({ images: [new Uint8Array([2])] }),
  };
};

describe('serializeRenders', () => {
  it('lets several un-awaited tiles share one renderer', async () => {
    const handle = serializeRenders(busyHandle());
    const glb = new Uint8Array([0]);

    // Four tiles mount on one page and render concurrently — the tutorial page shape.
    const results = await Promise.all([
      handle.render_glb_to_image(glb, '{}'),
      handle.render_glb_to_images(glb, '{}'),
      handle.render_glb_to_image(glb, '{}'),
      handle.render_glb_to_image(glb, '{}'),
    ]);

    expect(results).toHaveLength(4);
  });

  it('keeps rendering after one call fails', async () => {
    const inner = busyHandle();
    const handle = serializeRenders({
      ...inner,
      render_glb_to_images: () => Promise.reject(new Error('parse: unexpected glb magic')),
    });
    const glb = new Uint8Array([0]);

    await expect(handle.render_glb_to_images(glb, '{}')).rejects.toThrow('parse');
    await expect(handle.render_glb_to_image(glb, '{}')).resolves.toEqual(new Uint8Array([1]));
  });
});
