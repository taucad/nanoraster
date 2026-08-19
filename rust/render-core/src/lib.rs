//! GLB → image transcoder core: parses kernel-written GLB scenes and renders
//! them with wgpu (metallic-roughness surfaces + line edges) into RGBA/PNG
//! bytes, with no surface/canvas — works headless on native
//! (Metal/Vulkan/DX12) and in the browser via WebGPU.

mod bench;
mod capture_overlay;
mod encode;
mod glb;
mod options;
mod render;

use glb::parse_glb;

pub use bench::{bench_encodes, bench_multi_view, codec_conformance};
pub use encode::{ImageFormat, encode, encode_jpeg, encode_png, encode_webp};
pub use options::{
    LightRequest, LightingRequest, LightingRigRequest, RenderImagesRequest, RenderRequest,
    RenderView,
};
pub use render::Rendered;

/// World axis the camera treats as "up" when placing the spherical eye and
/// fitting the view. Kernel-exported GLBs are standard Y-up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UpAxis {
    X,
    #[default]
    Y,
    Z,
}

/// Camera projection used for the encoded image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Projection {
    #[default]
    Perspective,
    Orthographic,
}

/// Frame a rig's light directions are authored in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LightingSpace {
    /// Camera-relative, so every view of a batch is lit identically.
    #[default]
    View,
    /// glTF world coordinates (regardless of `up`), rotated into view space
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

/// Rendering options. Camera angles use a right-handed spherical basis.
#[derive(Debug, Clone)]
pub struct RenderOptions {
    pub width: u32,
    pub height: u32,
    /// Polar angle from the up axis, degrees.
    pub phi_deg: f32,
    /// Right-handed azimuth around the selected up axis, degrees.
    pub theta_deg: f32,
    /// Corner-fit zoom padding (0.9 = 10% margin).
    pub padding_factor: f32,
    /// Edge line width in pixels at the default 432 px output height; scales
    /// linearly with height so edges keep the same weight at any size.
    pub line_width: f32,
    /// World up axis for camera placement and view fitting.
    pub up: UpAxis,
    /// Perspective for ordinary thumbnails, orthographic for canonical views.
    pub projection: Projection,
    /// Background clear color as sRGB straight-alpha `[r, g, b, a]` in 0..=1;
    /// `None` renders on transparent. JPEG output requires an opaque one.
    pub background: Option<[f32; 4]>,
    /// Optional authored view label. It is drawn only when `include_label` is true.
    pub label: Option<String>,
    /// Whether to stamp the bottom-right XYZ orientation indicator.
    pub include_axes: bool,
    /// Whether to stamp the top-left view label.
    pub include_label: bool,
    /// Whether to stamp the bottom-left scale. Perspective labels identify
    /// the subject-center plane with `@ center`; orthographic scale is
    /// depth-invariant.
    pub include_scale: bool,
    /// Direct lights, ambient, environment and exposure. Defaults to
    /// [`ResolvedLighting::studio`].
    pub lighting: ResolvedLighting,
}

pub(crate) const DEFAULT_HEIGHT: u32 = 432;

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            width: 768,
            height: DEFAULT_HEIGHT,
            phi_deg: 60.0,
            theta_deg: -45.0,
            padding_factor: 0.9,
            line_width: 2.0,
            up: UpAxis::Y,
            projection: Projection::Perspective,
            background: None,
            label: None,
            include_axes: false,
            include_label: false,
            include_scale: false,
            lighting: ResolvedLighting::studio(),
        }
    }
}

/// Failure taxonomy — the string prefixes are the stable contract surfaced to
/// the TS façade (`adapter-unavailable`, `gpu`, `parse`, `encode`).
#[derive(Debug)]
pub enum RenderError {
    Parse(String),
    AdapterUnavailable(String),
    Gpu(String),
    Encode(String),
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(m) => write!(f, "parse: {m}"),
            Self::AdapterUnavailable(m) => write!(f, "adapter-unavailable: {m}"),
            Self::Gpu(m) => write!(f, "gpu: {m}"),
            Self::Encode(m) => write!(f, "encode: {m}"),
        }
    }
}

