/** The persistent renderer handle the wasm artifact exposes. */
export type WasmRendererHandle = {
  readonly render_glb_to_image: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /** Ordered identified views through one plan call; result order is view order. */
  readonly render_glb_to_images: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<{ readonly images: Uint8Array<ArrayBuffer>[]; readonly profile?: string }>;
};

type WasmModule = {
  readonly default: (input: { readonly module_or_path: URL }) => Promise<unknown>;
  readonly Renderer: { readonly create: (optionsJson?: string) => Promise<WasmRendererHandle> };
};

let renderer: Promise<WasmRendererHandle> | undefined;
let model: Promise<Uint8Array<ArrayBuffer>> | undefined;

/** The subject every documentation demo renders. */
const demoModelUrl = '/demo/gear-12-metal.glb';

/**
 * Load the browser binding and create one persistent renderer per document:
 * the GPU device, shader, and pipelines come up once, and every later draw —
 * every slider tick — pays only render and encode.
 */
export const loadWasmRenderer = async (): Promise<WasmRendererHandle> => {
  // A failure must not stick in the cache, or every later render would fail
  // until a reload; clearing it lets the next control change retry the load.
  renderer ??= (async () => {
    const moduleUrl = new URL('/demo/render_wasm.js', window.location.href).href;
    const module = (await import(/* webpackIgnore: true */ moduleUrl)) as unknown as WasmModule;
    await module.default({
      module_or_path: new URL('/demo/render_wasm_bg.wasm', window.location.href),
    });
    return module.Renderer.create();
  })().catch((error: unknown) => {
    renderer = undefined;
    throw error;
  });
  return renderer;
};

/** Fetch and cache the demo GLB. */
export const loadDemoModel = async (): Promise<Uint8Array<ArrayBuffer>> => {
  model ??= (async () => {
    const response = await fetch(demoModelUrl);
    if (!response.ok) throw new Error(`Could not load ${demoModelUrl}`);
    return new Uint8Array(await response.arrayBuffer());
  })().catch((error: unknown) => {
    model = undefined;
    throw error;
  });
  return model;
};

/** True when the host exposes the WebGPU entry point the renderer needs. */
export const hasWebGpu = (): boolean => typeof navigator !== 'undefined' && 'gpu' in navigator;
