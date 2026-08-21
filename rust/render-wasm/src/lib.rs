//! wasm-bindgen surface for the browser artifact. WebGPU-only, surface-less:
//! runs inside a plain dedicated worker with no canvas or OffscreenCanvas.
//! The `Renderer` class keeps one GPU device alive across calls (create it
//! inside the worker that uses it — handles cannot cross `postMessage`);
//! the free functions are one-shot sugar that destroy their device on exit.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use wasm_bindgen::prelude::*;

fn to_js_error(error: render_core::RenderError) -> JsValue {
    JsError::new(&error.to_string()).into()
}

fn reflect_set(target: &js_sys::Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(target, &JsValue::from_str(key), value)?;
    Ok(())
}

fn images_result(
    images: Vec<Vec<u8>>,
    timings: Option<render_core::RenderBatchTimings>,
) -> Result<JsValue, JsValue> {
    let array = js_sys::Array::new();
    for image in images {
        array.push(&js_sys::Uint8Array::from(image.as_slice()));
    }
    let result = js_sys::Object::new();
    reflect_set(&result, "images", &array)?;
    if let Some(timings) = timings {
        reflect_set(&result, "timings", &JsValue::from_str(&timings.to_json()))?;
    }
    Ok(result.into())
}

fn pixels_result(rendered: render_core::Rendered) -> Result<JsValue, JsValue> {
    let result = js_sys::Object::new();
    reflect_set(
        &result,
        "rgba",
        &js_sys::Uint8Array::from(rendered.rgba.as_slice()).into(),
    )?;
    reflect_set(
        &result,
        "width",
        &JsValue::from_f64(f64::from(rendered.width)),
    )?;
    reflect_set(
        &result,
        "height",
        &JsValue::from_f64(f64::from(rendered.height)),
    )?;
    Ok(result.into())
}

/// Renderer state shared with in-flight call futures. The renderer moves out
/// of the cell while a call runs (single-threaded: overlapping calls see
/// `busy`), and `dispose()` during a call defers the destroy to the call's
/// completion.
struct Shared {
    renderer: RefCell<Option<render_core::Renderer>>,
    busy: Cell<bool>,
    disposed: Cell<bool>,
}

impl Shared {
    fn checkout(&self) -> Result<render_core::Renderer, JsValue> {
        if self.disposed.get() {
            return Err(JsError::new("gpu: renderer disposed").into());
        }
        if self.busy.get() {
            return Err(JsError::new(
                "gpu: renderer busy: calls on one renderer must be awaited in sequence",
            )
            .into());
        }
        let renderer = self
            .renderer
            .borrow_mut()
            .take()
            .expect("non-disposed idle renderer holds its core");
        self.busy.set(true);
        Ok(renderer)
    }

    fn check_in(&self, renderer: render_core::Renderer) {
        self.busy.set(false);
        if self.disposed.get() {
            renderer.destroy();
            return;
        }
        *self.renderer.borrow_mut() = Some(renderer);
    }
}

/// Persistent GPU renderer: one adapter/device/pipeline set reused across
/// calls in this worker.
#[wasm_bindgen(skip_typescript)]
pub struct Renderer {
    shared: Rc<Shared>,
}

#[wasm_bindgen]
impl Renderer {
    /// Async constructor surrogate: `const renderer = await Renderer.create(json)`.
    #[wasm_bindgen(skip_typescript)]
    pub fn create(options_json: Option<String>) -> js_sys::Promise {
        wasm_bindgen_futures::future_to_promise(async move {
            let renderer = render_core::Renderer::from_request(options_json.as_deref())
                .await
                .map_err(to_js_error)?;
            Ok(Renderer {
                shared: Rc::new(Shared {
                    renderer: RefCell::new(Some(renderer)),
                    busy: Cell::new(false),
                    disposed: Cell::new(false),
                }),
            }
            .into())
        })
    }

    /// Render one view to encoded image bytes on the warm device.
    #[wasm_bindgen(skip_typescript)]
    pub fn render_image(&self, glb: Vec<u8>, options_json: String) -> js_sys::Promise {
        let shared = self.shared.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            let mut renderer = shared.checkout()?;
            let outcome = renderer.render_image_request(&glb, &options_json).await;
            shared.check_in(renderer);
            let bytes = outcome.map_err(to_js_error)?;
            Ok(js_sys::Uint8Array::from(bytes.as_slice()).into())
        })
    }

    /// Render ordered identified views in one plan call on the warm device.
    #[wasm_bindgen(skip_typescript)]
    pub fn render_images(&self, glb: Vec<u8>, options_json: String) -> js_sys::Promise {
        let shared = self.shared.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            let mut renderer = shared.checkout()?;
            let outcome = renderer
                .render_images_request(&glb, &options_json, Some(&js_sys::Date::now))
                .await;
            shared.check_in(renderer);
            let (images, timings) = outcome.map_err(to_js_error)?;
            images_result(images, timings)
        })
    }

    /// Render one view to raw RGBA pixels (no encode) on the warm device.
    #[wasm_bindgen(skip_typescript)]
    pub fn render_pixels(&self, glb: Vec<u8>, options_json: String) -> js_sys::Promise {
        let shared = self.shared.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            let mut renderer = shared.checkout()?;
            let outcome = renderer.render_pixels_request(&glb, &options_json).await;
            shared.check_in(renderer);
            pixels_result(outcome.map_err(to_js_error)?)
        })
    }

    /// Drop retained render targets above the core's retention budget. The
    /// one-shot façade calls this after every render so a single huge render
    /// cannot pin GPU memory for the worker's lifetime. A no-op while a call
    /// holds the renderer, which the façade queue prevents anyway.
    #[wasm_bindgen(skip_typescript)]
    pub fn trim_targets(&self) {
        if let Some(renderer) = self.shared.renderer.borrow_mut().as_mut() {
            renderer.trim_targets();
        }
    }

    /// Destroy the WebGPU device now instead of waiting for GC; later calls
    /// reject with `gpu: renderer disposed`. Safe to call while a render is
    /// in flight: the destroy happens when that call settles.
    #[wasm_bindgen(skip_typescript)]
    pub fn dispose(&self) {
        self.shared.disposed.set(true);
        if !self.shared.busy.get()
            && let Some(renderer) = self.shared.renderer.borrow_mut().take()
        {
            renderer.destroy();
        }
    }
}

