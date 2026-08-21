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
      renderGlbToImage: vi.fn(() => Promise.resolve(new Uint8Array([21]))),
      renderGlbToImages: vi.fn(() => Promise.resolve({ images: [new Uint8Array([22])], profile: null })),
      renderGlbToPixels: vi.fn(() => Promise.resolve({ rgba: new Uint8Array([23]), width: 1, height: 1 })),
      dispose: vi.fn(),
    };
    const native = {
      renderGlbToImage: vi.fn(() => new Uint8Array([1, 2])),
      renderGlbToImages: vi.fn(() => ({ images: [new Uint8Array([3]), new Uint8Array([4])], profile: null })),
      renderGlbToPixels: vi.fn(() => ({ rgba: new Uint8Array([5]), width: 1, height: 1 })),
      createRenderer: vi.fn(() => Promise.resolve(nativeRenderer)),
      describeAdapter: vi.fn(() => 'Metal / Test (IntegratedGpu)'),
    };
    const require = vi.fn(() => native);
    vi.doMock('node:module', () => ({ createRequire: vi.fn(() => require) }));
    const { createRendererRaw, describeAdapterRaw, renderManyRaw, renderPixelsRaw, renderRaw } =
      await import('#renderer.js');
    const glb = new Uint8Array([9]);

    await expect(renderRaw(glb, '{}')).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(renderManyRaw(glb, '{"views":[]}')).resolves.toEqual({
      images: [new Uint8Array([3]), new Uint8Array([4])],
    });
    await expect(renderPixelsRaw(glb, '{}')).resolves.toEqual({
      rgba: new Uint8Array([5]),
      width: 1,
      height: 1,
    });
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
    handle.dispose();
    expect(nativeRenderer.dispose).toHaveBeenCalledOnce();
    expect(require).toHaveBeenCalledOnce();
    expect(require).toHaveBeenCalledWith('nanoraster-darwin-arm64');
  });

  it('loads and initializes the WASM package when WebGPU is exposed', async () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: {} } });
    const initialize = vi.fn((_options: { module_or_path: URL }) => Promise.resolve(undefined));
    const renderImage = vi.fn(() => Promise.resolve(new Uint8Array([5])));
    const renderImages = vi.fn(() =>
      Promise.resolve({ images: [new Uint8Array([6])], profile: 'profile-json' }),
    );
    const wasmRenderer = {
      render_glb_to_image: vi.fn(() => Promise.resolve(new Uint8Array([31]))),
      render_glb_to_images: vi.fn(() => Promise.resolve({ images: [new Uint8Array([32])] })),
      render_glb_to_pixels: vi.fn(() => Promise.resolve({ rgba: new Uint8Array([33]), width: 1, height: 1 })),
      dispose: vi.fn(),
    };
    const create = vi.fn(() => Promise.resolve(wasmRenderer));
    vi.doMock('./wasm/render_wasm.js', () => ({
      default: initialize,
      render_glb_to_image: renderImage,
      render_glb_to_images: renderImages,
      render_glb_to_pixels: vi.fn(() => Promise.resolve({ rgba: new Uint8Array([7]), width: 1, height: 1 })),
      describe_adapter: vi.fn(() => Promise.resolve('WebGPU / Test (Other)')),
      Renderer: { create },
    }));
    const { createRendererRaw, describeAdapterRaw, renderManyRaw, renderPixelsRaw, renderRaw } =
      await import('#renderer.js');
    const glb = new Uint8Array([9]);

    await expect(renderRaw(glb, '{}')).resolves.toEqual(new Uint8Array([5]));
    await expect(renderManyRaw(glb, '{}')).resolves.toEqual({
      images: [new Uint8Array([6])],
      profile: 'profile-json',
    });
    await expect(renderPixelsRaw(glb, '{}')).resolves.toEqual({
      rgba: new Uint8Array([7]),
      width: 1,
      height: 1,
    });
    await expect(describeAdapterRaw()).resolves.toBe('WebGPU / Test (Other)');

    const handle = await createRendererRaw(undefined);
    expect(create).toHaveBeenCalledWith(undefined);
    await expect(handle.renderImage(glb, '{}')).resolves.toEqual(new Uint8Array([31]));
    await expect(handle.renderImages(glb, '{}')).resolves.toEqual({ images: [new Uint8Array([32])] });
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
