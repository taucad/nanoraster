/** Lazy environment selection for the WASM and N-API artifacts. */

import { RenderError } from '#render-error.js';

/** Ordered encoded images plus the optional profile JSON. @internal */
export type RawImagesResult = {
  readonly images: ReadonlyArray<Uint8Array<ArrayBuffer>>;
  readonly profile?: string;
};

/** Raw pixels result shared by both bindings. @internal */
export type RawPixelsResult = {
  readonly rgba: Uint8Array<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
};

/** One persistent binding-level renderer handle. @internal */
export type RawRendererHandle = {
  readonly renderImage: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  readonly renderImages: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<RawImagesResult>;
  readonly renderPixels: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<RawPixelsResult>;
  readonly dispose: () => void;
};

type RendererBindings = {
  readonly renderImage: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  readonly renderImages: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<RawImagesResult>;
  readonly renderPixels: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<RawPixelsResult>;
  readonly createRenderer: (optionsJson: string | undefined) => Promise<RawRendererHandle>;
  readonly describeAdapter: () => Promise<string>;
};

type WasmImagesResult = {
  images: Array<Uint8Array<ArrayBuffer>>;
  profile?: string;
};

type WasmRenderer = {
  render_glb_to_image: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  render_glb_to_images: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<WasmImagesResult>;
  render_glb_to_pixels: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<RawPixelsResult>;
  dispose: () => void;
};

type WasmModule = {
  default: (init: { module_or_path: URL }) => Promise<unknown>;
  render_glb_to_image: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  render_glb_to_images: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<WasmImagesResult>;
  render_glb_to_pixels: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<RawPixelsResult>;
  describe_adapter: () => Promise<string>;
  Renderer: {
    create: (optionsJson?: string) => Promise<WasmRenderer>;
  };
};

type NapiImagesResult = {
  images: Array<Uint8Array<ArrayBuffer>>;
  profile?: string | null;
};

type NapiRenderer = {
  renderGlbToImage: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<Uint8Array<ArrayBuffer>>;
  renderGlbToImages: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<NapiImagesResult>;
  renderGlbToPixels: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<RawPixelsResult>;
  dispose: () => void;
};

type NapiModule = {
  renderGlbToImage: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<Uint8Array<ArrayBuffer>>;
  renderGlbToImages: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<NapiImagesResult>;
  renderGlbToPixels: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<RawPixelsResult>;
  createRenderer: (optionsJson?: string) => Promise<NapiRenderer>;
  describeAdapter: () => string;
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

const normalizeImagesResult = (result: {
  images: Array<Uint8Array<ArrayBuffer>>;
  profile?: string | null;
}): RawImagesResult => ({
  images: [...result.images],
  ...(typeof result.profile === 'string' ? { profile: result.profile } : {}),
});

const loadWasmBindings = async (): Promise<RendererBindings> => {
  const wasm = (await import('./wasm/render_wasm.js')) as unknown as WasmModule;
  await wasm.default({ module_or_path: new URL('wasm/render_wasm_bg.wasm', import.meta.url) });
  return {
    renderImage: async (glb, optionsJson) => wasm.render_glb_to_image(glb, optionsJson),
    renderImages: async (glb, optionsJson) =>
      normalizeImagesResult(await wasm.render_glb_to_images(glb, optionsJson)),
    renderPixels: async (glb, optionsJson) => wasm.render_glb_to_pixels(glb, optionsJson),
    createRenderer: async (optionsJson) => {
      const renderer = await wasm.Renderer.create(optionsJson);
      return {
        renderImage: async (glb, json) => renderer.render_glb_to_image(glb, json),
        renderImages: async (glb, json) =>
          normalizeImagesResult(await renderer.render_glb_to_images(glb, json)),
        renderPixels: async (glb, json) => renderer.render_glb_to_pixels(glb, json),
        dispose: () => {
          renderer.dispose();
        },
      };
    },
    describeAdapter: async () => wasm.describe_adapter(),
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
    renderImage: async (glb, optionsJson) => native.renderGlbToImage(glb, optionsJson),
    renderImages: async (glb, optionsJson) =>
      normalizeImagesResult(await native.renderGlbToImages(glb, optionsJson)),
    renderPixels: async (glb, optionsJson) => native.renderGlbToPixels(glb, optionsJson),
    createRenderer: async (optionsJson) => {
      const renderer = await native.createRenderer(optionsJson);
      return {
        renderImage: async (glb, json) => renderer.renderGlbToImage(glb, json),
        renderImages: async (glb, json) => normalizeImagesResult(await renderer.renderGlbToImages(glb, json)),
        renderPixels: async (glb, json) => renderer.renderGlbToPixels(glb, json),
        dispose: () => {
          renderer.dispose();
        },
      };
    },
    describeAdapter: () => Promise.resolve(native.describeAdapter()),
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
): Promise<RawImagesResult> => {
  const renderer = await bindings();
  return renderer.renderImages(glb, optionsJson);
};

export const renderPixelsRaw = async (
  glb: Uint8Array<ArrayBuffer>,
  optionsJson: string,
): Promise<RawPixelsResult> => {
  const renderer = await bindings();
  return renderer.renderPixels(glb, optionsJson);
};

export const createRendererRaw = async (optionsJson: string | undefined): Promise<RawRendererHandle> => {
  const renderer = await bindings();
  return renderer.createRenderer(optionsJson);
};

export const describeAdapterRaw = async (): Promise<string> => {
  const renderer = await bindings();
  return renderer.describeAdapter();
};
