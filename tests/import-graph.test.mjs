// The `node` export condition is the only thing keeping the generated NAPI
// loader — and the Node builtins it imports — out of a browser bundle. A
// bundler resolves the default condition and follows every static and dynamic
// specifier from it, so this walks the same graph and fails on the first
// builtin or `./native/` reference that a bundler would have to resolve.
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const builtins = new Set(builtinModules);
const compilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ESNext,
};

const isBuiltin = (specifier) => specifier.startsWith('node:') || builtins.has(specifier);

const referencesNativeLoader = (specifier) => /(?:^|\/)native\//u.test(specifier);

/**
 * Every static, dynamic, and type-position module specifier in one file.
 * Minified output writes its specifiers as template literals, so each
 * position accepts both literal forms.
 */
const specifiersOf = (file) => {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteralLike(literal)) found.push(literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/**
 * Walk one entry point's module graph, returning every file reached and every
 * specifier that a bundler would have to resolve.
 */
const walk = (entry) => {
  const files = new Set();
  const specifiers = new Set();
  const pending = [path.resolve(root, entry)];

  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);

    for (const specifier of specifiersOf(file)) {
      specifiers.add(specifier);
      if (isBuiltin(specifier)) continue;
      const { resolvedModule } = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys);
      if (resolvedModule === undefined) continue;
      const resolved = resolvedModule.resolvedFileName;
      pending.push(resolved);
      // Hand-written declarations stand in for generated glue; the shipped
      // JavaScript beside them is what a bundler actually pulls in.
      const sibling = resolved.replace(/\.d\.ts$/u, '.js');
      if (sibling !== resolved && existsSync(sibling)) pending.push(sibling);
    }
  }

  return { files: [...files], specifiers: [...specifiers] };
};

/** Walk built ESM output, which carries only relative specifiers. */
const walkOutput = (entry) => {
  const specifiers = new Set();
  const seen = new Set();
  const pending = [path.resolve(root, entry)];

  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    for (const specifier of specifiersOf(file)) {
      specifiers.add(specifier);
      if (specifier.startsWith('.')) pending.push(path.resolve(path.dirname(file), specifier));
    }
  }

  return { files: [...seen], specifiers: [...specifiers] };
};

describe('universal entry point boundary', () => {
  it('should reach no Node builtin and no generated loader from src/index.ts', () => {
    const { files, specifiers } = walk('src/index.ts');

    expect(files).toContain(path.resolve(root, 'src/renderer.ts'));
    expect(files).toContain(path.resolve(root, 'src/wasm/render_wasm.js'));
    expect(specifiers.filter((specifier) => isBuiltin(specifier))).toEqual([]);
    expect(specifiers.filter((specifier) => referencesNativeLoader(specifier))).toEqual([]);
  });

  it('should reach both a Node builtin and the generated loader from src/index.node.ts', () => {
    // The negative control: the same walk over the Node entry point proves the
    // assertion above measures the boundary rather than an empty graph.
    const { specifiers } = walk('src/index.node.ts');

    expect(specifiers.filter((specifier) => isBuiltin(specifier))).toContain('node:os');
    expect(specifiers.filter((specifier) => referencesNativeLoader(specifier))).toEqual([
      './native/index.js',
    ]);
  });
});

// The unit-test target depends only on `build:napi`, so `dist/` may be absent
// locally and on the Node-floor lane (tsdown needs a newer Node than 22.13).
// The `assemble` job, which has just built the package, sets
// NANORASTER_REQUIRE_DIST=1 so these assertions run — and fail loudly if the
// output is missing — before the tree is frozen.
const dist =
  process.env['NANORASTER_REQUIRE_DIST'] === '1' || existsSync(path.resolve(root, 'dist/index.mjs'))
    ? describe
    : describe.skip;

dist('built universal entry point', () => {
  it('should ship no Node builtin and no generated loader in dist/index.mjs', () => {
    const { files, specifiers } = walkOutput('dist/index.mjs');

    expect(files).toContain(path.resolve(root, 'dist/renderer.mjs'));
    expect(specifiers.filter((specifier) => isBuiltin(specifier))).toEqual([]);
    expect(specifiers.filter((specifier) => referencesNativeLoader(specifier))).toEqual([]);
  });

  it('should reach the generated loader from dist/index.node.mjs', () => {
    const { files, specifiers } = walkOutput('dist/index.node.mjs');

    expect(files).toContain(path.resolve(root, 'dist/index.node.mjs'));
    expect(specifiers).toContain('./native/index.js');
  });
});
