//! GLB → image transcoder core: parses kernel-written GLB scenes and renders
//! them with wgpu (metallic-roughness surfaces + line edges) into RGBA/PNG
//! bytes, with no surface/canvas — works headless on native
//! (Metal/Vulkan/DX12) and in the browser via WebGPU.
//!
//! Architecture: state crosses the boundary as handles, work crosses as plans.
//! [`Renderer`] keeps the GPU device, shader, and pipeline/target caches alive
//! across calls; the free functions are one-shot sugar (create → render →
//! destroy) with unchanged signatures.

#[cfg(feature = "bench")]
mod bench;
mod capture_overlay;
mod driver;
mod encode;
mod glb;
mod options;
mod render;

use glb::parse_glb;

#[cfg(feature = "bench")]
pub use bench::{bench_encodes, bench_multi_view, codec_conformance};
pub use encode::{ImageFormat, encode, encode_jpeg, encode_png, encode_webp};
pub use options::{
    CameraRequest, CreateRendererRequest, LightRequest, LightingRequest, LightingRigRequest,
    RenderImagesRequest, RenderRequest, RenderView,
};
pub use render::{Rendered, Renderer};

/// Camera projection used for the encoded image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Projection {
    #[default]
    Perspective,
    Orthographic,
}

/// Resolved projection values. Fit framing leaves orthographic span to the
/// bounds solver and always carries zoom 1; fixed framing carries every value
/// needed to construct the requested frustum.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CameraProjection {
    Perspective {
        vertical_field_of_view_deg: f32,
        zoom: f32,
    },
    Orthographic {
        vertical_span: Option<f32>,
        zoom: f32,
    },
}

impl CameraProjection {
    #[must_use]
    pub fn kind(self) -> Projection {
        match self {
            Self::Perspective { .. } => Projection::Perspective,
            Self::Orthographic { .. } => Projection::Orthographic,
        }
    }
}

/// Explicit positive clipping distances for a fixed camera.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClipPlanes {
    pub near: f32,
    pub far: f32,
}

/// Resolved camera framing in glTF world coordinates.
#[derive(Debug, Clone, PartialEq)]
pub enum RenderCamera {
    Fit {
        /// Direction from bounds centre toward the camera, normalized.
        direction: [f32; 3],
        /// Camera screen-up direction, normalized.
        up: [f32; 3],
        /// Corner-fit zoom padding (0.9 = 10% margin).
        padding_factor: f32,
        projection: CameraProjection,
    },
    Fixed {
        position: [f32; 3],
        target: [f32; 3],
        /// Camera screen-up direction, normalized.
        up: [f32; 3],
        projection: CameraProjection,
        clipping: Option<ClipPlanes>,
    },
}

impl RenderCamera {
    #[must_use]
    pub fn projection(&self) -> CameraProjection {
        match self {
            Self::Fit { projection, .. } | Self::Fixed { projection, .. } => *projection,
        }
    }

    #[must_use]
    pub fn projection_kind(&self) -> Projection {
        self.projection().kind()
    }

    #[must_use]
    pub fn is_fit(&self) -> bool {
        matches!(self, Self::Fit { .. })
    }
}

impl Default for RenderCamera {
    fn default() -> Self {
        Self::Fit {
            direction: [0.612_372_46, 0.5, 0.612_372_46],
            up: [0.0, 1.0, 0.0],
            padding_factor: 0.9,
            projection: CameraProjection::Perspective {
                vertical_field_of_view_deg: 45.0,
                zoom: 1.0,
            },
        }
    }
}

/// Frame a rig's light directions are authored in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LightingSpace {
    /// Camera-relative, so every view of a batch is lit identically.
    #[default]
    View,
    /// glTF world coordinates, rotated into view space
    /// per view — the light stays fixed to the model while views orbit it.
    World,
}

/// One directional light. `direction` points *from the surface toward the
/// light* — the vector the shader dots with the normal. The CPU normalises it
/// during the frame-uniform write, so any finite non-zero vector is accepted.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedLight {
    pub direction: [f32; 3],
    pub color: [f32; 3],
}

/// A validated lighting rig, uploaded verbatim into the `Frame` uniform.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedLighting {
    /// At most [`MAX_LIGHTS`]; empty renders from the environment alone.
    pub lights: Vec<ResolvedLight>,
    /// Flat multiplier on the diffuse colour.
    pub ambient: f32,
    /// Whether the analytic environment contributes (specular *and* diffuse).
    pub environment: bool,
    pub space: LightingSpace,
    /// Linear multiplier applied before the ACES tone map.
    pub exposure: f32,
}

/// Uniform-array capacity for [`ResolvedLighting::lights`].
pub const MAX_LIGHTS: usize = 8;

impl ResolvedLighting {
    /// The studio preset — the one definition of the built-in rig. `fs_mesh`
    /// carries no lighting literals of its own; it reads these through the
    /// uniform. Directions are the Tau viewer's `performance` lights
    /// projected into view space: key upper-left-front, fill opposite it,
    /// headlamp above the camera.
    #[must_use]
    pub fn studio() -> Self {
        Self {
            lights: vec![
                ResolvedLight {
                    direction: [-0.45, 0.61, 0.63],
                    color: [2.09, 2.09, 2.09],
                },
                ResolvedLight {
                    direction: [0.45, -0.61, -0.63],
                    color: [1.45, 1.42, 1.38],
                },
                ResolvedLight {
                    direction: [0.03, 0.74, 0.67],
                    color: [0.68, 0.66, 0.62],
                },
            ],
            ambient: 0.02,
            environment: true,
            space: LightingSpace::View,
            exposure: 1.0,
        }
    }
}

impl Default for ResolvedLighting {
    fn default() -> Self {
        Self::studio()
    }
}

/// Rendering options.
#[derive(Debug, Clone)]
pub struct RenderOptions {
    pub width: u32,
    pub height: u32,
    /// Fitted or fixed camera state.
    pub camera: RenderCamera,
    /// Edge line width in output pixels.
    pub line_width: f32,
    /// Background clear color as sRGB straight-alpha `[r, g, b, a]` in 0..=1;
    /// `None` renders on transparent. JPEG output requires an opaque one.
    pub background: Option<[f32; 4]>,
    /// Optional authored view label. Its presence is the switch: a label is
    /// stamped top-left whenever one is set.
    pub label: Option<String>,
    /// Whether to stamp the bottom-right XYZ orientation indicator.
    pub axes: bool,
    /// Whether to stamp the bottom-left scale bar. Perspective labels identify
    /// the subject-center plane with `@ center`; orthographic scale is
    /// depth-invariant.
    pub scale_bar: bool,
    /// Direct lights, ambient, environment and exposure. Defaults to
    /// [`ResolvedLighting::studio`].
    pub lighting: ResolvedLighting,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            width: 768,
            height: 432,
            camera: RenderCamera::default(),
            line_width: 2.0,
            background: None,
            label: None,
            axes: false,
            scale_bar: false,
            lighting: ResolvedLighting::studio(),
        }
    }
}

