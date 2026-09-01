/** Consumer options and strict wire serialization for image rendering. */

import type { ImageFormat, RenderedImageFile } from '#image-file.js';
import { defaultHeight, defaultWidth } from '#image-file.js';

/**
 * One directional light.
 *
 * @public
 */
export type RenderLight = {
  /**
   * Direction from the surface toward the light — the vector dotted with the
   * surface normal. Any finite non-zero vector is accepted and normalized by
   * the renderer. View-space axes: `+x` right, `+y` up, `+z` toward the viewer.
   */
  readonly direction: readonly [number, number, number];
  /** Linear RGB radiance, unitless, each channel within `renderImageLightColorRange`. */
  readonly color: readonly [number, number, number];
};

/**
 * Explicit rig replacing the studio lights.
 *
 * @public
 */
export type RenderLightingRig = {
  /**
   * Direct lights replacing the studio ones, from none to
   * `renderImageMaxLights`. An empty array renders from the environment alone.
   */
  readonly lights: readonly RenderLight[];
  /** Flat ambient multiplier on the diffuse color, from 0 to 4. @default 0.02 */
  readonly ambient?: number;
  /** Analytic environment supplying specular reflection and diffuse irradiance; `'none'` removes both. @default 'studio' */
  readonly environment?: 'studio' | 'none';
  /**
   * Frame the directions are authored in. `'world'` fixes the lights to the
   * request's caller world whatever camera is used, so views of one subject
   * stop being comparably lit.
   *
   * @default 'view'
   */
  readonly space?: 'view' | 'world';
  /** Linear multiplier applied before tone mapping, from 0.01 to 16. @default 1 */
  readonly exposure?: number;
};

/**
 * The `'studio'` preset name or an explicit rig.
 *
 * @public
 */
export type RenderLighting = 'studio' | RenderLightingRig;

/**
 * A three-component vector in the request's caller-world coordinates. Those
 * are glTF world coordinates when `world` is omitted.
 *
 * @public
 */
export type RenderVector3 = readonly [x: number, y: number, z: number];

/** A signed caller-world axis. @public */
export type RenderWorldAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/**
 * Caller-world orbit angles in degrees — the polar form of a camera
 * {@link RenderVector3} direction, converted by
 * {@link directionFromOrbit} and {@link orbitFromDirection}.
 *
 * @public
 */
export type RenderOrbit = {
  /** Angle above the caller-world horizontal plane, from -90 to 90. */
  readonly elevation: number;
  /** Angle in that plane, from `world.forward` toward the caller's right. */
  readonly azimuth: number;
};

/**
 * Coordinate system of request-space values and rendered presentation.
 * Submitted GLB bytes always remain glTF: right-handed, +Y up, +Z forward,
 * and metres. Omitted fields use those glTF defaults.
 *
 * @public
 */
export type RenderWorld = {
  /** Caller-world up axis. @default '+y' */
  readonly up?: RenderWorldAxis;
  /** Caller-world forward axis. @default '+z' */
  readonly forward?: RenderWorldAxis;
  /** Length unit of caller-world spatial values. @default 'meter' */
  readonly unit?: 'meter' | 'millimeter';
};

/** One source glTF primitive instance. @public */
export type RenderPrimitiveReference = {
  /** Source node index, which disambiguates shared mesh instances. */
  readonly nodeIndex: number;
  /** Source mesh index referenced by the node. */
  readonly meshIndex: number;
  /** Source primitive index within the mesh. */
  readonly primitiveIndex: number;
};

/** One world-space retained-half-space plane. @public */
export type RenderSectionPlane = {
  /** A point on the plane in caller-world coordinates. */
  readonly point: RenderVector3;
  /** Non-zero normal pointing into the retained half-space. */
  readonly normal: RenderVector3;
};

/** One or more section planes and the geometry classes they clip. @public */
export type RenderSections = {
  /** One to {@link renderImageMaxSections} simultaneous retained half-spaces. */
  readonly planes: readonly [RenderSectionPlane, ...RenderSectionPlane[]];
  /** Clip triangle surfaces and draw their caps. @default true */
  readonly clipSurfaces?: boolean;
  /** Clip authored line primitives. @default true */
  readonly clipLines?: boolean;
};

type RenderPerspectiveProjection = {
  /** Rectilinear perspective projection. */
  readonly kind: 'perspective';
  /** Vertical field of view in degrees, from 1 to 179. @default 45 */
  readonly verticalFieldOfView?: number;
  /** Unitless magnification, from 0.01 to 100. @default 1 */
  readonly zoom?: number;
};

type RenderFitProjection =
  | Omit<RenderPerspectiveProjection, 'zoom'>
  | {
      /** Orthographic projection fitted to referenced subject geometry. */
      readonly kind: 'orthographic';
    };

type RenderFixedProjection =
  | RenderPerspectiveProjection
  | {
      /** Orthographic projection with an explicit visible vertical span. */
      readonly kind: 'orthographic';
      /** Visible vertical span in caller-world units before `zoom` is applied. */
      readonly verticalSpan: number;
      /** Unitless magnification, from 0.01 to 100. @default 1 */
      readonly zoom?: number;
    };

/**
 * Camera framing for one image.
 *
 * Fitted framing orients a camera toward referenced subject geometry and
 * solves its optical target, distance, and clipping. Fixed framing preserves
 * the supplied pose and projection exactly; annotations never reframe it.
 *
 * @public
 */
