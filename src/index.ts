/**
 * `nanoraster` — GLB to image rendering for browsers and Node.js.
 *
 * Picks the wasm (browser worker WebGPU) or napi (Node native) artifact and
 * renders one or many identified views with typed failures. One-shot
 * functions are sugar over a persistent {@link Renderer}; hold one to reuse
 * the GPU device across calls.
 *
 */

export { renderGlbToImage } from '#render-glb-to-image.js';
export { renderGlbToImages } from '#render-glb-to-images.js';
export { renderGlbToPixels } from '#render-glb-to-pixels.js';
export { createRenderer } from '#create-renderer.js';
export type { CreateRendererOptions, Renderer } from '#create-renderer.js';
export { describeAdapter } from '#describe-adapter.js';
export { RenderError } from '#render-error.js';
export type { RenderFailureCode } from '#render-error.js';
export { imageMimeTypes } from '#image-file.js';
export type { RenderedImageFile, RenderedPixels } from '#image-file.js';
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
  RenderPixelsOptions,
  RenderProfile,
  RenderViewProfile,
  RenderedImage,
  RenderedImages,
  RenderLight,
  RenderLighting,
  RenderLightingRig,
} from '#options.js';
