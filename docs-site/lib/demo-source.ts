import ts from 'typescript';

import {
  demoBoundsViolation,
  demoControlNames,
  demoControlTemplates,
  demoControls,
  demoDirectionFromOrbit,
  type DemoBinding,
  type DemoDescriptor,
  type DemoLight,
  type DemoPathPart,
  type DemoScope,
  type DemoSpan,
  type DemoValue,
  type DemoView,
} from './demo-options';

type Literal = DemoValue | readonly Literal[] | { readonly [key: string]: Literal };

const unwrap = (node: ts.Expression): ts.Expression => {
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return unwrap(node.expression);
  }
  return node;
};

type Scope = ReadonlyMap<string, ts.Expression>;

/**
 * The example's own top-level constants, so it can name its world once and
 * hand the same value to the request and to the orbit helper — which is what
 * a reader copying the block has to do.
 *
 * One parse runs at a time during the docs build, so this is set per parse
 * rather than threaded through every binding site.
 */
let scope: Scope = new Map();

const declaredConstants = (source: ts.SourceFile): Scope =>
  new Map(
    source.statements.flatMap((statement) =>
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.flatMap((declaration) =>
            ts.isIdentifier(declaration.name) && declaration.initializer !== undefined
              ? [[declaration.name.text, declaration.initializer] as const]
              : [],
          )
        : [],
    ),
  );

/** The exported orbit pair, as the examples name it. */
const orbitHelper = 'renderDirectionFromOrbit';

const isOrbitCall = (expression: ts.Expression): ts.CallExpression | undefined => {
  const node = unwrap(expression);
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === orbitHelper
    ? node
    : undefined;
};

/** The world argument an orbit call passes on, as the example spells it. */
const orbitWorld = (call: ts.CallExpression): { readonly world?: string } => {
  const world = call.arguments.at(1);
  return world === undefined ? {} : { world: world.getText().trim() };
};

/**
 * Evaluate `renderDirectionFromOrbit(orbit, world?)` where the example writes
 * it.
 *
 * The helper is the authoring form only: the vector it names is what the
 * descriptor, the executed request, and the build-time bounds check all see,
 * so nothing spherical reaches the renderer.
 */
const orbitLiteral = (node: ts.CallExpression): Literal | undefined => {
  const authored = node.arguments.at(0);
  const world = node.arguments.at(1);
  const orbit = authored === undefined ? undefined : literal(authored);
  const declared = world === undefined ? undefined : literal(world);
  if (orbit === undefined || Array.isArray(orbit) || typeof orbit !== 'object') return undefined;
  const { azimuth, elevation } = orbit as Record<string, unknown>;
  if (typeof azimuth !== 'number' || typeof elevation !== 'number') return undefined;
  return [...demoDirectionFromOrbit({ azimuth, elevation }, declared)];
};

const literal = (expression: ts.Expression): Literal | undefined => {
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(node)) {
    const declared = scope.get(node.text);
    return declared === undefined ? undefined : literal(declared);
  }
  if (ts.isCallExpression(node)) {
    const call = isOrbitCall(node);
    return call === undefined ? undefined : orbitLiteral(call);
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const value = literal(node.operand);
    return typeof value === 'number' ? -value : undefined;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map((part) => literal(part));
    return values.every((value) => value !== undefined) ? values : undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries = node.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        const value = literal(property.name);
        return value === undefined ? [] : [[property.name.text, value] as const];
      }
      if (!ts.isPropertyAssignment(property)) return [];
      const name = propertyName(property.name);
      const value = literal(property.initializer);
      return name === undefined || value === undefined ? [] : [[name, value] as const];
    });
    if (entries.length !== node.properties.length) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

const propertyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
};

