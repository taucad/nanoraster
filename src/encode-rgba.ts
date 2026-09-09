import { RenderError } from '#render-error.js';
import { encodeRgbaWebpRaw } from '#renderer.js';

export type EncodeRgbaWebpOptions = {
  /** Output width in pixels. */
  readonly width: number;
  /** Output height in pixels. */
  readonly height: number;
  /** WebP quality from 0 to 1. One selects lossless VP8L. */
  readonly quality?: number;
  /** Whether RGB channels are independent of alpha or already multiplied by it. */
  readonly alpha: 'straight' | 'premultiplied';
};

/**
 * Encode owned, tightly packed, top-row-first sRGB RGBA8 pixels as WebP without
 * initializing a GPU renderer. The input is snapshotted before asynchronous
 * native work begins.
 */
export const encodeRgbaWebp = async (
  rgba: Uint8Array<ArrayBuffer>,
  options: EncodeRgbaWebpOptions,
): Promise<Uint8Array<ArrayBuffer>> => {
  const rawOptions: unknown = options;
  if (typeof rawOptions !== 'object' || rawOptions === null) {
    throw new RenderError('encode', 'encode: WebP options must be an object');
  }
  const optionRecord = rawOptions as Record<string, unknown>;
  const width = optionRecord['width'];
  const height = optionRecord['height'];
  const quality = optionRecord['quality'] ?? 1;
  const alpha = optionRecord['alpha'];
  if (
    typeof width !== 'number' ||
    !Number.isInteger(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isInteger(height) ||
    height <= 0
  ) {
    throw new RenderError('encode', 'encode: width and height must be positive integers');
  }
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new RenderError('encode', 'encode: WebP quality must be within 0..=1');
  }
  if (alpha !== 'straight' && alpha !== 'premultiplied') {
    throw new RenderError('encode', 'encode: alpha must be "straight" or "premultiplied"');
  }
  const expected = width * height * 4;
  if (!Number.isSafeInteger(expected) || rgba.byteLength !== expected) {
    throw new RenderError(
      'encode',
      `encode: RGBA length ${rgba.byteLength} does not match ${width}x${height}`,
    );
  }
  try {
    return await encodeRgbaWebpRaw(new Uint8Array(rgba), {
      width,
      height,
      quality: Math.round(quality * 100),
      premultiplied: alpha === 'premultiplied',
    });
  } catch (error) {
    throw RenderError.from(error);
  }
};
