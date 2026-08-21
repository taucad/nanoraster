/**
 * Lazy environment selection for the WASM and N-API artifacts, plus the one
 * lazy renderer every one-shot call shares.
 */

import { RenderError } from '#render-error.js';

/** Ordered encoded images plus the optional timings JSON. @internal */
export type RawImagesResult = {
  readonly images: ReadonlyArray<Uint8Array<ArrayBuffer>>;
  readonly timings?: string;
};

/** One persistent binding-level renderer handle. @internal */
export type RawRendererHandle = {
  readonly renderImage: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  readonly renderImages: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<RawImagesResult>;
  /** Drop retained targets above the core's retention budget (one-shot guard). */
  readonly trimTargets: () => void;
  readonly dispose: () => void;
};

type RendererBindings = {
  readonly createRenderer: (optionsJson: string | undefined) => Promise<RawRendererHandle>;
};

type WasmImagesResult = {
  images: Array<Uint8Array<ArrayBuffer>>;
  timings?: string;
};

type WasmRenderer = {
  render_image: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<Uint8Array<ArrayBuffer>>;
  render_images: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<WasmImagesResult>;
  trim_targets: () => void;
  dispose: () => void;
};

type WasmModule = {
  default: (init: { module_or_path: URL }) => Promise<unknown>;
  Renderer: {
    create: (optionsJson?: string) => Promise<WasmRenderer>;
  };
};

type NapiImagesResult = {
  images: Array<Uint8Array<ArrayBuffer>>;
  timings?: string | null;
};

type NapiRenderer = {
  renderImage: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<Uint8Array<ArrayBuffer>>;
  renderImages: (glb: Uint8Array<ArrayBuffer>, optionsJson: string) => Promise<NapiImagesResult>;
  trimTargets: () => void;
  dispose: () => void;
};

type NapiModule = {
  createRenderer: (optionsJson?: string) => Promise<NapiRenderer>;
  describeAdapter: (optionsJson?: string) => string;
};

const nativePackages = {
  'darwin-arm64': 'nanoraster-darwin-arm64',
  'linux-x64': 'nanoraster-linux-x64-gnu',
  'win32-x64': 'nanoraster-win32-x64-msvc',
} as const;

export const nativePackageName = (platform: string, architecture: string): string | undefined =>
  nativePackages[`${platform}-${architecture}` as keyof typeof nativePackages];

let cachedBindings: Promise<RendererBindings> | undefined;
let cachedNative: Promise<NapiModule> | undefined;

/** `true` in Node, `false` wherever `navigator.gpu` exists. @internal */
export const isNodeRuntime = (): boolean => {
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  if (nav?.gpu !== undefined) {
    return false;
  }
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof proc?.versions?.node === 'string';
};

const normalizeImagesResult = (result: {
  images: Array<Uint8Array<ArrayBuffer>>;
  timings?: string | null;
}): RawImagesResult => ({
  images: [...result.images],
  ...(typeof result.timings === 'string' ? { timings: result.timings } : {}),
});

const loadWasmBindings = async (): Promise<RendererBindings> => {
  const wasm = (await import('./wasm/render_wasm.js')) as unknown as WasmModule;
  await wasm.default({ module_or_path: new URL('wasm/render_wasm_bg.wasm', import.meta.url) });
  return {
    createRenderer: async (optionsJson) => {
      const renderer = await wasm.Renderer.create(optionsJson);
      return {
        renderImage: async (glb, json) => renderer.render_image(glb, json),
        renderImages: async (glb, json) => normalizeImagesResult(await renderer.render_images(glb, json)),
        trimTargets: () => {
          renderer.trim_targets();
        },
        dispose: () => {
          renderer.dispose();
        },
      };
    },
  };
};

const loadNativeModule = async (): Promise<NapiModule> => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const packageName = nativePackageName(process.platform, process.arch);
  if (packageName === undefined) {
    throw new RenderError(
      'adapter-unavailable',
      `native render addon is not published for ${process.platform}-${process.arch}`,
    );
  }
  try {
    return require(packageName) as NapiModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RenderError(
      'adapter-unavailable',
      `native render addon unavailable for ${process.platform}-${process.arch}: ${detail}. ` +
        `Install the optional ${packageName} package or build it with \`pnpm nx run nanoraster:build:napi\`.`,
    );
  }
};

const nativeModule = async (): Promise<NapiModule> => {
  cachedNative ??= loadNativeModule();
  return cachedNative;
};

const loadNapiBindings = async (): Promise<RendererBindings> => {
  const native = await nativeModule();
  return {
    createRenderer: async (optionsJson) => {
      const renderer = await native.createRenderer(optionsJson);
      return {
        renderImage: async (glb, json) => renderer.renderImage(glb, json),
        renderImages: async (glb, json) => normalizeImagesResult(await renderer.renderImages(glb, json)),
        trimTargets: () => {
          renderer.trimTargets();
        },
        dispose: () => {
          renderer.dispose();
        },
      };
    },
  };
};

const bindings = async (): Promise<RendererBindings> => {
  cachedBindings ??= isNodeRuntime() ? loadNapiBindings() : loadWasmBindings();
  return cachedBindings;
};

let sharedRenderer: Promise<RawRendererHandle> | undefined;
// One-shot calls share one lazy renderer, so the process never holds two GPU
// devices at once (concurrent devices abort the process on D3D12/WARP) and
// every call after the first skips device bring-up. The chain serializes them
// here, at the façade, rather than parking libuv pool threads on a lock in
// Rust; the catch keeps one failed render from wedging every later call.
let queue: Promise<unknown> = Promise.resolve();

const oneShotRenderer = async (): Promise<RawRendererHandle> => {
  sharedRenderer ??= createRendererRaw(undefined).catch((error: unknown) => {
    // A failed bring-up must not poison the process: drop the memo so the
    // next call can try again.
    sharedRenderer = undefined;
    throw error;
  });
  return sharedRenderer;
};

const oneShot = <Value>(job: (handle: RawRendererHandle) => Promise<Value>): Promise<Value> => {
  const next = queue.then(async () => {
    const handle = await oneShotRenderer();
    try {
      return await job(handle);
    } finally {
      // Day-one guard: a single huge render must not pin its targets for the
      // process lifetime. Re-allocation costs milliseconds; the device
      // bring-up this renderer saves was the expensive part.
      handle.trimTargets();
    }
  });
  queue = next.catch(() => undefined);
  return next;
};

export const renderRaw = (
  glb: Uint8Array<ArrayBuffer>,
  optionsJson: string,
): Promise<Uint8Array<ArrayBuffer>> => oneShot(async (handle) => handle.renderImage(glb, optionsJson));

export const renderManyRaw = (glb: Uint8Array<ArrayBuffer>, optionsJson: string): Promise<RawImagesResult> =>
  oneShot(async (handle) => handle.renderImages(glb, optionsJson));

export const createRendererRaw = async (optionsJson: string | undefined): Promise<RawRendererHandle> => {
  const renderer = await bindings();
  return renderer.createRenderer(optionsJson);
};

/**
 * The native addon's adapter description, as JSON. Browsers never reach this:
 * they read `navigator.gpu` in TypeScript instead. @internal
 */
export const describeAdapterRaw = async (optionsJson: string | undefined): Promise<string> =>
  (await nativeModule()).describeAdapter(optionsJson);