export type RenderCamera =
  | {
      /** Let nanoraster frame referenced subject geometry. */
      readonly framing: 'fit';
      /** Direction from the subject toward the camera; fit may translate the optical axis. Magnitude is ignored. @default [0.6123724357, 0.5, 0.6123724357] */
      readonly direction?: RenderVector3;
      /** Camera screen-up direction. Magnitude is ignored. @default [0, 1, 0] */
      readonly up?: RenderVector3;
      /** Minimum empty fraction around contained fitted geometry, from 0 to 0.5. Aspect, front clearance, or annotations may add whitespace. @default 0.1 */
      readonly margin?: number;
      /** Fitted perspective or orthographic projection. @default perspective with a 45° vertical field of view */
      readonly projection?: RenderFitProjection;
    }
  | {
      /** Preserve an explicit camera pose and projection. */
      readonly framing: 'fixed';
      /** Camera position in caller-world coordinates. */
      readonly position: RenderVector3;
      /** Point the camera looks at in caller-world coordinates. */
      readonly target: RenderVector3;
      /** Camera screen-up direction. Magnitude is ignored. */
      readonly up: RenderVector3;
      /** Perspective or orthographic projection. @default perspective with a 45° vertical field of view and zoom 1 */
      readonly projection?: RenderFixedProjection;
      /** Explicit positive clip distances in caller-world units. Unused range outside referenced subject geometry is tightened to preserve depth precision. */
      readonly clipping?: {
        readonly near: number;
        readonly far: number;
      };
    };

type RenderImageSharedOptions = {
  /**
   * Required output format. `jpg` is an alias for `jpeg`. `'raw'` skips the
   * encoder and returns the frame itself: straight-alpha, sRGB-encoded RGBA8,
   * exactly `width * height * 4` bytes, row-major with the top row first, four
   * bytes per pixel and no padding, owned by the caller.
   */
  readonly format: 'png' | 'webp' | 'jpeg' | 'jpg' | 'raw';
  /** Output width in pixels, inclusive range 16–4096. @default 768 */
  readonly width?: number;
  /** Output height in pixels, inclusive range 16–4096. @default 432 */
  readonly height?: number;
  /**
   * Encoder quality from 0 to 1. For WebP, 1 is lossless and anything lower
   * encodes lossy, following Chrome's canvas `toBlob` semantics. PNG and raw
   * ignore quality.
   *
   * @default 0.92 (jpeg), 1 (webp)
   */
  readonly quality?: number;
  /** Caller coordinate system for spatial request values and presentation. @default glTF world */
  readonly world?: RenderWorld;
  /** Edge line width in output pixels, from 0.25 to 16. @default 3 */
  readonly lineWidth?: number;
  /** Draw triangle primitives. @default true */
  readonly surfaces?: boolean;
  /** Draw authored line primitives. @default true */
  readonly lines?: boolean;
  /**
   * Exact source primitive instances to render. Omit for all; an empty array renders none.
   * @default all
   */
  readonly visiblePrimitives?: readonly RenderPrimitiveReference[];
  /**
   * World-space section planes. Omit to disable sections.
   * @default disabled
   */
  readonly sections?: RenderSections;
  /** Transparent by default; otherwise `#RRGGBB`, `#RRGGBBAA`, or normalized sRGB straight-alpha RGBA. @default transparent */
  readonly background?: readonly [number, number, number, number] | string;
  /** Draw the bottom-right camera-aware XYZ indicator and front-on depth marker. @default false */
  readonly axes?: boolean;
  /**
   * Draw a bottom-left physical scale bar. Perspective labels identify the
   * subject-center measurement plane with `@ center`; orthographic scale is
   * depth-invariant.
   *
   * @default false
   */
  readonly scaleBar?: boolean;
  /**
   * Studio preset by default; a supplied rig replaces the direct lights and
   * inherits the other studio values. Determinism is unchanged: a fixed rig
   * gives fixed pixels.
   *
   * @default 'studio'
   */
  readonly lighting?: RenderLighting;
};

/** The singular camera plus the top-left label, whose presence is its switch. */
type RenderCameraOptions = {
  /** Screen-upright text drawn top-left; 1–64 supported Unicode code points. Omit it to draw no label. */
  readonly label?: string;
  /** Camera framing. Omit it for the default fitted three-quarter view. */
  readonly camera?: RenderCamera;
};

/**
 * Options for one rendered image.
 *
 * @public
 */
export type RenderImageOptions = RenderImageSharedOptions & RenderCameraOptions;

/**
 * One identified camera in a multi-image request: camera identity plus
 * optional per-view output overrides. An override defaults to the shared
 * call-level value, so one plan call can render a whole resolution or format
 * ladder of the same subject.
 *
 * @public
 */
export type RenderImageView<Id extends string = string> = {
  /** Unique result and filename identity matching `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. */
  readonly id: Id;
  /** Screen-upright caller-authored text rendered verbatim. Its presence draws this view's label. */
  readonly label?: string;
  /** Camera framing. Omit it for the default fitted three-quarter view. */
  readonly camera?: RenderCamera;
  /** Output width override for this view, inclusive range 16–4096. @default the shared `width` */
  readonly width?: number;
  /** Output height override for this view, inclusive range 16–4096. @default the shared `height` */
  readonly height?: number;
  /** Output format override for this view, `'raw'` included. @default the shared `format` */
  readonly format?: 'png' | 'webp' | 'jpeg' | 'jpg' | 'raw';
  /** Encoder quality override for this view with the shared semantics (WebP: 1 is lossless, below 1 is lossy). @default the shared `quality` */
  readonly quality?: number;
};

/**
 * Shared settings plus an ordered collection of camera views.
 *
 * @public
 */
export type RenderImagesOptions<Views extends readonly RenderImageView[] = readonly RenderImageView[]> =
  RenderImageSharedOptions & {
    /**
     * Attach stage timings and resource counters to the result as a `timings`
     * property. Rendering is unchanged.
     *
     * @default false
     */
    readonly timings?: boolean;
    /** Non-empty ordered view tuple with unique IDs. */
    readonly views: Views;
  };

/**
 * One identified rendered file.
 *
 * @public
 */
export type RenderedImage<Id extends string = string, Format extends ImageFormat = ImageFormat> = {
  /** Stable identity copied from the corresponding input view. */
  readonly id: Id;
  /** Owned output file for this view. */
  readonly file: RenderedImageFile<Format>;
};

type ViewOutputFormat<View, SharedFormat extends ImageFormat> = View extends {
  readonly format: infer Format extends ImageFormat;
}
  ? Format
  : SharedFormat;

/**
 * Result tuple whose IDs and order follow the input view tuple. Each entry's
 * MIME type follows its view's `format` override, falling back to the shared
 * format.
 *
 * @public
 */
