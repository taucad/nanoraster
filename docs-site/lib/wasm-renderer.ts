type WasmRenderer = {
  readonly default: (input: { readonly module_or_path: URL }) => Promise<unknown>;
  readonly render_glb_to_image: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /** Ordered identified views through one batch-scoped session; result order is view order. */
  readonly render_glb_to_images: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<Uint8Array<ArrayBuffer>[]>;
};

let renderer: Promise<WasmRenderer> | undefined;
let model: Promise<Uint8Array<ArrayBuffer>> | undefined;

/** The subject every documentation demo renders. */
const demoModelUrl = '/demo/gear-12-metal.glb';

/** Load the browser binding once per document. */
export const loadWasmRenderer = async (): Promise<WasmRenderer> => {
  renderer ??= (async () => {
    const moduleUrl = new URL('/demo/render_wasm.js', window.location.href).href;
    const module = (await import(/* webpackIgnore: true */ moduleUrl)) as unknown as WasmRenderer;
    await module.default({
      module_or_path: new URL('/demo/render_wasm_bg.wasm', window.location.href),
    });
    return module;
  })();
  return renderer;
};

/** Fetch and cache the demo GLB. */
export const loadDemoModel = async (): Promise<Uint8Array<ArrayBuffer>> => {
  model ??= (async () => {
    const response = await fetch(demoModelUrl);
    if (!response.ok) throw new Error(`Could not load ${demoModelUrl}`);
    return new Uint8Array(await response.arrayBuffer());
  })();
  return model;
};

/** True when the host exposes the WebGPU entry point the renderer needs. */
export const hasWebGpu = (): boolean => typeof navigator !== 'undefined' && 'gpu' in navigator;