impl std::error::Error for RenderError {}

/// Per-view timings recorded by the benchmark path.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderViewProfile {
    pub id: String,
    pub render_ms: f64,
    pub overlay_ms: f64,
    pub encode_ms: f64,
}

/// Batch setup/resource evidence recorded without changing the render path.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderBatchProfile {
    pub parse_ms: f64,
    pub setup_ms: f64,
    pub peak_readback_bytes: u64,
    pub glb_parses: u32,
    pub adapter_device_requests: u32,
    pub pipeline_sets: u32,
    pub scene_uploads: u32,
    pub target_allocations: u32,
    pub views: Vec<RenderViewProfile>,
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
    if (options.include_axes || options.include_label || options.include_scale)
        && (options.width < options::ANNOTATED_MIN_DIMENSION
            || options.height < options::ANNOTATED_MIN_DIMENSION)
    {
        return Err(RenderError::Parse(format!(
            "annotated images must be at least {}x{}",
            options::ANNOTATED_MIN_DIMENSION,
            options::ANNOTATED_MIN_DIMENSION
        )));
    }
    if !options.phi_deg.is_finite() || !options.theta_deg.is_finite() {
        return Err(RenderError::Parse("camera angles must be finite".into()));
    }
    Ok(())
}

fn with_view(error: RenderError, id: &str) -> RenderError {
    if id.is_empty() {
        return error;
    }
    let context = |message: String| format!("view {id:?}: {message}");
    match error {
        RenderError::Parse(message) => RenderError::Parse(context(message)),
        RenderError::AdapterUnavailable(message) => {
            RenderError::AdapterUnavailable(context(message))
        }
        RenderError::Gpu(message) => RenderError::Gpu(context(message)),
        RenderError::Encode(message) => RenderError::Encode(context(message)),
    }
}

fn with_view_result<T>(result: Result<T, RenderError>, id: &str) -> Result<T, RenderError> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => Err(with_view(error, id)),
    }
}

/// Render a kernel GLB to straight-alpha RGBA8 (sRGB-encoded) pixels.
pub async fn render_glb_to_rgba(
    glb: &[u8],
    options: &RenderOptions,
) -> Result<Rendered, RenderError> {
    validate_options(options)?;
    let scene = parse_glb(glb).map_err(RenderError::Parse)?;
    let prepared = capture_overlay::prepare_view(&scene, options)?;
    let session = render::RenderSession::new(&scene, options).await?;
    let mut rendered = session.render_view(prepared.camera, options).await?;
    if options.include_axes || options.include_label || options.include_scale {
        capture_overlay::stamp_capture_overlay(&mut rendered, &prepared, &mut Vec::new());
    }
    Ok(rendered)
}

/// Render a kernel GLB straight to encoded image bytes.
pub async fn render_glb_to_image(
    glb: &[u8],
    options: &RenderOptions,
    format: ImageFormat,
) -> Result<Vec<u8>, RenderError> {
    let view = RenderView {
        id: String::new(),
        label: options.label.clone(),
        phi_deg: options.phi_deg,
        theta_deg: options.theta_deg,
    };
    let mut images = render_glb_to_images(glb, options, format, &[view]).await?;
    Ok(images.remove(0))
}

/// Render ordered views while parsing and uploading the GLB only once.
pub async fn render_glb_to_images(
    glb: &[u8],
    options: &RenderOptions,
    format: ImageFormat,
    views: &[RenderView],
) -> Result<Vec<Vec<u8>>, RenderError> {
    render_glb_to_images_inner(glb, options, format, views, None)
        .await
        .map(|(images, _)| images)
}

/// Benchmark entry using the production batch path plus a caller-provided clock.
pub async fn render_glb_to_images_profiled(
    glb: &[u8],
    options: &RenderOptions,
    format: ImageFormat,
    views: &[RenderView],
    now: &dyn Fn() -> f64,
) -> Result<(Vec<Vec<u8>>, RenderBatchProfile), RenderError> {
    let (images, profile) =
        render_glb_to_images_inner(glb, options, format, views, Some(now)).await?;
    Ok((images, profile.expect("profile requested")))
}

