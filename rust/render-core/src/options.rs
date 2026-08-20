//! Strict JSON request contracts shared by the WASM and N-API bindings.

use crate::encode::ImageFormat;
use crate::{
    LightingSpace, MAX_LIGHTS, Projection, RenderError, RenderOptions, ResolvedLight,
    ResolvedLighting, UpAxis,
};
use serde::{Deserialize, Deserializer, de};
use std::collections::HashSet;

pub(crate) const MIN_DIMENSION: u32 = 16;
pub(crate) const MAX_DIMENSION: u32 = 4096;
pub(crate) const ANNOTATED_MIN_DIMENSION: u32 = 192;
const MAX_LIGHT_COLOR: f32 = 32.0;
const MAX_AMBIENT: f32 = 4.0;
const EXPOSURE_RANGE: std::ops::RangeInclusive<f32> = 0.01..=16.0;
/// Shorter than this and a direction carries no usable heading.
const MIN_DIRECTION_LENGTH: f32 = 1e-6;

/// Wire shape for one directional light.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LightRequest {
    direction: [f32; 3],
    color: [f32; 3],
}

/// Wire shape for an explicit rig. `lights` replaces the studio lights
/// entirely; everything else inherits the studio value when omitted.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LightingRigRequest {
    lights: Vec<LightRequest>,
    ambient: Option<f32>,
    environment: Option<String>,
    space: Option<String>,
    exposure: Option<f32>,
}

/// `"studio"` or an explicit rig.
#[derive(Debug)]
pub enum LightingRequest {
    Preset(String),
    Rig(Box<LightingRigRequest>),
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

/// Wire shape for one image.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct RenderRequest {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<String>,
    pub quality: Option<f32>,
    pub phi: Option<f32>,
    pub theta: Option<f32>,
    pub margin: Option<f32>,
    pub up: Option<String>,
    pub projection: Option<String>,
    pub background: Option<[f32; 4]>,
    pub label: Option<String>,
    pub include_axes: Option<bool>,
    pub include_label: Option<bool>,
    pub include_scale: Option<bool>,
    pub lighting: Option<LightingRequest>,
}

/// Wire shape for one identified camera in a batch: camera identity plus
/// optional per-view output overrides defaulting to the shared values.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderImageViewRequest {
    pub id: String,
    pub label: Option<String>,
    pub phi: f32,
    pub theta: f32,
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
    pub margin: Option<f32>,
    pub up: Option<String>,
    pub projection: Option<String>,
    pub background: Option<[f32; 4]>,
    pub include_axes: Option<bool>,
    pub include_label: Option<bool>,
    pub include_scale: Option<bool>,
    pub lighting: Option<LightingRequest>,
    pub profile: Option<bool>,
    pub views: Vec<RenderImageViewRequest>,
}

/// Resolved camera view. IDs are carried so failures can name the view; the
/// output overrides are `None` when the shared values apply.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderView {
    pub id: String,
    pub label: Option<String>,
    pub phi_deg: f32,
    pub theta_deg: f32,
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
    format: Option<&'a str>,
    quality: Option<f32>,
    margin: Option<f32>,
    up: Option<&'a str>,
    projection: Option<&'a str>,
    background: Option<[f32; 4]>,
    include_axes: Option<bool>,
    include_label: Option<bool>,
    include_scale: Option<bool>,
    lighting: Option<&'a LightingRequest>,
}

impl RenderRequest {
    pub fn from_json(json: &str) -> Result<Self, RenderError> {
        serde_json::from_str(json).map_err(|error| RenderError::Parse(format!("options: {error}")))
    }

