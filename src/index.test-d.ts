import { expectTypeOf } from 'vitest';
import * as renderModule from '#index.js';

const { createRenderImageOptions, createRenderImagesOptions, renderGlbToImage, renderGlbToImages } =
  renderModule;
type RenderModule = typeof renderModule;
expectTypeOf<
  Extract<
    keyof RenderModule,
    | 'RenderDeps'
    | 'RawRenderer'
    | 'RawImagesResult'
    | 'RawPixelsResult'
    | 'RawRendererHandle'
    | 'RenderedImagesResult'
    | 'StrictRenderImagesOptions'
    | 'assembleRenderedImages'
    | 'createRendererRaw'
    | 'describeAdapterRaw'
    | 'imageFileName'
    | 'isNodeRuntime'
    | 'renderManyRaw'
    | 'renderPixelsRaw'
    | 'renderRaw'
    | 'serializeImageOptions'
    | 'serializeImagesOptions'
    | 'serializePixelsOptions'
    | 'toImageRequestJson'
    | 'toImagesRequestJson'
    | 'toPixelsRequestJson'
    | 'toRenderedPixels'
  >
>().toEqualTypeOf<never>();

const glb = new Uint8Array([1, 2, 3]);

const singular = createRenderImageOptions({
  format: 'webp',
  label: 'Isometric',
  includeAxes: true,
  includeLabel: true,
  includeScale: true,
});
expectTypeOf(singular).toEqualTypeOf<{
  readonly format: 'webp';
  readonly label: 'Isometric';
  readonly includeAxes: true;
  readonly includeLabel: true;
  readonly includeScale: true;
}>();
expectTypeOf(renderGlbToImage(glb, singular)).toEqualTypeOf<Promise<renderModule.RenderedImageFile>>();

type TauExportFileShape = {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: 'image/png' | 'image/webp' | 'image/jpeg' | 'model/gltf-binary';
};
expectTypeOf<renderModule.RenderedImageFile>().toExtend<TauExportFileShape>();

const options = createRenderImagesOptions({
  format: 'png',
  includeAxes: true,
  includeLabel: true,
  includeScale: true,
  views: [
    { id: 'front', label: 'Front', phi: 90, theta: 0 },
    { id: 'top', label: 'Top', phi: 0, theta: 0 },
  ],
});
const rendered = renderGlbToImages(glb, options);
expectTypeOf(rendered).toEqualTypeOf<
  Promise<readonly [renderModule.RenderedImage<'front', 'png'>, renderModule.RenderedImage<'top', 'png'>]>
>();

const dynamicViews: renderModule.RenderImageView[] = [{ id: 'front', phi: 90, theta: 0 }];
const dynamic = renderGlbToImages(glb, { format: 'png', views: dynamicViews });
expectTypeOf(dynamic).toEqualTypeOf<Promise<readonly renderModule.RenderedImage<string, 'png'>[]>>();

// Per-view output overrides flow into each entry's mime type (R15), and
// profile: true adds a typed profile to the result.
const ladder = renderGlbToImages(glb, {
  format: 'webp',
  views: [
    { id: 'card', phi: 60, theta: -45 },
    { id: 'hero', phi: 60, theta: -45, width: 1536, height: 804, format: 'png' },
  ],
});
expectTypeOf(ladder).toEqualTypeOf<
  Promise<readonly [renderModule.RenderedImage<'card', 'webp'>, renderModule.RenderedImage<'hero', 'png'>]>
>();
declare const cardFile: Awaited<typeof ladder>[0]['file'];
expectTypeOf(cardFile.mimeType).toEqualTypeOf<'image/webp'>();
declare const heroFile: Awaited<typeof ladder>[1]['file'];
expectTypeOf(heroFile.mimeType).toEqualTypeOf<'image/png'>();

const profiled = renderGlbToImages(glb, {
  format: 'png',
  profile: true,
  views: [{ id: 'front', phi: 90, theta: 0 }],
});
expectTypeOf((await profiled).profile).toEqualTypeOf<renderModule.RenderProfile>();
const unprofiled = await renderGlbToImages(glb, {
  format: 'png',
  views: [{ id: 'front', phi: 90, theta: 0 }],
});
// @ts-expect-error no profile without profile: true
void unprofiled.profile;

// Renderer handles mirror the module-level surface.
declare const renderer: renderModule.Renderer;
expectTypeOf(renderer.renderGlbToImage(glb, singular)).toEqualTypeOf<
  Promise<renderModule.RenderedImageFile>
