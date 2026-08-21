import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderImageOptions } from '#options.js';
import type { RawRendererHandle } from '#renderer.js';
import {
  createRendererRaw,
  describeAdapterRaw,
  renderManyRaw,
  renderPixelsRaw,
  renderRaw,
} from '#renderer.js';
import {
  RenderError,
  createRenderer,
  describeAdapter,
  renderImage,
  renderImages,
  renderPixels,
} from '#index.js';

vi.mock('#renderer.js', () => ({
  renderRaw: vi.fn(),
  renderManyRaw: vi.fn(),
  renderPixelsRaw: vi.fn(),
  createRendererRaw: vi.fn(),
  describeAdapterRaw: vi.fn(),
}));

const singular = vi.mocked(renderRaw);
const plural = vi.mocked(renderManyRaw);
const pixels = vi.mocked(renderPixelsRaw);
const createRaw = vi.mocked(createRendererRaw);
const adapter = vi.mocked(describeAdapterRaw);
const glb = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  singular.mockReset();
  plural.mockReset();
  pixels.mockReset();
  createRaw.mockReset();
  adapter.mockReset();
});

describe('renderImage', () => {
  it('should return one named file passing the binding bytes through', async () => {
    const output = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    singular.mockResolvedValue(output);

    const file = await renderImage(glb, { format: 'webp', width: 800 });

    expect(file).toEqual(expect.objectContaining({ name: 'render.webp', mimeType: 'image/webp' }));
    // The binding allocates fresh bytes per call; the façade adds no copy.
    expect(file.bytes).toBe(output);
    expect(singular).toHaveBeenCalledWith(glb, JSON.stringify({ format: 'webp', width: 800 }));
  });

  it('should resolve the jpeg mime type for the jpg alias', async () => {
    singular.mockResolvedValue(new Uint8Array([0xff, 0xd8]));

    const file = await renderImage(glb, { format: 'jpg' });

    expect(file.mimeType).toBe('image/jpeg');
    expect(file.name).toBe('render.jpg');
  });

  it('should reject invalid options before invoking the renderer', async () => {
    const options: RenderImageOptions & { unexpected: boolean } = {
      format: 'png',
      unexpected: true,
    };

    try {
      await renderImage(glb, options);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).code).toBe('parse');
      expect((error as RenderError).message).toBe('parse: options contains unknown property "unexpected"');
    }
    expect(singular).not.toHaveBeenCalled();
  });

  it('should contain a non-Error option validation failure', async () => {
    const options = new Proxy<RenderImageOptions>(
      { format: 'png' },
      {
        ownKeys: () => {
          throw 'singular trap';
        },
      },
    );

    await expect(renderImage(glb, options)).rejects.toMatchObject({
      code: 'parse',
      message: 'parse: singular trap',
    });
  });

  it('should preserve tagged renderer failures', async () => {
    singular.mockRejectedValue(new Error('parse: unexpected glb magic'));

    try {
      await renderImage(glb, { format: 'png' });
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).code).toBe('parse');
      expect((error as RenderError).message).toBe('parse: unexpected glb magic');
    }
  });
});

