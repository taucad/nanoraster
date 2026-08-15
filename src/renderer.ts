/** Lazy environment selection for the WASM and N-API artifacts. */

import { RenderError } from '#render-error.js';

type RawRenderer = (
  glb: Uint8Array<ArrayBuffer>,
  optionsJson: string,
) => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>;

type RawImagesRenderer = (
  glb: Uint8Array<ArrayBuffer>,
  optionsJson: string,
) => ReadonlyArray<Uint8Array<ArrayBuffer>> | Promise<ReadonlyArray<Uint8Array<ArrayBuffer>>>;

type RendererBindings = {
  readonly renderImage: RawRenderer;
  readonly renderImages: RawImagesRenderer;
};

type WasmModule = {
  default: (init: { module_or_path: URL }) => Promise<unknown>;
  render_glb_to_image: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  render_glb_to_images: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<Array<Uint8Array<ArrayBuffer>>>;
};

type NapiModule = {
  renderGlbToImage: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Uint8Array<ArrayBuffer>;
  renderGlbToImages: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Array<Uint8Array<ArrayBuffer>>;
};

const nativePackages = {
  'darwin-arm64': 'nanoraster-darwin-arm64',
  'linux-x64': 'nanoraster-linux-x64-gnu',
  'win32-x64': 'nanoraster-win32-x64-msvc',
} as const;

export const nativePackageName = (platform: string, architecture: string): string | undefined =>
  nativePackages[`${platform}-${architecture}` as keyof typeof nativePackages];

let cachedBindings: Promise<RendererBindings> | undefined;

const isNodeRuntime = (): boolean => {
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  if (nav?.gpu !== undefined) {
    return false;
  }
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof proc?.versions?.node === 'string';
};

const loadWasmBindings = async (): Promise<RendererBindings> => {
  const wasm = (await import('./wasm/render_wasm.js')) as unknown as WasmModule;
  await wasm.default({ module_or_path: new URL('wasm/render_wasm_bg.wasm', import.meta.url) });
  return {
    renderImage: async (glb, optionsJson) => wasm.render_glb_to_image(glb, optionsJson),
    renderImages: async (glb, optionsJson) => [...(await wasm.render_glb_to_images(glb, optionsJson))],
  };
};

const loadNapiBindings = async (): Promise<RendererBindings> => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const packageName = nativePackageName(process.platform, process.arch);
  if (packageName === undefined) {
    throw new RenderError(
      'adapter-unavailable',
      `native render addon is not published for ${process.platform}-${process.arch}`,
    );
  }
  let native: NapiModule;
  try {
    native = require(packageName) as NapiModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RenderError(
      'adapter-unavailable',
      `native render addon unavailable for ${process.platform}-${process.arch}: ${detail}. ` +
        `Install the optional ${packageName} package or build it with \`pnpm nx run nanoraster:build:napi\`.`,
    );
  }
  return {
    renderImage: (glb, optionsJson) => native.renderGlbToImage(glb, optionsJson),
    renderImages: (glb, optionsJson) => [...native.renderGlbToImages(glb, optionsJson)],
  };
};

const bindings = async (): Promise<RendererBindings> => {
  cachedBindings ??= isNodeRuntime() ? loadNapiBindings() : loadWasmBindings();
  return cachedBindings;
};

export const renderRaw = async (
  glb: Uint8Array<ArrayBuffer>,
  optionsJson: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  const renderer = await bindings();
  return renderer.renderImage(glb, optionsJson);
};

export const renderManyRaw = async (
  glb: Uint8Array<ArrayBuffer>,
  optionsJson: string,
): Promise<ReadonlyArray<Uint8Array<ArrayBuffer>>> => {
  const renderer = await bindings();
  return renderer.renderImages(glb, optionsJson);
};
