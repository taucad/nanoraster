import { afterEach, describe, expect, it, vi } from 'vitest';

import { RenderError } from '#render-error.js';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

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

const exposeWebGpu = (): void => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: {} } });
};

afterEach(() => {
  restoreProperty(globalThis, 'navigator', originalNavigator);
  vi.doUnmock('./wasm/render_wasm.js');
  vi.resetModules();
});

describe('native backend installation', () => {
  it('should route to the addon only once a backend is installed and no WebGPU is exposed', async () => {
    const { installNativeBackend, usesNativeBackend } = await import('#renderer.js');

    expect(usesNativeBackend()).toBe(false);

    installNativeBackend(async () => ({ createRenderer: vi.fn(), describeAdapter: vi.fn() }));
    expect(usesNativeBackend()).toBe(true);

    exposeWebGpu();
    expect(usesNativeBackend()).toBe(false);
  });

  it('should reject the adapter probe with adapter-unavailable when no backend is installed', async () => {
    const { describeAdapterRaw } = await import('#renderer.js');

    try {
      await describeAdapterRaw(undefined);
      expect.fail('the universal entry point has no addon to probe');
    } catch (error) {
      expect((error as Error).name).toBe('RenderError');
      expect((error as { code: string }).code).toBe('adapter-unavailable');
      expect((error as Error).message).toContain('no native addon is installed');
    }
  });
});