describe('renderImages', () => {
  const options = {
    format: 'png',
    axes: true,
    scaleBar: true,
    views: [
      { id: 'front', label: 'Front', phi: 90, theta: 0 },
      { id: 'top', label: 'Top', phi: 0, theta: 0 },
    ],
  } as const;

  it('should preserve order, IDs, filenames, and binding bytes', async () => {
    const front = new Uint8Array([1, 2]);
    const top = new Uint8Array([3, 4]);
    plural.mockResolvedValue({ images: [front, top] });

    const results = await renderImages(glb, options);

    expect(results.map(({ id }) => id)).toEqual(['front', 'top']);
    expect(results.map(({ file }) => file.name)).toEqual(['render-front.png', 'render-top.png']);
    expect(results[0].file.bytes).toBe(front);
    expect(results[1].file.bytes).toBe(top);
    expect('timings' in results).toBe(false);
    expect(plural).toHaveBeenCalledOnce();
  });

  it('should name and type each entry by its own format override', async () => {
    plural.mockResolvedValue({ images: [new Uint8Array([1]), new Uint8Array([2])] });

    const results = await renderImages(glb, {
      format: 'webp',
      views: [
        { id: 'card', phi: 60, theta: -45 },
        { id: 'hero', phi: 60, theta: -45, width: 1536, format: 'png' },
      ],
    });

    expect(results.map(({ file }) => file.name)).toEqual(['render-card.webp', 'render-hero.png']);
    expect(results.map(({ file }) => file.mimeType)).toEqual(['image/webp', 'image/png']);
    expect(plural).toHaveBeenCalledWith(
      glb,
      JSON.stringify({
        format: 'webp',
        views: [
          { id: 'card', phi: 60, theta: -45 },
          { id: 'hero', phi: 60, theta: -45, width: 1536, format: 'png' },
        ],
      }),
    );
  });

  it('should attach the parsed timings when the call requested them', async () => {
    plural.mockResolvedValue({
      images: [new Uint8Array([1])],
      timings: JSON.stringify({
        parse: 0.5,
        setup: 2,
        peakReadbackBytes: 4,
        views: [{ id: 'front', render: 1, overlay: 0, encode: 3 }],
      }),
    });

    const results = await renderImages(glb, {
      format: 'png',
      timings: true,
      views: [{ id: 'front', phi: 90, theta: 0 }],
    });

    expect(results.timings).toEqual({
      parse: 0.5,
      setup: 2,
      views: [{ id: 'front', render: 1, overlay: 0, encode: 3 }],
    });
    expect(results[0].file.name).toBe('render-front.png');
  });

  it('should reject cardinality mismatches atomically', async () => {
    plural.mockResolvedValue({ images: [new Uint8Array([1])] });

    try {
      await renderImages(glb, options);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).code).toBe('unknown');
      expect((error as RenderError).message).toBe(
        'renderer contract violation: expected 2 images, received 1',
      );
    }
  });

  it('should reject invalid batch options before invoking the renderer', async () => {
    await expect(
      renderImages(glb, {
        format: 'png',
        axes: true,
        views: [{ id: 'front', phi: 90, theta: 0, width: 191 }],
      } as never),
    ).rejects.toMatchObject({
      code: 'parse',
      message: 'parse: views[0]: annotated images must be at least 192x192',
    });
    expect(plural).not.toHaveBeenCalled();
  });

  it('should preserve a view-qualified renderer failure', async () => {
    plural.mockRejectedValue(new Error('gpu: view "top": device lost'));

    try {
      await renderImages(glb, options);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).code).toBe('device-lost');
      expect((error as RenderError).message).toBe('gpu: view "top": device lost');
    }
  });

  it('should contain a non-Error batch validation failure', async () => {
    const trapped = new Proxy(options, {
      ownKeys: () => {
        throw 'batch trap';
      },
    });

    await expect(renderImages(glb, trapped)).rejects.toMatchObject({
      code: 'parse',
      message: 'parse: batch trap',
    });
  });
});

describe('renderPixels', () => {
  it('should return the raw pixels and reject encoder options', async () => {
    const rgba = new Uint8Array([1, 2, 3, 4]);
    pixels.mockResolvedValue({ rgba, width: 1, height: 1 });

    const result = await renderPixels(glb, { width: 640, phi: 45 });

    expect(result).toEqual({ rgba, width: 1, height: 1 });
    expect(pixels).toHaveBeenCalledWith(glb, JSON.stringify({ width: 640, phi: 45 }));

    await expect(renderPixels(glb, { format: 'png' } as never)).rejects.toMatchObject({
      code: 'parse',
      message: 'parse: options contains unknown property "format"',
    });
  });

  it('should preserve tagged renderer failures', async () => {
    pixels.mockRejectedValue(new Error('adapter-unavailable: no adapter'));

    await expect(renderPixels(glb, {})).rejects.toMatchObject({
      code: 'adapter-unavailable',
    });
  });

  it('should contain a non-Error option validation failure', async () => {
    const options = new Proxy(
      {},
      {
        ownKeys: () => {
          throw 'pixels trap';
        },
      },
    );

    await expect(renderPixels(glb, options)).rejects.toMatchObject({
      code: 'parse',
      message: 'parse: pixels trap',
    });
  });
});

describe('describeAdapter', () => {
  it('should pass the description through and wrap failures', async () => {
    adapter.mockResolvedValue('Metal / Apple M2 Pro (IntegratedGpu)');
    await expect(describeAdapter()).resolves.toBe('Metal / Apple M2 Pro (IntegratedGpu)');

    adapter.mockRejectedValue(new Error('adapter-unavailable: none'));
    await expect(describeAdapter()).rejects.toMatchObject({ code: 'adapter-unavailable' });
  });
});

