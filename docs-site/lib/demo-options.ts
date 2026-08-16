/** A control derived from the option values an example already sets. */
export type DemoControl =
  | { readonly kind: 'range'; readonly key: string; readonly min: number; readonly max: number; readonly step: number; readonly unit?: string }
  | { readonly kind: 'choice'; readonly key: string; readonly choices: readonly string[] }
  | { readonly kind: 'toggle'; readonly key: string };

export type DemoValue = number | string | boolean;

/**
 * Controls offered for each render option a demo can drive, keyed by the
 * option name. Bounds mirror the package's own validation constants, so a
 * control can never produce a request the renderer would reject.
 */
const catalogue: Record<string, DemoControl> = {
  phi: { kind: 'range', key: 'phi', min: 0, max: 180, step: 1, unit: '°' },
  theta: { kind: 'range', key: 'theta', min: -180, max: 180, step: 1, unit: '°' },
  margin: { kind: 'range', key: 'margin', min: 0, max: 0.5, step: 0.01 },
  up: { kind: 'choice', key: 'up', choices: ['x', 'y', 'z'] },
  projection: { kind: 'choice', key: 'projection', choices: ['perspective', 'orthographic'] },
  includeAxes: { kind: 'toggle', key: 'includeAxes' },
  includeScale: { kind: 'toggle', key: 'includeScale' },
  includeLabel: { kind: 'toggle', key: 'includeLabel' },
};

/** Defaults matching the package, used for options an example leaves unset. */
export const demoDefaults: Record<string, DemoValue> = {
  phi: 60,
  theta: -45,
  margin: 0.1,
  up: 'y',
  projection: 'perspective',
  includeAxes: false,
  includeScale: false,
  includeLabel: false,
};

const parseValue = (raw: string): DemoValue | undefined => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const quoted = /^'([^']*)'$/u.exec(raw);
  if (quoted?.[1] !== undefined) return quoted[1];
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
};

/**
 * Read the option values an example sets, so a demo starts from the code the
 * reader is looking at rather than from a separately maintained list.
 */
export const readDemoOptions = (code: string): Record<string, DemoValue> => {
  const found: Record<string, DemoValue> = {};

  for (const key of Object.keys(catalogue)) {
    const match = new RegExp(`\\b${key}\\s*:\\s*([^,\\n}]+)`, 'u').exec(code);
    const raw = match?.[1]?.trim();
    if (raw === undefined) continue;
    const value = parseValue(raw);
    if (value !== undefined) found[key] = value;
  }

  return found;
};

/** The controls to render, in catalogue order, for the options an example sets. */
export const demoControls = (code: string): readonly DemoControl[] =>
  Object.keys(catalogue)
    .filter((key) => key in readDemoOptions(code))
    .map((key) => catalogue[key]);

/** Format a value the way it would appear in the example's source. */
export const formatValue = (value: DemoValue): string =>
  typeof value === 'string' ? `'${value}'` : String(value);
