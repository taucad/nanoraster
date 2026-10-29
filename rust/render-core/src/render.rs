//! Surface-less wgpu render path: adapter with `compatible_surface: None`,
//! 4x MSAA into an sRGB resolve texture, `copy_texture_to_buffer` readback
//! with 256-byte row alignment. No canvas anywhere — the same code runs on
//! native backends and browser WebGPU.
//!
//! State crosses the boundary as handles; work crosses as plans. [`Renderer`]
//! owns everything whose lifetime is "the process/worker" (device, queue,
//! shader, layouts, pipeline and target caches); [`Scene`] owns one GLB's
//! parsed geometry plus its GPU buffers; [`Renderer::execute_plan`] is the one
//! render loop every public entry point funnels through.

use crate::encode::{ImageFormat, encode_owned};
use crate::glb::{self, MODE_TRIANGLES, Material};
use crate::{
    CameraProjection, LightingSpace, MAX_LIGHTS, MAX_SECTION_PLANES, Projection, RenderCamera,
    RenderError, RenderOptions, with_view_result,
};
use glam::{Mat4, Vec3};
use std::fmt::Display;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;

const MSAA_SAMPLES: u32 = 4;
// Native backends treat this as a hint; browser descriptors are validated once
// per initialized device before any production targets use the optional flag.
const TRANSIENT_ATTACHMENT_USAGE: wgpu::TextureUsages =
    wgpu::TextureUsages::RENDER_ATTACHMENT.union(wgpu::TextureUsages::TRANSIENT_ATTACHMENT);

async fn pass_local_attachment_usage(device: &wgpu::Device) -> wgpu::TextureUsages {
    #[cfg(target_arch = "wasm32")]
    {
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        for (format, sample_count) in [
            (COLOR_FORMAT, MSAA_SAMPLES),
            (HDR_FORMAT, MSAA_SAMPLES),
            (DEPTH_FORMAT, 1),
        ] {
            device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some("transient capability probe"),
                    size: wgpu::Extent3d {
                        width: 4,
                        height: 4,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: TRANSIENT_ATTACHMENT_USAGE,
                    view_formats: &[],
                })
                .destroy();
        }
        if scope.pop().await.is_some() {
            return wgpu::TextureUsages::RENDER_ATTACHMENT;
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = device;
    TRANSIENT_ATTACHMENT_USAGE
}
const HDR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const COLOR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
/// Depth-bias slope scale bakes the stroke width into each mesh pipeline, so
/// the cache keys on `line_width_px` bits; mixed-height plans stay small and
/// this bound keeps a long-lived renderer from accumulating one pair per size
/// it has ever seen.
const MAX_CACHED_PIPELINE_PAIRS: usize = 16;
/// Retention budget for [`Renderer::trim_targets`], in pixels (2048²). Above
/// it a target set is worth tens of megabytes, which the one-shot façade's
/// process-lifetime renderer must not pin after the render that needed it.
const MAX_RETAINED_TARGET_PIXELS: u64 = 2048 * 2048;

pub struct Rendered {
    /// Straight-alpha, sRGB-encoded RGBA8 rows, tightly packed.
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy)]
pub(crate) struct CameraState {
    pub(crate) projection: Mat4,
    pub(crate) view: Mat4,
    pub(crate) forward: Vec3,
    pub(crate) target_depth: f32,
}

struct GpuMesh {
    source_primitive_index: usize,
    positions: wgpu::Buffer,
    normals: wgpu::Buffer,
    surface_attributes: wgpu::Buffer,
    transparent: bool,
    transmission: bool,
    constant_attributes: bool,
    alpha_blend: bool,
    center: Vec3,
    indices: wgpu::Buffer,
    index_count: u32,
    bind_group: wgpu::BindGroup,
}

struct GpuLines {
    source_primitive_index: usize,
    segments: wgpu::Buffer,
    segment_count: u32,
    bind_group: wgpu::BindGroup,
}

struct GpuMeshAsset {
    source_mesh_index: usize,
    surfaces: Vec<GpuMesh>,
    lines: Vec<GpuLines>,
}

struct GpuInstance {
    model: Mat4,
    source_node_index: usize,
    mesh_index: usize,
    bind_group: wgpu::BindGroup,
}

/// One GLB's geometry uploaded to one renderer's device.
pub(crate) struct SceneBuffers {
    gpu_assets: Vec<GpuMeshAsset>,
    gpu_instances: Vec<GpuInstance>,
    texture_pixels: wgpu::Buffer,
    features: ShaderFeatures,
}

#[derive(Clone, Copy, Default)]
struct ShaderFeatures {
    texture_mask: u32,
    clearcoat: bool,
    anisotropy_sheen: bool,
}

/// Scene handle: parsed CPU geometry plus its GPU buffers. The parsed half is
/// retained so device loss can transparently re-upload — the buffers carry the
/// device generation they were uploaded under and go stale when the renderer
/// recreates its device. Internal seam by design; exposure is trigger-gated.
pub(crate) struct Scene {
    pub(crate) parsed: glb::Scene,
    buffers: Option<(u64, SceneBuffers)>,
}

impl Scene {
    pub(crate) fn new(parsed: glb::Scene) -> Self {
        Self {
            parsed,
            buffers: None,
        }
    }
}

struct PipelinePair {
    mesh: wgpu::RenderPipeline,
    blend_mesh: wgpu::RenderPipeline,
    constant_mesh: wgpu::RenderPipeline,
    constant_blend_mesh: wgpu::RenderPipeline,
    screen: wgpu::RenderPipeline,
    mip: wgpu::RenderPipeline,
    cap: wgpu::RenderPipeline,
    line: wgpu::RenderPipeline,
    transmission_line: wgpu::RenderPipeline,
}

struct AoPipelines {
    texture_mask: u32,
    depth_mesh: wgpu::RenderPipeline,
    depth_constant_mesh: wgpu::RenderPipeline,
    estimate: wgpu::RenderPipeline,
    /// Full-resolution stochastic denoise, first and second pass.
    blur: [wgpu::RenderPipeline; 2],
    /// Half-resolution separable denoise, horizontal and vertical pass.
    separable_blur: [wgpu::RenderPipeline; 2],
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    blue_noise: wgpu::TextureView,
    frame_buffer: wgpu::Buffer,
}

struct AoTargets {
    depth_view: wgpu::TextureView,
    test_depth_view: wgpu::TextureView,
    estimate_view: wgpu::TextureView,
    blur_view: wgpu::TextureView,
}

struct GpuCap {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    index_count: u32,
}

/// World-space fat-line segments drawn in one flat colour.
struct GpuStroke {
    segments: wgpu::Buffer,
    count: u32,
    material: wgpu::BindGroup,
}

pub(crate) struct PresentationBuffers {
    cap: Option<GpuCap>,
    /// Cap outlines, in black.
    boundary: Option<GpuStroke>,
    /// Open cut chains of uncertified sources, in the open-chain colour.
    open_chains: Option<GpuStroke>,
    identity_object: Option<wgpu::BindGroup>,
    /// Per plane and source section outcome, reported through timings.
    pub(crate) sections: Vec<crate::section::SectionSourceReport>,
}

/// Render targets for one output size. A second readback buffer is acquired
/// only when the executor overlaps two views of this target set.
#[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
#[path = "profile.rs"]
mod profile;

struct SizedTargets {
    width: u32,
    height: u32,
    extent: wgpu::Extent3d,
    msaa_view: wgpu::TextureView,
    hdr_msaa: wgpu::TextureView,
    opaque_view: wgpu::TextureView,
    opaque_levels: Vec<wgpu::TextureView>,
    opaque_mips: wgpu::TextureView,
    transmission: bool,
    ao: Option<AoTargets>,
    composite_view: Option<wgpu::TextureView>,
    depth_view: wgpu::TextureView,
    resolve_texture: wgpu::Texture,
    resolve_view: wgpu::TextureView,
    readback: Vec<Arc<Readback>>,
    unpadded_bytes_per_row: u32,
    padded_bytes_per_row: u32,
}

// wgpu's WebGPU backend frees nothing on drop, so a retired target set would
// hold its GPU memory until the JS garbage collector runs: about 100 MB at
// 1276x798 with MSAA, HDR, transmission mips and AO. Browsers with a fixed GPU
// budget then fail a later allocation, surfacing as a rejected `map_async` on
// a live device. Destroying is safe for work already submitted.
impl Drop for SizedTargets {
    fn drop(&mut self) {
        let mut views = vec![
            &self.msaa_view,
            &self.hdr_msaa,
            &self.opaque_view,
            &self.opaque_mips,
            &self.depth_view,
            &self.resolve_view,
        ];
        if let Some(composite) = &self.composite_view {
            views.push(composite);
        }
        if let Some(ao) = &self.ao {
            views.extend([
                &ao.depth_view,
                &ao.test_depth_view,
                &ao.estimate_view,
                &ao.blur_view,
            ]);
        }
        for view in views {
            view.texture().destroy();
        }
    }
}

/// A readback buffer shared by its target set and any view still reading it
/// back, destroyed when the last of them lets go (see `SizedTargets`' drop).
struct Readback(wgpu::Buffer);

impl std::ops::Deref for Readback {
    type Target = wgpu::Buffer;

    fn deref(&self) -> &wgpu::Buffer {
        &self.0
    }
}

impl Readback {
    fn new(device: &wgpu::Device, size: u64) -> Self {
        Self(device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        }))
    }
}

fn validate_target_extent(
    width: u32,
    height: u32,
    limits: &wgpu::Limits,
) -> Result<(), RenderError> {
    if width > limits.max_texture_dimension_2d || height > limits.max_texture_dimension_2d {
        return Err(RenderError::Gpu(format!(
            "requested {width}x{height} exceeds device maxTextureDimension2D {}",
            limits.max_texture_dimension_2d
        )));
    }
    let readback = u64::from(width).div_ceil(64) * 256 * u64::from(height);
    if readback > limits.max_buffer_size {
        return Err(RenderError::Gpu(format!(
            "requested readback {readback} bytes exceeds device maxBufferSize {}",
            limits.max_buffer_size
        )));
    }
    Ok(())
}

fn hdr_multisample_target(
    device: &wgpu::Device,
    size: wgpu::Extent3d,
    transparency: bool,
    pass_local_usage: wgpu::TextureUsages,
) -> wgpu::TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some("HDR multisample"),
            size,
            mip_level_count: 1,
            sample_count: MSAA_SAMPLES,
            dimension: wgpu::TextureDimension::D2,
            format: HDR_FORMAT,
            // Transparent rendering loads the opaque samples in a later pass.
            usage: if transparency {
                wgpu::TextureUsages::RENDER_ATTACHMENT
            } else {
                pass_local_usage
            },
            view_formats: &[],
        })
        .create_view(&wgpu::TextureViewDescriptor::default())
}

fn composite_target(device: &wgpu::Device, size: wgpu::Extent3d) -> wgpu::TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some("composite HDR"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: HDR_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
        .create_view(&wgpu::TextureViewDescriptor::default())
}

impl SizedTargets {
    // A view retains its buffer until mapping and CPU consumption finish, even
    // after resize retires its target set. Never copy into an in-flight buffer.
    #[cfg_attr(target_arch = "wasm32", allow(clippy::arc_with_non_send_sync))]
    fn acquire_readback(&mut self, device: &wgpu::Device) -> usize {
        if let Some(index) = self
            .readback
            .iter()
            .position(|buffer| Arc::strong_count(buffer) == 1)
        {
            return index;
        }
        let index = self.readback.len();
        self.readback.push(Arc::new(Readback::new(
            device,
            u64::from(self.padded_bytes_per_row) * u64::from(self.height),
        )));
        index
    }
}

impl Drop for Readback {
    fn drop(&mut self) {
        self.0.destroy();
    }
}

/// One submitted view awaiting readback. Owns clones of the wgpu handles it
/// needs so target-cache turnover cannot invalidate it.
struct InFlightView {
    #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
    probe: Option<profile::Probe>,
    buffer: Arc<Readback>,
    receiver: futures_channel::oneshot::Receiver<Result<(), wgpu::BufferAsyncError>>,
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    submission: wgpu::SubmissionIndex,
    height: u32,
    unpadded_bytes_per_row: u32,
    padded_bytes_per_row: u32,
    opaque_background: bool,
}

/// Cumulative resource-acquisition counters; timings reporting snapshots them
/// around a plan to attribute work to that call.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Counters {
    pub(crate) device_requests: u32,
    pub(crate) pipeline_sets: u32,
    pub(crate) presentation_builds: u32,
    pub(crate) scene_uploads: u32,
    pub(crate) target_allocations: u32,
}

impl Counters {
    pub(crate) fn since(self, start: Self) -> Self {
        Self {
            device_requests: self.device_requests - start.device_requests,
            pipeline_sets: self.pipeline_sets - start.pipeline_sets,
            presentation_builds: self.presentation_builds - start.presentation_builds,
            scene_uploads: self.scene_uploads - start.scene_uploads,
            target_allocations: self.target_allocations - start.target_allocations,
        }
    }
}

/// Everything scoped to one `wgpu::Device`, rebuilt wholesale on device loss.
struct DeviceState {
    specialize_anisotropy_sheen: bool,
    device: wgpu::Device,
    queue: wgpu::Queue,
    pass_local_usage: wgpu::TextureUsages,
    shader: wgpu::ShaderModule,
    frame_buffer: wgpu::Buffer,
    frame_bind_group: wgpu::BindGroup,
    prim_layout: wgpu::BindGroupLayout,
    scene_layout: wgpu::BindGroupLayout,
    scene_sampler: wgpu::Sampler,
    empty_scene: wgpu::TextureView,
    empty_ao: wgpu::TextureView,
    default_material: wgpu::BindGroup,
    identity_object: wgpu::BindGroup,
    object_layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
    /// Keyed on `line_width_px` bits and whether wireframe bias is needed.
    pipelines: Vec<(u64, PipelinePair)>,
    ao_pipelines: Option<AoPipelines>,
    /// Last-used target set, keyed on (width, height).
    targets: Option<SizedTargets>,
}

/// Persistent GPU half: one adapter/device/pipeline set reused across calls.
pub struct Renderer {
    #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
    profile: std::cell::RefCell<Vec<serde_json::Value>>,
    state: DeviceState,
    lost: Arc<AtomicBool>,
    uncaptured: Arc<Mutex<Option<String>>>,
    power: wgpu::PowerPreference,
    generation: u64,
    counters: Counters,
}

/// One fully resolved plan entry: per-view options (R15 output overrides
/// already applied), the per-view encode format, and the prepared camera and
/// overlay layout.
pub(crate) struct PlanEntry {
    pub(crate) id: String,
    pub(crate) options: RenderOptions,
    pub(crate) format: ImageFormat,
    pub(crate) prepared: crate::capture_overlay::PreparedView,
}

/// Per-view stage timings produced by the plan executor (zero when no clock).
#[derive(Clone, Copy, Default)]
pub(crate) struct ViewTimings {
    /// Milliseconds. GPU render, resolve, and pixel readback for this view.
    pub(crate) render: f64,
    /// Milliseconds. Annotation stamping (zero when nothing is stamped).
    pub(crate) overlay: f64,
    /// Milliseconds. Image encoding in this view's format.
    pub(crate) encode: f64,
}

/// An explicit destroy() is the caller's own teardown, not a loss.
fn note_device_lost(
    lost: &AtomicBool,
    captured: &Mutex<Option<String>>,
    reason: wgpu::DeviceLostReason,
    message: &str,
) {
    if !matches!(reason, wgpu::DeviceLostReason::Destroyed) {
        captured
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_or_insert_with(|| format!("device lost ({reason:?}): {message}"));
        lost.store(true, Ordering::Release);
    }
}

/// What glibc hands a default-attribute thread through `RLIMIT_STACK`, and the
/// size [`raise_default_thread_stack`] gives musl's process-wide default. Also
/// musl's own ceiling for that default, which clamps anything larger.
#[cfg(all(target_os = "linux", target_env = "musl"))]
const DRIVER_THREAD_STACK_BYTES: usize = 8 * 1024 * 1024;

#[cfg(all(target_os = "linux", target_env = "musl"))]
unsafe extern "C" {
    // musl 1.1.21 and later. The libc crate declares neither for musl targets,
    // so both are named here rather than imported.
    fn pthread_getattr_default_np(attr: *mut libc::pthread_attr_t) -> libc::c_int;
    fn pthread_setattr_default_np(attr: *const libc::pthread_attr_t) -> libc::c_int;
}

/// Raise musl's process-wide default thread stack to
/// [`DRIVER_THREAD_STACK_BYTES`], never shrinking a larger default. Reports
/// whether the default moved.
///
/// musl gives a default-attribute thread 128 KiB where glibc gives it
/// `RLIMIT_STACK`, and mesa's `u_thread_create` passes no attributes at all, so
/// lavapipe's `util_queue` worker — the thread that JIT-compiles a shader
/// variant on first draw — inherits that 128 KiB. LLVM 22's AArch64
/// `AsmPrinter::doFinalization` overruns it and the host process dies with
/// SIGSEGV mid-render (Alpine 3.24, mesa 26.1.6, LLVM 22.1.3; a 256 KiB
/// default still faults, 512 KiB and above survive). Matching glibc is what
/// makes the musl render agree with every other host.
///
/// The new default is process-global for threads created after it with default
/// attributes. Rust pins its own 2 MiB on the threads it spawns and libuv sizes
/// its pool from `RLIMIT_STACK`, so in practice only the driver's threads move.
///
/// One way, and idempotent: musl's own default only ever grows, and it clamps
/// to [`DRIVER_THREAD_STACK_BYTES`], so a second call finds the target already
/// in place. The read is what states that here rather than borrowing it.
///
/// Delete once mesa sizes `util_queue` thread stacks itself on musl.
#[cfg(all(target_os = "linux", target_env = "musl"))]
fn raise_default_thread_stack() -> bool {
    let mut attr = std::mem::MaybeUninit::<libc::pthread_attr_t>::uninit();
    let mut size = 0;
    unsafe {
        if pthread_getattr_default_np(attr.as_mut_ptr()) != 0 {
            return false;
        }
        let mut attr = attr.assume_init();
        let raised = libc::pthread_attr_getstacksize(&attr, &mut size) == 0
            && size < DRIVER_THREAD_STACK_BYTES
            && libc::pthread_attr_setstacksize(&mut attr, DRIVER_THREAD_STACK_BYTES) == 0
            && pthread_setattr_default_np(&attr) == 0;
        libc::pthread_attr_destroy(&mut attr);
        raised
    }
}

pub(crate) async fn request_adapter(
    power: wgpu::PowerPreference,
) -> Result<wgpu::Adapter, RenderError> {
    // Ahead of the instance, because the raise only reaches threads created
    // after it and the Vulkan driver spawns its own out of the instance. Best
    // effort: a refusal leaves musl's default in place and the render proceeds
    // exactly as it would have without this call.
    #[cfg(all(target_os = "linux", target_env = "musl"))]
    {
        static RAISED: std::sync::Once = std::sync::Once::new();
        RAISED.call_once(|| {
            let _ = raise_default_thread_stack();
        });
    }
    #[cfg(target_arch = "wasm32")]
    let backends = wgpu::Backends::BROWSER_WEBGPU;
    #[cfg(not(target_arch = "wasm32"))]
    let backends = wgpu::Backends::PRIMARY;
    // Surface-less by construction: no display handle, ever.
    let mut instance_descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    instance_descriptor.backends = backends;
    let instance = wgpu::Instance::new(instance_descriptor);
    instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: power,
            ..Default::default()
        })
        .await
        .map_err(adapter_error)
}

fn adapter_error(error: wgpu::RequestAdapterError) -> RenderError {
    RenderError::AdapterUnavailable(error.to_string())
}

fn gpu_error(context: &str, error: impl Display) -> RenderError {
    RenderError::Gpu(format!("{context}: {error}"))
}

fn request_device_error(error: wgpu::RequestDeviceError) -> RenderError {
    gpu_error("request_device", error)
}

#[cfg(not(target_arch = "wasm32"))]
fn poll_error(error: wgpu::PollError) -> RenderError {
    gpu_error("poll", error)
}

fn map_error(error: wgpu::BufferAsyncError, captured: Option<RenderError>) -> RenderError {
    captured.unwrap_or_else(|| gpu_error("map_async", error))
}

fn mapped_range_error(error: wgpu::MapRangeError) -> RenderError {
    gpu_error("mapped range", error)
}

/// Resolve fitted or fixed camera framing into WebGPU view/projection matrices.
#[cfg(test)]
pub(crate) fn camera_state(scene: &glb::Scene, options: &RenderOptions) -> CameraState {
    camera_state_with_bounds(
        &mut glb::UniquePositions::new(scene),
        options,
        scene.presented_bounds(options),
    )
}

pub(crate) fn camera_state_with_bounds(
    scene: &mut glb::UniquePositions<'_>,
    options: &RenderOptions,
    bounds: Option<([f32; 3], [f32; 3])>,
) -> CameraState {
    let (min, max) = bounds.unwrap_or(([-1.0; 3], [1.0; 3]));
    let min = Vec3::from(min);
    let max = Vec3::from(max);
    let center = (min + max) * 0.5;
    let mut radius = (max - center).length();
    if radius <= 0.0 || radius.is_nan() {
        // Matches resetCamera's degenerate-geometry fallback.
        radius = 1000.0;
    }

    let aspect = options.width as f32 / options.height as f32;
    match &options.camera {
        RenderCamera::Fit {
            direction,
            up,
            padding_factor,
            projection,
        } => {
            let direction = Vec3::from(*direction).normalize();
            let up = Vec3::from(*up).normalize();
            let (eye, target) = match projection {
                CameraProjection::Perspective {
                    vertical_field_of_view_deg,
                    ..
                } => fitted_perspective_pose(
                    scene,
                    options,
                    center,
                    (direction, up),
                    (vertical_field_of_view_deg.to_radians(), aspect),
                    *padding_factor,
                    radius,
                ),
                CameraProjection::Orthographic { .. } => {
                    let fov = 45f32.to_radians();
                    let standard_fov = 60f32.to_radians();
                    let distance = radius * 2.0 * ((standard_fov / 2.0).tan() / (fov / 2.0).tan());
                    fitted_orthographic_pose(scene, options, center, direction, up, distance)
                }
            };
            let view = glam::camera::rh::view::look_at_mat4(eye, target, up);
            let extents = match projection {
                CameraProjection::Orthographic { .. } => {
                    camera_extents::<true>(scene, options, view)
                }
                CameraProjection::Perspective { .. } => {
                    camera_extents::<false>(scene, options, view)
                }
            };
            let (near, far) = extents.clip_planes((eye - target).length());
            let projection = match projection {
                CameraProjection::Orthographic { .. } => {
                    let (half_width, half_height) =
                        extents.orthographic_half_extents(aspect, *padding_factor, radius);
                    glam::camera::rh::proj::directx::orthographic(
                        -half_width,
                        half_width,
                        -half_height,
                        half_height,
                        near,
                        far,
                    )
                }
                CameraProjection::Perspective {
                    vertical_field_of_view_deg,
                    ..
                } => glam::camera::rh::proj::directx::perspective(
                    vertical_field_of_view_deg.to_radians(),
                    aspect,
                    near,
                    far,
                ),
            };
            CameraState {
                projection,
                view,
                forward: (target - eye).normalize_or_zero(),
                target_depth: -view.transform_point3(center).z,
            }
        }
        RenderCamera::Fixed {
            position,
            target,
            up,
            projection,
            clipping,
        } => {
            let eye = Vec3::from(*position);
            let target = Vec3::from(*target);
            let view = glam::camera::rh::view::look_at_mat4(eye, target, Vec3::from(*up));
            let derived_clipping =
                position_clip_planes(scene, options, view, (eye - target).length());
            let (near, far) = clipping.map_or(derived_clipping, |planes| {
                let visible = (
                    planes.near.max(derived_clipping.0),
                    planes.far.min(derived_clipping.1),
                );
                if visible.0 < visible.1 {
                    visible
                } else {
                    (planes.near, planes.far)
                }
            });
            let projection = match projection {
                CameraProjection::Perspective {
                    vertical_field_of_view_deg,
                    zoom,
                } => {
                    let base = vertical_field_of_view_deg.to_radians();
                    let effective = 2.0 * ((base * 0.5).tan() / zoom).atan();
                    glam::camera::rh::proj::directx::perspective(effective, aspect, near, far)
                }
                CameraProjection::Orthographic {
                    vertical_span: Some(vertical_span),
                    zoom,
                } => {
                    let half_height = vertical_span / (2.0 * zoom);
                    let half_width = half_height * aspect;
                    glam::camera::rh::proj::directx::orthographic(
                        -half_width,
                        half_width,
                        -half_height,
                        half_height,
                        near,
                        far,
                    )
                }
                CameraProjection::Orthographic {
                    vertical_span: None,
                    ..
                } => unreachable!("fixed orthographic cameras resolve a vertical span"),
            };
            CameraState {
                projection,
                view,
                forward: (target - eye).normalize_or_zero(),
                target_depth: -view.transform_point3(target).z,
            }
        }
    }
}

fn for_each_camera_position(
    scene: &mut glb::UniquePositions<'_>,
    options: &RenderOptions,
    mut visit: impl FnMut(Vec3),
) {
    scene
        .for_each_position(options, &mut visit)
        .expect("parsed draw positions remain finite");
}

fn camera_basis(direction: Vec3, up: Vec3) -> (Vec3, Vec3) {
    let forward = -direction;
    let right = forward.cross(up).normalize();
    (right, right.cross(forward).normalize())
}

