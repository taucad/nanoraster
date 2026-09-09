import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('#renderer.js');
  vi.resetModules();
});

describe('encodeRgbaWebp', () => {
  it('copies input before dispatch and forwards explicit alpha representation', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encodeRgbaWebpRaw = vi.fn(async (rgba: Uint8Array) => {
      await held;
      return new Uint8Array(rgba);
    });
    vi.doMock('#renderer.js', () => ({ encodeRgbaWebpRaw }));
    const { encodeRgbaWebp } = await import('#encode-rgba.js');
    const rgba = new Uint8Array([64, 32, 16, 128]);
    const pending = encodeRgbaWebp(rgba, { width: 1, height: 1, quality: 1, alpha: 'premultiplied' });
    rgba.fill(0);
    release();

    await expect(pending).resolves.toEqual(new Uint8Array([64, 32, 16, 128]));
    expect(encodeRgbaWebpRaw).toHaveBeenCalledWith(new Uint8Array([64, 32, 16, 128]), {
      width: 1,
      height: 1,
      quality: 100,
      premultiplied: true,
    });
  });

  it.each([
    [new Uint8Array(3), { width: 1, height: 1, alpha: 'straight' as const }],
    [new Uint8Array(4), { width: 0, height: 1, alpha: 'straight' as const }],
    [new Uint8Array(4), { width: 1, height: 1, quality: 1.1, alpha: 'straight' as const }],
    [new Uint8Array(4), { width: 1, height: 1, alpha: 'invalid' as never }],
  ])('rejects invalid input before loading a codec binding', async (rgba, options) => {
    const encodeRgbaWebpRaw = vi.fn();
    vi.doMock('#renderer.js', () => ({ encodeRgbaWebpRaw }));
    const { encodeRgbaWebp } = await import('#encode-rgba.js');

    await expect(encodeRgbaWebp(rgba, options)).rejects.toMatchObject({ code: 'encode' });
    expect(encodeRgbaWebpRaw).not.toHaveBeenCalled();
  });
});