describe('renderer binding selection', () => {
  it('should load and cache the installed addon in Node', async () => {
    const nativeRenderer = {
      renderImage: vi.fn(() => Promise.resolve(new Uint8Array([21]))),
      renderImages: vi.fn(() => Promise.resolve({ images: [new Uint8Array([22])], timings: null })),
      trimTargets: vi.fn(),
      dispose: vi.fn(),
    };
    const native = {
      createRenderer: vi.fn(() => Promise.resolve(nativeRenderer)),
      describeAdapter: vi.fn(async () => '{"backend":"metal","name":"Test","deviceType":"integrated-gpu"}'),
    };
    const load = vi.fn(async () => native);
    const { createRendererRaw, describeAdapterRaw, installNativeBackend } = await import('#renderer.js');
    installNativeBackend(load);
    const glb = new Uint8Array([9]);

    await expect(describeAdapterRaw('{"powerPreference":"low-power"}')).resolves.toBe(
      '{"backend":"metal","name":"Test","deviceType":"integrated-gpu"}',
    );
    expect(native.describeAdapter).toHaveBeenCalledWith('{"powerPreference":"low-power"}');

    const handle = await createRendererRaw('{"powerPreference":"low-power"}');
    expect(native.createRenderer).toHaveBeenCalledWith('{"powerPreference":"low-power"}');
    await expect(handle.renderImage(glb, '{}')).resolves.toEqual(new Uint8Array([21]));
    await expect(handle.renderImages(glb, '{}')).resolves.toEqual({ images: [new Uint8Array([22])] });
    handle.trimTargets();
    expect(nativeRenderer.trimTargets).toHaveBeenCalledOnce();
    handle.dispose();
    expect(nativeRenderer.dispose).toHaveBeenCalledOnce();
    // The addon is loaded once and memoized across the probe and the renderer.
    expect(load).toHaveBeenCalledOnce();
  });

  it('should load and initialize the WASM package when WebGPU is exposed', async () => {
    exposeWebGpu();
    const initialize = vi.fn((_options: { module_or_path: URL }) => Promise.resolve(undefined));
    const wasmRenderer = {
      render_image: vi.fn(() => Promise.resolve(new Uint8Array([31]))),
      render_images: vi.fn(() =>
        Promise.resolve({ images: [new Uint8Array([32])], timings: 'timings-json' }),
      ),
      trim_targets: vi.fn(),
      dispose: vi.fn(),
    };
    const create = vi.fn(() => Promise.resolve(wasmRenderer));
    vi.doMock('./wasm/render_wasm.js', () => ({
      default: initialize,
      Renderer: { create },
    }));
    const { createRendererRaw, installNativeBackend, renderManyRaw, renderRaw, usesNativeBackend } =
      await import('#renderer.js');
    // An installed addon loses to `navigator.gpu`, so a WebGPU-capable Node
    // runtime keeps the same artifact a browser gets.
    const load = vi.fn(async () => ({ createRenderer: vi.fn(), describeAdapter: vi.fn() }));
    installNativeBackend(load);
    const glb = new Uint8Array([9]);

    // The browser artifact shares one renderer for one-shot calls too.
    await expect(renderRaw(glb, '{}')).resolves.toEqual(new Uint8Array([31]));
    await expect(renderManyRaw(glb, '{}')).resolves.toEqual({
      images: [new Uint8Array([32])],
      timings: 'timings-json',
    });
    expect(create).toHaveBeenCalledOnce();
    expect(wasmRenderer.trim_targets).toHaveBeenCalledTimes(2);
    expect(load).not.toHaveBeenCalled();
    expect(usesNativeBackend()).toBe(false);

    const handle = await createRendererRaw(undefined);
    expect(create).toHaveBeenLastCalledWith(undefined);
    await expect(handle.renderImage(glb, '{}')).resolves.toEqual(new Uint8Array([31]));
    await expect(handle.renderImages(glb, '{}')).resolves.toEqual({
      images: [new Uint8Array([32])],
      timings: 'timings-json',
    });
    handle.dispose();
    expect(wasmRenderer.dispose).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith({ module_or_path: expect.any(URL) });
    expect(initialize.mock.calls[0]?.[0].module_or_path.pathname.endsWith('/wasm/render_wasm_bg.wasm')).toBe(
      true,
    );
  });

  it('should share one lazy renderer across concurrent one-shot calls', async () => {
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
      trimTargets: vi.fn(),
      dispose: vi.fn(),
    };
    const native = {
      createRenderer: vi.fn(() => Promise.resolve(nativeRenderer)),
      describeAdapter: vi.fn(async () => 'Metal / Test (IntegratedGpu)'),
    };
    const { installNativeBackend, renderManyRaw, renderRaw } = await import('#renderer.js');
    installNativeBackend(async () => native);
    const glb = new Uint8Array([9]);

    await expect(
      Promise.all([
        renderRaw(glb, '{}'),
        renderManyRaw(glb, '{"views":[]}'),
        renderRaw(glb, '{"format":"raw"}'),
        renderRaw(glb, '{}'),
      ]),
    ).resolves.toEqual([
      new Uint8Array([21]),
      { images: [new Uint8Array([22])] },
      new Uint8Array([21]),
      new Uint8Array([21]),
    ]);
    expect(native.createRenderer).toHaveBeenCalledOnce();
    expect(native.createRenderer).toHaveBeenCalledWith(undefined);
    // The one-shot guard runs after every call, so an oversized target set
    // never outlives the render that needed it.
    expect(nativeRenderer.trimTargets).toHaveBeenCalledTimes(4);
  });

  it('should retry the shared renderer after a failed bring-up', async () => {
    const nativeRenderer = {
      renderImage: vi.fn(() => Promise.resolve(new Uint8Array([21]))),
      renderImages: vi.fn(),
      trimTargets: vi.fn(),
      dispose: vi.fn(),
    };
    const createRenderer = vi
      .fn()
      .mockRejectedValueOnce(new Error('gpu: request_device failed'))
      .mockResolvedValueOnce(nativeRenderer);
    const { installNativeBackend, renderRaw } = await import('#renderer.js');
    installNativeBackend(async () => ({ createRenderer, describeAdapter: vi.fn() }));
    const glb = new Uint8Array([9]);

    await expect(renderRaw(glb, '{}')).rejects.toThrow('gpu: request_device failed');
    await expect(renderRaw(glb, '{}')).resolves.toEqual(new Uint8Array([21]));
    expect(createRenderer).toHaveBeenCalledTimes(2);
  });

  it('should surface an addon load failure to the caller', async () => {
    const failure = new RenderError('adapter-unavailable', 'adapter-unavailable: no binding');
    const { installNativeBackend, renderRaw } = await import('#renderer.js');
    installNativeBackend(() => Promise.reject(failure));

    await expect(renderRaw(new Uint8Array(0), '{}')).rejects.toBe(failure);
  });
});