export type RenderedImages<
  Views extends readonly RenderImageView[],
  SharedFormat extends ImageFormat = ImageFormat,
> = {
  readonly [Index in keyof Views]: Views[Index] extends RenderImageView<infer Id>
    ? RenderedImage<Id, ViewOutputFormat<Views[Index], SharedFormat>>
    : never;
};

/**
 * Result of one plan call: the ordered tuple, plus the parsed timings when
 * the options literal set `timings: true`. This is what
 * `renderImages`/`Renderer.renderImages` resolve to, so consumers can name
 * their own return types.
 *
 * @public
 */
export type RenderedImagesResult<Options extends RenderImagesOptions> = RenderedImages<
  Options['views'],
  Options['format']
> &
  (Options extends { readonly timings: true } ? { readonly timings: RenderTimings } : unknown);

/**
 * Stage timings for one rendered view within a timed plan call.
 *
 * @public
 */
export type RenderViewTimings = {
  /** Identity copied from the corresponding input view. */
  readonly id: string;
  /** Milliseconds. GPU render, resolve, and pixel readback for this view. */
  readonly render: number;
  /** Milliseconds. Annotation stamping (zero when no annotations were requested). */
  readonly overlay: number;
  /** Milliseconds. Image encoding in the requested format. */
  readonly encode: number;
};

/**
 * Stage timings for one timed plan call. The fields map onto the render
 * pipeline's stages and reports the resources acquired by this call.
 *
 * @public
 */
export type RenderTimings = {
  /** Milliseconds. GLB parse, validation, and world-bounds computation. */
  readonly parse: number;
  /** Milliseconds. Renderer acquisition plus all presentation and upload work. */
  readonly setup: number;
  /** Milliseconds. Visibility resolution, section-cap construction, and cap upload. */
  readonly capBuild: number;
  /** Milliseconds. Source triangle and authored-line upload. */
  readonly upload: number;
  /** Largest readback allocation required by one view, in bytes. */
  readonly peakReadbackBytes: number;
  /** GLB parses performed by this call. */
  readonly glbParses: number;
  /** Adapter/device acquisitions performed by this call. */
  readonly adapterDeviceRequests: number;
  /** Pipeline sets created by this call. */
  readonly pipelineSets: number;
  /** Shared presentation plans built by this call. */
  readonly presentationBuilds: number;
  /** Source scenes uploaded by this call. */
  readonly sceneUploads: number;
  /** Render targets allocated by this call. */
  readonly targetAllocations: number;
  /** Per-view render/overlay/encode timings in plan order. */
  readonly views: readonly RenderViewTimings[];
};

type NoExtraKeys<Value, Shape> = Value & Record<Exclude<keyof Value, keyof Shape>, never>;

type StrictItems<Items extends readonly Shape[], Shape> = {
  readonly [Index in keyof Items]: Items[Index] extends Shape ? NoExtraKeys<Items[Index], Shape> : never;
};

type StrictLighting<Lighting> = Lighting extends RenderLightingRig
  ? NoExtraKeys<Lighting, RenderLightingRig> & {
      readonly lights: StrictItems<Lighting['lights'], RenderLight>;
    }
  : Lighting;

type StrictVisiblePrimitives<Primitives> = Primitives extends readonly RenderPrimitiveReference[]
  ? StrictItems<Primitives, RenderPrimitiveReference>
  : Primitives;

type StrictWorld<World> = World extends RenderWorld ? NoExtraKeys<World, RenderWorld> : World;

type StrictSectionPlane<Plane> = Plane extends RenderSectionPlane
  ? NoExtraKeys<Plane, RenderSectionPlane>
  : never;

type StrictSectionPlanes<Planes extends readonly RenderSectionPlane[]> = number extends Planes['length']
  ? readonly StrictSectionPlane<Planes[number]>[]
  : Planes extends readonly [
        infer First extends RenderSectionPlane,
        ...infer Rest extends readonly RenderSectionPlane[],
      ]
    ? readonly [StrictSectionPlane<First>, ...StrictSectionPlanes<Rest>]
    : readonly [];

type StrictSections<Sections> = Sections extends RenderSections
  ? NoExtraKeys<Sections, RenderSections> & {
      readonly planes: StrictSectionPlanes<Sections['planes']>;
    }
  : Sections;

type StrictProjection<Projection> = Projection extends { readonly kind: 'perspective' }
  ? NoExtraKeys<Projection, RenderPerspectiveProjection>
  : Projection extends { readonly kind: 'orthographic'; readonly verticalSpan: number }
    ? NoExtraKeys<Projection, Extract<RenderFixedProjection, { readonly kind: 'orthographic' }>>
    : Projection extends { readonly kind: 'orthographic' }
      ? NoExtraKeys<Projection, Extract<RenderFitProjection, { readonly kind: 'orthographic' }>>
      : Projection;

type StrictCamera<Camera> = Camera extends { readonly framing: 'fit' }
  ? NoExtraKeys<Camera, Extract<RenderCamera, { readonly framing: 'fit' }>> & {
      readonly projection?: StrictProjection<Camera extends { readonly projection?: infer P } ? P : never>;
    }
  : Camera extends { readonly framing: 'fixed' }
    ? NoExtraKeys<Camera, Extract<RenderCamera, { readonly framing: 'fixed' }>> & {
        readonly projection?: StrictProjection<Camera extends { readonly projection?: infer P } ? P : never>;
        readonly clipping?: NoExtraKeys<
          Camera extends { readonly clipping?: infer C } ? C : never,
          { readonly near: number; readonly far: number }
        >;
      }
    : Camera;

type StrictViews<Views extends readonly RenderImageView[]> = Views['length'] extends 0
  ? never
  : {
      readonly [Index in keyof Views]: Views[Index] extends RenderImageView
        ? NoExtraKeys<Views[Index], RenderImageView> & {
            readonly camera?: StrictCamera<
              Views[Index] extends { readonly camera?: infer Camera } ? Camera : never
            >;
          }
        : never;
    };