async fn render_glb_to_images_inner(
    glb: &[u8],
    options: &RenderOptions,
    format: ImageFormat,
    views: &[RenderView],
    now: Option<&dyn Fn() -> f64>,
) -> Result<(Vec<Vec<u8>>, Option<RenderBatchProfile>), RenderError> {
    validate_options(options)?;
    if views.is_empty() {
        return Err(RenderError::Parse(
            "views must contain at least one view".into(),
        ));
    }
    let parse_started = now.map_or(0.0, |clock| clock());
    let scene = parse_glb(glb).map_err(RenderError::Parse)?;
    let parse_ms = now.map_or(0.0, |clock| clock() - parse_started);
    let setup_started = now.map_or(0.0, |clock| clock());
    let mut prepared = Vec::with_capacity(views.len());
    for view in views {
        let mut view_options = options.clone();
        view_options.phi_deg = view.phi_deg;
        view_options.theta_deg = view.theta_deg;
        view_options.label.clone_from(&view.label);
        with_view_result(validate_options(&view_options), &view.id)?;
        prepared.push(with_view_result(
            capture_overlay::prepare_view(&scene, &view_options),
            &view.id,
        )?);
    }
    let session = render::RenderSession::new(&scene, options).await?;
    let setup_ms = now.map_or(0.0, |clock| clock() - setup_started);
    let mut images = Vec::with_capacity(views.len());
    let mut overlay_scratch = Vec::new();
    let mut view_profiles = Vec::with_capacity(if now.is_some() { views.len() } else { 0 });
    for (view, prepared_view) in views.iter().zip(prepared) {
        let mut view_options = options.clone();
        view_options.phi_deg = view.phi_deg;
        view_options.theta_deg = view.theta_deg;
        view_options.label.clone_from(&view.label);
        let render_started = now.map_or(0.0, |clock| clock());
        let rendered = session
            .render_view(prepared_view.camera, &view_options)
            .await;
        let mut rendered = with_view_result(rendered, &view.id)?;
        let render_ms = now.map_or(0.0, |clock| clock() - render_started);
        let overlay_started = now.map_or(0.0, |clock| clock());
        if view_options.include_axes || view_options.include_label || view_options.include_scale {
            capture_overlay::stamp_capture_overlay(
                &mut rendered,
                &prepared_view,
                &mut overlay_scratch,
            );
        }
        let overlay_ms = now.map_or(0.0, |clock| clock() - overlay_started);
        let encode_started = now.map_or(0.0, |clock| clock());
        images.push(with_view_result(encode(&rendered, format), &view.id)?);
        if let Some(clock) = now {
            view_profiles.push(RenderViewProfile {
                id: view.id.clone(),
                render_ms,
                overlay_ms,
                encode_ms: clock() - encode_started,
            });
        }
    }
    let profile = now.map(|_| RenderBatchProfile {
        parse_ms,
        setup_ms,
        peak_readback_bytes: u64::from(options.width) * u64::from(options.height) * 4,
        glb_parses: 1,
        adapter_device_requests: 1,
        pipeline_sets: 1,
        scene_uploads: 1,
        target_allocations: 1,
        views: view_profiles,
    });
    Ok((images, profile))
}

/// One-call surface for the wasm/napi bindings: parse the TS façade's JSON
/// render request (see [`RenderRequest`]), render, encode.
pub async fn render_glb_request(glb: &[u8], options_json: &str) -> Result<Vec<u8>, RenderError> {
    let (options, format) = RenderRequest::from_json(options_json)?.resolve()?;
    render_glb_to_image(glb, &options, format).await
}

/// Binding surface for an ordered plural request.
pub async fn render_glb_images_request(
    glb: &[u8],
    options_json: &str,
) -> Result<Vec<Vec<u8>>, RenderError> {
    let (options, format, views) = RenderImagesRequest::from_json(options_json)?.resolve()?;
    render_glb_to_images(glb, &options, format, &views).await
}

