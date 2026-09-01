import {
  directionFromOrbit,
  orbitFromDirection,
  type RenderOrbit,
  type RenderVector3,
  type RenderWorld,
} from 'nanoraster';

/** Where one editable demo literal belongs. */
export type DemoScope = 'option' | 'material';

/**
 * The widget a bound literal gets. Lengths carry model-derived bounds, so the
 * shapes below are produced by {@link demoControlTemplates} rather than
 * authored as constants: the same catalogue against a 22 mm gear and a 1 m
 * assembly yields different numbers.
 */
export type DemoControlTemplate =
  | { readonly kind: 'range'; readonly min: number; readonly max: number; readonly step: number }
  /** A length spanning decades — one slider over log10, so both ends are reachable. */
  | { readonly kind: 'log'; readonly min: number; readonly max: number }
  /** Three stacked sliders for a point or an HDR colour. */
  | { readonly kind: 'triple'; readonly min: number; readonly max: number; readonly step: number }
  /** A signed distance along a section plane's own normal. */
  | { readonly kind: 'offset'; readonly min: number; readonly max: number; readonly step: number }
  /** Azimuth and elevation in the caller's world; magnitude is not a degree of freedom. */
  | { readonly kind: 'orbit' }
  /** One of the six signed axes. */
  | { readonly kind: 'axis' }
  | { readonly kind: 'choice'; readonly choices: readonly string[]; readonly labels?: readonly string[] }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'colour' }
  | { readonly kind: 'text' };

export type DemoControl = {
  readonly key: string;
  readonly label: string;
  /** The full option path, for a tooltip when the label is shortened. */
  readonly title?: string;
  readonly view?: string;
} & DemoControlTemplate;

export type DemoValue = number | string | boolean | readonly number[];
export type DemoPathPart = string | number;
export type DemoSpan = { readonly start: number; readonly end: number };

export type DemoVector3 = readonly [number, number, number];

/** `Array.isArray` widens a `DemoValue` to `any[]`; this keeps the numbers. */
export const isVector = (value: DemoValue | undefined): value is readonly number[] => Array.isArray(value);

/** Signed-axis names in the order the `up` select offers them. */
export const demoAxes = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;
export type DemoAxis = (typeof demoAxes)[number];

const axisVectors: Readonly<Record<DemoAxis, DemoVector3>> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};

export const demoAxisVector = (axis: DemoAxis): DemoVector3 => axisVectors[axis];

/** The axis a vector names exactly, or `undefined` when it names none. */
export const demoAxisOf = (value: DemoValue | undefined): DemoAxis | undefined =>
  isVector(value)
    ? demoAxes.find((axis) => axisVectors[axis].every((part, index) => part === value[index]))
    : undefined;

/**
 * Keep the literal written back into the example readable. `toFixed(10)` is
 * far below a visible step at any camera distance, and the snap keeps a pole
 * reading `[0, 0, 1]` rather than `[0, 0, 0.9999999999]`.
 */
const tidy = (value: number): number => (Math.abs(value) < 1e-10 ? 0 : Number(value.toFixed(10)));

const world = (declared: unknown): RenderWorld | undefined =>
  declared !== null && typeof declared === 'object' && !Array.isArray(declared) ? declared : undefined;

/**
 * The package's own orbit pair, applied to a demo's declared world.
 *
 * Azimuth zero sits on `world.forward` and grows toward the caller's right —
 * the convention the exported helpers define, which is what the guides teach.
 */
export const demoDirectionFromOrbit = (orbit: RenderOrbit, declaredWorld?: unknown): DemoVector3 => {
  const [x, y, z] = directionFromOrbit(orbit, world(declaredWorld));
  return [tidy(x), tidy(y), tidy(z)];
};

/** Recover the orbit angles a Cartesian direction sits at. */
export const demoOrbitFromDirection = (
  direction: readonly number[],
  declaredWorld?: unknown,
): RenderOrbit => {
  const vector: RenderVector3 = [direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0];
  if (!vector.some((part) => part !== 0 && Number.isFinite(part))) return { azimuth: 0, elevation: 0 };
  return orbitFromDirection(vector, world(declaredWorld));
};

const dot = (left: readonly number[], right: readonly number[]): number =>
  (left[0] ?? 0) * (right[0] ?? 0) + (left[1] ?? 0) * (right[1] ?? 0) + (left[2] ?? 0) * (right[2] ?? 0);

/** How far along its own normal a section plane's point sits. */
export const demoPlaneOffset = (point: readonly number[], normal: readonly number[]): number => {
  const length = Math.hypot(normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 0);
  return length === 0 ? 0 : dot(point, normal) / length;
};