/**
 * The exact form `renderImages` accepts: {@link RenderImagesOptions} plus
 * compile-time rejection of extra keys, empty view tuples, and misplaced
 * per-view settings. Name it when wrapping the plan call in your own generic
 * function.
 *
 * @public
 */
export type StrictRenderImagesOptions<Options extends RenderImagesOptions> = NoExtraKeys<
  Options,
  RenderImagesOptions
> & {
  readonly views: StrictViews<Options['views']>;
  readonly lighting?: StrictLighting<Options['lighting']>;
  readonly visiblePrimitives?: StrictVisiblePrimitives<Options['visiblePrimitives']>;
  readonly sections?: StrictSections<Options['sections']>;
  readonly world?: StrictWorld<Options['world']>;
};

const singularKeys = new Set([
  'format',
  'width',
  'height',
  'quality',
  'world',
  'camera',
  'lineWidth',
  'surfaces',
  'lines',
  'visiblePrimitives',
  'sections',
  'background',
  'label',
  'axes',
  'scaleBar',
  'lighting',
]);

const pluralKeys = new Set([
  'format',
  'width',
  'height',
  'quality',
  'world',
  'lineWidth',
  'surfaces',
  'lines',
  'visiblePrimitives',
  'sections',
  'background',
  'axes',
  'scaleBar',
  'lighting',
  'timings',
  'views',
]);

const viewKeys = new Set(['id', 'label', 'camera', 'width', 'height', 'format', 'quality']);

const fitCameraKeys = new Set(['framing', 'direction', 'up', 'margin', 'projection']);

const fixedCameraKeys = new Set(['framing', 'position', 'target', 'up', 'projection', 'clipping']);

const fitPerspectiveProjectionKeys = new Set(['kind', 'verticalFieldOfView']);

const fitOrthographicProjectionKeys = new Set(['kind']);

const fixedPerspectiveProjectionKeys = new Set(['kind', 'verticalFieldOfView', 'zoom']);

const fixedOrthographicProjectionKeys = new Set(['kind', 'verticalSpan', 'zoom']);

const clippingKeys = new Set(['near', 'far']);

const lightingKeys = new Set(['lights', 'ambient', 'environment', 'space', 'exposure']);

const lightKeys = new Set(['direction', 'color']);

const primitiveRefKeys = new Set(['nodeIndex', 'meshIndex', 'primitiveIndex']);

const sectionsKeys = new Set(['planes', 'clipSurfaces', 'clipLines']);

const sectionPlaneKeys = new Set(['point', 'normal']);

const worldKeys = new Set(['up', 'forward', 'unit']);

const orbitKeys = new Set(['azimuth', 'elevation']);

const worldAxes: readonly RenderWorldAxis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

/** Inclusive pixel bounds for image width and height. @public */
export const renderImageDimensionRange = [16, 4096] as const;

/** Inclusive encoder-quality bounds. @public */
export const renderImageQualityRange = [0, 1] as const;

/** Inclusive minimum fitted-margin bounds. @public */
export const renderImageMarginRange = [0, 0.5] as const;

/** Inclusive vertical field-of-view bounds in degrees. @public */
export const renderImageVerticalFieldOfViewRange = [1, 179] as const;

/** Inclusive camera magnification bounds. @public */
export const renderImageZoomRange = [0.01, 100] as const;

/** Inclusive edge line-width bounds in output pixels. @public */
export const renderImageLineWidthRange = [0.25, 16] as const;

/** Most simultaneous section planes one request may carry. @public */
export const renderImageMaxSections = 8;

/** Most directional lights one rig may carry. @public */
export const renderImageMaxLights = 8;

/** Inclusive per-channel bounds for light radiance. @public */
export const renderImageLightColorRange = [0, 32] as const;

/** Inclusive bounds for the flat ambient multiplier. @public */
export const renderImageAmbientRange = [0, 4] as const;

/** Inclusive bounds for the pre-tone-map exposure multiplier. @public */
export const renderImageExposureRange = [0.01, 16] as const;

/** Minimum dimension when an annotation is enabled. @public */
export const renderImageAnnotatedMinDimension = 192;

/** Maximum label length in Unicode code points. @public */
export const renderImageLabelMaxLength = 64;

/** Supported label characters. @public */
export const renderImageLabelPattern = /^[\u0020-\u007E\u00B5\u2014\u2212]+$/u;

/** Stable view-identifier syntax. @public */
export const renderImageViewIdPattern = /^[\dA-Za-z][\w-]{0,63}$/u;

/** Hex clear-color syntax. @public */
export const renderImageBackgroundPattern = /^#[\dA-Fa-f]{6}(?:[\dA-Fa-f]{2})?$/u;

const viewIdDescription = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}';
const minimumLightDirectionLength = 1e-6;
const minimumCameraVectorLength = 1e-6;
const legacyCameraKeys = new Set(['phi', 'theta', 'up', 'projection', 'margin']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

const assertKnownKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  name: string,
): void => {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`${name} contains unknown property ${JSON.stringify(unknown)}`);
  }
};

const assertNoLegacyCameraKeys = (value: Record<string, unknown>, name: string): void => {
  const removed = Object.keys(value).find((key) => legacyCameraKeys.has(key));
  if (removed !== undefined) {
    throw new TypeError(
      `${name}.${removed} was removed; use ${name}.camera with framing, Cartesian vectors, and a nested projection`,
    );
  }
};

type AssertFinite = (value: unknown, name: string) => asserts value is number;

const assertFinite: AssertFinite = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
};

const assertOptionalBoolean = (value: unknown, name: string): void => {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }
};

type AssertLabel = (value: unknown, name: string) => asserts value is string;

const assertLabel: AssertLabel = (value, name) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const characters = Array.from(value);
  if (characters.length > renderImageLabelMaxLength) {
    throw new TypeError(`${name} must contain at most ${renderImageLabelMaxLength} characters`);
  }
  const unsupported = characters.find((character) => !renderImageLabelPattern.test(character));
  if (unsupported !== undefined) {
    throw new TypeError(`${name} contains unsupported character ${JSON.stringify(unsupported)}`);
  }
};