fn fitted_perspective_pose(
    scene: &mut glb::UniquePositions<'_>,
    options: &RenderOptions,
    center: Vec3,
    (direction, requested_up): (Vec3, Vec3),
    (fov, aspect): (f32, f32),
    padding: f32,
    radius: f32,
) -> (Vec3, Vec3) {
    let (right, up) = camera_basis(direction, requested_up);
    let vertical_tangent = (fov * 0.5).tan() * padding.max(0.001);
    let horizontal_tangent = vertical_tangent * aspect;
    let mut max_x_plus = f32::NEG_INFINITY;
    let mut min_x_minus = f32::INFINITY;
    let mut max_y_plus = f32::NEG_INFINITY;
    let mut min_y_minus = f32::INFINITY;
    let mut max_z = f32::NEG_INFINITY;
    for_each_camera_position(scene, options, |position| {
        let offset = position - center;
        let x = offset.dot(right);
        let y = offset.dot(up);
        let z = offset.dot(direction);
        max_x_plus = max_x_plus.max(x + horizontal_tangent * z);
        min_x_minus = min_x_minus.min(x - horizontal_tangent * z);
        max_y_plus = max_y_plus.max(y + vertical_tangent * z);
        min_y_minus = min_y_minus.min(y - vertical_tangent * z);
        max_z = max_z.max(z);
    });
    let distance_x = (max_x_plus - min_x_minus) / (2.0 * horizontal_tangent);
    let distance_y = (max_y_plus - min_y_minus) / (2.0 * vertical_tangent);
    let distance = distance_x
        .max(distance_y)
        .max(max_z + (radius * 0.001).max(f32::MIN_POSITIVE));
    let shift_x = (max_x_plus + min_x_minus) * 0.5;
    let shift_y = (max_y_plus + min_y_minus) * 0.5;
    let target = center + right * shift_x + up * shift_y;
    (target + direction * distance, target)
}

fn fitted_orthographic_pose(
    scene: &mut glb::UniquePositions<'_>,
    options: &RenderOptions,
    center: Vec3,
    direction: Vec3,
    requested_up: Vec3,
    distance: f32,
) -> (Vec3, Vec3) {
    let (right, up) = camera_basis(direction, requested_up);
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for_each_camera_position(scene, options, |position| {
        let offset = position - center;
        let x = offset.dot(right);
        let y = offset.dot(up);
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    });
    let target = center + right * ((min_x + max_x) * 0.5) + up * ((min_y + max_y) * 0.5);
    (target + direction * distance, target)
}

// Independent reductions over the same view-space positions share one transform.
// Perspective/fixed cameras specialize away the unneeded XY reduction.
struct CameraExtents {
    nearest: f32,
    farthest: f32,
    max_x: f32,
    max_y: f32,
}

fn camera_extents<const INCLUDE_XY: bool>(
    scene: &mut glb::UniquePositions<'_>,
    options: &RenderOptions,
    view: Mat4,
) -> CameraExtents {
    let mut extents = CameraExtents {
        nearest: f32::INFINITY,
        farthest: 0.0,
        max_x: 0.0,
        max_y: 0.0,
    };
    for_each_camera_position(scene, options, |position| {
        let camera = if INCLUDE_XY {
            // Evaluate only XYZ, preserving glam's transform_point3 addition order.
            // The explicit lanes reduce measured orthographic planning cost without
            // caching world positions or changing fitted bounds and clip planes.
            let x = view.x_axis.x * position.x;
            let x = view.y_axis.x * position.y + x;
            let x = view.z_axis.x * position.z + x;
            let x = view.w_axis.x + x;
            let y = view.x_axis.y * position.x;
            let y = view.y_axis.y * position.y + y;
            let y = view.z_axis.y * position.z + y;
            let y = view.w_axis.y + y;
            let z = view.x_axis.z * position.x;
            let z = view.y_axis.z * position.y + z;
            let z = view.z_axis.z * position.z + z;
            let z = view.w_axis.z + z;
            Vec3::new(x, y, z)
        } else {
            // Preserve glam's transform_point3 addition order, but compute only
            // the depth lane. Reassociation can change the fitted clip planes.
            let z = view.x_axis.z * position.x;
            let z = view.y_axis.z * position.y + z;
            let z = view.z_axis.z * position.z + z;
            let z = view.w_axis.z + z;
            Vec3::new(0.0, 0.0, z)
        };
        let depth = -camera.z;
        if depth > 0.0 {
            extents.nearest = extents.nearest.min(depth);
            extents.farthest = extents.farthest.max(depth);
        }
        if INCLUDE_XY {
            extents.max_x = extents.max_x.max(camera.x.abs());
            extents.max_y = extents.max_y.max(camera.y.abs());
        }
    });
    extents
}

impl CameraExtents {
    fn clip_planes(&self, fallback_depth: f32) -> (f32, f32) {
        if self.farthest <= 0.0 {
            let depth = fallback_depth.max(1.0);
            return (depth * 0.001, depth * 2.0);
        }
        let near = (self.nearest * 0.5)
            .max(self.farthest * 1e-6)
            .max(f32::MIN_POSITIVE);
        (near, (self.farthest * 2.0).max(near * 2.0))
    }

    fn orthographic_half_extents(&self, aspect: f32, padding: f32, radius: f32) -> (f32, f32) {
        let safe_padding = padding.max(0.001);
        let minimum = (radius * 0.001).max(f32::MIN_POSITIVE);
        let mut half_width = (self.max_x / safe_padding).max(minimum);
        let mut half_height = (self.max_y / safe_padding).max(minimum);
        if half_width / half_height < aspect {
            half_width = half_height * aspect;
        } else {
            half_height = half_width / aspect;
        }
        (half_width, half_height)
    }
}

fn position_clip_planes(
    scene: &mut glb::UniquePositions<'_>,
    options: &RenderOptions,
    view: Mat4,
    fallback_depth: f32,
) -> (f32, f32) {
    camera_extents::<false>(scene, options, view).clip_planes(fallback_depth)
}

// The one definition of the `Frame` uniform (see `shader.wgsl`): two mat4 and
// a viewport vec4, then eight Lights at a 32-byte stride, a 16-byte lighting
// tail, `MAX_SECTION_PLANES` section planes, a 16-byte section tail, 16-byte
// background, and 16-byte AO control. 592 bytes at eight planes.
const FRAME_LIGHTS: usize = 36;
const FRAME_LIGHT_STRIDE: usize = 8;
const FRAME_TAIL: usize = 100;
const FRAME_SECTION_PLANES: usize = 104;
const FRAME_SECTION_TAIL: usize = FRAME_SECTION_PLANES + MAX_SECTION_PLANES * 4;
const FRAME_FLOATS: usize = FRAME_SECTION_TAIL + 12;

fn frame_uniform(camera: CameraState, options: &RenderOptions) -> [f32; FRAME_FLOATS] {
    let lighting = &options.lighting;
    let mut data = [0f32; FRAME_FLOATS];
    data[..16].copy_from_slice(&(camera.projection * camera.view).to_cols_array());
    data[16..32].copy_from_slice(&camera.view.to_cols_array());
    data[32..FRAME_LIGHTS].copy_from_slice(&[
        options.width as f32,
        options.height as f32,
        line_width_px(options),
        crate::section::stripe_spacing(camera, camera_projection_kind(&options.camera)),
    ]);
    for (index, light) in lighting.lights.iter().take(MAX_LIGHTS).enumerate() {
        // World-space rigs are rotated into view space here, once per view,
        // so the shader stays view-space and never learns the difference.
        let direction = match lighting.space {
            LightingSpace::View => Vec3::from(light.direction),
            LightingSpace::World => camera.view.transform_vector3(Vec3::from(light.direction)),
        }
        .normalize_or_zero();
        let base = FRAME_LIGHTS + index * FRAME_LIGHT_STRIDE;
        data[base..base + 3].copy_from_slice(&direction.to_array());
        data[base + 4..base + 7].copy_from_slice(&light.color);
    }
    // The tail's two u32 fields ride in the same f32 array by bit pattern.
    data[FRAME_TAIL] = f32::from_bits(lighting.lights.len().min(MAX_LIGHTS) as u32);
    data[FRAME_TAIL + 1] = lighting.ambient;
    data[FRAME_TAIL + 2] = lighting.exposure;
    data[FRAME_TAIL + 3] = f32::from_bits(u32::from(lighting.environment));
    data[FRAME_SECTION_TAIL + 3] = f32::from_bits(u32::from(
        camera_projection_kind(&options.camera) == Projection::Orthographic,
    ));
    let background = clear_color(options);
    data[FRAME_SECTION_TAIL + 4..FRAME_SECTION_TAIL + 8].copy_from_slice(&[
        background.r as f32,
        background.g as f32,
        background.b as f32,
        background.a as f32,
    ]);
    data[FRAME_SECTION_TAIL + 8] = options.ao.map_or(1.0, |ao| ao.intensity);
    if let Some(sections) = &options.sections {
        // Clamped the way the light rig is: `RenderOptions` is public, so the
        // uniform's fixed array is the authority even when validation is not.
        for (index, plane) in sections.planes.iter().take(MAX_SECTION_PLANES).enumerate() {
            let base = FRAME_SECTION_PLANES + index * 4;
            let normal = Vec3::from(plane.normal).normalize();
            data[base..base + 3].copy_from_slice(&normal.to_array());
            data[base + 3] = -normal.dot(Vec3::from(plane.point));
        }
        data[FRAME_SECTION_TAIL] =
            f32::from_bits(sections.planes.len().min(MAX_SECTION_PLANES) as u32);
        data[FRAME_SECTION_TAIL + 1] = f32::from_bits(u32::from(sections.clip_surfaces));
        data[FRAME_SECTION_TAIL + 2] = f32::from_bits(u32::from(sections.clip_lines));
    }
    data
}

fn camera_projection_kind(camera: &RenderCamera) -> Projection {
    match camera {
        RenderCamera::Fit { projection, .. } | RenderCamera::Fixed { projection, .. } => {
            projection.kind()
        }
    }
}

fn line_width_px(options: &RenderOptions) -> f32 {
    options.line_width
}

fn draw_surface(pass: &mut wgpu::RenderPass<'_>, instance: &GpuInstance, mesh: &GpuMesh) {
    pass.set_bind_group(2, &instance.bind_group, &[]);
    pass.set_bind_group(1, &mesh.bind_group, &[]);
    pass.set_vertex_buffer(0, mesh.positions.slice(..));
    pass.set_vertex_buffer(1, mesh.normals.slice(..));
    pass.set_vertex_buffer(2, mesh.surface_attributes.slice(..));
    pass.set_index_buffer(mesh.indices.slice(..), wgpu::IndexFormat::Uint32);
    pass.draw_indexed(0..mesh.index_count, 0, 0..1);
}

fn draw_lines(pass: &mut wgpu::RenderPass<'_>, scene: &SceneBuffers, options: &RenderOptions) {
    for instance in &scene.gpu_instances {
        let asset = &scene.gpu_assets[instance.mesh_index];
        pass.set_bind_group(2, &instance.bind_group, &[]);
        for lines in &asset.lines {
            if !primitive_selected(
                options,
                instance.source_node_index,
                asset.source_mesh_index,
                lines.source_primitive_index,
            ) {
                continue;
            }
            pass.set_bind_group(1, &lines.bind_group, &[]);
            pass.set_vertex_buffer(0, lines.segments.slice(..));
            pass.draw(0..8, 0..lines.segment_count);
        }
    }
}

fn primitive_selected(
    options: &RenderOptions,
    node_index: usize,
    mesh_index: usize,
    primitive_index: usize,
) -> bool {
    options.visible_primitives.as_ref().is_none_or(|visible| {
        visible.contains(&crate::PrimitiveRef {
            node_index,
            mesh_index,
            primitive_index,
        })
    })
}

/// sRGB EOTF: `RenderOptions::background` is authored in sRGB, but wgpu clear
/// colors are linear (the sRGB target re-encodes on write).
fn srgb_to_linear(channel: f32) -> f64 {
    let channel = f64::from(channel.clamp(0.0, 1.0));
    if channel <= 0.040_45 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

fn clear_color(options: &RenderOptions) -> wgpu::Color {
    options
        .background
        .map_or(wgpu::Color::TRANSPARENT, |bg| wgpu::Color {
            r: srgb_to_linear(bg[0]),
            g: srgb_to_linear(bg[1]),
            b: srgb_to_linear(bg[2]),
            a: f64::from(bg[3].clamp(0.0, 1.0)),
        })
}

fn create_pipeline_pair(
    device: &wgpu::Device,
    shader: &wgpu::ShaderModule,
    pipeline_layout: &wgpu::PipelineLayout,
    line_width_px: f32,
    wireframe: bool,
    features: ShaderFeatures,
) -> PipelinePair {
    let position_layout = wgpu::VertexBufferLayout {
        array_stride: 12,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![0 => Float32x3],
    };
    let normal_layout = wgpu::VertexBufferLayout {
        array_stride: 12,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![1 => Float32x3],
    };
    // Fat lines: one instance per segment carrying both endpoints; the vertex
    // shader expands each into a screen-space body quad plus two round-cap
    // rows (8-vertex triangle strip).
    let segment_layout = wgpu::VertexBufferLayout {
        array_stride: 24,
        step_mode: wgpu::VertexStepMode::Instance,
        attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3],
    };

    let color_target = Some(wgpu::ColorTargetState {
        format: COLOR_FORMAT,
        // Straight-alpha over on a transparent clear.
        blend: Some(wgpu::BlendState::ALPHA_BLENDING),
        write_mask: wgpu::ColorWrites::ALL,
    });
    let line_depth_state = Some(wgpu::DepthStencilState {
        format: DEPTH_FORMAT,
        depth_write_enabled: Some(true),
        depth_compare: Some(wgpu::CompareFunction::Less),
        stencil: wgpu::StencilState::default(),
        bias: wgpu::DepthBiasState::default(),
    });
    // Wireframe surfaces take a slope-scaled polygon offset (the classic CAD
    // shaded+wireframe move) instead of lines being pulled forward: the edge
    // quad is expanded in screen space at the segment's depth, so wherever it
    // overhangs a nearer surface — grazing walls near silhouettes, bores,
    // ridges seen edge-on — a constant line-side bias loses to the surface's
    // depth gradient and the stroke gets chewed to a hairline. Pushing each
    // surface back by its own screen-space depth slope times the stroke's
    // half-width covers exactly that overhang at any resolution; `clamp`
    // bounds the push on near-tangent surfaces so hidden edges behind them
    // stay hidden. The half-width is the whole margin: depth is tested per
    // sample, so nothing beyond the stroke needs covering, and any extra push
    // shows a hidden edge that ends on a face's boundary (the far flank edges
    // of a gear tooth) as a tick past its outline. Surface-only renders use
    // the unbiased state.
    let mesh_depth_state = Some(wgpu::DepthStencilState {
        format: DEPTH_FORMAT,
        depth_write_enabled: Some(true),
        depth_compare: Some(wgpu::CompareFunction::Less),
        stencil: wgpu::StencilState::default(),
        bias: if wireframe {
            wgpu::DepthBiasState {
                constant: 2,
                // Any slope margin still lets a hidden edge lying just behind a
                // nearly coplanar face show through. The exact alternative is a
                // spine test (Cole & Finkelstein, "Two Fast Methods for
                // High-Quality Line Visibility", TVCG 2010): read the AO pass's
                // opaque depth in `fs_line` at the stroke's centre line and
                // discard when the surface is nearer, so the whole stroke width
                // takes its spine's visibility and this bias can drop to the
                // constant. It needs that depth pass whenever lines draw.
                slope_scale: line_width_px * 0.5,
                clamp: 0.01,
            }
        } else {
            wgpu::DepthBiasState::default()
        },
    });
    let multisample = wgpu::MultisampleState {
        count: MSAA_SAMPLES,
        mask: !0,
        alpha_to_coverage_enabled: false,
    };

    let surface_layout = wgpu::VertexBufferLayout {
        array_stride: 64,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![2 => Float32x4, 3 => Float32x4, 4 => Float32x4, 5 => Float32x4],
    };
    let make_mesh = |blend: bool, constant: bool| {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("mesh"),
            layout: Some(pipeline_layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some("vs_mesh"),
                compilation_options: Default::default(),
                buffers: &[
                    Some(position_layout.clone()),
                    Some(normal_layout.clone()),
                    Some(wgpu::VertexBufferLayout {
                        step_mode: if constant {
                            wgpu::VertexStepMode::Instance
                        } else {
                            wgpu::VertexStepMode::Vertex
                        },
                        ..surface_layout.clone()
                    }),
                ],
            },
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some("fs_mesh"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[
                        ("TEXTURE_MASK", f64::from(features.texture_mask)),
                        ("CLEARCOAT", f64::from(u32::from(features.clearcoat))),
                        (
                            "ANISOTROPY_SHEEN",
                            f64::from(u32::from(features.anisotropy_sheen)),
                        ),
                    ],
                    ..Default::default()
                },
                targets: &[Some(wgpu::ColorTargetState {
                    format: HDR_FORMAT,
                    blend: blend.then_some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                // CAD solids are frequently marked doubleSided by the kernels.
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: mesh_depth_state.clone().map(|mut state| {
                state.depth_write_enabled = Some(!blend);
                state
            }),
            multisample,
            multiview_mask: None,
            cache: None,
        })
    };

    let mesh = make_mesh(false, false);
    let blend_mesh = make_mesh(true, false);
    let constant_mesh = make_mesh(false, true);
    let constant_blend_mesh = make_mesh(true, true);

    // ponytail: pipelines compiled sequentially on purpose — llvmpipe SIGSEGVs
    // under concurrent pipeline compilation (bevy #13708).
    let make_line = |transmission: bool| {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("line"),
            layout: Some(pipeline_layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some("vs_line"),
                compilation_options: Default::default(),
                buffers: &[Some(segment_layout.clone())],
            },
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some("fs_line"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: if transmission {
                        HDR_FORMAT
                    } else {
                        COLOR_FORMAT
                    },
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: line_depth_state.clone().map(|mut state| {
                // The retained opaque image supplies refracted edges; their depth
                // must not prevent the later glass surface or final edge drawing.
                state.depth_write_enabled = Some(!transmission);
                state
            }),
            multisample,
            multiview_mask: None,
            cache: None,
        })
    };

    let cap_layout = wgpu::VertexBufferLayout {
        array_stride: 60,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![
            0 => Float32x3,
            1 => Float32x2,
            2 => Float32x4,
            3 => Float32x4,
            4 => Float32x2
        ],
    };
    let cap = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("section cap"),
        layout: Some(pipeline_layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_cap"),
            compilation_options: Default::default(),
            buffers: &[Some(cap_layout)],
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs_cap"),
            compilation_options: Default::default(),
            targets: std::slice::from_ref(&color_target),
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            cull_mode: None,
            ..Default::default()
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample,
        multiview_mask: None,
        cache: None,
    });

    let fullscreen = |mip: bool| {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("HDR output transform"),
            layout: Some(pipeline_layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some("vs_screen"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some(if mip { "fs_mip" } else { "fs_screen" }),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: if mip { HDR_FORMAT } else { COLOR_FORMAT },
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: (!mip).then_some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(false),
                depth_compare: Some(wgpu::CompareFunction::Always),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: if mip {
                wgpu::MultisampleState::default()
            } else {
                multisample
            },
            multiview_mask: None,
            cache: None,
        })
    };
    PipelinePair {
        mesh,
        blend_mesh,
        constant_mesh,
        constant_blend_mesh,
        screen: fullscreen(false),
        mip: fullscreen(true),
        cap,
        line: make_line(false),
        transmission_line: make_line(true),
    }
}

fn create_ao_pipelines(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    mesh_shader: &wgpu::ShaderModule,
    mesh_layout: &wgpu::PipelineLayout,
    texture_mask: u32,
) -> AoPipelines {
    let position = wgpu::VertexBufferLayout {
        array_stride: 12,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![0 => Float32x3],
    };
    let normal = wgpu::VertexBufferLayout {
        array_stride: 12,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![1 => Float32x3],
    };
    let attributes = wgpu::VertexBufferLayout {
        array_stride: 64,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![2 => Float32x4, 3 => Float32x4, 4 => Float32x4, 5 => Float32x4],
    };
    let make_depth_mesh = |constant: bool| {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("AO opaque depth"),
            layout: Some(mesh_layout),
            vertex: wgpu::VertexState {
                module: mesh_shader,
                entry_point: Some("vs_mesh"),
                compilation_options: Default::default(),
                buffers: &[
                    Some(position.clone()),
                    Some(normal.clone()),
                    Some(wgpu::VertexBufferLayout {
                        step_mode: if constant {
                            wgpu::VertexStepMode::Instance
                        } else {
                            wgpu::VertexStepMode::Vertex
                        },
                        ..attributes.clone()
                    }),
                ],
            },
            fragment: Some(wgpu::FragmentState {
                module: mesh_shader,
                entry_point: Some("fs_ao_depth"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[("TEXTURE_MASK", f64::from(texture_mask))],
                    ..Default::default()
                },
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::R32Float,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    };
    let depth_mesh = make_depth_mesh(false);
    let depth_constant_mesh = make_depth_mesh(true);

    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("AO depth and estimate"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 4,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("AO fullscreen"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("AO estimate and denoise"),
        source: wgpu::ShaderSource::Wgsl(include_str!("ao.wgsl").into()),
    });
    let fullscreen = |entry: &str, blur_index: Option<f64>| {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(entry),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_ao"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some(entry),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &blur_index.map_or(Vec::new(), |index| vec![("BLUR_INDEX", index)]),
                    ..Default::default()
                },
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        })
    };
    AoPipelines {
        texture_mask,
        depth_mesh,
        depth_constant_mesh,
        estimate: fullscreen("fs_ao_estimate", None),
        blur: [
            fullscreen("fs_ao_blur", Some(0.0)),
            fullscreen("fs_ao_blur", Some(1.0)),
        ],
        separable_blur: [
            fullscreen("fs_ao_blur_separable", Some(0.0)),
            fullscreen("fs_ao_blur_separable", Some(1.0)),
        ],
        layout,
        sampler: device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("AO denoise filtering"),
            min_filter: wgpu::FilterMode::Linear,
            mag_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        }),
        // Decoded from n8ao 1.10.2 src/BlueNoise.js (project LICENSE: CC0-1.0).
        blue_noise: device
            .create_texture_with_data(
                queue,
                &wgpu::TextureDescriptor {
                    label: Some("N8AO blue noise (CC0-1.0)"),
                    size: wgpu::Extent3d {
                        width: 128,
                        height: 128,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                wgpu::util::TextureDataOrder::LayerMajor,
                include_bytes!("../assets/n8ao-blue-noise.bin"),
            )
            .create_view(&wgpu::TextureViewDescriptor::default()),
        frame_buffer: device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("AO frame"),
            size: 160,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        }),
    }
}

impl DeviceState {
    async fn new(
        power: wgpu::PowerPreference,
        lost: &Arc<AtomicBool>,
        uncaptured: &Arc<Mutex<Option<String>>>,
    ) -> Result<Self, RenderError> {
        let adapter = request_adapter(power).await?;
        // Software WebGPU changes exact 5K quantization under this specialization.
        // Use the adapter's fallback classification, never a vendor-name heuristic.
        let specialize_anisotropy_sheen =
            cfg!(target_arch = "wasm32") && adapter.get_info().device_type != wgpu::DeviceType::Cpu;
        // 32-bit ARM Linux only: lavapipe from mesa 23 onwards dies inside the
        // driver during command replay, which no `Result` can carry. Refuse
        // before a device exists, unless the consumer opted out.
        #[cfg(all(target_arch = "arm", target_os = "linux"))]
        {
            let info = adapter.get_info();
            if let Some(message) =
                crate::driver::unsupported_lavapipe(&info.name, &info.driver, &info.driver_info)
            {
                if crate::driver::opt_out_active(
                    std::env::var_os(crate::driver::OPT_OUT_VARIABLE).as_deref(),
                ) {
                    static BYPASSED: std::sync::Once = std::sync::Once::new();
                    BYPASSED.call_once(|| {
                        eprintln!(
                            "nanoraster: {} bypasses the driver guard; this render may take the process down. {message}",
                            crate::driver::OPT_OUT_VARIABLE
                        );
                    });
                } else {
                    return Err(RenderError::DriverUnsupported(message));
                }
            }
        }
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("render-core"),
                required_limits: wgpu::Limits {
                    max_texture_dimension_2d: adapter
                        .limits()
                        .max_texture_dimension_2d
                        .min(crate::options::MAX_DIMENSION),
                    max_buffer_size: adapter.limits().max_buffer_size.min(256 * 1024 * 1024),
                    ..Default::default()
                },
                #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
                required_features: profile::features(&adapter),
                ..Default::default()
            })
            .await
            .map_err(request_device_error)?;

        device.set_device_lost_callback({
            let lost = lost.clone();
            let captured = uncaptured.clone();
            move |reason, message| note_device_lost(&lost, &captured, reason, &message)
        });
        // Without a handler, native wgpu panics on uncaptured validation errors
        // and browsers only log them; storing the first message gives every
        // consumer the same deterministic `gpu:` failure instead.
        device.on_uncaptured_error(Arc::new({
            let slot = uncaptured.clone();
            move |error: wgpu::Error| {
                let mut slot = slot
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                slot.get_or_insert_with(|| error.to_string());
            }
        }));

        let pass_local_usage = pass_local_attachment_usage(&device).await;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("render-core"),
            source: wgpu::ShaderSource::Wgsl(
                [
                    include_str!("shader.wgsl"),
                    include_str!("physical.wgsl"),
                    include_str!("lighting.wgsl"),
                ]
                .concat()
                .into(),
            ),
        });

        // Matrices are overwritten by every view before a draw; zero-fill so
        // the buffer is never uninitialised.
        let frame_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("frame"),
            contents: bytemuck::cast_slice(&[0f32; FRAME_FLOATS]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("frame"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let [studio_map, dfg_map] = crate::lighting::textures(&device, &queue);
        let lighting_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("studio filtering"),
            min_filter: wgpu::FilterMode::Linear,
            mag_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let frame_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("frame"),
            layout: &frame_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: frame_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&studio_map),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&dfg_map),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&lighting_sampler),
                },
            ],
        });

        let prim_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("prim"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let object_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("object"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let uniform_group = |layout: &wgpu::BindGroupLayout, label, data: &[f32]| {
            let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(data),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(label),
                layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buffer.as_entire_binding(),
                }],
            })
        };
        let default_material = uniform_group(
            &prim_layout,
            "default material",
            &Material::default().uniform(),
        );
        let identity_object = uniform_group(
            &object_layout,
            "identity object",
            &Mat4::IDENTITY.to_cols_array().repeat(2),
        );

        let scene_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("material maps and transmission"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 5,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });
        let scene_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("screen refraction"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let empty_scene = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("empty scene"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: HDR_FORMAT,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
            .create_view(&wgpu::TextureViewDescriptor::default());
        let empty_ao = device
            .create_texture_with_data(
                &queue,
                &wgpu::TextureDescriptor {
                    label: Some("unoccluded AO"),
                    size: wgpu::Extent3d {
                        width: 1,
                        height: 1,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                wgpu::util::TextureDataOrder::LayerMajor,
                &[255, 255, 255, 255],
            )
            .create_view(&wgpu::TextureViewDescriptor::default());

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("render-core"),
            bind_group_layouts: &[
                Some(&frame_layout),
                Some(&prim_layout),
                Some(&object_layout),
                Some(&scene_layout),
            ],
            immediate_size: 0,
        });

        Ok(Self {
            specialize_anisotropy_sheen,
            device,
            queue,
            pass_local_usage,
            shader,
            frame_buffer,
            frame_bind_group,
            prim_layout,
            scene_layout,
            scene_sampler,
            empty_scene,
            empty_ao,
            default_material,
            identity_object,
            object_layout,
            pipeline_layout,
            pipelines: Vec::new(),
            ao_pipelines: None,
            targets: None,
        })
    }
}

