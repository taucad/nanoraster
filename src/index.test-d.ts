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
  | 'renderDirectionFromOrbit'
  | 'renderImage'
  | 'renderImageAmbientRange'
  | 'renderImageAnnotatedMinDimension'
  | 'renderImageBackgroundPattern'
  | 'renderImageDimensionRange'
  | 'renderImageExposureRange'
  | 'renderImageLabelMaxLength'
  | 'renderImageLabelPattern'
  | 'renderImageLineWidthRange'
  | 'renderImageLightColorRange'
  | 'renderImageMarginRange'
  | 'renderImageMaxLights'
  | 'renderImageMaxSections'
  | 'renderImageQualityRange'
  | 'renderImageVerticalFieldOfViewRange'
  | 'renderImageViewIdPattern'
  | 'renderImageZoomRange'
  | 'renderImages'
  | 'renderOrbitFromDirection'
>();

const glb = new Uint8Array([1, 2, 3]);

const vector: renderModule.RenderVector3 = [1, 2, 3];
expectTypeOf(vector).toEqualTypeOf<readonly [number, number, number]>();
const world = {
  up: '+z',
  forward: '-y',
  unit: 'millimeter',
} as const satisfies renderModule.RenderWorld;
expectTypeOf(world.up).toEqualTypeOf<'+z'>();
expectTypeOf<renderModule.RenderWorldAxis>().toEqualTypeOf<'+x' | '-x' | '+y' | '-y' | '+z' | '-z'>();

// The orbit pair is world-aware and Cartesian on the wire: angles never reach
// the request, they only produce the `direction` it already accepts.
const orbit = { azimuth: 45, elevation: 30 } as const satisfies renderModule.RenderOrbit;
expectTypeOf(renderModule.renderDirectionFromOrbit(orbit)).toEqualTypeOf<renderModule.RenderVector3>();
expectTypeOf(renderModule.renderDirectionFromOrbit(orbit, world)).toEqualTypeOf<renderModule.RenderVector3>();
expectTypeOf(renderModule.renderOrbitFromDirection(vector)).toEqualTypeOf<renderModule.RenderOrbit>();
expectTypeOf(renderModule.renderOrbitFromDirection(vector, world)).toEqualTypeOf<renderModule.RenderOrbit>();
void renderImage(glb, {
  format: 'png',
  world,
  camera: { framing: 'fit', direction: renderModule.renderDirectionFromOrbit(orbit, world) },
});
// @ts-expect-error orbit angles are not a camera field
void ({ framing: 'fit', azimuth: 45 } as const satisfies renderModule.RenderCamera);
void renderImage(glb, { format: 'png', world });
// @ts-expect-error the unreleased camera-specific tuple name was consolidated
expectTypeOf<renderModule.CameraVector>();

const primitive: renderModule.RenderPrimitiveReference = {
  nodeIndex: 2,
  meshIndex: 1,
  primitiveIndex: 0,
};
const sections = {
  planes: [{ point: [0, 0, 0], normal: [1, 0, 0] }],
  clipSurfaces: true,
} as const satisfies renderModule.RenderSections;
const adapterSections: renderModule.RenderSections = sections;
void renderImage(glb, {
  format: 'png',
  surfaces: true,
  lines: false,
  visiblePrimitives: [primitive],
  sections,
});
void renderImage(glb, { format: 'png', sections: adapterSections });
expectTypeOf(renderModule.renderImageMaxSections).toEqualTypeOf<number>();

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
    { id: 'front', label: 'Front' },
    { id: 'top', label: 'Top' },
  ],
} as const satisfies ImagesOptions;
const rendered = renderImages(glb, options);
expectTypeOf(rendered).toEqualTypeOf<
  Promise<readonly [renderModule.RenderedImage<'front', 'png'>, renderModule.RenderedImage<'top', 'png'>]>
>();

const dynamicViews: renderModule.RenderImageView[] = [{ id: 'front' }];
const dynamic = renderImages(glb, { format: 'png', views: dynamicViews });
expectTypeOf(dynamic).toEqualTypeOf<Promise<readonly renderModule.RenderedImage<string, 'png'>[]>>();

// Per-view output overrides flow into each entry's mime type (R15), and
// timings: true adds typed timings to the result.
const ladder = renderImages(glb, {
  format: 'webp',
  views: [{ id: 'card' }, { id: 'hero', width: 1536, height: 804, format: 'png' }],
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
  views: [{ id: 'thumb' }, { id: 'frame', format: 'raw' }],
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
  views: [{ id: 'frame' }],
});
expectTypeOf(allRaw).toEqualTypeOf<Promise<readonly [renderModule.RenderedImage<'frame', 'raw'>]>>();
declare const sharedRawFile: Awaited<typeof allRaw>[0]['file'];
expectTypeOf(sharedRawFile.mimeType).toEqualTypeOf<'application/octet-stream'>();

