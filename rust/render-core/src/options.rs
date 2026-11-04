//! Strict JSON request contracts shared by the WASM and N-API bindings.

use crate::encode::ImageFormat;
use crate::{
    AmbientOcclusion, CameraProjection, ClipPlanes, EnvironmentSource, Headlamp, LightCard,
    LightingSpace, MAX_LIGHT_CARDS, MAX_LIGHTS, MAX_SECTION_PLANES, PrimitiveRef, RenderCamera,
    RenderError, RenderOptions, ResolvedLight, ResolvedLighting, SectionPlane, Sections,
    ToneMapping,
};
use serde::{Deserialize, Deserializer, de, de::DeserializeOwned};
use std::collections::HashSet;

pub(crate) const MIN_DIMENSION: u32 = 16;
pub(crate) const MAX_DIMENSION: u32 = 8_192;
pub(crate) const ANNOTATED_MIN_DIMENSION: u32 = 192;
const MAX_LIGHT_COLOR: f32 = 32.0;
const MAX_AMBIENT: f32 = 4.0;
const EXPOSURE_RANGE: std::ops::RangeInclusive<f32> = 0.01..=16.0;
const MAX_ENVIRONMENT_INTENSITY: f32 = 16.0;
/// Headlamp offsets and card positions and sizes, in scene radii.
const MAX_RIG_EXTENT: f32 = 64.0;
/// Card radiance; the viewer's key card is 64.
const MAX_CARD_INTENSITY: f32 = 4_096.0;
const FIELD_OF_VIEW_RANGE: std::ops::RangeInclusive<f32> = 1.0..=179.0;
const ZOOM_RANGE: std::ops::RangeInclusive<f32> = 0.01..=100.0;
const LINE_WIDTH_RANGE: std::ops::RangeInclusive<f32> = 0.25..=16.0;
/// Shorter than this and a direction carries no usable heading.
const MIN_DIRECTION_LENGTH: f32 = 1e-6;

/// Wire shape for fitted perspective/orthographic projection.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum FitProjectionRequest {
    Perspective {
        #[serde(rename = "verticalFieldOfView")]
        vertical_field_of_view: Option<f32>,
    },
    Orthographic,
}

/// Wire shape for a fixed perspective/orthographic projection.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum FixedProjectionRequest {
    Perspective {
        #[serde(rename = "verticalFieldOfView")]
        vertical_field_of_view: Option<f32>,
        zoom: Option<f32>,
    },
    Orthographic {
        #[serde(rename = "verticalSpan")]
        vertical_span: f32,
        zoom: Option<f32>,
    },
}

/// Explicit fixed-camera clipping distances.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipPlanesRequest {
    near: f32,
    far: f32,
}

/// Tagged fitted or fixed camera request.
#[derive(Debug, Deserialize)]
#[serde(tag = "framing", rename_all = "camelCase", deny_unknown_fields)]
pub enum CameraRequest {
    Fit {
        direction: Option<[f32; 3]>,
        up: Option<[f32; 3]>,
        margin: Option<f32>,
        projection: Option<FitProjectionRequest>,
    },
    Fixed {
        position: [f32; 3],
        target: [f32; 3],
        up: [f32; 3],
        projection: Option<FixedProjectionRequest>,
        clipping: Option<ClipPlanesRequest>,
    },
}

/// Wire shape for one directional light.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LightRequest {
    direction: [f32; 3],
    color: [f32; 3],
}

/// Wire shape for the camera-relative headlamp; omitted fields keep the
/// viewer's values.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeadlampRequest {
    intensity: Option<f32>,
    right_offset: Option<f32>,
    up_offset: Option<f32>,
}

/// Wire shape for one rectangular light card.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LightCardRequest {
    position: [f32; 3],
    size: [f32; 2],
    intensity: f32,
    rotation: Option<[f32; 3]>,
}

/// Wire shape for an environment object.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentObjectRequest {
    cards: Option<Vec<LightCardRequest>>,
    intensity: Option<f32>,
}

/// `"studio"`, `"none"`, or an environment object.
#[derive(Debug)]
pub enum EnvironmentRequest {
    Named(String),
    Object(EnvironmentObjectRequest),
}

impl<'de> Deserialize<'de> for EnvironmentRequest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Branch on the JSON shape, as `LightingRequest` does, so a field typo
        // keeps serde's own message.
        let value = serde_json::Value::deserialize(deserializer)?;
        if let serde_json::Value::String(name) = value {
            return Ok(Self::Named(name));
        }
        EnvironmentObjectRequest::deserialize(value)
            .map(Self::Object)
            .map_err(de::Error::custom)
    }
}

/// Wire shape for an explicit rig. Omitted fields inherit the studio value,
/// except that an explicit `lights` array replaces the studio's headlamp
/// unless `headlamp` is given too.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LightingRigRequest {
    lights: Option<Vec<LightRequest>>,
    headlamp: Option<HeadlampRequest>,
    ambient: Option<f32>,
    environment: Option<EnvironmentRequest>,
    space: Option<String>,
    exposure: Option<f32>,
}

/// `"studio"` or an explicit rig.
#[derive(Debug)]
pub enum LightingRequest {
    Preset(String),
    Rig(Box<LightingRigRequest>),
}

/// Wire shape for one source glTF primitive instance.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrimitiveRefRequest {
    node_index: usize,
    mesh_index: usize,
    primitive_index: usize,
}

/// Wire shape for one world-space retained-half-space plane.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SectionPlaneRequest {
    point: [f32; 3],
    normal: [f32; 3],
}

/// Wire shape for configured sections.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SectionsRequest {
    planes: Vec<SectionPlaneRequest>,
    clip_surfaces: Option<bool>,
    clip_lines: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AoRequest {
    #[serde(default, deserialize_with = "present_ao_number")]
    radius_pixels: Option<f32>,
    #[serde(default, deserialize_with = "present_ao_number")]
    intensity: Option<f32>,
    #[serde(default, deserialize_with = "present_ao_number")]
    distance_falloff: Option<f32>,
    #[serde(default, deserialize_with = "present_ao_number")]
    thickness_ratio: Option<f32>,
    #[serde(default, deserialize_with = "present_ao_number")]
    denoise_depth_tolerance: Option<f32>,
    #[serde(default, deserialize_with = "present_ao_number")]
    samples: Option<f32>,
    #[serde(default, deserialize_with = "present_ao_number")]
    resolution_scale: Option<f32>,
}

const AO_RADIUS_PIXELS_RANGE: std::ops::RangeInclusive<f32> = 1.0..=128.0;
const AO_INTENSITY_RANGE: std::ops::RangeInclusive<f32> = 0.0..=8.0;
const AO_DISTANCE_FALLOFF_RANGE: std::ops::RangeInclusive<f32> = 0.01..=1.0;
const AO_THICKNESS_RATIO_RANGE: std::ops::RangeInclusive<f32> = 0.1..=100.0;
const AO_DENOISE_DEPTH_TOLERANCE_RANGE: std::ops::RangeInclusive<f32> = 0.01..=10.0;
const AO_SAMPLES_RANGE: std::ops::RangeInclusive<u32> = 1..=64;
const AO_RESOLUTION_SCALE_RANGE: std::ops::RangeInclusive<f32> = 0.25..=1.0;

/// The one AO admission rule, shared by request resolution and
/// `RenderOptions` validation. Each failure names its field.
pub(crate) fn validate_ao(ao: &AmbientOcclusion) -> Result<(), RenderError> {
    let mut checks = vec![
        ("intensity", ao.intensity, AO_INTENSITY_RANGE),
        (
            "distanceFalloff",
            ao.distance_falloff,
            AO_DISTANCE_FALLOFF_RANGE,
        ),
        (
            "thicknessRatio",
            ao.thickness_ratio,
            AO_THICKNESS_RATIO_RANGE,
        ),
        (
            "denoiseDepthTolerance",
            ao.denoise_depth_tolerance,
            AO_DENOISE_DEPTH_TOLERANCE_RANGE,
        ),
        (
            "resolutionScale",
            ao.resolution_scale,
            AO_RESOLUTION_SCALE_RANGE,
        ),
    ];
    if let Some(radius) = ao.radius_pixels {
        checks.insert(0, ("radiusPixels", radius, AO_RADIUS_PIXELS_RANGE));
    }
    for (name, value, range) in checks {
        if !value.is_finite() || !range.contains(&value) {
            return Err(RenderError::Parse(format!("ao.{name} outside {range:?}")));
        }
    }
    if !AO_SAMPLES_RANGE.contains(&ao.samples) {
        return Err(RenderError::Parse(format!(
            "ao.samples outside {AO_SAMPLES_RANGE:?}"
        )));
    }
    Ok(())
}

fn present_ao_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f32>, D::Error> {
    f32::deserialize(deserializer).map(Some)
}

fn present_ao<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<AoRequest>, D::Error> {
    AoRequest::deserialize(deserializer).map(Some)
}

/// Wrap a present field so an explicit `null` survives as `Some(None)`. Serde
/// only calls this for a field that is actually there, so an absent one still
/// lands on `Default` — `None` — and a plain `Option` would collapse the two.
fn present_option<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer).map(Some)
}

/// Coordinate system of caller-authored spatial values and presentation.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldRequest {
    // `Option<Option<_>>` separates an absent field (`None`, which defaults)
    // from an explicit JSON `null` (`Some(None)`, which is rejected), so
    // `{"up": null}` cannot silently take the default the TypeScript facade
    // rejects outright.
    #[serde(default, deserialize_with = "present_option")]
    up: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_option")]
    forward: Option<Option<String>>,
    unit: Option<String>,
}

#[derive(Clone, Copy, Debug)]
struct WorldTransform {
    rotation: glam::Mat3,
    meters_per_unit: f32,
    axes: [[f32; 3]; 3],
    caller_up: glam::Vec3,
    caller_forward: glam::Vec3,
}

/// Orbit of the default fit camera, in the declared world's own basis:
/// azimuth swings from `world.forward` toward the caller's right, elevation
/// rises above the caller's horizontal plane. Degrees, and `f64` so the
/// resolved direction is the correctly rounded `f32` on every target.
const DEFAULT_FIT_AZIMUTH_DEG: f64 = 45.0;
const DEFAULT_FIT_ELEVATION_DEG: f64 = 30.0;

impl WorldTransform {
    fn point(self, value: glam::Vec3) -> glam::Vec3 {
        self.rotation * value * self.meters_per_unit
    }

    fn direction(self, value: glam::Vec3) -> glam::Vec3 {
        self.rotation * value
    }

    fn length(self, value: f32) -> f32 {
        value * self.meters_per_unit
    }

    /// The default fit direction, built from the orbit above in the declared
    /// basis rather than substituted as a literal, so an omitted `direction`
    /// frames the same picture in every world. Elevation used to drift with
    /// the declaration — about 37.8 degrees for a Z-up world. The glTF default
    /// world still resolves to the historic `[0.612_372_46, 0.5, 0.612_372_46]`
    /// bit for bit: `rotation` is a signed axis permutation, so the multiply
    /// only moves and negates exact components.
    fn default_fit_direction(self) -> glam::Vec3 {
        let (azimuth, elevation) = (
            DEFAULT_FIT_AZIMUTH_DEG.to_radians(),
            DEFAULT_FIT_ELEVATION_DEG.to_radians(),
        );
        let right = self.caller_up.cross(self.caller_forward);
        self.direction(
            (elevation.cos() * azimuth.cos()) as f32 * self.caller_forward
                + (elevation.cos() * azimuth.sin()) as f32 * right
                + elevation.sin() as f32 * self.caller_up,
        )
    }
}

impl<'de> Deserialize<'de> for LightingRequest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Untagged serde collapses every arm's failure into "did not match any
        // variant", which hides a typo like `colour`. Branching on the JSON
        // shape first keeps serde's own field-level message.
        let value = serde_json::Value::deserialize(deserializer)?;
        if let serde_json::Value::String(name) = value {
            return Ok(Self::Preset(name));
        }
        LightingRigRequest::deserialize(value)
            .map(|rig| Self::Rig(Box::new(rig)))
            .map_err(de::Error::custom)
    }
}

/// Wire shape for one image. `format` is optional here only so an absent one
/// is reported as the caller mistake it is (`format is required`) rather than
/// as a serde field error; every request is rejected without one.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct RenderRequest {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<String>,
    pub quality: Option<f32>,
    pub world: Option<WorldRequest>,
    pub camera: Option<CameraRequest>,
    pub line_width: Option<f32>,
    pub surfaces: Option<bool>,
    pub lines: Option<bool>,
    pub visible_primitives: Option<Vec<PrimitiveRefRequest>>,
    pub sections: Option<SectionsRequest>,
    pub background: Option<[f32; 4]>,
    pub line_color: Option<[f32; 4]>,
    pub label: Option<String>,
    pub axes: Option<bool>,
    pub scale_bar: Option<bool>,
    pub lighting: Option<LightingRequest>,
    #[serde(default, deserialize_with = "present_ao")]
    pub ao: Option<AoRequest>,
    pub tone_mapping: Option<String>,
}

