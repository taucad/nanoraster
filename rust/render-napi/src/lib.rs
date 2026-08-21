//! napi-rs surface for the Node artifact (Metal / Vulkan / DX12; lavapipe and
//! WARP in CI). Render entry points run as `AsyncTask`s on the libuv thread
//! pool so Node's event loop never blocks on a render or a lossy encode;
//! napi-rs wraps compute in catch_unwind so a core panic surfaces as a JS
//! error instead of aborting the host process. The `Renderer` class keeps one
//! GPU device alive across calls; the free functions are one-shot sugar.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Arc, Mutex, MutexGuard};

type SharedRenderer = Arc<Mutex<Option<render_core::Renderer>>>;

fn map_error(error: render_core::RenderError) -> Error {
    Error::from_reason(error.to_string())
}

fn lock_renderer(inner: &SharedRenderer) -> MutexGuard<'_, Option<render_core::Renderer>> {
    inner.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn disposed() -> Error {
    Error::from_reason("gpu: renderer disposed")
}

/// Ordered encoded images plus the optional timings from `timings: true`.
#[napi(object)]
pub struct RenderImagesResult {
    pub images: Vec<Buffer>,
    /// JSON-serialized stage timings and resource counters, present when the
    /// request set `timings: true`.
    pub timings: Option<String>,
}

fn images_result(
    (images, timings): (Vec<Vec<u8>>, Option<render_core::RenderBatchTimings>),
) -> RenderImagesResult {
    RenderImagesResult {
        images: images.into_iter().map(Into::into).collect(),
        timings: timings.map(|timings| timings.to_json()),
    }
}

pub struct RenderImageTask {
    renderer: Option<SharedRenderer>,
    glb: Uint8Array,
    options_json: String,
}

impl Task for RenderImageTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        match &self.renderer {
            None => pollster::block_on(render_core::render_image_request(
                &self.glb,
                &self.options_json,
            ))
            .map_err(map_error),
            Some(inner) => {
                let mut guard = lock_renderer(inner);
                let renderer = guard.as_mut().ok_or_else(disposed)?;
                pollster::block_on(renderer.render_image_request(&self.glb, &self.options_json))
                    .map_err(map_error)
            }
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

pub struct RenderImagesTask {
    renderer: Option<SharedRenderer>,
    glb: Uint8Array,
    options_json: String,
}

impl Task for RenderImagesTask {
    type Output = (Vec<Vec<u8>>, Option<render_core::RenderBatchTimings>);
    type JsValue = RenderImagesResult;

    fn compute(&mut self) -> Result<Self::Output> {
        match &self.renderer {
            None => pollster::block_on(render_core::render_images_request(
                &self.glb,
                &self.options_json,
                None,
            ))
            .map_err(map_error),
            Some(inner) => {
                let mut guard = lock_renderer(inner);
                let renderer = guard.as_mut().ok_or_else(disposed)?;
                pollster::block_on(renderer.render_images_request(
                    &self.glb,
                    &self.options_json,
                    None,
                ))
                .map_err(map_error)
            }
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(images_result(output))
    }
}

pub struct CreateRendererTask {
    options_json: Option<String>,
}

impl Task for CreateRendererTask {
    type Output = render_core::Renderer;
    type JsValue = Renderer;

    fn compute(&mut self) -> Result<Self::Output> {
        pollster::block_on(render_core::Renderer::from_request(
            self.options_json.as_deref(),
        ))
        .map_err(map_error)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(Renderer {
            inner: Arc::new(Mutex::new(Some(output))),
        })
    }
}

/// Persistent GPU renderer: one adapter/device/pipeline set reused across
/// calls. Calls on one renderer serialize on an internal lock; after
/// `dispose()` every call rejects with `gpu: renderer disposed`.
#[napi]
pub struct Renderer {
    inner: SharedRenderer,
}

/// Create a renderer that keeps device, shader, and pipelines alive across
/// calls. `options_json` is the `createRenderer` request contract (currently
/// `powerPreference: "high-performance" | "low-power"`).
#[napi]
pub fn create_renderer(options_json: Option<String>) -> AsyncTask<CreateRendererTask> {
    AsyncTask::new(CreateRendererTask { options_json })
}

#[napi]
impl Renderer {
    /// Render one view to encoded image bytes on this renderer's warm device.
    #[napi]
    pub fn render_image(
        &self,
        glb: Uint8Array,
        options_json: String,
    ) -> AsyncTask<RenderImageTask> {
        AsyncTask::new(RenderImageTask {
            renderer: Some(self.inner.clone()),
            glb,
            options_json,
        })
    }

