import { expectTypeOf } from 'vitest';
import * as renderModule from '#index.js';

const { renderImage, renderImages } = renderModule;
// `as const satisfies` replaces the deleted option-identity helpers: it keeps
// literal view IDs and formats while still rejecting misspelled or misplaced
// keys, and it costs no runtime call.
type ImageOptions = renderModule.RenderImageOptions;
type ImagesOptions = renderModule.RenderImagesOptions;
type RenderModule = typeof renderModule;
// The whole runtime surface, pinned as a set rather than as a list of names
// that must not leak: a denylist only catches internals somebody remembered to
// name, while an equality trips on *any* new export — leaked helper or
// intended addition — until it is spelled out here on purpose. Type-only
// exports are invisible to `keyof`, so this covers the value surface.
expectTypeOf<keyof RenderModule>().toEqualTypeOf<
  | 'RenderError'
  | 'createRenderer'
  | 'describeAdapter'
  | 'imageMimeTypes'
  | 'renderImage'
  | 'renderImageAmbientRange'
  | 'renderImageAnnotatedMinDimension'
  | 'renderImageBackgroundPattern'
  | 'renderImageDimensionRange'
  | 'renderImageExposureRange'
  | 'renderImageLabelMaxLength'
  | 'renderImageLabelPattern'
  | 'renderImageLightColorRange'
  | 'renderImageMarginRange'
  | 'renderImageMaxLights'
  | 'renderImageQualityRange'
  | 'renderImageViewIdPattern'
  | 'renderImages'
>();

const glb = new Uint8Array([1, 2, 3]);

const singular = {
  format: 'webp',
  label: 'Isometric',
  axes: true,
  scaleBar: true,
} as const satisfies ImageOptions;
expectTypeOf(singular).toEqualTypeOf<{
  readonly format: 'webp';
  readonly label: 'Isometric';
  readonly axes: true;
  readonly scaleBar: true;
}>();
expectTypeOf(renderImage(glb, singular)).toEqualTypeOf<Promise<renderModule.RenderedImageFile>>();

type TauExportFileShape = {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: 'image/png' | 'image/webp' | 'image/jpeg' | 'application/octet-stream' | 'model/gltf-binary';
};
expectTypeOf<renderModule.RenderedImageFile>().toExtend<TauExportFileShape>();

const options = {
  format: 'png',
  axes: true,
  scaleBar: true,
  views: [
    { id: 'front', label: 'Front', phi: 90, theta: 0 },
    { id: 'top', label: 'Top', phi: 0, theta: 0 },
  ],
} as const satisfies ImagesOptions;
const rendered = renderImages(glb, options);
expectTypeOf(rendered).toEqualTypeOf<
  Promise<readonly [renderModule.RenderedImage<'front', 'png'>, renderModule.RenderedImage<'top', 'png'>]>
>();

const dynamicViews: renderModule.RenderImageView[] = [{ id: 'front', phi: 90, theta: 0 }];
const dynamic = renderImages(glb, { format: 'png', views: dynamicViews });
expectTypeOf(dynamic).toEqualTypeOf<Promise<readonly renderModule.RenderedImage<string, 'png'>[]>>();

