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

/**
 * The addon surface the generated NAPI loader resolves, as this package uses
 * it. @internal
 */
export type NapiModule = {
  createRenderer: (optionsJson?: string) => Promise<NapiRenderer>;
  describeAdapter: (optionsJson?: string) => Promise<string | null>;
};

/** Loads the addon the `node` export condition resolves. @internal */
export type NativeAddonLoader = () => Promise<NapiModule>;

let nativeAddon: NativeAddonLoader | undefined;
let cachedBindings: Promise<RendererBindings> | undefined;
let cachedNative: Promise<NapiModule> | undefined;

/**
 * Register the addon loader the Node entry point owns. The universal entry
 * point never calls this, which is what keeps the generated loader — and
 * every Node builtin it imports — out of a browser bundle.
 *
 * @internal
 * @param load - Loader for the addon the `node` export condition resolves
 */
export const installNativeBackend = (load: NativeAddonLoader): void => {
  nativeAddon = load;
};

/**
 * `true` when an addon backend is installed and the host exposes no
 * `navigator.gpu`, which is the one case that renders natively. @internal
 *
 * @returns Whether calls route to the addon rather than to the wasm artifact
 */
export const usesNativeBackend = (): boolean =>
  nativeAddon !== undefined && (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu === undefined;

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

const nativeModule = async (): Promise<NapiModule> => {
  if (nativeAddon === undefined) {
    throw new RenderError(
      'adapter-unavailable',
      'adapter-unavailable: no native addon is installed. This entry point renders through WebGPU; ' +
        'import `nanoraster` under the `node` export condition to reach the native addon.',
    );
  }
  cachedNative ??= nativeAddon();
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
  cachedBindings ??= usesNativeBackend() ? loadNapiBindings() : loadWasmBindings();
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
 * The native addon's adapter description, as JSON, or `null` when the host has
 * no adapter. Browsers never reach this: they read `navigator.gpu` in
 * TypeScript instead. @internal
 */
export const describeAdapterRaw = async (optionsJson: string | undefined): Promise<string | null> =>
  (await nativeModule()).describeAdapter(optionsJson);
