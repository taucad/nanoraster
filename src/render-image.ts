/** Render one GLB view to one owned image file. */

import { createRenderedImageFile, type RenderedImageFile } from '#image-file.js';
import { RenderError } from '#render-error.js';
import type { RenderImageOptions } from '#options.js';
import { imageFileName, toImageRequestJson } from '#options.js';
import { renderRaw } from '#renderer.js';

/**
 * Validate and serialize singular options, wrapping validation failures in
 * the `parse` taxonomy.
 *
 * @internal
 * @param options - Singular image settings
 * @returns The validated JSON request
 */
export const serializeImageOptions = (options: RenderImageOptions): string => {
  try {
    return toImageRequestJson(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RenderError('parse', `parse: ${message}`);
  }
};

/**
 * Name the singular result and attach the dimensions the request resolved to.
 *
 * @internal
 * @param options - The validated singular options the bytes answer
 * @param bytes - Binding-level output bytes
 * @returns The named result file
 */
export const toRenderedImageFile = (
  options: RenderImageOptions,
  bytes: Uint8Array<ArrayBuffer>,
): RenderedImageFile =>
  createRenderedImageFile(
    options.format,
    imageFileName(options.format),
    bytes,
    options.width,
    options.height,
  );

/**
 * Render a kernel GLB to one owned `render.<format>` image, or to the raw
 * frame itself with `format: 'raw'`.
 *
 * @public
 * @param glb - Binary glTF bytes with owned `ArrayBuffer` storage
 * @param options - Camera, format, background, and optional axis-indicator settings
 * @returns The output file: encoded bytes, or straight-alpha RGBA8 for `'raw'`
 */
export const renderImage = async (
  glb: Uint8Array<ArrayBuffer>,
  options: RenderImageOptions,
): Promise<RenderedImageFile> => {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await renderRaw(glb, serializeImageOptions(options));
  } catch (error) {
    throw RenderError.from(error);
  }
  return toRenderedImageFile(options, bytes);
};