    pub fn resolve(&self) -> Result<(RenderOptions, ImageFormat), RenderError> {
        let (mut options, format) = resolve_common(self.common())?;
        validate_optional_label(self.label.as_deref(), "label")?;
        if options.include_label && self.label.is_none() {
            return Err(RenderError::Parse(
                "label is required when includeLabel is true".into(),
            ));
        }
        options.label.clone_from(&self.label);
        options.phi_deg = finite_or_default(self.phi, options.phi_deg, "phi")?;
        options.theta_deg = finite_or_default(self.theta, options.theta_deg, "theta")?;
        Ok((options, format))
    }

    fn common(&self) -> CommonRequest<'_> {
        CommonRequest {
            width: self.width,
            height: self.height,
            format: self.format.as_deref(),
            quality: self.quality,
            margin: self.margin,
            up: self.up.as_deref(),
            projection: self.projection.as_deref(),
            background: self.background,
            include_axes: self.include_axes,
            include_label: self.include_label,
            include_scale: self.include_scale,
            lighting: self.lighting.as_ref(),
        }
    }
}

impl RenderImagesRequest {
    pub fn from_json(json: &str) -> Result<Self, RenderError> {
        serde_json::from_str(json).map_err(|error| RenderError::Parse(format!("options: {error}")))
    }

    pub fn resolve(
        &self,
    ) -> Result<(RenderOptions, ImageFormat, Vec<RenderView>, bool), RenderError> {
        let (options, format) = resolve_common(self.common())?;
        if self.views.is_empty() {
            return Err(RenderError::Parse(
                "views must contain at least one view".into(),
            ));
        }
        let shared_format_name = self.format.as_deref().unwrap_or("png");
        let annotated = options.include_axes || options.include_label || options.include_scale;
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
            if !view.phi.is_finite() {
                return Err(RenderError::Parse(format!(
                    "views[{index}].phi must be finite"
                )));
            }
            if !view.theta.is_finite() {
                return Err(RenderError::Parse(format!(
                    "views[{index}].theta must be finite"
                )));
            }
            for (name, value) in [("width", view.width), ("height", view.height)] {
                if let Some(value) = value
                    && !(MIN_DIMENSION..=MAX_DIMENSION).contains(&value)
                {
                    return Err(RenderError::Parse(format!(
                        "views[{index}].{name} {value} outside {MIN_DIMENSION}..={MAX_DIMENSION}"
                    )));
                }
            }
            if annotated
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
            if options.include_label && view.label.is_none() {
                return Err(RenderError::Parse(format!(
                    "views[{index}].label is required when includeLabel is true"
                )));
            }
            views.push(RenderView {
                id: view.id.clone(),
                label: view.label.clone(),
                phi_deg: view.phi,
                theta_deg: view.theta,
                width: view.width,
                height: view.height,
                format: view_format,
            });
        }
        Ok((options, format, views, self.profile.unwrap_or(false)))
    }

    fn common(&self) -> CommonRequest<'_> {
        CommonRequest {
            width: self.width,
            height: self.height,
            format: self.format.as_deref(),
            quality: self.quality,
            margin: self.margin,
            up: self.up.as_deref(),
            projection: self.projection.as_deref(),
            background: self.background,
            include_axes: self.include_axes,
            include_label: self.include_label,
            include_scale: self.include_scale,
            lighting: self.lighting.as_ref(),
        }
    }
}

