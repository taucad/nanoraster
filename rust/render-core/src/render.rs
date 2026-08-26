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

use crate::encode::{ImageFormat, encode};
use crate::glb::{self, MODE_TRIANGLES, Material};
use crate::{
    CameraProjection, LightingSpace, MAX_LIGHTS, RenderCamera, RenderError, RenderOptions,
    with_view_result,
};
use glam::{Mat4, Vec3};
use std::fmt::Display;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;

const MSAA_SAMPLES: u32 = 4;
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
    source_node_index: usize,
    mesh_index: usize,
    bind_group: wgpu::BindGroup,
}

/// One GLB's geometry uploaded to one renderer's device.
pub(crate) struct SceneBuffers {
    gpu_assets: Vec<GpuMeshAsset>,
    gpu_instances: Vec<GpuInstance>,
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
    cap: wgpu::RenderPipeline,
    line: wgpu::RenderPipeline,
}

struct GpuCap {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    index_count: u32,
}

pub(crate) struct PresentationBuffers {
    cap: Option<GpuCap>,
    boundary: Option<wgpu::Buffer>,
    boundary_count: u32,
    boundary_material: Option<wgpu::BindGroup>,
    identity_object: Option<wgpu::BindGroup>,
}

/// Render targets plus readback for one output size. The two readback buffers
/// ping-pong so the plan executor can submit view N+1 while view N's buffer is
/// still mapped for the CPU.
struct SizedTargets {
    width: u32,
    height: u32,
    extent: wgpu::Extent3d,
    msaa_view: wgpu::TextureView,
    depth_view: wgpu::TextureView,
    resolve_texture: wgpu::Texture,
    resolve_view: wgpu::TextureView,
    readback: [wgpu::Buffer; 2],
    unpadded_bytes_per_row: u32,
    padded_bytes_per_row: u32,
}

/// One submitted view awaiting readback. Owns clones of the wgpu handles it
/// needs so target-cache turnover cannot invalidate it.
struct InFlightView {
    buffer: wgpu::Buffer,
    receiver: futures_channel::oneshot::Receiver<Result<(), wgpu::BufferAsyncError>>,
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    submission: wgpu::SubmissionIndex,
    height: u32,
    unpadded_bytes_per_row: u32,
    padded_bytes_per_row: u32,
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
    device: wgpu::Device,
    queue: wgpu::Queue,
    shader: wgpu::ShaderModule,
    frame_buffer: wgpu::Buffer,
    frame_bind_group: wgpu::BindGroup,
    prim_layout: wgpu::BindGroupLayout,
    object_layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
    /// Keyed on `line_width_px` bits (depth-bias slope scale bakes it).
    pipelines: Vec<(u32, PipelinePair)>,
    /// Last-used target set, keyed on (width, height).
    targets: Option<SizedTargets>,
    /// Next readback slot; alternates so at most one view is ever in flight
    /// against a mapped buffer.
    slot: usize,
}