    /// Render ordered identified views in one plan call on the warm device.
    #[napi]
    pub fn render_images(
        &self,
        glb: Uint8Array,
        options_json: String,
    ) -> AsyncTask<RenderImagesTask> {
        AsyncTask::new(RenderImagesTask {
            renderer: Some(self.inner.clone()),
            glb,
            options_json,
        })
    }

    /// Drop retained render targets above the core's retention budget. The
    /// one-shot façade calls this after every render so a single huge render
    /// cannot pin GPU memory for the process lifetime; it never blocks,
    /// because the façade queue leaves no call in flight.
    #[napi]
    pub fn trim_targets(&self) {
        if let Some(renderer) = lock_renderer(&self.inner).as_mut() {
            renderer.trim_targets();
        }
    }

    /// Destroy the GPU device now; later render calls reject.
    #[napi]
    pub fn dispose(&self) {
        if let Some(renderer) = lock_renderer(&self.inner).take() {
            renderer.destroy();
        }
    }
}

/// Render a kernel GLB to image bytes — encoded, or the raw frame itself for
/// `"raw"`. `options_json` is the shared
/// render-request contract (`render_core::RenderRequest`): a required
/// format `"png" | "webp" | "jpeg" | "jpg" | "raw"`, width/height, quality 0..=1,
/// phi/theta degrees, margin 0..=0.5, up `"x" | "y" | "z"`, background
/// `[r, g, b, a]` in 0..=1.
/// One-shot sugar: creates and destroys a device per call — hold a
/// [`Renderer`] to amortize that across calls.
#[napi]
pub fn render_image(glb: Uint8Array, options_json: String) -> AsyncTask<RenderImageTask> {
    AsyncTask::new(RenderImageTask {
        renderer: None,
        glb,
        options_json,
    })
}

/// Render ordered identified views through one batch-scoped plan call.
#[napi]
pub fn render_images(glb: Uint8Array, options_json: String) -> AsyncTask<RenderImagesTask> {
    AsyncTask::new(RenderImagesTask {
        renderer: None,
        glb,
        options_json,
    })
}

/// Benchmark the codec encoders over one render (white background so JPEG
/// participates): JSON report with per-format avg ms / bytes / FNV-1a
/// fingerprints for cross-artifact byte-identity checks.
#[cfg(feature = "bench")]
#[napi]
pub fn bench_codecs(glb: Uint8Array, width: u32, height: u32) -> Result<String> {
    let options = render_core::RenderOptions {
        width,
        height,
        background: Some([1.0, 1.0, 1.0, 1.0]),
        ..Default::default()
    };
    let started = std::time::Instant::now();
    let rendered =
        pollster::block_on(render_core::render_rgba(&glb, &options)).map_err(map_error)?;
    let render_duration = started.elapsed().as_secs_f64() * 1000.0;
    let epoch = std::time::Instant::now();
    let now = move || epoch.elapsed().as_secs_f64() * 1000.0;
    let mut report = render_core::bench_encodes(&rendered, &now).map_err(map_error)?;
    report["render"] = ((render_duration * 100.0).round() / 100.0).into();
    Ok(report.to_string())
}

/// Compare six singular calls with one six-view batch.
#[cfg(feature = "bench")]
#[napi]
pub fn bench_multi_view(glb: Uint8Array, width: u32, height: u32) -> Result<String> {
    let epoch = std::time::Instant::now();
    let now = move || epoch.elapsed().as_secs_f64() * 1000.0;
    pollster::block_on(render_core::bench_multi_view(&glb, width, height, &now))
        .map(|report| report.to_string())
        .map_err(map_error)
}

/// GPU-independent PNG/WebP/JPEG fingerprints for native/wasm conformance.
#[cfg(feature = "bench")]
#[napi]
pub fn codec_conformance() -> Result<String> {
    render_core::codec_conformance()
        .map(|report| report.to_string())
        .map_err(map_error)
}

/// The adapter a renderer created with `options_json` would bind, as JSON:
/// `{"backend","name","deviceType"}`. `"deviceType":"cpu"` means software
/// rasterization.
#[napi]
pub fn describe_adapter(options_json: Option<String>) -> Result<String> {
    pollster::block_on(render_core::describe_adapter(options_json.as_deref())).map_err(map_error)
}