fn resolve_common(request: CommonRequest<'_>) -> Result<(RenderOptions, ImageFormat), RenderError> {
    let defaults = RenderOptions::default();
    let width = request.width.unwrap_or(defaults.width);
    let height = request.height.unwrap_or(defaults.height);
    if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&width)
        || !(MIN_DIMENSION..=MAX_DIMENSION).contains(&height)
    {
        return Err(RenderError::Parse(format!(
            "dimensions {width}x{height} outside {MIN_DIMENSION}..={MAX_DIMENSION}"
        )));
    }
    let include_axes = request.include_axes.unwrap_or(false);
    let include_label = request.include_label.unwrap_or(false);
    let include_scale = request.include_scale.unwrap_or(false);
    if (include_axes || include_label || include_scale)
        && (width < ANNOTATED_MIN_DIMENSION || height < ANNOTATED_MIN_DIMENSION)
    {
        return Err(RenderError::Parse(format!(
            "annotated images must be at least {ANNOTATED_MIN_DIMENSION}x{ANNOTATED_MIN_DIMENSION}"
        )));
    }

    let margin = request.margin.unwrap_or(0.1);
    if !margin.is_finite() || !(0.0..=0.5).contains(&margin) {
        return Err(RenderError::Parse(format!(
            "margin {margin} outside 0..=0.5"
        )));
    }
    let up = match request.up {
        None => defaults.up,
        Some("x") => UpAxis::X,
        Some("y") => UpAxis::Y,
        Some("z") => UpAxis::Z,
        Some(other) => return Err(RenderError::Parse(format!("up axis {other:?} not x/y/z"))),
    };
    let projection = match request.projection {
        None | Some("perspective") => Projection::Perspective,
        Some("orthographic") => Projection::Orthographic,
        Some(other) => {
            return Err(RenderError::Parse(format!(
                "projection {other:?} not perspective/orthographic"
            )));
        }
    };
    if let Some(background) = request.background
        && background
            .iter()
            .any(|channel| !channel.is_finite() || !(0.0..=1.0).contains(channel))
    {
        return Err(RenderError::Parse(
            "background channels outside 0..=1".into(),
        ));
    }

    let lighting = resolve_lighting(request.lighting)?;

    let format = resolve_format(request.format.unwrap_or("png"), request.quality)
        .map_err(RenderError::Parse)?;

    Ok((
        RenderOptions {
            width,
            height,
            padding_factor: 1.0 - margin,
            line_width: defaults.line_width,
            up,
            projection,
            background: request.background,
            include_axes,
            include_label,
            include_scale,
            lighting,
            ..defaults
        },
        format,
    ))
}

/// Resolve a format name plus 0..=1 quality into the encoder format, applying
/// the per-format quality default and the lossless-only-at-exactly-1 WebP
/// rule. WebP defaults to 1 (lossless, matching earlier lossless-only
/// releases); JPEG keeps 0.92. PNG ignores quality entirely.
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
        .map_err(|_| format!("format {name:?} not png/webp/jpeg/jpg"))
}

