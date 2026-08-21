/** Consumer options and strict wire serialization for image rendering. */

import type { ImageFormat, RenderedImageFile } from '#image-file.js';

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
   * coordinates whatever `up` is, so views of one subject stop being
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

type RenderImageSharedOptions = {
  /** Required output encoder. `jpg` is an alias for `jpeg`. */
  readonly format: 'png' | 'webp' | 'jpeg' | 'jpg';
  /** Output width in pixels, inclusive range 16–4096. @default 768 */
  readonly width?: number;
  /** Output height in pixels, inclusive range 16–4096. @default 432 */
  readonly height?: number;
  /**
   * Encoder quality from 0 to 1. For WebP, 1 is lossless and anything lower
   * encodes lossy, following Chrome's canvas `toBlob` semantics. PNG ignores
   * quality.
   *
   * @default 0.92 (jpeg), 1 (webp)
   */
  readonly quality?: number;
  /** Empty fraction around the fitted subject, from 0 to 0.5. @default 0.1 */
  readonly margin?: number;
  /** World axis treated as up while placing and fitting the camera. @default 'y' */
  readonly up?: 'x' | 'y' | 'z';
  /** Camera projection used for the image. @default 'perspective' */
  readonly projection?: 'perspective' | 'orthographic';
  /** Transparent by default; otherwise `#RRGGBB`, `#RRGGBBAA`, or normalized sRGB straight-alpha RGBA. @default transparent */
  readonly background?: readonly [number, number, number, number] | string;
  /** Include the bottom-right camera-aware XYZ indicator and front-on depth marker. @default false */
  readonly includeAxes?: boolean;
  /** Include the top-left caller-authored label verbatim. Requires `label` on every rendered view. @default false */
  readonly includeLabel?: boolean;
  /**
   * Include a bottom-left physical scale. Perspective labels identify the
   * subject-center measurement plane with `@ center`; orthographic scale is
   * depth-invariant.
   *
   * @default false
   */
  readonly includeScale?: boolean;
  /**
   * Studio preset by default; a supplied rig replaces the direct lights and
   * inherits the other studio values. Determinism is unchanged: a fixed rig
   * gives fixed pixels.
   *
   * @default 'studio'
   */
  readonly lighting?: RenderLighting;
};

type RenderLabelOptions =
  | {
      readonly includeLabel: true;
      /** Screen-upright text; 1–64 supported Unicode code points and required when labels are enabled. */
      readonly label: string;
    }
  | {
      readonly includeLabel?: false;
      readonly label?: string;
    };

/**
 * Options for one rendered image.
 *
 * @public
 */
export type RenderImageOptions = RenderImageSharedOptions &
  RenderLabelOptions & {
    /** Polar camera angle from the selected up axis, in finite degrees. @default 60 */
    readonly phi?: number;
    /** Right-handed camera azimuth around the selected up axis, in finite degrees. @default -45 */
    readonly theta?: number;
  };

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
  /** Screen-upright caller-authored text rendered verbatim; required when `includeLabel` is true. */
  readonly label?: string;
  /** Polar camera angle from the selected up axis, in finite degrees. */
  readonly phi: number;
  /** Right-handed camera azimuth around the selected up axis, in finite degrees. */
  readonly theta: number;
  /** Output width override for this view, inclusive range 16–4096. @default the shared `width` */
  readonly width?: number;
  /** Output height override for this view, inclusive range 16–4096. @default the shared `height` */
  readonly height?: number;
  /** Output encoder override for this view. @default the shared `format` */
  readonly format?: 'png' | 'webp' | 'jpeg' | 'jpg';
  /** Encoder quality override for this view with the shared semantics (WebP: 1 is lossless, below 1 is lossy). @default the shared `quality` */
  readonly quality?: number;
};

type LabeledViews<Views extends readonly RenderImageView[]> = {
  readonly [Index in keyof Views]: Views[Index] & { readonly label: string };
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
     * the result as a `profile` property. Rendering is unchanged.
     *
     * @default false
     */
    readonly profile?: boolean;
  } & (
      | {
          readonly includeLabel: true;
          /** Non-empty ordered view tuple with unique IDs; every view needs a label when labels are enabled. */
          readonly views: LabeledViews<Views>;
        }
      | {
          readonly includeLabel?: false;
          readonly views: Views;
        }
    );