describe('createRenderer', () => {
  const makeHandle = () => ({
    renderImage: vi.fn<RawRendererHandle['renderImage']>(),
    renderImages: vi.fn<RawRendererHandle['renderImages']>(),
    renderPixels: vi.fn<RawRendererHandle['renderPixels']>(),
    trimTargets: vi.fn<RawRendererHandle['trimTargets']>(),
    dispose: vi.fn<RawRendererHandle['dispose']>(),
  });

  it('should forward the power preference and render through one handle', async () => {
    const handle = makeHandle();
    handle.renderImage.mockResolvedValue(new Uint8Array([7]));
    handle.renderImages.mockResolvedValue({ images: [new Uint8Array([8])] });
    handle.renderPixels.mockResolvedValue({ rgba: new Uint8Array([9]), width: 1, height: 1 });
    createRaw.mockResolvedValue(handle);

    const renderer = await createRenderer({ powerPreference: 'low-power' });
    expect(createRaw).toHaveBeenCalledWith(JSON.stringify({ powerPreference: 'low-power' }));

    const file = await renderer.renderImage(glb, { format: 'png' });
    expect(file.name).toBe('render.png');
    const images = await renderer.renderImages(glb, {
      format: 'webp',
      views: [{ id: 'front', phi: 90, theta: 0 }],
    });
    expect(images[0].file.name).toBe('render-front.webp');
    const raw = await renderer.renderPixels(glb, {});
    expect(raw.width).toBe(1);
    expect(singular).not.toHaveBeenCalled();
    expect(plural).not.toHaveBeenCalled();
  });

  it('should omit the options JSON when no preference is given', async () => {
    createRaw.mockResolvedValue(makeHandle());

    await createRenderer();
    expect(createRaw).toHaveBeenCalledWith(undefined);

    await createRenderer({});
    expect(createRaw).toHaveBeenLastCalledWith(undefined);
  });

  it('should reject invalid creation options without touching the binding', async () => {
    await expect(createRenderer({ powerPreference: 'turbo' } as never)).rejects.toMatchObject({
      code: 'parse',
      message: 'parse: powerPreference must be high-performance or low-power',
    });
    await expect(createRenderer({ battery: true } as never)).rejects.toMatchObject({
      code: 'parse',
      message: 'parse: options contains unknown property "battery"',
    });
    await expect(createRenderer(null as never)).rejects.toMatchObject({
      code: 'parse',
      message: 'parse: options must be an object',
    });
    const trapped = new Proxy(
      {},
      {
        ownKeys: () => {
          throw 'renderer trap';
        },
      },
    );
    await expect(createRenderer(trapped)).rejects.toMatchObject({
      code: 'parse',
      message: 'parse: renderer trap',
    });
    expect(createRaw).not.toHaveBeenCalled();
  });

  it('should run calls in sequence on one renderer', async () => {
    const handle = makeHandle();
    const order: string[] = [];
    let releaseFirst = (): void => {};
    handle.renderImage
      .mockImplementationOnce(async () => {
        order.push('first:start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push('first:end');
        return new Uint8Array([1]);
      })
      .mockImplementationOnce(async () => {
        order.push('second');
        return new Uint8Array([2]);
      });
    createRaw.mockResolvedValue(handle);

    const renderer = await createRenderer();
    const first = renderer.renderImage(glb, { format: 'png' });
    const second = renderer.renderImage(glb, { format: 'png' });
    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('should keep rendering after one call fails', async () => {
    const handle = makeHandle();
    handle.renderImage
      .mockRejectedValueOnce(new Error('encode: transparent jpeg'))
      .mockResolvedValueOnce(new Uint8Array([1]));
    createRaw.mockResolvedValue(handle);

    const renderer = await createRenderer();
    await expect(renderer.renderImage(glb, { format: 'jpeg' })).rejects.toMatchObject({
      code: 'encode',
    });
    await expect(renderer.renderImage(glb, { format: 'png' })).resolves.toMatchObject({
      name: 'render.png',
    });
  });

  it('should wrap plan and pixels failures in the taxonomy', async () => {
    const handle = makeHandle();
    handle.renderImages.mockRejectedValue(new Error('gpu: device lost'));
    handle.renderPixels.mockRejectedValue(new Error('parse: unexpected glb magic'));
    createRaw.mockResolvedValue(handle);

    const renderer = await createRenderer();
    await expect(
      renderer.renderImages(glb, { format: 'png', views: [{ id: 'front', phi: 90, theta: 0 }] }),
    ).rejects.toMatchObject({ code: 'device-lost' });
    await expect(renderer.renderPixels(glb, {})).rejects.toMatchObject({ code: 'parse' });
  });

  it('should dispose after in-flight calls settle and reject later calls', async () => {
    const handle = makeHandle();
    let release = (): void => {};
    handle.renderImage.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Uint8Array([1]);
    });
    createRaw.mockResolvedValue(handle);

    const renderer = await createRenderer();
    const inFlight = renderer.renderImage(glb, { format: 'png' });
    await Promise.resolve();
    renderer.dispose();
    expect(handle.dispose).not.toHaveBeenCalled();

    const late = renderer.renderImage(glb, { format: 'png' });
    release();
    await inFlight;
    await expect(late).rejects.toMatchObject({
      code: 'gpu',
      message: 'gpu: renderer disposed',
    });
    await Promise.resolve();
    expect(handle.dispose).toHaveBeenCalledOnce();

    // Dispose is idempotent, and Symbol.dispose aliases it.
    renderer.dispose();
    renderer[Symbol.dispose]();
    await Promise.resolve();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });

  it('should wrap creation failures in the taxonomy', async () => {
    createRaw.mockRejectedValue(new Error('adapter-unavailable: no adapter'));

    await expect(createRenderer()).rejects.toMatchObject({ code: 'adapter-unavailable' });
  });
});
