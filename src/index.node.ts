/**
 * `nanoraster` on Node.js — the surface of the universal entry point with the
 * NAPI-RS-generated addon loader installed behind it.
 *
 * A host that exposes `navigator.gpu` still renders through the wasm artifact;
 * every other Node host renders through the addon its platform package or a
 * colocated build provides.
 */

import {
  createRenderer as createRendererUniversal,
  describeAdapter as describeAdapterUniversal,
  renderImage as renderImageUniversal,
  renderImages as renderImagesUniversal,
} from '#index.js';
import { nativeAddonLoader } from '#native-backend.js';
import { installNativeBackend } from '#renderer.js';

// Installing the backend is a module-level effect, and this package declares
// `sideEffects: false`. Each export below is bound through this idempotent
// call, so a bundler that drops unreferenced statements cannot keep an export
// while discarding the installation it depends on.
const withNativeAddon = <Value>(value: Value): Value => {
  installNativeBackend(nativeAddonLoader);
  return value;
};

/** Render a kernel GLB to one owned image file, through the addon. */
export const renderImage = withNativeAddon(renderImageUniversal);

/** Render ordered identified views in one addon call. */
export const renderImages = withNativeAddon(renderImagesUniversal);

/** Create a persistent renderer holding one addon GPU device. */
export const createRenderer = withNativeAddon(createRendererUniversal);

/** Describe the adapter the addon would bind on this host. */
export const describeAdapter = withNativeAddon(describeAdapterUniversal);

export * from '#index.js';
