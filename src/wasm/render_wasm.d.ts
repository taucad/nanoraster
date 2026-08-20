/* tslint:disable */
/* eslint-disable */

/** Ordered encoded images plus the optional JSON profile from `profile: true`. */
export type RenderImagesResult = { images: Array<Uint8Array>; profile?: string };
/** Straight-alpha sRGB RGBA8 rows, tightly packed. */
export type RenderPixelsResult = { rgba: Uint8Array; width: number; height: number };
/**
 * Persistent GPU renderer: one adapter/device/pipeline set reused across
 * calls in this worker. Calls must be awaited in sequence; after dispose()
 * every call rejects.
 */
export class Renderer {
    private constructor();
    free(): void;
    static create(options_json?: string): Promise<Renderer>;
    render_glb_to_image(glb: Uint8Array, options_json: string): Promise<Uint8Array>;
    render_glb_to_images(glb: Uint8Array, options_json: string): Promise<RenderImagesResult>;
    render_glb_to_pixels(glb: Uint8Array, options_json: string): Promise<RenderPixelsResult>;
    dispose(): void;
}



/** Render ordered identified views through one batch-scoped plan call. */
export function render_glb_to_images(glb: Uint8Array, options_json: string): Promise<RenderImagesResult>;
/** Render a kernel GLB to raw straight-alpha RGBA8 pixels (no encode). */
export function render_glb_to_pixels(glb: Uint8Array, options_json: string): Promise<RenderPixelsResult>;



/**
 * Benchmark the codec encoders over one render (white background so JPEG
 * participates): JSON report with per-format avg ms / bytes / FNV-1a
 * fingerprints for cross-artifact byte-identity checks.
 */
export function bench_codecs(glb: Uint8Array, width: number, height: number): Promise<string>;

/**
 * Compare six singular calls with one six-view batch.
 */
export function bench_multi_view(glb: Uint8Array, width: number, height: number): Promise<string>;

/**
 * GPU-independent PNG/WebP/JPEG fingerprints for native/wasm conformance.
 */
export function codec_conformance(): string;

/**
 * Backend + device name of the adapter the browser hands us.
 */
export function describe_adapter(): Promise<string>;

/**
 * Render a kernel GLB to encoded image bytes. `options_json` is the shared
 * render-request contract (`render_core::RenderRequest`): width/height,
 * format `"png" | "webp" | "jpeg" | "jpg"`, quality 0..=1, phi/theta degrees,
 * margin 0..=0.5, up `"x" | "y" | "z"`, background `[r, g, b, a]` in 0..=1.
 * One-shot sugar: creates and destroys a device per call — hold a `Renderer`
 * to amortize that across calls.
 */
export function render_glb_to_image(glb: Uint8Array, options_json: string): Promise<Uint8Array>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_renderer_free: (a: number, b: number) => void;
    readonly renderer_create: (a: number, b: number) => number;
    readonly renderer_render_glb_to_image: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly renderer_render_glb_to_images: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly renderer_render_glb_to_pixels: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly renderer_dispose: (a: number) => void;
    readonly render_glb_to_image: (a: number, b: number, c: number, d: number) => number;
    readonly render_glb_to_images: (a: number, b: number, c: number, d: number) => number;
    readonly render_glb_to_pixels: (a: number, b: number, c: number, d: number) => number;
    readonly bench_codecs: (a: number, b: number, c: number, d: number) => number;
    readonly bench_multi_view: (a: number, b: number, c: number, d: number) => number;
    readonly codec_conformance: (a: number) => void;
    readonly describe_adapter: () => number;
    readonly __wasm_bindgen_func_elem_2052: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1056: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1056_4: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1056_5: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_2069: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_1053: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_1053_3: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number) => void;
    readonly __wbindgen_export5: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
