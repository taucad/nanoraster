/** MIME types emitted by nanoraster. @public */
export const imageMimeTypes = {
  png: 'image/png',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
} as const;

/** Encoder format keys, including the `jpg` alias for `jpeg`. @internal */
export type ImageFormat = keyof typeof imageMimeTypes;

/** Named image bytes returned by nanoraster. @public */
export type RenderedImageFile = {
  /** Canonical output filename: `thumbnail.<format>` or `thumbnail-<id>.<format>`. */
  name: string;
  /** Newly allocated encoded image bytes owned by the caller. */
  bytes: Uint8Array<ArrayBuffer>;
  /** MIME type matching the encoded image format. */
  mimeType: (typeof imageMimeTypes)[keyof typeof imageMimeTypes];
};

/** Create a rendered image file with its canonical MIME type. @internal */
export const createRenderedImageFile = (
  format: ImageFormat,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
): RenderedImageFile => ({ name, bytes, mimeType: imageMimeTypes[format] });