/// Failure taxonomy — the string prefixes are the stable contract surfaced to
/// the TS façade (`adapter-unavailable`, `device-lost`, `driver-unsupported`,
/// `gpu`, `parse`, `encode`).
#[derive(Debug)]
pub enum RenderError {
    Parse(String),
    AdapterUnavailable(String),
    /// The host's Vulkan driver is known to fault mid-render on this
    /// architecture. Deterministic on that host, so never a retry case.
    DriverUnsupported(String),
    Gpu(String),
    Encode(String),
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(m) => write!(f, "parse: {m}"),
            Self::AdapterUnavailable(m) => write!(f, "adapter-unavailable: {m}"),
            Self::DriverUnsupported(m) => write!(f, "driver-unsupported: {m}"),
            Self::Gpu(m) => write!(f, "gpu: {m}"),
            Self::Encode(m) => write!(f, "encode: {m}"),
        }
    }
}

impl std::error::Error for RenderError {}

/// Host clock supplying monotonic milliseconds. `Sync` because the native plan
/// executor reads stage timings from encode worker threads.
pub type TimingsClock = dyn Fn() -> f64 + Sync;

/// Per-view timings recorded by timed plan calls.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderViewTimings {
    pub id: String,
    /// Milliseconds. GPU render, resolve, and pixel readback for this view.
    pub render: f64,
    /// Milliseconds. Annotation stamping (zero when nothing is stamped).
    pub overlay: f64,
    /// Milliseconds. Image encoding in this view's format.
    pub encode: f64,
}

/// Batch setup/resource evidence recorded without changing the render path.
/// The resource counters attribute acquisitions to the timed call, so a
/// warm renderer reports zero device requests while the one-shot sugar
/// reports one.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderBatchTimings {
    /// Milliseconds. GLB parse, validation, and world-bounds computation.
    pub parse: f64,
    /// Milliseconds. Renderer acquisition plus scene upload for this call.
    pub setup: f64,
    pub peak_readback_bytes: u64,
    pub glb_parses: u32,
    pub adapter_device_requests: u32,
    pub pipeline_sets: u32,
    pub scene_uploads: u32,
    pub target_allocations: u32,
    pub views: Vec<RenderViewTimings>,
}

impl RenderBatchTimings {
    /// Camel-cased JSON for the bindings' wire shape.
    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("timings fields always serialize")
    }
}

/// Whether anything is stamped over the render. A label's presence is its own
/// switch, so this is the single definition the overlay, the minimum-dimension
/// rule, and the plan executor all read.
pub(crate) fn annotated(options: &RenderOptions) -> bool {
    options.axes || options.scale_bar || options.label.is_some()
}

fn validate_options(options: &RenderOptions) -> Result<(), RenderError> {
    if !(options::MIN_DIMENSION..=options::MAX_DIMENSION).contains(&options.width)
        || !(options::MIN_DIMENSION..=options::MAX_DIMENSION).contains(&options.height)
    {
        return Err(RenderError::Parse(format!(
            "dimensions {}x{} outside {}..={}",
            options.width,
            options.height,
            options::MIN_DIMENSION,
            options::MAX_DIMENSION
        )));
    }
    if annotated(options)
        && (options.width < options::ANNOTATED_MIN_DIMENSION
            || options.height < options::ANNOTATED_MIN_DIMENSION)
    {
        return Err(RenderError::Parse(format!(
            "annotated images must be at least {}x{}",
            options::ANNOTATED_MIN_DIMENSION,
            options::ANNOTATED_MIN_DIMENSION
        )));
    }
    if !options.line_width.is_finite() || !(0.25..=16.0).contains(&options.line_width) {
        return Err(RenderError::Parse(
            "lineWidth must be between 0.25 and 16".into(),
        ));
    }
    validate_camera(&options.camera)?;
    Ok(())
}

fn validated_vector(
    value: [f32; 3],
    name: &str,
    allow_zero: bool,
) -> Result<glam::Vec3, RenderError> {
    let vector = glam::Vec3::from(value);
    if !vector.is_finite() || (!allow_zero && vector.length() < 1e-6) {
        return Err(RenderError::Parse(format!(
            "{name} must be a finite non-zero vector"
        )));
    }
    Ok(vector)
}

fn validate_projection(projection: CameraProjection, fixed: bool) -> Result<(), RenderError> {
    match projection {
        CameraProjection::Perspective {
            vertical_field_of_view_deg,
            zoom,
        } => {
            if !vertical_field_of_view_deg.is_finite()
                || !(1.0..=179.0).contains(&vertical_field_of_view_deg)
                || !zoom.is_finite()
                || !(0.01..=100.0).contains(&zoom)
                || (!fixed && zoom != 1.0)
            {
                return Err(RenderError::Parse("invalid perspective projection".into()));
            }
        }
        CameraProjection::Orthographic {
            vertical_span,
            zoom,
        } => {
            if !zoom.is_finite()
                || !(0.01..=100.0).contains(&zoom)
                || (!fixed && (vertical_span.is_some() || zoom != 1.0))
                || (fixed && vertical_span.is_none_or(|span| !span.is_finite() || span <= 0.0))
            {
                return Err(RenderError::Parse("invalid orthographic projection".into()));
            }
        }
    }
    Ok(())
}

