import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { createGenerator, type GeneratedDoc } from 'fumadocs-typescript';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { llmStringifyMdx } from './lib/llm-stringify-mdx';

const ROOT = resolve(import.meta.dirname, '..');
const sourcePath = resolve(ROOT, 'src/index.ts');
const program = ts.createProgram([sourcePath], {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ESNext,
});
const checker = program.getTypeChecker();
const file = program.getSourceFile(sourcePath);
if (!file) throw new Error(`missing public entrypoint: ${sourcePath}`);
const moduleSymbol = checker.getSymbolAtLocation(file);
if (!moduleSymbol) throw new Error(`public entrypoint has no module symbol: ${sourcePath}`);
const exported = checker.getExportsOfModule(moduleSymbol).map(({ name }) => name);
const pagePaths = globSync('content/docs/**/*.mdx', { cwd: import.meta.dirname });
const pages = pagePaths.map((path) => readFileSync(resolve(import.meta.dirname, path), 'utf8')).join('\n');
const hasWholeToken = (content: string, name: string): boolean => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^$\\p{ID_Continue}])${escaped}(?:$|[^$\\p{ID_Continue}])`, 'u').test(content);
};
const generator = createGenerator({ tsconfigPath: resolve(import.meta.dirname, 'tsconfig.json') });
const tableNames = [
  'RenderedImageFile',
  'RenderedImage',
  'RenderImageOptions',
  'RenderImagesOptions',
  'RenderImageView',
  'RenderLightingRig',
  'RenderLight',
  'CreateRendererOptions',
  'AdapterInfo',
  'RenderTimings',
  'RenderViewTimings',
] as const;
const expectedFields: Record<(typeof tableNames)[number], readonly string[]> = {
  RenderedImageFile: ['name', 'bytes', 'mimeType', 'width', 'height'],
  RenderedImage: ['id', 'file'],
  RenderImageOptions: [
    'format',
    'width',
    'height',
    'quality',
    'lineWidth',
    'surfaces',
    'lines',
    'visiblePrimitives',
    'sections',
    'background',
    'axes',
    'scaleBar',
    'lighting',
    'label',
    'camera',
  ],
  RenderImagesOptions: [
    'format',
    'width',
    'height',
    'quality',
    'lineWidth',
    'surfaces',
    'lines',
    'visiblePrimitives',
    'sections',
    'background',
    'axes',
    'scaleBar',
    'lighting',
    'timings',
    'views',
  ],
  RenderImageView: ['id', 'label', 'camera', 'width', 'height', 'format', 'quality'],
  RenderLightingRig: ['lights', 'ambient', 'environment', 'space', 'exposure'],
  RenderLight: ['direction', 'color'],
  CreateRendererOptions: ['powerPreference'],
  AdapterInfo: ['backend', 'name', 'deviceType'],
  RenderTimings: [
    'parse',
    'setup',
    'capBuild',
    'upload',
    'peakReadbackBytes',
    'glbParses',
    'adapterDeviceRequests',
    'pipelineSets',
    'presentationBuilds',
    'sceneUploads',
    'targetAllocations',
    'views',
  ],
  RenderViewTimings: ['id', 'render', 'overlay', 'encode'],
};
const defaults = {
  width: '768',
  height: '432',
  quality: '0.92 (jpeg), 1 (webp)',
  lineWidth: '3',
  surfaces: 'true',
  lines: 'true',
  visiblePrimitives: 'all',
  sections: 'disabled',
  background: 'transparent',
  axes: 'false',
  scaleBar: 'false',
  lighting: "'studio'",
} as const;

const generateDoc = async (name: (typeof tableNames)[number]): Promise<GeneratedDoc> => {
  const [document] = await generator.generateTypeTable(
    { path: 'content/docs/props.ts', name },
    { basePath: import.meta.dirname },
  );
  return document;
};

const stringifyDoc = (document: GeneratedDoc): string => {
  const output = llmStringifyMdx({
    type: 'mdxJsxFlowElement',
    name: 'TypeTable',
    attributes: [
      {
        type: 'mdxJsxAttribute',
        name: 'type',
        value: { type: 'mdxJsxAttributeValueExpression', value: JSON.stringify(document) },
      },
    ],
  });
  if (!output) throw new Error(`failed to stringify ${document.name}`);
  return output;
};

describe('API documentation coverage', () => {
  it('assigns every public export to exactly one named reference section', () => {
    const headings = [...pages.matchAll(/^### `([^`]+)`$/gmu)].map((match) => match[1]);
    expect(headings.toSorted()).toEqual(exported.toSorted());
  });

  it('uses generated tables only for record-like public types', () => {
    const targets = [...pages.matchAll(/<auto-type-table\b[^>]*\bname="([^"]+)"[^>]*\/>/gu)].map(
      (match) => match[1],
    );
    expect(targets.toSorted()).toEqual(tableNames.toSorted());
  });

  it('generates only the intended, documented fields', async () => {
    for (const name of tableNames) {
      const document = await generateDoc(name);
      expect(document.entries.map((entry) => entry.name)).toEqual(expectedFields[name]);
      expect(document.entries.every((entry) => entry.description.trim().length > 0)).toBe(true);
      expect(document.entries.map((entry) => entry.name)).not.toContain('toString');
      expect(document.entries.map((entry) => entry.name)).not.toContain('map');
    }
  });

  it('publishes every runtime default through generated JSDoc', async () => {
    for (const name of ['RenderImageOptions', 'RenderImagesOptions'] as const) {
      const document = await generateDoc(name);
      for (const [field, expected] of Object.entries(defaults)) {
        const entry = document.entries.find(({ name: entryName }) => entryName === field);
        expect(entry?.tags.find(({ name: tagName }) => tagName === 'default')?.text).toBe(expected);
      }
    }
  });

  it('stringifies exact types as tight CommonMark property lists', async () => {
    const output = (await Promise.all(tableNames.map(generateDoc))).map(stringifyDoc).join('\n\n');
    expect(output).toContain('`Uint8Array<ArrayBuffer>`');
    expect(output).toContain('`string | readonly [number, number, number, number] | undefined`');
    expect(output).toContain('default `0.92 (jpeg), 1 (webp)`');
    expect(output).not.toContain('<TypeTable');
    expect(output).not.toContain('<br>');
    expect(output).not.toContain('\\|');
    expect(output).not.toContain('**`toString`**');
  });
});

