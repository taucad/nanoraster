/** Render one GLB view to raw straight-alpha RGBA pixels — no encode. */

import type { RenderedPixels } from '#image-file.js';
import { RenderError } from '#render-error.js';
import type { RenderPixelsOptions } from '#options.js';
import { toPixelsRequestJson } from '#options.js';
import type { RawPixelsResult } from '#renderer.js';
import { renderPixelsRaw } from '#renderer.js';

/**
 * Validate and serialize pixels options, wrapping validation failures in the
 * `parse` taxonomy.
 *
 * @internal
 * @param options - Singular camera and annotation settings
 * @returns The validated JSON request
 */
export const serializePixelsOptions = (options: RenderPixelsOptions): string => {
  try {
    return toPixelsRequestJson(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RenderError('parse', `parse: ${message}`);
  }
};

/** @internal Shape a raw binding pixels result into the public type. */
export const toRenderedPixels = (result: RawPixelsResult): RenderedPixels => ({
  rgba: result.rgba,
  width: result.width,
  height: result.height,
});

/**
 * Render a kernel GLB to raw straight-alpha, sRGB-encoded RGBA8 pixels,
 * skipping the encode entirely — for canvas display (`putImageData` expects
 * exactly this layout), custom encoding pipelines, and pixel-level
 * comparisons.
 *
 * @public
 * @param glb - Binary glTF bytes with owned `ArrayBuffer` storage
 * @param options - Camera, background, and annotation settings (no format or quality)
 * @returns The rendered pixels with their dimensions
 */
export const renderPixels = async (
  glb: Uint8Array<ArrayBuffer>,
  options: RenderPixelsOptions,
): Promise<RenderedPixels> => {
  let result: RawPixelsResult;
  try {
    result = await renderPixelsRaw(glb, serializePixelsOptions(options));
  } catch (error) {
    throw RenderError.from(error);
  }
  return toRenderedPixels(result);
};