const assertRange = (
  value: unknown,
  name: string,
  bounds: readonly [minimum: number, maximum: number],
): void => {
  const [minimum, maximum] = bounds;
  assertFinite(value, name);
  if (value < minimum || value > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
};

const assertOptionalEnum = (value: unknown, name: string, allowed: readonly string[]): void => {
  if (value !== undefined && !allowed.some((option) => option === value)) {
    throw new TypeError(`${name} must be ${allowed.join(' or ')}`);
  }
};

const worldAxisVector = (axis: RenderWorldAxis): RenderVector3 => {
  const sign = axis[0] === '+' ? 1 : -1;
  if (axis.endsWith('x')) {
    return [sign, 0, 0];
  }
  if (axis.endsWith('y')) {
    return [0, sign, 0];
  }
  return [0, 0, sign];
};

/**
 * Mirror render-core's `resolve_world`: the pair is supplied together or not
 * at all, both names are signed axes, and they name different axes. No
 * handedness rule — render-core derives the caller's right as
 * `up × forward`, which makes `(right, up, forward)` right-handed for every
 * one of the 24 non-collinear pairs, so all 24 are legal.
 */
const validateWorld = (world: unknown): void => {
  if (world === undefined) {
    return;
  }
  if (!isRecord(world)) {
    throw new TypeError('world must be an object');
  }
  assertKnownKeys(world, worldKeys, 'world');
  const up = (world['up'] === undefined ? '+y' : world['up']) as RenderWorldAxis;
  const forward = (world['forward'] === undefined ? '+z' : world['forward']) as RenderWorldAxis;
  assertOptionalEnum(up, 'world.up', worldAxes);
  assertOptionalEnum(forward, 'world.forward', worldAxes);
  assertOptionalEnum(world['unit'], 'world.unit', ['meter', 'millimeter']);
  if ((world['up'] === undefined) !== (world['forward'] === undefined)) {
    throw new TypeError('world.up and world.forward must be provided together');
  }
  if (up.slice(1) === forward.slice(1)) {
    throw new TypeError('world.up and world.forward must name different axes');
  }
};

const isFiniteTriple = (value: unknown): value is RenderVector3 =>
  isUnknownArray(value) &&
  value.length === 3 &&
  value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));

const finiteTriple = (value: unknown, message: string): RenderVector3 => {
  if (!isFiniteTriple(value)) {
    throw new TypeError(message);
  }
  return value;
};

const cameraVector = (value: unknown, name: string, allowZero = false): RenderVector3 => {
  const vector = finiteTriple(value, `${name} must contain three finite numbers`);
  if (!allowZero && Math.hypot(...vector) < minimumCameraVectorLength) {
    throw new TypeError(`${name} must not be zero length`);
  }
  return vector;
};

const degreesPerRadian = 180 / Math.PI;

const orbitElevationRange = [-90, 90] as const;

/**
 * The default fitted three-quarter view. Holding it in orbit form leaves one
 * derivation of the default direction rather than a literal per call site.
 */
const defaultFitOrbit: RenderOrbit = { azimuth: 45, elevation: 30 };

const dot = (left: RenderVector3, right: RenderVector3): number =>
  left[0] * right[0] + left[1] * right[1] + left[2] * right[2];

/**
 * The declared world's forward, right, and up axes. `right = up × forward`
 * matches render-core's caller basis, so azimuth turns the same way on both
 * sides of the wire.
 */
const orbitBasis = (
  world: RenderWorld | undefined,
): readonly [forward: RenderVector3, right: RenderVector3, up: RenderVector3] => {
  validateWorld(world);
  const up = worldAxisVector(world?.up ?? '+y');
  const forward = worldAxisVector(world?.forward ?? '+z');
  return [
    forward,
    [
      up[1] * forward[2] - up[2] * forward[1],
      up[2] * forward[0] - up[0] * forward[2],
      up[0] * forward[1] - up[1] * forward[0],
    ],
    up,
  ];
};

/**
 * Convert caller-world orbit angles to the unit direction they name.
 *
 * `azimuth` 0 sits on `world.forward` and turns positively toward the
 * caller's right; `elevation` lifts out of that plane toward `world.up`.
 * The result is the inverse of {@link orbitFromDirection} under the
 * same world.
 *
 * @public
 * @param orbit - Azimuth and elevation in degrees, elevation within -90 to 90
 * @param world - Caller coordinate system the angles are read in; omit it for the glTF world
 * @returns The unit direction in caller-world coordinates
 */
export const directionFromOrbit = (orbit: RenderOrbit, world?: RenderWorld): RenderVector3 => {
  if (!isRecord(orbit)) {
    throw new TypeError('orbit must be an object');
  }
  assertKnownKeys(orbit, orbitKeys, 'orbit');
  assertFinite(orbit.azimuth, 'orbit.azimuth');
  assertRange(orbit.elevation, 'orbit.elevation', orbitElevationRange);
  const [forward, right, up] = orbitBasis(world);
  const azimuth = orbit.azimuth / degreesPerRadian;
  const elevation = orbit.elevation / degreesPerRadian;
  const alongForward = Math.cos(elevation) * Math.cos(azimuth);
  const alongRight = Math.cos(elevation) * Math.sin(azimuth);
  const alongUp = Math.sin(elevation);
  return [
    forward[0] * alongForward + right[0] * alongRight + up[0] * alongUp,
    forward[1] * alongForward + right[1] * alongRight + up[1] * alongUp,
    forward[2] * alongForward + right[2] * alongRight + up[2] * alongUp,
  ];
};

/**
 * Convert a caller-world direction to the orbit angles that name it.
 *
 * Magnitude is ignored. `azimuth` comes back normalized to the half-open
 * range -180 (exclusive) to 180 (inclusive). A direction lying exactly on
 * `world.up` or its negative has no azimuth in the horizontal plane, so
 * elevation is ±90 and azimuth is reported as 0.
 *
 * @public
 * @param direction - Non-zero direction in caller-world coordinates
 * @param world - Caller coordinate system the direction is read in; omit it for the glTF world
 * @returns The azimuth and elevation in degrees
 */
