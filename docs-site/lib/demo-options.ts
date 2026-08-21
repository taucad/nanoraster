/**
 * Where a control's value goes. Render options travel in the request; material
 * factors are carried in the GLB and have to be patched into the model; rig
 * values sit inside the request's `lighting` object.
 */
type DemoScope = 'option' | 'material' | 'lighting';

export type DemoControl = { readonly key: string; readonly scope: DemoScope } & (
  | { readonly kind: 'range'; readonly min: number; readonly max: number; readonly step: number }
  | {
      readonly kind: 'choice';
      readonly choices: readonly string[];
      /** Shown in place of the raw value, position for position, where a literal reads badly. */
      readonly labels?: readonly string[];
    }
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
  format: { kind: 'choice', key: 'format', scope: 'option', choices: ['png', 'webp', 'jpeg'] },
  quality: { kind: 'range', key: 'quality', scope: 'option', min: 0, max: 1, step: 0.01 },
  // Hex only: the wire schema takes an RGBA tuple, so the demo expands whichever
  // of these is picked. `#00000000` is the package's transparent default, and a
  // transparent render shows the stage checkerboard through it.
  background: {
    kind: 'choice',
    key: 'background',
    scope: 'option',
    choices: ['#00000000', '#101418', '#ffffff', '#1d4ed8'],
    labels: ['transparent', 'dark', 'white', 'blue'],
  },
  axes: { kind: 'toggle', key: 'axes', scope: 'option' },
  scaleBar: { kind: 'toggle', key: 'scaleBar', scope: 'option' },
  // Rig values. Ranges stay inside renderImageAmbientRange / renderImageExposureRange
  // but stop where the picture stops changing usefully.
  ambient: { kind: 'range', key: 'ambient', scope: 'lighting', min: 0, max: 1, step: 0.01 },
  exposure: { kind: 'range', key: 'exposure', scope: 'lighting', min: 0.1, max: 4, step: 0.05 },
  environment: { kind: 'choice', key: 'environment', scope: 'lighting', choices: ['studio', 'none'] },
  space: { kind: 'choice', key: 'space', scope: 'lighting', choices: ['view', 'world'] },
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

/**
 * The controls to render, in catalogue order, for the values an example sets.
 *
 * `format` is the one required key, so every example states it, yet switching
 * it changes no pixel — the tile is decoded either way. It is offered only
 * where the example also sets `quality`, which is where the badge under the
 * image turns the pair into something a reader can see.
 */
export const demoControls = (code: string): readonly DemoControl[] => {
  const present = readDemoOptions(code);
  return Object.keys(catalogue)
    .filter((key) => key in present && (key !== 'format' || 'quality' in present))
    .map((key) => catalogue[key]);
};

/**
 * True when an example asks for the raw frame rather than an encoded file,
 * which is what the example itself states. The demo reads its mode out of the
 * code the same way it reads a batch out of a `views: [ … ]` literal: nothing
 * about a tile is declared twice.
 */
export const isRawDemo = (code: string): boolean => /\bformat\s*:\s*['"]raw['"]/u.test(code);

/** True when a value belongs in the model rather than in the render request. */
export const isMaterialKey = (key: string): boolean =>
  key in catalogue && catalogue[key].scope === 'material';

/** True when a value belongs inside the request's `lighting` rig. */
export const isLightingKey = (key: string): boolean =>
  key in catalogue && catalogue[key].scope === 'lighting';

/**
 * Format a value the way it would appear in the example's source. Numbers are
 * printed as they are, so a value read out of an example and written back is
 * the same literal the reader started from.
 */
const formatValue = (value: DemoValue): string => {
  if (Array.isArray(value)) return `[${value.map((part) => Number(part)).join(', ')}]`;
  return typeof value === 'string' ? `'${value}'` : String(value);
};

/**
 * The span of a `views: [ … ]` literal. Angles declared there belong to one
 * view rather than to the shared request, so substitution steps over them.
 */
const viewsLiteral = /\bviews\s*:\s*\[[^\]]*\]/u;

const viewsSpan = (code: string): { readonly start: number; readonly end: number } | undefined => {
  const match = viewsLiteral.exec(code);
  return match === null ? undefined : { start: match.index, end: match.index + match[0].length };
};

/**
 * Rewrite an example so it states the values the controls hold, which makes
 * the code the reader copies the code they tuned.
 *
 * Only the first occurrence of each key is replaced — the same one
 * `readDemoOptions` reads — and a key the caller does not pass keeps whatever
 * the example already says.
 */
export const substituteDemoValues = (code: string, values: Record<string, DemoValue>): string => {
  let out = code;

  for (const [key, value] of Object.entries(values)) {
    if (!(key in catalogue)) continue;

    const span = viewsSpan(out);
    const pattern = new RegExp(`(["']?\\b${key}\\b["']?\\s*:\\s*)(\\[[^\\]]*\\]|[^,\\n}]+)`, 'gu');
    let replaced = false;

    out = out.replace(pattern, (whole: string, head: string, _raw: string, index: number) => {
      if (replaced || (span !== undefined && index >= span.start && index < span.end)) return whole;
      replaced = true;
      return `${head}${formatValue(value)}`;
    });
  }

  return out;
};

// -- views (appended by A2) --

/** One identified camera an example declares inside its `views: [ … ]` literal. */
export type DemoView = {
  readonly id: string;
  readonly label?: string;
  readonly phi: number;
  readonly theta: number;
};

/** The literal a view's property holds, quotes and all. */
const viewField = (body: string, key: string): string | undefined =>
  new RegExp(`\\b${key}\\s*:\\s*(["'][^"']*["']|-?[\\d.]+)`, 'u').exec(body)?.[1];

/** The text inside a pair of quotes, or nothing when the literal is unquoted. */
const unquote = (raw: string | undefined): string | undefined =>
  raw === undefined ? undefined : /^["'](.*)["']$/u.exec(raw)?.[1];

/**
 * Read the views an example declares, in the order it declares them.
 *
 * The angles belong to one view rather than to the shared request, which is
 * why substitution steps over this span and the demo offers no angle controls
 * once a `views` literal is present. An example without one gives back an
 * empty list, so a caller can tell a batch request from a singular one.
 */
export const readDemoViews = (code: string): readonly DemoView[] => {
  const literal = /\bviews\s*:\s*\[([^\]]*)\]/u.exec(code)?.[1];
  if (literal === undefined) return [];

  return [...literal.matchAll(/\{([^{}]*)\}/gu)].flatMap(([, body]) => {
    const id = unquote(viewField(body, 'id'));
    const label = unquote(viewField(body, 'label'));
    const phi = Number(viewField(body, 'phi'));
    const theta = Number(viewField(body, 'theta'));

    if (id === undefined || id === '' || !Number.isFinite(phi) || !Number.isFinite(theta)) {
      return [];
    }
    return [{ id, phi, theta, ...(label === undefined ? {} : { label }) }];
  });
};

/**
 * The singular `label` an example sets. A label's presence is its own switch,
 * so it carries no control — the demo reads whatever the example states, the
 * way it reads views and lights. The `views: [ … ]` literal is cut out first:
 * the labels inside it belong to one view each, and a shared `label` on a
 * batch request is an unknown key the renderer rejects.
 */
export const readDemoLabel = (code: string): string | undefined =>
  unquote(/\blabel\s*:\s*(["'][^"']*["'])/u.exec(code.replace(viewsLiteral, ''))?.[1]);

/** One directional light an example declares inside its `lights: [ … ]` literal. */
export type DemoLight = {
  readonly direction: readonly [number, number, number];
  readonly color: readonly [number, number, number];
};

/** A `[x, y, z]` literal as three numbers, or nothing when it is not one. */
const triple = (body: string, key: string): readonly [number, number, number] | undefined => {
  const raw = new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`, 'u').exec(body)?.[1];
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((part) => Number(part.trim()));
  return parts.length === 3 && parts.every((part) => Number.isFinite(part))
    ? [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
    : undefined;
};

/**
 * Read the rig lights an example declares, in order. An example with no
 * `lights` literal gives back nothing at all, so a caller can tell "no rig"
 * from "a rig with no lights" (`lights: []`).
 */
export const readDemoLights = (code: string): readonly DemoLight[] | undefined => {
  const literal = /\blights\s*:\s*\[((?:[^[\]]|\[[^\]]*\])*)\]/u.exec(code)?.[1];
  if (literal === undefined) return undefined;

  return [...literal.matchAll(/\{((?:[^{}]|\[[^\]]*\])*)\}/gu)].flatMap(([, body]) => {
    const direction = triple(body, 'direction');
    const color = triple(body, 'color');
    return direction === undefined || color === undefined ? [] : [{ direction, color }];
  });
};
