/**
 * `nanoraster` — GLB to image rendering for browsers and Node.js.
 *
 * Picks the wasm (browser worker WebGPU) or napi (Node native) artifact and
 * renders one or many identified views with typed failures.
 *
 */

export { renderGlbToImage } from '#render-glb-to-image.js';
export { renderGlbToImages } from '#render-glb-to-images.js';
export { RenderError } from '#render-error.js';
export type { RenderFailureCode } from '#render-error.js';
export { imageMimeTypes } from '#image-file.js';
export type { RenderedImageFile } from '#image-file.js';
export { createRenderImageOptions, createRenderImagesOptions } from '#options.js';
export {
  renderImageAmbientRange,
  renderImageAnnotatedMinDimension,
  renderImageBackgroundPattern,
  renderImageDimensionRange,
  renderImageExposureRange,
  renderImageLabelMaxLength,
  renderImageLabelPattern,
  renderImageLightColorRange,
  renderImageMarginRange,
  renderImageMaxLights,
  renderImageQualityRange,
  renderImageViewIdPattern,
} from '#options.js';
export type {
  RenderImageOptions,
  RenderImagesOptions,
  RenderImageView,
  RenderedImage,
  RenderedImages,
  RenderLight,
  RenderLighting,
  RenderLightingRig,
} from '#options.js';