fn validate_camera(camera: &RenderCamera) -> Result<(), RenderError> {
    let (direction, up, projection) = match camera {
        RenderCamera::Fit {
            direction,
            up,
            padding_factor,
            projection,
        } => {
            if !padding_factor.is_finite() || !(0.5..=1.0).contains(padding_factor) {
                return Err(RenderError::Parse(
                    "camera margin must be between 0 and 0.5".into(),
                ));
            }
            (
                validated_vector(*direction, "camera direction", false)?,
                validated_vector(*up, "camera up", false)?,
                (*projection, false),
            )
        }
        RenderCamera::Fixed {
            position,
            target,
            up,
            projection,
            clipping,
        } => {
            let position = validated_vector(*position, "camera position", true)?;
            let target = validated_vector(*target, "camera target", true)?;
            let direction = position - target;
            if direction.length() < 1e-6 {
                return Err(RenderError::Parse(
                    "camera position and target must not coincide".into(),
                ));
            }
            if clipping.is_some_and(|planes| {
                !planes.near.is_finite()
                    || !planes.far.is_finite()
                    || planes.near <= 0.0
                    || planes.far <= planes.near
            }) {
                return Err(RenderError::Parse(
                    "camera clipping requires 0 < near < far".into(),
                ));
            }
            (
                direction.normalize(),
                validated_vector(*up, "camera up", false)?,
                (*projection, true),
            )
        }
    };
    if direction.normalize().cross(up.normalize()).length() < 1e-6 {
        return Err(RenderError::Parse(
            "camera direction and up must not be collinear".into(),
        ));
    }
    validate_projection(projection.0, projection.1)
}

pub(crate) fn with_view(error: RenderError, id: &str) -> RenderError {
    if id.is_empty() {
        return error;
    }
    let context = |message: String| format!("view {id:?}: {message}");
    match error {
        RenderError::Parse(message) => RenderError::Parse(context(message)),
        RenderError::AdapterUnavailable(message) => {
            RenderError::AdapterUnavailable(context(message))
        }
        RenderError::DriverUnsupported(message) => RenderError::DriverUnsupported(context(message)),
        RenderError::Gpu(message) => RenderError::Gpu(context(message)),
        RenderError::Encode(message) => RenderError::Encode(context(message)),
    }
}

pub(crate) fn with_view_result<T>(
    result: Result<T, RenderError>,
    id: &str,
) -> Result<T, RenderError> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => Err(with_view(error, id)),
    }
}

fn clock(now: Option<&TimingsClock>) -> f64 {
    now.map_or(0.0, |clock| clock())
}

/// Apply one view's camera identity and output overrides to the shared options.
fn resolved_view_options(options: &RenderOptions, view: &RenderView) -> RenderOptions {
    let mut view_options = options.clone();
    view_options.camera.clone_from(&view.camera);
    view_options.label.clone_from(&view.label);
    if let Some(width) = view.width {
        view_options.width = width;
    }
    if let Some(height) = view.height {
        view_options.height = height;
    }
    view_options
}

/// Resolve and validate every view into a plan entry (all CPU: no GPU work has
/// happened when this rejects).
fn build_plan(
    scene: &glb::Scene,
    options: &RenderOptions,
    format: ImageFormat,
    views: &[RenderView],
) -> Result<Vec<render::PlanEntry>, RenderError> {
    let mut plan = Vec::with_capacity(views.len());
    for view in views {
        let view_options = resolved_view_options(options, view);
        with_view_result(validate_options(&view_options), &view.id)?;
        let prepared = with_view_result(
            capture_overlay::prepare_view(scene, &view_options),
            &view.id,
        )?;
        plan.push(render::PlanEntry {
            id: view.id.clone(),
            format: view.format.unwrap_or(format),
            options: view_options,
            prepared,
        });
    }
    Ok(plan)
}

/// Upload the parsed scene and run the plan on a ready renderer, assembling
/// the timings from the executor's stages and the renderer's counter deltas.
async fn run_plan(
    renderer: &mut Renderer,
    counters_start: render::Counters,
    parsed: glb::Scene,
    plan: Vec<render::PlanEntry>,
    now: Option<&TimingsClock>,
    parse: f64,
    setup_started: f64,
) -> Result<(Vec<Vec<u8>>, Option<RenderBatchTimings>), RenderError> {
    let mut scene = render::Scene::new(parsed);
    let buffers = renderer.ensure_uploaded(&mut scene)?;
    let setup = clock(now) - setup_started;
    let (images, view_stages) = renderer.execute_plan(buffers, &plan, now).await?;
    let timings = now.map(|_| {
        let delta = renderer.counters().since(counters_start);
        RenderBatchTimings {
            parse,
            setup,
            peak_readback_bytes: plan
                .iter()
                .map(|entry| u64::from(entry.options.width) * u64::from(entry.options.height) * 4)
                .max()
                .unwrap_or(0),
            glb_parses: 1,
            adapter_device_requests: delta.device_requests,
            pipeline_sets: delta.pipeline_sets,
            scene_uploads: delta.scene_uploads,
            target_allocations: delta.target_allocations,
            views: plan
                .iter()
                .zip(view_stages)
                .map(|(entry, stages)| RenderViewTimings {
                    id: entry.id.clone(),
                    render: stages.render,
                    overlay: stages.overlay,
                    encode: stages.encode,
                })
                .collect(),
        }
    });
    Ok((images, timings))
}

/// One-shot sugar: create a renderer, run the plan, destroy the device. This
/// is the core's own one-shot contract, which the bindings' free functions
/// inherit — not the `nanoraster` package's, whose one-shot functions route
/// through one shared [`Renderer`] instead.
async fn render_once(
    glb: &[u8],
    options: &RenderOptions,
    format: ImageFormat,
    views: &[RenderView],
    now: Option<&TimingsClock>,
) -> Result<(Vec<Vec<u8>>, Option<RenderBatchTimings>), RenderError> {
    validate_options(options)?;
    if views.is_empty() {
        return Err(RenderError::Parse(
            "views must contain at least one view".into(),
        ));
    }
    let parse_started = clock(now);
    let scene = parse_glb(glb).map_err(RenderError::Parse)?;
    let parse = clock(now) - parse_started;
    let setup_started = clock(now);
    let plan = build_plan(&scene, options, format, views)?;
    let mut renderer = Renderer::new(wgpu::PowerPreference::HighPerformance).await?;
    let result = run_plan(
        &mut renderer,
        render::Counters::default(),
        scene,
        plan,
        now,
        parse,
        setup_started,
    )
    .await;
    // Release the device now instead of waiting for GC/drop (wasm especially).
    renderer.destroy();
    result
}

impl Renderer {
    /// Binding constructor: parse the `createRenderer` request JSON (currently
    /// `powerPreference`) and bring up the device.
    pub async fn from_request(options_json: Option<&str>) -> Result<Self, RenderError> {
        let power = CreateRendererRequest::from_json(options_json)?.resolve()?;
        Self::new(power).await
    }

