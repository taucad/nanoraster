/** Render one GLB to an ordered tuple of owned image files. */

import { createRenderedImageFile } from '#image-file.js';
import { RenderError } from '#render-error.js';
import type {
  RenderImageView,
  RenderImagesOptions,
  RenderProfile,
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

const parseProfile = (json: string): RenderProfile => {
  const raw = JSON.parse(json) as {
    parseMs: number;
    setupMs: number;
    views: Array<{ id: string; renderMs: number; overlayMs: number; encodeMs: number }>;
  };
  return {
    parseMs: raw.parseMs,
    setupMs: raw.setupMs,
    views: raw.views.map(({ id, renderMs, overlayMs, encodeMs }) => ({
      id,
      renderMs,
      overlayMs,
      encodeMs,
    })),
  };
};

/**
 * Map a raw binding result onto the typed, named result tuple (with the
 * parsed profile attached when the call requested one).
 *
 * @internal
 * @param options - The validated options the raw result answers
 * @param raw - Binding-level images plus optional profile JSON
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
    raw.profile === undefined ? images : Object.assign(images, { profile: parseProfile(raw.profile) });
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