/** The point a signed offset along the normal names. */
export const demoPlanePoint = (offset: number, normal: readonly number[]): DemoVector3 => {
  const length = Math.hypot(normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 0);
  if (length === 0) return [0, 0, 0];
  return [
    tidy(((normal[0] ?? 0) / length) * offset),
    tidy(((normal[1] ?? 0) / length) * offset),
    tidy(((normal[2] ?? 0) / length) * offset),
  ];
};

type DemoCamera = {
  readonly framing: 'fit' | 'fixed';
  readonly direction?: DemoVector3;
  readonly position?: DemoVector3;
  readonly target?: DemoVector3;
  readonly up?: DemoVector3;
  readonly margin?: number;
  readonly projection?: {
    readonly kind: 'perspective' | 'orthographic';
    readonly verticalFieldOfView?: number;
    readonly verticalSpan?: number;
    readonly zoom?: number;
  };
  readonly clipping?: { readonly near: number; readonly far: number };
};

export type DemoView = {
  readonly id: string;
  readonly label?: string;
  readonly camera?: DemoCamera;
};

export type DemoLight = {
  readonly direction: DemoVector3;
  readonly color: DemoVector3;
};

export type DemoBinding = {
  readonly control: string;
  readonly key: string;
  readonly label: string;
  readonly path: readonly DemoPathPart[];
  readonly scope: DemoScope;
  readonly value: DemoValue;
  readonly valueSpan: DemoSpan;
  readonly deleteSpan?: DemoSpan;
  /**
   * Present when the example authors this vector as a
   * `directionFromOrbit` call, carrying the source text of the world
   * argument it passes. Edits are written back in the same form.
   */
  readonly orbit?: { readonly world?: string };
  readonly title?: string;
  readonly view?: string;
};

/** Build-time description consumed by the client without parsing TypeScript. */
export type DemoDescriptor = {
  readonly bindings: readonly DemoBinding[];
  readonly code: string;
  /**
   * The diagonal of the rendered model's bounding box, in scene units. Every
   * length control is scaled by it, so a control's smallest nudge is a nudge
   * on *this* model rather than on an imagined unit cube.
   */
  readonly diagonal: number;
  readonly lights?: readonly DemoLight[];
  readonly material: Readonly<Record<string, DemoValue>>;
  readonly raw: boolean;
  readonly request: Readonly<Record<string, unknown>>;
  readonly views: readonly DemoView[];
};

/**
 * The control each bindable option name gets, sized to the model on screen.
 *
 * Lengths are expressed as multiples of the bounding-box diagonal `d`: the
 * whole travel of a plane offset is the model, one step of a position is
 * half a percent of it, and the clipping sliders span the decades either side
 * rather than a linear track whose authored value sits at 0.4 % of it.
 */
/**
 * A symmetric length track whose ends are a whole number of steps from zero.
 *
 * A raw multiple of the diagonal gives `min` and `step` eighteen significant
 * digits, and the browser snaps a range input to `min + n * step`: at the far
 * end of such a track the snap lands a few times 10^-18 outside `min`, and the
 * control reports `rangeUnderflow` while holding a value the renderer accepts.
 * Rounding the step to three significant digits and placing the ends on it
 * keeps the arithmetic exact enough to snap cleanly.
 */
const lengthTrack = (extent: number, steps: number): { min: number; max: number; step: number } => {
  const step = Number((extent / steps).toPrecision(3));
  const end = step * steps;
  return { min: -end, max: end, step };
};

export const demoControlTemplates = (d: number): Readonly<Record<string, DemoControlTemplate>> => ({
  margin: { kind: 'range', min: 0, max: 0.5, step: 0.01 },
  direction: { kind: 'orbit' },
  normal: { kind: 'orbit' },
  up: { kind: 'axis' },
  position: { kind: 'triple', ...lengthTrack(3 * d, 600) },
  target: { kind: 'triple', ...lengthTrack(d, 200) },
  point: { kind: 'offset', ...lengthTrack(d / 2, 200) },
  verticalFieldOfView: { kind: 'range', min: 1, max: 179, step: 1 },
  verticalSpan: { kind: 'range', min: d / 20, max: 4 * d, step: d / 400 },
  zoom: { kind: 'range', min: 0.01, max: 4, step: 0.01 },
  near: { kind: 'log', min: d / 1000, max: 10 * d },
  far: { kind: 'log', min: d / 100, max: 1000 * d },
  lineWidth: { kind: 'range', min: 0.25, max: 16, step: 0.25 },
  surfaces: { kind: 'toggle' },
  lines: { kind: 'toggle' },
  clipSurfaces: { kind: 'toggle' },
  clipLines: { kind: 'toggle' },
  format: { kind: 'choice', choices: ['png', 'webp', 'jpeg'] },
  quality: { kind: 'range', min: 0, max: 1, step: 0.01 },
  background: {
    kind: 'choice',
    choices: ['#00000000', '#101418', '#252525', '#ffffff', '#1d4ed8'],
    labels: ['transparent', 'dark', 'grey', 'white', 'blue'],
  },
  axes: { kind: 'toggle' },
  scaleBar: { kind: 'toggle' },
  label: { kind: 'text' },
  ambient: { kind: 'range', min: 0, max: 1, step: 0.01 },
  exposure: { kind: 'range', min: 0.1, max: 4, step: 0.05 },
  environment: { kind: 'choice', choices: ['studio', 'none'] },
  space: { kind: 'choice', choices: ['view', 'world'] },
  color: { kind: 'triple', min: 0, max: 4, step: 0.05 },
  baseColorFactor: { kind: 'colour' },
  metallicFactor: { kind: 'range', min: 0, max: 1, step: 0.01 },
  roughnessFactor: { kind: 'range', min: 0, max: 1, step: 0.01 },
});

