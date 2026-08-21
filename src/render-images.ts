/** Render one GLB to an ordered tuple of owned image files. */

import { createRenderedImageFile } from '#image-file.js';
import { RenderError } from '#render-error.js';
import type {
  RenderImageView,
  RenderImagesOptions,
  RenderTimings,
  RenderedImagesResult,
  StrictRenderImagesOptions,
} from '#options.js';
import { imageViewFileName, toImagesRequestJson } from '#options.js';
import type { RawImagesResult } from '#renderer.js';
import { renderManyRaw } from '#renderer.js';

/**
 * Validate and serialize plural options, wrapping validation failures in the
 * `parse` taxonomy.
 *
 * @internal
 * @param options - Shared settings and ordered views
 * @returns The validated JSON request
 */
export const serializeImagesOptions = (options: RenderImagesOptions): string => {
  try {
    return toImagesRequestJson(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RenderError('parse', `parse: ${message}`);
  }
};

const parseTimings = (json: string): RenderTimings => {
  const raw = JSON.parse(json) as {
    parse: number;
    setup: number;
    views: Array<{ id: string; render: number; overlay: number; encode: number }>;
  };
  return {
    parse: raw.parse,
    setup: raw.setup,
    views: raw.views.map(({ id, render, overlay, encode }) => ({
      id,
      render,
      overlay,
      encode,
    })),
  };
};

/**
 * Map a raw binding result onto the typed, named result tuple (with the
 * parsed timings attached when the call requested them).
 *
 * @internal
 * @param options - The validated options the raw result answers
 * @param raw - Binding-level images plus optional timings JSON
 * @returns The ordered result tuple
 */
export const assembleRenderedImages = <const Options extends RenderImagesOptions>(
  options: StrictRenderImagesOptions<Options>,
  raw: RawImagesResult,
): RenderedImagesResult<Options> => {
  if (raw.images.length !== options.views.length) {
    throw new RenderError(
      'unknown',
      `renderer contract violation: expected ${options.views.length} images, received ${raw.images.length}`,
    );
  }
  const images = (options.views as readonly RenderImageView[]).map((view, index) => {
    const format = view.format ?? options.format;
    return {
      id: view.id,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Output cardinality is checked above.
      file: createRenderedImageFile(format, imageViewFileName(view.id, format), raw.images[index]!),
    };
  });
  const result =
    raw.timings === undefined ? images : Object.assign(images, { timings: parseTimings(raw.timings) });
  return result as RenderedImagesResult<Options>;
};

/**
 * Render ordered identified camera views while parsing and uploading the GLB
 * once. Each view may override the shared output settings (width, height,
 * format, quality), so a resolution or format ladder is one call.
 *
 * @public
 * @param glb - Binary glTF bytes with owned `ArrayBuffer` storage
 * @param options - Shared settings and the ordered views to render
 * @returns An ordered tuple whose IDs follow the input view tuple
 */
export const renderImages = async <const Options extends RenderImagesOptions>(
  glb: Uint8Array<ArrayBuffer>,
  options: StrictRenderImagesOptions<Options>,
): Promise<RenderedImagesResult<Options>> => {
  let raw: RawImagesResult;
  try {
    raw = await renderManyRaw(glb, serializeImagesOptions(options));
  } catch (error) {
    throw RenderError.from(error);
  }
  return assembleRenderedImages(options, raw);
};