const timed = renderImages(glb, {
  format: 'png',
  timings: true,
  views: [{ id: 'front' }],
});
expectTypeOf((await timed).timings).toEqualTypeOf<renderModule.RenderTimings>();
const untimed = await renderImages(glb, {
  format: 'png',
  views: [{ id: 'front' }],
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
      // @ts-expect-error axes is shared, not per view
      axes: true,
    },
  ],
});
void renderImages(glb, {
  format: 'png',
  world,
  views: [{ id: 'front' }],
});
void renderImages(glb, {
  format: 'png',
  views: [
    {
      id: 'front',
      // @ts-expect-error world is shared, not per view
      world,
    },
  ],
});
// A label's presence is its own switch: it stands alone, and a batch labels
// whichever views it chooses to.
void ({ format: 'png', label: 'Isometric' } as const satisfies ImageOptions);
const fixedCamera = {
  framing: 'fixed',
  position: [4, 3, 2],
  target: [0, 0, 0],
  up: [0, 1, 0],
  projection: { kind: 'perspective', verticalFieldOfView: 35, zoom: 1.5 },
  clipping: { near: 0.1, far: 100 },
} as const satisfies renderModule.RenderCamera;
expectTypeOf(fixedCamera.position).toEqualTypeOf<readonly [4, 3, 2]>();
void renderImage(glb, { format: 'png', camera: fixedCamera, lineWidth: 1 });
void ({
  format: 'png',
  views: [
    {
      id: 'front',
      label: 'Front',
      camera: {
        framing: 'fit',
        direction: [0, 0, 1],
        up: [0, 1, 0],
        projection: { kind: 'orthographic' },
      },
    },
    { id: 'top' },
  ],
} as const satisfies ImagesOptions);
void renderImages(glb, {
  format: 'png',
  views: [
    {
      id: 'front',
      // @ts-expect-error scaleBar is shared, not per view
      scaleBar: true,
    },
  ],
});
void renderImages(glb, {
  format: 'png',
  views: [
    {
      id: 'front',
      // @ts-expect-error presentation state is shared across a batch
      surfaces: false,
    },
  ],
});
void ({
  format: 'png',
  // @ts-expect-error singular label is not a batch-level property
  label: 'Front',
  views: [{ id: 'front' }],
} as const satisfies ImagesOptions);
// Per-view output overrides are part of the plan-entry schema (R15).
void ({
  format: 'png',
  views: [{ id: 'front', format: 'webp' }],
} as const satisfies ImagesOptions);
void ({
  format: 'png',
  // @ts-expect-error unknown per-view format
  views: [{ id: 'front', format: 'gif' }],
} as const satisfies ImagesOptions);
void ({
  format: 'png',
  // @ts-expect-error removed angle fields are not part of the camera contract
  phi: 90,
  views: [{ id: 'front' }],
} as const satisfies ImagesOptions);
void ({
  format: 'png',
  views: [
    {
      id: 'front',
      camera: {
        framing: 'fixed',
        position: [0, 0, 1],
        target: [0, 0, 0],
        up: [0, 1, 0],
        // @ts-expect-error fixed orthographic cameras require verticalSpan
        projection: {
          kind: 'orthographic',
        },
      },
    },
  ],
} as const satisfies ImagesOptions);
void ({
  format: 'png',
  views: [
    {
      id: 'front',
      camera: {
        framing: 'fit',
        // @ts-expect-error fitted cameras do not accept position
        position: [0, 0, 1],
      },
    },
  ],
} as const satisfies ImagesOptions);
void renderImages(glb, {
  format: 'png',
  views: [
    {
      id: 'front',
      camera: {
        framing: 'fixed',
        position: [0, 0, 1],
        target: [0, 0, 0],
        up: [0, 1, 0],
        projection: {
          kind: 'perspective',
          // @ts-expect-error deep unknown projection keys are rejected by generic calls
          fov: 45,
        },
      },
    },
  ],
});
// @ts-expect-error misspelled singular option
void ({ format: 'png', axis: true } as const satisfies ImageOptions);
void ({
  format: 'png',
  // @ts-expect-error misspelled plural option
  axis: true,
  views: [{ id: 'front' }],
} as const satisfies ImagesOptions);
// @ts-expect-error missing singular format
void ({ axes: true } as const satisfies ImageOptions);
void renderImages(glb, {
  format: 'png',
  lighting: 'studio',
  views: [{ id: 'front' }],
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
void renderImages(glb, {
  format: 'png',
  lighting: {
    lights: [
      {
        direction: [0, 1, 0],
        color: [1, 1, 1],
        // @ts-expect-error deep unknown light keys are rejected by generic calls
        intensity: 2,
      },
    ],
  },
  views: [{ id: 'front' }],
});
void renderImages(glb, {
  format: 'png',
  visiblePrimitives: [
    {
      nodeIndex: 0,
      meshIndex: 0,
      primitiveIndex: 0,
      // @ts-expect-error deep unknown primitive keys are rejected by generic calls
      componentId: 'part',
    },
  ],
  views: [{ id: 'front' }],
});
void ({
  format: 'png',
  lighting: {
    lights: [],
    // @ts-expect-error unknown environment name
    environment: 'sunset',
  },
  views: [{ id: 'front' }],
} as const satisfies ImagesOptions);
void renderImages(glb, { format: 'png', views: [{ id: 'front', width: 320 }] });
// @ts-expect-error missing view id
void ({ format: 'png', views: [{}] } as const satisfies ImagesOptions);