>();
expectTypeOf(renderer.renderGlbToImages(glb, options)).toEqualTypeOf<typeof rendered>();
expectTypeOf(renderer.renderGlbToPixels(glb, {})).toEqualTypeOf<Promise<renderModule.RenderedPixels>>();
expectTypeOf(renderer.dispose).toEqualTypeOf<() => void>();
expectTypeOf(renderer[Symbol.dispose]).toEqualTypeOf<() => void>();
expectTypeOf(renderModule.createRenderer()).toEqualTypeOf<Promise<renderModule.Renderer>>();
expectTypeOf(renderModule.createRenderer({ powerPreference: 'low-power' })).toEqualTypeOf<
  Promise<renderModule.Renderer>
>();
// @ts-expect-error pixels options carry no encoder pair
void renderer.renderGlbToPixels(glb, { format: 'png' });
// @ts-expect-error unknown power preference
void renderModule.createRenderer({ powerPreference: 'turbo' });

// @ts-expect-error empty literal view tuples are rejected
void renderGlbToImages(glb, { format: 'png', views: [] });
void renderGlbToImages(glb, {
  format: 'png',
  views: [
    {
      id: 'front',
      phi: 90,
      theta: 0,
      // @ts-expect-error includeAxes is shared, not per view
      includeAxes: true,
    },
  ],
});
// @ts-expect-error includeLabel true requires a singular label
createRenderImageOptions({ format: 'png', includeLabel: true });
// @ts-expect-error includeLabel true requires every batch view label
createRenderImagesOptions({ format: 'png', includeLabel: true, views: [{ id: 'front', phi: 90, theta: 0 }] });
void renderGlbToImages(glb, {
  format: 'png',
  views: [
    {
      id: 'front',
      phi: 90,
      theta: 0,
      // @ts-expect-error includeScale is shared, not per view
      includeScale: true,
    },
  ],
});
// @ts-expect-error singular label is not a batch-level property
createRenderImagesOptions({ format: 'png', label: 'Front', views: [{ id: 'front', phi: 90, theta: 0 }] });
// Per-view output overrides are part of the plan-entry schema (R15).
createRenderImagesOptions({ format: 'png', views: [{ id: 'front', phi: 90, theta: 0, format: 'webp' }] });
// @ts-expect-error unknown per-view format
createRenderImagesOptions({ format: 'png', views: [{ id: 'front', phi: 90, theta: 0, format: 'gif' }] });
// @ts-expect-error plural angles belong on each view
createRenderImagesOptions({ format: 'png', phi: 90, views: [{ id: 'front', phi: 90, theta: 0 }] });
// @ts-expect-error missing theta
createRenderImagesOptions({ format: 'png', views: [{ id: 'front', phi: 90 }] });
// @ts-expect-error misspelled singular option
createRenderImageOptions({ format: 'png', includeAxis: true });
// @ts-expect-error misspelled plural option
createRenderImagesOptions({ format: 'png', includeAxis: true, views: [{ id: 'front', phi: 90, theta: 0 }] });
// @ts-expect-error missing singular format
createRenderImageOptions({ includeAxes: true });
void renderGlbToImages(glb, {
  format: 'png',
  lighting: 'studio',
  views: [{ id: 'front', phi: 90, theta: 0 }],
});
const lit = createRenderImageOptions({
  format: 'png',
  lighting: {
    lights: [{ direction: [-0.45, 0.61, 0.63], color: [2.09, 2.09, 2.09] }],
    ambient: 0.02,
    environment: 'studio',
    space: 'world',
    exposure: 1.5,
  },
});
expectTypeOf(lit.lighting).toExtend<renderModule.RenderLighting | undefined>();
createRenderImageOptions({
  format: 'png',
  // @ts-expect-error unknown preset name
  lighting: 'sunset',
});
createRenderImageOptions({
  format: 'png',
  lighting: {
    lights: [],
    // @ts-expect-error misspelled rig property
    ambien: 0.02,
  },
});
createRenderImageOptions({
  format: 'png',
  // @ts-expect-error direction needs three components
  lighting: { lights: [{ direction: [0, 1], color: [1, 1, 1] }] },
});
createRenderImagesOptions({
  format: 'png',
  lighting: {
    lights: [],
    // @ts-expect-error unknown environment name
    environment: 'sunset',
  },
  views: [{ id: 'front', phi: 90, theta: 0 }],
});
void renderGlbToImages(glb, { format: 'png', views: [{ id: 'front', phi: 90, theta: 0, width: 320 }] });
// @ts-expect-error missing view id
createRenderImagesOptions({ format: 'png', views: [{ phi: 90, theta: 0 }] });
