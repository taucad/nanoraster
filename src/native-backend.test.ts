import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArchitecture = Object.getOwnPropertyDescriptor(process, 'arch');

const addon = {
  createRenderer: vi.fn(),
  describeAdapter: vi.fn(),
};

afterEach(() => {
  if (originalArchitecture === undefined) {
    Reflect.deleteProperty(process, 'arch');
  } else {
    Object.defineProperty(process, 'arch', originalArchitecture);
  }
  vi.doUnmock('node:os');
  vi.doUnmock('./native/index.js');
  vi.resetModules();
});

/**
 * The budget for the one test below that loads the real addon instead of a
 * mock. It waits on the host: `dlopen` of a multi-megabyte binding that links
 * wgpu and the platform's Vulkan or Metal stack, then one adapter enumeration
 * through it. That is about 30 ms of work in a Linux container on lavapipe and
 * 440 ms in this suite on an idle machine, but it is wall clock on a shared CI
 * runner, where the 5 s default has already lost the race once.
 */
const HOST_ADDON_TIMEOUT = 60_000;

describe('nativeAddonLoader', () => {
  it(
    'should load the generated loader that this host built',
    async () => {
      const { nativeAddonLoader } = await import('#native-backend.js');

      const native = await nativeAddonLoader();

      // Calling the addon is what proves the loader resolved a real binding: the
      // probe answers with the adapter JSON this host would bind, or `null` where
      // there is no adapter at all.
      const adapter = await native.describeAdapter();

      expect(adapter === null || typeof adapter === 'string').toBe(true);
      if (typeof adapter === 'string') {
        expect(JSON.parse(adapter)).toMatchObject({ backend: expect.any(String) });
      }
    },
    HOST_ADDON_TIMEOUT,
  );

  it('should reject a big-endian ppc64 host before reaching the loader', async () => {
    Object.defineProperty(process, 'arch', { configurable: true, value: 'ppc64' });
    vi.doMock('node:os', () => ({ endianness: () => 'BE' }));
    const load = vi.fn(() => addon);
    vi.doMock('./native/index.js', load);
    const { nativeAddonLoader } = await import('#native-backend.js');

    try {
      await nativeAddonLoader();
      expect.fail('a big-endian host cannot run the little-endian package');
    } catch (error) {
      expect((error as Error).name).toBe('RenderError');
      expect((error as { code: string }).code).toBe('adapter-unavailable');
      expect((error as Error).message).toContain('big-endian');
      expect((error as Error).message).toContain('compatibility.md');
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('should load the addon on a little-endian ppc64 host', async () => {
    Object.defineProperty(process, 'arch', { configurable: true, value: 'ppc64' });
    vi.doMock('node:os', () => ({ endianness: () => 'LE' }));
    vi.doMock('./native/index.js', () => addon);
    const { nativeAddonLoader } = await import('#native-backend.js');

    await expect(nativeAddonLoader()).resolves.toMatchObject({
      createRenderer: addon.createRenderer,
      describeAdapter: addon.describeAdapter,
    });
  });

  it('should keep the whole loader cause chain when no binding resolves', async () => {
    const innermost = new Error('darwin-arm64 candidate failed');
    const chain = new Error('Cannot find native binding.', { cause: innermost });
    vi.doMock('./native/index.js', () => {
      throw chain;
    });
    const { nativeAddonLoader } = await import('#native-backend.js');

    try {
      await nativeAddonLoader();
      expect.fail('a loader that resolves nothing must reject');
    } catch (error) {
      expect((error as Error).name).toBe('RenderError');
      expect((error as { code: string }).code).toBe('adapter-unavailable');
      expect((error as Error).message).toContain(`${process.platform}-${process.arch}`);
      expect((error as Error).message).toContain('compatibility.md');
      // The chain is the only diagnostic an unsupported host gets, so it is
      // carried as thrown rather than flattened into the message.
      expect((error as Error).message).not.toContain('Cannot find native binding');
      const causes: unknown[] = [];
      for (let link = (error as Error).cause; link instanceof Error; link = link.cause) {
        causes.push(link);
      }
      expect(causes).toContain(chain);
      expect(causes).toContain(innermost);
    }
  });
});