/// Report the adapter wgpu selects (backend + device name) — used by spike
/// harnesses and CI to assert the expected backend (Metal/lavapipe/WARP).
pub async fn describe_adapter() -> Result<String, RenderError> {
    let adapter = render::request_adapter().await?;
    let info = adapter.get_info();
    Ok(format!(
        "{:?} / {} ({:?})",
        info.backend, info.name, info.device_type
    ))
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::cell::Cell;

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

    #[test]
    fn public_defaults_are_locked() {
        let options = RenderOptions::default();
        assert_eq!(options.width, 768);
        assert_eq!(options.height, 432);
        assert_eq!(options.phi_deg, 60.0);
        assert_eq!(options.theta_deg, -45.0);
        assert_eq!(options.padding_factor, 0.9);
        assert_eq!(options.line_width, 2.0);
        assert_eq!(options.up, UpAxis::Y);
        assert_eq!(options.projection, Projection::Perspective);
        assert_eq!(options.background, None);
        assert_eq!(options.label, None);
        assert!(!options.include_axes);
        assert!(!options.include_label);
        assert!(!options.include_scale);
        assert_eq!(options.lighting, ResolvedLighting::studio());
        assert_eq!(ResolvedLighting::default(), ResolvedLighting::studio());
        assert_eq!(options.lighting.lights.len(), 3);
        assert_eq!(options.lighting.ambient, 0.02);
        assert_eq!(options.lighting.exposure, 1.0);
        assert!(options.lighting.environment);
        assert_eq!(options.lighting.space, LightingSpace::View);
        assert_eq!(LightingSpace::default(), LightingSpace::View);
        assert_eq!(UpAxis::default(), UpAxis::Y);
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
                include_axes: true,
                ..Default::default()
            },
            RenderOptions {
                height: 191,
                include_scale: true,
                ..Default::default()
            },
            RenderOptions {
                phi_deg: f32::NAN,
                ..Default::default()
            },
            RenderOptions {
                theta_deg: f32::INFINITY,
                ..Default::default()
            },
        ];
        for options in invalid {
            assert!(validate_options(&options).is_err());
        }
        assert!(validate_options(&RenderOptions::default()).is_ok());
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
    fn public_requests_reject_before_gpu_work() {
        let invalid_options = RenderOptions {
            width: 1,
            ..Default::default()
        };
        assert!(pollster::block_on(render_glb_to_rgba(FIXTURE, &invalid_options)).is_err());
        assert!(pollster::block_on(render_glb_to_rgba(b"bad", &RenderOptions::default())).is_err());
        assert!(
            pollster::block_on(render_glb_to_rgba(
                FIXTURE,
                &RenderOptions {
                    include_label: true,
                    ..Default::default()
                }
            ))
            .is_err()
        );
        assert!(
            pollster::block_on(render_glb_to_image(
                b"bad",
                &RenderOptions::default(),
                ImageFormat::Png,
            ))
            .is_err()
        );
        assert!(
            pollster::block_on(render_glb_to_images(
                FIXTURE,
                &RenderOptions::default(),
                ImageFormat::Png,
                &[],
            ))
            .is_err()
        );
        assert!(
            pollster::block_on(render_glb_to_images_profiled(
                b"bad",
                &RenderOptions::default(),
                ImageFormat::Png,
                &[RenderView {
                    id: "front".into(),
                    label: None,
                    phi_deg: 90.0,
                    theta_deg: 0.0,
                }],
                &|| 0.0,
            ))
            .is_err()
        );
        assert!(pollster::block_on(render_glb_request(FIXTURE, "{")).is_err());
        assert!(pollster::block_on(render_glb_request(FIXTURE, r#"{"width":1}"#)).is_err());
        assert!(pollster::block_on(render_glb_images_request(FIXTURE, "{}")).is_err());
        assert!(
            pollster::block_on(render_glb_images_request(
                FIXTURE,
                r#"{"views":[{"id":"x","phi":null,"theta":0}]}"#
            ))
            .is_err()
        );

        let view = RenderView {
            id: "bad".into(),
            label: None,
            phi_deg: 90.0,
            theta_deg: 0.0,
        };
        assert!(
            pollster::block_on(render_glb_to_images(
                FIXTURE,
                &invalid_options,
                ImageFormat::Png,
                std::slice::from_ref(&view),
            ))
            .is_err()
        );
        assert!(
            pollster::block_on(render_glb_to_images(
                FIXTURE,
                &RenderOptions::default(),
                ImageFormat::Png,
                &[RenderView {
                    phi_deg: f32::NAN,
                    ..view.clone()
                }],
            ))
            .is_err()
        );
        assert!(
            pollster::block_on(render_glb_to_images(
                FIXTURE,
                &RenderOptions {
                    include_label: true,
                    ..Default::default()
                },
                ImageFormat::Png,
                std::slice::from_ref(&view),
            ))
            .is_err()
        );
    }

    #[test]
    fn gpu_public_surface_renders_and_profiles() {
        let options = RenderOptions {
            width: 192,
            height: 192,
            background: Some([1.0, 1.0, 1.0, 1.0]),
            label: Some("Front".into()),
            include_axes: true,
            include_label: true,
            include_scale: true,
            ..Default::default()
        };
        let views = [RenderView {
            id: "front".into(),
            label: Some("Front".into()),
            phi_deg: 90.0,
            theta_deg: 0.0,
        }];

        let rendered =
            pollster::block_on(render_glb_to_rgba(FIXTURE, &options)).expect("RGBA render");
        assert_eq!(rendered.width, 192);
        assert_eq!(rendered.height, 192);
        let material_options = RenderOptions {
            width: 192,
            height: 192,
            ..Default::default()
        };
        let baseline = pollster::block_on(render_glb_to_rgba(FIXTURE, &material_options))
            .expect("baseline material");
        let polished_metal = pollster::block_on(render_glb_to_rgba(
            &material_variant(1.0, 0.05),
            &material_options,
        ))
        .expect("polished metal material");
        let polished_metal_repeat = pollster::block_on(render_glb_to_rgba(
            &material_variant(1.0, 0.05),
            &material_options,
        ))
        .expect("repeated polished metal material");
        assert_ne!(baseline.rgba, polished_metal.rgba);
        assert_eq!(polished_metal.rgba, polished_metal_repeat.rgba);

        let png = pollster::block_on(render_glb_to_image(FIXTURE, &options, ImageFormat::Png))
            .expect("PNG render");
        assert_eq!(&png[..4], &[0x89, 0x50, 0x4e, 0x47]);

        let images = pollster::block_on(render_glb_to_images(
            FIXTURE,
            &options,
            ImageFormat::WebP,
            &views,
        ))
        .expect("batch render");
        assert_eq!(&images[0][..4], b"RIFF");

        let tick = Cell::new(0.0);
        let clock = || {
            tick.set(tick.get() + 1.0);
            tick.get()
        };
        let (_, profile) = pollster::block_on(render_glb_to_images_profiled(
            FIXTURE,
            &options,
            ImageFormat::Png,
            &views,
            &clock,
        ))
        .expect("profiled render");
        assert_eq!(profile.glb_parses, 1);
        assert_eq!(profile.views[0].id, "front");
        assert!(profile.views[0].encode_ms > 0.0);

        let request = r#"{"format":"png","width":192,"height":192,"background":[1,1,1,1]}"#;
        assert!(pollster::block_on(render_glb_request(FIXTURE, request)).is_ok());
        let plural = r#"{"format":"png","width":192,"height":192,"background":[1,1,1,1],"views":[{"id":"front","phi":90,"theta":0}]}"#;
        assert!(pollster::block_on(render_glb_images_request(FIXTURE, plural)).is_ok());
        assert!(
            pollster::block_on(describe_adapter())
                .expect("adapter description")
                .contains('/')
        );

        let benchmark = pollster::block_on(bench_multi_view(FIXTURE, 192, 192, &clock))
            .expect("multi-view benchmark");
        assert_eq!(benchmark["variants"].as_array().map(Vec::len), Some(8));
    }
}