/** Every option name a demo can bind a control to. */
export const demoControlNames: readonly string[] = Object.keys(demoControlTemplates(1));

/**
 * Why an authored literal cannot be expressed by its own control, or
 * `undefined` when it can.
 *
 * A demo whose example sets a value its control cannot reach shows the reader
 * one request and renders another — `clipping: { far: 1 }` under a slider
 * whose floor was 2 read `2` beside `far: 1`. This is the check that turns
 * that class of drift into a failed docs build.
 */
export const demoBoundsViolation = (
  template: DemoControlTemplate,
  value: DemoValue,
  normal?: DemoValue,
): string | undefined => {
  const parts = isVector(value) ? value : undefined;
  const outside = (min: number, max: number, each: readonly number[]): string | undefined =>
    each.every((part) => part >= min && part <= max)
      ? undefined
      : `${JSON.stringify(value)} is outside ${min} … ${max}`;

  switch (template.kind) {
    case 'range':
    case 'log': {
      return typeof value === 'number'
        ? outside(template.min, template.max, [value])
        : `${JSON.stringify(value)} is not a number`;
    }
    case 'triple': {
      return parts === undefined
        ? `${JSON.stringify(value)} is not a vector`
        : outside(template.min, template.max, parts);
    }
    case 'offset': {
      // The slider drives a signed distance along the plane's own normal, so
      // that is what has to be reachable. The point's distance from the origin
      // is not: `[0, 100, 0]` under a `[1, 0, 0]` normal names the same plane
      // as `[0, 0, 0]`, and the tangential component moves nothing.
      return parts === undefined
        ? `${JSON.stringify(value)} is not a vector`
        : outside(template.min, template.max, [
            isVector(normal) ? demoPlaneOffset(parts, normal) : Math.hypot(...parts),
          ]);
    }
    case 'orbit': {
      return parts !== undefined && parts.length === 3 && parts.some((part) => part !== 0)
        ? undefined
        : `${JSON.stringify(value)} is not a non-zero direction`;
    }
    case 'axis': {
      // A non-axis `up` keeps its raw XYZ boxes, which can express anything.
      return undefined;
    }
    case 'choice': {
      return template.choices.includes(String(value))
        ? undefined
        : `${JSON.stringify(value)} is not one of ${template.choices.join(', ')}`;
    }
    case 'text': {
      return cleanLabel(String(value)) === value
        ? undefined
        : `${JSON.stringify(value)} is not a legal label`;
    }
    default: {
      return undefined;
    }
  }
};

/** Keep demo labels inside the renderer's public label alphabet and limit. */
export const cleanLabel = (raw: string): string =>
  raw.replace(/[^\u0020-\u007E\u00B5\u2014\u2212]/gu, '').slice(0, 64);

export const readDemoOptions = (descriptor: DemoDescriptor): Record<string, DemoValue> =>
  Object.fromEntries(descriptor.bindings.map(({ key, value }) => [key, value]));

/**
 * The controls one panel shows.
 *
 * View-scoped controls — a view's label as much as its camera — belong to the
 * selected view only, so a four-view sheet shows one view's group rather than
 * four labels competing with one view's sliders.
 */
export const demoControls = (descriptor: DemoDescriptor, selectedViewId?: string): readonly DemoControl[] => {
  const templates = demoControlTemplates(descriptor.diagonal);
  const hasQuality = descriptor.bindings.some(
    ({ control, view }) => control === 'quality' && view === undefined,
  );
  const selected =
    selectedViewId ??
    descriptor.views.find(({ camera }) => camera !== undefined)?.id ??
    descriptor.views.at(0)?.id;
  return descriptor.bindings.flatMap((binding) => {
    if (binding.view !== undefined && binding.view !== selected) return [];
    if (binding.control === 'format' && !hasQuality) return [];
    return [
      {
        ...templates[binding.control],
        key: binding.key,
        label: binding.label,
        ...(binding.title === undefined ? {} : { title: binding.title }),
        ...(binding.view === undefined ? {} : { view: binding.view }),
      },
    ];
  });
};