    /// Render ordered identified views on this renderer's warm device, parsing
    /// and uploading the GLB once. The whole plan executes in one crossing.
    pub async fn render_images(
        &mut self,
        glb: &[u8],
        options: &RenderOptions,
        format: ImageFormat,
        views: &[RenderView],
        now: Option<&TimingsClock>,
    ) -> Result<(Vec<Vec<u8>>, Option<RenderBatchTimings>), RenderError> {
        validate_options(options)?;
        if views.is_empty() {
            return Err(RenderError::Parse(
                "views must contain at least one view".into(),
            ));
        }
        let counters_start = self.counters();
        self.recover_if_lost().await?;
        let parse_started = clock(now);
        let scene = parse_glb(glb).map_err(RenderError::Parse)?;
        let parse = clock(now) - parse_started;
        let setup_started = clock(now);
        let plan = build_plan(&scene, options, format, views)?;
        run_plan(self, counters_start, scene, plan, now, parse, setup_started).await
    }

    /// Binding surface: singular render-request JSON on a warm renderer.
    pub async fn render_image_request(
        &mut self,
        glb: &[u8],
        options_json: &str,
    ) -> Result<Vec<u8>, RenderError> {
        let (options, format) = RenderRequest::from_json(options_json)?.resolve()?;
        let view = singular_view(&options);
        let (mut images, _) = self
            .render_images(glb, &options, format, std::slice::from_ref(&view), None)
            .await?;
        Ok(images.remove(0))
    }

    /// Binding surface: plural render-request JSON on a warm renderer. The
    /// request's `timings: true` flag opts into stage timings; `now` supplies
    /// the clock on wasm (native self-clocks via `Instant`).
    pub async fn render_images_request(
        &mut self,
        glb: &[u8],
        options_json: &str,
        now: Option<&TimingsClock>,
    ) -> Result<(Vec<Vec<u8>>, Option<RenderBatchTimings>), RenderError> {
        let (options, format, views, want_timings) =
            RenderImagesRequest::from_json(options_json)?.resolve()?;
        let fallback = fallback_clock();
        let stage_clock = stage_clock(want_timings, now, fallback.as_deref())?;
        self.render_images(glb, &options, format, &views, stage_clock)
            .await
    }
}

fn singular_view(options: &RenderOptions) -> RenderView {
    RenderView {
        id: String::new(),
        label: options.label.clone(),
        camera: options.camera.clone(),
        width: None,
        height: None,
        format: None,
    }
}

/// The clock a `timings: true` request measures with when the host supplies
/// none: native self-clocks via `Instant`.
#[cfg(not(target_arch = "wasm32"))]
fn fallback_clock() -> Option<Box<TimingsClock>> {
    let epoch = std::time::Instant::now();
    Some(Box::new(move || epoch.elapsed().as_secs_f64() * 1000.0))
}

/// Wasm has no ambient clock, so there is nothing to fall back to: a timed
/// request there must carry the host's own.
#[cfg(target_arch = "wasm32")]
fn fallback_clock() -> Option<Box<TimingsClock>> {
    None
}

/// Resolve the clock the stage timings are measured with, or `None` when the
/// request did not ask for timings.
fn stage_clock<'a>(
    want_timings: bool,
    now: Option<&'a TimingsClock>,
    fallback: Option<&'a TimingsClock>,
) -> Result<Option<&'a TimingsClock>, RenderError> {
    if !want_timings {
        return Ok(None);
    }
    let clock = now.or(fallback);
    #[cfg(target_arch = "wasm32")]
    if clock.is_none() {
        return Err(RenderError::Parse(
            "timings require a host clock on wasm".into(),
        ));
    }
    Ok(clock)
}

/// Render a kernel GLB to straight-alpha RGBA8 (sRGB-encoded) pixels — the
/// encoders' own input, which `ImageFormat::Raw` hands back verbatim.
pub async fn render_rgba(glb: &[u8], options: &RenderOptions) -> Result<Rendered, RenderError> {
    validate_options(options)?;
    // Reject before any GPU work: parse and prepare precede device creation.
    let parsed = parse_glb(glb).map_err(RenderError::Parse)?;
    let prepared = capture_overlay::prepare_view(&parsed, options)?;
    let entry = render::PlanEntry {
        id: String::new(),
        options: options.clone(),
        // Unused: the RGBA path stops before encode.
        format: ImageFormat::Png,
        prepared,
    };
    let mut renderer = Renderer::new(wgpu::PowerPreference::HighPerformance).await?;
    let mut scene = render::Scene::new(parsed);
    let result = async {
        let buffers = renderer.ensure_uploaded(&mut scene)?;
        renderer.render_entry_to_rgba(buffers, &entry).await
    }
    .await;
    renderer.destroy();
    result
}

/// Render a kernel GLB straight to encoded image bytes.
pub async fn render_image(
    glb: &[u8],
    options: &RenderOptions,
    format: ImageFormat,
) -> Result<Vec<u8>, RenderError> {
    let view = singular_view(options);
    let mut images = render_images(glb, options, format, std::slice::from_ref(&view)).await?;
    Ok(images.remove(0))
}

/// Render ordered views while parsing and uploading the GLB only once.
pub async fn render_images(
    glb: &[u8],
    options: &RenderOptions,
    format: ImageFormat,
    views: &[RenderView],
) -> Result<Vec<Vec<u8>>, RenderError> {
    render_once(glb, options, format, views, None)
        .await
        .map(|(images, _)| images)
}

/// Benchmark entry using the production batch path plus a caller-provided clock.
pub async fn render_images_timed(
    glb: &[u8],
    options: &RenderOptions,
    format: ImageFormat,
    views: &[RenderView],
    now: &TimingsClock,
) -> Result<(Vec<Vec<u8>>, RenderBatchTimings), RenderError> {
    let (images, timings) = render_once(glb, options, format, views, Some(now)).await?;
    Ok((images, timings.expect("timings requested")))
}

/// One-call surface for the wasm/napi bindings: parse the TS façade's JSON
/// render request (see [`RenderRequest`]), render, encode.
pub async fn render_image_request(glb: &[u8], options_json: &str) -> Result<Vec<u8>, RenderError> {
    let (options, format) = RenderRequest::from_json(options_json)?.resolve()?;
    render_image(glb, &options, format).await
}