const objectExpression = (expression: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined => {
  if (expression === undefined) return undefined;
  const node = unwrap(expression);
  return ts.isObjectLiteralExpression(node) ? node : undefined;
};

const property = (object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined =>
  object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === name,
  );

const span = (node: ts.Node, offset: number): DemoSpan => ({
  start: node.getStart() - offset,
  end: node.getEnd() - offset,
});

const deleteSpan = (
  object: ts.ObjectLiteralExpression,
  target: ts.PropertyAssignment,
  offset: number,
): DemoSpan => {
  const properties = object.properties;
  const index = properties.indexOf(target);
  const next = properties.at(index + 1);
  if (next !== undefined) return { start: target.getStart() - offset, end: next.getStart() - offset };
  const previous = index === 0 ? undefined : properties.at(index - 1);
  return previous === undefined
    ? span(target, offset)
    : { start: previous.getEnd() - offset, end: target.getEnd() - offset };
};

const pushBinding = (
  bindings: DemoBinding[],
  object: ts.ObjectLiteralExpression,
  options: {
    readonly key: string;
    readonly label: string;
    readonly name: string;
    readonly offset: number;
    readonly path: readonly DemoPathPart[];
    readonly scope?: DemoScope;
    readonly title?: string;
    readonly view?: string;
  },
): void => {
  const { name } = options;
  const found = property(object, name);
  if (found === undefined) return;
  const value = literal(found.initializer);
  const call = isOrbitCall(found.initializer);
  if (
    typeof value !== 'number' &&
    typeof value !== 'string' &&
    typeof value !== 'boolean' &&
    !(Array.isArray(value) && value.every((part) => typeof part === 'number'))
  ) {
    return;
  }
  bindings.push({
    control: name,
    key: options.key,
    label: options.label,
    path: options.path,
    scope: options.scope ?? 'option',
    value,
    valueSpan: span(found.initializer, options.offset),
    ...(name === 'label' ? { deleteSpan: deleteSpan(object, found, options.offset) } : {}),
    ...(call === undefined ? {} : { orbit: orbitWorld(call) }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.view === undefined ? {} : { view: options.view }),
  });
};

/**
 * What a row is called, and what its tooltip spells out.
 *
 * The composed API paths are the labels most at risk of being ellipsed and
 * the least self-explanatory, so the row carries the short name and the path
 * stays one hover away.
 */
const shortLabels: Readonly<Record<string, string>> = {
  verticalFieldOfView: 'field of view',
  verticalSpan: 'vertical span',
  near: 'near clip',
  far: 'far clip',
};

const cameraBindings = (
  bindings: DemoBinding[],
  camera: ts.ObjectLiteralExpression,
  options: {
    readonly offset: number;
    readonly path: readonly DemoPathPart[];
    readonly prefix: string;
    readonly view?: string;
  },
): void => {
  for (const name of ['direction', 'position', 'target', 'up', 'margin']) {
    pushBinding(bindings, camera, {
      key: `${options.prefix}${name}`,
      label: name,
      name,
      offset: options.offset,
      path: [...options.path, name],
      ...(options.view === undefined ? {} : { view: options.view }),
    });
  }
  for (const container of ['projection', 'clipping']) {
    const nested = objectExpression(property(camera, container)?.initializer);
    if (nested === undefined) continue;
    const names =
      container === 'projection' ? ['verticalFieldOfView', 'verticalSpan', 'zoom'] : ['near', 'far'];
    for (const name of names) {
      pushBinding(bindings, nested, {
        key: `${options.prefix}${container}.${name}`,
        label: shortLabels[name] ?? name,
        name,
        offset: options.offset,
        path: [...options.path, container, name],
        title: `${container}.${name}`,
        ...(options.view === undefined ? {} : { view: options.view }),
      });
    }
  }
};

const renderCallOptions = (source: ts.SourceFile): ts.ObjectLiteralExpression | undefined => {
  let result: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      result === undefined &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'renderImage' || node.expression.text === 'renderImages')
    ) {
      result = objectExpression(node.arguments[1]);
    }
    if (result === undefined) ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
};

const materialObject = (
  code: string,
): { readonly object: ts.ObjectLiteralExpression; readonly offset: number } | undefined => {
  const prefix = 'const __demo = (';
  const source = ts.createSourceFile('material.ts', `${prefix}${code}\n);`, ts.ScriptTarget.Latest, true);
  const declaration = source.statements[0];
  if (!ts.isVariableStatement(declaration)) return undefined;
  const root = objectExpression(declaration.declarationList.declarations[0].initializer);
  const pbr =
    root === undefined ? undefined : objectExpression(property(root, 'pbrMetallicRoughness')?.initializer);
  return pbr === undefined ? undefined : { object: pbr, offset: prefix.length };
};

const asObject = (value: Literal | undefined): Record<string, unknown> =>
  value !== undefined && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};

/**
 * Every authored literal a control cannot express, as one message.
 *
 * A demo whose example sets a value its own control cannot reach shows the
 * reader one request and renders another. Running at parse time makes that a
 * failed docs build rather than a defect a reader has to notice.
 */
const boundsFailures = (descriptor: DemoDescriptor): readonly string[] => {
  const values = Object.fromEntries(descriptor.bindings.map(({ key, value }) => [key, value]));
  const viewIds = [undefined, ...descriptor.views.map(({ id }) => id)];
  const seen = new Set<string>();
  const templates = demoControlTemplates(descriptor.diagonal);
  return viewIds.flatMap((viewId) =>
    demoControls(descriptor, viewId).flatMap((control) => {
      if (seen.has(control.key)) return [];
      seen.add(control.key);
      const binding = descriptor.bindings.find(({ key }) => key === control.key);
      const violation =
        binding === undefined
          ? undefined
          : demoBoundsViolation(
              templates[binding.control],
              values[control.key],
              // A plane offset is bounded along the plane's own normal, so the
              // sibling binding is what makes that check mean anything.
              values[control.key.replace(/\.point$/u, '.normal')],
            );
      return violation === undefined ? [] : [`${control.key}: ${violation}`];
    }),
  );
};

/**
 * Parse one authored demo once during the docs build.
 *
 * `diagonal` is the rendered model's bounding-box diagonal: every length
 * control is scaled by it, so the demo's model has to be known here rather
 * than after it lands in the browser.
 */