export const isRawDemo = (descriptor: DemoDescriptor): boolean => descriptor.raw;

/**
 * Write a replacement in the style the example already uses: array elements
 * spaced the way the author spaced them, strings in the quote the author
 * chose. What the reader copies stays the file they were reading.
 */
const formatValue = (value: DemoValue, authored: string): string => {
  if (Array.isArray(value)) return `[${value.join(authored.includes(', ') ? ', ' : ',')}]`;
  // A label the reader typed can carry the quote it is being wrapped in, or a
  // backslash that would escape the closing one. Both have to survive as text.
  if (typeof value === 'string')
    return authored.startsWith("'") ? `'${value.replace(/['\\]/gu, '\\$&')}'` : JSON.stringify(value);
  return JSON.stringify(value);
};

/**
 * The helper call that names a direction, or `undefined` when no whole-degree
 * pair does.
 *
 * An angle-driven vector is written back as the call a reader would author, so
 * a drag moves two integers instead of thirty digits of float — the example
 * stays short, near enough fixed width, and says what the two sliders mean.
 * The round-trip keeps that honest: a direction typed into the XYZ boxes that
 * no whole-degree orbit names stays a Cartesian literal.
 */
const orbitCall = (
  value: readonly number[],
  declaredWorld: unknown,
  { azimuthEnd, worldArgument }: { readonly azimuthEnd?: number; readonly worldArgument?: string },
): string | undefined => {
  const orbit = demoOrbitFromDirection(value, declaredWorld);
  const canonical = Math.round(orbit.azimuth);
  // -180 and 180 name one direction, and the recovered angle is always the
  // canonical 180. The example prints the end the reader is holding.
  const azimuth = canonical === 180 && azimuthEnd === -180 ? -180 : canonical;
  const elevation = Math.round(orbit.elevation);
  const exact = demoDirectionFromOrbit({ azimuth, elevation }, declaredWorld);
  if (exact.some((part, index) => Math.abs(part - (value[index] ?? 0)) > 1e-9)) return undefined;
  const world = worldArgument === undefined ? '' : `, ${worldArgument}`;
  return `directionFromOrbit({ azimuth: ${azimuth}, elevation: ${elevation} }${world})`;
};

/**
 * Round a control's value to the precision its own step warrants.
 *
 * A slider that writes ten decimals into the example changes the length of its
 * line on every drag, which is what makes the block's scrollbar appear and
 * disappear mid-gesture. Rounding the value rather than its printed form keeps
 * the request that runs identical to the request on screen.
 */
export const demoQuantize = (template: DemoControlTemplate | undefined, value: DemoValue): DemoValue => {
  if (template === undefined || !('step' in template)) return value;
  const places = Math.min(6, Math.max(0, Math.ceil(-Math.log10(template.step)) + 1));
  const round = (part: number): number => Number(part.toFixed(places));
  if (typeof value === 'number') return round(value);
  return isVector(value) ? value.map(round) : value;
};

/** Rewrite only build-time-proven literal spans; no client-side source discovery. */
export const substituteDemoValues = (
  descriptor: DemoDescriptor,
  values: Record<string, DemoValue>,
  azimuthEnds?: ReadonlyMap<string, number>,
): string => {
  const edits = descriptor.bindings.flatMap((binding) => {
    const value = values[binding.key];
    if (Object.is(value, binding.value)) return [];
    if (binding.control === 'label' && value === '' && binding.deleteSpan !== undefined) {
      return [{ ...binding.deleteSpan, replacement: '' }];
    }
    const authored = descriptor.code.slice(binding.valueSpan.start, binding.valueSpan.end);
    const call =
      binding.orbit === undefined || !isVector(value)
        ? undefined
        : orbitCall(value, descriptor.request['world'], {
            azimuthEnd: azimuthEnds?.get(binding.key),
            worldArgument: binding.orbit.world,
          });
    return [{ ...binding.valueSpan, replacement: call ?? formatValue(value, authored) }];
  });
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (code, { start, end, replacement }) => `${code.slice(0, start)}${replacement}${code.slice(end)}`,
      descriptor.code,
    );
};

/** Caption a tile with what its view declares, and nothing it does not. */
export const describeDemoView = (view: DemoView): string =>
  view.camera === undefined
    ? 'default camera'
    : [view.camera.framing, view.camera.projection?.kind].filter((part) => part !== undefined).join(' · ');
