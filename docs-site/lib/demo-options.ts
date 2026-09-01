/** Where one editable demo literal belongs. */
export type DemoScope = 'option' | 'material';

export type DemoControl = { readonly key: string; readonly label: string } & (
  | { readonly kind: 'range'; readonly min: number; readonly max: number; readonly step: number }
  | { readonly kind: 'choice'; readonly choices: readonly string[]; readonly labels?: readonly string[] }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'colour' }
  | { readonly kind: 'vector'; readonly min: number; readonly max: number; readonly step: number }
  | { readonly kind: 'text'; readonly view?: string }
);

export type DemoValue = number | string | boolean | readonly number[];
export type DemoPathPart = string | number;
export type DemoSpan = { readonly start: number; readonly end: number };

type DemoCamera = {
  readonly framing: 'fit' | 'fixed';
  readonly direction?: readonly [number, number, number];
  readonly position?: readonly [number, number, number];
  readonly target?: readonly [number, number, number];
  readonly up?: readonly [number, number, number];
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
  readonly direction: readonly [number, number, number];
  readonly color: readonly [number, number, number];
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
  readonly view?: string;
};

/** Build-time description consumed by the client without parsing TypeScript. */
export type DemoDescriptor = {
  readonly bindings: readonly DemoBinding[];
  readonly code: string;
  readonly lights?: readonly DemoLight[];
  readonly material: Readonly<Record<string, DemoValue>>;
  readonly raw: boolean;
  readonly request: Readonly<Record<string, unknown>>;
  readonly views: readonly DemoView[];
};

type ControlTemplate =
  | { readonly kind: 'range'; readonly min: number; readonly max: number; readonly step: number }
  | { readonly kind: 'choice'; readonly choices: readonly string[]; readonly labels?: readonly string[] }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'colour' }
  | { readonly kind: 'vector'; readonly min: number; readonly max: number; readonly step: number }
  | { readonly kind: 'text' };

/** Bounds mirror nanoraster's public validation contract. */
export const demoControlCatalogue: Readonly<Record<string, ControlTemplate>> = {
  margin: { kind: 'range', min: 0, max: 0.5, step: 0.01 },
  direction: { kind: 'vector', min: -10, max: 10, step: 0.1 },
  position: { kind: 'vector', min: -20, max: 20, step: 0.1 },
  target: { kind: 'vector', min: -20, max: 20, step: 0.1 },
  up: { kind: 'vector', min: -1, max: 1, step: 0.1 },
  verticalFieldOfView: { kind: 'range', min: 1, max: 179, step: 1 },
  verticalSpan: { kind: 'range', min: 0.01, max: 50, step: 0.01 },
  zoom: { kind: 'range', min: 0.01, max: 4, step: 0.01 },
  near: { kind: 'range', min: 0.001, max: 1, step: 0.001 },
  far: { kind: 'range', min: 2, max: 1_000, step: 1 },
  lineWidth: { kind: 'range', min: 0.25, max: 16, step: 0.25 },
  surfaces: { kind: 'toggle' },
  lines: { kind: 'toggle' },
  clipSurfaces: { kind: 'toggle' },
  clipLines: { kind: 'toggle' },
  point: { kind: 'vector', min: -20, max: 20, step: 0.1 },
  normal: { kind: 'vector', min: -1, max: 1, step: 0.1 },
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
  baseColorFactor: { kind: 'colour' },
  metallicFactor: { kind: 'range', min: 0, max: 1, step: 0.01 },
  roughnessFactor: { kind: 'range', min: 0, max: 1, step: 0.01 },
};

/** Keep demo labels inside the renderer's public label alphabet and limit. */
export const cleanLabel = (raw: string): string =>
  raw.replace(/[^\u0020-\u007E\u00B5\u2014\u2212]/gu, '').slice(0, 64);

export const readDemoOptions = (descriptor: DemoDescriptor): Record<string, DemoValue> =>
  Object.fromEntries(descriptor.bindings.map(({ key, value }) => [key, value]));

export const demoControls = (descriptor: DemoDescriptor, selectedViewId?: string): readonly DemoControl[] => {
  const hasQuality = descriptor.bindings.some(
    ({ control, view }) => control === 'quality' && view === undefined,
  );
  const selected = selectedViewId ?? descriptor.views.find(({ camera }) => camera !== undefined)?.id;
  return descriptor.bindings.flatMap((binding) => {
    if (binding.view !== undefined && binding.control !== 'label' && binding.view !== selected) return [];
    if (binding.control === 'format' && !hasQuality) return [];
    const template = demoControlCatalogue[binding.control];
    const view = binding.control === 'label' ? binding.view : undefined;
    return [
      {
        ...template,
        key: binding.key,
        label: binding.label,
        ...(view === undefined ? {} : { view }),
      },
    ];
  });
};

export const isRawDemo = (descriptor: DemoDescriptor): boolean => descriptor.raw;

const formatValue = (value: DemoValue): string => JSON.stringify(value);

/** Rewrite only build-time-proven literal spans; no client-side source discovery. */
export const substituteDemoValues = (
  descriptor: DemoDescriptor,
  values: Record<string, DemoValue>,
): string => {
  const edits = descriptor.bindings.flatMap((binding) => {
    const value = values[binding.key];
    if (Object.is(value, binding.value)) return [];
    if (binding.control === 'label' && value === '' && binding.deleteSpan !== undefined) {
      return [{ ...binding.deleteSpan, replacement: '' }];
    }
    return [{ ...binding.valueSpan, replacement: formatValue(value) }];
  });
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (code, { start, end, replacement }) => `${code.slice(0, start)}${replacement}${code.slice(end)}`,
      descriptor.code,
    );
};

export const describeDemoView = (view: DemoView): string =>
  `${view.camera?.framing ?? 'fit'} · ${view.camera?.projection?.kind ?? 'perspective'}`;