export const orbitFromDirection = (direction: RenderVector3, world?: RenderWorld): RenderOrbit => {
  const vector = cameraVector(direction, 'direction');
  const [forward, right, up] = orbitBasis(world);
  const alongForward = dot(vector, forward);
  const alongRight = dot(vector, right);
  const alongUp = dot(vector, up) / Math.hypot(...vector);
  return {
    // `+ 0` folds a negative zero to positive, so a direction opposite
    // `world.forward` reports 180 rather than -180.
    azimuth:
      alongForward === 0 && alongRight === 0
        ? 0
        : Math.atan2(alongRight + 0, alongForward) * degreesPerRadian,
    elevation: Math.asin(Math.min(Math.max(alongUp, -1), 1)) * degreesPerRadian,
  };
};

const normalizedCrossLength = (left: RenderVector3, right: RenderVector3): number => {
  const leftLength = Math.hypot(...left);
  const rightLength = Math.hypot(...right);
  return (
    Math.hypot(
      left[1] * right[2] - left[2] * right[1],
      left[2] * right[0] - left[0] * right[2],
      left[0] * right[1] - left[1] * right[0],
    ) /
    (leftLength * rightLength)
  );
};

const validateProjection = (projection: unknown, name: string, framing: RenderCamera['framing']): void => {
  if (projection === undefined) {
    return;
  }
  if (!isRecord(projection)) {
    throw new TypeError(`${name} must be an object`);
  }
  const { kind } = projection;
  if (kind === 'perspective') {
    assertKnownKeys(
      projection,
      framing === 'fit' ? fitPerspectiveProjectionKeys : fixedPerspectiveProjectionKeys,
      name,
    );
    if (projection['verticalFieldOfView'] !== undefined) {
      assertRange(
        projection['verticalFieldOfView'],
        `${name}.verticalFieldOfView`,
        renderImageVerticalFieldOfViewRange,
      );
    }
    if (projection['zoom'] !== undefined) {
      assertRange(projection['zoom'], `${name}.zoom`, renderImageZoomRange);
    }
    return;
  }
  if (kind === 'orthographic') {
    assertKnownKeys(
      projection,
      framing === 'fit' ? fitOrthographicProjectionKeys : fixedOrthographicProjectionKeys,
      name,
    );
    if (framing === 'fixed') {
      assertFinite(projection['verticalSpan'], `${name}.verticalSpan`);
      if (projection['verticalSpan'] <= 0) {
        throw new TypeError(`${name}.verticalSpan must be greater than 0`);
      }
      if (projection['zoom'] !== undefined) {
        assertRange(projection['zoom'], `${name}.zoom`, renderImageZoomRange);
      }
    }
    return;
  }
  throw new TypeError(`${name}.kind must be perspective or orthographic`);
};

const validateCamera = (camera: unknown, name: string, world?: RenderWorld): void => {
  if (camera === undefined) {
    return;
  }
  if (!isRecord(camera)) {
    throw new TypeError(`${name} must be an object`);
  }
  if (camera['framing'] === 'fit') {
    assertKnownKeys(camera, fitCameraKeys, name);
    // Both fit defaults are read in the declared world, as render-core reads
    // them: an omitted direction is `world.default_fit_direction()` and an
    // omitted up is `world.caller_up`. Defaulting either in the glTF basis
    // would make the collinearity verdict disagree with the authority.
    const direction = cameraVector(
      camera['direction'] ?? directionFromOrbit(defaultFitOrbit, world),
      `${name}.direction`,
    );
    const up = cameraVector(camera['up'] ?? worldAxisVector(world?.up ?? '+y'), `${name}.up`);
    if (normalizedCrossLength(direction, up) < minimumCameraVectorLength) {
      throw new TypeError(`${name}.direction and ${name}.up must not be collinear`);
    }
    if (camera['margin'] !== undefined) {
      assertRange(camera['margin'], `${name}.margin`, renderImageMarginRange);
    }
    validateProjection(camera['projection'], `${name}.projection`, 'fit');
    return;
  }
  if (camera['framing'] !== 'fixed') {
    throw new TypeError(`${name}.framing must be fit or fixed`);
  }
  assertKnownKeys(camera, fixedCameraKeys, name);
  const position = cameraVector(camera['position'], `${name}.position`, true);
  const target = cameraVector(camera['target'], `${name}.target`, true);
  const up = cameraVector(camera['up'], `${name}.up`);
  const direction: RenderVector3 = [
    position[0] - target[0],
    position[1] - target[1],
    position[2] - target[2],
  ];
  if (Math.hypot(...direction) < minimumCameraVectorLength) {
    throw new TypeError(`${name}.position and ${name}.target must not coincide`);
  }
  if (normalizedCrossLength(direction, up) < minimumCameraVectorLength) {
    throw new TypeError(`${name}.view direction and ${name}.up must not be collinear`);
  }
  validateProjection(camera['projection'], `${name}.projection`, 'fixed');
  const clipping = camera['clipping'];
  if (clipping !== undefined) {
    if (!isRecord(clipping)) {
      throw new TypeError(`${name}.clipping must be an object`);
    }
    assertKnownKeys(clipping, clippingKeys, `${name}.clipping`);
    assertFinite(clipping['near'], `${name}.clipping.near`);
    assertFinite(clipping['far'], `${name}.clipping.far`);
    if (clipping['near'] <= 0) {
      throw new TypeError(`${name}.clipping.near must be greater than 0`);
    }
    if (clipping['far'] <= clipping['near']) {
      throw new TypeError(`${name}.clipping.far must be greater than ${name}.clipping.near`);
    }
  }
};

