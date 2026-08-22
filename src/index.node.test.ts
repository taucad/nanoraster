import { afterEach, describe, expect, it, vi } from 'vitest';

const adapterJson = '{"backend":"metal","name":"Test Adapter","deviceType":"integrated-gpu"}';
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

const mockAddon = (): {
  renderImage: ReturnType<typeof vi.fn>;
  describeAdapter: ReturnType<typeof vi.fn>;
} => {
  const renderImage = vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const describeAdapter = vi.fn(async () => adapterJson);
  vi.doMock('./native/index.js', () => ({
    createRenderer: vi.fn(async () => ({
      renderImage,
      renderImages: vi.fn(),
      trimTargets: vi.fn(),
      dispose: vi.fn(),
    })),
    describeAdapter,
  }));
  return { renderImage, describeAdapter };
};

afterEach(() => {
  if (originalNavigator === undefined) {
    Reflect.deleteProperty(globalThis, 'navigator');
  } else {
    Object.defineProperty(globalThis, 'navigator', originalNavigator);
  }
  vi.doUnmock('./native/index.js');
  vi.resetModules();
});

describe('Node entry point', () => {
  it('should export exactly the universal runtime surface', async () => {
    mockAddon();
    const node = await import('#index.node.js');
    const universal = await import('#index.js');

    expect(Object.keys(node).toSorted()).toEqual(Object.keys(universal).toSorted());
  });

  it('should render through the addon the generated loader resolves', async () => {
    const { renderImage } = mockAddon();
    const { renderImage: render } = await import('#index.node.js');

    const file = await render(new Uint8Array([1, 2, 3]), { format: 'png', width: 64, height: 64 });

    expect(file).toEqual(
      expect.objectContaining({ name: 'render.png', mimeType: 'image/png', width: 64, height: 64 }),
    );
    expect(renderImage).toHaveBeenCalledOnce();
  });

  it('should describe the adapter through the addon', async () => {
    const { describeAdapter } = mockAddon();
    const { describeAdapter: probe } = await import('#index.node.js');

    await expect(probe({ powerPreference: 'low-power' })).resolves.toEqual({
      backend: 'metal',
      name: 'Test Adapter',
      deviceType: 'integrated-gpu',
    });
    expect(describeAdapter).toHaveBeenCalledWith('{"powerPreference":"low-power"}');
  });

  it('should prefer WebGPU over the addon when the host exposes it', async () => {
    const { describeAdapter } = mockAddon();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        gpu: {
          requestAdapter: async () => ({
            info: { vendor: 'test', architecture: '', description: 'browser', isFallbackAdapter: true },
          }),
        },
      },
    });
    const { describeAdapter: probe } = await import('#index.node.js');

    await expect(probe()).resolves.toEqual({
      backend: 'webgpu',
      name: 'test browser',
      deviceType: 'cpu',
    });
    expect(describeAdapter).not.toHaveBeenCalled();
  });

  it('should leave the universal entry point on the WebGPU probe with no addon installed', async () => {
    const { describeAdapter } = mockAddon();
    const { describeAdapter: probe } = await import('#index.js');

    // No `navigator.gpu` and no installed addon: the universal surface answers
    // "no adapter" rather than reaching for a native one.
    await expect(probe()).resolves.toBeUndefined();
    expect(describeAdapter).not.toHaveBeenCalled();
  });
});