/// Wire shape for one identified camera in a batch: camera identity plus
/// optional per-view output overrides defaulting to the shared values.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderImageViewRequest {
    pub id: String,
    pub visible_primitives: Option<Vec<PrimitiveRefRequest>>,
    pub label: Option<String>,
    pub camera: Option<CameraRequest>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<String>,
    pub quality: Option<f32>,
}

/// Wire shape for ordered multi-image rendering.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct RenderImagesRequest {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<String>,
    pub quality: Option<f32>,
    pub world: Option<WorldRequest>,
    pub line_width: Option<f32>,
    pub surfaces: Option<bool>,
    pub lines: Option<bool>,
    pub visible_primitives: Option<Vec<PrimitiveRefRequest>>,
    pub sections: Option<SectionsRequest>,
    pub background: Option<[f32; 4]>,
    pub line_color: Option<[f32; 4]>,
    pub axes: Option<bool>,
    pub scale_bar: Option<bool>,
    pub lighting: Option<LightingRequest>,
    #[serde(default, deserialize_with = "present_ao")]
    pub ao: Option<AoRequest>,
    pub tone_mapping: Option<String>,
    pub timings: Option<bool>,
    pub views: Vec<RenderImageViewRequest>,
}

/// Resolved camera view. IDs are carried so failures can name the view; the
/// output overrides are `None` when the shared values apply.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderView {
    pub id: String,
    /// Per-view source primitive instances; `None` inherits the shared selection.
    pub visible_primitives: Option<Vec<PrimitiveRef>>,
    pub label: Option<String>,
    pub camera: RenderCamera,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<ImageFormat>,
}

/// Wire shape for `createRenderer` options.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct CreateRendererRequest {
    pub power_preference: Option<String>,
}

impl CreateRendererRequest {
    pub fn from_json(json: Option<&str>) -> Result<Self, RenderError> {
        match json {
            None => Ok(Self::default()),
            Some(json) => serde_json::from_str(json)
                .map_err(|error| RenderError::Parse(format!("options: {error}"))),
        }
    }

    pub fn resolve(&self) -> Result<wgpu::PowerPreference, RenderError> {
        match self.power_preference.as_deref() {
            None | Some("high-performance") => Ok(wgpu::PowerPreference::HighPerformance),
            Some("low-power") => Ok(wgpu::PowerPreference::LowPower),
            Some(other) => Err(RenderError::Parse(format!(
                "powerPreference {other:?} not high-performance/low-power"
            ))),
        }
    }
}

struct CommonRequest<'a> {
    width: Option<u32>,
    height: Option<u32>,
    camera: Option<&'a CameraRequest>,
    world: Option<&'a WorldRequest>,
    line_width: Option<f32>,
    surfaces: Option<bool>,
    lines: Option<bool>,
    visible_primitives: Option<&'a [PrimitiveRefRequest]>,
    sections: Option<&'a SectionsRequest>,
    background: Option<[f32; 4]>,
    line_color: Option<[f32; 4]>,
    axes: Option<bool>,
    /// Whether the shared width/height must clear the annotated minimum. Only
    /// a singular request renders at them; a batch renders at each view's
    /// effective size, which the per-view rule checks instead.
    annotated: bool,
    scale_bar: Option<bool>,
    lighting: Option<&'a LightingRequest>,
    ao: Option<&'a AoRequest>,
    tone_mapping: Option<&'a str>,
}

impl RenderRequest {
    pub fn from_json(json: &str) -> Result<Self, RenderError> {
        parse_render_options(json)
    }

    pub fn resolve(&self) -> Result<(RenderOptions, ImageFormat), RenderError> {
        let options = self.resolve_options()?;
        let (_, format) = resolve_required_format(self.format.as_deref(), self.quality)?;
        Ok((options, format))
    }

    /// The camera and annotation settings alone, with no encoder chosen yet.
    pub fn resolve_options(&self) -> Result<RenderOptions, RenderError> {
        let (mut options, _) = resolve_common(self.common())?;
        validate_optional_label(self.label.as_deref(), "label")?;
        options.label.clone_from(&self.label);
        Ok(options)
    }

    fn common(&self) -> CommonRequest<'_> {
        CommonRequest {
            width: self.width,
            height: self.height,
            camera: self.camera.as_ref(),
            world: self.world.as_ref(),
            line_width: self.line_width,
            surfaces: self.surfaces,
            lines: self.lines,
            visible_primitives: self.visible_primitives.as_deref(),
            sections: self.sections.as_ref(),
            background: self.background,
            line_color: self.line_color,
            axes: self.axes,
            annotated: self.axes.unwrap_or(false)
                || self.scale_bar.unwrap_or(false)
                || self.label.is_some(),
            scale_bar: self.scale_bar,
            lighting: self.lighting.as_ref(),
            ao: self.ao.as_ref(),
            tone_mapping: self.tone_mapping.as_deref(),
        }
    }
}

impl RenderImagesRequest {
    pub fn from_json(json: &str) -> Result<Self, RenderError> {
        parse_render_options(json)
    }

    pub fn resolve(
        &self,
    ) -> Result<(RenderOptions, ImageFormat, Vec<RenderView>, bool), RenderError> {
        let (options, world) = resolve_common(self.common())?;
        let (shared_format_name, format) =
            resolve_required_format(self.format.as_deref(), self.quality)?;
        if self.views.is_empty() {
            return Err(RenderError::Parse(
                "views must contain at least one view".into(),
            ));
        }
        let shared_annotated = options.axes || options.scale_bar;
        let mut ids = HashSet::with_capacity(self.views.len());
        let mut views = Vec::with_capacity(self.views.len());
        for (index, view) in self.views.iter().enumerate() {
            if !valid_view_id(&view.id) {
                return Err(RenderError::Parse(format!(
                    "views[{index}].id must match [A-Za-z0-9][A-Za-z0-9_-]{{0,63}}"
                )));
            }
            if !ids.insert(view.id.as_str()) {
                return Err(RenderError::Parse(format!(
                    "views contains duplicate id {:?}",
                    view.id
                )));
            }
            let camera = resolve_camera(view.camera.as_ref(), world)
                .map_err(|error| RenderError::Parse(format!("views[{index}].camera: {error}")))?;
            for (name, value) in [("width", view.width), ("height", view.height)] {
                if let Some(value) = value
                    && !(MIN_DIMENSION..=MAX_DIMENSION).contains(&value)
                {
                    return Err(RenderError::Parse(format!(
                        "views[{index}].{name} {value} outside {MIN_DIMENSION}..={MAX_DIMENSION}"
                    )));
                }
            }
            if (shared_annotated || view.label.is_some())
                && (view.width.unwrap_or(options.width) < ANNOTATED_MIN_DIMENSION
                    || view.height.unwrap_or(options.height) < ANNOTATED_MIN_DIMENSION)
            {
                return Err(RenderError::Parse(format!(
                    "views[{index}]: annotated images must be at least {ANNOTATED_MIN_DIMENSION}x{ANNOTATED_MIN_DIMENSION}"
                )));
            }
            if let Some(quality) = view.quality
                && (!quality.is_finite() || !(0.0..=1.0).contains(&quality))
            {
                return Err(RenderError::Parse(format!(
                    "views[{index}].quality {quality} outside 0..=1"
                )));
            }
            // A per-view format or quality resolves against the same defaults
            // and lossless-only-at-exactly-1 rule as the shared pair.
            let view_format = if view.format.is_some() || view.quality.is_some() {
                let name = view.format.as_deref().unwrap_or(shared_format_name);
                Some(
                    resolve_format(name, view.quality.or(self.quality))
                        .map_err(|error| RenderError::Parse(format!("views[{index}]: {error}")))?,
                )
            } else {
                None
            };
            validate_optional_label(view.label.as_deref(), &format!("views[{index}].label"))?;
            views.push(RenderView {
                id: view.id.clone(),
                visible_primitives: view.visible_primitives.as_ref().map(|refs| {
                    refs.iter()
                        .map(|r| PrimitiveRef {
                            node_index: r.node_index,
                            mesh_index: r.mesh_index,
                            primitive_index: r.primitive_index,
                        })
                        .collect()
                }),
                label: view.label.clone(),
                camera,
                width: view.width,
                height: view.height,
                format: view_format,
            });
        }
        Ok((options, format, views, self.timings.unwrap_or(false)))
    }

    fn common(&self) -> CommonRequest<'_> {
        CommonRequest {
            width: self.width,
            height: self.height,
            camera: None,
            world: self.world.as_ref(),
            line_width: self.line_width,
            surfaces: self.surfaces,
            lines: self.lines,
            visible_primitives: self.visible_primitives.as_deref(),
            sections: self.sections.as_ref(),
            background: self.background,
            line_color: self.line_color,
            axes: self.axes,
            annotated: false,
            scale_bar: self.scale_bar,
            lighting: self.lighting.as_ref(),
            ao: self.ao.as_ref(),
            tone_mapping: self.tone_mapping.as_deref(),
        }
    }
}

fn parse_render_options<T: DeserializeOwned>(json: &str) -> Result<T, RenderError> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|error| RenderError::Parse(format!("options: {error}")))?;
    reject_legacy_camera_keys(&value)?;
    serde_json::from_value(value).map_err(|error| RenderError::Parse(format!("options: {error}")))
}

fn reject_legacy_camera_keys(value: &serde_json::Value) -> Result<(), RenderError> {
    const REMOVED: [&str; 5] = ["phi", "theta", "up", "projection", "margin"];
    let reject = |object: &serde_json::Map<String, serde_json::Value>, path: &str| {
        for key in REMOVED {
            if object.contains_key(key) {
                return Err(RenderError::Parse(format!(
                    "{path}.{key} was removed; use {path}.camera with framing, Cartesian vectors, and a nested projection"
                )));
            }
        }
        Ok(())
    };
    let Some(root) = value.as_object() else {
        return Err(RenderError::Parse("options must be an object".into()));
    };
    reject(root, "options")?;
    if let Some(views) = root.get("views").and_then(serde_json::Value::as_array) {
        for (index, view) in views.iter().enumerate() {
            let Some(view) = view.as_object() else {
                continue;
            };
            reject(view, &format!("views[{index}]"))?;
        }
    }
    Ok(())
}