#[wasm_bindgen(typescript_custom_section)]
const RENDERER_TYPES: &str = r#"
/** Ordered encoded images plus the optional JSON timings from `timings: true`. */
export type RenderImagesResult = { images: Array<Uint8Array>; timings?: string };
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
  render_image(glb: Uint8Array, options_json: string): Promise<Uint8Array>;
  render_images(glb: Uint8Array, options_json: string): Promise<RenderImagesResult>;
  render_pixels(glb: Uint8Array, options_json: string): Promise<RenderPixelsResult>;
  trim_targets(): void;
  dispose(): void;
}
"#;

/// Render a kernel GLB to encoded image bytes. `options_json` is the shared
/// render-request contract (`render_core::RenderRequest`): width/height,
/// format `"png" | "webp" | "jpeg" | "jpg"`, quality 0..=1, phi/theta degrees,
/// margin 0..=0.5, up `"x" | "y" | "z"`, background `[r, g, b, a]` in 0..=1.
/// One-shot sugar: creates and destroys a device per call — hold a `Renderer`
/// to amortize that across calls.
#[wasm_bindgen]
pub async fn render_image(glb: Vec<u8>, options_json: String) -> Result<Vec<u8>, JsError> {
    render_core::render_image_request(&glb, &options_json)
        .await
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Render ordered identified views through one batch-scoped plan call.
#[wasm_bindgen(skip_typescript)]
pub async fn render_images(glb: Vec<u8>, options_json: String) -> Result<JsValue, JsValue> {
    let (images, timings) =
        render_core::render_images_request(&glb, &options_json, Some(&js_sys::Date::now))
            .await
            .map_err(to_js_error)?;
    images_result(images, timings)
}

/// Render a kernel GLB to raw straight-alpha RGBA8 pixels (no encode).
#[wasm_bindgen(skip_typescript)]
pub async fn render_pixels(glb: Vec<u8>, options_json: String) -> Result<JsValue, JsValue> {
    let rendered = render_core::render_pixels_request(&glb, &options_json)
        .await
        .map_err(to_js_error)?;
    pixels_result(rendered)
}

#[wasm_bindgen(typescript_custom_section)]
const FREE_FUNCTION_TYPES: &str = r#"
/** Render ordered identified views through one batch-scoped plan call. */
export function render_images(glb: Uint8Array, options_json: string): Promise<RenderImagesResult>;
/** Render a kernel GLB to raw straight-alpha RGBA8 pixels (no encode). */
export function render_pixels(glb: Uint8Array, options_json: string): Promise<RenderPixelsResult>;
"#;

/// Benchmark the codec encoders over one render (white background so JPEG
/// participates): JSON report with per-format avg ms / bytes / FNV-1a
/// fingerprints for cross-artifact byte-identity checks.
#[wasm_bindgen]
pub async fn bench_codecs(glb: Vec<u8>, width: u32, height: u32) -> Result<String, JsError> {
    let options = render_core::RenderOptions {
        width,
        height,
        background: Some([1.0, 1.0, 1.0, 1.0]),
        ..Default::default()
    };
    let start = js_sys::Date::now();
    let rendered = render_core::render_rgba(&glb, &options)
        .await
        .map_err(|e| JsError::new(&e.to_string()))?;
    let render_duration = js_sys::Date::now() - start;
    let mut report = render_core::bench_encodes(&rendered, &js_sys::Date::now)
        .map_err(|e| JsError::new(&e.to_string()))?;
    report["render"] = render_duration.round().into();
    Ok(report.to_string())
}

/// Compare six singular calls with one six-view batch.
#[wasm_bindgen]
pub async fn bench_multi_view(glb: Vec<u8>, width: u32, height: u32) -> Result<String, JsError> {
    render_core::bench_multi_view(&glb, width, height, &js_sys::Date::now)
        .await
        .map(|report| report.to_string())
        .map_err(|error| JsError::new(&error.to_string()))
}

/// GPU-independent PNG/WebP/JPEG fingerprints for native/wasm conformance.
#[wasm_bindgen]
pub fn codec_conformance() -> Result<String, JsError> {
    render_core::codec_conformance()
        .map(|report| report.to_string())
        .map_err(|error| JsError::new(&error.to_string()))
}

/// Backend + device name of the adapter the browser hands us.
#[wasm_bindgen]
pub async fn describe_adapter() -> Result<String, JsError> {
    render_core::describe_adapter()
        .await
        .map_err(|e| JsError::new(&e.to_string()))
}