/// Binding surface for an ordered plural request. The request's
/// `timings: true` flag opts into stage timings; `now` supplies the clock on
/// wasm (native self-clocks via `Instant`).
pub async fn render_images_request(
    glb: &[u8],
    options_json: &str,
    now: Option<&TimingsClock>,
) -> Result<(Vec<Vec<u8>>, Option<RenderBatchTimings>), RenderError> {
    let (options, format, views, want_timings) =
        RenderImagesRequest::from_json(options_json)?.resolve()?;
    let fallback = fallback_clock();
    let stage_clock = stage_clock(want_timings, now, fallback.as_deref())?;
    render_once(glb, &options, format, &views, stage_clock).await
}

/// Describe the adapter a [`Renderer`] built from `options_json` would bind,
/// as JSON: `{"backend","name","deviceType"}`, or `None` when the host has no
/// adapter. Lets consumers distinguish absent WebGPU from a software (`"cpu"`)
/// adapter before committing, and lets CI assert the expected backend
/// (Metal/lavapipe/WARP). Only invalid options are an error: having no adapter
/// is an answer.
pub async fn describe_adapter(options_json: Option<&str>) -> Result<Option<String>, RenderError> {
    let power = CreateRendererRequest::from_json(options_json)?.resolve()?;
    Ok(adapter_description(
        render::request_adapter(power).await.ok(),
    ))
}

/// wgpu reports "no adapter" as a request error; the probe reports it as
/// `None`, which is what every caller of the probe wants back.
fn adapter_description(adapter: Option<wgpu::Adapter>) -> Option<String> {
    let info = adapter?.get_info();
    Some(
        serde_json::json!({
            "backend": info.backend.to_str(),
            "name": info.name,
            "deviceType": device_type_name(info.device_type),
        })
        .to_string(),
    )
}

