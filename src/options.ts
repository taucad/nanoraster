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
   * Frame the directions are authored in. `'world'` fixes the lights to glTF
   * coordinates whatever camera is used, so views of one subject stop being
   * comparably lit.
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
 * A three-component vector in glTF world coordinates.
 *
 * @public
 */
export type RenderVector3 = readonly [x: number, y: number, z: number];

type RenderPerspectiveProjection = {
  /** Perspective projection. */
  readonly kind: 'perspective';
  /** Vertical field of view in degrees, from 1 to 179. @default 45 */
  readonly verticalFieldOfView?: number;
  /** Unitless magnification, from 0.01 to 100. @default 1 */
  readonly zoom?: number;
};

type RenderFitProjection =
  | Omit<RenderPerspectiveProjection, 'zoom'>
  | {
      /** Orthographic projection fitted to the subject bounds. */
      readonly kind: 'orthographic';
    };

type RenderFixedProjection =
  | RenderPerspectiveProjection
  | {
      /** Orthographic projection with an explicit visible vertical span. */
      readonly kind: 'orthographic';
      /** Visible vertical span in glTF world units before `zoom` is applied. */
      readonly verticalSpan: number;
      /** Unitless magnification, from 0.01 to 100. @default 1 */
      readonly zoom?: number;
    };

/**
 * Camera framing for one image.
 *
 * Fitted framing points a camera at the subject bounds and solves distance,
 * clipping, and magnification. Fixed framing preserves the supplied pose and
 * projection exactly; annotations never reframe it.
 *
 * @public
 */
export type RenderCamera =
  | {
      /** Let nanoraster frame the subject bounds. */
      readonly framing: 'fit';
      /** Direction from the bounds centre toward the camera. Magnitude is ignored. @default [0.6123724357, 0.5, 0.6123724357] */
      readonly direction?: RenderVector3;
      /** Camera screen-up direction. Magnitude is ignored. @default [0, 1, 0] */
      readonly up?: RenderVector3;
      /** Empty fraction around the fitted subject, from 0 to 0.5. @default 0.1 */
      readonly margin?: number;
      /** Fitted perspective or orthographic projection. @default perspective with a 45° vertical field of view */
      readonly projection?: RenderFitProjection;
    }
  | {
      /** Preserve an explicit camera pose and projection. */
      readonly framing: 'fixed';
      /** Camera position in glTF world coordinates. */
      readonly position: RenderVector3;
      /** Point the camera looks at in glTF world coordinates. */
      readonly target: RenderVector3;
      /** Camera screen-up direction. Magnitude is ignored. */
      readonly up: RenderVector3;
      /** Perspective or orthographic projection. @default perspective with a 45° vertical field of view and zoom 1 */
      readonly projection?: RenderFixedProjection;
      /** Explicit positive clip distances. Omit to derive safe planes from the subject bounds. */
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
  /** Edge line width in output pixels, from 0.25 to 16. @default 2 */
  readonly lineWidth?: number;
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
     * Attach stage timings (parse, setup, per-view render/overlay/encode) to
     * the result as a `timings` property. Rendering is unchanged.
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
 * pipeline's stages: parse, setup (device acquisition and geometry upload),
 * then per-view rasterise, annotation overlay, and encode.
 *
 * @public
 */
export type RenderTimings = {
  /** Milliseconds. GLB parse, validation, and world-bounds computation. */
  readonly parse: number;
  /** Milliseconds. Renderer acquisition plus scene upload for this call. */
  readonly setup: number;
  /** Per-view render/overlay/encode timings in plan order. */
  readonly views: readonly RenderViewTimings[];
};

type NoExtraKeys<Value, Shape> = Value & Record<Exclude<keyof Value, keyof Shape>, never>;

type StrictLighting<Lighting> = Lighting extends RenderLightingRig
  ? NoExtraKeys<Lighting, RenderLightingRig>
  : Lighting;

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
};

const singularKeys = new Set([
  'format',
  'width',
  'height',
  'quality',
  'camera',
  'lineWidth',
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
  'lineWidth',
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

/** Inclusive pixel bounds for image width and height. @public */
export const renderImageDimensionRange = [16, 4096] as const;

/** Inclusive encoder-quality bounds. @public */
export const renderImageQualityRange = [0, 1] as const;

/** Inclusive corner-fit margin bounds. @public */
export const renderImageMarginRange = [0, 0.5] as const;

/** Inclusive vertical field-of-view bounds in degrees. @public */
export const renderImageVerticalFieldOfViewRange = [1, 179] as const;

/** Inclusive camera magnification bounds. @public */
export const renderImageZoomRange = [0.01, 100] as const;

/** Inclusive edge line-width bounds in output pixels. @public */
export const renderImageLineWidthRange = [0.25, 16] as const;

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

const validateCamera = (camera: unknown, name: string): void => {
  if (camera === undefined) {
    return;
  }
  if (!isRecord(camera)) {
    throw new TypeError(`${name} must be an object`);
  }
  if (camera['framing'] === 'fit') {
    assertKnownKeys(camera, fitCameraKeys, name);
    const direction = cameraVector(
      camera['direction'] ?? [0.612_372_435_7, 0.5, 0.612_372_435_7],
      `${name}.direction`,
    );
    const up = cameraVector(camera['up'] ?? [0, 1, 0], `${name}.up`);
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
  validateCamera(options.camera, 'camera');
  assertOptionalBoolean(options.axes, 'axes');
  assertOptionalBoolean(options.scaleBar, 'scaleBar');
  validateAnnotatedDimensions(options, annotated);
  validateBackground(options.background);
  validateLighting(options.lighting);
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
    camera: options.camera,
    lineWidth: options.lineWidth,
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
    validateCamera(camera, `views[${index}].camera`);
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
    lineWidth: options.lineWidth,
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
