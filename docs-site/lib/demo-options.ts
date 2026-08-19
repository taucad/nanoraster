/**
 * Where a control's value goes. Render options travel in the request; material
 * factors are carried in the GLB and have to be patched into the model.
 */
type DemoScope = 'option' | 'material';

export type DemoControl = { readonly key: string; readonly scope: DemoScope } & (
  | { readonly kind: 'range'; readonly min: number; readonly max: number; readonly step: number }
  | { readonly kind: 'choice'; readonly choices: readonly string[] }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'colour' }
);

export type DemoValue = number | string | boolean | readonly number[];

/**
 * Controls offered for each value a demo can drive, keyed by its name. Bounds
 * mirror the package's own validation constants and the glTF specification, so
 * a control can never produce a request the renderer would reject.
 */
const catalogue: Record<string, DemoControl> = {
  phi: { kind: 'range', key: 'phi', scope: 'option', min: 0, max: 180, step: 1 },
  theta: { kind: 'range', key: 'theta', scope: 'option', min: -180, max: 180, step: 1 },
  margin: { kind: 'range', key: 'margin', scope: 'option', min: 0, max: 0.5, step: 0.01 },
  up: { kind: 'choice', key: 'up', scope: 'option', choices: ['x', 'y', 'z'] },
  projection: {
    kind: 'choice',
    key: 'projection',
    scope: 'option',
    choices: ['perspective', 'orthographic'],
  },
  lighting: {
    kind: 'choice',
    key: 'lighting',
    scope: 'option',
    choices: ['studio', 'two-light', 'environment-only', 'world-key'],
  },
  includeAxes: { kind: 'toggle', key: 'includeAxes', scope: 'option' },
  includeScale: { kind: 'toggle', key: 'includeScale', scope: 'option' },
  includeLabel: { kind: 'toggle', key: 'includeLabel', scope: 'option' },
  baseColorFactor: { kind: 'colour', key: 'baseColorFactor', scope: 'material' },
  metallicFactor: {
    kind: 'range',
    key: 'metallicFactor',
    scope: 'material',
    min: 0,
    max: 1,
    step: 0.01,
  },
  roughnessFactor: {
    kind: 'range',
    key: 'roughnessFactor',
    scope: 'material',
    min: 0,
    max: 1,
    step: 0.01,
  },
};

const parseValue = (raw: string): DemoValue | undefined => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  const quoted = /^["']([^"']*)["']$/u.exec(raw);
  if (quoted?.[1] !== undefined) return quoted[1];

  const array = /^\[([^\]]*)\]$/u.exec(raw);
  if (array?.[1] !== undefined) {
    const numbers = array[1].split(',').map((part) => Number(part.trim()));
    return numbers.every((value) => Number.isFinite(value)) ? numbers : undefined;
  }

  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
};

/**
 * Read the values an example sets, so a demo starts from the code the reader
 * is looking at. Keys are matched both bare and quoted, because the examples
 * are TypeScript on some pages and glTF JSON on others.
 */
export const readDemoOptions = (code: string): Record<string, DemoValue> => {
  const found: Record<string, DemoValue> = {};

  for (const key of Object.keys(catalogue)) {
    const pattern = new RegExp(`["']?\\b${key}\\b["']?\\s*:\\s*(\\[[^\\]]*\\]|[^,\\n}]+)`, 'u');
    const raw = pattern.exec(code)?.[1]?.trim();
    if (raw === undefined) continue;
    const value = parseValue(raw);
    if (value !== undefined) found[key] = value;
  }

  return found;
};

/** The controls to render, in catalogue order, for the values an example sets. */
export const demoControls = (code: string): readonly DemoControl[] => {
  const present = readDemoOptions(code);
  return Object.keys(catalogue)
    .filter((key) => key in present)
    .map((key) => catalogue[key]);
};

/** True when a value belongs in the model rather than in the render request. */
export const isMaterialKey = (key: string): boolean =>
  key in catalogue && catalogue[key].scope === 'material';

/**
 * The rig each `lighting` choice stands for. A control carries a scalar and a
 * rig is an object, so the name is what the control holds and this is where it
 * becomes the request's value. The names match the guide's examples.
 */
const lightingRigs: Record<string, unknown> = {
  studio: 'studio',
  'two-light': {
    lights: [
      { direction: [-0.5, 0.6, 0.6], color: [3, 2.9, 2.7] },
      { direction: [0.6, -0.2, 0.4], color: [0.7, 0.8, 1] },
    ],
  },
  'environment-only': { lights: [] },
  'world-key': {
    lights: [{ direction: [0, 1, 0.4], color: [3, 2.9, 2.7] }],
    space: 'world',
  },
};

/**
 * Turn the control values into the render request. Values are literal except
 * `lighting`, whose choice name expands into the rig it names; material factors
 * are dropped, because they are patched into the model instead.
 */
export const toRequestOptions = (values: Record<string, DemoValue>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => !isMaterialKey(key))
      .map(([key, value]) => [key, key === 'lighting' ? lightingRigs[String(value)] : value]),
  );

/** Format a value the way it would appear in the example's source. */
export const formatValue = (value: DemoValue): string => {
  if (Array.isArray(value)) return `[${value.map((part) => Number(part).toFixed(3)).join(', ')}]`;
  return typeof value === 'string' ? `'${value}'` : String(value);
};