impl Renderer {
    pub async fn new(power: wgpu::PowerPreference) -> Result<Self, RenderError> {
        let lost = Arc::new(AtomicBool::new(false));
        let uncaptured = Arc::new(Mutex::new(None));
        let state = DeviceState::new(power, &lost, &uncaptured).await?;
        Ok(Self {
            #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
            profile: Default::default(),
            state,
            lost,
            uncaptured,
            power,
            generation: 0,
            counters: Counters {
                device_requests: 1,
                ..Counters::default()
            },
        })
    }

    /// Destroys the GPU device now instead of waiting for GC/drop. Later plan
    /// calls fail with a `gpu:` error; bindings gate disposed handles above
    /// this layer.
    pub fn destroy(&self) {
        self.state.device.destroy();
    }

    /// Drain native, opt-in benchmark diagnostics. Absent from published builds.
    #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
    pub fn take_profile(&self) -> Vec<serde_json::Value> {
        self.profile.take()
    }

    pub(crate) fn counters(&self) -> Counters {
        self.counters
    }

    /// Drop retained render targets larger than [`MAX_RETAINED_TARGET_PIXELS`].
    /// Re-allocating them costs milliseconds, so the shared one-shot renderer
    /// calls this after every render rather than holding a 4096² target set
    /// (hundreds of MB) for the rest of the process.
    pub fn trim_targets(&mut self) {
        let oversized = self.state.targets.as_ref().is_some_and(|targets| {
            u64::from(targets.width) * u64::from(targets.height) > MAX_RETAINED_TARGET_PIXELS
        });
        if oversized {
            #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
            if self
                .state
                .device
                .features()
                .contains(wgpu::Features::TIMESTAMP_QUERY)
            {
                self.profile.borrow_mut().push(serde_json::json!({"event":"trim", "retired": self.state.targets.as_ref().map(profile::ledger)}));
            }
            self.state.targets = None;
        }
    }

    /// Device loss is recovered transparently at the next plan entry: rebuild
    /// every device-scoped resource and bump the generation so scene buffers
    /// uploaded under the old device re-upload lazily.
    pub(crate) async fn recover_if_lost(&mut self) -> Result<(), RenderError> {
        if !self.lost.swap(false, Ordering::Acquire) {
            return Ok(());
        }
        // The replacement device must not inherit the retired device's error.
        let _ = self.take_uncaptured();
        self.state = DeviceState::new(self.power, &self.lost, &self.uncaptured).await?;
        self.generation += 1;
        self.counters.device_requests += 1;
        Ok(())
    }

    fn take_uncaptured(&self) -> Result<(), RenderError> {
        let mut slot = self
            .uncaptured
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match slot.take() {
            Some(message) => Err(RenderError::Gpu(message)),
            None => Ok(()),
        }
    }

    /// Parse-and-upload seam: uploads (or re-uploads after device loss) the
    /// scene's GPU buffers, returning the buffers bound to this device.
    pub(crate) fn ensure_uploaded<'scene>(
        &mut self,
        scene: &'scene mut Scene,
    ) -> Result<&'scene SceneBuffers, RenderError> {
        let stale =
            !matches!(&scene.buffers, Some((generation, _)) if *generation == self.generation);
        if stale {
            let buffers = self.upload_scene(&scene.parsed);
            self.take_uncaptured()?;
            scene.buffers = Some((self.generation, buffers));
        }
        Ok(&scene
            .buffers
            .as_ref()
            .expect("scene buffers just ensured")
            .1)
    }

    fn upload_scene(&mut self, scene: &glb::Scene) -> SceneBuffers {
        self.counters.scene_uploads += 1;
        let device = &self.state.device;
        // Each source mesh is uploaded once. Lines are de-indexed into segment
        // endpoint pairs for the fat-line quad expansion.
        let make_bind_group = |material: &Material| {
            let data = material.uniform();
            // The bind group keeps the uniform buffer alive; the handle can drop.
            let material_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("material"),
                contents: bytemuck::cast_slice(&data),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("prim"),
                layout: &self.state.prim_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: material_buffer.as_entire_binding(),
                }],
            })
        };
        let gpu_assets = scene
            .meshes
            .iter()
            .map(|mesh| {
                let mut surfaces = Vec::new();
                let mut lines = Vec::new();
                for primitive in &mesh.primitives {
                    let bind_group = make_bind_group(&primitive.material);
                    if primitive.mode == MODE_TRIANGLES {
                        let attributes = if primitive.surface_attributes.is_empty() {
                            let mut values = vec![[0.0; 16]; 1];
                            for value in &mut values {
                                value[12..].fill(1.0);
                            }
                            std::borrow::Cow::Owned(values)
                        } else {
                            std::borrow::Cow::Borrowed(&primitive.surface_attributes)
                        };
                        let center = if primitive.material.transparent() {
                            primitive
                                .positions
                                .as_chunks::<3>()
                                .0
                                .iter()
                                .map(|point| Vec3::from_array(*point))
                                .sum::<Vec3>()
                                / (primitive.positions.len() / 3).max(1) as f32
                        } else {
                            Vec3::ZERO
                        };
                        surfaces.push(GpuMesh {
                            source_primitive_index: primitive.source_index,
                            constant_attributes: primitive.surface_attributes.is_empty(),
                            transparent: primitive.material.transparent(),
                            transmission: primitive.material.transmission[0] > 0.0,
                            alpha_blend: primitive.material.alpha_mode == 2.0,
                            center,
                            surface_attributes: device.create_buffer_init(
                                &wgpu::util::BufferInitDescriptor {
                                    label: Some("surface attributes"),
                                    contents: bytemuck::cast_slice(attributes.as_ref()),
                                    usage: wgpu::BufferUsages::VERTEX,
                                },
                            ),
                            positions: device.create_buffer_init(
                                &wgpu::util::BufferInitDescriptor {
                                    label: Some("positions"),
                                    contents: bytemuck::cast_slice(&primitive.positions),
                                    usage: wgpu::BufferUsages::VERTEX,
                                },
                            ),
                            normals: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                label: Some("normals"),
                                contents: bytemuck::cast_slice(&primitive.normals),
                                usage: wgpu::BufferUsages::VERTEX,
                            }),
                            indices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                label: Some("indices"),
                                contents: bytemuck::cast_slice(&primitive.indices),
                                usage: wgpu::BufferUsages::INDEX,
                            }),
                            index_count: primitive.indices.len() as u32,
                            bind_group,
                        });
                        continue;
                    }
                    let segments: Vec<f32> = primitive
                        .indices
                        .iter()
                        .flat_map(|&index| {
                            let base = index as usize * 3;
                            primitive.positions[base..base + 3].iter().copied()
                        })
                        .collect();
                    lines.push(GpuLines {
                        source_primitive_index: primitive.source_index,
                        segments: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some("segments"),
                            contents: bytemuck::cast_slice(&segments),
                            usage: wgpu::BufferUsages::VERTEX,
                        }),
                        segment_count: (primitive.indices.len() / 2) as u32,
                        bind_group,
                    });
                }
                GpuMeshAsset {
                    source_mesh_index: mesh.source_index,
                    surfaces,
                    lines,
                }
            })
            .collect();

        let gpu_instances = scene
            .instances
            .iter()
            .map(|instance| {
                let mut data = [0.0f32; 32];
                data[..16].copy_from_slice(&instance.model.to_cols_array());
                data[16..].copy_from_slice(&instance.normal_matrix.to_cols_array());
                let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("object"),
                    contents: bytemuck::cast_slice(&data),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                GpuInstance {
                    model: instance.model,
                    source_node_index: instance.source_node_index,
                    mesh_index: instance.mesh_index,
                    bind_group: device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("object"),
                        layout: &self.state.object_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: buffer.as_entire_binding(),
                        }],
                    }),
                }
            })
            .collect();

        let features = scene.meshes.iter().flat_map(|mesh| &mesh.primitives).fold(
            ShaderFeatures {
                // Native Metal feature specialization needs independent exact-output
                // qualification. Keep its general shader; specialize browser WebGPU.
                clearcoat: cfg!(not(target_arch = "wasm32")),
                anisotropy_sheen: !self.state.specialize_anisotropy_sheen,
                ..ShaderFeatures::default()
            },
            |mut features, primitive| {
                let material = &primitive.material;
                features.clearcoat |= material.coat[0] != 0.0;
                features.anisotropy_sheen |= material.anisotropy[0] != 0.0
                    // Active iridescence also retains the general expression tree:
                    // removing its neighboring layers changes exact film output.
                    || material.iridescence[0] != 0.0
                    || material.sheen[..3].iter().any(|value| *value != 0.0);
                for (index, slot) in material.textures.iter().enumerate() {
                    features.texture_mask |= u32::from(slot.present()) << index;
                }
                features
            },
        );
        SceneBuffers {
            features,
            gpu_assets,
            gpu_instances,
            texture_pixels: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("texture mip pixels"),
                contents: bytemuck::cast_slice(&scene.texture_pixels),
                usage: wgpu::BufferUsages::STORAGE,
            }),
        }
    }

    pub(crate) fn prepare_presentation(
        &mut self,
        scene: &glb::Scene,
        options: &RenderOptions,
    ) -> Result<PresentationBuffers, RenderError> {
        self.counters.presentation_builds += 1;
        let geometry = crate::section::build(scene, options)?;
        let device = &self.state.device;
        let cap = (!geometry.indices.is_empty()).then(|| GpuCap {
            vertices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("section cap vertices"),
                contents: bytemuck::cast_slice(&geometry.vertices),
                usage: wgpu::BufferUsages::VERTEX,
            }),
            indices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("section cap indices"),
                contents: bytemuck::cast_slice(&geometry.indices),
                usage: wgpu::BufferUsages::INDEX,
            }),
            index_count: geometry.indices.len() as u32,
        });
        let stroke = |label: &str, segments: &[f32], color: [f32; 4]| {
            (!segments.is_empty()).then(|| {
                let material = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(label),
                    contents: bytemuck::cast_slice(
                        &Material {
                            base_color: color,
                            ..Material::default()
                        }
                        .uniform(),
                    ),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                GpuStroke {
                    segments: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some(label),
                        contents: bytemuck::cast_slice(segments),
                        usage: wgpu::BufferUsages::VERTEX,
                    }),
                    count: (segments.len() / 6) as u32,
                    material: device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some(label),
                        layout: &self.state.prim_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: material.as_entire_binding(),
                        }],
                    }),
                }
            })
        };
        let boundary = stroke(
            "section boundaries",
            &geometry.boundaries,
            [0.0, 0.0, 0.0, 1.0],
        );
        let open_chains = stroke(
            "section open chains",
            &geometry.open_chains,
            crate::section::srgb_hex(crate::section::OPEN_CHAIN_SRGB),
        );
        let identity_object = (boundary.is_some() || open_chains.is_some()).then(|| {
            let identity = [
                Mat4::IDENTITY.to_cols_array(),
                Mat4::IDENTITY.to_cols_array(),
            ]
            .concat();
            let object = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("section boundary object"),
                contents: bytemuck::cast_slice(&identity),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("section boundary object"),
                layout: &self.state.object_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: object.as_entire_binding(),
                }],
            })
        });
        Ok(PresentationBuffers {
            cap,
            boundary,
            open_chains,
            identity_object,
            sections: geometry.sources,
        })
    }

    /// Index of the pipeline pair for this stroke width, creating and caching
    /// it on first sight.
    fn ensure_pipelines(
        &mut self,
        line_width_px: f32,
        wireframe: bool,
        features: ShaderFeatures,
    ) -> usize {
        let key = u64::from(line_width_px.to_bits() << 1 | u32::from(wireframe))
            | (u64::from(features.texture_mask) << 32)
            // The texture mask uses bits 32..49 (17 material map slots).
            | (u64::from(features.clearcoat) << 49)
            | (u64::from(features.anisotropy_sheen) << 50);
        if let Some(index) = self
            .state
            .pipelines
            .iter()
            .position(|(cached, _)| *cached == key)
        {
            return index;
        }
        if self.state.pipelines.len() >= MAX_CACHED_PIPELINE_PAIRS {
            // Oldest-first eviction; in-flight passes keep their pipelines
            // alive internally.
            self.state.pipelines.remove(0);
        }
        self.counters.pipeline_sets += 1;
        let pair = create_pipeline_pair(
            &self.state.device,
            &self.state.shader,
            &self.state.pipeline_layout,
            line_width_px,
            wireframe,
            features,
        );
        self.state.pipelines.push((key, pair));
        self.state.pipelines.len() - 1
    }

    fn ensure_ao_pipelines(&mut self, texture_mask: u32) {
        if self
            .state
            .ao_pipelines
            .as_ref()
            .is_some_and(|pipelines| pipelines.texture_mask == texture_mask)
        {
            return;
        }
        self.counters.pipeline_sets += 1;
        self.state.ao_pipelines = Some(create_ao_pipelines(
            &self.state.device,
            &self.state.queue,
            &self.state.shader,
            &self.state.pipeline_layout,
            texture_mask,
        ));
    }

    /// Keep the last-used target set; recreate on size change (R15 mixed-size
    /// plans cycle it within one job).
    fn ensure_targets(
        &mut self,
        width: u32,
        height: u32,
        transmission: bool,
        ao: bool,
        transparency: bool,
    ) {
        if let Some(targets) = &mut self.state.targets
            && targets.width == width
            && targets.height == height
            && targets.transmission == transmission
            && targets.ao.is_some() == ao
        {
            if targets.composite_view.is_some() != transparency {
                if let Some(old) = targets.composite_view.take() {
                    old.texture().destroy();
                }
                targets.composite_view =
                    transparency.then(|| composite_target(&self.state.device, targets.extent));
                let usage = if transparency {
                    wgpu::TextureUsages::RENDER_ATTACHMENT
                } else {
                    self.state.pass_local_usage
                };
                if targets.hdr_msaa.texture().usage() != usage {
                    let next = hdr_multisample_target(
                        &self.state.device,
                        targets.extent,
                        transparency,
                        self.state.pass_local_usage,
                    );
                    targets.hdr_msaa.texture().destroy();
                    targets.hdr_msaa = next;
                }
            }
            return;
        }
        #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
        let retired = self.state.targets.as_ref().map(profile::ledger);
        self.counters.target_allocations += 1;
        let device = &self.state.device;
        // Render targets: MSAA color + depth, single-sample sRGB resolve target.
        let extent = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let msaa_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("msaa"),
            size: extent,
            mip_level_count: 1,
            sample_count: MSAA_SAMPLES,
            dimension: wgpu::TextureDimension::D2,
            format: COLOR_FORMAT,
            usage: self.state.pass_local_usage,
            view_formats: &[],
        });
        let depth_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("depth"),
            size: extent,
            mip_level_count: 1,
            sample_count: MSAA_SAMPLES,
            dimension: wgpu::TextureDimension::D2,
            format: DEPTH_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let ao_targets = ao.then(|| {
            let texture = |label, format, usage| {
                let mut size = extent;
                if width * height > 1_048_576 && format == wgpu::TextureFormat::Rgba8Unorm {
                    size.width = width.div_ceil(2);
                    size.height = height.div_ceil(2);
                }
                device
                    .create_texture(&wgpu::TextureDescriptor {
                        label: Some(label),
                        size,
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format,
                        usage,
                        view_formats: &[],
                    })
                    .create_view(&wgpu::TextureViewDescriptor::default())
            };
            AoTargets {
                depth_view: texture(
                    "AO view depth",
                    wgpu::TextureFormat::R32Float,
                    wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                ),
                test_depth_view: texture(
                    "AO depth test",
                    DEPTH_FORMAT,
                    self.state.pass_local_usage,
                ),
                estimate_view: texture(
                    "AO estimate",
                    wgpu::TextureFormat::Rgba8Unorm,
                    wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                ),
                blur_view: texture(
                    "AO denoise",
                    wgpu::TextureFormat::Rgba8Unorm,
                    wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                ),
            }
        });
        let resolve_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("resolve"),
            size: extent,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: COLOR_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        let hdr_msaa =
            hdr_multisample_target(device, extent, transparency, self.state.pass_local_usage);
        let mip_count = if transmission {
            width.max(height).ilog2() + 1
        } else {
            1
        };
        let opaque_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("opaque HDR mip pyramid"),
            size: extent,
            mip_level_count: mip_count,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: HDR_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let opaque_levels: Vec<_> = (0..mip_count)
            .map(|level| {
                opaque_texture.create_view(&wgpu::TextureViewDescriptor {
                    base_mip_level: level,
                    mip_level_count: Some(1),
                    ..Default::default()
                })
            })
            .collect();
        let opaque_view = opaque_levels[0].clone();
        let opaque_mips = opaque_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let composite_view = transparency.then(|| composite_target(device, extent));

        // Start with one readback. Overlapping views acquire another on demand.
        let unpadded_bytes_per_row = width * 4;
        let padded_bytes_per_row = unpadded_bytes_per_row
            .div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        // Native renderers cross threads, so this is an `Arc`; wasm handles are
        // not `Send`, which is harmless on the single-threaded browser.
        #[cfg_attr(target_arch = "wasm32", allow(clippy::arc_with_non_send_sync))]
        let readback = vec![Arc::new(Readback::new(
            device,
            u64::from(padded_bytes_per_row) * u64::from(height),
        ))];

        self.state.targets = Some(SizedTargets {
            width,
            height,
            extent,
            hdr_msaa,
            opaque_view,
            opaque_mips,
            opaque_levels,
            transmission,
            ao: ao_targets,
            composite_view,
            msaa_view: msaa_texture.create_view(&wgpu::TextureViewDescriptor::default()),
            depth_view: depth_texture.create_view(&wgpu::TextureViewDescriptor::default()),
            resolve_view: resolve_texture.create_view(&wgpu::TextureViewDescriptor::default()),
            resolve_texture,
            readback,
            unpadded_bytes_per_row,
            padded_bytes_per_row,
        });
        #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
        if self
            .state
            .device
            .features()
            .contains(wgpu::Features::TIMESTAMP_QUERY)
        {
            let acquired = profile::ledger(self.state.targets.as_ref().expect("targets"));
            self.profile.borrow_mut().push(serde_json::json!({"event":"target-turnover", "retired":retired,
                "acquired":acquired, "overlapBytes":retired.as_ref().and_then(|v| v["targetBytes"].as_u64()).unwrap_or(0)
                    + acquired["targetBytes"].as_u64().unwrap()}));
        }
    }

    /// Submit one view's render pass and readback copy without waiting for it.
    /// The frame-uniform write and the submission ride the queue timeline in
    /// call order, so a single uniform buffer stays correct while views
    /// pipeline.
    fn begin_view(
        &mut self,
        scene: &SceneBuffers,
        presentation: &PresentationBuffers,
        entry: &PlanEntry,
    ) -> Result<InFlightView, RenderError> {
        #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
        let started = std::time::Instant::now();
        let options = &entry.options;
        let ao_active = options.ao.is_some_and(|ao| ao.intensity > 0.0);
        let camera = entry.prepared.camera;
        let mut opaque = Vec::new();
        let mut transparent = Vec::new();
        if options.surfaces {
            for instance in &scene.gpu_instances {
                let asset = &scene.gpu_assets[instance.mesh_index];
                for mesh in &asset.surfaces {
                    if !primitive_selected(
                        options,
                        instance.source_node_index,
                        asset.source_mesh_index,
                        mesh.source_primitive_index,
                    ) {
                        continue;
                    }
                    if mesh.transparent {
                        let depth = camera
                            .view
                            .transform_point3(instance.model.transform_point3(mesh.center))
                            .z;
                        transparent.push((depth, instance, mesh));
                    } else {
                        opaque.push((instance, mesh));
                    }
                }
            }
        }
        transparent.sort_by(|left, right| left.0.total_cmp(&right.0));
        let has_transparency = !transparent.is_empty();
        let has_transmission = transparent.iter().any(|(_, _, mesh)| mesh.transmission);
        validate_target_extent(options.width, options.height, &self.state.device.limits())?;
        self.ensure_targets(
            options.width,
            options.height,
            has_transmission,
            ao_active,
            has_transparency,
        );
        if ao_active {
            self.ensure_ao_pipelines(scene.features.texture_mask);
        }
        // Bias surfaces only when line geometry actually draws this view:
        // enabled model edges that survive `visiblePrimitives`, or a section
        // boundary (drawn unconditionally). Keying on `options.lines` alone —
        // or on line geometry the selection excludes — would fork the bytes of
        // otherwise identical renders. This mirrors the line pass's own draw
        // condition below; the two must stay in step.
        let wireframe = (options.lines
            && scene.gpu_instances.iter().any(|instance| {
                let asset = &scene.gpu_assets[instance.mesh_index];
                asset.lines.iter().any(|lines| {
                    primitive_selected(
                        options,
                        instance.source_node_index,
                        asset.source_mesh_index,
                        lines.source_primitive_index,
                    )
                })
            }))
            || presentation.boundary.is_some()
            || presentation.open_chains.is_some();
        let pipeline_index =
            self.ensure_pipelines(line_width_px(options), wireframe, scene.features);
        let slot = self
            .state
            .targets
            .as_mut()
            .expect("targets ensured")
            .acquire_readback(&self.state.device);
        let state = &self.state;
        let targets = state.targets.as_ref().expect("targets ensured above");
        let pair = &state.pipelines[pipeline_index].1;
        #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
        let mut probe = profile::Probe::new(
            &state.device,
            || serde_json::json!({"id":entry.id,"allocations":profile::ledger(targets)}),
            started,
        );

        let frame_data = frame_uniform(camera, options);
        state
            .queue
            .write_buffer(&state.frame_buffer, 0, bytemuck::cast_slice(&frame_data));

        let mut encoder = state
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("render"),
            });
        let scene_group = |opaque: &wgpu::TextureView,
                           composite: &wgpu::TextureView,
                           ao: &wgpu::TextureView| {
            state.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("capture material resources"),
                layout: &state.scene_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: scene.texture_pixels.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(opaque),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&state.scene_sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(composite),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(ao),
                    },
                    wgpu::BindGroupEntry {
                        binding: 5,
                        resource: wgpu::BindingResource::TextureView(if ao.texture().width() > 1 {
                            &targets.ao.as_ref().expect("AO").depth_view
                        } else {
                            &state.empty_scene
                        }),
                    },
                ],
            })
        };
        let empty_resources = scene_group(&state.empty_scene, &state.empty_scene, &state.empty_ao);
        let transmission_resources =
            scene_group(&targets.opaque_mips, &state.empty_scene, &state.empty_ao);
        // Each surface draws once. Transmission samples the retained opaque
        // HDR image; compositing precedes the sole display transform.
        for stage in 0..if has_transparency { 2 } else { 1 } {
            if stage == 1 && has_transmission {
                for levels in targets.opaque_levels.windows(2) {
                    let resources = scene_group(&levels[0], &state.empty_scene, &state.empty_ao);
                    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("transmission mip"),
                        #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
                        timestamp_writes: probe.as_mut().map(|p| p.pass("transmission mip")),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &levels[1],
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        ..Default::default()
                    });
                    pass.set_pipeline(&pair.mip);
                    pass.set_bind_group(0, &state.frame_bind_group, &[]);
                    pass.set_bind_group(1, &state.default_material, &[]);
                    pass.set_bind_group(2, &state.identity_object, &[]);
                    pass.set_bind_group(3, &resources, &[]);
                    pass.draw(0..3, 0..1);
                }
            }
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(if stage == 0 {
                    "opaque HDR"
                } else {
                    "transmission and alpha"
                }),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &targets.hdr_msaa,
                    depth_slice: None,
                    resolve_target: Some(if stage == 0 {
                        &targets.opaque_view
                    } else {
                        targets.composite_view.as_ref().expect("transparent target")
                    }),
                    ops: wgpu::Operations {
                        load: if stage == 0 {
                            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
                        } else {
                            wgpu::LoadOp::Load
                        },
                        store: if stage == 0 && has_transparency {
                            wgpu::StoreOp::Store
                        } else {
                            wgpu::StoreOp::Discard
                        },
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &targets.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: if stage == 0 {
                            wgpu::LoadOp::Clear(1.0)
                        } else {
                            wgpu::LoadOp::Load
                        },
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
                timestamp_writes: probe.as_mut().map(|p| {
                    p.pass(if stage == 0 {
                        "opaque HDR"
                    } else {
                        "transmission and alpha"
                    })
                }),
                #[cfg(not(all(feature = "bench", not(target_arch = "wasm32"))))]
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &state.frame_bind_group, &[]);
            pass.set_bind_group(
                3,
                if stage == 0 {
                    &empty_resources
                } else {
                    &transmission_resources
                },
                &[],
            );
            if stage == 0 {
                for (instance, mesh) in &opaque {
                    pass.set_pipeline(if mesh.constant_attributes {
                        &pair.constant_mesh
                    } else {
                        &pair.mesh
                    });
                    draw_surface(&mut pass, instance, mesh);
                }
                if has_transmission && options.lines {
                    pass.set_pipeline(&pair.transmission_line);
                    draw_lines(&mut pass, scene, options);
                }
            } else {
                for (_, instance, mesh) in &transparent {
                    pass.set_pipeline(match (mesh.constant_attributes, mesh.alpha_blend) {
                        (true, true) => &pair.constant_blend_mesh,
                        (true, false) => &pair.constant_mesh,
                        (false, true) => &pair.blend_mesh,
                        (false, false) => &pair.mesh,
                    });
                    draw_surface(&mut pass, instance, mesh);
                }
            }
        }
        if let (Some(ao), Some(ao_targets)) = (options.ao, &targets.ao) {
            let pipelines = state
                .ao_pipelines
                .as_ref()
                .expect("AO pipelines ensured above");
            let radius = ao.radius_pixels.unwrap_or_else(|| {
                ((options.width as f32).hypot(options.height as f32) * 0.01).max(4.0)
            });
            let mut ao_frame = [0f32; 40];
            ao_frame[..16].copy_from_slice(&camera.projection.to_cols_array());
            ao_frame[16..32].copy_from_slice(&camera.projection.inverse().to_cols_array());
            ao_frame[32..36].copy_from_slice(&[
                options.width as f32,
                options.height as f32,
                radius,
                ao.distance_falloff,
            ]);
            ao_frame[37] = options.width as f32 / ao_targets.estimate_view.texture().width() as f32;
            ao_frame[38] =
                options.height as f32 / ao_targets.estimate_view.texture().height() as f32;
            ao_frame[36] =
                f32::from(camera_projection_kind(&options.camera) == Projection::Orthographic);
            state
                .queue
                .write_buffer(&pipelines.frame_buffer, 0, bytemuck::cast_slice(&ao_frame));
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("AO opaque depth"),
                    #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
                    timestamp_writes: probe.as_mut().map(|p| p.pass("AO opaque depth")),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &ao_targets.depth_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &ao_targets.test_depth_view,
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(1.0),
                            store: wgpu::StoreOp::Discard,
                        }),
                        stencil_ops: None,
                    }),
                    ..Default::default()
                });
                pass.set_bind_group(0, &state.frame_bind_group, &[]);
                pass.set_bind_group(3, &empty_resources, &[]);
                for (instance, mesh) in &opaque {
                    pass.set_pipeline(if mesh.constant_attributes {
                        &pipelines.depth_constant_mesh
                    } else {
                        &pipelines.depth_mesh
                    });
                    draw_surface(&mut pass, instance, mesh);
                }
            }
            // The shader filters by resolution mode in separate entry points.
            let blur = if ao_frame[37] > 1.0 || ao_frame[38] > 1.0 {
                &pipelines.separable_blur
            } else {
                &pipelines.blur
            };
            for (label, output, input, pipeline) in [
                (
                    "AO hemisphere",
                    &ao_targets.estimate_view,
                    &state.empty_ao,
                    &pipelines.estimate,
                ),
                (
                    "AO denoise first",
                    &ao_targets.blur_view,
                    &ao_targets.estimate_view,
                    &blur[0],
                ),
                (
                    "AO denoise second",
                    &ao_targets.estimate_view,
                    &ao_targets.blur_view,
                    &blur[1],
                ),
            ] {
                let resources = state.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some(label),
                    layout: &pipelines.layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: pipelines.frame_buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&ao_targets.depth_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::TextureView(input),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: wgpu::BindingResource::Sampler(&pipelines.sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 4,
                            resource: wgpu::BindingResource::TextureView(&pipelines.blue_noise),
                        },
                    ],
                });
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some(label),
                    #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
                    timestamp_writes: probe.as_mut().map(|p| p.pass(label)),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: output,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::WHITE),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &resources, &[]);
                pass.draw(0..3, 0..1);
            }
        }
        let final_resources = scene_group(
            &state.empty_scene,
            if has_transparency {
                targets.composite_view.as_ref().expect("transparent target")
            } else {
                &targets.opaque_view
            },
            targets
                .ao
                .as_ref()
                .map_or(&state.empty_ao, |ao| &ao.estimate_view),
        );
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("display transform and exact edges"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &targets.msaa_view,
                    depth_slice: None,
                    resolve_target: Some(&targets.resolve_view),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Discard,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &targets.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
                timestamp_writes: probe
                    .as_mut()
                    .map(|p| p.pass("display transform and exact edges")),
                #[cfg(not(all(feature = "bench", not(target_arch = "wasm32"))))]
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &state.frame_bind_group, &[]);
            pass.set_bind_group(3, &final_resources, &[]);
            pass.set_bind_group(1, &state.default_material, &[]);
            pass.set_bind_group(2, &state.identity_object, &[]);
            pass.set_pipeline(&pair.screen);
            pass.draw(0..3, 0..1);
            if let Some(cap) = &presentation.cap {
                pass.set_pipeline(&pair.cap);
                pass.set_vertex_buffer(0, cap.vertices.slice(..));
                pass.set_index_buffer(cap.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..cap.index_count, 0, 0..1);
            }
            if options.lines {
                pass.set_pipeline(&pair.line);
                draw_lines(&mut pass, scene, options);
            }
            if let Some(object) = &presentation.identity_object {
                for stroke in [&presentation.boundary, &presentation.open_chains]
                    .into_iter()
                    .flatten()
                {
                    pass.set_pipeline(&pair.line);
                    pass.set_bind_group(1, &stroke.material, &[]);
                    pass.set_bind_group(2, object, &[]);
                    pass.set_vertex_buffer(0, stroke.segments.slice(..));
                    pass.draw(0..8, 0..stroke.count);
                }
            }
        }
        let readback = &targets.readback[slot];
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &targets.resolve_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(targets.padded_bytes_per_row),
                    rows_per_image: Some(options.height),
                },
            },
            targets.extent,
        );
        #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
        if let Some(probe) = &probe {
            probe.resolve(&mut encoder);
        }
        let submission = state.queue.submit(Some(encoder.finish()));
        #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
        if let Some(probe) = &mut probe {
            probe.map();
        }

        let (sender, receiver) = futures_channel::oneshot::channel();
        readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });

        let in_flight = InFlightView {
            #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
            probe,
            buffer: readback.clone(),
            receiver,
            submission,
            height: options.height,
            unpadded_bytes_per_row: targets.unpadded_bytes_per_row,
            padded_bytes_per_row: targets.padded_bytes_per_row,
            opaque_background: clear_color(options).a == 1.0,
        };
        Ok(in_flight)
    }

    /// De-pad the mapped readback rows into tightly packed RGBA.
    fn read_back(&self, view: &InFlightView) -> Result<Rendered, RenderError> {
        let slice = view.buffer.slice(..);
        let mut rgba = {
            #[cfg(not(target_arch = "wasm32"))]
            let mut rgba = Vec::with_capacity((view.unpadded_bytes_per_row * view.height) as usize);
            let data = slice.get_mapped_range().map_err(mapped_range_error)?;
            #[cfg(not(target_arch = "wasm32"))]
            {
                for row in 0..view.height {
                    let start = (row * view.padded_bytes_per_row) as usize;
                    rgba.extend_from_slice(
                        &data[start..start + view.unpadded_bytes_per_row as usize],
                    );
                }
                rgba
            }
            #[cfg(target_arch = "wasm32")]
            {
                // Dereferencing BufferView on WebGPU lazily copies the entire
                // mapping into a temporary WASM Vec. Copy from the JS mapping
                // directly into the owned image instead, before dropping/unmapping.
                let bytes = data.as_uint8array();
                if view.padded_bytes_per_row == view.unpadded_bytes_per_row {
                    bytes.to_vec()
                } else {
                    let row_bytes = view.unpadded_bytes_per_row as usize;
                    let mut rgba = vec![0; row_bytes * view.height as usize];
                    for (row, output) in rgba.chunks_exact_mut(row_bytes).enumerate() {
                        let start = row as u32 * view.padded_bytes_per_row;
                        bytes
                            .subarray(start, start + view.unpadded_bytes_per_row)
                            .copy_to(output);
                    }
                    rgba
                }
            }
        };
        view.buffer.unmap();
        self.take_uncaptured()?;
        // The sRGB target stores encoded premultiplied-linear RGB. Convert to
        // the public straight-alpha contract after every cap/edge blend and MSAA
        // resolve, rather than unpremultiplying the surface pass prematurely.
        // The display pass composites every sample over the requested background;
        // an opaque background therefore resolves to alpha 255, including lines,
        // transparent surfaces and transmission. Its straight RGB is already final.
        // Snapshot this per submitted view: a later overlapping view may differ.
        if !view.opaque_background {
            for pixel in rgba.as_chunks_mut::<4>().0 {
                let alpha = pixel[3];
                if alpha > 0 && alpha < 255 {
                    for channel in &mut pixel[..3] {
                        *channel = crate::texture::encoded(
                            crate::texture::linear(*channel, true) * 255.0 / f32::from(alpha),
                            true,
                        );
                    }
                }
            }
        }
        Ok(Rendered {
            rgba,
            width: view.unpadded_bytes_per_row / 4,
            height: view.height,
        })
    }

    /// Wait for one in-flight view and read its pixels back (native: blocks on
    /// the submission's poll, which also delivers the map callback).
    #[cfg(not(target_arch = "wasm32"))]
    fn finish_view_blocking(&self, mut view: InFlightView) -> Result<Rendered, RenderError> {
        if let Err(error) = self.state.device.poll(wgpu::PollType::Wait {
            submission_index: Some(view.submission.clone()),
            timeout: None,
        }) {
            // A submission that failed validation never advances the device's
            // successful-submission index, so the wait fails with a symptom
            // ("submission index … not returned"); the uncaptured handler
            // already holds the cause, and that is the message to surface.
            self.take_uncaptured()?;
            return Err(poll_error(error));
        }
        // A callback that is missing after the awaited poll is a wgpu contract
        // violation, but not a reason to panic the host process: the wasm
        // sibling maps the same condition to `gpu:`, so this path does too.
        view.receiver
            .try_recv()
            .ok()
            .flatten()
            .ok_or(RenderError::Gpu("map_async: callback dropped".into()))?
            .map_err(|error| map_error(error, self.take_uncaptured().err()))?;
        #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
        if let Some(probe) = &view.probe {
            let mut receipt = probe.read(self.state.queue.get_timestamp_period())?;
            let copy_started = std::time::Instant::now();
            let image = self.read_back(&view)?;
            receipt["cpuReadbackCopyMs"] =
                serde_json::json!(copy_started.elapsed().as_secs_f64() * 1000.0);
            self.profile.borrow_mut().push(receipt);
            return Ok(image);
        }
        self.read_back(&view)
    }

    /// Wait for one in-flight view and read its pixels back (wasm: the browser
    /// event loop delivers the map callback while other work proceeds).
    #[cfg(target_arch = "wasm32")]
    async fn finish_view(&self, mut view: InFlightView) -> Result<Rendered, RenderError> {
        (&mut view.receiver)
            .await
            .map_err(|_| RenderError::Gpu("map_async: callback dropped".into()))?
            .map_err(|error| map_error(error, self.take_uncaptured().err()))?;
        self.read_back(&view)
    }

    /// Render one plan entry to raw pixels (overlay stamped, no encode).
    pub(crate) async fn render_entry_to_rgba(
        &mut self,
        scene: &SceneBuffers,
        presentation: &PresentationBuffers,
        entry: &PlanEntry,
    ) -> Result<Rendered, RenderError> {
        let in_flight = self.begin_view(scene, presentation, entry)?;
        #[cfg(not(target_arch = "wasm32"))]
        let mut rendered = self.finish_view_blocking(in_flight)?;
        #[cfg(target_arch = "wasm32")]
        let mut rendered = self.finish_view(in_flight).await?;
        if crate::annotated(&entry.options) {
            crate::capture_overlay::stamp_capture_overlay(
                &mut rendered,
                &entry.prepared,
                &mut Vec::new(),
            );
        }
        Ok(rendered)
    }

    /// THE render loop: every layer funnels a plan through here, so the
    /// executor's scheduling covers every consumer. View N+1's GPU pass is
    /// submitted before view N's pixels are consumed; on native, encodes fan
    /// out across scoped threads while the GPU keeps rendering.
    pub(crate) async fn execute_plan(
        &mut self,
        scene: &SceneBuffers,
        presentation: &PresentationBuffers,
        plan: &[PlanEntry],
        now: Option<&(dyn Fn() -> f64 + Sync)>,
    ) -> Result<(Vec<Vec<u8>>, Vec<ViewTimings>), RenderError> {
        if plan.len() == 1
            && let Some(targets) = &mut self.state.targets
        {
            targets.readback.truncate(1);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.execute_plan_native(scene, presentation, plan, now)
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.execute_plan_wasm(scene, presentation, plan, now).await
        }
    }

    /// Wait for one pipelined view (when there is one) and hand its frame to
    /// the encode workers. Shared by the loop body and the final flush so the
    /// executor has exactly one resolve path.
    #[cfg(not(target_arch = "wasm32"))]
    fn resolve_pending(
        &self,
        plan: &[PlanEntry],
        pending: Option<(usize, f64, InFlightView)>,
        sender: &std::sync::mpsc::Sender<(usize, Rendered, f64)>,
        now: Option<&(dyn Fn() -> f64 + Sync)>,
    ) -> Result<(), RenderError> {
        let Some((index, started, in_flight)) = pending else {
            return Ok(());
        };
        let finished = with_view_result(self.finish_view_blocking(in_flight), &plan[index].id);
        let elapsed = now.map_or(0.0, |clock| clock()) - started;
        let _ = sender.send((index, finished?, elapsed));
        Ok(())
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn execute_plan_native(
        &mut self,
        scene: &SceneBuffers,
        presentation: &PresentationBuffers,
        plan: &[PlanEntry],
        now: Option<&(dyn Fn() -> f64 + Sync)>,
    ) -> Result<(Vec<Vec<u8>>, Vec<ViewTimings>), RenderError> {
        let clock = |now: Option<&(dyn Fn() -> f64 + Sync)>| now.map_or(0.0, |clock| clock());
        if let [entry] = plan {
            // Single view: no pipelining or worker to win anything with.
            let render_started = clock(now);
            let in_flight = self.begin_view(scene, presentation, entry)?;
            let rendered = with_view_result(self.finish_view_blocking(in_flight), &entry.id)?;
            let (bytes, timings) = encode_entry(
                entry,
                rendered,
                clock(now) - render_started,
                now,
                &mut Vec::new(),
            )?;
            return Ok((vec![bytes], vec![timings]));
        }

        type Slot = Option<Result<(Vec<u8>, ViewTimings), RenderError>>;
        let results: Mutex<Vec<Slot>> = Mutex::new((0..plan.len()).map(|_| None).collect());
        let workers = std::thread::available_parallelism()
            .map_or(1, std::num::NonZero::get)
            .min(plan.len())
            .min(8);
        let (sender, receiver) = std::sync::mpsc::channel::<(usize, Rendered, f64)>();
        let receiver = Mutex::new(receiver);
        let render_result = std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| {
                    let mut scratch = Vec::new();
                    loop {
                        let job = {
                            let receiver = receiver
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            receiver.recv()
                        };
                        let Ok((index, rendered, render)) = job else {
                            return;
                        };
                        let result =
                            encode_entry(&plan[index], rendered, render, now, &mut scratch);
                        results
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)[index] =
                            Some(result);
                    }
                });
            }

            let mut submit = |sender: &std::sync::mpsc::Sender<(usize, Rendered, f64)>| {
                let mut pending: Option<(usize, f64, InFlightView)> = None;
                for (index, entry) in plan.iter().enumerate() {
                    let started = clock(now);
                    let in_flight = self.begin_view(scene, presentation, entry)?;
                    let previous = pending.replace((index, started, in_flight));
                    self.resolve_pending(plan, previous, sender, now)?;
                }
                self.resolve_pending(plan, pending.take(), sender, now)
            };
            let outcome = submit(&sender);
            drop(sender);
            outcome
        });
        render_result?;

        let mut images = Vec::with_capacity(plan.len());
        let mut timings = Vec::with_capacity(plan.len());
        // In plan order so a failing view reports deterministically even when
        // encodes completed out of order.
        for slot in results
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            let (bytes, view_timings) =
                slot.expect("every submitted view is encoded before the scope joins")?;
            images.push(bytes);
            timings.push(view_timings);
        }
        Ok((images, timings))
    }

    #[cfg(target_arch = "wasm32")]
    async fn execute_plan_wasm(
        &mut self,
        scene: &SceneBuffers,
        presentation: &PresentationBuffers,
        plan: &[PlanEntry],
        now: Option<&(dyn Fn() -> f64 + Sync)>,
    ) -> Result<(Vec<Vec<u8>>, Vec<ViewTimings>), RenderError> {
        let clock = |now: Option<&(dyn Fn() -> f64 + Sync)>| now.map_or(0.0, |clock| clock());
        let mut images = Vec::with_capacity(plan.len());
        let mut timings = Vec::with_capacity(plan.len());
        let mut scratch = Vec::new();
        let mut pending: Option<(usize, f64, InFlightView)> = None;
        // Submit view N+1 before consuming view N, so the GPU renders under
        // the CPU's de-pad + overlay + encode of the previous view.
        for (index, entry) in plan.iter().enumerate() {
            let started = clock(now);
            let in_flight = self.begin_view(scene, presentation, entry)?;
            if let Some((prev_index, prev_started, prev_flight)) =
                pending.replace((index, started, in_flight))
            {
                let rendered =
                    with_view_result(self.finish_view(prev_flight).await, &plan[prev_index].id)?;
                let (bytes, view_timings) = encode_entry(
                    &plan[prev_index],
                    rendered,
                    clock(now) - prev_started,
                    now,
                    &mut scratch,
                )?;
                images.push(bytes);
                timings.push(view_timings);
            }
        }
        if let Some((index, started, in_flight)) = pending.take() {
            let rendered = with_view_result(self.finish_view(in_flight).await, &plan[index].id)?;
            let (bytes, view_timings) = encode_entry(
                &plan[index],
                rendered,
                clock(now) - started,
                now,
                &mut scratch,
            )?;
            images.push(bytes);
            timings.push(view_timings);
        }
        Ok((images, timings))
    }
}