const staticOutputTest = process.env['VERIFY_STATIC_OUTPUT'] === 'true' ? it : it.skip;

describe('static agent documentation', () => {
  staticOutputTest('emits complete Markdown endpoints and a smaller API page', () => {
    const output = resolve(import.meta.dirname, 'out');
    expect(existsSync(output)).toBe(true);
    const files = globSync('**/*', { cwd: output });
    expect(files).toContain('llms.txt');
    expect(files).toContain('llms-full.txt');
    const slugs = [
      'install',
      'tutorial',
      'guides/render-multiple-views',
      'guides/frame-the-model',
      'guides/choose-visible-geometry',
      'guides/render-section-views',
      'how-it-works',
      'api',
    ];
    expect(files).toContain('docs.mdx');
    for (const slug of slugs) expect(files).toContain(`docs/${slug}.mdx`);
    expect(files.some((file) => file.startsWith('llms.mdx'))).toBe(false);
    expect(files.some((file) => file.startsWith('docs/md'))).toBe(false);

    for (const path of ['docs.mdx', ...slugs.map((slug) => `docs/${slug}.mdx`)]) {
      const projection = readFileSync(resolve(output, path), 'utf8');
      expect(projection.startsWith('# ')).toBe(true);
      expect(projection).toContain('Canonical page: https://www.nanoraster.xyz');
      const relative = [...projection.matchAll(/\]\(([^)\s]*)\)/gu)].map((match) => match[1]);
      expect(relative.filter((target) => !/^(?:https?:|#)/u.test(target))).toEqual([]);
    }

    const vercel = JSON.parse(readFileSync(resolve(import.meta.dirname, 'vercel.json'), 'utf8')) as {
      readonly headers: ReadonlyArray<{
        readonly headers: ReadonlyArray<{ readonly key: string; readonly value: string }>;
      }>;
      readonly redirects: ReadonlyArray<{ readonly source: string; readonly destination: string }>;
    };
    expect(
      vercel.headers.flatMap(({ headers }) => headers.map(({ key, value }) => `${key}: ${value}`)),
    ).toContain('Content-Type: text/markdown; charset=utf-8');
    expect(vercel.redirects.map(({ source: from, destination }) => [from, destination])).toEqual([
      ['/docs/md/index', '/docs.mdx'],
      ['/docs/md/:path*', '/docs/:path*.mdx'],
    ]);

    const full = readFileSync(resolve(output, 'llms-full.txt'), 'utf8');
    for (const name of exported) expect(hasWholeToken(full, name)).toBe(true);
    expect(full).toContain('`Uint8Array<ArrayBuffer>`');
    expect(full).toContain('string | readonly [number, number, number, number] | undefined');
    expect(full).not.toContain('<TypeTable');
    expect(full).not.toContain('<br>');
    expect(full).not.toContain('\\|');
    expect(full).not.toContain('**`toString`**');

    const index = readFileSync(resolve(output, 'llms.txt'), 'utf8');
    const links = [...index.matchAll(/\]\(([^)\s]*)\)/gu)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.startsWith('https://www.nanoraster.xyz/docs'))).toBe(true);
    expect(links.every((link) => link.endsWith('.mdx'))).toBe(true);
    expect(links).toContain('https://www.nanoraster.xyz/docs.mdx');

    for (const route of ['llms.txt', 'llms-full.txt']) {
      const metadata = JSON.parse(
        readFileSync(resolve(import.meta.dirname, `.next/server/app/${route}.meta`), 'utf8'),
      ) as { readonly headers: { readonly 'content-type': string } };
      expect(metadata.headers['content-type']).toBe('text/markdown; charset=utf-8');
    }

    const apiHtml = resolve(output, 'docs/api.html');
    expect(statSync(apiHtml).size).toBeLessThan(725_000);

    const optionsHtml = readFileSync(apiHtml, 'utf8');
    expect(optionsHtml).toContain('aria-label="RenderImageOptions properties"');
    expect(optionsHtml).toContain('aria-expanded="false"');
    expect(optionsHtml).toContain('Expand all');
    expect(optionsHtml).not.toContain('<table id="type-table-');
  });
});