/// wgpu's device classes under the names the published `AdapterInfo` uses.
fn device_type_name(device_type: wgpu::DeviceType) -> &'static str {
    match device_type {
        wgpu::DeviceType::DiscreteGpu => "discrete-gpu",
        wgpu::DeviceType::IntegratedGpu => "integrated-gpu",
        wgpu::DeviceType::VirtualGpu => "virtual-gpu",
        wgpu::DeviceType::Cpu => "cpu",
        wgpu::DeviceType::Other => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::json;

    use super::*;

    const FIXTURE: &[u8] = include_bytes!("../../../tests/fixtures/gear-12.glb");

    fn material_variant(metallic: f32, roughness: f32) -> Vec<u8> {
        let parsed = gltf::binary::Glb::from_slice(FIXTURE).expect("fixture");
        let mut document: serde_json::Value =
            serde_json::from_slice(&parsed.json).expect("fixture JSON");
        document["materials"][0]["pbrMetallicRoughness"]["metallicFactor"] = json!(metallic);
        document["materials"][0]["pbrMetallicRoughness"]["roughnessFactor"] = json!(roughness);
        gltf::binary::Glb {
            header: gltf::binary::Header {
                magic: *b"glTF",
                version: 2,
                length: 0,
            },
            json: Cow::Owned(serde_json::to_vec(&document).expect("variant JSON")),
            bin: parsed.bin.map(|bytes| Cow::Owned(bytes.into_owned())),
        }
        .to_vec()
        .expect("variant GLB")
    }

    fn view(id: &str) -> RenderView {
        RenderView {
            id: id.into(),
            label: None,
            camera: RenderCamera::default(),
            width: None,
            height: None,
            format: None,
        }
    }

    #[test]
    fn public_defaults_are_locked() {
        let options = RenderOptions::default();
        assert_eq!(options.width, 768);
        assert_eq!(options.height, 432);
        assert_eq!(options.camera, RenderCamera::default());
        assert_eq!(options.line_width, 2.0);
        assert_eq!(options.camera.projection_kind(), Projection::Perspective);
        assert_eq!(options.background, None);
        assert_eq!(options.label, None);
        assert!(!options.axes);
        assert!(options.label.is_none());
        assert!(!options.scale_bar);
        assert_eq!(options.lighting, ResolvedLighting::studio());
        assert_eq!(ResolvedLighting::default(), ResolvedLighting::studio());
        assert_eq!(options.lighting.lights.len(), 3);
        assert_eq!(options.lighting.ambient, 0.02);
        assert_eq!(options.lighting.exposure, 1.0);
        assert!(options.lighting.environment);
        assert_eq!(options.lighting.space, LightingSpace::View);
        assert_eq!(LightingSpace::default(), LightingSpace::View);
        assert_eq!(Projection::default(), Projection::Perspective);
    }

    #[test]
    fn error_display_contract_is_locked() {
        let cases = [
            (RenderError::Parse("bad glb".into()), "parse: bad glb"),
            (
                RenderError::AdapterUnavailable("no adapter".into()),
                "adapter-unavailable: no adapter",
            ),
            (RenderError::Gpu("device lost".into()), "gpu: device lost"),
            (
                RenderError::DriverUnsupported("lavapipe".into()),
                "driver-unsupported: lavapipe",
            ),
            (
                RenderError::Encode("transparent jpeg".into()),
                "encode: transparent jpeg",
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(error.to_string(), expected);
            assert!(std::error::Error::source(&error).is_none());
        }
    }

    #[test]
    fn option_validation_covers_every_rejection() {
        let invalid = [
            RenderOptions {
                width: 15,
                ..Default::default()
            },
            RenderOptions {
                height: 4097,
                ..Default::default()
            },
            RenderOptions {
                width: 191,
                axes: true,
                ..Default::default()
            },
            RenderOptions {
                height: 191,
                scale_bar: true,
                ..Default::default()
            },
            RenderOptions {
                line_width: f32::NAN,
                ..Default::default()
            },
            RenderOptions {
                camera: RenderCamera::Fixed {
                    position: [0.0, 0.0, 0.0],
                    target: [0.0, 0.0, 0.0],
                    up: [0.0, 1.0, 0.0],
                    projection: CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    },
                    clipping: None,
                },
                ..Default::default()
            },
            RenderOptions {
                camera: RenderCamera::Fit {
                    direction: [f32::NAN, 0.0, 1.0],
                    up: [0.0, 1.0, 0.0],
                    padding_factor: 0.9,
                    projection: CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    },
                },
                ..Default::default()
            },
            RenderOptions {
                camera: RenderCamera::Fit {
                    direction: [0.612_372_46, 0.5, 0.612_372_46],
                    up: [0.0, 1.0, 0.0],
                    padding_factor: 0.49,
                    projection: CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    },
                },
                ..Default::default()
            },
            RenderOptions {
                camera: RenderCamera::Fit {
                    direction: [0.612_372_46, 0.5, 0.612_372_46],
                    up: [0.0, 1.0, 0.0],
                    padding_factor: 0.9,
                    projection: CameraProjection::Perspective {
                        vertical_field_of_view_deg: 0.0,
                        zoom: 1.0,
                    },
                },
                ..Default::default()
            },
            RenderOptions {
                camera: RenderCamera::Fixed {
                    position: [0.0, 0.0, 2.0],
                    target: [0.0, 0.0, 0.0],
                    up: [0.0, 1.0, 0.0],
                    projection: CameraProjection::Orthographic {
                        vertical_span: Some(-1.0),
                        zoom: 1.0,
                    },
                    clipping: None,
                },
                ..Default::default()
            },
            RenderOptions {
                camera: RenderCamera::Fixed {
                    position: [0.0, 0.0, 2.0],
                    target: [0.0, 0.0, 0.0],
                    up: [0.0, 1.0, 0.0],
                    projection: CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    },
                    clipping: Some(ClipPlanes {
                        near: 1.0,
                        far: 1.0,
                    }),
                },
                ..Default::default()
            },
            RenderOptions {
                camera: RenderCamera::Fixed {
                    position: [0.0, 0.0, 2.0],
                    target: [0.0, 0.0, 0.0],
                    up: [0.0, 0.0, 1.0],
                    projection: CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    },
                    clipping: None,
                },
                ..Default::default()
            },
        ];
        for options in invalid {
            assert!(validate_options(&options).is_err());
        }
        assert!(validate_options(&RenderOptions::default()).is_ok());
        assert!(
            validate_options(&RenderOptions {
                camera: RenderCamera::Fit {
                    direction: [0.612_372_46, 0.5, 0.612_372_46],
                    up: [0.0, 1.0, 0.0],
                    padding_factor: 0.9,
                    projection: CameraProjection::Orthographic {
                        vertical_span: None,
                        zoom: 1.0,
                    },
                },
                ..Default::default()
            })
            .is_ok()
        );
        assert!(
            validate_options(&RenderOptions {
                camera: RenderCamera::Fixed {
                    position: [0.0, 0.0, 2.0],
                    target: [0.0, 0.0, 0.0],
                    up: [0.0, 1.0, 0.0],
                    projection: CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    },
                    clipping: None,
                },
                ..Default::default()
            })
            .is_ok()
        );
    }

    #[test]
    fn view_context_preserves_every_error_variant() {
        assert_eq!(
            with_view(RenderError::Parse("x".into()), "").to_string(),
            "parse: x"
        );
        let cases = [
            RenderError::Parse("x".into()),
            RenderError::AdapterUnavailable("x".into()),
            RenderError::Gpu("x".into()),
            RenderError::Encode("x".into()),
            RenderError::DriverUnsupported("x".into()),
        ];
        for error in cases {
            assert!(
                with_view(error, "front")
                    .to_string()
                    .contains("view \"front\": x")
            );
        }
        assert!(with_view_result::<()>(Ok(()), "front").is_ok());
        assert_eq!(
            with_view_result::<()>(Err(RenderError::Gpu("lost".into())), "front")
                .unwrap_err()
                .to_string(),
            "gpu: view \"front\": lost"
        );
    }

    #[test]
    fn view_overrides_resolve_onto_shared_options() {
        let options = RenderOptions::default();
        let plain = resolved_view_options(&options, &view("front"));
        assert_eq!((plain.width, plain.height), (768, 432));
        assert_eq!(plain.camera, RenderCamera::default());

        let overridden = resolved_view_options(
            &options,
            &RenderView {
                width: Some(1536),
                height: Some(804),
                format: Some(ImageFormat::Jpeg { quality: 80 }),
                ..view("og")
            },
        );
        assert_eq!((overridden.width, overridden.height), (1536, 804));

        // A per-view dimension override outside the valid range rejects with
        // the view's identity attached.
        let bad = RenderView {
            width: Some(8),
            ..view("tiny")
        };
        let error = pollster::block_on(render_images(
            FIXTURE,
            &RenderOptions::default(),
            ImageFormat::Png,
            std::slice::from_ref(&bad),
        ))
        .unwrap_err();
        assert!(error.to_string().contains("view \"tiny\""), "{error}");
    }

    #[test]
    fn public_requests_reject_before_gpu_work() {
        let invalid_options = RenderOptions {
            width: 1,
            ..Default::default()
        };
        assert!(pollster::block_on(render_rgba(FIXTURE, &invalid_options)).is_err());
        assert!(pollster::block_on(render_rgba(b"bad", &RenderOptions::default())).is_err());
        assert!(
            pollster::block_on(render_image(
                b"bad",
                &RenderOptions::default(),
                ImageFormat::Png,
            ))
            .is_err()
        );
        assert!(
            pollster::block_on(render_images(
                FIXTURE,
                &RenderOptions::default(),
                ImageFormat::Png,
                &[],
            ))
            .is_err()
        );
        assert!(
            pollster::block_on(render_images_timed(
                b"bad",
                &RenderOptions::default(),
                ImageFormat::Png,
                &[view("front")],
                &|| 0.0,
            ))
            .is_err()
        );
        assert!(pollster::block_on(render_image_request(FIXTURE, "{")).is_err());
        assert!(pollster::block_on(render_image_request(FIXTURE, r#"{"width":1}"#)).is_err());
        assert!(pollster::block_on(render_images_request(FIXTURE, "{}", None)).is_err());
        assert!(
            pollster::block_on(render_images_request(
                FIXTURE,
                r#"{"views":[{"id":"x","phi":null,"theta":0}]}"#,
                None,
            ))
            .is_err()
        );
        assert!(
            pollster::block_on(Renderer::from_request(Some(
                r#"{"powerPreference":"turbo"}"#
            )))
            .is_err()
        );

        let front = view("bad");
        assert!(
            pollster::block_on(render_images(
                FIXTURE,
                &invalid_options,
                ImageFormat::Png,
                std::slice::from_ref(&front),
            ))
            .is_err()
        );
        assert!(
            pollster::block_on(render_images(
                FIXTURE,
                &RenderOptions::default(),
                ImageFormat::Png,
                &[RenderView {
                    camera: RenderCamera::Fixed {
                        position: [0.0, 0.0, 0.0],
                        target: [0.0, 0.0, 0.0],
                        up: [0.0, 1.0, 0.0],
                        projection: CameraProjection::Perspective {
                            vertical_field_of_view_deg: 45.0,
                            zoom: 1.0,
                        },
                        clipping: None,
                    },
                    ..front.clone()
                }],
            ))
            .is_err()
        );
        // A per-view overlay that cannot be laid out fails inside `build_plan`,
        // still before any GPU work.
        assert!(
            pollster::block_on(render_images(
                FIXTURE,
                &RenderOptions {
                    width: 192,
                    height: 192,
                    ..Default::default()
                },
                ImageFormat::Png,
                &[RenderView {
                    label: Some("W".repeat(64)),
                    ..front.clone()
                }],
            ))
            .is_err()
        );
    }

    #[test]
    fn gpu_public_surface_renders_and_times_stages() {
        let options = RenderOptions {
            width: 192,
            height: 192,
            background: Some([1.0, 1.0, 1.0, 1.0]),
            label: Some("Front".into()),
            axes: true,
            scale_bar: true,
            ..Default::default()
        };
        let views = [RenderView {
            label: Some("Front".into()),
            ..view("front")
        }];

        let rendered = pollster::block_on(render_rgba(FIXTURE, &options)).expect("RGBA render");
        assert_eq!(rendered.width, 192);
        assert_eq!(rendered.height, 192);
        let material_options = RenderOptions {
            width: 192,
            height: 192,
            ..Default::default()
        };
        let baseline =
            pollster::block_on(render_rgba(FIXTURE, &material_options)).expect("baseline material");
        let polished_metal =
            pollster::block_on(render_rgba(&material_variant(1.0, 0.05), &material_options))
                .expect("polished metal material");
        let polished_metal_repeat =
            pollster::block_on(render_rgba(&material_variant(1.0, 0.05), &material_options))
                .expect("repeated polished metal material");
        assert_ne!(baseline.rgba, polished_metal.rgba);
        assert_eq!(polished_metal.rgba, polished_metal_repeat.rgba);

        let png = pollster::block_on(render_image(FIXTURE, &options, ImageFormat::Png))
            .expect("PNG render");
        assert_eq!(&png[..4], &[0x89, 0x50, 0x4e, 0x47]);

        let images = pollster::block_on(render_images(
            FIXTURE,
            &options,
            ImageFormat::WebP { quality: 100 },
            &views,
        ))
        .expect("batch render");
        assert_eq!(&images[0][..4], b"RIFF");

        let tick = AtomicU64::new(0);
        let clock = move || (tick.fetch_add(1, Ordering::Relaxed) + 1) as f64;
        let (_, timings) = pollster::block_on(render_images_timed(
            FIXTURE,
            &options,
            ImageFormat::Png,
            &views,
            &clock,
        ))
        .expect("timed render");
        assert_eq!(timings.glb_parses, 1);
        assert_eq!(timings.adapter_device_requests, 1);
        assert_eq!(timings.scene_uploads, 1);
        assert_eq!(timings.views[0].id, "front");
        assert!(timings.views[0].encode > 0.0);

        let request = r#"{"format":"png","width":192,"height":192,"background":[1,1,1,1]}"#;
        assert!(pollster::block_on(render_image_request(FIXTURE, request)).is_ok());
        let plural = r#"{"format":"png","width":192,"height":192,"background":[1,1,1,1],"views":[{"id":"front"}]}"#;
        assert!(pollster::block_on(render_images_request(FIXTURE, plural, None)).is_ok());
        let raw = pollster::block_on(render_image_request(
            FIXTURE,
            r#"{"format":"raw","width":192,"height":192}"#,
        ))
        .expect("raw request");
        assert_eq!(raw.len(), 192 * 192 * 4);
        let adapter: serde_json::Value = serde_json::from_str(
            &pollster::block_on(describe_adapter(Some(r#"{"powerPreference":"low-power"}"#)))
                .expect("adapter description")
                .expect("an adapter on a test host"),
        )
        .expect("adapter JSON");
        assert!(
            ["metal", "vulkan", "dx12", "webgpu"]
                .contains(&adapter["backend"].as_str().expect("backend"))
        );
        assert!(adapter["name"].is_string());
        assert!(
            [
                "discrete-gpu",
                "integrated-gpu",
                "virtual-gpu",
                "cpu",
                "unknown"
            ]
            .contains(&adapter["deviceType"].as_str().expect("deviceType"))
        );

        #[cfg(feature = "bench")]
        {
            let benchmark = pollster::block_on(bench::bench_multi_view(FIXTURE, 192, 192, &clock))
                .expect("multi-view benchmark");
            assert_eq!(benchmark["variants"].as_array().map(Vec::len), Some(8));
        }
    }

    #[test]
    fn device_types_map_to_the_published_kebab_case_names() {
        let names: Vec<&str> = [
            wgpu::DeviceType::DiscreteGpu,
            wgpu::DeviceType::IntegratedGpu,
            wgpu::DeviceType::VirtualGpu,
            wgpu::DeviceType::Cpu,
            wgpu::DeviceType::Other,
        ]
        .into_iter()
        .map(device_type_name)
        .collect();
        assert_eq!(
            names,
            [
                "discrete-gpu",
                "integrated-gpu",
                "virtual-gpu",
                "cpu",
                "unknown"
            ]
        );
    }

    #[test]
    fn a_host_with_no_adapter_describes_nothing() {
        assert_eq!(adapter_description(None), None);
    }

    #[test]
    fn timings_serialize_camel_cased_json() {
        let timings = RenderBatchTimings {
            parse: 1.5,
            setup: 2.0,
            peak_readback_bytes: 4096,
            glb_parses: 1,
            adapter_device_requests: 0,
            pipeline_sets: 0,
            scene_uploads: 1,
            target_allocations: 0,
            views: vec![RenderViewTimings {
                id: "front".into(),
                render: 3.0,
                overlay: 0.0,
                encode: 4.0,
            }],
        };
        let json: serde_json::Value = serde_json::from_str(&timings.to_json()).expect("valid JSON");
        assert_eq!(json["parse"], 1.5);
        assert_eq!(json["adapterDeviceRequests"], 0);
        assert_eq!(json["views"][0]["encode"], 4.0);
    }

    #[test]
    fn encode_failures_carry_through_the_plan_executor() {
        // A transparent JPEG passes validation and fails at encode, exercising
        // the executor's error propagation on both the singular fast path and
        // the parallel batch path.
        let singular = pollster::block_on(render_image(
            FIXTURE,
            &RenderOptions::default(),
            ImageFormat::Jpeg { quality: 85 },
        ))
        .unwrap_err();
        assert!(singular.to_string().starts_with("encode:"), "{singular}");

        let batch = pollster::block_on(render_images(
            FIXTURE,
            &RenderOptions::default(),
            ImageFormat::Jpeg { quality: 85 },
            &[view("iso"), view("front")],
        ))
        .unwrap_err();
        assert!(batch.to_string().starts_with("encode: view \"iso\":"));
    }

    #[test]
    fn warm_renderer_reuses_the_device_across_calls_and_plans() {
        let mut renderer = pollster::block_on(Renderer::from_request(None)).expect("renderer");
        let options = RenderOptions {
            width: 192,
            height: 192,
            ..Default::default()
        };

        // One-shot sugar and the warm renderer must produce identical bytes.
        let cold = pollster::block_on(render_image(FIXTURE, &options, ImageFormat::Png))
            .expect("cold render");
        let warm = pollster::block_on(
            renderer.render_image_request(FIXTURE, r#"{"format":"png","width":192,"height":192}"#),
        )
        .expect("warm render");
        assert_eq!(cold, warm);

        // The second call reuses the device: the timed counters attribute zero
        // adapter/device requests and zero pipeline builds to the call.
        let plural = r#"{"format":"png","width":192,"height":192,"timings":true,"views":[{"id":"front"},{"id":"top"}]}"#;
        let (images, timings) =
            pollster::block_on(renderer.render_images_request(FIXTURE, plural, None))
                .expect("warm batch");
        assert_eq!(images.len(), 2);
        let timings = timings.expect("timings requested");
        assert_eq!(timings.adapter_device_requests, 0);
        assert_eq!(timings.pipeline_sets, 0);
        assert_eq!(timings.target_allocations, 0);
        assert_eq!(timings.scene_uploads, 1);
        assert_eq!(timings.views.len(), 2);
        assert!(timings.views[0].encode > 0.0);

        // R15: per-view output overrides — a mixed-size, mixed-format ladder
        // in one plan call, byte-identical to the equivalent singular calls.
        let ladder = r#"{"format":"png","width":192,"height":192,"views":[{"id":"card"},{"id":"og","width":256,"height":256},{"id":"hero","width":256,"height":256,"format":"webp","quality":0.9}]}"#;
        let (ladder_images, _) =
            pollster::block_on(renderer.render_images_request(FIXTURE, ladder, None))
                .expect("ladder");
        assert_eq!(ladder_images.len(), 3);
        let og_singular = pollster::block_on(
            renderer.render_image_request(FIXTURE, r#"{"format":"png","width":256,"height":256}"#),
        )
        .expect("og singular");
        let hero_singular = pollster::block_on(renderer.render_image_request(
            FIXTURE,
            r#"{"format":"webp","quality":0.9,"width":256,"height":256}"#,
        ))
        .expect("hero singular");
        assert_eq!(ladder_images[0], cold);
        assert_eq!(ladder_images[1], og_singular);
        assert_eq!(ladder_images[2], hero_singular);
        assert_eq!(&ladder_images[2][..4], b"RIFF");

        // `format: "raw"` is the same pathway with the encoder replaced by a
        // copy: its bytes are exactly the pixels a lossless encoder compresses.
        let raw = pollster::block_on(
            renderer.render_image_request(FIXTURE, r#"{"format":"raw","width":192,"height":192}"#),
        )
        .expect("raw");
        assert_eq!(raw.len(), 192 * 192 * 4);
        let lossless = pollster::block_on(renderer.render_image_request(
            FIXTURE,
            r#"{"format":"webp","quality":1,"width":192,"height":192}"#,
        ))
        .expect("lossless webp");
        let mut decoder =
            image_webp::WebPDecoder::new(std::io::Cursor::new(&lossless)).expect("decoder");
        assert_eq!(decoder.dimensions(), (192, 192));
        let mut decoded = vec![0u8; decoder.output_buffer_size().expect("size")];
        decoder.read_image(&mut decoded).expect("decode");
        assert_eq!(decoded, raw);
        // A mixed plan carries both kinds in one crossing, and the raw entry
        // matches the singular raw call byte for byte.
        let (mixed, _) = pollster::block_on(renderer.render_images_request(
            FIXTURE,
            r#"{"format":"webp","quality":1,"width":192,"height":192,"views":[{"id":"thumb"},{"id":"frame","format":"raw"}]}"#,
            None,
        ))
        .expect("mixed plan");
        assert_eq!(&mixed[0][..4], b"RIFF");
        assert_eq!(mixed[0], lossless);
        assert_eq!(mixed[1], raw);

        // A caller-supplied clock takes precedence over the native fallback,
        // on both the warm-renderer and one-shot request paths.
        let host_clock = || 42.0;
        let timed_request =
            r#"{"format":"png","width":192,"height":192,"timings":true,"views":[{"id":"front"}]}"#;
        let (_, hosted) = pollster::block_on(renderer.render_images_request(
            FIXTURE,
            timed_request,
            Some(&host_clock),
        ))
        .expect("hosted clock timings");
        assert_eq!(hosted.expect("timings").parse, 0.0);
        let (_, free_hosted) = pollster::block_on(render_images_request(
            FIXTURE,
            timed_request,
            Some(&host_clock),
        ))
        .expect("free hosted clock timings");
        assert_eq!(free_hosted.expect("timings").parse, 0.0);
        // Without a host clock, native self-clocks via Instant.
        let (_, fallback) = pollster::block_on(render_images_request(FIXTURE, timed_request, None))
            .expect("fallback clock timings");
        assert!(fallback.expect("timings").views[0].encode >= 0.0);

        // The typed warm entry rejects an empty plan before any GPU work.
        assert!(
            pollster::block_on(renderer.render_images(
                FIXTURE,
                &RenderOptions::default(),
                ImageFormat::Png,
                &[],
                None,
            ))
            .is_err()
        );

        renderer.destroy();
    }
}