/// `'studio'`, omitted, and the studio values spelled out all resolve to the
/// same rig. An explicit `lights` array replaces the studio lights entirely;
/// every other field inherits the preset.
fn resolve_lighting(request: Option<&LightingRequest>) -> Result<ResolvedLighting, RenderError> {
    let studio = ResolvedLighting::studio();
    let rig = match request {
        None => return Ok(studio),
        Some(LightingRequest::Preset(name)) if name == "studio" => return Ok(studio),
        Some(LightingRequest::Preset(other)) => {
            return Err(RenderError::Parse(format!("lighting {other:?} not studio")));
        }
        Some(LightingRequest::Rig(rig)) => rig,
    };

    if rig.lights.len() > MAX_LIGHTS {
        return Err(RenderError::Parse(format!(
            "lighting.lights: at most {MAX_LIGHTS} lights, received {}",
            rig.lights.len()
        )));
    }
    let mut lights = Vec::with_capacity(rig.lights.len());
    for (index, light) in rig.lights.iter().enumerate() {
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
            direction: light.direction,
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
    let environment = match rig.environment.as_deref() {
        None | Some("studio") => true,
        Some("none") => false,
        Some(other) => {
            return Err(RenderError::Parse(format!(
                "lighting.environment {other:?} not studio/none"
            )));
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
        ambient,
        environment,
        space,
        exposure,
    })
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

fn finite_or_default(value: Option<f32>, default: f32, name: &str) -> Result<f32, RenderError> {
    let value = value.unwrap_or(default);
    if !value.is_finite() {
        return Err(RenderError::Parse(format!("{name} must be finite")));
    }
    Ok(value)
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

    #[test]
    fn singular_defaults_include_axes_off() {
        let (options, format) = RenderRequest::from_json("{}")
            .expect("parse")
            .resolve()
            .expect("resolve");
        assert_eq!((options.width, options.height), (768, 432));
        assert_eq!((options.phi_deg, options.theta_deg), (60.0, -45.0));
        assert!(!options.include_axes);
        assert!(!options.include_label);
        assert!(!options.include_scale);
        assert_eq!(format, ImageFormat::Png);
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
        let (options, format, views, profile) = RenderImagesRequest::from_json(
            r#"{"format":"webp","includeAxes":true,"includeLabel":true,"includeScale":true,"views":[{"id":"front","label":"Front","phi":90,"theta":0},{"id":"top","label":"Top","phi":0,"theta":0}]}"#,
        )
        .expect("parse")
        .resolve()
        .expect("resolve");
        assert!(options.include_axes);
        assert!(options.include_label);
        assert!(options.include_scale);
        assert!(!profile);
        assert_eq!(views[0].label.as_deref(), Some("Front"));
        assert_eq!(format, ImageFormat::WebP { quality: 100 });
        assert_eq!(views[0].id, "front");
        assert_eq!(views[1].id, "top");
        assert_eq!(views[0].width, None);
        assert_eq!(views[0].format, None);
    }

    #[test]
    fn plural_resolves_per_view_output_overrides() {
        let (options, format, views, profile) = RenderImagesRequest::from_json(
            r#"{"format":"webp","quality":0.9,"width":768,"height":432,"profile":true,"views":[
                {"id":"card","phi":60,"theta":-45},
                {"id":"og","phi":60,"theta":-45,"width":1536,"height":804},
                {"id":"hero","phi":60,"theta":-45,"format":"png"},
                {"id":"print","phi":60,"theta":-45,"format":"jpeg","quality":0.8},
                {"id":"exact","phi":60,"theta":-45,"quality":1}
            ]}"#,
        )
        .expect("parse")
        .resolve()
        .expect("resolve");
        assert!(profile);
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
            r#"{"width":15}"#,
            r#"{"margin":0.6}"#,
            r#"{"quality":1.5}"#,
            r#"{"up":"w"}"#,
            r#"{"projection":"fish-eye"}"#,
            r#"{"format":"gif"}"#,
            r#"{"background":[2.0,0.0,0.0,1.0]}"#,
            r#"{"zoomLevel":1.8}"#,
            r#"{"includeLabel":true}"#,
            r#"{"includeAxes":true,"width":191}"#,
            r#"{"label":"snowman ☃"}"#,
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
            r#"{"views":[]}"#,
            r#"{"views":[{"id":"../front","phi":90,"theta":0}]}"#,
            r#"{"views":[{"id":"front","phi":90,"theta":0},{"id":"front","phi":0,"theta":0}]}"#,
            r#"{"views":[{"id":"front","phi":90,"theta":0,"zoom":2}]}"#,
            r#"{"phi":90,"views":[{"id":"front","phi":90,"theta":0}]}"#,
            r#"{"includeLabel":true,"views":[{"id":"front","phi":90,"theta":0}]}"#,
        ] {
            assert!(
                RenderImagesRequest::from_json(json)
                    .and_then(|request| request.resolve())
                    .is_err()
            );
        }
    }

    #[test]
    fn rejects_invalid_per_view_output_overrides_by_name() {
        let cases = [
            (
                r#"{"views":[{"id":"front","phi":90,"theta":0,"width":15}]}"#,
                "parse: views[0].width 15 outside 16..=4096",
            ),
            (
                r#"{"views":[{"id":"front","phi":90,"theta":0,"height":4097}]}"#,
                "parse: views[0].height 4097 outside 16..=4096",
            ),
            (
                r#"{"views":[{"id":"front","phi":90,"theta":0,"quality":1.5}]}"#,
                "parse: views[0].quality 1.5 outside 0..=1",
            ),
            (
                r#"{"views":[{"id":"front","phi":90,"theta":0,"format":"gif"}]}"#,
                "parse: views[0]: format \"gif\" not png/webp/jpeg/jpg",
            ),
            (
                r#"{"includeAxes":true,"views":[{"id":"front","phi":90,"theta":0,"width":191}]}"#,
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
                expected,
                "{json}"
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
        for up in ["x", "y", "z"] {
            let json = format!(
                r#"{{"format":"jpeg","quality":0.8,"width":192,"height":193,"margin":0.2,"up":"{up}","projection":"orthographic","background":[0,0.25,0.5,1],"label":"µ—−","includeLabel":true}}"#
            );
            let (options, format) = RenderRequest::from_json(&json)
                .expect("parse")
                .resolve()
                .expect("resolve");
            assert_eq!(options.width, 192);
            assert_eq!(options.height, 193);
            assert_eq!(options.projection, Projection::Orthographic);
            assert_eq!(format, ImageFormat::Jpeg { quality: 80 });
        }
    }

    fn lighting_of(json: &str) -> Result<ResolvedLighting, RenderError> {
        RenderRequest::from_json(json)
            .and_then(|request| request.resolve())
            .map(|(options, _)| options.lighting)
    }

    #[test]
    fn every_spelling_of_the_studio_preset_resolves_identically() {
        let studio = ResolvedLighting::studio();
        let explicit = r#"{"lighting":{"lights":[
            {"direction":[-0.45,0.61,0.63],"color":[2.09,2.09,2.09]},
            {"direction":[0.45,-0.61,-0.63],"color":[1.45,1.42,1.38]},
            {"direction":[0.03,0.74,0.67],"color":[0.68,0.66,0.62]}
        ],"ambient":0.02,"environment":"studio","space":"view","exposure":1}}"#;
        for json in ["{}", r#"{"lighting":"studio"}"#, explicit] {
            assert_eq!(lighting_of(json).expect("resolve"), studio, "{json}");
        }
        // The plural request carries the same field.
        let (options, _, _, _) = RenderImagesRequest::from_json(
            r#"{"lighting":"studio","views":[{"id":"front","phi":90,"theta":0}]}"#,
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

        // An empty array is an environment-only render, not an error, and the
        // unspecified fields still inherit the preset.
        let bare = lighting_of(r#"{"lighting":{"lights":[]}}"#).expect("resolve");
        assert!(bare.lights.is_empty());
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
        ] {
            let error = RenderRequest::from_json(json).unwrap_err().to_string();
            assert!(error.starts_with("parse: options: "), "{error}");
            assert!(error.contains(fragment), "{error}");
        }
    }

    #[test]
    fn rejects_non_finite_views_labels_and_common_values() {
        for (phi, theta) in [(f32::NAN, 0.0), (0.0, f32::INFINITY)] {
            let request = RenderImagesRequest {
                views: vec![RenderImageViewRequest {
                    id: "front".into(),
                    label: None,
                    phi,
                    theta,
                    width: None,
                    height: None,
                    format: None,
                    quality: None,
                }],
                ..Default::default()
            };
            assert!(request.resolve().is_err());
        }
        for label in ["", " ", &"x".repeat(65)] {
            assert!(validate_optional_label(Some(label), "label").is_err());
        }
        assert!(finite_or_default(Some(f32::NAN), 0.0, "angle").is_err());
        for request in [
            RenderRequest {
                margin: Some(f32::NAN),
                ..Default::default()
            },
            RenderRequest {
                quality: Some(f32::INFINITY),
                ..Default::default()
            },
            RenderRequest {
                background: Some([0.0, 0.0, f32::NAN, 1.0]),
                ..Default::default()
            },
        ] {
            assert!(request.resolve().is_err());
        }
    }
}