fn resolve_common(
    request: CommonRequest<'_>,
) -> Result<(RenderOptions, WorldTransform), RenderError> {
    let defaults = RenderOptions::default();
    let world = resolve_world(request.world)?;
    let width = request.width.unwrap_or(defaults.width);
    let height = request.height.unwrap_or(defaults.height);
    if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&width)
        || !(MIN_DIMENSION..=MAX_DIMENSION).contains(&height)
    {
        return Err(RenderError::Parse(format!(
            "dimensions {width}x{height} outside {MIN_DIMENSION}..={MAX_DIMENSION}"
        )));
    }
    let axes = request.axes.unwrap_or(false);
    let scale_bar = request.scale_bar.unwrap_or(false);
    if request.annotated && (width < ANNOTATED_MIN_DIMENSION || height < ANNOTATED_MIN_DIMENSION) {
        return Err(RenderError::Parse(format!(
            "annotated images must be at least {ANNOTATED_MIN_DIMENSION}x{ANNOTATED_MIN_DIMENSION}"
        )));
    }

    let camera = resolve_camera(request.camera, world).map_err(RenderError::Parse)?;
    let line_width = request.line_width.unwrap_or(defaults.line_width);
    if !line_width.is_finite() || !LINE_WIDTH_RANGE.contains(&line_width) {
        return Err(RenderError::Parse(format!(
            "lineWidth {line_width} outside {}..={}",
            LINE_WIDTH_RANGE.start(),
            LINE_WIDTH_RANGE.end()
        )));
    }
    for (name, color) in [
        ("background", request.background),
        ("lineColor", request.line_color),
    ] {
        if let Some(color) = color
            && color
                .iter()
                .any(|channel| !channel.is_finite() || !(0.0..=1.0).contains(channel))
        {
            return Err(RenderError::Parse(format!("{name} channels outside 0..=1")));
        }
    }

    let lighting = resolve_lighting(request.lighting, world)?;
    let ao = request
        .ao
        .map(|ao| {
            let fallback = AmbientOcclusion::default();
            let samples = match ao.samples {
                None => fallback.samples,
                Some(samples) if samples.is_finite() && samples.fract() == 0.0 => {
                    if !(*AO_SAMPLES_RANGE.start() as f32..=*AO_SAMPLES_RANGE.end() as f32)
                        .contains(&samples)
                    {
                        return Err(RenderError::Parse(format!(
                            "ao.samples outside {AO_SAMPLES_RANGE:?}"
                        )));
                    }
                    samples as u32
                }
                Some(_) => {
                    return Err(RenderError::Parse("ao.samples must be an integer".into()));
                }
            };
            let resolved = AmbientOcclusion {
                radius_pixels: ao.radius_pixels,
                intensity: ao.intensity.unwrap_or(fallback.intensity),
                distance_falloff: ao.distance_falloff.unwrap_or(fallback.distance_falloff),
                thickness_ratio: ao.thickness_ratio.unwrap_or(fallback.thickness_ratio),
                denoise_depth_tolerance: ao
                    .denoise_depth_tolerance
                    .unwrap_or(fallback.denoise_depth_tolerance),
                samples,
                resolution_scale: ao.resolution_scale.unwrap_or(fallback.resolution_scale),
            };
            validate_ao(&resolved)?;
            Ok(resolved)
        })
        .transpose()?
        .or(defaults.ao);
    let tone_mapping = match request.tone_mapping {
        None | Some("neutral") => ToneMapping::Neutral,
        Some("aces") => ToneMapping::Aces,
        Some("linear") => ToneMapping::Linear,
        Some("none") => ToneMapping::None,
        Some(other) => {
            return Err(RenderError::Parse(format!(
                "toneMapping {other:?} not neutral/aces/linear/none"
            )));
        }
    };
    let visible_primitives = request
        .visible_primitives
        .map(|primitives| {
            let mut seen = HashSet::with_capacity(primitives.len());
            primitives
                .iter()
                .enumerate()
                .map(|(index, primitive)| {
                    if !seen.insert(*primitive) {
                        return Err(RenderError::Parse(format!(
                            "visiblePrimitives[{index}] duplicates an earlier primitive reference"
                        )));
                    }
                    Ok(PrimitiveRef {
                        node_index: primitive.node_index,
                        mesh_index: primitive.mesh_index,
                        primitive_index: primitive.primitive_index,
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let sections = request
        .sections
        .map(|sections| {
            if sections.planes.is_empty() || sections.planes.len() > MAX_SECTION_PLANES {
                return Err(RenderError::Parse(format!(
                    "sections.planes must contain between 1 and {MAX_SECTION_PLANES} planes"
                )));
            }
            let planes = sections
                .planes
                .iter()
                .enumerate()
                .map(|(index, plane)| {
                    let point = world.point(
                        finite_vector(
                            plane.point,
                            &format!("sections.planes[{index}].point"),
                            true,
                        )
                        .map_err(RenderError::Parse)?,
                    );
                    let normal = world.direction(
                        normalized_direction(
                            plane.normal,
                            &format!("sections.planes[{index}].normal"),
                        )
                        .map_err(RenderError::Parse)?,
                    );
                    Ok(SectionPlane {
                        point: point.to_array(),
                        normal: normal.to_array(),
                    })
                })
                .collect::<Result<Vec<_>, RenderError>>()?;
            Ok(Sections {
                planes,
                clip_surfaces: sections.clip_surfaces.unwrap_or(true),
                clip_lines: sections.clip_lines.unwrap_or(true),
            })
        })
        .transpose()?;

    Ok((
        RenderOptions {
            width,
            height,
            camera,
            line_width,
            surfaces: request.surfaces.unwrap_or(true),
            lines: request.lines.unwrap_or(true),
            visible_primitives,
            sections,
            background: request.background,
            line_color: request.line_color,
            axes,
            scale_bar,
            lighting,
            ao,
            tone_mapping,
            world_axes: world.axes,
            ..defaults
        },
        world,
    ))
}

fn signed_axis(value: &str, name: &str) -> Result<(usize, glam::Vec3), RenderError> {
    let (index, vector) = match value {
        "+x" => (0, glam::Vec3::X),
        "-x" => (0, glam::Vec3::NEG_X),
        "+y" => (1, glam::Vec3::Y),
        "-y" => (1, glam::Vec3::NEG_Y),
        "+z" => (2, glam::Vec3::Z),
        "-z" => (2, glam::Vec3::NEG_Z),
        other => {
            return Err(RenderError::Parse(format!(
                "{name} {other:?} not +x/-x/+y/-y/+z/-z"
            )));
        }
    };
    Ok((index, vector))
}

/// Flatten one declared axis field: absent stays absent, an explicit `null` is
/// an error rather than a silent fall back to the default.
fn declared_axis<'a>(
    field: Option<&'a Option<String>>,
    name: &str,
) -> Result<Option<&'a str>, RenderError> {
    match field {
        None => Ok(None),
        Some(None) => Err(RenderError::Parse(format!("{name} must not be null"))),
        Some(Some(value)) => Ok(Some(value.as_str())),
    }
}

fn resolve_world(request: Option<&WorldRequest>) -> Result<WorldTransform, RenderError> {
    let up_declared = declared_axis(request.and_then(|world| world.up.as_ref()), "world.up")?;
    let forward_declared = declared_axis(
        request.and_then(|world| world.forward.as_ref()),
        "world.forward",
    )?;
    if up_declared.is_some() != forward_declared.is_some() {
        return Err(RenderError::Parse(
            "world.up and world.forward must be provided together".into(),
        ));
    }
    let up_name = up_declared.unwrap_or("+y");
    let forward_name = forward_declared.unwrap_or("+z");
    let (up_index, up) = signed_axis(up_name, "world.up")?;
    let (forward_index, forward) = signed_axis(forward_name, "world.forward")?;
    if up_index == forward_index {
        return Err(RenderError::Parse(
            "world.up and world.forward must name different axes".into(),
        ));
    }
    let caller_basis = glam::Mat3::from_cols(up.cross(forward), up, forward);
    let rotation = caller_basis.transpose();
    let meters_per_unit = match request.and_then(|world| world.unit.as_deref()) {
        None | Some("meter") => 1.0,
        Some("millimeter") => 0.001,
        Some(other) => {
            return Err(RenderError::Parse(format!(
                "world.unit {other:?} not meter/millimeter"
            )));
        }
    };
    Ok(WorldTransform {
        rotation,
        meters_per_unit,
        axes: [
            (rotation * glam::Vec3::X).to_array(),
            (rotation * glam::Vec3::Y).to_array(),
            (rotation * glam::Vec3::Z).to_array(),
        ],
        caller_up: up,
        caller_forward: forward,
    })
}

fn finite_vector(value: [f32; 3], name: &str, allow_zero: bool) -> Result<glam::Vec3, String> {
    let vector = glam::Vec3::from(value);
    if !vector.is_finite() {
        return Err(format!("{name} must contain three finite numbers"));
    }
    if !allow_zero && vector.length() < MIN_DIRECTION_LENGTH {
        return Err(format!("{name} must not be zero length"));
    }
    Ok(vector)
}

fn normalized_direction(value: [f32; 3], name: &str) -> Result<glam::Vec3, String> {
    finite_vector(value, name, false).map(glam::Vec3::normalize)
}

fn collinear(left: glam::Vec3, right: glam::Vec3) -> bool {
    left.cross(right).length() < MIN_DIRECTION_LENGTH
}

/// Screen-up for a view, substituting a declared-world axis where the
/// requested `up` is collinear with `direction` and so names no roll.
///
/// The substitute is `world.forward`, falling back to `world.up` for the one
/// family of views `world.forward` cannot serve: those running along
/// `world.forward` itself. Those two exhaust the degeneracy, because the two
/// axes are orthogonal — a direction collinear with one is perpendicular to
/// the other — so the caller's right axis is never reached and is not offered.
/// Both vectors are unit length, and the substitution reads only the declared
/// world, so one request always resolves to one basis.
fn resolved_up(direction: glam::Vec3, up: glam::Vec3, world: WorldTransform) -> glam::Vec3 {
    if !collinear(direction, up) {
        return up;
    }
    let forward = world.direction(world.caller_forward);
    if collinear(direction, forward) {
        return world.direction(world.caller_up);
    }
    forward
}

fn resolve_vertical_field_of_view(value: Option<f32>) -> Result<f32, String> {
    let value = value.unwrap_or(45.0);
    if !value.is_finite() || !FIELD_OF_VIEW_RANGE.contains(&value) {
        return Err(format!(
            "verticalFieldOfView {value} outside {}..={}",
            FIELD_OF_VIEW_RANGE.start(),
            FIELD_OF_VIEW_RANGE.end()
        ));
    }
    Ok(value)
}

fn zoom(value: Option<f32>) -> Result<f32, String> {
    let value = value.unwrap_or(1.0);
    if !value.is_finite() || !ZOOM_RANGE.contains(&value) {
        return Err(format!(
            "zoom {value} outside {}..={}",
            ZOOM_RANGE.start(),
            ZOOM_RANGE.end()
        ));
    }
    Ok(value)
}

fn resolve_fit_projection(
    request: Option<&FitProjectionRequest>,
) -> Result<CameraProjection, String> {
    match request {
        None => Ok(CameraProjection::Perspective {
            vertical_field_of_view_deg: 45.0,
            zoom: 1.0,
        }),
        Some(FitProjectionRequest::Perspective {
            vertical_field_of_view,
        }) => Ok(CameraProjection::Perspective {
            vertical_field_of_view_deg: resolve_vertical_field_of_view(*vertical_field_of_view)?,
            zoom: 1.0,
        }),
        Some(FitProjectionRequest::Orthographic) => Ok(CameraProjection::Orthographic {
            vertical_span: None,
            zoom: 1.0,
        }),
    }
}

fn resolve_fixed_projection(
    request: Option<&FixedProjectionRequest>,
    world: WorldTransform,
) -> Result<CameraProjection, String> {
    match request {
        None => Ok(CameraProjection::Perspective {
            vertical_field_of_view_deg: 45.0,
            zoom: 1.0,
        }),
        Some(FixedProjectionRequest::Perspective {
            vertical_field_of_view,
            zoom: requested_zoom,
        }) => Ok(CameraProjection::Perspective {
            vertical_field_of_view_deg: resolve_vertical_field_of_view(*vertical_field_of_view)?,
            zoom: zoom(*requested_zoom)?,
        }),
        Some(FixedProjectionRequest::Orthographic {
            vertical_span,
            zoom: requested_zoom,
        }) => {
            if !vertical_span.is_finite() || *vertical_span <= 0.0 {
                return Err(format!(
                    "verticalSpan {vertical_span} must be greater than 0"
                ));
            }
            Ok(CameraProjection::Orthographic {
                vertical_span: Some(world.length(*vertical_span)),
                zoom: zoom(*requested_zoom)?,
            })
        }
    }
}

fn resolve_camera(
    request: Option<&CameraRequest>,
    world: WorldTransform,
) -> Result<RenderCamera, String> {
    let Some(request) = request else {
        return resolve_camera(
            Some(&CameraRequest::Fit {
                direction: None,
                up: None,
                margin: None,
                projection: None,
            }),
            world,
        );
    };
    match request {
        CameraRequest::Fit {
            direction,
            up,
            margin,
            projection,
        } => {
            let direction = match direction {
                Some(direction) => world.direction(normalized_direction(*direction, "direction")?),
                None => world.default_fit_direction(),
            };
            let up = resolved_up(
                direction,
                world.direction(match up {
                    Some(up) => normalized_direction(*up, "up")?,
                    None => world.caller_up,
                }),
                world,
            );
            let margin = margin.unwrap_or(0.1);
            if !margin.is_finite() || !(0.0..=0.5).contains(&margin) {
                return Err(format!("margin {margin} outside 0..=0.5"));
            }
            Ok(RenderCamera::Fit {
                direction: direction.to_array(),
                up: up.to_array(),
                padding_factor: 1.0 - margin,
                projection: resolve_fit_projection(projection.as_ref())?,
            })
        }
        CameraRequest::Fixed {
            position,
            target,
            up,
            projection,
            clipping,
        } => {
            let position = world.point(finite_vector(*position, "position", true)?);
            let target = world.point(finite_vector(*target, "target", true)?);
            let direction = position - target;
            if direction.length() < MIN_DIRECTION_LENGTH {
                return Err("position and target must not coincide".into());
            }
            let up = resolved_up(
                direction.normalize(),
                world.direction(normalized_direction(*up, "up")?),
                world,
            );
            let clipping = clipping
                .as_ref()
                .map(|clipping| {
                    if !clipping.near.is_finite()
                        || !clipping.far.is_finite()
                        || clipping.near <= 0.0
                        || clipping.far <= clipping.near
                    {
                        return Err("clipping requires finite 0 < near < far".to_owned());
                    }
                    Ok(ClipPlanes {
                        near: world.length(clipping.near),
                        far: world.length(clipping.far),
                    })
                })
                .transpose()?;
            Ok(RenderCamera::Fixed {
                position: position.to_array(),
                target: target.to_array(),
                up: up.to_array(),
                projection: resolve_fixed_projection(projection.as_ref(), world)?,
                clipping,
            })
        }
    }
}

/// Resolve the request's own format name and encoder settings. `format` is
/// required on the wire — the TS façade makes it mandatory so a better default
/// can be adopted later without an API break, which leaves no honest default
/// to fall back to here. The name is handed back so a batch can resolve its
/// per-view overrides against it.
fn resolve_required_format(
    name: Option<&str>,
    quality: Option<f32>,
) -> Result<(&str, ImageFormat), RenderError> {
    let name = name.ok_or_else(|| RenderError::Parse("format is required".into()))?;
    let format = resolve_format(name, quality).map_err(RenderError::Parse)?;
    Ok((name, format))
}

/// Resolve a format name plus 0..=1 quality into the output format, applying
/// the per-format quality default and the lossless-only-at-exactly-1 WebP
/// rule. WebP defaults to 1 (lossless, matching earlier lossless-only
/// releases); JPEG keeps 0.92. PNG and raw ignore quality entirely.
fn resolve_format(name: &str, quality: Option<f32>) -> Result<ImageFormat, String> {
    let default_quality = if name == "webp" { 1.0 } else { 0.92 };
    let quality = quality.unwrap_or(default_quality);
    if !quality.is_finite() || !(0.0..=1.0).contains(&quality) {
        return Err(format!("quality {quality} outside 0..=1"));
    }
    // Only an exact quality of 1 selects lossless WebP: rounding alone would
    // send 0.995..1.0 to 100, silently breaking the "below 1 is lossy"
    // contract.
    let encoder_quality = match (quality * 100.0).round() as u8 {
        100 if quality < 1.0 => 99,
        rounded => rounded,
    };
    ImageFormat::from_name(name, encoder_quality)
        .map_err(|_| format!("format {name:?} not png/webp/jpeg/jpg/raw"))
}

/// `'studio'`, omitted, and the studio values spelled out all resolve to the
/// same rig. Every omitted field inherits the preset, except that an explicit
/// `lights` array without a `headlamp` replaces the studio's headlamp too.
fn resolve_lighting(
    request: Option<&LightingRequest>,
    world: WorldTransform,
) -> Result<ResolvedLighting, RenderError> {
    let studio = ResolvedLighting::studio();
    let rig = match request {
        None => return Ok(studio),
        Some(LightingRequest::Preset(name)) if name == "studio" => return Ok(studio),
        Some(LightingRequest::Preset(other)) => {
            return Err(RenderError::Parse(format!("lighting {other:?} not studio")));
        }
        Some(LightingRequest::Rig(rig)) => rig,
    };

    let headlamp = match (&rig.headlamp, &rig.lights) {
        (Some(request), _) => resolve_headlamp(request)?,
        (None, Some(_)) => None,
        (None, None) => studio.headlamp,
    };
    let requested = rig.lights.as_deref().unwrap_or_default();
    let capacity = MAX_LIGHTS - usize::from(headlamp.is_some());
    if requested.len() > capacity {
        let beside = if headlamp.is_some() {
            " beside the headlamp"
        } else {
            ""
        };
        return Err(RenderError::Parse(format!(
            "lighting.lights: at most {capacity} lights{beside}, received {}",
            requested.len()
        )));
    }
    let mut lights = Vec::with_capacity(requested.len());
    for (index, light) in requested.iter().enumerate() {
        if light.direction.iter().any(|axis| !axis.is_finite()) {
            return Err(RenderError::Parse(format!(
                "lighting.lights[{index}].direction must be finite"
            )));
        }
        let length_squared: f32 = light.direction.iter().map(|axis| axis * axis).sum();
        if length_squared.sqrt() < MIN_DIRECTION_LENGTH {
            return Err(RenderError::Parse(format!(
                "lighting.lights[{index}].direction must be non-zero"
            )));
        }
        if light
            .color
            .iter()
            .any(|channel| !channel.is_finite() || !(0.0..=MAX_LIGHT_COLOR).contains(channel))
        {
            return Err(RenderError::Parse(format!(
                "lighting.lights[{index}].color channels outside 0..={MAX_LIGHT_COLOR}"
            )));
        }
        lights.push(ResolvedLight {
            direction: if matches!(rig.space.as_deref(), Some("world")) {
                world
                    .direction(glam::Vec3::from(light.direction))
                    .to_array()
            } else {
                light.direction
            },
            color: light.color,
        });
    }

    let ambient = rig.ambient.unwrap_or(studio.ambient);
    if !ambient.is_finite() || !(0.0..=MAX_AMBIENT).contains(&ambient) {
        return Err(RenderError::Parse(format!(
            "lighting.ambient {ambient} outside 0..={MAX_AMBIENT}"
        )));
    }
    let exposure = rig.exposure.unwrap_or(studio.exposure);
    if !exposure.is_finite() || !EXPOSURE_RANGE.contains(&exposure) {
        return Err(RenderError::Parse(format!(
            "lighting.exposure {exposure} outside {}..={}",
            EXPOSURE_RANGE.start(),
            EXPOSURE_RANGE.end()
        )));
    }
    let (environment, environment_source, environment_intensity) = match rig.environment.as_ref() {
        None => (true, EnvironmentSource::Room, studio.environment_intensity),
        Some(EnvironmentRequest::Named(name)) if name == "studio" => {
            (true, EnvironmentSource::Room, studio.environment_intensity)
        }
        Some(EnvironmentRequest::Named(name)) if name == "none" => {
            (false, EnvironmentSource::Room, studio.environment_intensity)
        }
        Some(EnvironmentRequest::Named(other)) => {
            return Err(RenderError::Parse(format!(
                "lighting.environment {other:?} not studio/none"
            )));
        }
        Some(EnvironmentRequest::Object(object)) => {
            let intensity = object.intensity.unwrap_or(studio.environment_intensity);
            if !intensity.is_finite() || !(0.0..=MAX_ENVIRONMENT_INTENSITY).contains(&intensity) {
                return Err(RenderError::Parse(format!(
                    "lighting.environment.intensity {intensity} outside 0..={MAX_ENVIRONMENT_INTENSITY}"
                )));
            }
            let source = match object.cards.as_deref() {
                None => EnvironmentSource::Room,
                Some(cards) => EnvironmentSource::Cards(resolve_cards(cards)?),
            };
            (true, source, intensity)
        }
    };
    let space = match rig.space.as_deref() {
        None | Some("view") => LightingSpace::View,
        Some("world") => LightingSpace::World,
        Some(other) => {
            return Err(RenderError::Parse(format!(
                "lighting.space {other:?} not view/world"
            )));
        }
    };

    Ok(ResolvedLighting {
        lights,
        headlamp,
        ambient,
        environment,
        environment_source,
        environment_intensity,
        space,
        exposure,
    })
}

/// A zero intensity switches the headlamp off and frees its light slot.
fn resolve_headlamp(request: &HeadlampRequest) -> Result<Option<Headlamp>, RenderError> {
    let viewer = Headlamp::VIEWER;
    let intensity = request.intensity.unwrap_or(viewer.intensity);
    if !intensity.is_finite() || !(0.0..=MAX_LIGHT_COLOR).contains(&intensity) {
        return Err(RenderError::Parse(format!(
            "lighting.headlamp.intensity {intensity} outside 0..={MAX_LIGHT_COLOR}"
        )));
    }
    let mut offsets = [viewer.right_offset, viewer.up_offset];
    for ((offset, requested), name) in offsets
        .iter_mut()
        .zip([request.right_offset, request.up_offset])
        .zip(["rightOffset", "upOffset"])
    {
        *offset = requested.unwrap_or(*offset);
        if !offset.is_finite() || offset.abs() > MAX_RIG_EXTENT {
            return Err(RenderError::Parse(format!(
                "lighting.headlamp.{name} {offset} outside -{MAX_RIG_EXTENT}..={MAX_RIG_EXTENT}"
            )));
        }
    }
    Ok((intensity > 0.0).then_some(Headlamp {
        intensity,
        right_offset: offsets[0],
        up_offset: offsets[1],
    }))
}

fn resolve_cards(requested: &[LightCardRequest]) -> Result<Vec<LightCard>, RenderError> {
    if requested.len() > MAX_LIGHT_CARDS {
        return Err(RenderError::Parse(format!(
            "lighting.environment.cards: at most {MAX_LIGHT_CARDS} cards, received {}",
            requested.len()
        )));
    }
    requested
        .iter()
        .enumerate()
        .map(|(index, card)| {
            let name = format!("lighting.environment.cards[{index}]");
            if card
                .position
                .iter()
                .any(|axis| !axis.is_finite() || axis.abs() > MAX_RIG_EXTENT)
            {
                return Err(RenderError::Parse(format!(
                    "{name}.position axes outside -{MAX_RIG_EXTENT}..={MAX_RIG_EXTENT}"
                )));
            }
            if glam::Vec3::from(card.position).length() < MIN_DIRECTION_LENGTH {
                return Err(RenderError::Parse(format!(
                    "{name}.position must be away from the centre"
                )));
            }
            if card
                .size
                .iter()
                .any(|side| !side.is_finite() || *side <= 0.0 || *side > MAX_RIG_EXTENT)
            {
                return Err(RenderError::Parse(format!(
                    "{name}.size sides outside (0, {MAX_RIG_EXTENT}]"
                )));
            }
            if !card.intensity.is_finite() || !(0.0..=MAX_CARD_INTENSITY).contains(&card.intensity)
            {
                return Err(RenderError::Parse(format!(
                    "{name}.intensity {} outside 0..={MAX_CARD_INTENSITY}",
                    card.intensity
                )));
            }
            if card
                .rotation
                .is_some_and(|rotation| rotation.iter().any(|angle| !angle.is_finite()))
            {
                return Err(RenderError::Parse(format!(
                    "{name}.rotation must be finite"
                )));
            }
            Ok(LightCard {
                position: card.position,
                size: card.size,
                intensity: card.intensity,
                rotation: card.rotation,
            })
        })
        .collect()
}

fn validate_optional_label(label: Option<&str>, name: &str) -> Result<(), RenderError> {
    let Some(label) = label else {
        return Ok(());
    };
    if label.trim().is_empty() {
        return Err(RenderError::Parse(format!(
            "{name} must be a non-empty string"
        )));
    }
    if label.chars().count() > 64 {
        return Err(RenderError::Parse(format!(
            "{name} must contain at most 64 characters"
        )));
    }
    if let Some(character) = label.chars().find(|character| {
        let code = u32::from(*character);
        !((0x20..=0x7e).contains(&code) || matches!(code, 0xb5 | 0x2014 | 0x2212))
    }) {
        return Err(RenderError::Parse(format!(
            "{name} contains unsupported character {character:?}"
        )));
    }
    Ok(())
}

fn valid_view_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_vec3_near(actual: glam::Vec3, expected: glam::Vec3) {
        assert!(
            actual.abs_diff_eq(expected, 1e-6),
            "expected {expected:?}, got {actual:?}"
        );
    }

    /// `(up, direction)` for a fit camera, `None` for a fixed one.
    fn fit_orientation(camera: RenderCamera) -> Option<([f32; 3], [f32; 3])> {
        match camera {
            RenderCamera::Fit { up, direction, .. } => Some((up, direction)),
            RenderCamera::Fixed { .. } => None,
        }
    }

    #[test]
    fn eight_k_extent_is_admitted_and_larger_extents_are_rejected() {
        let (single, _) =
            RenderRequest::from_json(r#"{"format":"png","width":8192,"height":8192}"#)
                .unwrap()
                .resolve()
                .unwrap();
        assert_eq!((single.width, single.height), (8192, 8192));
        let (_, _, views, _) = RenderImagesRequest::from_json(
            r#"{"format":"png","views":[{"id":"max","width":8192,"height":8192}]}"#,
        )
        .unwrap()
        .resolve()
        .unwrap();
        assert_eq!((views[0].width, views[0].height), (Some(8192), Some(8192)));
        assert!(
            RenderRequest::from_json(r#"{"format":"png","width":8193}"#)
                .unwrap()
                .resolve()
                .is_err()
        );
        assert!(
            RenderImagesRequest::from_json(
                r#"{"format":"png","views":[{"id":"over","height":8193}]}"#
            )
            .unwrap()
            .resolve()
            .is_err()
        );
    }

    #[test]
    fn singular_defaults_annotations_off() {
        let (options, format) = RenderRequest::from_json(r#"{"format":"png"}"#)
            .expect("parse")
            .resolve()
            .expect("resolve");
        assert_eq!((options.width, options.height), (768, 432));
        assert_eq!(options.camera, RenderCamera::default());
        assert!(!options.axes);
        assert!(options.label.is_none());
        assert!(!options.scale_bar);
        assert_eq!(format, ImageFormat::Png);
    }

    #[test]
    fn omitted_ao_is_enabled_and_zero_intensity_disables_it() {
        let (single, _) = RenderRequest::from_json(r#"{"format":"raw"}"#)
            .expect("single request")
            .resolve()
            .expect("single defaults");
        let (batch, _, _, _) =
            RenderImagesRequest::from_json(r#"{"format":"raw","views":[{"id":"front"}]}"#)
                .expect("batch request")
                .resolve()
                .expect("batch defaults");
        assert!(single.ao.is_some_and(|ao| ao.intensity > 0.0));
        assert_eq!(batch.ao, single.ao);
        assert_eq!(RenderOptions::default().ao, single.ao);
        let (disabled, _) = RenderRequest::from_json(r#"{"format":"raw","ao":{"intensity":0}}"#)
            .expect("disabled request")
            .resolve()
            .expect("disabled AO");
        assert_eq!(disabled.ao.expect("runtime controls").intensity, 0.0);
    }

    #[test]
    fn ao_defaults_and_admission_match_in_single_and_batch_requests() {
        let (single, _) = RenderRequest::from_json(r#"{"format":"raw","ao":{}}"#)
            .expect("AO request")
            .resolve()
            .expect("AO defaults");
        assert_eq!(
            single.ao,
            Some(AmbientOcclusion {
                radius_pixels: None,
                intensity: 0.75,
                distance_falloff: 1.0,
                thickness_ratio: 1.0 / 0.09,
                denoise_depth_tolerance: 0.1,
                samples: 16,
                resolution_scale: 0.5,
            })
        );
        let (batch, _, _, _) = RenderImagesRequest::from_json(
            r#"{"format":"raw","ao":{"radiusPixels":12,"intensity":2,"distanceFalloff":0.25},"views":[{"id":"front"}]}"#,
        )
        .expect("batch AO request")
        .resolve()
        .expect("batch AO controls");
        assert_eq!(
            batch.ao,
            Some(AmbientOcclusion {
                radius_pixels: Some(12.0),
                intensity: 2.0,
                distance_falloff: 0.25,
                ..AmbientOcclusion::default()
            })
        );
        for invalid in [
            r#"{"format":"raw","ao":null}"#,
            r#"{"format":"raw","ao":{"intensity":null}}"#,
            r#"{"format":"raw","ao":{"radiusPixels":0}}"#,
            r#"{"format":"raw","ao":{"distanceFalloff":2}}"#,
            r#"{"format":"raw","ao":{"other":1}}"#,
        ] {
            assert!(
                RenderRequest::from_json(invalid)
                    .and_then(|request| request.resolve())
                    .is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn gtao_controls_resolve_and_each_rejection_names_its_field() {
        let (single, _) = RenderRequest::from_json(
            r#"{"format":"raw","ao":{"thicknessRatio":4,"denoiseDepthTolerance":0.5,"samples":30,"resolutionScale":1}}"#,
        )
        .expect("GTAO request")
        .resolve()
        .expect("GTAO controls");
        assert_eq!(
            single.ao,
            Some(AmbientOcclusion {
                thickness_ratio: 4.0,
                denoise_depth_tolerance: 0.5,
                samples: 30,
                resolution_scale: 1.0,
                ..AmbientOcclusion::default()
            })
        );
        let (batch, _, _, _) = RenderImagesRequest::from_json(
            r#"{"format":"raw","ao":{"samples":8},"views":[{"id":"front"}]}"#,
        )
        .expect("batch GTAO request")
        .resolve()
        .expect("batch GTAO controls");
        assert_eq!(batch.ao.expect("AO").samples, 8);
        for (field, expected) in [
            (
                r#""thicknessRatio":0"#,
                "parse: ao.thicknessRatio outside 0.1..=100.0",
            ),
            (
                r#""thicknessRatio":101"#,
                "parse: ao.thicknessRatio outside 0.1..=100.0",
            ),
            (
                r#""denoiseDepthTolerance":0"#,
                "parse: ao.denoiseDepthTolerance outside 0.01..=10.0",
            ),
            (r#""samples":0"#, "parse: ao.samples outside 1..=64"),
            (r#""samples":65"#, "parse: ao.samples outside 1..=64"),
            (r#""samples":16.5"#, "parse: ao.samples must be an integer"),
            (
                r#""resolutionScale":0.2"#,
                "parse: ao.resolutionScale outside 0.25..=1.0",
            ),
            (
                r#""resolutionScale":1.5"#,
                "parse: ao.resolutionScale outside 0.25..=1.0",
            ),
        ] {
            let error =
                RenderRequest::from_json(&format!(r#"{{"format":"raw","ao":{{{field}}}}}"#))
                    .and_then(|request| request.resolve())
                    .expect_err(field);
            assert_eq!(error.to_string(), expected);
        }
        for invalid in [
            AmbientOcclusion {
                thickness_ratio: f32::NAN,
                ..AmbientOcclusion::default()
            },
            AmbientOcclusion {
                samples: 0,
                ..AmbientOcclusion::default()
            },
            AmbientOcclusion {
                resolution_scale: 0.0,
                ..AmbientOcclusion::default()
            },
        ] {
            assert!(validate_ao(&invalid).is_err());
        }
        assert!(validate_ao(&AmbientOcclusion::default()).is_ok());
    }

    #[test]
    fn tone_mapping_resolves_every_operator_and_names_unknown_ones() {
        let (default, _) = RenderRequest::from_json(r#"{"format":"raw"}"#)
            .expect("request")
            .resolve()
            .expect("default tone mapping");
        assert_eq!(default.tone_mapping, ToneMapping::Neutral);
        for (name, expected) in [
            ("neutral", ToneMapping::Neutral),
            ("aces", ToneMapping::Aces),
            ("linear", ToneMapping::Linear),
            ("none", ToneMapping::None),
        ] {
            let (single, _) =
                RenderRequest::from_json(&format!(r#"{{"format":"raw","toneMapping":"{name}"}}"#))
                    .expect("request")
                    .resolve()
                    .expect("tone mapping");
            assert_eq!(single.tone_mapping, expected);
            let (batch, _, _, _) = RenderImagesRequest::from_json(&format!(
                r#"{{"format":"raw","toneMapping":"{name}","views":[{{"id":"front"}}]}}"#
            ))
            .expect("batch request")
            .resolve()
            .expect("batch tone mapping");
            assert_eq!(batch.tone_mapping, expected);
        }
        let error = RenderRequest::from_json(r#"{"format":"raw","toneMapping":"agx"}"#)
            .and_then(|request| request.resolve())
            .expect_err("unknown operator");
        assert_eq!(
            error.to_string(),
            r#"parse: toneMapping "agx" not neutral/aces/linear/none"#
        );
    }

    #[test]
    fn gtao_samples_split_like_gtao_node() {
        assert_eq!(crate::gtao_slices_and_steps(16), (3.0, 6.0));
        assert_eq!(crate::gtao_slices_and_steps(8), (3.0, 10.0 / 3.0));
        assert_eq!(crate::gtao_slices_and_steps(29), (3.0, 31.0 / 3.0));
        assert_eq!(crate::gtao_slices_and_steps(30), (5.0, 34.0 / 5.0));
        assert_eq!(crate::gtao_slices_and_steps(64), (5.0, 68.0 / 5.0));
        assert_eq!(crate::ao_extent(769, 577, 0.5), (385, 289));
        assert_eq!(crate::ao_extent(768, 576, 0.5), (384, 288));
        assert_eq!(crate::ao_extent(768, 576, 1.0), (768, 576));
        assert_eq!(crate::ao_extent(17, 16, 0.25), (4, 4));
    }

    #[test]
    fn world_basis_is_proper_and_tau_world_matches_the_canonical_mapping() {
        let default = resolve_world(None).expect("default world");
        assert_eq!(default.rotation, glam::Mat3::IDENTITY);
        assert_eq!(default.axes, RenderOptions::default().world_axes);

        let tau = resolve_world(Some(&WorldRequest {
            up: Some(Some("+z".into())),
            forward: Some(Some("-y".into())),
            unit: Some("millimeter".into()),
        }))
        .expect("Tau world");
        assert!((tau.rotation.determinant() - 1.0).abs() < 1e-6);
        assert!(
            (tau.rotation.transpose() * tau.rotation - glam::Mat3::IDENTITY)
                .to_cols_array()
                .iter()
                .all(|value| value.abs() < 1e-6)
        );
        assert_eq!(
            tau.axes,
            [[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]]
        );
        assert_vec3_near(
            tau.point(glam::Vec3::new(1000.0, 2000.0, 3000.0)),
            glam::Vec3::new(1.0, 3.0, -2.0),
        );
        assert_eq!(
            signed_axis("-z", "axis").expect("negative Z").1,
            glam::Vec3::NEG_Z
        );
        assert!(signed_axis("sideways", "axis").is_err());

        let axes = ["+x", "-x", "+y", "-y", "+z", "-z"];
        let mut accepted = 0;
        for up in axes {
            for forward in axes {
                if up[1..] == forward[1..] {
                    let collinear = resolve_world(Some(&WorldRequest {
                        up: Some(Some(up.into())),
                        forward: Some(Some(forward.into())),
                        unit: None,
                    }))
                    .expect_err("collinear signed-axis pair");
                    assert_eq!(
                        collinear.to_string(),
                        "parse: world.up and world.forward must name different axes"
                    );
                    continue;
                }
                let world = resolve_world(Some(&WorldRequest {
                    up: Some(Some(up.into())),
                    forward: Some(Some(forward.into())),
                    unit: None,
                }))
                .expect("every non-collinear signed-axis pair");
                assert!((world.rotation.determinant() - 1.0).abs() < 1e-6);
                accepted += 1;
            }
        }
        assert_eq!(accepted, 24);

        for request in [
            WorldRequest {
                up: Some(Some("+z".into())),
                forward: None,
                unit: None,
            },
            WorldRequest {
                up: None,
                forward: Some(Some("-y".into())),
                unit: None,
            },
            WorldRequest {
                up: None,
                forward: None,
                unit: Some("inch".into()),
            },
        ] {
            assert!(resolve_world(Some(&request)).is_err());
        }

        // An explicit JSON `null` is a caller mistake, not an omission: serde
        // collapses both to `None` unless the field is `Option<Option<_>>`, and
        // the TypeScript facade rejects `null` outright. Omitting both fields
        // still takes the documented `+y`/`+z` defaults.
        for (world, message) in [
            (r#"{"up":null}"#, "parse: world.up must not be null"),
            (
                r#"{"forward":null}"#,
                "parse: world.forward must not be null",
            ),
            (
                r#"{"up":null,"forward":null}"#,
                "parse: world.up must not be null",
            ),
            (
                r#"{"up":null,"forward":"+z"}"#,
                "parse: world.up must not be null",
            ),
        ] {
            let error = RenderRequest::from_json(&format!(r#"{{"format":"png","world":{world}}}"#))
                .expect("parse")
                .resolve()
                .expect_err("explicit null world axis");
            assert_eq!(error.to_string(), message, "for world {world}");
        }
        let omitted = RenderRequest::from_json(r#"{"format":"png","world":{"unit":"millimeter"}}"#)
            .expect("parse")
            .resolve()
            .expect("omitted axes keep the defaults");
        assert_eq!(omitted.0.world_axes, RenderOptions::default().world_axes);
    }

    #[test]
    fn default_fit_camera_uses_the_declared_world_up() {
        // D4: the default direction is the same 45/30 orbit in every declared
        // basis, so it resolves to one vector — and that vector is the historic
        // Y-up literal, bit for bit, so default glTF renders cannot move.
        const HISTORIC_LITERAL: [f32; 3] = [0.612_372_46, 0.5, 0.612_372_46];
        for (up, forward) in [
            ("+y", "+z"),
            ("+z", "-y"),
            ("+x", "+z"),
            ("-y", "+x"),
            ("-z", "-x"),
        ] {
            let options = RenderRequest::from_json(&format!(
                r#"{{"format":"png","world":{{"up":"{up}","forward":"{forward}"}}}}"#
            ))
            .expect("parse")
            .resolve_options()
            .expect("resolve");
            let (resolved_up, direction) =
                fit_orientation(options.camera).expect("default camera must fit");
            assert_vec3_near(resolved_up.into(), glam::Vec3::Y);
            assert_eq!(direction, HISTORIC_LITERAL, "world {up}/{forward}");
        }
        let fixed = RenderRequest::from_json(
            r#"{"format":"png","camera":{"framing":"fixed","position":[4,3,2],"target":[0,0,0],"up":[0,0,1]}}"#,
        )
        .expect("parse")
        .resolve_options()
        .expect("resolve");
        assert!(fit_orientation(fixed.camera).is_none());
        // Resolved space puts the declared up on Y, so the elevation reads back
        // as the 30 degrees the orbit asks for — not the ~37.8 the literal
        // substitution used to hand a Z-up caller.
        let elevation = glam::Vec3::from(HISTORIC_LITERAL)
            .dot(glam::Vec3::Y)
            .asin()
            .to_degrees();
        assert!((elevation - DEFAULT_FIT_ELEVATION_DEG as f32).abs() < 1.0e-4);
    }

    /// Resolve one request and hand back its camera's screen-up and direction.
    /// Resolution maps the declared world onto the engine basis, so a
    /// substituted `world.forward` reads back as `+Z` and `world.up` as `+Y`
    /// whichever axes the caller declared.
    fn resolved_orientation(json: &str) -> ([f32; 3], [f32; 3]) {
        let camera = RenderRequest::from_json(json)
            .expect("parse")
            .resolve_options()
            .expect("resolve")
            .camera;
        match camera {
            RenderCamera::Fit { up, direction, .. } => (up, direction),
            RenderCamera::Fixed {
                up,
                position,
                target,
                ..
            } => (
                up,
                (glam::Vec3::from(position) - glam::Vec3::from(target))
                    .normalize()
                    .to_array(),
            ),
        }
    }

    #[test]
    fn a_degenerate_up_resolves_to_a_declared_world_axis() {
        const FORWARD: [f32; 3] = [0.0, 0.0, 1.0];
        const UP: [f32; 3] = [0.0, 1.0, 0.0];

        // Fit at elevation ±90 puts the view on the pole an omitted `up`
        // already occupies; `world.forward` takes the roll.
        for direction in ["[0,1,0]", "[0,-1,0]"] {
            let (up, _) = resolved_orientation(&format!(
                r#"{{"format":"png","camera":{{"framing":"fit","direction":{direction}}}}}"#
            ));
            assert_eq!(up, FORWARD, "fit along {direction}");
        }
        // The same view in a declared world reads the same substitution there:
        // `world.forward` is `-y`, which resolution puts on `+Z`.
        assert_eq!(
            resolved_orientation(
                r#"{"format":"png","world":{"up":"+z","forward":"-y"},"camera":{"framing":"fit","direction":[0,0,1]}}"#
            ),
            (FORWARD, UP),
        );
        // An explicit `up` that contradicts an explicit `direction` resolves
        // the same way, for both framings.
        assert_eq!(
            resolved_orientation(
                r#"{"format":"png","camera":{"framing":"fit","direction":[0,2,0],"up":[0,3,0]}}"#
            ),
            (FORWARD, UP),
        );
        assert_eq!(
            resolved_orientation(
                r#"{"format":"png","camera":{"framing":"fixed","position":[0,4,0],"target":[0,0,0],"up":[0,1,0]}}"#
            ),
            (FORWARD, UP),
        );
        // A view along `world.forward` is the one case `world.forward` cannot
        // serve, so the second fallback — `world.up` — is taken.
        assert_eq!(
            resolved_orientation(
                r#"{"format":"png","camera":{"framing":"fit","direction":[0,0,1],"up":[0,0,5]}}"#
            ),
            (UP, FORWARD),
        );
        assert_eq!(
            resolved_orientation(
                r#"{"format":"png","camera":{"framing":"fixed","position":[0,0,4],"target":[0,0,0],"up":[0,0,1]}}"#
            ),
            (UP, FORWARD),
        );
        assert_eq!(
            resolved_orientation(
                r#"{"format":"png","world":{"up":"+z","forward":"-y"},"camera":{"framing":"fit","direction":[0,-1,0],"up":[0,-1,0]}}"#
            ),
            (UP, FORWARD),
        );
        // An `up` that names a roll keeps it, so no accepted request moves.
        let request =
            r#"{"format":"png","camera":{"framing":"fit","direction":[0,1,0],"up":[1,0,0]}}"#;
        assert_eq!(resolved_orientation(request), ([1.0, 0.0, 0.0], UP));
        // Resolution reads the request and the declared world alone, so the
        // same request always names the same basis.
        assert_eq!(resolved_orientation(request), resolved_orientation(request));
    }

    #[test]
    fn caller_world_converts_every_spatial_request_value_once() {
        let options = RenderRequest::from_json(
            r#"{
                "format":"png",
                "world":{"up":"+z","forward":"-y","unit":"millimeter"},
                "camera":{"framing":"fixed","position":[1000,2000,3000],"target":[0,0,0],"up":[0,0,1],"projection":{"kind":"orthographic","verticalSpan":5000},"clipping":{"near":100,"far":100000}},
                "sections":{"planes":[{"point":[1000,2000,3000],"normal":[0,0,1]}]},
                "lighting":{"lights":[{"direction":[0,1,0],"color":[1,1,1]}],"space":"world"}
            }"#,
        )
        .expect("parse")
        .resolve_options()
        .expect("resolve");
        assert_eq!(
            options.camera,
            RenderCamera::Fixed {
                position: [1.0, 3.000_000_2, -2.0],
                target: [0.0; 3],
                up: [0.0, 1.0, 0.0],
                projection: CameraProjection::Orthographic {
                    vertical_span: Some(5.0),
                    zoom: 1.0,
                },
                clipping: Some(crate::ClipPlanes {
                    near: 0.1,
                    far: 100.000_01,
                }),
            }
        );
        let section = &options.sections.expect("sections").planes[0];
        assert_vec3_near(section.point.into(), glam::Vec3::new(1.0, 3.0, -2.0));
        assert_eq!(section.normal, [0.0, 1.0, 0.0]);
        assert_eq!(options.lighting.lights[0].direction, [0.0, 0.0, -1.0]);
    }

    #[test]
    fn a_label_alone_switches_the_label_annotation_on() {
        let (options, _) = RenderRequest::from_json(r#"{"format":"png","label":"gear"}"#)
            .expect("parse")
            .resolve()
            .expect("resolve");
        assert_eq!(options.label.as_deref(), Some("gear"));
        assert_eq!(
            RenderRequest::from_json(r#"{"format":"png","label":"gear","width":191}"#)
                .expect("parse")
                .resolve()
                .unwrap_err()
                .to_string(),
            "parse: annotated images must be at least 192x192"
        );
        assert_eq!(
            RenderImagesRequest::from_json(
                r#"{"format":"png","views":[{"id":"front","label":"Front","width":191}]}"#
            )
            .expect("parse")
            .resolve()
            .unwrap_err()
            .to_string(),
            "parse: views[0]: annotated images must be at least 192x192"
        );
    }

    #[test]
    fn a_batch_judges_annotated_dimensions_per_view() {
        // The shared pair is only a default: a view that overrides both is the
        // size that gets rendered and annotated.
        let (options, _, views, _) = RenderImagesRequest::from_json(
            r#"{"format":"png","axes":true,"width":128,"height":128,"views":[{"id":"front","width":512,"height":512}]}"#
        )
        .expect("parse")
        .resolve()
        .expect("resolve");
        assert_eq!((options.width, options.height), (128, 128));
        assert_eq!(views[0].width, Some(512));
        // A view that inherits the small shared pair still fails on its own size.
        assert_eq!(
            RenderImagesRequest::from_json(
                r#"{"format":"png","axes":true,"width":128,"height":128,"views":[{"id":"front"}]}"#
            )
            .expect("parse")
            .resolve()
            .unwrap_err()
            .to_string(),
            "parse: views[0]: annotated images must be at least 192x192"
        );
    }

    #[test]
    fn a_batch_resolves_each_view_primitive_selection() {
        let (_, _, views, _) = RenderImagesRequest::from_json(
            r#"{"format":"png","views":[{"id":"part","visiblePrimitives":[{"nodeIndex":2,"meshIndex":1,"primitiveIndex":0}]},{"id":"empty","visiblePrimitives":[]},{"id":"shared"}]}"#,
        )
        .expect("parse")
        .resolve()
        .expect("resolve");
        assert_eq!(
            views[0].visible_primitives,
            Some(vec![PrimitiveRef {
                node_index: 2,
                mesh_index: 1,
                primitive_index: 0,
            }])
        );
        assert_eq!(views[1].visible_primitives, Some(vec![]));
        assert_eq!(views[2].visible_primitives, None);
    }

    #[test]
    fn an_image_request_without_a_format_is_rejected() {
        // The TS façade makes `format` required, so no default can be right
        // here: an absent format is a caller mistake, not a request for PNG.
        for json in ["{}", r#"{"width":256}"#, r#"{"quality":0.9}"#] {
            let error = RenderRequest::from_json(json)
                .expect("parse")
                .resolve()
                .unwrap_err();
            assert_eq!(error.to_string(), "parse: format is required", "{json}");
        }
        assert_eq!(
            RenderImagesRequest::from_json(r#"{"views":[{"id":"front"}]}"#)
                .expect("parse")
                .resolve()
                .unwrap_err()
                .to_string(),
            "parse: format is required"
        );
        // The format-free resolution still answers, because it chooses no
        // encoder: it is what `resolve` layers the required format onto.
        let options = RenderRequest::from_json(r#"{"width":256}"#)
            .expect("parse")
            .resolve_options()
            .expect("resolve");
        assert_eq!(options.width, 256);
    }

    #[test]
    fn raw_resolves_as_a_format_and_ignores_quality() {
        for json in [r#"{"format":"raw"}"#, r#"{"format":"raw","quality":0.5}"#] {
            let (options, format) = RenderRequest::from_json(json)
                .expect("parse")
                .resolve()
                .expect("resolve");
            assert_eq!(format, ImageFormat::Raw, "{json}");
            assert_eq!((options.width, options.height), (768, 432));
        }
        // A per-view override picks it up through the same resolution, so one
        // plan can mix an encoded view with an unencoded one.
        let (_, shared, views, _) = RenderImagesRequest::from_json(
            r#"{"format":"webp","views":[{"id":"thumb"},{"id":"frame","format":"raw"}]}"#,
        )
        .expect("parse")
        .resolve()
        .expect("resolve");
        assert_eq!(shared, ImageFormat::WebP { quality: 100 });
        assert_eq!(views[0].format, None);
        assert_eq!(views[1].format, Some(ImageFormat::Raw));
    }

    #[test]
    fn webp_quality_below_one_is_always_lossy() {
        for (json, expected) in [
            (r#"{"format":"webp"}"#, 100u8),
            (r#"{"format":"webp","quality":1}"#, 100),
            (r#"{"format":"webp","quality":0.995}"#, 99),
            (r#"{"format":"webp","quality":0.9}"#, 90),
        ] {
            let (_, format) = RenderRequest::from_json(json)
                .expect("parse")
                .resolve()
                .expect("resolve");
            assert_eq!(format, ImageFormat::WebP { quality: expected }, "{json}");
        }
    }

    #[test]
    fn plural_resolves_shared_settings_and_ordered_views() {
        let (options, format, views, timings) = RenderImagesRequest::from_json(
            r#"{"format":"webp","axes":true,"scaleBar":true,"views":[{"id":"front","label":"Front"},{"id":"top","label":"Top"}]}"#,
        )
        .expect("parse")
        .resolve()
        .expect("resolve");
        assert!(options.axes);
        assert!(options.scale_bar);
        assert!(!timings);
        assert_eq!(views[0].label.as_deref(), Some("Front"));
        assert_eq!(format, ImageFormat::WebP { quality: 100 });
        assert_eq!(views[0].id, "front");
        assert_eq!(views[1].id, "top");
        assert_eq!(views[0].width, None);
        assert_eq!(views[0].format, None);
    }

    #[test]
    fn plural_resolves_per_view_output_overrides() {
        let (options, format, views, timings) = RenderImagesRequest::from_json(
            r#"{"format":"webp","quality":0.9,"width":768,"height":432,"timings":true,"views":[
                {"id":"card"},
                {"id":"og","width":1536,"height":804},
                {"id":"hero","format":"png"},
                {"id":"print","format":"jpeg","quality":0.8},
                {"id":"exact","quality":1}
            ]}"#,
        )
        .expect("parse")
        .resolve()
        .expect("resolve");
        assert!(timings);
        // Shared pair: lossy webp at 0.9.
        assert_eq!(format, ImageFormat::WebP { quality: 90 });
        // No overrides: shared values apply.
        assert_eq!(views[0].format, None);
        // Dimensions only: format untouched.
        assert_eq!((views[1].width, views[1].height), (Some(1536), Some(804)));
        assert_eq!(views[1].format, None);
        // Format override without quality: PNG ignores the shared quality.
        assert_eq!(views[2].format, Some(ImageFormat::Png));
        // Format + quality override.
        assert_eq!(views[3].format, Some(ImageFormat::Jpeg { quality: 80 }));
        // Quality override alone resolves against the shared format name, and
        // exactly 1 selects lossless per the shared WebP rule.
        assert_eq!(views[4].format, Some(ImageFormat::WebP { quality: 100 }));
        assert_eq!(options.width, 768);
    }

    #[test]
    fn rejects_invalid_singular_requests() {
        for json in [
            r#"{"format":"png","width":15}"#,
            r#"{"format":"png","margin":0.6}"#,
            r#"{"format":"png","quality":1.5}"#,
            r#"{"format":"png","up":"w"}"#,
            r#"{"format":"png","projection":"fish-eye"}"#,
            r#"{"format":"gif"}"#,
            r#"{"format":"png","background":[2.0,0.0,0.0,1.0]}"#,
            r#"{"format":"png","zoomLevel":1.8}"#,
            r#"{"format":"png","axes":true,"width":191}"#,
            r#"{"format":"png","label":"snowman ☃"}"#,
            "not json",
        ] {
            assert!(
                RenderRequest::from_json(json)
                    .and_then(|request| request.resolve())
                    .is_err()
            );
        }
    }

    #[test]
    fn rejects_invalid_plural_views_before_rendering() {
        for json in [
            r#"{"format":"png","views":[]}"#,
            r#"{"format":"png","views":[{"id":"../front"}]}"#,
            r#"{"format":"png","views":[{"id":"front"},{"id":"front"}]}"#,
            r#"{"format":"png","views":[{"id":"front","zoom":2}]}"#,
            r#"{"format":"png","views":[{"id":"front","camera":{"framing":"fit","direction":[0,0,0]}}]}"#,
            r#"{"format":"png","phi":90,"views":[{"id":"front"}]}"#,
            r#"{"format":"png","label":"shared","views":[{"id":"front"}]}"#,
        ] {
            assert!(
                RenderImagesRequest::from_json(json)
                    .and_then(|request| request.resolve())
                    .is_err()
            );
        }
    }

    #[test]
    fn removed_camera_fields_name_their_replacement() {
        assert!(RenderRequest::from_json("[]").is_err());
        assert!(RenderImagesRequest::from_json("not json").is_err());
        assert!(RenderImagesRequest::from_json(r#"{"views":[null]}"#).is_err());
        assert_eq!(
            RenderRequest::from_json(r#"{"format":"png","phi":60}"#)
                .unwrap_err()
                .to_string(),
            "parse: options.phi was removed; use options.camera with framing, Cartesian vectors, and a nested projection"
        );
        assert_eq!(
            RenderImagesRequest::from_json(
                r#"{"format":"png","views":[{"id":"front","theta":0}]}"#,
            )
            .unwrap_err()
            .to_string(),
            "parse: views[0].theta was removed; use views[0].camera with framing, Cartesian vectors, and a nested projection"
        );
    }

    #[test]
    fn rejects_invalid_per_view_output_overrides_by_name() {
        let cases = [
            (
                r#"{"format":"png","views":[{"id":"front","width":15}]}"#,
                "parse: views[0].width 15 outside 16..=8192",
            ),
            (
                r#"{"format":"png","views":[{"id":"front","height":8193}]}"#,
                "parse: views[0].height 8193 outside 16..=8192",
            ),
            (
                r#"{"format":"png","views":[{"id":"front","quality":1.5}]}"#,
                "parse: views[0].quality 1.5 outside 0..=1",
            ),
            (
                r#"{"format":"png","views":[{"id":"front","format":"gif"}]}"#,
                "parse: views[0]: format \"gif\" not png/webp/jpeg/jpg/raw",
            ),
            (
                r#"{"format":"png","axes":true,"views":[{"id":"front","width":191}]}"#,
                "parse: views[0]: annotated images must be at least 192x192",
            ),
        ];
        for (json, expected) in cases {
            let error = RenderImagesRequest::from_json(json)
                .and_then(|request| request.resolve())
                .unwrap_err()
                .to_string();
            assert_eq!(error, expected, "{json}");
        }
    }

    #[test]
    fn create_renderer_request_resolves_power_preferences() {
        assert_eq!(
            CreateRendererRequest::from_json(None)
                .expect("parse")
                .resolve()
                .expect("resolve"),
            wgpu::PowerPreference::HighPerformance
        );
        for (json, expected) in [
            (
                r#"{"powerPreference":"high-performance"}"#,
                wgpu::PowerPreference::HighPerformance,
            ),
            (
                r#"{"powerPreference":"low-power"}"#,
                wgpu::PowerPreference::LowPower,
            ),
            (r"{}", wgpu::PowerPreference::HighPerformance),
        ] {
            assert_eq!(
                CreateRendererRequest::from_json(Some(json))
                    .expect("parse")
                    .resolve()
                    .expect("resolve"),
                expected
            );
        }
        assert_eq!(
            CreateRendererRequest::from_json(Some(r#"{"powerPreference":"turbo"}"#))
                .expect("parse")
                .resolve()
                .unwrap_err()
                .to_string(),
            "parse: powerPreference \"turbo\" not high-performance/low-power"
        );
        assert!(CreateRendererRequest::from_json(Some(r#"{"battery":true}"#)).is_err());
        assert!(CreateRendererRequest::from_json(Some("not json")).is_err());
    }

    #[test]
    fn resolves_every_common_option_variant() {
        let json = r#"{"format":"jpeg","quality":0.8,"width":192,"height":193,"lineWidth":0.25,"surfaces":false,"lines":true,"visiblePrimitives":[{"nodeIndex":2,"meshIndex":1,"primitiveIndex":0}],"sections":{"planes":[{"point":[1,2,3],"normal":[2,0,0]}],"clipLines":false},"camera":{"framing":"fixed","position":[4,3,2],"target":[0,0,0],"up":[0,0,1],"projection":{"kind":"orthographic","verticalSpan":12,"zoom":1.5},"clipping":{"near":0.1,"far":100}},"background":[0,0.25,0.5,1],"label":"µ—−","axes":true,"scaleBar":true}"#;
        let (options, format) = RenderRequest::from_json(json)
            .expect("parse")
            .resolve()
            .expect("resolve");
        assert_eq!(options.width, 192);
        assert_eq!(options.height, 193);
        assert_eq!(options.line_width, 0.25);
        assert!(!options.surfaces);
        assert!(options.lines);
        assert_eq!(
            options.visible_primitives,
            Some(vec![PrimitiveRef {
                node_index: 2,
                mesh_index: 1,
                primitive_index: 0,
            }])
        );
        let sections = options.sections.as_ref().expect("sections");
        assert_eq!(sections.planes[0].normal, [1.0, 0.0, 0.0]);
        assert!(sections.clip_surfaces);
        assert!(!sections.clip_lines);
        assert!(options.axes);
        assert!(options.scale_bar);
        assert_eq!(
            options.camera.projection_kind(),
            crate::Projection::Orthographic
        );
        assert_eq!(format, ImageFormat::Jpeg { quality: 80 });
    }

    #[test]
    fn rejects_invalid_presentation_requests() {
        for json in [
            r#"{"format":"png","visiblePrimitives":[{"nodeIndex":0,"meshIndex":0,"primitiveIndex":0},{"nodeIndex":0,"meshIndex":0,"primitiveIndex":0}]}"#,
            r#"{"format":"png","sections":{"planes":[]}}"#,
            r#"{"format":"png","sections":{"planes":[{"point":[0,0,0],"normal":[0,0,0]}]}}"#,
        ] {
            assert!(
                RenderRequest::from_json(json)
                    .and_then(|request| request.resolve())
                    .is_err()
            );
        }
        // The limit itself resolves; one plane past it does not.
        let request = |count: usize| {
            let planes = (1..=count)
                .map(|index| format!(r#"{{"point":[0,0,0],"normal":[{index},1,0]}}"#))
                .collect::<Vec<_>>()
                .join(",");
            RenderRequest::from_json(&format!(
                r#"{{"format":"png","sections":{{"planes":[{planes}]}}}}"#
            ))
            .and_then(|request| request.resolve())
        };
        assert!(request(MAX_SECTION_PLANES).is_ok());
        assert_eq!(
            request(MAX_SECTION_PLANES + 1)
                .err()
                .map(|error| error.to_string()),
            Some(format!(
                "parse: sections.planes must contain between 1 and {MAX_SECTION_PLANES} planes"
            ))
        );
    }

    #[test]
    fn resolves_every_camera_arm_and_rejects_invalid_combinations() {
        let cases = [
            r#"{"format":"png","camera":{"framing":"fit"}}"#,
            r#"{"format":"png","camera":{"framing":"fit","direction":[1,-1,1],"up":[0,0,1],"margin":0.2,"projection":{"kind":"perspective","verticalFieldOfView":60}}}"#,
            // A degenerate `up` names a substitution, not a mistake.
            r#"{"format":"png","camera":{"framing":"fit","direction":[0,1,0],"up":[0,2,0]}}"#,
            r#"{"format":"png","camera":{"framing":"fixed","position":[0,0,1],"target":[0,0,0],"up":[0,0,1]}}"#,
            r#"{"format":"png","camera":{"framing":"fit","projection":{"kind":"orthographic"}}}"#,
            r#"{"format":"png","camera":{"framing":"fixed","position":[4,3,2],"target":[0,0,0],"up":[0,0,1]}}"#,
            r#"{"format":"png","camera":{"framing":"fixed","position":[4,3,2],"target":[0,0,0],"up":[0,0,1],"projection":{"kind":"perspective","verticalFieldOfView":35,"zoom":2},"clipping":{"near":0.1,"far":100}}}"#,
            r#"{"format":"png","camera":{"framing":"fixed","position":[0,0,10],"target":[0,0,0],"up":[0,1,0],"projection":{"kind":"orthographic","verticalSpan":20,"zoom":0.5}}}"#,
        ];
        for json in cases {
            RenderRequest::from_json(json)
                .expect("parse")
                .resolve()
                .expect("resolve");
        }

        for json in [
            r#"{"format":"png","camera":{"framing":"fit","direction":[0,0,0]}}"#,
            r#"{"format":"png","camera":{"framing":"fit","up":[0,0,0]}}"#,
            r#"{"format":"png","camera":{"framing":"fit","margin":0.6}}"#,
            r#"{"format":"png","camera":{"framing":"fit","projection":{"kind":"perspective","verticalFieldOfView":0}}}"#,
            r#"{"format":"png","camera":{"framing":"fit","projection":{"kind":"perspective","zoom":2}}}"#,
            r#"{"format":"png","camera":{"framing":"fixed","position":[0,0,0],"target":[0,0,0],"up":[0,1,0]}}"#,
            r#"{"format":"png","camera":{"framing":"fixed","position":[0,0,1],"target":[0,0,0],"up":[0,0,0]}}"#,
            r#"{"format":"png","camera":{"framing":"fixed","position":[0,0,1],"target":[0,0,0],"up":[0,1,0],"projection":{"kind":"orthographic","verticalSpan":0}}}"#,
            r#"{"format":"png","camera":{"framing":"fixed","position":[0,0,1],"target":[0,0,0],"up":[0,1,0],"projection":{"kind":"perspective","zoom":0}}}"#,
            r#"{"format":"png","camera":{"framing":"fixed","position":[0,0,1],"target":[0,0,0],"up":[0,1,0],"clipping":{"near":1,"far":1}}}"#,
        ] {
            assert!(
                RenderRequest::from_json(json)
                    .and_then(|request| request.resolve())
                    .is_err(),
            );
        }
        assert!(finite_vector([f32::NAN, 0.0, 0.0], "position", true).is_err());
    }

    /// Lighting is settled before any encoder is chosen, so these cases go
    /// through the format-free resolution.
    fn lighting_of(json: &str) -> Result<ResolvedLighting, RenderError> {
        RenderRequest::from_json(json)
            .and_then(|request| request.resolve_options())
            .map(|options| options.lighting)
    }

    #[test]
    fn every_spelling_of_the_studio_preset_resolves_identically() {
        let studio = ResolvedLighting::studio();
        let explicit = format!(
            r#"{{"lighting":{{"lights":[],"headlamp":{{"intensity":1.5,"rightOffset":2,"upOffset":2}},
            "ambient":{},"environment":{{"intensity":1}},"space":"view","exposure":1}}}}"#,
            studio.ambient
        );
        for json in [
            "{}",
            r#"{"lighting":"studio"}"#,
            r#"{"lighting":{}}"#,
            r#"{"lighting":{"environment":"studio"}}"#,
            &explicit,
        ] {
            assert_eq!(lighting_of(json).expect("resolve"), studio, "{json}");
        }
        // The plural request carries the same field.
        let (options, _, _, _) = RenderImagesRequest::from_json(
            r#"{"format":"png","lighting":"studio","views":[{"id":"front"}]}"#,
        )
        .expect("parse")
        .resolve()
        .expect("resolve");
        assert_eq!(options.lighting, studio);
    }

    #[test]
    fn accepts_every_rig_field_and_bound() {
        let rig = lighting_of(
            r#"{"lighting":{"lights":[{"direction":[0,0,1],"color":[0,16,32]}],"ambient":4,"environment":"none","space":"world","exposure":16}}"#,
        )
        .expect("resolve");
        assert_eq!(rig.lights.len(), 1);
        assert_eq!(rig.lights[0].direction, [0.0, 0.0, 1.0]);
        assert_eq!(rig.lights[0].color, [0.0, 16.0, 32.0]);
        assert_eq!(rig.ambient, 4.0);
        assert!(!rig.environment);
        assert_eq!(rig.space, LightingSpace::World);
        assert_eq!(rig.exposure, 16.0);

        // An empty array is an environment-only render, not an error: a lights
        // array without a headlamp replaces the studio headlamp, and the
        // unspecified fields still inherit the preset.
        let bare = lighting_of(r#"{"lighting":{"lights":[]}}"#).expect("resolve");
        assert!(bare.lights.is_empty());
        assert_eq!(bare.headlamp, None);
        assert_eq!(bare.ambient, ResolvedLighting::studio().ambient);
        assert!(bare.environment);
        assert_eq!(bare.space, LightingSpace::View);
        assert_eq!(bare.exposure, 1.0);

        // The cap itself is allowed; only exceeding it is not.
        let light = r#"{"direction":[0,1,0],"color":[1,1,1]}"#;
        let full = format!(
            r#"{{"lighting":{{"lights":[{}]}}}}"#,
            [light; MAX_LIGHTS].join(",")
        );
        assert_eq!(
            lighting_of(&full).expect("resolve").lights.len(),
            MAX_LIGHTS
        );
        assert_eq!(
            lighting_of(&format!(
                r#"{{"lighting":{{"lights":[{}]}}}}"#,
                [light; MAX_LIGHTS + 1].join(",")
            ))
            .unwrap_err()
            .to_string(),
            "parse: lighting.lights: at most 8 lights, received 9"
        );
        // Beside the headlamp one slot fewer remains.
        assert_eq!(
            lighting_of(&format!(
                r#"{{"lighting":{{"headlamp":{{}},"lights":[{}]}}}}"#,
                [light; MAX_LIGHTS].join(",")
            ))
            .unwrap_err()
            .to_string(),
            "parse: lighting.lights: at most 7 lights beside the headlamp, received 8"
        );
    }

    #[test]
    fn resolves_the_headlamp_and_light_cards() {
        let viewer = Headlamp::VIEWER;
        // Omitted headlamp fields keep the viewer's; zero intensity is off.
        let rig = lighting_of(r#"{"lighting":{"headlamp":{"upOffset":-1}}}"#).expect("resolve");
        assert_eq!(
            rig.headlamp,
            Some(Headlamp {
                up_offset: -1.0,
                ..viewer
            })
        );
        assert!(rig.lights.is_empty());
        assert_eq!(rig.headlamp.expect("on").direction(), [2.0, -1.0, 2.0]);
        let off = lighting_of(r#"{"lighting":{"headlamp":{"intensity":0}}}"#).expect("resolve");
        assert_eq!(off.headlamp, None);
        let both = lighting_of(
            r#"{"lighting":{"headlamp":{"intensity":3},"lights":[{"direction":[0,1,0],"color":[1,1,1]}]}}"#,
        )
        .expect("resolve");
        assert_eq!(both.headlamp.expect("on").intensity, 3.0);
        assert_eq!(both.lights.len(), 1);

        let cards = lighting_of(
            r#"{"lighting":{"environment":{"intensity":0.5,"cards":[
                {"position":[1,1,1],"size":[1.2,1.2],"intensity":64},
                {"position":[0,3,0],"size":[3,2],"intensity":0.25,"rotation":[1.5,0,0]}
            ]}}}"#,
        )
        .expect("resolve");
        assert!(cards.environment);
        assert_eq!(cards.environment_intensity, 0.5);
        assert_eq!(
            cards.environment_source,
            EnvironmentSource::Cards(vec![
                LightCard {
                    position: [1.0; 3],
                    size: [1.2, 1.2],
                    intensity: 64.0,
                    rotation: None,
                },
                LightCard {
                    position: [0.0, 3.0, 0.0],
                    size: [3.0, 2.0],
                    intensity: 0.25,
                    rotation: Some([1.5, 0.0, 0.0]),
                },
            ])
        );
        // An empty card list is a black environment, not the room.
        assert_eq!(
            lighting_of(r#"{"lighting":{"environment":{"cards":[]}}}"#)
                .expect("resolve")
                .environment_source,
            EnvironmentSource::Cards(Vec::new())
        );
        let card = r#"{"position":[0,0,2],"size":[1,1],"intensity":1}"#;
        let full = format!(
            r#"{{"lighting":{{"environment":{{"cards":[{}]}}}}}}"#,
            [card; MAX_LIGHT_CARDS].join(",")
        );
        assert!(lighting_of(&full).is_ok());
        assert_eq!(
            lighting_of(&format!(
                r#"{{"lighting":{{"environment":{{"cards":[{}]}}}}}}"#,
                [card; MAX_LIGHT_CARDS + 1].join(",")
            ))
            .unwrap_err()
            .to_string(),
            "parse: lighting.environment.cards: at most 16 cards, received 17"
        );
    }

    #[test]
    fn rejects_every_invalid_lighting_rule_by_name() {
        let cases = [
            (
                r#"{"lighting":"neutral"}"#,
                "parse: lighting \"neutral\" not studio",
            ),
            (
                // 1e40 overflows f32 to infinity rather than failing to parse.
                r#"{"lighting":{"lights":[{"direction":[1,0,0],"color":[1,1,1]},{"direction":[0,1e40,0],"color":[1,1,1]}]}}"#,
                "parse: lighting.lights[1].direction must be finite",
            ),
            (
                r#"{"lighting":{"lights":[{"direction":[0,0,0],"color":[1,1,1]}]}}"#,
                "parse: lighting.lights[0].direction must be non-zero",
            ),
            (
                r#"{"lighting":{"lights":[{"direction":[0,0,1],"color":[1,33,1]}]}}"#,
                "parse: lighting.lights[0].color channels outside 0..=32",
            ),
            (
                r#"{"lighting":{"lights":[{"direction":[0,0,1],"color":[-1,0,0]}]}}"#,
                "parse: lighting.lights[0].color channels outside 0..=32",
            ),
            (
                r#"{"lighting":{"lights":[],"ambient":4.5}}"#,
                "parse: lighting.ambient 4.5 outside 0..=4",
            ),
            (
                r#"{"lighting":{"lights":[],"exposure":0}}"#,
                "parse: lighting.exposure 0 outside 0.01..=16",
            ),
            (
                r#"{"lighting":{"lights":[],"exposure":16.5}}"#,
                "parse: lighting.exposure 16.5 outside 0.01..=16",
            ),
            (
                r#"{"lighting":{"lights":[],"environment":"hdr"}}"#,
                "parse: lighting.environment \"hdr\" not studio/none",
            ),
            (
                r#"{"lighting":{"lights":[],"space":"object"}}"#,
                "parse: lighting.space \"object\" not view/world",
            ),
            (
                r#"{"lighting":{"headlamp":{"intensity":33}}}"#,
                "parse: lighting.headlamp.intensity 33 outside 0..=32",
            ),
            (
                r#"{"lighting":{"headlamp":{"rightOffset":65}}}"#,
                "parse: lighting.headlamp.rightOffset 65 outside -64..=64",
            ),
            (
                r#"{"lighting":{"headlamp":{"upOffset":1e40}}}"#,
                "parse: lighting.headlamp.upOffset inf outside -64..=64",
            ),
            (
                r#"{"lighting":{"environment":{"intensity":17}}}"#,
                "parse: lighting.environment.intensity 17 outside 0..=16",
            ),
            (
                r#"{"lighting":{"environment":{"cards":[{"position":[0,0,65],"size":[1,1],"intensity":1}]}}}"#,
                "parse: lighting.environment.cards[0].position axes outside -64..=64",
            ),
            (
                r#"{"lighting":{"environment":{"cards":[{"position":[0,0,0],"size":[1,1],"intensity":1}]}}}"#,
                "parse: lighting.environment.cards[0].position must be away from the centre",
            ),
            (
                r#"{"lighting":{"environment":{"cards":[{"position":[0,0,1],"size":[0,1],"intensity":1}]}}}"#,
                "parse: lighting.environment.cards[0].size sides outside (0, 64]",
            ),
            (
                r#"{"lighting":{"environment":{"cards":[{"position":[0,0,1],"size":[1,1],"intensity":-1}]}}}"#,
                "parse: lighting.environment.cards[0].intensity -1 outside 0..=4096",
            ),
            (
                r#"{"lighting":{"environment":{"cards":[{"position":[0,0,1],"size":[1,1],"intensity":1,"rotation":[0,1e40,0]}]}}}"#,
                "parse: lighting.environment.cards[0].rotation must be finite",
            ),
        ];
        for (json, expected) in cases {
            let message = lighting_of(json).unwrap_err().to_string();
            assert_eq!(message, expected, "{json}");
        }
        // Non-finite values that arrive as JSON numbers rather than null.
        for value in [f32::NAN, f32::INFINITY] {
            for json in [
                format!(r#"{{"lighting":{{"lights":[],"ambient":{value}}}}}"#),
                format!(r#"{{"lighting":{{"lights":[],"exposure":{value}}}}}"#),
            ] {
                assert!(lighting_of(&json).is_err(), "{json}");
            }
        }
    }

    #[test]
    fn unknown_lighting_keys_name_the_offending_field() {
        // Untagged serde would report "did not match any variant" here.
        for (json, fragment) in [
            (
                r#"{"lighting":{"lights":[{"direction":[0,0,1],"colour":[1,1,1]}]}}"#,
                "unknown field `colour`",
            ),
            (
                r#"{"lighting":{"lights":[],"tone":"aces"}}"#,
                "unknown field `tone`",
            ),
            (r#"{"lighting":42}"#, "invalid type"),
            (
                r#"{"lighting":{"headlamp":{"leftOffset":1}}}"#,
                "unknown field `leftOffset`",
            ),
            (
                r#"{"lighting":{"environment":{"card":[]}}}"#,
                "unknown field `card`",
            ),
            (
                r#"{"lighting":{"environment":{"cards":[{"position":[0,0,1],"size":[1,1],"intensity":1,"form":"circle"}]}}}"#,
                "unknown field `form`",
            ),
        ] {
            let error = RenderRequest::from_json(json).unwrap_err().to_string();
            assert!(error.starts_with("parse: options: "), "{error}");
            assert!(error.contains(fragment), "{error}");
        }
    }

    #[test]
    fn rejects_non_finite_views_labels_and_common_values() {
        for label in ["", " ", &"x".repeat(65)] {
            assert!(validate_optional_label(Some(label), "label").is_err());
        }
        let png = || Some("png".to_owned());
        for request in [
            RenderRequest {
                format: png(),
                line_width: Some(f32::NAN),
                ..Default::default()
            },
            RenderRequest {
                format: png(),
                quality: Some(f32::INFINITY),
                ..Default::default()
            },
            RenderRequest {
                format: png(),
                background: Some([0.0, 0.0, f32::NAN, 1.0]),
                ..Default::default()
            },
        ] {
            assert!(request.resolve().is_err());
        }
    }
}
