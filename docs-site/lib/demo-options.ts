/**
 * Where a control's value goes. Render options travel in the request; material
 * factors are carried in the GLB and have to be patched into the model.
 */
export type DemoScope = 'option' | 'material';

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

/** Defaults matching the package and the glTF specification. */
export const demoDefaults: Record<string, DemoValue> = {
  phi: 60,
  theta: -45,
  margin: 0.1,
  up: 'y',
  projection: 'perspective',
  includeAxes: false,
  includeScale: false,
  includeLabel: false,
  baseColorFactor: [1, 1, 1, 1],
  metallicFactor: 1,
  roughnessFactor: 1,
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

/** Format a value the way it would appear in the example's source. */
export const formatValue = (value: DemoValue): string => {
  if (Array.isArray(value)) return `[${value.map((part) => Number(part).toFixed(3)).join(', ')}]`;
  return typeof value === 'string' ? `'${value}'` : String(value);
};