const validateLight = (light: unknown, name: string): void => {
  if (!isRecord(light)) {
    throw new TypeError(`${name} must be an object`);
  }
  assertKnownKeys(light, lightKeys, name);
  const direction = finiteTriple(light['direction'], `${name}.direction must contain three finite numbers`);
  if (Math.hypot(...direction) < minimumLightDirectionLength) {
    throw new TypeError(`${name}.direction must not be zero length`);
  }
  const [minimum, maximum] = renderImageLightColorRange;
  const colorMessage = `${name}.color must contain three channels between ${minimum} and ${maximum}`;
  const color = finiteTriple(light['color'], colorMessage);
  if (color.some((channel) => channel < minimum || channel > maximum)) {
    throw new TypeError(colorMessage);
  }
};

const validateLighting = (lighting: unknown): void => {
  if (lighting === undefined || lighting === 'studio') {
    return;
  }
  if (!isRecord(lighting)) {
    throw new TypeError('lighting must be studio or a rig object');
  }
  assertKnownKeys(lighting, lightingKeys, 'lighting');
  const { lights, ambient, environment, space, exposure } = lighting;
  if (!isUnknownArray(lights)) {
    throw new TypeError('lighting.lights must be an array');
  }
  if (lights.length > renderImageMaxLights) {
    throw new TypeError(`lighting.lights must contain at most ${renderImageMaxLights} lights`);
  }
  for (const [index, light] of lights.entries()) {
    validateLight(light, `lighting.lights[${index}]`);
  }
  if (ambient !== undefined) {
    assertRange(ambient, 'lighting.ambient', renderImageAmbientRange);
  }
  if (exposure !== undefined) {
    assertRange(exposure, 'lighting.exposure', renderImageExposureRange);
  }
  assertOptionalEnum(environment, 'lighting.environment', ['studio', 'none']);
  assertOptionalEnum(space, 'lighting.space', ['view', 'world']);
};

const validatePresentation = (options: CameraCommonOptions): void => {
  assertOptionalBoolean(options.surfaces, 'surfaces');
  assertOptionalBoolean(options.lines, 'lines');
  if (options.visiblePrimitives !== undefined) {
    if (!isUnknownArray(options.visiblePrimitives)) {
      throw new TypeError('visiblePrimitives must be an array');
    }
    const seen = new Set<string>();
    for (const [index, primitive] of options.visiblePrimitives.entries()) {
      const name = `visiblePrimitives[${index}]`;
      if (!isRecord(primitive)) {
        throw new TypeError(`${name} must be an object`);
      }
      assertKnownKeys(primitive, primitiveRefKeys, name);
      const values = [primitive.nodeIndex, primitive.meshIndex, primitive.primitiveIndex];
      if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new TypeError(`${name} indices must be non-negative safe integers`);
      }
      const identity = values.join(':');
      if (seen.has(identity)) {
        throw new TypeError(`${name} duplicates an earlier primitive reference`);
      }
      seen.add(identity);
    }
  }
  if (options.sections === undefined) {
    return;
  }
  const { sections } = options;
  if (!isRecord(sections)) {
    throw new TypeError('sections must be an object');
  }
  assertKnownKeys(sections, sectionsKeys, 'sections');
  assertOptionalBoolean(sections['clipSurfaces'], 'sections.clipSurfaces');
  assertOptionalBoolean(sections['clipLines'], 'sections.clipLines');
  const planes = sections['planes'];
  if (!isUnknownArray(planes) || planes.length === 0 || planes.length > renderImageMaxSections) {
    throw new TypeError(`sections.planes must contain between 1 and ${renderImageMaxSections} planes`);
  }
  for (const [index, plane] of planes.entries()) {
    const name = `sections.planes[${index}]`;
    if (!isRecord(plane)) {
      throw new TypeError(`${name} must be an object`);
    }
    assertKnownKeys(plane, sectionPlaneKeys, name);
    cameraVector(plane['point'], `${name}.point`, true);
    cameraVector(plane['normal'], `${name}.normal`);
  }
};

const parseHexColor = (value: string): readonly [number, number, number, number] => {
  if (!renderImageBackgroundPattern.test(value)) {
    throw new TypeError('background must be #RRGGBB or #RRGGBBAA');
  }
  const hex = value.slice(1);
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
    hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  ];
};

type CameraCommonOptions = Omit<RenderImageSharedOptions, 'format' | 'quality'> & {
  readonly label?: string;
  readonly camera?: RenderCamera;
};

/**
 * Hold an annotated request to the minimum size its overlays stay legible at.
 * `annotated` is decided by the caller because only a singular request renders
 * at the shared width/height: a batch renders at each view's effective size,
 * which the per-view rule in {@link toImagesRequestJson} checks instead.
 */
const validateAnnotatedDimensions = (options: CameraCommonOptions, annotated: boolean): void => {
  if (!annotated) {
    return;
  }
  if (
    (options.width ?? defaultWidth) < renderImageAnnotatedMinDimension ||
    (options.height ?? defaultHeight) < renderImageAnnotatedMinDimension
  ) {
    throw new TypeError(
      `annotated images must be at least ${renderImageAnnotatedMinDimension}x${renderImageAnnotatedMinDimension}`,
    );
  }
};

const validateBackground = (background: unknown): void => {
  if (typeof background === 'string') {
    parseHexColor(background);
    return;
  }
  if (
    background !== undefined &&
    (!isUnknownArray(background) ||
      background.length !== 4 ||
      background.some(
        (channel) => typeof channel !== 'number' || !Number.isFinite(channel) || channel < 0 || channel > 1,
      ))
  ) {
    throw new TypeError('background must contain four channels between 0 and 1');
  }
};

const validateCommon = (options: RenderImageOptions, annotated: boolean): void => {
  if (!['png', 'webp', 'jpeg', 'jpg', 'raw'].includes(options.format)) {
    throw new TypeError('format must be png, webp, jpeg, jpg, or raw');
  }
  if (options.quality !== undefined) {
    assertRange(options.quality, 'quality', renderImageQualityRange);
  }
  validateCameraCommon(options, annotated);
};