// Per-view output overrides flow into each entry's mime type (R15), and
// timings: true adds typed timings to the result.
const ladder = renderImages(glb, {
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

// `format: 'raw'` narrows to the octet-stream MIME type on the shared option
// and on a per-view override, so a mixed plan types each entry by its own kind.
void renderImage(glb, { format: 'raw', width: 640, height: 480 });
const mixed = renderImages(glb, {
  format: 'webp',
  views: [
    { id: 'thumb', phi: 60, theta: -45 },
    { id: 'frame', phi: 60, theta: -45, format: 'raw' },
  ],
});
expectTypeOf(mixed).toEqualTypeOf<
  Promise<readonly [renderModule.RenderedImage<'thumb', 'webp'>, renderModule.RenderedImage<'frame', 'raw'>]>
>();
declare const thumbFile: Awaited<typeof mixed>[0]['file'];
expectTypeOf(thumbFile.mimeType).toEqualTypeOf<'image/webp'>();
declare const frameFile: Awaited<typeof mixed>[1]['file'];
expectTypeOf(frameFile.mimeType).toEqualTypeOf<'application/octet-stream'>();
expectTypeOf(frameFile.width).toEqualTypeOf<number>();
expectTypeOf(frameFile.height).toEqualTypeOf<number>();
const allRaw = renderImages(glb, {
  format: 'raw',
  views: [{ id: 'frame', phi: 60, theta: -45 }],
});
expectTypeOf(allRaw).toEqualTypeOf<Promise<readonly [renderModule.RenderedImage<'frame', 'raw'>]>>();
declare const sharedRawFile: Awaited<typeof allRaw>[0]['file'];
expectTypeOf(sharedRawFile.mimeType).toEqualTypeOf<'application/octet-stream'>();

const timed = renderImages(glb, {
  format: 'png',
  timings: true,
  views: [{ id: 'front', phi: 90, theta: 0 }],
});
expectTypeOf((await timed).timings).toEqualTypeOf<renderModule.RenderTimings>();
const untimed = await renderImages(glb, {
  format: 'png',
  views: [{ id: 'front', phi: 90, theta: 0 }],
});
// @ts-expect-error no timings without timings: true
void untimed.timings;

// Renderer handles mirror the module-level surface.
declare const renderer: renderModule.Renderer;
expectTypeOf(renderer.renderImage(glb, singular)).toEqualTypeOf<Promise<renderModule.RenderedImageFile>>();
expectTypeOf(renderer.renderImages(glb, options)).toEqualTypeOf<typeof rendered>();
expectTypeOf(renderer.dispose).toEqualTypeOf<() => void>();
expectTypeOf(renderer[Symbol.dispose]).toEqualTypeOf<() => void>();
expectTypeOf(renderModule.createRenderer()).toEqualTypeOf<Promise<renderModule.Renderer>>();
// The probe answers "none" with a value, and takes an optional cause as its
// third and last constructor argument.
expectTypeOf(renderModule.describeAdapter()).toEqualTypeOf<Promise<renderModule.AdapterInfo | undefined>>();
expectTypeOf(renderModule.RenderError).toBeConstructibleWith('parse', 'parse: bad', new Error('x'));
expectTypeOf(renderModule.createRenderer({ powerPreference: 'low-power' })).toEqualTypeOf<
  Promise<renderModule.Renderer>
>();
// @ts-expect-error unknown power preference
void renderModule.createRenderer({ powerPreference: 'turbo' });

// @ts-expect-error empty literal view tuples are rejected
void renderImages(glb, { format: 'png', views: [] });
void renderImages(glb, {
  format: 'png',
  views: [
    {
      id: 'front',
      phi: 90,
      theta: 0,
      // @ts-expect-error axes is shared, not per view
      axes: true,
    },
  ],
});
// A label's presence is its own switch: it stands alone, and a batch labels
// whichever views it chooses to.
void ({ format: 'png', label: 'Isometric' } as const satisfies ImageOptions);
void ({
  format: 'png',
  views: [
    { id: 'front', label: 'Front', phi: 90, theta: 0 },
    { id: 'top', phi: 0, theta: 0 },
  ],
} as const satisfies ImagesOptions);
void renderImages(glb, {
  format: 'png',
  views: [
    {
      id: 'front',
      phi: 90,
      theta: 0,
      // @ts-expect-error scaleBar is shared, not per view
      scaleBar: true,
    },
  ],
});
void ({
  format: 'png',
  // @ts-expect-error singular label is not a batch-level property
  label: 'Front',
  views: [{ id: 'front', phi: 90, theta: 0 }],
} as const satisfies ImagesOptions);
// Per-view output overrides are part of the plan-entry schema (R15).
void ({
  format: 'png',
  views: [{ id: 'front', phi: 90, theta: 0, format: 'webp' }],
} as const satisfies ImagesOptions);
void ({
  format: 'png',
  // @ts-expect-error unknown per-view format
  views: [{ id: 'front', phi: 90, theta: 0, format: 'gif' }],
} as const satisfies ImagesOptions);
void ({
  format: 'png',
  // @ts-expect-error plural angles belong on each view
  phi: 90,
  views: [{ id: 'front', phi: 90, theta: 0 }],
} as const satisfies ImagesOptions);
// @ts-expect-error missing theta
void ({ format: 'png', views: [{ id: 'front', phi: 90 }] } as const satisfies ImagesOptions);
// @ts-expect-error misspelled singular option
void ({ format: 'png', axis: true } as const satisfies ImageOptions);
void ({
  format: 'png',
  // @ts-expect-error misspelled plural option
  axis: true,
  views: [{ id: 'front', phi: 90, theta: 0 }],
} as const satisfies ImagesOptions);
// @ts-expect-error missing singular format
void ({ axes: true } as const satisfies ImageOptions);
void renderImages(glb, {
  format: 'png',
  lighting: 'studio',
  views: [{ id: 'front', phi: 90, theta: 0 }],
});
const lit = {
  format: 'png',
  lighting: {
    lights: [{ direction: [-0.45, 0.61, 0.63], color: [2.09, 2.09, 2.09] }],
    ambient: 0.02,
    environment: 'studio',
    space: 'world',
    exposure: 1.5,
  },
} as const satisfies ImageOptions;
expectTypeOf(lit.lighting).toExtend<renderModule.RenderLighting | undefined>();
void ({
  format: 'png',
  // @ts-expect-error unknown preset name
  lighting: 'sunset',
} as const satisfies ImageOptions);
void ({
  format: 'png',
  lighting: {
    lights: [],
    // @ts-expect-error misspelled rig property
    ambien: 0.02,
  },
} as const satisfies ImageOptions);
void ({
  format: 'png',
  // @ts-expect-error direction needs three components
  lighting: { lights: [{ direction: [0, 1], color: [1, 1, 1] }] },
} as const satisfies ImageOptions);
void ({
  format: 'png',
  lighting: {
    lights: [],
    // @ts-expect-error unknown environment name
    environment: 'sunset',
  },
  views: [{ id: 'front', phi: 90, theta: 0 }],
} as const satisfies ImagesOptions);
void renderImages(glb, { format: 'png', views: [{ id: 'front', phi: 90, theta: 0, width: 320 }] });
// @ts-expect-error missing view id
void ({ format: 'png', views: [{ phi: 90, theta: 0 }] } as const satisfies ImagesOptions);
