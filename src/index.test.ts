import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderImageOptions } from '#options.js';
import type { RawRendererHandle } from '#renderer.js';
import { createRendererRaw, describeAdapterRaw, isNodeRuntime, renderManyRaw, renderRaw } from '#renderer.js';
import { RenderError, createRenderer, describeAdapter, renderImage, renderImages } from '#index.js';

vi.mock('#renderer.js', () => ({
  renderRaw: vi.fn(),
  renderManyRaw: vi.fn(),
  createRendererRaw: vi.fn(),
  describeAdapterRaw: vi.fn(),
  isNodeRuntime: vi.fn(),
}));

const singular = vi.mocked(renderRaw);
const plural = vi.mocked(renderManyRaw);
const createRaw = vi.mocked(createRendererRaw);
const adapter = vi.mocked(describeAdapterRaw);
const node = vi.mocked(isNodeRuntime);
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const glb = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  singular.mockReset();
  plural.mockReset();
  createRaw.mockReset();
  adapter.mockReset();
  node.mockReset();
});

afterEach(() => {
  if (originalNavigator === undefined) {
    Reflect.deleteProperty(globalThis, 'navigator');
    return;
  }
  Object.defineProperty(globalThis, 'navigator', originalNavigator);
});

describe('renderImage', () => {
  it('should return one named file passing the binding bytes through', async () => {
    const output = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    singular.mockResolvedValue(output);

    const file = await renderImage(glb, { format: 'webp', width: 800 });

    expect(file).toEqual(expect.objectContaining({ name: 'render.webp', mimeType: 'image/webp' }));
    // The binding allocates fresh bytes per call; the façade adds no copy.
    expect(file.bytes).toBe(output);
    // Dimensions are resolved from the request, so the height falls back to
    // the documented default the renderer would have used.
    expect(file.width).toBe(800);
    expect(file.height).toBe(432);
    expect(singular).toHaveBeenCalledWith(glb, JSON.stringify({ format: 'webp', width: 800 }));
  });

  it('should report the default dimensions when the request states none', async () => {
    singular.mockResolvedValue(new Uint8Array([0x89, 0x50]));

    const file = await renderImage(glb, { format: 'png' });

    expect(file.width).toBe(768);
    expect(file.height).toBe(432);
  });

  it('should hand back the frame itself for the raw format', async () => {
    // `format: 'raw'` is the singular raw path: the bytes are the frame, so
    // their length is exactly the resolved shape times four channels.
    const rgba = new Uint8Array(64 * 48 * 4);
    singular.mockResolvedValue(rgba);

    const file = await renderImage(glb, { format: 'raw', width: 64, height: 48 });

    expect(file.name).toBe('render.raw');
    expect(file.mimeType).toBe('application/octet-stream');
    expect(file.bytes).toBe(rgba);
    expect(file.bytes.length).toBe(file.width * file.height * 4);
    expect(singular).toHaveBeenCalledWith(glb, JSON.stringify({ format: 'raw', width: 64, height: 48 }));
  });

  it('should ignore quality on a raw request exactly as png does', async () => {
    singular.mockResolvedValue(new Uint8Array(16 * 16 * 4));

    await expect(
      renderImage(glb, { format: 'raw', width: 16, height: 16, quality: 0.5 }),
    ).resolves.toBeDefined();
    expect(singular).toHaveBeenCalledWith(
      glb,
      JSON.stringify({ format: 'raw', width: 16, height: 16, quality: 0.5 }),
    );
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
    width: 1024,
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
    // No per-view override: every entry reports the shared request's shape.
    expect(results.map(({ file }) => [file.width, file.height])).toEqual([
      [1024, 432],
      [1024, 432],
    ]);
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
    // Per-view dimensions override the shared pair; an absent one falls back
    // through the shared value to the default.
    expect(results.map(({ file }) => [file.width, file.height])).toEqual([
      [768, 432],
      [1536, 432],
    ]);
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

  it('should render a mixed plan of encoded and raw views', async () => {
    // One plan, two output kinds: the thumbnail is encoded and the frame beside
    // it is not, which is the capability collapsing pixels into `format` buys.
    const thumb = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const frame = new Uint8Array(32 * 24 * 4);
    plural.mockResolvedValue({ images: [thumb, frame] });

    const results = await renderImages(glb, {
      format: 'webp',
      width: 32,
      height: 24,
      views: [
        { id: 'thumb', phi: 60, theta: -45 },
        { id: 'frame', phi: 60, theta: -45, format: 'raw' },
      ],
    });

    expect(results.map(({ file }) => file.name)).toEqual(['render-thumb.webp', 'render-frame.raw']);
    expect(results.map(({ file }) => file.mimeType)).toEqual(['image/webp', 'application/octet-stream']);
    expect(results[1].file.bytes.length).toBe(results[1].file.width * results[1].file.height * 4);
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

describe('describeAdapter', () => {
  const stubGpu = (value: unknown): ReturnType<typeof vi.fn> => {
    const requestAdapter = vi.fn(() => Promise.resolve(value));
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { gpu: { requestAdapter } },
    });
    return requestAdapter;
  };

  it('should parse the native structure and wrap failures', async () => {
    node.mockReturnValue(true);
    adapter.mockResolvedValue('{"backend":"metal","name":"Apple M2 Pro","deviceType":"integrated-gpu"}');

    await expect(describeAdapter()).resolves.toEqual({
      backend: 'metal',
      name: 'Apple M2 Pro',
      deviceType: 'integrated-gpu',
    });
    expect(adapter).toHaveBeenCalledWith(undefined);

    adapter.mockRejectedValue(new Error('adapter-unavailable: none'));
    await expect(describeAdapter()).rejects.toMatchObject({ code: 'adapter-unavailable' });
  });

  it('should describe the adapter the requested power preference binds', async () => {
    node.mockReturnValue(true);
    adapter.mockResolvedValue('{"backend":"vulkan","name":"","deviceType":"cpu"}');

    await expect(describeAdapter({ powerPreference: 'low-power' })).resolves.toEqual({
      backend: 'vulkan',
      name: '',
      deviceType: 'cpu',
    });
    expect(adapter).toHaveBeenCalledWith('{"powerPreference":"low-power"}');
  });

  it('should reject options the renderer would reject', async () => {
    node.mockReturnValue(true);

    // @ts-expect-error powerPreference is a closed union
    await expect(describeAdapter({ powerPreference: 'turbo' })).rejects.toMatchObject({
      code: 'parse',
      message: 'parse: powerPreference must be high-performance or low-power',
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it.each([
    ['{"backend":"opengl","name":"","deviceType":"cpu"}'],
    ['{"backend":"metal","name":"","deviceType":"software"}'],
    ['{"backend":"metal","deviceType":"cpu"}'],
  ])('should refuse an unrecognizable native description: %s', async (payload) => {
    node.mockReturnValue(true);
    adapter.mockResolvedValue(payload);

    await expect(describeAdapter()).rejects.toMatchObject({
      code: 'unknown',
      message: `unrecognized adapter description: ${payload}`,
    });
  });

  it.each([
    // Chrome fills vendor and architecture, Firefox blanks every field, and
    // Safari repeats one word across all of them.
    [{ vendor: 'apple', architecture: 'metal-3', description: '' }, 'apple metal-3'],
    [{ vendor: '', architecture: '', description: '' }, ''],
    [{ vendor: 'apple', architecture: 'apple', description: 'apple' }, 'apple'],
  ])('should read the browser adapter without touching the wasm binding: %o', async (info, name) => {
    node.mockReturnValue(false);
    const requestAdapter = stubGpu({ info: { ...info, isFallbackAdapter: false } });

    await expect(describeAdapter()).resolves.toEqual({
      backend: 'webgpu',
      name,
      deviceType: 'unknown',
    });
    expect(requestAdapter).toHaveBeenCalledWith(undefined);
    expect(adapter).not.toHaveBeenCalled();
  });

  it('should read a fallback browser adapter as a cpu device', async () => {
    node.mockReturnValue(false);
    const requestAdapter = stubGpu({
      info: {
        vendor: 'google',
        architecture: 'swiftshader',
        description: '',
        isFallbackAdapter: true,
      },
    });

    await expect(describeAdapter({ powerPreference: 'high-performance' })).resolves.toEqual({
      backend: 'webgpu',
      name: 'google swiftshader',
      deviceType: 'cpu',
    });
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
  });

  it('should report a browser without WebGPU as adapter-unavailable', async () => {
    node.mockReturnValue(false);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });

    await expect(describeAdapter()).rejects.toMatchObject({
      code: 'adapter-unavailable',
      message: 'adapter-unavailable: this environment exposes no navigator.gpu',
    });
  });

  it('should report a browser that hands out no adapter as adapter-unavailable', async () => {
    node.mockReturnValue(false);
    stubGpu(null);

    await expect(describeAdapter()).rejects.toMatchObject({
      code: 'adapter-unavailable',
      message: 'adapter-unavailable: navigator.gpu returned no adapter',
    });
  });
});

describe('createRenderer', () => {
  const makeHandle = () => ({
    renderImage: vi.fn<RawRendererHandle['renderImage']>(),
    renderImages: vi.fn<RawRendererHandle['renderImages']>(),
    trimTargets: vi.fn<RawRendererHandle['trimTargets']>(),
    dispose: vi.fn<RawRendererHandle['dispose']>(),
  });

  it('should forward the power preference and render through one handle', async () => {
    const handle = makeHandle();
    handle.renderImage.mockResolvedValue(new Uint8Array([7]));
    handle.renderImages.mockResolvedValue({ images: [new Uint8Array([8])] });
    createRaw.mockResolvedValue(handle);

    const renderer = await createRenderer({ powerPreference: 'low-power' });
    expect(createRaw).toHaveBeenCalledWith(JSON.stringify({ powerPreference: 'low-power' }));

    const file = await renderer.renderImage(glb, { format: 'png', height: 256 });
    expect(file.name).toBe('render.png');
    expect([file.width, file.height]).toEqual([768, 256]);
    const images = await renderer.renderImages(glb, {
      format: 'webp',
      views: [{ id: 'front', phi: 90, theta: 0, height: 300 }],
    });
    expect(images[0].file.name).toBe('render-front.webp');
    expect([images[0].file.width, images[0].file.height]).toEqual([768, 300]);
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

  it('should wrap plan failures in the taxonomy', async () => {
    const handle = makeHandle();
    handle.renderImages.mockRejectedValue(new Error('gpu: device lost'));
    createRaw.mockResolvedValue(handle);

    const renderer = await createRenderer();
    await expect(
      renderer.renderImages(glb, { format: 'png', views: [{ id: 'front', phi: 90, theta: 0 }] }),
    ).rejects.toMatchObject({ code: 'device-lost' });
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