export const createDemoDescriptor = (code: string, diagonal: number): DemoDescriptor => {
  const source = ts.createSourceFile('demo.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  scope = declaredConstants(source);
  const options = renderCallOptions(source);
  const bindings: DemoBinding[] = [];
  const request = options === undefined ? {} : asObject(literal(options));

  if (options !== undefined) {
    for (const name of demoControlNames) {
      pushBinding(bindings, options, { key: name, label: name, name, offset: 0, path: [name] });
    }
    const camera = objectExpression(property(options, 'camera')?.initializer);
    if (camera !== undefined)
      cameraBindings(bindings, camera, { offset: 0, path: ['camera'], prefix: 'camera.' });
    const lighting = objectExpression(property(options, 'lighting')?.initializer);
    if (lighting !== undefined) {
      for (const name of ['ambient', 'exposure', 'environment', 'space']) {
        pushBinding(bindings, lighting, {
          key: `lighting.${name}`,
          label: name,
          name,
          offset: 0,
          path: ['lighting', name],
        });
      }
      // Without these the lighting guide has no control over its own subject:
      // `space` swaps the frame the light directions are read in, with no
      // light direction on the panel to watch it move.
      const lightList = property(lighting, 'lights')?.initializer;
      const lights = lightList === undefined ? undefined : unwrap(lightList);
      if (lights !== undefined && ts.isArrayLiteralExpression(lights)) {
        for (const [index, item] of lights.elements.entries()) {
          const light = objectExpression(item);
          if (light === undefined) continue;
          for (const name of ['direction', 'color']) {
            pushBinding(bindings, light, {
              key: `lighting.lights.${index}.${name}`,
              label: `light ${index + 1} ${name}`,
              name,
              offset: 0,
              path: ['lighting', 'lights', index, name],
            });
          }
        }
      }
    }
    const sections = objectExpression(property(options, 'sections')?.initializer);
    if (sections !== undefined) {
      for (const name of ['clipSurfaces', 'clipLines']) {
        pushBinding(bindings, sections, {
          key: `sections.${name}`,
          label: name,
          name,
          offset: 0,
          path: ['sections', name],
        });
      }
      const planeList = property(sections, 'planes')?.initializer;
      const planes = planeList === undefined ? undefined : unwrap(planeList);
      if (planes !== undefined && ts.isArrayLiteralExpression(planes)) {
        for (const [index, item] of planes.elements.entries()) {
          const plane = objectExpression(item);
          if (plane === undefined) continue;
          for (const name of ['point', 'normal']) {
            pushBinding(bindings, plane, {
              key: `sections.planes.${index}.${name}`,
              // The point is driven as a signed distance along the plane's own
              // normal, which is the only direction moving it can cut in.
              label: `plane ${index + 1} ${name === 'point' ? 'offset' : name}`,
              name,
              offset: 0,
              path: ['sections', 'planes', index, name],
              title: `sections.planes[${index}].${name}`,
            });
          }
        }
      }
    }
    const views = property(options, 'views')?.initializer;
    const viewArray = views === undefined ? undefined : unwrap(views);
    if (viewArray !== undefined && ts.isArrayLiteralExpression(viewArray)) {
      for (const [index, item] of viewArray.elements.entries()) {
        const entry = objectExpression(item);
        const idProperty = entry === undefined ? undefined : property(entry, 'id');
        const idValue = idProperty === undefined ? undefined : literal(idProperty.initializer);
        if (entry === undefined || typeof idValue !== 'string') continue;
        pushBinding(bindings, entry, {
          key: `view.${idValue}.label`,
          // Only the selected view's group is on the panel, so the row does
          // not have to spell out which view it belongs to.
          label: 'label',
          name: 'label',
          offset: 0,
          path: ['views', index, 'label'],
          title: `views[${index}].label`,
          view: idValue,
        });
        const camera = objectExpression(property(entry, 'camera')?.initializer);
        if (camera !== undefined) {
          cameraBindings(bindings, camera, {
            offset: 0,
            path: ['views', index, 'camera'],
            prefix: `view.${idValue}.camera.`,
            view: idValue,
          });
        }
      }
    }
  }

  const material = materialObject(code);
  const materialValues: Record<string, DemoValue> = {};
  if (material !== undefined) {
    for (const name of ['baseColorFactor', 'metallicFactor', 'roughnessFactor']) {
      pushBinding(bindings, material.object, {
        key: name,
        label: name,
        name,
        offset: material.offset,
        path: [name],
        scope: 'material',
      });
      const value = literal(property(material.object, name)?.initializer as ts.Expression);
      if (value !== undefined) materialValues[name] = value as DemoValue;
    }
  }

  const views = Array.isArray(request['views']) ? (request['views'] as unknown as readonly DemoView[]) : [];
  const lighting = asObject(request['lighting'] as Literal | undefined);
  const lights = Array.isArray(lighting['lights']) ? (lighting['lights'] as readonly DemoLight[]) : undefined;
  const descriptor: DemoDescriptor = {
    bindings,
    code,
    diagonal,
    ...(lights === undefined ? {} : { lights }),
    material: materialValues,
    raw: request['format'] === 'raw',
    request,
    views,
  };

  const failures = boundsFailures(descriptor);
  if (failures.length > 0) {
    throw new Error(`demo literals outside their control's range — ${failures.join('; ')}`);
  }
  return descriptor;
};
