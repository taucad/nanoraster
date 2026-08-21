/** MIME types emitted by nanoraster. @public */
export const imageMimeTypes = {
  png: 'image/png',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
} as const;

/** Encoder format keys, including the `jpg` alias for `jpeg`. @internal */
export type ImageFormat = keyof typeof imageMimeTypes;

/**
 * Named image bytes returned by nanoraster. The `Format` parameter narrows
 * `mimeType` when the requesting format is known as a literal.
 *
 * @public
 */
export type RenderedImageFile<Format extends ImageFormat = ImageFormat> = {
  /** Canonical output filename: `render.<format>` or `render-<id>.<format>`. */
  name: string;
  /** Newly allocated encoded image bytes owned by the caller. */
  bytes: Uint8Array<ArrayBuffer>;
  /** MIME type matching the encoded image format. */
  mimeType: (typeof imageMimeTypes)[Format];
};

/**
 * Straight-alpha, sRGB-encoded RGBA8 pixels: tightly packed rows, no encode
 * and no decode. Wrap `rgba` in a `Uint8ClampedArray` for `ImageData`.
 *
 * @public
 */
export type RenderedPixels = {
  /** Tightly packed RGBA rows, `width * height * 4` bytes, owned by the caller. */
  readonly rgba: Uint8Array<ArrayBuffer>;
  /** Pixel width of the rendered image. */
  readonly width: number;
  /** Pixel height of the rendered image. */
  readonly height: number;
};

/** Create a rendered image file with its canonical MIME type. @internal */
export const createRenderedImageFile = <Format extends ImageFormat>(
  format: Format,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
): RenderedImageFile<Format> => ({ name, bytes, mimeType: imageMimeTypes[format] });
