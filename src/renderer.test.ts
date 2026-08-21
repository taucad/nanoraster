import { afterEach, describe, expect, it, vi } from 'vitest';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArchitecture = Object.getOwnPropertyDescriptor(process, 'arch');

const restoreProperty = (
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void => {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
    return;
  }
  Object.defineProperty(target, key, descriptor);
};

afterEach(() => {
  restoreProperty(globalThis, 'navigator', originalNavigator);
  restoreProperty(process, 'platform', originalPlatform);
  restoreProperty(process, 'arch', originalArchitecture);
  vi.doUnmock('node:module');
  vi.doUnmock('./wasm/render_wasm.js');
  vi.resetModules();
});

describe('nativePackageName', () => {
  it('maps every published native target and rejects the rest', async () => {
    const { nativePackageName } = await import('#renderer.js');

    expect(nativePackageName('darwin', 'arm64')).toBe('nanoraster-darwin-arm64');
    expect(nativePackageName('linux', 'x64')).toBe('nanoraster-linux-x64-gnu');
    expect(nativePackageName('win32', 'x64')).toBe('nanoraster-win32-x64-msvc');
    expect(nativePackageName('freebsd', 'x64')).toBeUndefined();
  });
});

describe('renderer binding selection', () => {
  it('loads and caches the native package in Node', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    Object.defineProperty(process, 'arch', { configurable: true, value: 'arm64' });
    const nativeRenderer = {
      renderImage: vi.fn(() => Promise.resolve(new Uint8Array([21]))),
      renderImages: vi.fn(() => Promise.resolve({ images: [new Uint8Array([22])], timings: null })),
      renderPixels: vi.fn(() => Promise.resolve({ rgba: new Uint8Array([23]), width: 1, height: 1 })),
      trimTargets: vi.fn(),
      dispose: vi.fn(),
    };
    const native = {
      createRenderer: vi.fn(() => Promise.resolve(nativeRenderer)),
      describeAdapter: vi.fn(() => 'Metal / Test (IntegratedGpu)'),
    };
    const require = vi.fn(() => native);
    vi.doMock('node:module', () => ({ createRequire: vi.fn(() => require) }));
    const { createRendererRaw, describeAdapterRaw } = await import('#renderer.js');
    const glb = new Uint8Array([9]);

    await expect(describeAdapterRaw()).resolves.toBe('Metal / Test (IntegratedGpu)');

    const handle = await createRendererRaw('{"powerPreference":"low-power"}');
    expect(native.createRenderer).toHaveBeenCalledWith('{"powerPreference":"low-power"}');
    await expect(handle.renderImage(glb, '{}')).resolves.toEqual(new Uint8Array([21]));
    await expect(handle.renderImages(glb, '{}')).resolves.toEqual({ images: [new Uint8Array([22])] });
    await expect(handle.renderPixels(glb, '{}')).resolves.toEqual({
      rgba: new Uint8Array([23]),
      width: 1,
      height: 1,
    });
    handle.trimTargets();
    expect(nativeRenderer.trimTargets).toHaveBeenCalledOnce();
    handle.dispose();
    expect(nativeRenderer.dispose).toHaveBeenCalledOnce();
    expect(require).toHaveBeenCalledOnce();
    expect(require).toHaveBeenCalledWith('nanoraster-darwin-arm64');
  });

  it('loads and initializes the WASM package when WebGPU is exposed', async () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: {} } });
    const initialize = vi.fn((_options: { module_or_path: URL }) => Promise.resolve(undefined));
    const wasmRenderer = {
      render_image: vi.fn(() => Promise.resolve(new Uint8Array([31]))),
      render_images: vi.fn(() =>
        Promise.resolve({ images: [new Uint8Array([32])], timings: 'timings-json' }),
      ),
      render_pixels: vi.fn(() => Promise.resolve({ rgba: new Uint8Array([33]), width: 1, height: 1 })),
      trim_targets: vi.fn(),
      dispose: vi.fn(),
    };
    const create = vi.fn(() => Promise.resolve(wasmRenderer));
    vi.doMock('./wasm/render_wasm.js', () => ({
      default: initialize,
      describe_adapter: vi.fn(() => Promise.resolve('WebGPU / Test (Other)')),
      Renderer: { create },
    }));
    const { createRendererRaw, describeAdapterRaw, renderManyRaw, renderPixelsRaw, renderRaw } =
      await import('#renderer.js');
    const glb = new Uint8Array([9]);

    // The browser artifact shares one renderer for one-shot calls too.
    await expect(renderRaw(glb, '{}')).resolves.toEqual(new Uint8Array([31]));
    await expect(renderManyRaw(glb, '{}')).resolves.toEqual({
      images: [new Uint8Array([32])],
      timings: 'timings-json',
    });
    await expect(renderPixelsRaw(glb, '{}')).resolves.toEqual({
      rgba: new Uint8Array([33]),
      width: 1,
      height: 1,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(wasmRenderer.trim_targets).toHaveBeenCalledTimes(3);
    await expect(describeAdapterRaw()).resolves.toBe('WebGPU / Test (Other)');

    const handle = await createRendererRaw(undefined);
    expect(create).toHaveBeenLastCalledWith(undefined);
    await expect(handle.renderImage(glb, '{}')).resolves.toEqual(new Uint8Array([31]));
    await expect(handle.renderImages(glb, '{}')).resolves.toEqual({
      images: [new Uint8Array([32])],
      timings: 'timings-json',
    });
    await expect(handle.renderPixels(glb, '{}')).resolves.toEqual({
      rgba: new Uint8Array([33]),
      width: 1,
      height: 1,
    });
    handle.dispose();
    expect(wasmRenderer.dispose).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith({ module_or_path: expect.any(URL) });
    expect(initialize.mock.calls[0]?.[0].module_or_path.pathname.endsWith('/wasm/render_wasm_bg.wasm')).toBe(
      true,
    );
  });

  it('shares one lazy renderer across concurrent one-shot calls', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    Object.defineProperty(process, 'arch', { configurable: true, value: 'arm64' });
    // Mirrors the wasm class contract: overlapping calls on one renderer are a
    // hard error, so an unserialized façade fails loudly here.
    let busy = false;
    const serialized = async <Value>(value: Value): Promise<Value> => {
      if (busy) {
        throw new Error('gpu: renderer busy');
      }
      busy = true;
      await Promise.resolve();
      busy = false;
      return value;
    };
    const nativeRenderer = {
      renderImage: vi.fn(() => serialized(new Uint8Array([21]))),
      renderImages: vi.fn(() => serialized({ images: [new Uint8Array([22])], timings: null })),
      renderPixels: vi.fn(() => serialized({ rgba: new Uint8Array([23]), width: 1, height: 1 })),
      trimTargets: vi.fn(),
      dispose: vi.fn(),
    };
    const native = {
      renderImage: vi.fn(() => Promise.resolve(new Uint8Array([1]))),
      renderImages: vi.fn(() => Promise.resolve({ images: [new Uint8Array([2])], timings: null })),
      renderPixels: vi.fn(() => Promise.resolve({ rgba: new Uint8Array([3]), width: 9, height: 9 })),
      createRenderer: vi.fn(() => Promise.resolve(nativeRenderer)),
      describeAdapter: vi.fn(() => 'Metal / Test (IntegratedGpu)'),
    };
    vi.doMock('node:module', () => ({ createRequire: vi.fn(() => vi.fn(() => native)) }));
    const { renderManyRaw, renderPixelsRaw, renderRaw } = await import('#renderer.js');
    const glb = new Uint8Array([9]);

    await expect(
      Promise.all([
        renderRaw(glb, '{}'),
        renderManyRaw(glb, '{"views":[]}'),
        renderPixelsRaw(glb, '{}'),
        renderRaw(glb, '{}'),
      ]),
    ).resolves.toEqual([
      new Uint8Array([21]),
      { images: [new Uint8Array([22])] },
      { rgba: new Uint8Array([23]), width: 1, height: 1 },
      new Uint8Array([21]),
    ]);
    expect(native.createRenderer).toHaveBeenCalledOnce();
    expect(native.createRenderer).toHaveBeenCalledWith(undefined);
    expect(native.renderImage).not.toHaveBeenCalled();
    // The one-shot guard runs after every call, so an oversized target set
    // never outlives the render that needed it.
    expect(nativeRenderer.trimTargets).toHaveBeenCalledTimes(4);
  });

  it('retries the shared renderer after a failed bring-up', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    Object.defineProperty(process, 'arch', { configurable: true, value: 'arm64' });
    const nativeRenderer = {
      renderImage: vi.fn(() => Promise.resolve(new Uint8Array([21]))),
      renderImages: vi.fn(),
      renderPixels: vi.fn(),
      trimTargets: vi.fn(),
      dispose: vi.fn(),
    };
    const createRenderer = vi
      .fn()
      .mockRejectedValueOnce(new Error('gpu: request_device failed'))
      .mockResolvedValueOnce(nativeRenderer);
    vi.doMock('node:module', () => ({
      createRequire: vi.fn(() => vi.fn(() => ({ createRenderer, describeAdapter: vi.fn() }))),
    }));
    const { renderRaw } = await import('#renderer.js');
    const glb = new Uint8Array([9]);

    await expect(renderRaw(glb, '{}')).rejects.toThrow('gpu: request_device failed');
    await expect(renderRaw(glb, '{}')).resolves.toEqual(new Uint8Array([21]));
    expect(createRenderer).toHaveBeenCalledTimes(2);
  });

  it('reports an unpublished native target without attempting require', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'freebsd' });
    Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' });
    const require = vi.fn();
    vi.doMock('node:module', () => ({ createRequire: vi.fn(() => require) }));
    const { renderRaw } = await import('#renderer.js');

    await expect(renderRaw(new Uint8Array(0), '{}')).rejects.toMatchObject({
      code: 'adapter-unavailable',
      message: 'native render addon is not published for freebsd-x64',
    });
    expect(require).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('missing'), 'missing'],
    ['raw failure', 'raw failure'],
  ])('contains a failed native package load: %#', async (failure, detail) => {
    vi.doMock('node:module', () => ({
      createRequire: vi.fn(() => () => {
        throw failure;
      }),
    }));
    const { renderRaw } = await import('#renderer.js');

    await expect(renderRaw(new Uint8Array(0), '{}')).rejects.toMatchObject({
      code: 'adapter-unavailable',
      message: expect.stringContaining(detail),
    });
  });
});