const validateCameraCommon = (options: CameraCommonOptions, annotated: boolean): void => {
  if (options.width !== undefined) {
    assertRange(options.width, 'width', renderImageDimensionRange);
  }
  if (options.height !== undefined) {
    assertRange(options.height, 'height', renderImageDimensionRange);
  }
  if (options.lineWidth !== undefined) {
    assertRange(options.lineWidth, 'lineWidth', renderImageLineWidthRange);
  }
  // World first: the camera's fit defaults are resolved in it.
  validateWorld(options.world);
  validateCamera(options.camera, 'camera', options.world);
  assertOptionalBoolean(options.axes, 'axes');
  assertOptionalBoolean(options.scaleBar, 'scaleBar');
  validateAnnotatedDimensions(options, annotated);
  validateBackground(options.background);
  validateLighting(options.lighting);
  validatePresentation(options);
};

const normalizedBackground = (
  background: RenderImageOptions['background'],
): readonly [number, number, number, number] | undefined =>
  typeof background === 'string' ? parseHexColor(background) : background;

/**
 * Validate and serialize one request for render-core.
 *
 * @internal
 * @param options - Singular render options
 * @returns The validated JSON request
 */
export const toImageRequestJson = (options: RenderImageOptions): string => {
  const input: unknown = options;
  if (!isRecord(input)) {
    throw new TypeError('options must be an object');
  }
  assertNoLegacyCameraKeys(input, 'options');
  assertKnownKeys(input, singularKeys, 'options');
  validateCommon(options, options.axes === true || options.scaleBar === true || options.label !== undefined);
  if (options.label !== undefined) {
    assertLabel(options.label, 'label');
  }
  return JSON.stringify({
    format: options.format,
    width: options.width,
    height: options.height,
    quality: options.quality,
    world: options.world,
    camera: options.camera,
    lineWidth: options.lineWidth,
    surfaces: options.surfaces,
    lines: options.lines,
    visiblePrimitives: options.visiblePrimitives,
    sections: options.sections,
    background: normalizedBackground(options.background),
    label: options.label,
    axes: options.axes,
    scaleBar: options.scaleBar,
    lighting: options.lighting,
  });
};

/**
 * Validate and serialize one ordered multi-image request for render-core.
 *
 * @internal
 * @param options - Shared render options and ordered views
 * @returns The validated JSON request
 */
export const toImagesRequestJson = (options: RenderImagesOptions): string => {
  const input: unknown = options;
  if (!isRecord(input)) {
    throw new TypeError('options must be an object');
  }
  assertNoLegacyCameraKeys(input, 'options');
  assertKnownKeys(input, pluralKeys, 'options');
  validateCommon(options, false);
  assertOptionalBoolean(options.timings, 'timings');
  const sharedAnnotated = options.axes === true || options.scaleBar === true;
  const { views } = input;
  if (!isUnknownArray(views) || views.length === 0) {
    throw new TypeError('views must contain at least one view');
  }
  const ids = new Set<string>();
  const normalizedViews: RenderImageView[] = [];
  for (const [index, view] of views.entries()) {
    if (!isRecord(view)) {
      throw new TypeError(`views[${index}] must be an object`);
    }
    if ('world' in view) {
      throw new TypeError(`views[${index}].world is not allowed; world is shared by every view`);
    }
    assertNoLegacyCameraKeys(view, `views[${index}]`);
    assertKnownKeys(view, viewKeys, `views[${index}]`);
    const { id, label, camera, width, height, format, quality } = view;
    if (typeof id !== 'string' || !renderImageViewIdPattern.test(id)) {
      throw new TypeError(`views[${index}].id must match ${viewIdDescription}`);
    }
    if (ids.has(id)) {
      throw new TypeError(`views contains duplicate id ${JSON.stringify(id)}`);
    }
    ids.add(id);
    validateCamera(camera, `views[${index}].camera`, options.world);
    if (width !== undefined) {
      assertRange(width, `views[${index}].width`, renderImageDimensionRange);
    }
    if (height !== undefined) {
      assertRange(height, `views[${index}].height`, renderImageDimensionRange);
    }
    if (format !== undefined && !['png', 'webp', 'jpeg', 'jpg', 'raw'].some((name) => name === format)) {
      throw new TypeError(`views[${index}].format must be png, webp, jpeg, jpg, or raw`);
    }
    if (quality !== undefined) {
      assertRange(quality, `views[${index}].quality`, renderImageQualityRange);
    }
    if (
      (sharedAnnotated || label !== undefined) &&
      (((width as number | undefined) ?? options.width ?? defaultWidth) < renderImageAnnotatedMinDimension ||
        ((height as number | undefined) ?? options.height ?? defaultHeight) <
          renderImageAnnotatedMinDimension)
    ) {
      throw new TypeError(
        `views[${index}]: annotated images must be at least ${renderImageAnnotatedMinDimension}x${renderImageAnnotatedMinDimension}`,
      );
    }
    if (label !== undefined) {
      assertLabel(label, `views[${index}].label`);
    }
    normalizedViews.push({
      id,
      label,
      camera: camera as RenderCamera | undefined,
      width: width as number | undefined,
      height: height as number | undefined,
      format: format as RenderImageView['format'],
      quality: quality as number | undefined,
    });
  }
  return JSON.stringify({
    format: options.format,
    width: options.width,
    height: options.height,
    quality: options.quality,
    world: options.world,
    lineWidth: options.lineWidth,
    surfaces: options.surfaces,
    lines: options.lines,
    visiblePrimitives: options.visiblePrimitives,
    sections: options.sections,
    background: normalizedBackground(options.background),
    axes: options.axes,
    scaleBar: options.scaleBar,
    lighting: options.lighting,
    timings: options.timings,
    views: normalizedViews,
  });
};

/**
 * Derive the singular output filename (`render.raw` for the raw format).
 *
 * @internal
 * @param format - Output image format
 * @returns The singular output filename
 */
export const imageFileName = (format: ImageFormat): string => `render.${format}`;

/**
 * Derive an identified-view output filename (`render-<id>.raw` for raw).
 *
 * @internal
 * @param id - Validated view identifier
 * @param format - Output image format
 * @returns The identified output filename
 */
export const imageViewFileName = (id: string, format: ImageFormat): string => `render-${id}.${format}`;
