/** MIME types emitted by nanoraster. @public */
export const imageMimeTypes = {
  png: 'image/png',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
} as const;

/** Named image bytes returned by nanoraster. @public */
export type RenderedImageFile = {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: (typeof imageMimeTypes)[keyof typeof imageMimeTypes];
};

/** Create a rendered image file with its canonical MIME type. @internal */
export const createRenderedImageFile = (
  format: keyof typeof imageMimeTypes,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
): RenderedImageFile => ({ name, bytes, mimeType: imageMimeTypes[format] });