/**
 * Options for one raw-pixels render: the singular camera and annotation
 * settings minus `format` and `quality` (nothing is encoded).
 *
 * @public
 */
export type RenderPixelsOptions = Omit<RenderImageSharedOptions, 'format' | 'quality'> &
  RenderLabelOptions & {
    /** Polar camera angle from the selected up axis, in finite degrees. @default 60 */
    readonly phi?: number;
    /** Right-handed camera azimuth around the selected up axis, in finite degrees. @default -45 */
    readonly theta?: number;
  };

/**
 * One identified rendered file.
 *
 * @public
 */
export type RenderedImage<Id extends string = string, Format extends ImageFormat = ImageFormat> = {
  /** Stable identity copied from the corresponding input view. */
  readonly id: Id;
  /** Owned encoded image file for this view. */
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
 * Result of one plan call: the ordered tuple, plus the parsed profile when
 * the options literal set `profile: true`.
 *
 * @internal
 */
export type RenderedImagesResult<Options extends RenderImagesOptions> = RenderedImages<
  Options['views'],
  Options['format']
> &
  (Options extends { readonly profile: true } ? { readonly profile: RenderProfile } : unknown);

/**
 * Stage timings for one rendered view within a profiled plan call, in
 * milliseconds.
 *
 * @public
 */
export type RenderViewProfile = {
  /** Identity copied from the corresponding input view. */
  readonly id: string;
  /** GPU render, resolve, and pixel readback for this view. */
  readonly renderMs: number;
  /** Annotation stamping (zero when no annotations were requested). */
  readonly overlayMs: number;
  /** Image encoding in the requested format. */
  readonly encodeMs: number;
};

/**
 * Stage timings for one profiled plan call, in milliseconds. The fields map
 * onto the render pipeline's stages: parse, setup (device acquisition and
 * geometry upload), then per-view rasterise and encode.
 *
 * @public
 */
export type RenderProfile = {
  /** GLB parse, validation, and world-bounds computation. */
  readonly parseMs: number;
  /** Renderer acquisition plus scene upload for this call. */
  readonly setupMs: number;
  /** Per-view render/overlay/encode timings in plan order. */
  readonly views: readonly RenderViewProfile[];
};

type NoExtraKeys<Value, Shape> = Value & Record<Exclude<keyof Value, keyof Shape>, never>;

type StrictLighting<Lighting> = Lighting extends RenderLightingRig
  ? NoExtraKeys<Lighting, RenderLightingRig>
  : Lighting;

type StrictViews<Views extends readonly RenderImageView[]> = Views['length'] extends 0
  ? never
  : {
      readonly [Index in keyof Views]: Views[Index] extends RenderImageView
        ? NoExtraKeys<Views[Index], RenderImageView>
        : never;
    };

/**
 * Internal exact form used by the façade.
 *
 * @internal
 */
export type StrictRenderImagesOptions<Options extends RenderImagesOptions> = NoExtraKeys<
  Options,
  RenderImagesOptions
> & {
  readonly views: StrictViews<Options['views']>;
  readonly lighting?: StrictLighting<Options['lighting']>;
};

/**
 * Preserve literal singular option values while rejecting misspelled keys.
 *
 * @public
 * @param options - Singular image settings
 * @returns The same settings with literal types preserved
 */
export const createRenderImageOptions = <const Options extends RenderImageOptions>(
  options: NoExtraKeys<Options, RenderImageOptions> & {
    readonly lighting?: StrictLighting<Options['lighting']>;
  },
): Options => options;

/**
 * Preserve literal view IDs and order while rejecting misplaced or misspelled keys.
 *
 * @public
 * @param options - Shared settings and ordered views
 * @returns The same settings with literal view IDs and order preserved
 */
export const createRenderImagesOptions = <const Options extends RenderImagesOptions>(
  options: StrictRenderImagesOptions<Options>,
): Options => options;

const singularKeys = new Set([
  'format',
  'width',
  'height',
  'quality',
  'phi',
  'theta',
  'margin',
  'up',
  'projection',
  'background',
  'label',
  'includeAxes',
  'includeLabel',
  'includeScale',
  'lighting',
]);

const pluralKeys = new Set([
  'format',
  'width',
  'height',
  'quality',
  'margin',
  'up',
  'projection',
  'background',
  'includeAxes',
  'includeLabel',
  'includeScale',
  'lighting',
  'profile',
  'views',
]);

const pixelsKeys = new Set([...singularKeys].filter((key) => key !== 'format' && key !== 'quality'));

const viewKeys = new Set(['id', 'label', 'phi', 'theta', 'width', 'height', 'format', 'quality']);

const lightingKeys = new Set(['lights', 'ambient', 'environment', 'space', 'exposure']);

const lightKeys = new Set(['direction', 'color']);

/** Inclusive pixel bounds for image width and height. @public */
export const renderImageDimensionRange = [16, 4096] as const;

/** Inclusive encoder-quality bounds. @public */
export const renderImageQualityRange = [0, 1] as const;

/** Inclusive corner-fit margin bounds. @public */
export const renderImageMarginRange = [0, 0.5] as const;

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
const defaultWidth = 768;
const defaultHeight = 432;
const minimumLightDirectionLength = 1e-6;

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

type AssertFinite = (value: unknown, name: string) => asserts value is number;

const assertFinite: AssertFinite = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
};

