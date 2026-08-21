/** MIME types emitted by nanoraster. @public */
export const imageMimeTypes = {
  png: 'image/png',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  raw: 'application/octet-stream',
} as const;

/** Encoder format keys, including the `jpg` alias for `jpeg`. @internal */
export type ImageFormat = keyof typeof imageMimeTypes;

/** Output width when a request states none. @internal */
export const defaultWidth = 768;

/** Output height when a request states none. @internal */
export const defaultHeight = 432;

/**
 * Named image bytes returned by nanoraster. The `Format` parameter narrows
 * `mimeType` when the requesting format is known as a literal.
 *
 * For `format: 'raw'` the bytes are the frame itself rather than an encoded
 * file: straight-alpha, sRGB-encoded RGBA8, exactly `width * height * 4` bytes,
 * row-major with the top row first, four bytes per pixel and no padding —
 * which is what a canvas `ImageData` expects after a `Uint8ClampedArray` wrap.
 *
 * @public
 */
export type RenderedImageFile<Format extends ImageFormat = ImageFormat> = {
  /** Canonical output filename: `render.<format>` or `render-<id>.<format>`. */
  name: string;
  /** Newly allocated image bytes owned by the caller. */
  bytes: Uint8Array<ArrayBuffer>;
  /** MIME type matching the output format; `'application/octet-stream'` for raw. */
  mimeType: (typeof imageMimeTypes)[Format];
  /** Pixel width this view was rendered at, resolved from the request. */
  readonly width: number;
  /** Pixel height this view was rendered at, resolved from the request. */
  readonly height: number;
};

/** Create a rendered image file with its canonical MIME type. @internal */
export const createRenderedImageFile = <Format extends ImageFormat>(
  format: Format,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  width: number | undefined,
  height: number | undefined,
): RenderedImageFile<Format> => ({
  name,
  bytes,
  mimeType: imageMimeTypes[format],
  width: width ?? defaultWidth,
  height: height ?? defaultHeight,
});
