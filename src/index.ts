/**
 * `nanoraster` — GLB to image rendering for browsers and Node.js.
 *
 * Picks the wasm (browser worker WebGPU) or napi (Node native) artifact and
 * renders one or many identified views with typed failures. The one-shot
 * functions share one lazily created {@link Renderer} per process and run in
 * sequence; create your own to control its lifetime or power preference.
 *
 */

export { renderImage } from '#render-image.js';
export { renderImages } from '#render-images.js';
export { createRenderer } from '#create-renderer.js';
export type { CreateRendererOptions, Renderer } from '#create-renderer.js';
export { describeAdapter } from '#describe-adapter.js';
export type { AdapterInfo } from '#describe-adapter.js';
export { RenderError } from '#render-error.js';
export type { RenderFailureCode } from '#render-error.js';
export { imageMimeTypes } from '#image-file.js';
export type { RenderedImageFile } from '#image-file.js';
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
  RenderTimings,
  RenderViewTimings,
  RenderedImage,
  RenderedImages,
  RenderedImagesResult,
  RenderLight,
  RenderLighting,
  RenderLightingRig,
  StrictRenderImagesOptions,
} from '#options.js';
