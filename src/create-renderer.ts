/** Persistent renderer façade: one GPU device reused across calls. */

import { createRenderedImageFile, type RenderedImageFile, type RenderedPixels } from '#image-file.js';
import { RenderError } from '#render-error.js';
import type {
  RenderImageOptions,
  RenderImagesOptions,
  RenderPixelsOptions,
  RenderedImagesResult,
  StrictRenderImagesOptions,
} from '#options.js';
import { imageFileName } from '#options.js';
import { serializeImageOptions } from '#render-image.js';
import { assembleRenderedImages, serializeImagesOptions } from '#render-images.js';
import { serializePixelsOptions, toRenderedPixels } from '#render-pixels.js';
import type { RawRendererHandle } from '#renderer.js';
import { createRendererRaw } from '#renderer.js';

/**
 * Options accepted by {@link createRenderer} and {@link describeAdapter}.
 *
 * @public
 */
export type CreateRendererOptions = {
  /**
   * GPU selection hint. On dual-GPU machines `'high-performance'` prefers the
   * discrete GPU; small, frequent renders should prefer `'low-power'`.
   * Pixel output is identical either way on a given adapter.
   *
   * @default 'high-performance'
   */
  readonly powerPreference?: 'high-performance' | 'low-power';
};

/**
 * A persistent GPU renderer: one adapter, device, shader, and pipeline set
 * reused across calls, with a lifetime and a power preference you choose (the
 * one-shot functions share a renderer of their own that has neither). Pixels
 * are byte-identical to the one-shot functions on the same adapter. A renderer
 * is single-realm — create it inside the worker that uses it (handles cannot
 * cross `postMessage`; bytes can) — and calls on one renderer run in sequence.
 *
 * @public
 */
export type Renderer = {
  /** Render one view to one owned `render.<format>` image on the warm device. */
  readonly renderImage: (
    glb: Uint8Array<ArrayBuffer>,
    options: RenderImageOptions,
  ) => Promise<RenderedImageFile>;
  /** Render an ordered plan of identified views (with per-view output overrides) in one call. */
  readonly renderImages: <const Options extends RenderImagesOptions>(
    glb: Uint8Array<ArrayBuffer>,
    options: StrictRenderImagesOptions<Options>,
  ) => Promise<RenderedImagesResult<Options>>;
  /** Render one view to raw straight-alpha RGBA8 pixels — no encode. */
  readonly renderPixels: (
    glb: Uint8Array<ArrayBuffer>,
    options: RenderPixelsOptions,
  ) => Promise<RenderedPixels>;
  /**
   * Destroy the GPU device once in-flight calls settle. Later calls reject
   * with a {@link RenderError} whose code is `'gpu'` — recreate the renderer
   * rather than retrying the call.
   */
  readonly dispose: () => void;
  /** `using renderer = await createRenderer()` disposes at scope exit. */
  readonly [Symbol.dispose]: () => void;
};

const createRendererKeys = new Set(['powerPreference']);

/** Validate creation options and render them as the wire request. @internal */
export const serializeCreateOptions = (options: CreateRendererOptions | undefined): string | undefined => {
  if (options === undefined) {
    return undefined;
  }
  try {
    const input: unknown = options;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new TypeError('options must be an object');
    }
    const unknownKey = Object.keys(input).find((key) => !createRendererKeys.has(key));
    if (unknownKey !== undefined) {
      throw new TypeError(`options contains unknown property ${JSON.stringify(unknownKey)}`);
    }
    const { powerPreference } = options;
    if (
      powerPreference !== undefined &&
      !['high-performance', 'low-power'].some((preference) => preference === powerPreference)
    ) {
      throw new TypeError('powerPreference must be high-performance or low-power');
    }
    return powerPreference === undefined ? undefined : JSON.stringify({ powerPreference });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RenderError('parse', `parse: ${message}`);
  }
};

/**
 * Create a renderer that keeps the GPU device, shader, and pipelines alive
 * across calls. Dispose it deliberately (`dispose()` or `using`) when the
 * worker or process is done rendering.
 *
 * @public
 * @param options - GPU selection hints
 * @returns The persistent renderer
 */
export const createRenderer = async (options?: CreateRendererOptions): Promise<Renderer> => {
  const optionsJson = serializeCreateOptions(options);
  let handle: RawRendererHandle;
  try {
    handle = await createRendererRaw(optionsJson);
  } catch (error) {
    throw RenderError.from(error);
  }

  let disposed = false;
  // Calls on one renderer run in sequence: the chain keeps ordering while the
  // catch keeps one failed render from wedging every later call.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <Value>(job: () => Promise<Value>): Promise<Value> => {
    const next = queue.then(() => {
      if (disposed) {
        throw new RenderError('gpu', 'gpu: renderer disposed');
      }
      return job();
    });
    queue = next.catch(() => undefined);
    return next;
  };
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    void queue.then(() => {
      handle.dispose();
    });
  };

  return {
    renderImage: (glb, renderOptions) =>
      enqueue(async () => {
        const request = serializeImageOptions(renderOptions);
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          bytes = await handle.renderImage(glb, request);
        } catch (error) {
          throw RenderError.from(error);
        }
        return createRenderedImageFile(renderOptions.format, imageFileName(renderOptions.format), bytes);
      }),
    renderImages: (glb, renderOptions) =>
      enqueue(async () => {
        const request = serializeImagesOptions(renderOptions);
        try {
          return assembleRenderedImages(renderOptions, await handle.renderImages(glb, request));
        } catch (error) {
          throw RenderError.from(error);
        }
      }),
    renderPixels: (glb, renderOptions) =>
      enqueue(async () => {
        const request = serializePixelsOptions(renderOptions);
        try {
          return toRenderedPixels(await handle.renderPixels(glb, request));
        } catch (error) {
          throw RenderError.from(error);
        }
      }),
    dispose,
    [Symbol.dispose]: dispose,
  };
};