/// Stamp the overlay (when requested) and encode one finished view. Pure CPU:
/// safe to run on worker threads.
fn encode_entry(
    entry: &PlanEntry,
    mut rendered: Rendered,
    render: f64,
    now: Option<&(dyn Fn() -> f64 + Sync)>,
    scratch: &mut Vec<u8>,
) -> Result<(Vec<u8>, ViewTimings), RenderError> {
    let clock = |now: Option<&(dyn Fn() -> f64 + Sync)>| now.map_or(0.0, |clock| clock());
    let overlay_started = clock(now);
    if crate::annotated(&entry.options) {
        crate::capture_overlay::stamp_capture_overlay(&mut rendered, &entry.prepared, scratch);
    }
    let overlay = clock(now) - overlay_started;
    let encode_started = clock(now);
    let bytes = with_view_result(encode_owned(rendered, entry.format), &entry.id)?;
    Ok((
        bytes,
        ViewTimings {
            render,
            overlay,
            encode: clock(now) - encode_started,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::encode;
    use glam::Vec2;

    fn scene() -> glb::Scene {
        let segments = [
            [[-1.0, -1.0, -1.0], [1.0, -1.0, -1.0]],
            [[-1.0, 1.0, -1.0], [1.0, 1.0, -1.0]],
            [[-1.0, -1.0, 1.0], [1.0, -1.0, 1.0]],
            [[-1.0, 1.0, 1.0], [1.0, 1.0, 1.0]],
        ];
        line_scene(&segments)
    }

    #[test]
    fn camera_visitor_skips_repeated_indices_without_changing_draw_visits() {
        let mut source = line_scene(&[[[0.0, 0.0, 0.0], [1.0, 2.0, 3.0]]]);
        source.meshes[0].primitives[0].indices = vec![0, 1, 0, 1, 1, 0];
        // An unreferenced nonfinite/outlying position must never enter camera fitting.
        source.meshes[0].primitives[0]
            .positions
            .extend([f32::NAN, 1.0e30, 0.0]);
        let mut instance = source.instances[0].clone();
        instance.source_node_index = 1;
        instance.model = Mat4::from_translation(Vec3::X * 10.0);
        source.instances.push(instance);
        let options = RenderOptions::default();
        let mut draws = Vec::new();
        source
            .for_each_position(&options, &mut |p| draws.push(p))
            .expect("draws");
        assert_eq!(draws.len(), 12);
        let mut positions = glb::UniquePositions::new(&source);
        for _ in 0..3 {
            let mut unique = Vec::new();
            assert!(
                positions
                    .for_each_position(&options, &mut |p| unique.push(p))
                    .expect("camera")
            );
            assert_eq!(
                unique,
                vec![
                    Vec3::ZERO,
                    Vec3::new(1.0, 2.0, 3.0),
                    Vec3::new(10.0, 0.0, 0.0),
                    Vec3::new(11.0, 2.0, 3.0)
                ]
            );
        }
        let visits = std::cell::Cell::new(0);
        let mut visit = |_| visits.set(visits.get() + 1);
        assert!(
            positions
                .for_each_position(&options, &mut visit)
                .expect("visible")
        );
        assert!(visits.get() > 0);
        visits.set(0);
        for options in [
            RenderOptions {
                lines: false,
                ..options.clone()
            },
            RenderOptions {
                visible_primitives: Some(vec![]),
                ..options
            },
        ] {
            assert!(
                !positions
                    .for_each_position(&options, &mut visit)
                    .expect("hidden")
            );
        }
        assert_eq!(visits.get(), 0, "hidden visitors must not run");
        drop(positions);
        source.meshes[0].primitives[0].indices = vec![2, 0];
        assert_eq!(
            glb::UniquePositions::new(&source)
                .for_each_position(&RenderOptions::default(), &mut visit),
            Err("transformed POSITION values must be finite".into())
        );
    }

    #[test]
    fn unique_camera_matrices_match_full_draw_index_reference() {
        let mut sources = vec![
            glb::parse_glb(include_bytes!("../../../tests/fixtures/gear-12.glb")).expect("gear"),
            glb::parse_glb(include_bytes!(
                "../../../tests/fixtures/interleaved-instanced-lines.glb"
            ))
            .expect("instances"),
        ];
        for scale in [0.0_f32, 1.0e-12, 1.0, 1.0e12] {
            let mut source = line_scene(&[
                [[-scale, 0.0, -0.0], [scale, -0.0, 0.0]],
                [[0.0, scale, -scale], [-0.0, -scale, scale]],
            ]);
            source.meshes[0].primitives[0].indices = vec![0, 1, 0, 2, 1, 3, 0, 3];
            sources.push(source);
        }
        let bits = |camera: CameraState| {
            camera
                .view
                .to_cols_array()
                .into_iter()
                .chain(camera.projection.to_cols_array())
                .chain(camera.forward.to_array())
                .chain([camera.target_depth])
                .map(f32::to_bits)
                .collect::<Vec<_>>()
        };
        for source in &sources {
            let mut unique = glb::UniquePositions::new(source);
            let mut reference = glb::UniquePositions::all(source);
            for (direction, up) in [
                ([1.2, -1.7, 4.2], [0.0, 1.0, 0.0]),
                ([0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
                ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
            ] {
                for projection in [
                    CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    },
                    CameraProjection::Perspective {
                        vertical_field_of_view_deg: 160.0,
                        zoom: 2.0,
                    },
                    CameraProjection::Orthographic {
                        vertical_span: None,
                        zoom: 1.0,
                    },
                ] {
                    for surfaces in [false, true] {
                        let options = RenderOptions {
                            width: 5120,
                            height: 2880,
                            surfaces,
                            camera: RenderCamera::Fit {
                                direction,
                                up,
                                padding_factor: 0.9,
                                projection,
                            },
                            ..RenderOptions::default()
                        };
                        let bounds = source.presented_bounds(&options);
                        assert!(
                            bounds.is_some(),
                            "fixture must exercise the camera reduction"
                        );
                        assert_eq!(
                            bits(camera_state_with_bounds(&mut unique, &options, bounds)),
                            bits(camera_state_with_bounds(&mut reference, &options, bounds))
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn camera_extents_preserve_extremes_signed_zero_and_empty_depth_fallback() {
        for points in [
            [[-0.0, 0.0, -0.0], [0.0, -0.0, 0.0]],
            [[1.0e-20, -1.0e-20, -1.0e-20], [-1.0e-20, 1.0e-20, 1.0e-20]],
            [[-1.0e20, 1.0e20, -1.0e20], [1.0e20, -1.0e20, 1.0e20]],
            [[1.0, 2.0, 3.0], [-1.0, -2.0, 4.0]],
        ] {
            let scene = line_scene(&[points]);
            let options = RenderOptions::default();
            for view in [
                Mat4::IDENTITY,
                Mat4::from_translation(Vec3::new(1.0, -2.0, 3.0)),
            ] {
                let mut nearest = f32::INFINITY;
                let mut farthest = 0.0_f32;
                scene
                    .for_each_position(&options, &mut |p| {
                        let depth = -view.transform_point3(p).z;
                        if depth > 0.0 {
                            nearest = nearest.min(depth);
                            farthest = farthest.max(depth);
                        }
                    })
                    .expect("finite world positions");
                let mut xy = [0.0_f32; 2];
                scene
                    .for_each_position(&options, &mut |p| {
                        let p = view.transform_point3(p);
                        xy[0] = xy[0].max(p.x.abs());
                        xy[1] = xy[1].max(p.y.abs());
                    })
                    .expect("finite world positions");
                let fused =
                    camera_extents::<true>(&mut glb::UniquePositions::new(&scene), &options, view);
                assert_eq!(
                    [fused.nearest, fused.farthest, fused.max_x, fused.max_y].map(f32::to_bits),
                    [nearest, farthest, xy[0], xy[1]].map(f32::to_bits)
                );
                for fallback in [-2.0_f32, 0.0, 10.0] {
                    let expected = if farthest <= 0.0 {
                        let depth = fallback.max(1.0);
                        (depth * 0.001, depth * 2.0)
                    } else {
                        let near = (nearest * 0.5).max(farthest * 1e-6).max(f32::MIN_POSITIVE);
                        (near, (farthest * 2.0).max(near * 2.0))
                    };
                    for actual in [
                        fused.clip_planes(fallback),
                        position_clip_planes(
                            &mut glb::UniquePositions::new(&scene),
                            &options,
                            view,
                            fallback,
                        ),
                    ] {
                        assert_eq!(
                            [actual.0, actual.1].map(f32::to_bits),
                            [expected.0, expected.1].map(f32::to_bits)
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn camera_extents_match_full_transform_bits_for_affine_views() {
        // Compare each point independently: aggregate extrema could hide a rounding
        // difference that changes near/far when a different vertex becomes nearest.
        let mut state = 0x913a_7bd5_u32;
        let mut next = || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state as i32 as f32) / i32::MAX as f32
        };
        let mut points = vec![Vec3::ZERO, Vec3::splat(-0.0)];
        for scale in [1.0e-20, 1.0e-6, 1.0, 1.0e6, 1.0e20] {
            for _ in 0..128 {
                points.push(Vec3::new(next(), next(), next()) * scale);
            }
        }
        for view in [
            Mat4::IDENTITY,
            Mat4::from_translation(Vec3::new(-3.7, 2.1, -0.01)),
            glam::camera::rh::view::look_at_mat4(Vec3::new(1.2, -1.7, 4.2), Vec3::ZERO, Vec3::Y),
            glam::camera::rh::view::look_at_mat4(Vec3::new(-9.3, 0.1, -0.2), Vec3::ONE, Vec3::Z),
            Mat4::from_scale_rotation_translation(
                Vec3::new(-1.0e-3, 7.1, 1.0e3),
                glam::Quat::from_euler(glam::EulerRot::XYZ, 0.7, -1.3, 2.9),
                Vec3::new(0.3, -0.2, 1.1),
            ),
        ] {
            for point in &points {
                let scene = line_scene(&[[point.to_array(), point.to_array()]]);
                for options in [
                    RenderOptions::default(),
                    RenderOptions {
                        lines: false,
                        ..RenderOptions::default()
                    },
                ] {
                    let full = camera_extents::<true>(
                        &mut glb::UniquePositions::new(&scene),
                        &options,
                        view,
                    );
                    // Keep the reference independent of both optimized paths.
                    // Per-point XYZ checks catch differences hidden by aggregate maxima.
                    let mut expected = [f32::INFINITY, 0.0_f32, 0.0_f32, 0.0_f32];
                    scene
                        .for_each_position(&options, &mut |position| {
                            let camera = view.transform_point3(position);
                            let depth = -camera.z;
                            if depth > 0.0 {
                                expected[0] = expected[0].min(depth);
                                expected[1] = expected[1].max(depth);
                            }
                            expected[2] = expected[2].max(camera.x.abs());
                            expected[3] = expected[3].max(camera.y.abs());
                        })
                        .expect("finite world positions");
                    assert_eq!(
                        [full.nearest, full.farthest, full.max_x, full.max_y].map(f32::to_bits),
                        expected.map(f32::to_bits),
                        "point={point:?}, view={view:?}",
                    );
                    let depth = camera_extents::<false>(
                        &mut glb::UniquePositions::new(&scene),
                        &options,
                        view,
                    );
                    assert_eq!(
                        [depth.nearest, depth.farthest].map(f32::to_bits),
                        [full.nearest, full.farthest].map(f32::to_bits),
                        "point={point:?}, view={view:?}",
                    );
                    assert_eq!([depth.max_x, depth.max_y], [0.0, 0.0]);
                    for fallback in [0.0, 1.0e-6, 1000.0] {
                        let a = depth.clip_planes(fallback);
                        let b = full.clip_planes(fallback);
                        assert_eq!([a.0, a.1].map(f32::to_bits), [b.0, b.1].map(f32::to_bits));
                    }
                }
            }
        }
    }

    #[test]
    fn fitted_orthographic_projection_matches_separate_draw_reductions() {
        let scene = glb::parse_glb(include_bytes!(
            "../../../tests/fixtures/interleaved-instanced-lines.glb"
        ))
        .expect("fixture");
        for (width, height) in [(5120, 2880), (432, 768), (8192, 1)] {
            for (direction, up) in [
                ([1.2, -1.7, 4.2], [0.0, 1.0, 0.0]),
                ([0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
                ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
            ] {
                for surfaces in [false, true] {
                    for padding in [0.001, 0.9, 1.0] {
                        let options = RenderOptions {
                            width,
                            height,
                            surfaces,
                            camera: RenderCamera::Fit {
                                direction,
                                up,
                                padding_factor: padding,
                                projection: CameraProjection::Orthographic {
                                    vertical_span: None,
                                    zoom: 1.0,
                                },
                            },
                            ..RenderOptions::default()
                        };
                        let camera = camera_state(&scene, &options);
                        let (min, max) = scene.presented_bounds(&options).expect("bounds");
                        let center = (Vec3::from(min) + Vec3::from(max)) * 0.5;
                        let radius = (Vec3::from(max) - center).length();
                        // Independent original two-pass reference: retain transform and reduction order.
                        let mut nearest = f32::INFINITY;
                        let mut farthest = 0.0_f32;
                        scene
                            .for_each_position(&options, &mut |p| {
                                let depth = -camera.view.transform_point3(p).z;
                                if depth > 0.0 {
                                    nearest = nearest.min(depth);
                                    farthest = farthest.max(depth);
                                }
                            })
                            .expect("depth positions");
                        let near = (nearest * 0.5).max(farthest * 1e-6).max(f32::MIN_POSITIVE);
                        let far = (farthest * 2.0).max(near * 2.0);
                        let mut xy = [0.0_f32; 2];
                        scene
                            .for_each_position(&options, &mut |p| {
                                let p = camera.view.transform_point3(p);
                                xy[0] = xy[0].max(p.x.abs());
                                xy[1] = xy[1].max(p.y.abs());
                            })
                            .expect("extent positions");
                        let minimum = (radius * 0.001).max(f32::MIN_POSITIVE);
                        let mut hw = (xy[0] / padding.max(0.001)).max(minimum);
                        let mut hh = (xy[1] / padding.max(0.001)).max(minimum);
                        let aspect = width as f32 / height as f32;
                        if hw / hh < aspect {
                            hw = hh * aspect;
                        } else {
                            hh = hw / aspect;
                        }
                        let expected = glam::camera::rh::proj::directx::orthographic(
                            -hw, hw, -hh, hh, near, far,
                        );
                        assert_eq!(
                            camera.projection.to_cols_array().map(f32::to_bits),
                            expected.to_cols_array().map(f32::to_bits)
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn raw_plan_encoding_transfers_the_finished_pixel_allocation() {
        for annotated in [false, true] {
            let options = RenderOptions {
                width: 128,
                height: 96,
                label: annotated.then(|| "A".into()),
                axes: annotated,
                ..RenderOptions::default()
            };
            let entry = PlanEntry {
                id: "owned-raw".into(),
                prepared: crate::capture_overlay::prepare_view(&scene(), &options)
                    .expect("prepared view"),
                options,
                format: ImageFormat::Raw,
            };
            let mut rgba = Vec::with_capacity(128 * 96 * 4 + 128);
            rgba.resize(128 * 96 * 4, 200);
            let allocation = rgba.as_ptr();
            let capacity = rgba.capacity();
            let rendered = Rendered {
                rgba,
                width: 128,
                height: 96,
            };
            let mut expected = Rendered {
                rgba: rendered.rgba.clone(),
                width: 128,
                height: 96,
            };
            if annotated {
                crate::capture_overlay::stamp_capture_overlay(
                    &mut expected,
                    &entry.prepared,
                    &mut Vec::new(),
                );
                assert_ne!(expected.rgba, rendered.rgba, "annotation must be exercised");
            }
            let (bytes, timings) =
                encode_entry(&entry, rendered, 7.0, None, &mut Vec::new()).expect("raw output");
            assert_eq!(bytes, expected.rgba);
            assert_eq!(
                bytes.as_ptr(),
                allocation,
                "owned raw output must not clone pixels"
            );
            assert_eq!(bytes.capacity(), capacity);
            assert_eq!(timings.render, 7.0);
        }
    }

    #[test]
    fn raw_plan_encoding_preserves_shape_errors_and_view_context() {
        let options = RenderOptions::default();
        let entry = PlanEntry {
            id: "invalid-raw".into(),
            prepared: crate::capture_overlay::prepare_view(&scene(), &options)
                .expect("prepared view"),
            options,
            format: ImageFormat::Raw,
        };
        for (width, height, len) in [
            (0, 1, 0),
            (1, 0, 0),
            (2, 1, 7),
            (1, 1, 5),
            (u32::MAX, u32::MAX, 4),
        ] {
            let rendered = Rendered {
                rgba: vec![0; len],
                width,
                height,
            };
            let expected = with_view_result(encode(&rendered, ImageFormat::Raw), &entry.id)
                .expect_err("borrowed shape error")
                .to_string();
            let error = encode_entry(&entry, rendered, 0.0, None, &mut Vec::new())
                .err()
                .expect("owned shape error");
            assert_eq!(error.to_string(), expected);
        }
    }

    fn assert_close(actual: Vec3, expected: Vec3) {
        assert!((actual - expected).length() < 1e-5);
    }

    fn assert_matrix_close(actual: Mat4, expected: Mat4) {
        for (actual, expected) in actual
            .to_cols_array()
            .into_iter()
            .zip(expected.to_cols_array())
        {
            assert!((actual - expected).abs() < 1e-5, "{actual} != {expected}");
        }
    }

    fn referenced_positions(scene: &glb::Scene) -> Vec<Vec3> {
        let mut positions = Vec::new();
        scene
            .for_each_position(&RenderOptions::default(), &mut |position| {
                positions.push(position)
            })
            .expect("positions");
        positions
    }

    fn fixed_camera(projection: CameraProjection) -> RenderCamera {
        RenderCamera::Fixed {
            position: [0.0, 0.0, 10.0],
            target: [0.0, 0.0, 0.0],
            up: [0.0, 1.0, 0.0],
            projection,
            clipping: Some(crate::ClipPlanes {
                near: 0.1,
                far: 100.0,
            }),
        }
    }

    fn line_scene(segments: &[[[f32; 3]; 2]]) -> glb::Scene {
        let (min, max) = segments.iter().flatten().fold(
            (Vec3::splat(f32::INFINITY), Vec3::splat(f32::NEG_INFINITY)),
            |(min, max), point| {
                let point = Vec3::from(*point);
                (min.min(point), max.max(point))
            },
        );
        let positions = segments
            .iter()
            .flat_map(|segment| segment.iter().flat_map(|point| point.iter().copied()))
            .collect::<Vec<_>>();
        let indices = (0..segments.len() as u32 * 2).collect();
        glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                manifold: None,
                primitives: vec![glb::Primitive {
                    source_index: 0,
                    mode: glb::MODE_LINES,
                    positions,
                    normals: Vec::new(),
                    indices,
                    surface_attributes: Vec::new(),
                    material: glb::Material {
                        base_color: [0.0, 0.0, 0.0, 1.0],
                        metallic: 0.0,
                        roughness: 1.0,
                        ..Material::default()
                    },
                }],
            }],
            instances: vec![glb::MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::IDENTITY,
                normal_matrix: Mat4::IDENTITY,
            }],
            topology_diagnostics: Vec::new(),
            texture_pixels: vec![u32::MAX],
            bounds: Some((min.to_array(), max.to_array())),
        }
    }

    fn asymmetric_scene() -> glb::Scene {
        let positions = vec![
            -3.0, -1.0, -2.0, 2.0, 4.0, 1.0, 5.0, 0.0, -1.0, -1.0, 2.0, 3.0, 100.0, 100.0, 100.0,
        ];
        glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                manifold: None,
                primitives: vec![glb::Primitive {
                    source_index: 0,
                    mode: glb::MODE_LINES,
                    positions,
                    normals: Vec::new(),
                    indices: vec![0, 1, 2, 3],
                    surface_attributes: Vec::new(),
                    material: glb::Material {
                        base_color: [0.0, 0.0, 0.0, 1.0],
                        metallic: 0.0,
                        roughness: 1.0,
                        ..Material::default()
                    },
                }],
            }],
            instances: vec![glb::MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::IDENTITY,
                normal_matrix: Mat4::IDENTITY,
            }],
            topology_diagnostics: Vec::new(),
            texture_pixels: vec![u32::MAX],
            bounds: Some(([-3.0, -1.0, -2.0], [5.0, 4.0, 3.0])),
        }
    }

    fn occluded_line_scene(include_line: bool) -> glb::Scene {
        let mut primitives = vec![glb::Primitive {
            source_index: 0,
            mode: glb::MODE_TRIANGLES,
            positions: vec![
                -1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0,
            ],
            normals: [0.0, 0.0, 1.0].repeat(4),
            indices: vec![0, 1, 2, 0, 2, 3],
            surface_attributes: Vec::new(),
            material: glb::Material {
                base_color: [0.8, 0.8, 0.8, 1.0],
                metallic: 0.0,
                roughness: 1.0,
                ..Material::default()
            },
        }];
        if include_line {
            primitives.push(glb::Primitive {
                source_index: 1,
                mode: glb::MODE_LINES,
                positions: vec![-0.8, 0.0, -0.5, 0.8, 0.0, -0.5],
                normals: Vec::new(),
                indices: vec![0, 1],
                surface_attributes: Vec::new(),
                material: glb::Material {
                    base_color: [0.0, 0.0, 0.0, 1.0],
                    metallic: 0.0,
                    roughness: 1.0,
                    ..Material::default()
                },
            });
        }
        glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                manifold: None,
                primitives,
            }],
            instances: vec![glb::MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::IDENTITY,
                normal_matrix: Mat4::IDENTITY,
            }],
            topology_diagnostics: Vec::new(),
            texture_pixels: vec![u32::MAX],
            bounds: Some(([-1.0, -1.0, -0.5], [1.0, 1.0, 0.0])),
        }
    }

    fn cube_scene() -> glb::Scene {
        let positions = vec![
            -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, 1.0,
            1.0, -1.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 1.0,
        ];
        glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                manifold: None,
                primitives: vec![glb::Primitive {
                    source_index: 0,
                    mode: glb::MODE_TRIANGLES,
                    normals: positions.clone(),
                    positions,
                    indices: vec![
                        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0,
                        1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
                    ],
                    surface_attributes: Vec::new(),
                    material: glb::Material {
                        base_color: [0.5, 0.5, 0.5, 1.0],
                        metallic: 0.0,
                        roughness: 1.0,
                        ..Material::default()
                    },
                }],
            }],
            instances: vec![glb::MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::IDENTITY,
                normal_matrix: Mat4::IDENTITY,
            }],
            topology_diagnostics: Vec::new(),
            texture_pixels: vec![u32::MAX],
            bounds: Some(([-1.0; 3], [1.0; 3])),
        }
    }

    fn render_test_scene(
        renderer: &mut Renderer,
        parsed: glb::Scene,
        options: RenderOptions,
    ) -> Rendered {
        let prepared = crate::capture_overlay::prepare_view(&parsed, &options).expect("camera");
        let entry = PlanEntry {
            id: "line".into(),
            options,
            format: ImageFormat::Raw,
            prepared,
        };
        let mut scene = Scene::new(parsed);
        let presentation = renderer
            .prepare_presentation(&scene.parsed, &entry.options)
            .expect("presentation");
        let buffers = renderer.ensure_uploaded(&mut scene).expect("line upload");
        let context = format!(
            "test render (texture_mask={:#x})",
            buffers.features.texture_mask
        );
        pollster::block_on(renderer.render_entry_to_rgba(buffers, &presentation, &entry))
            .expect(&context)
    }

    fn physical_sphere(material: Material) -> glb::Scene {
        let mut scene = cube_scene();
        let primitive = &mut scene.meshes[0].primitives[0];
        primitive.positions.clear();
        primitive.normals.clear();
        primitive.indices.clear();
        primitive.material = material;
        for row in 0..=32 {
            let theta = row as f32 * std::f32::consts::PI / 32.0;
            for column in 0..=64 {
                let phi = column as f32 * std::f32::consts::TAU / 64.0;
                let normal = [
                    theta.sin() * phi.cos(),
                    theta.cos(),
                    theta.sin() * phi.sin(),
                ];
                primitive.positions.extend(normal);
                primitive.normals.extend(normal);
                primitive.surface_attributes.push([
                    -phi.sin(),
                    0.0,
                    phi.cos(),
                    1.0,
                    column as f32 / 64.0,
                    row as f32 / 32.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    1.0,
                    1.0,
                    1.0,
                    1.0,
                ]);
                if row < 32 && column < 64 {
                    let a = row * 65 + column;
                    let b = a + 65;
                    primitive.indices.extend([a, a + 1, b, b, a + 1, b + 1]);
                }
            }
        }
        scene
    }

    fn physical_options() -> RenderOptions {
        RenderOptions {
            width: 96,
            height: 96,
            lines: false,
            camera: fixed_camera(CameraProjection::Orthographic {
                vertical_span: Some(2.4),
                zoom: 1.0,
            }),
            background: Some([1.0; 4]),
            ..RenderOptions::default()
        }
    }

    #[test]
    fn synthesised_flat_normals_match_authored_face_normals() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let options = RenderOptions {
            width: 96,
            height: 96,
            lines: false,
            ..RenderOptions::default()
        };
        let mut synthesised = cube_scene();
        let primitive = &mut synthesised.meshes[0].primitives[0];
        primitive.normals.clear();
        glb::flat_shade(primitive).expect("flat shade");
        // Reference: the same corners with hand-authored axis normals.
        let mut authored = synthesised.clone();
        let primitive = &mut authored.meshes[0].primitives[0];
        primitive.normals = primitive
            .positions
            .as_chunks::<9>()
            .0
            .iter()
            .flat_map(|corners| {
                let axis = (0..3)
                    .find(|&k| corners[k] == corners[k + 3] && corners[k] == corners[k + 6])
                    .expect("axis-aligned face");
                let mut normal = [0.0; 3];
                normal[axis] = corners[axis];
                normal.repeat(3)
            })
            .collect();
        let flat = render_test_scene(&mut renderer, synthesised, options.clone());
        assert_eq!(
            flat.rgba,
            render_test_scene(&mut renderer, authored, options.clone()).rgba
        );
        let smooth = render_test_scene(&mut renderer, cube_scene(), options);
        assert_ne!(flat.rgba, smooth.rgba);
    }

    #[test]
    fn ao_uses_opaque_depth_and_zero_intensity_keeps_baseline_pixels() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let scene = glb::parse_glb(include_bytes!("../../../tests/fixtures/gear-12.glb"))
            .expect("gear fixture");
        let options = RenderOptions {
            width: 256,
            height: 256,
            lines: false,
            ao: None,
            ..RenderOptions::default()
        };
        let off = render_test_scene(&mut renderer, scene.clone(), options.clone());
        let zero = render_test_scene(
            &mut renderer,
            scene.clone(),
            RenderOptions {
                ao: Some(crate::AmbientOcclusion {
                    radius_pixels: None,
                    intensity: 0.0,
                    distance_falloff: 0.2,
                }),
                ..options.clone()
            },
        );
        let on = render_test_scene(
            &mut renderer,
            scene,
            RenderOptions {
                ao: Some(crate::AmbientOcclusion {
                    radius_pixels: None,
                    intensity: 3.0,
                    distance_falloff: 0.2,
                }),
                ..options
            },
        );
        assert_eq!(zero.rgba, off.rgba);
        let changed = on
            .rgba
            .iter()
            .zip(&off.rgba)
            .filter(|(a, b)| a != b)
            .count();
        assert!(changed > 100, "AO changed only {changed} channels");
        // Per-vertex tangent/UV/color attributes select the other depth pipeline.
        let mut with_attributes = physical_options();
        with_attributes.ao = Some(crate::AmbientOcclusion {
            radius_pixels: None,
            intensity: 3.0,
            distance_falloff: 0.2,
        });
        render_test_scene(
            &mut renderer,
            physical_sphere(Material::default()),
            with_attributes,
        );
        renderer.take_uncaptured().expect("AO GPU validation");
    }

    #[test]
    fn ao_is_stable_across_cad_scene_scales() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let options = RenderOptions {
            width: 768,
            height: 576,
            lines: false,
            ao: Some(crate::AmbientOcclusion {
                radius_pixels: None,
                intensity: 3.0,
                distance_falloff: 0.2,
            }),
            ..RenderOptions::default()
        };
        let small_cube = glb::parse_glb(include_bytes!("../../../tests/fixtures/cad-mm-cube.glb"))
            .expect("small CAD cube");
        let without_ao = render_test_scene(
            &mut renderer,
            small_cube.clone(),
            RenderOptions {
                ao: None,
                ..options.clone()
            },
        );
        let small = render_test_scene(&mut renderer, small_cube.clone(), options.clone());
        let mut large_cube = small_cube;
        for primitive in &mut large_cube.meshes[0].primitives {
            for position in &mut primitive.positions {
                *position *= 100.0;
            }
        }
        let large = render_test_scene(&mut renderer, large_cube, options);
        let mut error = 0u64;
        let mut count = 0u64;
        for (a, b) in large
            .rgba
            .as_chunks::<4>()
            .0
            .iter()
            .zip(small.rgba.as_chunks::<4>().0.iter())
        {
            if a[3] == 255 && b[3] == 255 {
                error += u64::from(
                    (0..3)
                        .map(|channel| a[channel].abs_diff(b[channel]))
                        .max()
                        .unwrap(),
                );
                count += 1;
            }
        }
        assert!(count > 100_000, "only {count} overlapping opaque pixels");
        let mean_error = error as f64 / count as f64;
        assert!(
            mean_error < 3.0,
            "AO changed with scene scale: mean RGB error {mean_error}"
        );
        // The planar left wall is far from contact edges. The old absolute
        // normal threshold darkened it by ~25 levels at millimetre scale.
        let mut wall_error = 0u64;
        for y in 240..330 {
            for x in 230..320 {
                let offset = ((y * 768 + x) * 4) as usize;
                wall_error += u64::from(small.rgba[offset].abs_diff(without_ao.rgba[offset]));
            }
        }
        assert!(
            wall_error as f64 / 8_100.0 < 3.0,
            "AO falsely darkened the planar millimetre-scale wall"
        );
    }

    #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
    #[test]
    fn profiling_preserves_pixels_and_drains_receipts() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let image = render_test_scene(&mut renderer, cube_scene(), physical_options());
        let hash = image.rgba.iter().fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
        });
        println!("profile image hash: {hash}");
        let receipts = renderer.take_profile();
        assert!(renderer.take_profile().is_empty(), "diagnostics must drain");
        if renderer
            .state
            .device
            .features()
            .contains(wgpu::Features::TIMESTAMP_QUERY)
        {
            let frame = receipts
                .iter()
                .find(|r| r.get("passes").is_some())
                .expect("frame receipt");
            let passes = frame["passes"].as_array().unwrap();
            let begin = passes.first().unwrap()["beginTicks"].as_u64().unwrap();
            let end = passes.last().unwrap()["endTicks"].as_u64().unwrap();
            assert_eq!(frame["gpuSpanMs"].is_null(), begin == 0 || end < begin);
            for pass in passes {
                let begin = pass["beginTicks"].as_u64().unwrap();
                let end = pass["endTicks"].as_u64().unwrap();
                assert_eq!(pass["gpuMs"].is_null(), begin == 0 || end < begin);
            }
            assert!(frame["allocations"]["targetBytes"].as_u64().unwrap() > 0);
            let child =
                std::process::Command::new(std::env::current_exe().expect("test executable"))
                    .args([
                        "--exact",
                        "render::tests::profiling_preserves_pixels_and_drains_receipts",
                        "--nocapture",
                    ])
                    .env("NANORASTER_GPU_PROFILE", "0")
                    .output()
                    .expect("query-free child");
            let stderr = String::from_utf8_lossy(&child.stderr);
            assert!(child.status.success(), "{stderr}");
            assert!(
                String::from_utf8_lossy(&child.stdout)
                    .contains(&format!("profile image hash: {hash}")),
                "profiling changed pixels"
            );
        } else {
            assert!(
                receipts.is_empty(),
                "query-free invocation retained diagnostics"
            );
        }
    }

    #[test]
    fn large_ao_preserves_native_depth_and_edges_and_has_no_frame_history() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let scene = glb::parse_glb(include_bytes!("../../../tests/fixtures/gear-12.glb"))
            .expect("gear fixture");
        let options = RenderOptions {
            width: 1537,
            height: 865,
            ao: Some(crate::AmbientOcclusion {
                radius_pixels: None,
                intensity: 3.0,
                distance_falloff: 0.2,
            }),
            ..RenderOptions::default()
        };
        let first = render_test_scene(&mut renderer, scene.clone(), options.clone());
        let targets = renderer.state.targets.as_ref().unwrap();
        let ao = targets.ao.as_ref().unwrap();
        assert_eq!(
            (
                ao.depth_view.texture().width(),
                ao.depth_view.texture().height()
            ),
            (1537, 865)
        );
        assert_eq!(
            (
                ao.estimate_view.texture().width(),
                ao.estimate_view.texture().height()
            ),
            (769, 433)
        );
        assert_eq!(targets.depth_view.texture().sample_count(), MSAA_SAMPLES);
        let off = render_test_scene(
            &mut renderer,
            scene.clone(),
            RenderOptions {
                ao: None,
                ..options.clone()
            },
        );
        // AO cannot affect final geometric coverage; exact black authored lines
        // remain black because the edge pass follows the surface composition.
        let mut black = 0;
        for (a, b) in first
            .rgba
            .as_chunks::<4>()
            .0
            .iter()
            .zip(off.rgba.as_chunks::<4>().0)
        {
            assert_eq!(a[3], b[3]);
            if b[..3] == [0, 0, 0] && b[3] == 255 {
                assert_eq!(a, b);
                black += 1;
            }
        }
        assert!(black > 100, "fixture must exercise authored CAD edges");
        let repeated = render_test_scene(&mut renderer, scene.clone(), options.clone());
        assert_eq!(
            first.rgba, repeated.rgba,
            "AO must not rely on temporal history"
        );
        renderer.trim_targets();
        assert_eq!(
            first.rgba,
            render_test_scene(&mut renderer, scene, options).rgba
        );
        renderer.take_uncaptured().expect("large AO validation");
    }

    #[test]
    fn ao_thin_feature_ignores_missing_depth_neighbors() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let mut scene = occluded_line_scene(false);
        let strip = &mut scene.meshes[0].primitives[0];
        for vertex in strip.positions.as_chunks_mut::<3>().0 {
            vertex[0] = if vertex[0] < 0.0 { 0.0 } else { 0.009 };
            vertex[1] *= 0.5;
        }
        let mut neighbor = strip.clone();
        // Column 133 samples this front, one-pixel strip; the rear strip is context.
        for vertex in neighbor.positions.as_chunks_mut::<3>().0 {
            vertex[0] += 0.05;
            vertex[2] += 0.02;
        }
        scene.meshes[0].primitives.push(neighbor);
        let options = RenderOptions {
            width: 256,
            height: 256,
            lines: false,
            camera: fixed_camera(CameraProjection::Orthographic {
                vertical_span: Some(2.4),
                zoom: 1.0,
            }),
            ..RenderOptions::default()
        };
        let off = render_test_scene(&mut renderer, scene.clone(), options.clone());
        let on = render_test_scene(
            &mut renderer,
            scene,
            RenderOptions {
                ao: Some(crate::AmbientOcclusion {
                    radius_pixels: Some(16.0),
                    intensity: 3.0,
                    distance_falloff: 0.2,
                }),
                ..options
            },
        );
        let mut error = 0u64;
        for y in 112..145 {
            let pixel = ((y * 256 + 133) * 4) as usize;
            assert!(off.rgba[pixel] > 230, "thin strip must be visible");
            error += u64::from(off.rgba[pixel].abs_diff(on.rgba[pixel]));
        }
        assert!(
            error as f64 / 33.0 < 2.0,
            "AO darkened a thin isolated strip"
        );
    }

    #[test]
    fn glass_refracts_authored_edges_behind_it() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let mut scene = occluded_line_scene(true);
        scene.meshes[0].primitives[0].material = Material {
            base_color: [1.0; 4],
            metallic: 0.0,
            roughness: 0.0,
            transmission: [1.0, 0.0, 1.0, 0.0],
            ..Material::default()
        };
        let hidden = render_test_scene(&mut renderer, scene.clone(), physical_options());
        let visible = render_test_scene(
            &mut renderer,
            scene,
            RenderOptions {
                lines: true,
                ..physical_options()
            },
        );
        let center = (48 * 96 + 48) * 4;
        assert!(hidden.rgba[center] > 200);
        let pixel = &visible.rgba[center..center + 4];
        // Bicubic reconstruction softens a three-pixel line; it must still
        // strongly contrast with the empty transmission background.
        assert!(
            pixel[0] < 100,
            "authored edge vanished behind glass: {pixel:?}"
        );
    }

    #[test]
    fn clear_glass_preserves_transparent_background() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let glass = Material {
            base_color: [1.0; 4],
            metallic: 0.0,
            roughness: 0.1,
            transmission: [1.0, 0.0, 1.5, 0.0],
            ..Material::default()
        };
        let image = render_test_scene(
            &mut renderer,
            physical_sphere(glass),
            RenderOptions {
                background: None,
                ..physical_options()
            },
        );
        let center = ((image.height / 2 * image.width + image.width / 2) * 4) as usize;
        let pixel = &image.rgba[center..center + 4];
        assert!(
            pixel[3].abs_diff(128) <= 1,
            "clear glass incorrectly blocks the background: {pixel:?}"
        );
    }

    #[test]
    fn clearcoat_specialization_preserves_pixels_when_switching_scenes() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let base = Material {
            base_color: [0.55, 0.25, 0.12, 1.0],
            metallic: 0.6,
            roughness: 0.35,
            ..Material::default()
        };
        let plain = render_test_scene(
            &mut renderer,
            physical_sphere(base.clone()),
            physical_options(),
        );
        let mut coated = base.clone();
        coated.coat[0] = 1.0;
        coated.coat[1] = 0.1;
        let coat = render_test_scene(
            &mut renderer,
            physical_sphere(coated.clone()),
            physical_options(),
        );
        assert_ne!(plain.rgba, coat.rgba, "clearcoat must remain visible");
        for material in [base, coated] {
            let expected = if material.coat[0] == 0.0 {
                &plain
            } else {
                &coat
            };
            let repeated =
                render_test_scene(&mut renderer, physical_sphere(material), physical_options());
            assert_eq!(expected.rgba, repeated.rgba, "scene history changed pixels");
        }
        assert_eq!(
            renderer.counters.pipeline_sets,
            if cfg!(target_arch = "wasm32") { 3 } else { 2 },
            "reuse qualified specializations plus AO"
        );
    }

    #[test]
    fn physical_material_factors_produce_distinct_gpu_pixels() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let base = Material {
            base_color: [0.55, 0.25, 0.12, 1.0],
            metallic: 0.6,
            roughness: 0.35,
            ..Material::default()
        };
        let reference = render_test_scene(
            &mut renderer,
            physical_sphere(base.clone()),
            physical_options(),
        );
        let mut variants = Vec::new();
        let mut m = base.clone();
        m.anisotropy[0] = 0.9;
        variants.push(("anisotropy", m));
        let mut m = base.clone();
        m.coat[0] = 1.0;
        m.coat[1] = 0.1;
        variants.push(("clearcoat", m));
        let mut m = base.clone();
        m.emissive = [1.0, 0.3, 0.0, 0.0];
        variants.push(("emission", m));
        let mut m = base.clone();
        m.transmission[2] = 2.5;
        variants.push(("IOR", m));
        let mut m = base.clone();
        m.iridescence[0] = 1.0;
        variants.push(("iridescence", m));
        let mut m = base.clone();
        m.sheen = [0.4, 0.05, 0.2, 0.5];
        variants.push(("sheen", m));
        let mut m = base.clone();
        m.specular = [0.2, 1.0, 0.1, 0.1];
        variants.push(("specular", m));
        let mut m = base.clone();
        m.transmission[0] = 1.0;
        m.transmission[1] = 0.1;
        variants.push(("transmission", m));
        let mut m = base.clone();
        m.anisotropy[3] = 1.0;
        variants.push(("unlit", m));
        for (name, material) in variants {
            let image =
                render_test_scene(&mut renderer, physical_sphere(material), physical_options());
            let changed = image
                .rgba
                .as_chunks::<4>()
                .0
                .iter()
                .zip(reference.rgba.as_chunks::<4>().0)
                .filter(|(a, b)| a[..3].iter().zip(&b[..3]).any(|(a, b)| a.abs_diff(*b) > 2))
                .count();
            assert!(
                changed > 100,
                "{name}: only {changed} materially changed pixels"
            );
        }
        let mut horizontal = base.clone();
        horizontal.anisotropy[0] = 0.9;
        let mut vertical = horizontal.clone();
        vertical.anisotropy[1] = 0.0;
        vertical.anisotropy[2] = 1.0;
        let left = render_test_scene(
            &mut renderer,
            physical_sphere(horizontal),
            physical_options(),
        );
        let right = render_test_scene(&mut renderer, physical_sphere(vertical), physical_options());
        assert_ne!(
            left.rgba, right.rgba,
            "anisotropy rotation must rotate the highlight"
        );
        renderer.take_uncaptured().expect("no uncaptured GPU error");
    }

    #[test]
    fn specular_color_above_one_clamps_f0_in_the_shader() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let mut render = |factor| {
            render_test_scene(
                &mut renderer,
                physical_sphere(Material {
                    base_color: [0.55, 0.25, 0.12, 1.0],
                    metallic: 0.0,
                    roughness: 0.35,
                    specular: [factor, factor, factor, 1.0],
                    ..Material::default()
                }),
                physical_options(),
            )
        };
        let unit = render(1.0);
        let high = render(100.0);
        let higher = render(200.0);
        assert_ne!(
            unit.rgba, high.rgba,
            "factor must not be clamped before shading"
        );
        assert_eq!(
            high.rgba, higher.rgba,
            "IOR-derived F0 must saturate at one"
        );
        renderer.take_uncaptured().expect("no uncaptured GPU error");
    }

    #[test]
    fn large_emission_stays_finite_through_hdr_and_display() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let material = Material {
            emissive: [100000.0, 100000.0, 100000.0, 0.0],
            ..Material::default()
        };
        let image = render_test_scene(&mut renderer, physical_sphere(material), physical_options());
        let center = ((image.height / 2 * image.width + image.width / 2) * 4) as usize;
        let pixel = &image.rgba[center..center + 4];
        assert!(
            pixel[..3].iter().all(|&channel| channel >= 250),
            "bright emitter must tone-map to white: {pixel:?}"
        );
        renderer.take_uncaptured().expect("no uncaptured GPU error");
    }

    #[test]
    fn unlit_ignores_lighting_but_uses_display_transform_and_mask_discards_pixels() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let mut material = Material {
            base_color: [0.18, 0.4, 0.7, 1.0],
            ..Material::default()
        };
        material.anisotropy[3] = 1.0;
        let mut options = physical_options();
        let first = render_test_scene(
            &mut renderer,
            physical_sphere(material.clone()),
            options.clone(),
        );
        options.lighting.ambient = 0.0;
        options.lighting.environment = false;
        options.lighting.lights.clear();
        let second = render_test_scene(
            &mut renderer,
            physical_sphere(material.clone()),
            options.clone(),
        );
        let center = (48 * 96 + 48) * 4;
        for (&a, &b) in first.rgba[center..center + 4]
            .iter()
            .zip(&second.rgba[center..center + 4])
        {
            assert!(a.abs_diff(b) <= 1);
        }
        for (channel, expected) in [105u8, 162, 212].into_iter().enumerate() {
            assert!(second.rgba[center + channel].abs_diff(expected) <= 1);
        }
        options.lighting.exposure = 4.0;
        let exposed = render_test_scene(
            &mut renderer,
            physical_sphere(material.clone()),
            options.clone(),
        );
        assert!(
            exposed.rgba[center] > second.rgba[center] + 30,
            "exposure applies to unlit glTF colors"
        );
        material.alpha_mode = 1.0;
        material.base_color[3] = 0.2;
        let hidden = render_test_scene(&mut renderer, physical_sphere(material), options);
        assert!(
            hidden.rgba.iter().all(|&v| v == 255),
            "MASK leaves the background unchanged"
        );
    }

    fn constant_map(scene: &mut glb::Scene, slot: usize, rgba: [u8; 4], srgb: bool) {
        let mut data = [0.0; 16];
        data[..4].copy_from_slice(&[1u32, 1, 1, 1].map(f32::from_bits));
        data[4..8].copy_from_slice(
            &[
                0u32,
                33071,
                33071,
                1 | (9729 << 1) | (u32::from(srgb) << 16),
            ]
            .map(f32::from_bits),
        );
        data[8..12].copy_from_slice(&[1.0, 0.0, 1.0, 1.0]);
        scene.meshes[0].primitives[0].material.textures[slot].data = data;
        scene.texture_pixels.push(u32::from_le_bytes(rgba));
    }

    #[test]
    fn material_maps_match_factor_equivalents_in_their_declared_channels_and_color_spaces() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let rgba = [8u8, 128, 192, 96];
        let linear = rgba.map(|v| f32::from(v) / 255.0);
        let srgb = linear.map(|v| {
            if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        });
        for slot in [0, 1, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16] {
            let mut m = Material {
                base_color: [0.6, 0.4, 0.2, 1.0],
                metallic: 0.2,
                roughness: 0.6,
                ..Material::default()
            };
            match slot {
                4 => m.emissive = [1.0, 0.5, 0.25, 0.0],
                5 => m.anisotropy[0] = 0.8,
                6 | 7 => {
                    m.coat[0] = 1.0;
                    m.coat[1] = 0.5;
                }
                9 | 10 => m.iridescence[0] = 1.0,
                11 | 12 => m.sheen = [0.5, 0.3, 0.1, 0.8],
                15 | 16 => {
                    m.transmission[0] = 0.9;
                    m.transmission[1] = 0.5;
                    m.attenuation = [0.8, 0.5, 0.3, 1.0];
                }
                _ => {}
            }
            let mut expected = m.clone();
            match slot {
                0 => {
                    for (i, value) in srgb.iter().enumerate().take(3) {
                        expected.base_color[i] *= value;
                    }
                }
                1 => {
                    expected.roughness *= linear[1];
                    expected.metallic *= linear[2];
                }
                4 => {
                    for (i, value) in srgb.iter().enumerate().take(3) {
                        expected.emissive[i] *= value;
                    }
                }
                5 => {
                    expected.anisotropy[0] *= linear[2];
                    let x = linear[0] * 2.0 - 1.0;
                    let y = linear[1] * 2.0 - 1.0;
                    let length = x.hypot(y);
                    expected.anisotropy[1] = x / length;
                    expected.anisotropy[2] = y / length;
                }
                6 => expected.coat[0] *= linear[0],
                7 => expected.coat[1] *= linear[1],
                9 => expected.iridescence[0] *= linear[0],
                10 => {
                    expected.iridescence[3] = expected.iridescence[2]
                        + (expected.iridescence[3] - expected.iridescence[2]) * linear[1]
                }
                11 => {
                    for (i, value) in srgb.iter().enumerate().take(3) {
                        expected.sheen[i] *= value;
                    }
                }
                12 => expected.sheen[3] *= linear[3],
                13 => expected.specular[3] *= linear[3],
                14 => {
                    for (i, value) in srgb.iter().enumerate().take(3) {
                        expected.specular[i] *= value;
                    }
                }
                15 => expected.transmission[0] *= linear[0],
                _ => expected.transmission[1] *= linear[1], // Last listed slot: thickness (16).
            }
            let baseline = render_test_scene(
                &mut renderer,
                physical_sphere(m.clone()),
                physical_options(),
            );
            let mut mapped = physical_sphere(m);
            constant_map(&mut mapped, slot, rgba, matches!(slot, 0 | 4 | 11 | 14));
            let actual = render_test_scene(&mut renderer, mapped, physical_options());
            let reference =
                render_test_scene(&mut renderer, physical_sphere(expected), physical_options());
            let max_error = actual
                .rgba
                .iter()
                .zip(&reference.rgba)
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap();
            assert!(
                max_error <= 3,
                "map {slot}: factor/color-space equivalence failed by {max_error} codes"
            );
            assert_ne!(
                actual.rgba, baseline.rgba,
                "map {slot} must have a visible effect"
            );
        }
        renderer
            .take_uncaptured()
            .expect("no GPU validation errors");
    }

    #[test]
    fn clearcoat_normal_and_surface_normal_maps_render_on_a_fresh_device() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        // Keep vector maps independent of the scalar-map pipeline cache and
        // exercise clearcoat first, including a zero-strength neutral check.
        for slot in [8, 2, 3] {
            let mut material = Material {
                roughness: 0.3,
                metallic: 0.0,
                ..Material::default()
            };
            material.coat[0] = 1.0;
            let base = physical_sphere(material.clone());
            let reference = render_test_scene(&mut renderer, base.clone(), physical_options());
            let mut mapped = base;
            constant_map(&mut mapped, slot, [192, 64, 192, 255], false);
            let actual = render_test_scene(&mut renderer, mapped.clone(), physical_options());
            assert_ne!(actual.rgba, reference.rgba, "map {slot}");
            if slot == 3 {
                mapped.meshes[0].primitives[0].material.misc[1] = 0.0;
            } else if slot == 2 {
                mapped.meshes[0].primitives[0].material.misc[0] = 0.0;
            } else {
                mapped.meshes[0].primitives[0].material.coat[3] = 0.0;
            }
            let disabled = render_test_scene(&mut renderer, mapped, physical_options());
            assert_eq!(
                disabled.rgba, reference.rgba,
                "map {slot} scale zero is neutral"
            );
        }
        renderer
            .take_uncaptured()
            .expect("no GPU validation errors");
    }

    #[test]
    fn glass_transmits_opaque_geometry_and_volume_absorption_scales_with_path_length() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let mut glass = Material {
            base_color: [1.0; 4],
            metallic: 0.0,
            roughness: 0.01,
            ..Material::default()
        };
        glass.transmission = [1.0, 0.15, 1.5, 0.0];
        let mut scene = physical_sphere(glass.clone());
        let mut back = scene.meshes[0].clone();
        back.primitives[0].material = Material {
            base_color: [0.1, 0.7, 0.2, 1.0],
            ..Material::default()
        };
        back.primitives[0].material.anisotropy[3] = 1.0;
        scene.meshes.push(back);
        // fixed_camera looks down -Z; the opaque green sphere is behind the glass.
        scene.instances.push(glb::MeshInstance {
            mesh_index: 1,
            source_node_index: 1,
            model: Mat4::from_translation(Vec3::new(0.0, 0.0, -2.0)),
            normal_matrix: Mat4::IDENTITY,
        });
        let clear = render_test_scene(&mut renderer, scene.clone(), physical_options());
        let mut constant = scene.clone();
        constant.meshes[0].primitives[0].surface_attributes.clear();
        let without_attributes = render_test_scene(&mut renderer, constant, physical_options());
        assert_eq!(clear.rgba, without_attributes.rgba);
        let center = (48 * 96 + 48) * 4;
        assert!(
            clear.rgba[center + 1] > clear.rgba[center] + 40,
            "glass must reveal the green opaque part"
        );
        scene.meshes[0].primitives[0].material.attenuation = [0.7, 0.4, 0.2, 2.0];
        let absorbing = render_test_scene(&mut renderer, scene.clone(), physical_options());
        assert!(absorbing.rgba[center + 1] < clear.rgba[center + 1]);
        // Beer-Lambert depends on thickness / attenuationDistance, not either length alone.
        scene.meshes[0].primitives[0].material.transmission[1] *= 2.0;
        scene.meshes[0].primitives[0].material.attenuation[3] *= 0.5;
        let equivalent = render_test_scene(&mut renderer, scene, physical_options());
        for i in 0..3 {
            assert!(absorbing.rgba[center + i].abs_diff(equivalent.rgba[center + i]) <= 2);
        }
        renderer
            .take_uncaptured()
            .expect("no GPU validation errors");
    }

    #[test]
    fn opaque_readback_matches_conversion_across_overlapping_backgrounds() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        let blended = Material {
            alpha_mode: 2.0,
            base_color: [0.2, 0.4, 0.8, 0.5],
            ..Material::default()
        };
        let glass = Material {
            transmission: [0.8, 0.0, 1.5, 0.0],
            ..Material::default()
        };
        for parsed in [
            cube_with_edges(true),
            physical_sphere(blended),
            physical_sphere(glass),
        ] {
            let mut scene = Scene::new(parsed);
            let make_entry = |alpha| {
                let options = RenderOptions {
                    background: Some([0.2, 0.4, 0.6, alpha]),
                    width: 127,
                    height: 85,
                    lines: true,
                    ..physical_options()
                };
                PlanEntry {
                    id: "background".into(),
                    prepared: crate::capture_overlay::prepare_view(&scene.parsed, &options)
                        .expect("camera"),
                    format: ImageFormat::Raw,
                    options,
                }
            };
            let entries = [make_entry(1.0), make_entry(0.5), make_entry(0.0)];
            let presentation = renderer
                .prepare_presentation(&scene.parsed, &entries[0].options)
                .expect("presentation");
            let buffers = renderer.ensure_uploaded(&mut scene).expect("upload");
            for index in 0..entries.len() {
                let first = renderer
                    .begin_view(buffers, &presentation, &entries[index])
                    .expect("first");
                let next = renderer
                    .begin_view(
                        buffers,
                        &presentation,
                        &entries[(index + 1) % entries.len()],
                    )
                    .expect("overlapping different background");
                let image = renderer.finish_view_blocking(first).expect("pixels");
                renderer.finish_view_blocking(next).expect("overlap pixels");
                let mut reference = renderer
                    .begin_view(buffers, &presentation, &entries[index])
                    .expect("reference");
                // Force the original full conversion as the independent oracle.
                reference.opaque_background = false;
                let reference = renderer.finish_view_blocking(reference).expect("converted");
                assert_eq!(image.rgba, reference.rgba);
                if index == 0 {
                    assert!(
                        image
                            .rgba
                            .as_chunks::<4>()
                            .0
                            .iter()
                            .all(|pixel| pixel[3] == 255)
                    );
                } else {
                    assert!(
                        image
                            .rgba
                            .as_chunks::<4>()
                            .0
                            .iter()
                            .any(|pixel| pixel[3] < 255)
                    );
                }
            }
        }
        renderer.destroy();
    }

    #[test]
    fn transparent_output_retains_straight_color_for_surfaces_edges_and_lines() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let mut material = Material {
            base_color: [0.18, 0.4, 0.7, 1.0],
            ..Material::default()
        };
        material.anisotropy[3] = 1.0;
        let mut options = physical_options();
        options.background = None;
        // Isolate straight-alpha coverage from intentional AO color attenuation.
        options.ao = None;
        let opaque = render_test_scene(
            &mut renderer,
            physical_sphere(material.clone()),
            options.clone(),
        );
        material.alpha_mode = 2.0;
        material.base_color[3] = 0.5;
        let blended = render_test_scene(
            &mut renderer,
            physical_sphere(material.clone()),
            options.clone(),
        );
        let mut line = cube_scene();
        line.meshes[0].primitives[0] = glb::Primitive {
            source_index: 0,
            mode: glb::MODE_LINES,
            positions: vec![-0.8, 0.0, 0.0, 0.8, 0.0, 0.0],
            indices: vec![0, 1],
            normals: Vec::new(),
            surface_attributes: Vec::new(),
            material,
        };
        options.lines = true;
        options.line_width = 4.0;
        let line = render_test_scene(&mut renderer, line, options);
        let center = (48 * 96 + 48) * 4;
        assert!(blended.rgba[center + 3].abs_diff(128) <= 1);
        for (image, expected_color) in [
            (opaque, [105u8, 162, 212]),
            (blended, [105, 162, 212]),
            (line, [118, 170, 218]),
        ] {
            let mut partial = 0;
            for pixel in image.rgba.as_chunks::<4>().0 {
                if pixel[3] == 0 {
                    assert_eq!(&pixel[..3], &[0; 3]);
                } else if pixel[3] < 255 {
                    partial += 1;
                    for (channel, expected) in expected_color.into_iter().enumerate() {
                        assert!(pixel[channel].abs_diff(expected) <= 3, "{pixel:?}");
                    }
                }
            }
            assert!(
                partial > 50,
                "exercise partial coverage, not just opaque pixels"
            );
        }
    }

    /// A cube with its edges as a line primitive; `hidden` keeps the three edges that meet at the
    /// corner facing away from a camera in the +X/+Z quadrant.
    fn cube_with_edges(hidden: bool) -> glb::Scene {
        let mut scene = cube_scene();
        let corners = scene.meshes[0].primitives[0].positions.clone();
        let mut indices = vec![1, 2, 2, 3, 4, 5, 5, 6, 6, 7, 7, 4, 1, 5, 2, 6, 3, 7];
        if hidden {
            indices.extend([0, 1, 0, 3, 0, 4]);
        }
        scene.meshes[0].primitives.push(glb::Primitive {
            source_index: 1,
            mode: glb::MODE_LINES,
            positions: corners,
            indices,
            normals: Vec::new(),
            surface_attributes: Vec::new(),
            material: glb::Material {
                base_color: [1.0, 0.0, 0.0, 1.0],
                metallic: 0.0,
                roughness: 1.0,
                ..Material::default()
            },
        });
        scene
    }

    #[test]
    fn hidden_edges_ending_on_a_face_boundary_leave_no_trace() {
        // An edge behind a face that ends on the face's boundary (the far flank edges of a gear
        // tooth) shows through for as long as the surface bias exceeds what the stroke needs.
        // Inside the solid's silhouette, hidden edges must change no pixel at any grazing angle or
        // stroke width.
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let mut leaks = Vec::new();
        for line_width in [1.0, 3.0] {
            for elevation in [10.0_f32, 20.0, 35.0] {
                let (elevation, azimuth) = (elevation.to_radians(), 30.0_f32.to_radians());
                let direction = Vec3::new(
                    azimuth.sin() * elevation.cos(),
                    elevation.sin(),
                    azimuth.cos() * elevation.cos(),
                );
                let options = RenderOptions {
                    width: 256,
                    height: 256,
                    line_width,
                    background: Some([1.0; 4]),
                    camera: RenderCamera::Fixed {
                        position: (direction * 10.0).to_array(),
                        target: [0.0; 3],
                        up: [0.0, 1.0, 0.0],
                        projection: CameraProjection::Orthographic {
                            vertical_span: Some(4.0),
                            zoom: 1.0,
                        },
                        clipping: Some(crate::ClipPlanes {
                            near: 5.0,
                            far: 15.0,
                        }),
                    },
                    ..RenderOptions::default()
                };
                // A hidden edge's own stroke can overhang the silhouette at an outline
                // corner whatever the bias; a tick through a face lies inside it.
                let solid = render_test_scene(
                    &mut renderer,
                    cube_scene(),
                    RenderOptions {
                        lines: false,
                        ..options.clone()
                    },
                );
                let visible =
                    render_test_scene(&mut renderer, cube_with_edges(false), options.clone());
                let all = render_test_scene(&mut renderer, cube_with_edges(true), options);
                let changed = solid
                    .rgba
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(visible.rgba.as_chunks::<4>().0)
                    .zip(all.rgba.as_chunks::<4>().0)
                    .filter(|((solid, a), b)| {
                        solid[..3] != [255; 3] && a.iter().zip(*b).any(|(a, b)| a.abs_diff(*b) > 2)
                    })
                    .count();
                leaks.push((line_width, elevation.to_degrees().round(), changed));
            }
        }
        assert!(
            leaks.iter().all(|&(_, _, changed)| changed == 0),
            "hidden edges showed through (width, elevation°, pixels): {leaks:?}"
        );
    }

    #[test]
    fn alpha_blend_orders_surfaces_and_opaque_ignores_alpha() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance)).expect("GPU");
        let mut red = Material {
            base_color: [0.8, 0.05, 0.05, 0.5],
            alpha_mode: 2.0,
            metallic: 0.0,
            ..Material::default()
        };
        red.anisotropy[3] = 1.0;
        let mut scene = physical_sphere(red);
        let mut back = scene.meshes[0].clone();
        back.primitives[0].material.base_color = [0.05, 0.05, 0.8, 0.5];
        scene.meshes.push(back);
        scene.instances.push(glb::MeshInstance {
            mesh_index: 1,
            source_node_index: 1,
            model: Mat4::from_translation(Vec3::new(0.0, 0.0, -2.0)),
            normal_matrix: Mat4::IDENTITY,
        });
        let first = render_test_scene(&mut renderer, scene.clone(), physical_options());
        let mut constant = scene.clone();
        for mesh in &mut constant.meshes {
            mesh.primitives[0].surface_attributes.clear();
        }
        let without_attributes = render_test_scene(&mut renderer, constant, physical_options());
        assert_eq!(first.rgba, without_attributes.rgba);
        scene.instances.reverse();
        let reordered = render_test_scene(&mut renderer, scene.clone(), physical_options());
        assert_eq!(first.rgba, reordered.rgba);
        let center = (48 * 96 + 48) * 4;
        assert!(
            first.rgba[center] > first.rgba[center + 2],
            "front red layer must cover back blue layer"
        );
        scene.meshes[0].primitives[0].material.alpha_mode = 0.0;
        scene.meshes[0].primitives[0].material.base_color[3] = 0.0;
        let zero = render_test_scene(&mut renderer, scene.clone(), physical_options());
        scene.meshes[0].primitives[0].material.base_color[3] = 1.0;
        let one = render_test_scene(&mut renderer, scene, physical_options());
        assert_eq!(zero.rgba, one.rgba);
        assert!(one.rgba[center] > first.rgba[center]);
        renderer
            .take_uncaptured()
            .expect("no GPU validation errors");
    }

    #[test]
    fn frame_uniform_packs_the_rig_at_the_offsets_wgsl_declares() {
        use crate::{LightingSpace, ResolvedLight, ResolvedLighting};

        // A 90-degree yaw: a world +x light must land on view-space -z.
        let view = Mat4::from_rotation_y(std::f32::consts::FRAC_PI_2);
        let options = RenderOptions {
            lighting: ResolvedLighting {
                lights: vec![ResolvedLight {
                    direction: [3.0, 0.0, 0.0],
                    color: [0.25, 0.5, 0.75],
                }],
                ambient: 0.5,
                environment: false,
                space: LightingSpace::World,
                exposure: 2.0,
            },
            sections: Some(crate::Sections {
                planes: vec![crate::SectionPlane {
                    point: [2.0, 0.0, 0.0],
                    normal: [2.0, 0.0, 0.0],
                }],
                clip_surfaces: true,
                clip_lines: false,
            }),
            ..RenderOptions::default()
        };
        let camera = CameraState {
            projection: Mat4::IDENTITY,
            view,
            forward: Vec3::NEG_Z,
            target_depth: 1.0,
        };
        let data = frame_uniform(camera, &options);
        assert_close(
            Vec3::from_slice(&data[FRAME_LIGHTS..FRAME_LIGHTS + 3]),
            Vec3::NEG_Z,
        );
        assert_eq!(&data[FRAME_LIGHTS + 4..FRAME_LIGHTS + 7], [0.25, 0.5, 0.75]);
        assert_eq!(data[FRAME_TAIL].to_bits(), 1);
        assert_eq!(data[FRAME_TAIL + 1], 0.5);
        assert_eq!(data[FRAME_TAIL + 2], 2.0);
        assert_eq!(data[FRAME_TAIL + 3].to_bits(), 0);
        assert_eq!(
            &data[FRAME_SECTION_PLANES..FRAME_SECTION_PLANES + 4],
            [1.0, 0.0, 0.0, -2.0]
        );
        assert_eq!(data[FRAME_SECTION_TAIL].to_bits(), 1);
        assert_eq!(data[FRAME_SECTION_TAIL + 1].to_bits(), 1);
        assert_eq!(data[FRAME_SECTION_TAIL + 2].to_bits(), 0);
        assert!((data[35] - 0.05).abs() < 1.0e-6);
        // Unwritten slots stay zero, and the studio rig fills exactly three.
        assert_eq!(data[FRAME_LIGHTS + FRAME_LIGHT_STRIDE], 0.0);

        // The plane array is the limit: a full rig writes every slot up to the
        // tail and leaves the tail where `shader.wgsl` declares it.
        assert_eq!(MAX_SECTION_PLANES, 8);
        assert_eq!(FRAME_SECTION_TAIL, 136);
        assert_eq!(FRAME_FLOATS * 4, 592);
        assert_eq!(data[FRAME_SECTION_TAIL + 8], 3.0);
        assert_eq!(
            frame_uniform(
                camera,
                &RenderOptions {
                    ao: Some(crate::AmbientOcclusion {
                        radius_pixels: None,
                        intensity: 2.0,
                        distance_falloff: 0.2
                    }),
                    ..RenderOptions::default()
                }
            )[FRAME_SECTION_TAIL + 8],
            2.0
        );
        let full = frame_uniform(
            camera,
            &RenderOptions {
                sections: Some(crate::Sections {
                    planes: (0..MAX_SECTION_PLANES)
                        .map(|index| crate::SectionPlane {
                            point: [index as f32 + 1.0, 0.0, 0.0],
                            normal: [1.0, 0.0, 0.0],
                        })
                        .collect(),
                    clip_surfaces: true,
                    clip_lines: true,
                }),
                ..RenderOptions::default()
            },
        );
        assert_eq!(
            full[FRAME_SECTION_TAIL].to_bits(),
            MAX_SECTION_PLANES as u32
        );
        for index in 0..MAX_SECTION_PLANES {
            let base = FRAME_SECTION_PLANES + index * 4;
            assert_eq!(
                &full[base..base + 4],
                [1.0, 0.0, 0.0, -(index as f32 + 1.0)]
            );
        }

        let studio = frame_uniform(camera, &RenderOptions::default());
        assert_eq!(studio[FRAME_TAIL].to_bits(), 1);
        assert_eq!(studio[FRAME_TAIL + 3].to_bits(), 1);
        // View space ignores the view matrix; the direction is only normalised.
        assert_close(
            Vec3::from_slice(&studio[FRAME_LIGHTS..FRAME_LIGHTS + 3]),
            Vec3::ONE.normalize(),
        );
    }

    #[test]
    fn default_camera_keeps_the_previous_isometric_direction() {
        let camera = camera_state(&scene(), &RenderOptions::default());
        assert_close(camera.forward, -Vec3::new(0.612_372_46, 0.5, 0.612_372_46));
        assert!(camera.target_depth.is_finite());
    }

    #[test]
    fn fitted_camera_honours_cartesian_direction_and_up() {
        for (direction, up) in [
            ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
            ([0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
        ] {
            for projection in [
                CameraProjection::Perspective {
                    vertical_field_of_view_deg: 45.0,
                    zoom: 1.0,
                },
                CameraProjection::Orthographic {
                    vertical_span: None,
                    zoom: 1.0,
                },
            ] {
                for (width, height) in [(800, 800), (400, 800), (800, 400)] {
                    let camera = camera_state(
                        &scene(),
                        &RenderOptions {
                            width,
                            height,
                            camera: RenderCamera::Fit {
                                direction,
                                up,
                                padding_factor: 0.9,
                                projection,
                            },
                            ..RenderOptions::default()
                        },
                    );
                    assert_close(camera.forward, -Vec3::from(direction));
                    assert_close(camera.view.transform_vector3(Vec3::from(up)), Vec3::Y);
                }
            }
        }
    }

    #[test]
    fn fitted_perspective_uses_the_exact_requested_frustum_and_contains_referenced_geometry() {
        let scene = asymmetric_scene();
        let points = referenced_positions(&scene);
        assert_eq!(
            points.len(),
            4,
            "unreferenced accessor values are not fit geometry"
        );
        for field_of_view in [1.0, 22.0, 45.0, 79.0, 90.0, 120.0, 143.0, 160.0, 179.0] {
            let camera = camera_state(
                &scene,
                &RenderOptions {
                    width: 640,
                    height: 480,
                    camera: RenderCamera::Fit {
                        direction: [0.612_372_46, 0.5, 0.612_372_46],
                        up: [0.0, 1.0, 0.0],
                        padding_factor: 0.9,
                        projection: CameraProjection::Perspective {
                            vertical_field_of_view_deg: field_of_view,
                            zoom: 1.0,
                        },
                    },
                    ..RenderOptions::default()
                },
            );
            let expected_scale = 1.0 / (field_of_view.to_radians() * 0.5).tan();
            assert!(
                (camera.projection.y_axis.y - expected_scale).abs() <= expected_scale.abs() * 2e-4,
                "{field_of_view}° projection contains a hidden fitted zoom"
            );
            let view_projection = camera.projection * camera.view;
            let mut ndc_min = Vec2::splat(f32::INFINITY);
            let mut ndc_max = Vec2::splat(f32::NEG_INFINITY);
            for &point in &points {
                let view = camera.view.transform_point3(point);
                assert!(
                    view.z < 0.0,
                    "{field_of_view}° put a referenced point behind the eye"
                );
                let clip = view_projection * point.extend(1.0);
                assert!(clip.w > 0.0);
                let ndc = clip.truncate() / clip.w;
                assert!(ndc.x.abs() <= 0.9001);
                assert!(ndc.y.abs() <= 0.9001);
                assert!((0.0..=1.0).contains(&ndc.z));
                ndc_min = ndc_min.min(ndc.truncate());
                ndc_max = ndc_max.max(ndc.truncate());
            }
            if field_of_view == 143.0 {
                let minimum = ndc_min.min_element();
                let maximum = ndc_max.max_element();
                assert!((minimum + 0.9).abs() < 2e-4);
                assert!((maximum - 0.9).abs() < 2e-4);

                let (min, max) = scene.bounds.expect("bounds");
                let center = (Vec3::from(min) + Vec3::from(max)) * 0.5;
                let direction = Vec3::new(0.612_372_46, 0.5, 0.612_372_46).normalize();
                let eye = camera.view.inverse().transform_point3(Vec3::ZERO);
                let center_to_eye = eye - center;
                let lateral = center_to_eye - direction * center_to_eye.dot(direction);
                assert!(
                    lateral.length() > 0.01,
                    "asymmetric geometry must translate the optical axis"
                );
            }
        }
    }

    #[test]
    fn fitted_gear_stays_contained_after_the_old_wide_fov_crossover() {
        let scene = glb::parse_glb(include_bytes!("../../../tests/fixtures/gear-12.glb"))
            .expect("gear fixture");
        for field_of_view in [143.0, 160.0, 179.0] {
            let camera = camera_state(
                &scene,
                &RenderOptions {
                    width: 192,
                    height: 192,
                    camera: RenderCamera::Fit {
                        direction: [1.2, -1.7, 4.2],
                        up: [0.0, 1.0, 0.0],
                        padding_factor: 0.9,
                        projection: CameraProjection::Perspective {
                            vertical_field_of_view_deg: field_of_view,
                            zoom: 1.0,
                        },
                    },
                    ..RenderOptions::default()
                },
            );
            let view_projection = camera.projection * camera.view;
            assert!(
                scene
                    .for_each_position(&RenderOptions::default(), &mut |position| {
                        let depth = -camera.view.transform_point3(position).z;
                        let clip = view_projection * position.extend(1.0);
                        let ndc = clip.truncate() / clip.w;
                        assert!(depth > 0.0, "{field_of_view}° point behind fitted eye");
                        assert!(ndc.is_finite());
                        assert!(ndc.x.abs() <= 0.9005);
                        assert!(ndc.y.abs() <= 0.9005);
                        assert!((0.0..=1.0).contains(&ndc.z));
                    })
                    .expect("gear positions")
            );
        }
    }

    #[test]
    fn orthographic_fit_centres_exact_referenced_intervals() {
        let scene = asymmetric_scene();
        let camera = camera_state(
            &scene,
            &RenderOptions {
                width: 400,
                height: 800,
                camera: RenderCamera::Fit {
                    direction: [1.0, 2.0, 3.0],
                    up: [0.0, 0.0, 1.0],
                    padding_factor: 0.9,
                    projection: CameraProjection::Orthographic {
                        vertical_span: None,
                        zoom: 1.0,
                    },
                },
                ..RenderOptions::default()
            },
        );
        let matrix = camera.projection * camera.view;
        let mut min = Vec2::splat(f32::INFINITY);
        let mut max = Vec2::splat(f32::NEG_INFINITY);
        for position in referenced_positions(&scene) {
            let ndc = (matrix * position.extend(1.0)).truncate();
            assert!(ndc.x.abs() <= 0.9001);
            assert!(ndc.y.abs() <= 0.9001);
            min = min.min(ndc.truncate());
            max = max.max(ndc.truncate());
        }
        let limiting = (min.min_element(), max.max_element());
        assert!((limiting.0 + 0.9).abs() < 2e-4);
        assert!((limiting.1 - 0.9).abs() < 2e-4);
    }

    #[test]
    fn exact_depths_drive_derived_clipping() {
        let scene = asymmetric_scene();
        let eye = Vec3::new(8.0, 6.0, 10.0);
        let view = glam::camera::rh::view::look_at_mat4(eye, Vec3::ZERO, Vec3::Y);
        let (near, far) = position_clip_planes(
            &mut glb::UniquePositions::new(&scene),
            &RenderOptions::default(),
            view,
            eye.length(),
        );
        let depths = referenced_positions(&scene)
            .into_iter()
            .map(|position| -view.transform_point3(position).z)
            .filter(|depth| *depth > 0.0)
            .collect::<Vec<_>>();
        let nearest = depths.iter().copied().reduce(f32::min).expect("nearest");
        let farthest = depths.iter().copied().reduce(f32::max).expect("farthest");
        assert!((near - nearest * 0.5).abs() < 1e-5);
        assert!((far - farthest * 2.0).abs() < 1e-5);
    }

    #[test]
    fn degenerate_and_extreme_finite_geometry_produces_finite_fit_matrices() {
        for scale in [0.0, 1e-9, 1e9] {
            let scene = line_scene(&[[[-scale, 0.0, 0.0], [scale, 0.0, 0.0]]]);
            for projection in [
                CameraProjection::Perspective {
                    vertical_field_of_view_deg: 179.0,
                    zoom: 1.0,
                },
                CameraProjection::Orthographic {
                    vertical_span: None,
                    zoom: 1.0,
                },
            ] {
                let camera = camera_state(
                    &scene,
                    &RenderOptions {
                        camera: RenderCamera::Fit {
                            direction: [1.0, 2.0, 3.0],
                            up: [0.0, 1.0, 0.0],
                            padding_factor: 0.9,
                            projection,
                        },
                        ..RenderOptions::default()
                    },
                );
                assert!(camera.view.is_finite());
                assert!(camera.projection.is_finite());
            }
        }
    }

    #[test]
    fn fitted_perspective_field_of_view_remains_effective_above_sixty_degrees() {
        let camera_at = |vertical_field_of_view_deg| {
            camera_state(
                &scene(),
                &RenderOptions {
                    camera: RenderCamera::Fit {
                        direction: [0.6, 0.5, 0.6],
                        up: [0.0, 1.0, 0.0],
                        padding_factor: 0.9,
                        projection: CameraProjection::Perspective {
                            vertical_field_of_view_deg,
                            zoom: 1.0,
                        },
                    },
                    ..RenderOptions::default()
                },
            )
        };

        let sixty = camera_at(60.0);
        let wide = camera_at(120.0);

        assert!(wide.target_depth < sixty.target_depth);
        assert_ne!(wide.projection, sixty.projection);
    }

    #[test]
    fn fixed_camera_honours_position_target_and_roll() {
        let base = RenderOptions {
            camera: RenderCamera::Fixed {
                position: [4.0, 5.0, 6.0],
                target: [1.0, 2.0, 3.0],
                up: [0.0, 1.0, 0.0],
                projection: CameraProjection::Perspective {
                    vertical_field_of_view_deg: 45.0,
                    zoom: 1.0,
                },
                clipping: None,
            },
            ..RenderOptions::default()
        };
        let camera = camera_state(&scene(), &base);
        assert_close(camera.forward, Vec3::new(-3.0, -3.0, -3.0).normalize());
        assert_close(
            camera.view.transform_point3(Vec3::new(4.0, 5.0, 6.0)),
            Vec3::ZERO,
        );

        let rolled = camera_state(
            &scene(),
            &RenderOptions {
                camera: RenderCamera::Fixed {
                    position: [4.0, 5.0, 6.0],
                    target: [1.0, 2.0, 3.0],
                    up: [1.0, -1.0, 0.0],
                    projection: CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    },
                    clipping: None,
                },
                ..RenderOptions::default()
            },
        );
        assert_ne!(camera.view, rolled.view);
        assert_close(camera.forward, rolled.forward);
    }

    #[test]
    fn perspective_field_of_view_and_zoom_share_one_effective_frustum() {
        let field_of_view = 60.0_f32;
        let zoom = 2.0_f32;
        let effective =
            (2.0 * ((field_of_view.to_radians() * 0.5).tan() / zoom).atan()).to_degrees();
        let zoomed = camera_state(
            &scene(),
            &RenderOptions {
                camera: fixed_camera(CameraProjection::Perspective {
                    vertical_field_of_view_deg: field_of_view,
                    zoom,
                }),
                ..RenderOptions::default()
            },
        );
        let equivalent = camera_state(
            &scene(),
            &RenderOptions {
                camera: fixed_camera(CameraProjection::Perspective {
                    vertical_field_of_view_deg: effective,
                    zoom: 1.0,
                }),
                ..RenderOptions::default()
            },
        );
        assert_matrix_close(zoomed.projection, equivalent.projection);
    }

    #[test]
    fn orthographic_vertical_span_and_zoom_share_one_effective_frustum() {
        let zoomed = camera_state(
            &scene(),
            &RenderOptions {
                camera: fixed_camera(CameraProjection::Orthographic {
                    vertical_span: Some(20.0),
                    zoom: 2.0,
                }),
                ..RenderOptions::default()
            },
        );
        let equivalent = camera_state(
            &scene(),
            &RenderOptions {
                camera: fixed_camera(CameraProjection::Orthographic {
                    vertical_span: Some(10.0),
                    zoom: 1.0,
                }),
                ..RenderOptions::default()
            },
        );
        assert_matrix_close(zoomed.projection, equivalent.projection);
    }

    #[test]
    fn output_dimensions_define_projection_aspect() {
        for (width, height) in [(800, 400), (400, 800)] {
            let state = camera_state(
                &scene(),
                &RenderOptions {
                    width,
                    height,
                    camera: fixed_camera(CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    }),
                    ..RenderOptions::default()
                },
            );
            let aspect = width as f32 / height as f32;
            assert!((state.projection.y_axis.y / state.projection.x_axis.x - aspect).abs() < 1e-5);
        }
    }

    #[test]
    fn fixed_camera_supports_derived_and_explicit_clipping() {
        let derived = camera_state(
            &scene(),
            &RenderOptions {
                camera: RenderCamera::Fixed {
                    position: [0.0, 0.0, 10.0],
                    target: [0.0, 0.0, 0.0],
                    up: [0.0, 1.0, 0.0],
                    projection: CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    },
                    clipping: None,
                },
                ..RenderOptions::default()
            },
        );
        let generous = camera_state(
            &scene(),
            &RenderOptions {
                camera: fixed_camera(CameraProjection::Perspective {
                    vertical_field_of_view_deg: 45.0,
                    zoom: 1.0,
                }),
                ..RenderOptions::default()
            },
        );
        assert!(derived.projection.is_finite());
        assert_matrix_close(derived.projection, generous.projection);

        let clipped = camera_state(
            &scene(),
            &RenderOptions {
                camera: RenderCamera::Fixed {
                    position: [0.0, 0.0, 10.0],
                    target: [0.0, 0.0, 0.0],
                    up: [0.0, 1.0, 0.0],
                    projection: CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    },
                    clipping: Some(crate::ClipPlanes {
                        near: 8.0,
                        far: 10.0,
                    }),
                },
                ..RenderOptions::default()
            },
        );
        assert_ne!(derived.projection, clipped.projection);

        let outside = camera_state(
            &scene(),
            &RenderOptions {
                camera: RenderCamera::Fixed {
                    position: [0.0, 0.0, 10.0],
                    target: [0.0, 0.0, 0.0],
                    up: [0.0, 1.0, 0.0],
                    projection: CameraProjection::Perspective {
                        vertical_field_of_view_deg: 45.0,
                        zoom: 1.0,
                    },
                    clipping: Some(crate::ClipPlanes {
                        near: 0.1,
                        far: 1.0,
                    }),
                },
                ..RenderOptions::default()
            },
        );
        assert_ne!(derived.projection, outside.projection);
    }

    #[test]
    fn derived_clipping_handles_bounds_behind_the_camera() {
        let scene = line_scene(&[[[-1.0, -1.0, 1.0], [1.0, 1.0, 2.0]]]);
        let (near, far) = position_clip_planes(
            &mut glb::UniquePositions::new(&scene),
            &RenderOptions::default(),
            Mat4::IDENTITY,
            10.0,
        );
        assert!((near - 0.01).abs() < f32::EPSILON);
        assert_eq!(far, 20.0);
    }

    #[test]
    #[should_panic(expected = "fixed orthographic cameras resolve a vertical span")]
    fn fixed_orthographic_camera_requires_a_resolved_span() {
        camera_state(
            &scene(),
            &RenderOptions {
                camera: fixed_camera(CameraProjection::Orthographic {
                    vertical_span: None,
                    zoom: 1.0,
                }),
                ..RenderOptions::default()
            },
        );
    }

    #[test]
    fn srgb_transfer_covers_linear_and_exponential_segments() {
        assert_eq!(srgb_to_linear(0.0), 0.0);
        assert!(srgb_to_linear(0.02) > 0.0);
        assert!(srgb_to_linear(0.5) > srgb_to_linear(0.02));
        assert_eq!(srgb_to_linear(-1.0), 0.0);
        assert_eq!(srgb_to_linear(2.0), 1.0);
    }

    #[test]
    fn line_width_is_measured_in_output_pixels() {
        for (width, height) in [(192, 192), (768, 432), (3072, 1728)] {
            let options = RenderOptions {
                width,
                height,
                line_width: 0.75,
                ..RenderOptions::default()
            };
            assert_eq!(line_width_px(&options), 0.75);
        }
    }

    #[test]
    fn line_raster_width_matches_output_pixels_across_resolutions() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        for size in [192, 768] {
            for width in [0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0] {
                let options = RenderOptions {
                    width: size,
                    height: size,
                    line_width: width,
                    background: Some([1.0; 4]),
                    camera: fixed_camera(CameraProjection::Orthographic {
                        vertical_span: Some(4.0),
                        zoom: 1.0,
                    }),
                    ..RenderOptions::default()
                };
                let rendered = render_test_scene(
                    &mut renderer,
                    line_scene(&[[[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0]]]),
                    options,
                );
                let x = size / 2;
                let coverage: f64 = (0..size)
                    .map(|y| {
                        let red = rendered.rgba[((y * size + x) * 4) as usize] as f32 / 255.0;
                        1.0 - srgb_to_linear(red)
                    })
                    .sum();
                assert!((coverage - f64::from(width)).abs() < 0.35);
            }
        }
        renderer.destroy();
    }

    #[test]
    fn line_caps_are_round_and_hidden_lines_stay_hidden() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        let options = RenderOptions {
            width: 256,
            height: 256,
            line_width: 8.0,
            background: Some([1.0; 4]),
            camera: fixed_camera(CameraProjection::Orthographic {
                vertical_span: Some(4.0),
                zoom: 1.0,
            }),
            ..RenderOptions::default()
        };
        let line = render_test_scene(
            &mut renderer,
            line_scene(&[[[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0]]]),
            options.clone(),
        );
        let red = |x: u32, y: u32| line.rgba[((y * 256 + x) * 4) as usize];
        assert!(red(61, 128) < 200);
        assert_eq!(red(61, 124), 255);

        let surface = render_test_scene(&mut renderer, occluded_line_scene(false), options.clone());
        let hidden_line = render_test_scene(&mut renderer, occluded_line_scene(true), options);
        assert_eq!(surface.rgba, hidden_line.rgba);
        renderer.destroy();
    }

    #[test]
    fn broad_fixed_camera_clipping_does_not_reveal_hidden_lines() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        let options = RenderOptions {
            width: 256,
            height: 256,
            line_width: 3.0,
            background: Some([1.0; 4]),
            camera: RenderCamera::Fixed {
                position: [0.0, 0.0, 10.0],
                target: [0.0, 0.0, 0.0],
                up: [0.0, 1.0, 0.0],
                projection: CameraProjection::Perspective {
                    vertical_field_of_view_deg: 45.0,
                    zoom: 1.0,
                },
                clipping: Some(crate::ClipPlanes {
                    near: 0.000_001,
                    far: 10_000_000.0,
                }),
            },
            ..RenderOptions::default()
        };
        let surface = render_test_scene(&mut renderer, occluded_line_scene(false), options.clone());
        let hidden_line = render_test_scene(&mut renderer, occluded_line_scene(true), options);
        assert_eq!(surface.rgba, hidden_line.rgba);
        renderer.destroy();
    }

    #[test]
    fn presentation_switches_clip_authored_lines_and_draw_section_caps() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        let camera = RenderCamera::Fixed {
            position: [4.0, 3.0, 5.0],
            target: [0.0; 3],
            up: [0.0, 1.0, 0.0],
            projection: CameraProjection::Orthographic {
                vertical_span: Some(4.5),
                zoom: 1.0,
            },
            clipping: Some(crate::ClipPlanes {
                near: 0.1,
                far: 100.0,
            }),
        };
        let sections = crate::Sections {
            planes: vec![crate::SectionPlane {
                point: [0.0; 3],
                normal: [1.0, 0.0, 0.0],
            }],
            clip_surfaces: true,
            clip_lines: true,
        };
        let options = RenderOptions {
            width: 256,
            height: 256,
            background: Some([1.0; 4]),
            camera,
            sections: Some(sections.clone()),
            ..RenderOptions::default()
        };
        let cut = render_test_scene(&mut renderer, cube_scene(), options.clone());
        assert!(
            cut.rgba
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[0] < 240)
        );
        let open_chain = |rendered: &Rendered| {
            rendered
                .rgba
                .as_chunks::<4>()
                .0
                .iter()
                .filter(|pixel| pixel[0] > 180 && pixel[1] < 40 && pixel[2] < 100)
                .count()
        };
        assert_eq!(open_chain(&cut), 0);
        // Without its +z face the cube is open where the plane crosses it: the
        // cut is stroked as an open chain instead of being refused.
        let mut open_box = cube_scene();
        open_box.meshes[0].primitives[0].indices.drain(6..12);
        let open = render_test_scene(&mut renderer, open_box, options.clone());
        assert!(open_chain(&open) > 100);

        let blank = render_test_scene(
            &mut renderer,
            cube_scene(),
            RenderOptions {
                surfaces: false,
                lines: false,
                ..options.clone()
            },
        );
        assert!(
            blank
                .rgba
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| pixel == &[255; 4])
        );

        let hidden_surface = render_test_scene(
            &mut renderer,
            cube_scene(),
            RenderOptions {
                visible_primitives: Some(Vec::new()),
                ..options.clone()
            },
        );
        assert_eq!(hidden_surface.rgba, blank.rgba);

        let line = render_test_scene(
            &mut renderer,
            line_scene(&[[[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0]]]),
            RenderOptions {
                camera: fixed_camera(CameraProjection::Orthographic {
                    vertical_span: Some(4.0),
                    zoom: 1.0,
                }),
                ..options.clone()
            },
        );
        let dark = |x: u32| line.rgba[((128 * 256 + x) * 4) as usize] < 200;
        assert!(!dark(96));
        assert!(dark(160));

        let surface_only = render_test_scene(
            &mut renderer,
            line_scene(&[[[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0]]]),
            RenderOptions {
                camera: fixed_camera(CameraProjection::Orthographic {
                    vertical_span: Some(4.0),
                    zoom: 1.0,
                }),
                sections: Some(crate::Sections {
                    clip_lines: false,
                    ..sections.clone()
                }),
                ..options.clone()
            },
        );
        let surface_only_dark = |x: u32| surface_only.rgba[((128 * 256 + x) * 4) as usize] < 200;
        assert!(surface_only_dark(96));
        assert!(surface_only_dark(160));

        let uncut_cube = render_test_scene(
            &mut renderer,
            cube_scene(),
            RenderOptions {
                sections: Some(crate::Sections {
                    clip_surfaces: false,
                    ..sections
                }),
                ..options.clone()
            },
        );
        let whole_cube = render_test_scene(
            &mut renderer,
            cube_scene(),
            RenderOptions {
                sections: None,
                ..options.clone()
            },
        );
        assert_eq!(uncut_cube.rgba, whole_cube.rgba);

        let hidden_line = render_test_scene(
            &mut renderer,
            line_scene(&[[[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0]]]),
            RenderOptions {
                width: 256,
                height: 256,
                background: Some([1.0; 4]),
                camera: fixed_camera(CameraProjection::Orthographic {
                    vertical_span: Some(4.0),
                    zoom: 1.0,
                }),
                visible_primitives: Some(Vec::new()),
                ..RenderOptions::default()
            },
        );
        assert!(
            hidden_line
                .rgba
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| pixel == &[255; 4])
        );
        renderer.destroy();
    }

    #[test]
    fn multiple_section_plane_order_does_not_change_pixels() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        let planes = vec![
            crate::SectionPlane {
                point: [0.0; 3],
                normal: [1.0, 0.0, 0.0],
            },
            crate::SectionPlane {
                point: [0.0; 3],
                normal: [0.0, 1.0, 0.0],
            },
        ];
        let render = |renderer: &mut Renderer, planes| {
            render_test_scene(
                renderer,
                cube_scene(),
                RenderOptions {
                    width: 256,
                    height: 256,
                    background: Some([1.0; 4]),
                    camera: RenderCamera::Fixed {
                        position: [4.0, 3.0, 5.0],
                        target: [0.0; 3],
                        up: [0.0, 1.0, 0.0],
                        projection: CameraProjection::Orthographic {
                            vertical_span: Some(4.5),
                            zoom: 1.0,
                        },
                        clipping: None,
                    },
                    sections: Some(crate::Sections {
                        planes,
                        clip_surfaces: true,
                        clip_lines: true,
                    }),
                    ..RenderOptions::default()
                },
            )
        };
        let forward = render(&mut renderer, planes.clone());
        let reverse = render(&mut renderer, planes.into_iter().rev().collect());
        assert_eq!(forward.rgba, reverse.rgba);
        renderer.destroy();
    }

    #[test]
    fn seven_and_eight_section_planes_reach_the_shader() {
        // Q6 grew the uniform's plane array from six to eight. Each plane cuts
        // one cube corner; the list is ordered by how much the corner faces the
        // camera, so the seventh and eighth cuts are the two most visible ones
        // and a slot that never reached the shader would leave their renders
        // identical to the six-plane one.
        const CORNERS: [[f32; 3]; MAX_SECTION_PLANES] = [
            [-1.0, -1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [1.0, -1.0, -1.0],
            [-1.0, -1.0, 1.0],
            [1.0, 1.0, -1.0],
            [-1.0, 1.0, 1.0],
            [1.0, -1.0, 1.0],
            [1.0, 1.0, 1.0],
        ];
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        let render = |renderer: &mut Renderer, count: usize| {
            render_test_scene(
                renderer,
                cube_scene(),
                RenderOptions {
                    width: 256,
                    height: 256,
                    background: Some([1.0; 4]),
                    camera: RenderCamera::Fixed {
                        position: [4.0, 3.0, 5.0],
                        target: [0.0; 3],
                        up: [0.0, 1.0, 0.0],
                        projection: CameraProjection::Orthographic {
                            vertical_span: Some(4.5),
                            zoom: 1.0,
                        },
                        clipping: None,
                    },
                    sections: Some(crate::Sections {
                        planes: CORNERS[..count]
                            .iter()
                            .map(|corner| crate::SectionPlane {
                                point: corner.map(|axis| axis * 0.6),
                                normal: corner.map(|axis| -axis),
                            })
                            .collect(),
                        clip_surfaces: true,
                        clip_lines: true,
                    }),
                    ..RenderOptions::default()
                },
            )
            .rgba
        };
        let six = render(&mut renderer, 6);
        let seven = render(&mut renderer, 7);
        let eight = render(&mut renderer, MAX_SECTION_PLANES);
        assert_ne!(seven, six, "the seventh plane must change pixels");
        assert_ne!(eight, seven, "the eighth plane must change pixels");
        assert_eq!(render(&mut renderer, MAX_SECTION_PLANES), eight);
        renderer.destroy();
    }

    #[test]
    fn fixed_camera_lines_trim_at_the_near_plane() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        let options = RenderOptions {
            width: 256,
            height: 256,
            background: Some([1.0; 4]),
            camera: RenderCamera::Fixed {
                position: [0.0, 0.0, 2.0],
                target: [0.0, 0.0, 0.0],
                up: [0.0, 1.0, 0.0],
                projection: CameraProjection::Perspective {
                    vertical_field_of_view_deg: 60.0,
                    zoom: 1.0,
                },
                clipping: Some(crate::ClipPlanes {
                    near: 1.0,
                    far: 10.0,
                }),
            },
            ..RenderOptions::default()
        };
        let visible = [[[-0.8, -0.5, 0.0], [0.8, -0.5, 0.0]]];
        let crossing = [
            [[-0.8, -0.5, 0.0], [0.8, -0.5, 0.0]],
            [[-0.8, 0.0, 0.0], [0.8, 0.0, 1.5]],
        ];
        let behind = [
            [[-0.8, -0.5, 0.0], [0.8, -0.5, 0.0]],
            [[-0.8, 0.0, 0.0], [0.8, 0.0, 1.5]],
            [[-0.8, 0.5, 1.5], [0.8, 0.5, 1.5]],
        ];
        let visible = render_test_scene(&mut renderer, line_scene(&visible), options.clone());
        let crossing = render_test_scene(&mut renderer, line_scene(&crossing), options.clone());
        let behind = render_test_scene(&mut renderer, line_scene(&behind), options);
        assert_ne!(visible.rgba, crossing.rgba);
        assert_eq!(crossing.rgba, behind.rgba);
        renderer.destroy();
    }

    #[test]
    fn counters_report_per_call_deltas() {
        let start = Counters {
            device_requests: 1,
            pipeline_sets: 2,
            presentation_builds: 3,
            scene_uploads: 4,
            target_allocations: 5,
        };
        let end = Counters {
            device_requests: 1,
            pipeline_sets: 3,
            presentation_builds: 4,
            scene_uploads: 5,
            target_allocations: 7,
        };
        let delta = end.since(start);
        assert_eq!(delta.device_requests, 0);
        assert_eq!(delta.pipeline_sets, 1);
        assert_eq!(delta.presentation_builds, 1);
        assert_eq!(delta.scene_uploads, 1);
        assert_eq!(delta.target_allocations, 2);
    }

    #[test]
    fn gpu_failures_keep_stable_context() {
        assert!(matches!(
            adapter_error(wgpu::RequestAdapterError::EnvNotSet),
            RenderError::AdapterUnavailable(_)
        ));
        assert!(
            poll_error(wgpu::PollError::Timeout)
                .to_string()
                .starts_with("gpu: poll:")
        );
        assert!(
            map_error(wgpu::BufferAsyncError, None)
                .to_string()
                .starts_with("gpu: map_async:")
        );

        let adapter = pollster::block_on(request_adapter(wgpu::PowerPreference::HighPerformance))
            .expect("adapter");
        let unsupported = (wgpu::Features::all() - adapter.features())
            .iter()
            .next()
            .expect("at least one unsupported feature");
        let request_error = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("intentional unsupported-feature request"),
            required_features: unsupported,
            ..Default::default()
        }))
        .unwrap_err();
        assert!(
            request_device_error(request_error)
                .to_string()
                .starts_with("gpu: request_device:")
        );

        let (device, _) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .expect("device");
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("unmapped range error"),
            size: 4,
            usage: wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let range_error = buffer.slice(..).get_mapped_range().unwrap_err();
        assert!(
            mapped_range_error(range_error)
                .to_string()
                .starts_with("gpu: mapped range:")
        );
    }

    #[test]
    fn device_loss_notes_every_reason_except_explicit_destroy() {
        let lost = AtomicBool::new(false);
        let captured = Mutex::new(None);
        note_device_lost(
            &lost,
            &captured,
            wgpu::DeviceLostReason::Destroyed,
            "disposed",
        );
        assert!(!lost.load(Ordering::Acquire));
        assert!(captured.lock().unwrap().is_none());
        note_device_lost(
            &lost,
            &captured,
            wgpu::DeviceLostReason::Unknown,
            "driver cause",
        );
        assert!(lost.load(Ordering::Acquire));
        let message = captured.lock().unwrap().take().unwrap();
        assert!(message.contains("driver cause"));
        assert!(
            map_error(wgpu::BufferAsyncError, Some(RenderError::Gpu(message)))
                .to_string()
                .contains("driver cause")
        );
    }

    #[test]
    fn scene_buffers_upload_once_per_device_generation() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        let mut handle = Scene::new(scene());

        renderer.ensure_uploaded(&mut handle).expect("first upload");
        renderer
            .ensure_uploaded(&mut handle)
            .expect("cached upload");
        assert_eq!(renderer.counters.scene_uploads, 1);

        // A recreated device invalidates the buffers: the same handle
        // re-uploads lazily on next use.
        note_device_lost(
            &renderer.lost,
            &renderer.uncaptured,
            wgpu::DeviceLostReason::Unknown,
            "retired device",
        );
        pollster::block_on(renderer.recover_if_lost()).expect("recreate");
        assert!(renderer.take_uncaptured().is_ok());
        renderer.ensure_uploaded(&mut handle).expect("re-upload");
        assert_eq!(renderer.counters.scene_uploads, 2);
        renderer.destroy();
    }

    #[test]
    fn finish_view_retains_the_device_cause_of_a_mapping_failure() {
        let renderer = pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
            .expect("renderer");
        for cause in [None, Some("driver removed the device")] {
            *renderer.uncaptured.lock().unwrap() = cause.map(str::to_owned);
            let (sender, receiver) = futures_channel::oneshot::channel();
            sender.send(Err(wgpu::BufferAsyncError)).unwrap();
            let view = InFlightView {
                #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
                probe: None,
                buffer: Arc::new(Readback(renderer.state.device.create_buffer(
                    &wgpu::BufferDescriptor {
                        label: Some("failed map"),
                        size: 256,
                        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                        mapped_at_creation: false,
                    },
                ))),
                receiver,
                submission: renderer.state.queue.submit([]),
                height: 1,
                unpadded_bytes_per_row: 256,
                padded_bytes_per_row: 256,
                opaque_background: false,
            };
            let error = renderer
                .finish_view_blocking(view)
                .err()
                .expect("mapping failed");
            assert!(error.to_string().contains(cause.unwrap_or("map_async")));
            assert!(renderer.take_uncaptured().is_ok());
        }
    }

    #[test]
    fn finish_view_reports_the_failed_submission_rather_than_the_poll_symptom() {
        let renderer = pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
            .expect("renderer");
        let device = &renderer.state.device;
        let source = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("destroyed source"),
            size: 256,
            usage: wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: 256,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        encoder.copy_buffer_to_buffer(&source, 0, &readback, 0, 256);
        let commands = encoder.finish();
        // Destroying a referenced buffer makes the submission fail validation:
        // wgpu reports it through the uncaptured handler and never advances the
        // successful-submission index, so the wait alone would only say so.
        source.destroy();
        let submission = renderer.state.queue.submit(Some(commands));
        let (_sender, receiver) = futures_channel::oneshot::channel();
        let view = InFlightView {
            #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
            probe: None,
            buffer: Arc::new(Readback(readback)),
            receiver,
            submission,
            height: 1,
            unpadded_bytes_per_row: 256,
            padded_bytes_per_row: 256,
            opaque_background: false,
        };

        let error = renderer
            .finish_view_blocking(view)
            .err()
            .expect("a failed submission must not read back");
        assert!(matches!(&error, RenderError::Gpu(message) if message.contains("destroyed")));
        // The cause is drained; a later poll symptom is reported as itself.
        assert!(renderer.take_uncaptured().is_ok());
        renderer.destroy();
    }

    #[test]
    fn finish_view_reports_the_poll_symptom_when_no_cause_was_captured() {
        let renderer = pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
            .expect("renderer");
        let device = &renderer.state.device;
        let source = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("destroyed source"),
            size: 256,
            usage: wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: 256,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        encoder.copy_buffer_to_buffer(&source, 0, &readback, 0, 256);
        let commands = encoder.finish();
        source.destroy();
        let submission = renderer.state.queue.submit(Some(commands));
        // Another consumer drained the cause first: the wait's own error is
        // all that is left to report, and it must still be a `gpu: poll:` one.
        assert!(renderer.take_uncaptured().is_err());
        let (_sender, receiver) = futures_channel::oneshot::channel();
        let view = InFlightView {
            #[cfg(all(feature = "bench", not(target_arch = "wasm32")))]
            probe: None,
            buffer: Arc::new(Readback(readback)),
            receiver,
            submission,
            height: 1,
            unpadded_bytes_per_row: 256,
            padded_bytes_per_row: 256,
            opaque_background: false,
        };

        let error = renderer
            .finish_view_blocking(view)
            .err()
            .expect("a failed submission must not read back");
        assert!(error.to_string().starts_with("gpu: poll:"), "{error}");
        renderer.destroy();
    }

    #[test]
    fn renderer_surfaces_uncaptured_errors_and_recovers_from_device_loss() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");

        // A buffer usage violation is an uncaptured validation error; the
        // stored message must surface as a deterministic `gpu:` failure.
        let bad = renderer
            .state
            .device
            .create_buffer(&wgpu::BufferDescriptor {
                label: Some("uncaptured probe"),
                size: 4,
                usage: wgpu::BufferUsages::UNIFORM,
                mapped_at_creation: false,
            });
        bad.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        let _ = renderer.state.device.poll(wgpu::PollType::Poll);
        assert!(matches!(
            renderer.take_uncaptured(),
            Err(RenderError::Gpu(_))
        ));
        // The slot is drained: the next check is clean.
        assert!(renderer.take_uncaptured().is_ok());

        // Simulated device loss: the next plan entry rebuilds the device and
        // bumps the generation so stale scene buffers re-upload.
        let generation = renderer.generation;
        renderer.lost.store(true, Ordering::Release);
        pollster::block_on(renderer.recover_if_lost()).expect("recreate");
        assert_eq!(renderer.generation, generation + 1);
        assert_eq!(renderer.counters.device_requests, 2);
        // Without a pending loss the call is a no-op.
        pollster::block_on(renderer.recover_if_lost()).expect("no-op");
        assert_eq!(renderer.counters.device_requests, 2);

        // Explicit destroy is not a loss: the callback ignores Destroyed.
        renderer.destroy();
        let _ = renderer.state.device.poll(wgpu::PollType::Poll);
        assert!(!renderer.lost.load(Ordering::Acquire));
    }

    #[test]
    fn requested_extents_respect_the_initialized_device_limits() {
        let limits = wgpu::Limits {
            max_texture_dimension_2d: 8192,
            max_buffer_size: 256 * 1024 * 1024,
            ..Default::default()
        };
        assert!(validate_target_extent(8192, 8192, &limits).is_ok());
        assert!(
            validate_target_extent(8193, 16, &limits)
                .unwrap_err()
                .to_string()
                .contains("maxTextureDimension2D")
        );
        let small = wgpu::Limits {
            max_buffer_size: 128 * 1024 * 1024,
            ..limits
        };
        assert!(
            validate_target_extent(8192, 8192, &small)
                .unwrap_err()
                .to_string()
                .contains("maxBufferSize")
        );
        assert!(validate_target_extent(768, 432, &small).is_ok());
    }

    #[test]
    fn pass_local_targets_are_transient_but_loaded_depth_and_hdr_are_not() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        for transparency in [false, true, false, true] {
            renderer.ensure_targets(320, 240, false, true, transparency);
            let targets = renderer.state.targets.as_ref().unwrap();
            let transient = |view: &wgpu::TextureView| {
                view.texture()
                    .usage()
                    .contains(wgpu::TextureUsages::TRANSIENT_ATTACHMENT)
            };
            assert!(transient(&targets.msaa_view));
            assert!(transient(&targets.ao.as_ref().unwrap().test_depth_view));
            assert_eq!(transient(&targets.hdr_msaa), !transparency);
            assert!(!transient(&targets.depth_view));
            assert!(!transient(&targets.opaque_view));
            assert_eq!(targets.msaa_view.texture().sample_count(), 4);
            assert_eq!(targets.hdr_msaa.texture().sample_count(), 4);
            assert_eq!(targets.depth_view.texture().format(), DEPTH_FORMAT);
        }
        assert_eq!(renderer.counters.target_allocations, 1);
    }

    #[test]
    fn conditional_targets_follow_visible_surfaces_and_preserve_pixels() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        let opaque = cube_scene();
        let expected = render_test_scene(&mut renderer, opaque.clone(), physical_options());
        assert!(
            renderer
                .state
                .targets
                .as_ref()
                .unwrap()
                .composite_view
                .is_none()
        );
        for transmission in [false, true] {
            let mut transparent = opaque.clone();
            let material = &mut transparent.meshes[0].primitives[0].material;
            if transmission {
                material.transmission[0] = 0.8;
            } else {
                material.base_color[3] = 0.4;
                material.alpha_mode = 2.0;
            }
            let actual = render_test_scene(&mut renderer, transparent.clone(), physical_options());
            let targets = renderer.state.targets.as_ref().unwrap();
            assert!(targets.composite_view.is_some());
            assert_eq!(targets.transmission, transmission);
            let mut cold =
                pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                    .expect("cold renderer");
            assert_eq!(
                actual.rgba,
                render_test_scene(&mut cold, transparent.clone(), physical_options()).rgba
            );
            let hidden = RenderOptions {
                surfaces: false,
                ..physical_options()
            };
            render_test_scene(&mut renderer, transparent, hidden);
            let targets = renderer.state.targets.as_ref().unwrap();
            assert!(targets.composite_view.is_none());
            assert!(!targets.transmission);
            assert_eq!(
                expected.rgba,
                render_test_scene(&mut renderer, opaque.clone(), physical_options()).rgba
            );
        }
    }

    #[test]
    fn overlapping_readbacks_survive_resize_and_only_allocate_when_busy() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        let mut scene = Scene::new(cube_scene());
        let options = physical_options();
        let presentation = renderer
            .prepare_presentation(&scene.parsed, &options)
            .expect("presentation");
        let make_entry = |options: RenderOptions| PlanEntry {
            id: "overlap".into(),
            format: ImageFormat::Raw,
            prepared: crate::capture_overlay::prepare_view(&scene.parsed, &options)
                .expect("camera"),
            options,
        };
        let entry = make_entry(options.clone());
        let resized = make_entry(RenderOptions {
            width: 127,
            height: 85,
            ..options
        });
        let buffers = renderer.ensure_uploaded(&mut scene).expect("upload");
        let first = renderer
            .begin_view(buffers, &presentation, &entry)
            .expect("first");
        assert_eq!(renderer.state.targets.as_ref().unwrap().readback.len(), 1);
        let second = renderer
            .begin_view(buffers, &presentation, &entry)
            .expect("second");
        assert_eq!(renderer.state.targets.as_ref().unwrap().readback.len(), 2);
        assert!(!Arc::ptr_eq(&first.buffer, &second.buffer));
        let expected = renderer.finish_view_blocking(first).expect("first pixels");
        let third = renderer
            .begin_view(buffers, &presentation, &resized)
            .expect("resize");
        assert_eq!(renderer.state.targets.as_ref().unwrap().readback.len(), 1);
        assert_eq!(
            expected.rgba,
            renderer
                .finish_view_blocking(second)
                .expect("retired pixels")
                .rgba
        );
        let resized_pixels = renderer
            .finish_view_blocking(third)
            .expect("resized pixels");
        assert_eq!((resized_pixels.width, resized_pixels.height), (127, 85));
        let fourth = renderer
            .begin_view(buffers, &presentation, &resized)
            .expect("reuse");
        assert_eq!(renderer.state.targets.as_ref().unwrap().readback.len(), 1);
        assert_eq!(
            resized_pixels.rgba,
            renderer
                .finish_view_blocking(fourth)
                .expect("reused pixels")
                .rgba
        );
        renderer.take_uncaptured().expect("validation");
    }

    #[cfg(feature = "bench")]
    #[test]
    fn opaque_single_targets_do_not_reserve_transparency_or_overlap_storage() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");
        renderer.ensure_targets(768, 432, false, false, false);
        let ledger = profile::ledger(renderer.state.targets.as_ref().expect("targets"));
        assert_eq!(
            ledger["readbackBytes"].as_array().unwrap().len(),
            1,
            "a single view has no overlapping readback"
        );
        assert!(
            !ledger["textures"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["label"] == "composite HDR"),
            "opaque output resolves directly into opaque HDR"
        );
    }

    #[test]
    fn pipeline_and_target_caches_reuse_and_evict() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");

        let first = renderer.ensure_pipelines(2.0, true, ShaderFeatures::default());
        assert_eq!(
            renderer.ensure_pipelines(2.0, true, ShaderFeatures::default()),
            first
        );
        assert_eq!(renderer.counters.pipeline_sets, 1);
        assert_ne!(
            renderer.ensure_pipelines(2.0, false, ShaderFeatures::default()),
            first
        );
        let second = renderer.ensure_pipelines(4.0, true, ShaderFeatures::default());
        assert_ne!(first, second);
        assert_eq!(renderer.counters.pipeline_sets, 3);
        let extras = ShaderFeatures {
            anisotropy_sheen: true,
            ..ShaderFeatures::default()
        };
        let active = renderer.ensure_pipelines(2.0, true, extras);
        assert_ne!(active, first);
        assert_eq!(renderer.ensure_pipelines(2.0, true, extras), active);
        assert_eq!(
            renderer.ensure_pipelines(2.0, true, ShaderFeatures::default()),
            first
        );
        assert_eq!(renderer.counters.pipeline_sets, 4);

        // Fill past the cap: the oldest entry is evicted, the cache stays bounded.
        for width in 0..MAX_CACHED_PIPELINE_PAIRS as u32 {
            renderer.ensure_pipelines(8.0 + width as f32, true, ShaderFeatures::default());
        }
        assert_eq!(renderer.state.pipelines.len(), MAX_CACHED_PIPELINE_PAIRS);
        assert!(
            !renderer
                .state
                .pipelines
                .iter()
                .any(|(key, _)| *key == u64::from(2.0f32.to_bits() << 1 | 1))
        );

        renderer.ensure_targets(320, 240, false, false, false);
        assert_eq!(renderer.counters.target_allocations, 1);
        renderer.ensure_targets(320, 240, false, false, false);
        assert_eq!(renderer.counters.target_allocations, 1);
        renderer.ensure_targets(640, 480, false, false, false);
        assert_eq!(renderer.counters.target_allocations, 2);
        // The retention guard keeps ordinary sizes and evicts oversized ones.
        renderer.trim_targets();
        assert!(renderer.state.targets.is_some());
        renderer.ensure_targets(4096, 4096, false, false, false);
        renderer.trim_targets();
        assert!(renderer.state.targets.is_none());
        // Nothing retained: trimming again is a no-op.
        renderer.trim_targets();
        assert!(renderer.state.targets.is_none());

        renderer.ensure_targets(640, 480, false, false, false);
        let targets = renderer.state.targets.as_ref().expect("targets");
        assert_eq!(targets.readback.len(), 1);
        assert_eq!(targets.unpadded_bytes_per_row, 640 * 4);
        assert_eq!(
            targets.padded_bytes_per_row % wgpu::COPY_BYTES_PER_ROW_ALIGNMENT,
            0
        );
        renderer.ensure_targets(640, 480, false, true, false);
        assert!(
            renderer
                .state
                .targets
                .as_ref()
                .expect("AO targets")
                .ao
                .is_some()
        );
        assert_eq!(renderer.counters.target_allocations, 5);
        renderer.ensure_targets(640, 480, false, true, false);
        assert_eq!(renderer.counters.target_allocations, 5);
        renderer.ensure_ao_pipelines(0);
        let pipeline_sets = renderer.counters.pipeline_sets;
        renderer.ensure_ao_pipelines(0);
        assert_eq!(renderer.counters.pipeline_sets, pipeline_sets);
    }

    /// musl starts every process at a 128 KiB default and never lowers it, so
    /// the raise is observable once per process: it reports movement exactly
    /// when there was room to move, and leaves the target in place after.
    #[cfg(all(target_os = "linux", target_env = "musl"))]
    mod musl_default_thread_stack {
        use super::*;

        fn default_stack_bytes() -> usize {
            let mut attr = std::mem::MaybeUninit::<libc::pthread_attr_t>::uninit();
            let mut size = 0;
            unsafe {
                assert_eq!(pthread_getattr_default_np(attr.as_mut_ptr()), 0);
                assert_eq!(libc::pthread_attr_getstacksize(attr.as_ptr(), &mut size), 0);
            }
            size
        }

        #[test]
        fn raises_the_default_to_the_size_glibc_would_have_given_and_holds_it() {
            let below_target = default_stack_bytes() < DRIVER_THREAD_STACK_BYTES;
            assert_eq!(raise_default_thread_stack(), below_target);
            assert_eq!(default_stack_bytes(), DRIVER_THREAD_STACK_BYTES);
            assert!(!raise_default_thread_stack());
            assert_eq!(default_stack_bytes(), DRIVER_THREAD_STACK_BYTES);
        }
    }
}