/// Persistent GPU half: one adapter/device/pipeline set reused across calls.
pub struct Renderer {
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
fn note_device_lost(lost: &AtomicBool, reason: wgpu::DeviceLostReason) {
    if !matches!(reason, wgpu::DeviceLostReason::Destroyed) {
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

fn map_error(error: wgpu::BufferAsyncError) -> RenderError {
    gpu_error("map_async", error)
}

fn mapped_range_error(error: wgpu::MapRangeError) -> RenderError {
    gpu_error("mapped range", error)
}

/// Resolve fitted or fixed camera framing into WebGPU view/projection matrices.
pub(crate) fn camera_state(scene: &glb::Scene, options: &RenderOptions) -> CameraState {
    let (min, max) = scene
        .presented_bounds(options)
        .unwrap_or(([-1.0; 3], [1.0; 3]));
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
            let (near, far) = position_clip_planes(scene, options, view, (eye - target).length());
            let projection = match projection {
                CameraProjection::Orthographic { .. } => {
                    let (half_width, half_height) =
                        orthographic_half_extents(
                            scene,
                            options,
                            view,
                            aspect,
                            *padding_factor,
                            radius,
                        );
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
            let (near, far) = clipping.map_or_else(
                || position_clip_planes(scene, options, view, (eye - target).length()),
                |planes| (planes.near, planes.far),
            );
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
    scene: &glb::Scene,
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
    scene: &glb::Scene,
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
    scene: &glb::Scene,
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

fn position_clip_planes(
    scene: &glb::Scene,
    options: &RenderOptions,
    view: Mat4,
    fallback_depth: f32,
) -> (f32, f32) {
    let mut nearest = f32::INFINITY;
    let mut farthest = 0.0_f32;
    for_each_camera_position(scene, options, |position| {
        let depth = -view.transform_point3(position).z;
        if depth > 0.0 {
            nearest = nearest.min(depth);
            farthest = farthest.max(depth);
        }
    });
    if farthest <= 0.0 {
        let depth = fallback_depth.max(1.0);
        return (depth * 0.001, depth * 2.0);
    }
    let near = (nearest * 0.5).max(farthest * 1e-6).max(f32::MIN_POSITIVE);
    (near, (farthest * 2.0).max(near * 2.0))
}

fn orthographic_half_extents(
    scene: &glb::Scene,
    options: &RenderOptions,
    view: Mat4,
    aspect: f32,
    padding: f32,
    radius: f32,
) -> (f32, f32) {
    let mut max_x = 0.0_f32;
    let mut max_y = 0.0_f32;
    for_each_camera_position(scene, options, |position| {
        let camera = view.transform_point3(position);
        max_x = max_x.max(camera.x.abs());
        max_y = max_y.max(camera.y.abs());
    });
    let safe_padding = padding.max(0.001);
    let minimum = (radius * 0.001).max(f32::MIN_POSITIVE);
    let mut half_width = (max_x / safe_padding).max(minimum);
    let mut half_height = (max_y / safe_padding).max(minimum);
    if half_width / half_height < aspect {
        half_width = half_height * aspect;
    } else {
        half_height = half_width / aspect;
    }
    (half_width, half_height)
}

// The one definition of the `Frame` uniform (see `shader.wgsl`): two mat4 and
// a viewport vec4, then eight Lights at a 32-byte stride, a 16-byte lighting
// tail, six section planes, and a 16-byte section tail. 528 bytes.
const FRAME_FLOATS: usize = 132;
const FRAME_LIGHTS: usize = 36;
const FRAME_LIGHT_STRIDE: usize = 8;
const FRAME_TAIL: usize = 100;
const FRAME_SECTION_PLANES: usize = 104;
const FRAME_SECTION_TAIL: usize = 128;

fn frame_uniform(
    view_projection: Mat4,
    view: Mat4,
    options: &RenderOptions,
) -> [f32; FRAME_FLOATS] {
    let lighting = &options.lighting;
    let mut data = [0f32; FRAME_FLOATS];
    data[..16].copy_from_slice(&view_projection.to_cols_array());
    data[16..32].copy_from_slice(&view.to_cols_array());
    data[32..FRAME_LIGHTS].copy_from_slice(&[
        options.width as f32,
        options.height as f32,
        line_width_px(options),
        0.0,
    ]);
    for (index, light) in lighting.lights.iter().take(MAX_LIGHTS).enumerate() {
        // World-space rigs are rotated into view space here, once per view,
        // so the shader stays view-space and never learns the difference.
        let direction = match lighting.space {
            LightingSpace::View => Vec3::from(light.direction),
            LightingSpace::World => view.transform_vector3(Vec3::from(light.direction)),
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
    if let Some(sections) = &options.sections {
        for (index, plane) in sections.planes.iter().enumerate() {
            let base = FRAME_SECTION_PLANES + index * 4;
            let normal = Vec3::from(plane.normal).normalize();
            data[base..base + 3].copy_from_slice(&normal.to_array());
            data[base + 3] = -normal.dot(Vec3::from(plane.point));
        }
        data[FRAME_SECTION_TAIL] = f32::from_bits(sections.planes.len() as u32);
        data[FRAME_SECTION_TAIL + 1] = f32::from_bits(u32::from(sections.clip_surfaces));
        data[FRAME_SECTION_TAIL + 2] = f32::from_bits(u32::from(sections.clip_lines));
    }
    data
}

fn line_width_px(options: &RenderOptions) -> f32 {
    options.line_width
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
    // Surfaces take a slope-scaled polygon offset (the classic CAD
    // shaded+wireframe move) instead of lines being pulled forward: the edge
    // quad is expanded in screen space at the segment's depth, so wherever it
    // overhangs a nearer surface — grazing walls near silhouettes, bores,
    // ridges seen edge-on — a constant line-side bias loses to the surface's
    // depth gradient and the stroke gets chewed to a hairline. Pushing each
    // surface back by its own screen-space depth slope times the stroke's
    // half-width covers exactly that overhang at any resolution; `clamp`
    // bounds the push on near-tangent surfaces so hidden edges behind them
    // stay hidden.
    let mesh_depth_state = Some(wgpu::DepthStencilState {
        format: DEPTH_FORMAT,
        depth_write_enabled: Some(true),
        depth_compare: Some(wgpu::CompareFunction::Less),
        stencil: wgpu::StencilState::default(),
        bias: wgpu::DepthBiasState {
            constant: 2,
            slope_scale: line_width_px * 0.5 + 1.0,
            clamp: 0.01,
        },
    });
    let multisample = wgpu::MultisampleState {
        count: MSAA_SAMPLES,
        mask: !0,
        alpha_to_coverage_enabled: false,
    };

    let mesh = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("mesh"),
        layout: Some(pipeline_layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_mesh"),
            compilation_options: Default::default(),
            buffers: &[Some(position_layout.clone()), Some(normal_layout)],
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs_mesh"),
            compilation_options: Default::default(),
            targets: std::slice::from_ref(&color_target),
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            // CAD solids are frequently marked doubleSided by the kernels.
            cull_mode: None,
            ..Default::default()
        },
        depth_stencil: mesh_depth_state,
        multisample,
        multiview_mask: None,
        cache: None,
    });

    // ponytail: pipelines compiled sequentially on purpose — llvmpipe SIGSEGVs
    // under concurrent pipeline compilation (bevy #13708).
    let line = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("line"),
        layout: Some(pipeline_layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_line"),
            compilation_options: Default::default(),
            buffers: &[Some(segment_layout)],
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs_line"),
            compilation_options: Default::default(),
            targets: std::slice::from_ref(&color_target),
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleStrip,
            cull_mode: None,
            ..Default::default()
        },
        depth_stencil: line_depth_state,
        multisample,
        multiview_mask: None,
        cache: None,
    });

    let cap_layout = wgpu::VertexBufferLayout {
        array_stride: 68,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![
            0 => Float32x3,
            1 => Float32x2,
            2 => Float32x4,
            3 => Float32x4,
            4 => Float32x4
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

    PipelinePair { mesh, cap, line }
}

impl DeviceState {
    async fn new(
        power: wgpu::PowerPreference,
        lost: &Arc<AtomicBool>,
        uncaptured: &Arc<Mutex<Option<String>>>,
    ) -> Result<Self, RenderError> {
        let adapter = request_adapter(power).await?;
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
                ..Default::default()
            })
            .await
            .map_err(request_device_error)?;

        device.set_device_lost_callback({
            let lost = lost.clone();
            move |reason, _message| note_device_lost(&lost, reason)
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

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("render-core"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
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
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let frame_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("frame"),
            layout: &frame_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: frame_buffer.as_entire_binding(),
            }],
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

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("render-core"),
            bind_group_layouts: &[
                Some(&frame_layout),
                Some(&prim_layout),
                Some(&object_layout),
            ],
            immediate_size: 0,
        });

        Ok(Self {
            device,
            queue,
            shader,
            frame_buffer,
            frame_bind_group,
            prim_layout,
            object_layout,
            pipeline_layout,
            pipelines: Vec::new(),
            targets: None,
            slot: 0,
        })
    }
}

impl Renderer {
    pub async fn new(power: wgpu::PowerPreference) -> Result<Self, RenderError> {
        let lost = Arc::new(AtomicBool::new(false));
        let uncaptured = Arc::new(Mutex::new(None));
        let state = DeviceState::new(power, &lost, &uncaptured).await?;
        Ok(Self {
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
            let mut data = [0.0f32; 8];
            data[..4].copy_from_slice(&material.base_color);
            data[4] = material.metallic;
            data[5] = material.roughness;
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
                        surfaces.push(GpuMesh {
                            source_primitive_index: primitive.source_index,
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

        SceneBuffers {
            gpu_assets,
            gpu_instances,
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
        if geometry.boundaries.is_empty() {
            return Ok(PresentationBuffers {
                cap,
                boundary: None,
                boundary_count: 0,
                boundary_material: None,
                identity_object: None,
            });
        }

        let boundary = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("section boundaries"),
            contents: bytemuck::cast_slice(&geometry.boundaries),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let material = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("section boundary material"),
            contents: bytemuck::cast_slice(&[0.0_f32, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0]),
            usage: wgpu::BufferUsages::UNIFORM,
        });
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
        Ok(PresentationBuffers {
            cap,
            boundary: Some(boundary),
            boundary_count: (geometry.boundaries.len() / 6) as u32,
            boundary_material: Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("section boundary material"),
                layout: &self.state.prim_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: material.as_entire_binding(),
                }],
            })),
            identity_object: Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("section boundary object"),
                layout: &self.state.object_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: object.as_entire_binding(),
                }],
            })),
        })
    }

    /// Index of the pipeline pair for this stroke width, creating and caching
    /// it on first sight.
    fn ensure_pipelines(&mut self, line_width_px: f32) -> usize {
        let key = line_width_px.to_bits();
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
        );
        self.state.pipelines.push((key, pair));
        self.state.pipelines.len() - 1
    }

    /// Keep the last-used target set; recreate on size change (R15 mixed-size
    /// plans cycle it within one job).
    fn ensure_targets(&mut self, width: u32, height: u32) {
        if matches!(&self.state.targets, Some(targets) if targets.width == width && targets.height == height)
        {
            return;
        }
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
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
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

        // Readback buffers with 256-byte-aligned rows; two so the executor can
        // keep one view in flight while the previous one is mapped.
        let unpadded_bytes_per_row = width * 4;
        let padded_bytes_per_row = unpadded_bytes_per_row
            .div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let readback = std::array::from_fn(|_| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("readback"),
                size: (padded_bytes_per_row * height) as u64,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            })
        });

        self.state.targets = Some(SizedTargets {
            width,
            height,
            extent,
            msaa_view: msaa_texture.create_view(&wgpu::TextureViewDescriptor::default()),
            depth_view: depth_texture.create_view(&wgpu::TextureViewDescriptor::default()),
            resolve_view: resolve_texture.create_view(&wgpu::TextureViewDescriptor::default()),
            resolve_texture,
            readback,
            unpadded_bytes_per_row,
            padded_bytes_per_row,
        });
        self.state.slot = 0;
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
        let options = &entry.options;
        self.ensure_targets(options.width, options.height);
        let pipeline_index = self.ensure_pipelines(line_width_px(options));
        let state = &self.state;
        let targets = state.targets.as_ref().expect("targets ensured above");
        let pair = &state.pipelines[pipeline_index].1;
        let slot = state.slot;

        let camera = entry.prepared.camera;
        let mvp = camera.projection * camera.view;
        let frame_data = frame_uniform(mvp, camera.view, options);
        state
            .queue
            .write_buffer(&state.frame_buffer, 0, bytemuck::cast_slice(&frame_data));

        let mut encoder = state
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("render"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("render"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &targets.msaa_view,
                    depth_slice: None,
                    resolve_target: Some(&targets.resolve_view),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(clear_color(options)),
                        store: wgpu::StoreOp::Discard,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &targets.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });

            pass.set_bind_group(0, &state.frame_bind_group, &[]);
            if options.surfaces {
                pass.set_pipeline(&pair.mesh);
                for instance in &scene.gpu_instances {
                    let asset = &scene.gpu_assets[instance.mesh_index];
                    pass.set_bind_group(2, &instance.bind_group, &[]);
                    for mesh in &asset.surfaces {
                        if !primitive_selected(
                            options,
                            instance.source_node_index,
                            asset.source_mesh_index,
                            mesh.source_primitive_index,
                        ) {
                            continue;
                        }
                        pass.set_bind_group(1, &mesh.bind_group, &[]);
                        pass.set_vertex_buffer(0, mesh.positions.slice(..));
                        pass.set_vertex_buffer(1, mesh.normals.slice(..));
                        pass.set_index_buffer(mesh.indices.slice(..), wgpu::IndexFormat::Uint32);
                        pass.draw_indexed(0..mesh.index_count, 0, 0..1);
                    }
                }
            }
            if let Some(cap) = &presentation.cap {
                pass.set_pipeline(&pair.cap);
                pass.set_vertex_buffer(0, cap.vertices.slice(..));
                pass.set_index_buffer(cap.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..cap.index_count, 0, 0..1);
            }
            if options.lines {
                pass.set_pipeline(&pair.line);
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
            if let (Some(boundary), Some(material), Some(object)) = (
                &presentation.boundary,
                &presentation.boundary_material,
                &presentation.identity_object,
            ) {
                pass.set_pipeline(&pair.line);
                pass.set_bind_group(1, material, &[]);
                pass.set_bind_group(2, object, &[]);
                pass.set_vertex_buffer(0, boundary.slice(..));
                pass.draw(0..8, 0..presentation.boundary_count);
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
        let submission = state.queue.submit(Some(encoder.finish()));

        let (sender, receiver) = futures_channel::oneshot::channel();
        readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });

        let in_flight = InFlightView {
            buffer: readback.clone(),
            receiver,
            submission,
            height: options.height,
            unpadded_bytes_per_row: targets.unpadded_bytes_per_row,
            padded_bytes_per_row: targets.padded_bytes_per_row,
        };
        self.state.slot ^= 1;
        Ok(in_flight)
    }

    /// De-pad the mapped readback rows into tightly packed RGBA.
    fn read_back(&self, view: &InFlightView) -> Result<Rendered, RenderError> {
        let slice = view.buffer.slice(..);
        let mut rgba = Vec::with_capacity((view.unpadded_bytes_per_row * view.height) as usize);
        {
            let data = slice.get_mapped_range().map_err(mapped_range_error)?;
            for row in 0..view.height {
                let start = (row * view.padded_bytes_per_row) as usize;
                rgba.extend_from_slice(&data[start..start + view.unpadded_bytes_per_row as usize]);
            }
        }
        view.buffer.unmap();
        self.take_uncaptured()?;
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
            .map_err(map_error)?;
        self.read_back(&view)
    }

    /// Wait for one in-flight view and read its pixels back (wasm: the browser
    /// event loop delivers the map callback while other work proceeds).
    #[cfg(target_arch = "wasm32")]
    async fn finish_view(&self, mut view: InFlightView) -> Result<Rendered, RenderError> {
        (&mut view.receiver)
            .await
            .map_err(|_| RenderError::Gpu("map_async: callback dropped".into()))?
            .map_err(map_error)?;
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
    let bytes = with_view_result(encode(&rendered, entry.format), &entry.id)?;
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
                primitives: vec![glb::Primitive {
                    source_index: 0,
                    mode: glb::MODE_LINES,
                    positions,
                    normals: Vec::new(),
                    indices,
                    material: glb::Material {
                        base_color: [0.0, 0.0, 0.0, 1.0],
                        metallic: 0.0,
                        roughness: 1.0,
                    },
                }],
            }],
            instances: vec![glb::MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::IDENTITY,
                normal_matrix: Mat4::IDENTITY,
            }],
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
                primitives: vec![glb::Primitive {
                    source_index: 0,
                    mode: glb::MODE_LINES,
                    positions,
                    normals: Vec::new(),
                    indices: vec![0, 1, 2, 3],
                    material: glb::Material {
                        base_color: [0.0, 0.0, 0.0, 1.0],
                        metallic: 0.0,
                        roughness: 1.0,
                    },
                }],
            }],
            instances: vec![glb::MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::IDENTITY,
                normal_matrix: Mat4::IDENTITY,
            }],
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
            material: glb::Material {
                base_color: [0.8, 0.8, 0.8, 1.0],
                metallic: 0.0,
                roughness: 1.0,
            },
        }];
        if include_line {
            primitives.push(glb::Primitive {
                source_index: 1,
                mode: glb::MODE_LINES,
                positions: vec![-0.8, 0.0, -0.5, 0.8, 0.0, -0.5],
                normals: Vec::new(),
                indices: vec![0, 1],
                material: glb::Material {
                    base_color: [0.0, 0.0, 0.0, 1.0],
                    metallic: 0.0,
                    roughness: 1.0,
                },
            });
        }
        glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                primitives,
            }],
            instances: vec![glb::MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::IDENTITY,
                normal_matrix: Mat4::IDENTITY,
            }],
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
                primitives: vec![glb::Primitive {
                    source_index: 0,
                    mode: glb::MODE_TRIANGLES,
                    normals: positions.clone(),
                    positions,
                    indices: vec![
                        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0,
                        1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
                    ],
                    material: glb::Material {
                        base_color: [0.5, 0.5, 0.5, 1.0],
                        metallic: 0.0,
                        roughness: 1.0,
                    },
                }],
            }],
            instances: vec![glb::MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::IDENTITY,
                normal_matrix: Mat4::IDENTITY,
            }],
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
        pollster::block_on(renderer.render_entry_to_rgba(buffers, &presentation, &entry))
            .expect("line render")
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
        let data = frame_uniform(Mat4::IDENTITY, view, &options);
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
        // Unwritten slots stay zero, and the studio rig fills exactly three.
        assert_eq!(data[FRAME_LIGHTS + FRAME_LIGHT_STRIDE], 0.0);

        let studio = frame_uniform(Mat4::IDENTITY, view, &RenderOptions::default());
        assert_eq!(studio[FRAME_TAIL].to_bits(), 3);
        assert_eq!(studio[FRAME_TAIL + 3].to_bits(), 1);
        // View space ignores the view matrix; the direction is only normalised.
        assert_close(
            Vec3::from_slice(&studio[FRAME_LIGHTS..FRAME_LIGHTS + 3]),
            Vec3::new(-0.45, 0.61, 0.63).normalize(),
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
        let (near, far) =
            position_clip_planes(&scene, &RenderOptions::default(), view, eye.length());
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
        let explicit = camera_state(
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
        assert!(explicit.projection.is_finite());
        assert_ne!(derived.projection, explicit.projection);
    }

    #[test]
    fn derived_clipping_handles_bounds_behind_the_camera() {
        let scene = line_scene(&[[[-1.0, -1.0, 1.0], [1.0, 1.0, 2.0]]]);
        let (near, far) = position_clip_planes(
            &scene,
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
        assert!(cut.rgba.chunks_exact(4).any(|pixel| pixel[0] < 240));

        let blank = render_test_scene(
            &mut renderer,
            cube_scene(),
            RenderOptions {
                surfaces: false,
                lines: false,
                ..options.clone()
            },
        );
        assert!(blank.rgba.chunks_exact(4).all(|pixel| pixel == [255; 4]));

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
                ..options
            },
        );
        let dark = |x: u32| line.rgba[((128 * 256 + x) * 4) as usize] < 200;
        assert!(!dark(96));
        assert!(dark(160));

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
                .chunks_exact(4)
                .all(|pixel| pixel == [255; 4])
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
            map_error(wgpu::BufferAsyncError)
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
        note_device_lost(&lost, wgpu::DeviceLostReason::Destroyed);
        assert!(!lost.load(Ordering::Acquire));
        note_device_lost(&lost, wgpu::DeviceLostReason::Unknown);
        assert!(lost.load(Ordering::Acquire));
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
        renderer.lost.store(true, Ordering::Release);
        pollster::block_on(renderer.recover_if_lost()).expect("recreate");
        renderer.ensure_uploaded(&mut handle).expect("re-upload");
        assert_eq!(renderer.counters.scene_uploads, 2);
        renderer.destroy();
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
            buffer: readback,
            receiver,
            submission,
            height: 1,
            unpadded_bytes_per_row: 256,
            padded_bytes_per_row: 256,
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
            buffer: readback,
            receiver,
            submission,
            height: 1,
            unpadded_bytes_per_row: 256,
            padded_bytes_per_row: 256,
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
    fn pipeline_and_target_caches_reuse_and_evict() {
        let mut renderer =
            pollster::block_on(Renderer::new(wgpu::PowerPreference::HighPerformance))
                .expect("renderer");

        let first = renderer.ensure_pipelines(2.0);
        assert_eq!(renderer.ensure_pipelines(2.0), first);
        assert_eq!(renderer.counters.pipeline_sets, 1);
        let second = renderer.ensure_pipelines(4.0);
        assert_ne!(first, second);
        assert_eq!(renderer.counters.pipeline_sets, 2);

        // Fill past the cap: the oldest entry is evicted, the cache stays bounded.
        for width in 0..MAX_CACHED_PIPELINE_PAIRS as u32 {
            renderer.ensure_pipelines(8.0 + width as f32);
        }
        assert_eq!(renderer.state.pipelines.len(), MAX_CACHED_PIPELINE_PAIRS);
        assert!(
            !renderer
                .state
                .pipelines
                .iter()
                .any(|(key, _)| *key == 2.0f32.to_bits())
        );

        renderer.ensure_targets(320, 240);
        assert_eq!(renderer.counters.target_allocations, 1);
        renderer.ensure_targets(320, 240);
        assert_eq!(renderer.counters.target_allocations, 1);
        renderer.ensure_targets(640, 480);
        assert_eq!(renderer.counters.target_allocations, 2);
        // The retention guard keeps ordinary sizes and evicts oversized ones.
        renderer.trim_targets();
        assert!(renderer.state.targets.is_some());
        renderer.ensure_targets(4096, 4096);
        renderer.trim_targets();
        assert!(renderer.state.targets.is_none());
        // Nothing retained: trimming again is a no-op.
        renderer.trim_targets();
        assert!(renderer.state.targets.is_none());

        renderer.ensure_targets(640, 480);
        let targets = renderer.state.targets.as_ref().expect("targets");
        assert_eq!(targets.readback.len(), 2);
        assert_eq!(targets.unpadded_bytes_per_row, 640 * 4);
        assert_eq!(
            targets.padded_bytes_per_row % wgpu::COPY_BYTES_PER_ROW_ALIGNMENT,
            0
        );
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