const assertOptionalFinite = (value: unknown, name: string): void => {
  if (value !== undefined) {
    assertFinite(value, name);
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

const finiteTriple = (value: unknown, message: string): readonly number[] => {
  if (!isUnknownArray(value) || value.length !== 3) {
    throw new TypeError(message);
  }
  const numbers = value.filter(
    (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry),
  );
  if (numbers.length !== 3) {
    throw new TypeError(message);
  }
  return numbers;
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
  readonly includeLabel?: boolean;
};

const validateAnnotatedDimensions = (options: CameraCommonOptions): void => {
  if (![options.includeAxes, options.includeLabel, options.includeScale].includes(true)) {
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

const validateCommon = (options: Omit<RenderImageOptions, 'phi' | 'theta'>): void => {
  if (!['png', 'webp', 'jpeg', 'jpg'].includes(options.format)) {
    throw new TypeError('format must be png, webp, jpeg, or jpg');
  }
  if (options.quality !== undefined) {
    assertRange(options.quality, 'quality', renderImageQualityRange);
  }
  validateCameraCommon(options);
};

const validateCameraCommon = (options: CameraCommonOptions): void => {
  if (options.width !== undefined) {
    assertRange(options.width, 'width', renderImageDimensionRange);
  }
  if (options.height !== undefined) {
    assertRange(options.height, 'height', renderImageDimensionRange);
  }
  if (options.margin !== undefined) {
    assertRange(options.margin, 'margin', renderImageMarginRange);
  }
  if (options.up !== undefined && !['x', 'y', 'z'].includes(options.up)) {
    throw new TypeError('up must be x, y, or z');
  }
  if (options.projection !== undefined && !['perspective', 'orthographic'].includes(options.projection)) {
    throw new TypeError('projection must be perspective or orthographic');
  }
  assertOptionalBoolean(options.includeAxes, 'includeAxes');
  assertOptionalBoolean(options.includeLabel, 'includeLabel');
  assertOptionalBoolean(options.includeScale, 'includeScale');
  validateAnnotatedDimensions(options);
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
  assertKnownKeys(input, singularKeys, 'options');
  validateCommon(options);
  if (options.label !== undefined) {
    assertLabel(options.label, 'label');
  }
  if (input['includeLabel'] === true && input['label'] === undefined) {
    throw new TypeError('label is required when includeLabel is true');
  }
  assertOptionalFinite(options.phi, 'phi');
  assertOptionalFinite(options.theta, 'theta');
  return JSON.stringify({
    format: options.format,
    width: options.width,
    height: options.height,
    quality: options.quality,
    phi: options.phi,
    theta: options.theta,
    margin: options.margin,
    up: options.up,
    projection: options.projection,
    background: normalizedBackground(options.background),
    label: options.label,
    includeAxes: options.includeAxes,
    includeLabel: options.includeLabel,
    includeScale: options.includeScale,
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
  assertKnownKeys(input, pluralKeys, 'options');
  validateCommon(options);
  assertOptionalBoolean(options.profile, 'profile');
  const annotated = [options.includeAxes, options.includeLabel, options.includeScale].includes(true);
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
    assertKnownKeys(view, viewKeys, `views[${index}]`);
    const { id, label, phi, theta, width, height, format, quality } = view;
    if (typeof id !== 'string' || !renderImageViewIdPattern.test(id)) {
      throw new TypeError(`views[${index}].id must match ${viewIdDescription}`);
    }
    if (ids.has(id)) {
      throw new TypeError(`views contains duplicate id ${JSON.stringify(id)}`);
    }
    ids.add(id);
    assertFinite(phi, `views[${index}].phi`);
    assertFinite(theta, `views[${index}].theta`);
    if (width !== undefined) {
      assertRange(width, `views[${index}].width`, renderImageDimensionRange);
    }
    if (height !== undefined) {
      assertRange(height, `views[${index}].height`, renderImageDimensionRange);
    }
    if (format !== undefined && !['png', 'webp', 'jpeg', 'jpg'].some((name) => name === format)) {
      throw new TypeError(`views[${index}].format must be png, webp, jpeg, or jpg`);
    }
    if (quality !== undefined) {
      assertRange(quality, `views[${index}].quality`, renderImageQualityRange);
    }
    if (
      annotated &&
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
    if (options.includeLabel && label === undefined) {
      throw new TypeError(`views[${index}].label is required when includeLabel is true`);
    }
    normalizedViews.push({
      id,
      label,
      phi,
      theta,
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
    margin: options.margin,
    up: options.up,
    projection: options.projection,
    background: normalizedBackground(options.background),
    includeAxes: options.includeAxes,
    includeLabel: options.includeLabel,
    includeScale: options.includeScale,
    lighting: options.lighting,
    profile: options.profile,
    views: normalizedViews,
  });
};

/**
 * Validate and serialize one raw-pixels request for render-core.
 *
 * @internal
 * @param options - Singular camera and annotation settings, no encoder pair
 * @returns The validated JSON request
 */
export const toPixelsRequestJson = (options: RenderPixelsOptions): string => {
  const input: unknown = options;
  if (!isRecord(input)) {
    throw new TypeError('options must be an object');
  }
  assertKnownKeys(input, pixelsKeys, 'options');
  validateCameraCommon(options);
  if (options.label !== undefined) {
    assertLabel(options.label, 'label');
  }
  if (input['includeLabel'] === true && input['label'] === undefined) {
    throw new TypeError('label is required when includeLabel is true');
  }
  assertOptionalFinite(options.phi, 'phi');
  assertOptionalFinite(options.theta, 'theta');
  return JSON.stringify({
    width: options.width,
    height: options.height,
    phi: options.phi,
    theta: options.theta,
    margin: options.margin,
    up: options.up,
    projection: options.projection,
    background: normalizedBackground(options.background),
    label: options.label,
    includeAxes: options.includeAxes,
    includeLabel: options.includeLabel,
    includeScale: options.includeScale,
    lighting: options.lighting,
  });
};

/**
 * Derive the singular output filename.
 *
 * @internal
 * @param format - Encoded image format
 * @returns The singular output filename
 */
export const imageFileName = (format: ImageFormat): string => `render.${format}`;

/**
 * Derive an identified-view output filename.
 *
 * @internal
 * @param id - Validated view identifier
 * @param format - Encoded image format
 * @returns The identified output filename
 */
export const imageViewFileName = (id: string, format: ImageFormat): string => `render-${id}.${format}`;
