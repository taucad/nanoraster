//! Codec benchmark surface for the spike harnesses: times each encoder over
//! one rendered frame and fingerprints outputs (FNV-1a 64) so the
//! byte-identity invariant can be checked across artifacts without shipping
//! images around.

use crate::{
    CameraProjection, ImageFormat, RenderCamera, RenderError, RenderOptions, RenderView, Rendered,
    SectionPlane, Sections, encode, render_image, render_images_timed,
};

fn fit_camera(direction: [f32; 3], up: [f32; 3]) -> RenderCamera {
    RenderCamera::Fit {
        direction,
        up,
        padding_factor: 0.9,
        projection: CameraProjection::Perspective {
            vertical_field_of_view_deg: 45.0,
            zoom: 1.0,
        },
    }
}

/// FNV-1a 64 — enough to compare artifacts for equality across legs.
pub fn fnv64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Every codec path the package can take, including the lossy WebP one — the
/// newest and the only forked encoder, and therefore the one a fingerprint
/// table is most worth having.
const CONFORMANCE_CODECS: [(&str, ImageFormat); 4] = [
    ("png", ImageFormat::Png),
    ("webp", ImageFormat::WebP { quality: 100 }),
    ("webpLossy", ImageFormat::WebP { quality: 90 }),
    ("jpeg", ImageFormat::Jpeg { quality: 85 }),
];

fn codec_fingerprints(rendered: &Rendered) -> Result<serde_json::Value, RenderError> {
    let mut report = serde_json::json!({
        "pixelFnv": format!("{:016x}", fnv64(&rendered.rgba)),
    });
    for (name, format) in CONFORMANCE_CODECS {
        let bytes = encode(rendered, format)?;
        report[name] = serde_json::json!({
            "bytes": bytes.len(),
            "fnv": format!("{:016x}", fnv64(&bytes)),
        });
    }
    Ok(report)
}

fn ensure_batch_matches(batch: &[Vec<u8>], singular: &[Vec<u8>]) -> Result<(), RenderError> {
    if batch == singular {
        return Ok(());
    }
    Err(RenderError::Encode(
        "batch benchmark outputs differ from singular bytes".into(),
    ))
}

/// The GPU-free frame both codec fixtures below run on: an analytic gradient
/// with a high-frequency term, so every encoder does real work on it.
fn fixture_frame(width: u32, height: u32) -> Rendered {
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            rgba.extend_from_slice(&[
                ((x * 17 + y * 31) & 255) as u8,
                ((x * 7 + y * 43 + (x ^ y)) & 255) as u8,
                ((x * 53 + y * 11) & 255) as u8,
                255,
            ]);
        }
    }
    Rendered {
        rgba,
        width,
        height,
    }
}

/// Codec timings without an adapter: the encode stages are pure CPU work over
/// a frame, so the wasm speed gate (`scripts/check-wasm-speed.mjs`) times them
/// on a procedural one rather than standing up WebGPU to produce a frame it
/// would throw away. Same [`bench_encodes`] the browser benchmark reports.
pub fn bench_fixture_encodes(
    width: u32,
    height: u32,
    now: &dyn Fn() -> f64,
) -> Result<serde_json::Value, RenderError> {
    bench_encodes(&fixture_frame(width, height), now)
}

/// GPU-independent codec fixtures used to prove native/wasm byte parity.
pub fn codec_conformance() -> Result<serde_json::Value, RenderError> {
    let (width, height) = (320u32, 240u32);
    let base = fixture_frame(width, height);
    // Keep codec fingerprints independent of fitted-camera changes: a centred
    // horizontal line preserves the established centre-plane scale without
    // intersecting any annotation slot.
    let horizontal_tangent = 22.5_f32.to_radians().tan() * 0.9 * width as f32 / height as f32;
    let extent = 4.944_608_7 * horizontal_tangent;
    let axis = std::f32::consts::FRAC_1_SQRT_2 * extent;
    let scene = crate::glb::Scene {
        meshes: vec![crate::glb::MeshAsset {
            source_index: 0,
            manifold: None,
            primitives: vec![crate::glb::Primitive {
                source_index: 0,
                mode: crate::glb::MODE_LINES,
                positions: vec![-axis, 0.0, axis, axis, 0.0, -axis],
                normals: Vec::new(),
                indices: vec![0, 1],
                material: crate::glb::Material {
                    base_color: [0.0, 0.0, 0.0, 1.0],
                    metallic: 0.0,
                    roughness: 1.0,
                },
            }],
        }],
        instances: vec![crate::glb::MeshInstance {
            source_node_index: 0,
            mesh_index: 0,
            model: glam::Mat4::IDENTITY,
            normal_matrix: glam::Mat4::IDENTITY,
        }],
        topology_diagnostics: Vec::new(),
        bounds: None,
    };
    let mut report = serde_json::json!({
        "width": width,
        "height": height,
        "base": codec_fingerprints(&base)?,
    });
    for bits in 1..8 {
        let options = RenderOptions {
            width,
            height,
            label: (bits & 2 != 0).then(|| "View".to_owned()),
            axes: bits & 1 != 0,
            scale_bar: bits & 4 != 0,
            ..Default::default()
        };
        let prepared = crate::capture_overlay::prepare_view(&scene, &options)?;
        let mut rendered = Rendered {
            rgba: base.rgba.clone(),
            width,
            height,
        };
        crate::capture_overlay::stamp_capture_overlay(&mut rendered, &prepared, &mut Vec::new());
        report[format!("include{bits}")] = codec_fingerprints(&rendered)?;
    }
    Ok(report)
}

/// The section leg of the multi-view benchmark, if this model can carry one.
///
/// Cap build is a shared batch stage worth timing, so the benchmark cuts the
/// model when it can. Certification is fail-closed, though, and plenty of
/// exported meshes are not watertight — the gear fixture's flat cap faces
/// leave 72 unfilled sliver loops, so it is one of them. A benchmark that
/// hard-failed on those would be unusable on most real models, so an
/// uncertified model runs its remaining stages and reports the reason instead.
fn certified_sections(glb: &[u8], requested: Sections) -> (Option<Sections>, Option<String>) {
    // The same certification `prepare_presentation` runs, minus the GPU.
    let options = RenderOptions {
        sections: Some(requested.clone()),
        ..Default::default()
    };
    match crate::glb::parse_glb_for_sections(glb)
        .map_err(RenderError::Parse)
        .and_then(|scene| crate::section::build(&scene, &options))
    {
        Ok(_) => (Some(requested), None),
        Err(error) => (None, Some(error.to_string())),
    }
}

/// Compare six separate renders with one six-view batch for every annotation
/// combination, cutting the model with one section plane where it certifies.
pub async fn bench_multi_view(
    glb: &[u8],
    width: u32,
    height: u32,
    now: &crate::TimingsClock,
) -> Result<serde_json::Value, RenderError> {
    let view = |id: &str, label: &str, direction: [f32; 3], up: [f32; 3]| RenderView {
        id: id.into(),
        label: Some(label.into()),
        camera: fit_camera(direction, up),
        width: None,
        height: None,
        format: None,
    };
    let views = [
        view("front", "Front", [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
        view("back", "Back", [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]),
        view("right", "Right", [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        view("left", "Left", [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        view("top", "Top", [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
        view("bottom", "Bottom", [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]),
    ];
    let (sections, sections_skipped) = certified_sections(
        glb,
        Sections {
            planes: vec![SectionPlane {
                point: [0.0; 3],
                normal: [1.0, 0.0, 0.0],
            }],
            clip_surfaces: true,
            clip_lines: true,
        },
    );
    let mut variants = Vec::new();
    for bits in 0..8 {
        let axes = bits & 1 != 0;
        let labeled = bits & 2 != 0;
        let scale_bar = bits & 4 != 0;
        let options = RenderOptions {
            width,
            height,
            background: Some([1.0, 1.0, 1.0, 1.0]),
            axes,
            scale_bar,
            sections: sections.clone(),
            ..Default::default()
        };
        // A label is drawn where one is set, so the label leg strips them
        // rather than flipping a flag.
        let views: Vec<RenderView> = views
            .iter()
            .map(|view| RenderView {
                label: labeled.then(|| view.label.clone()).flatten(),
                ..view.clone()
            })
            .collect();
        let singular_started = now();
        let mut singular = Vec::with_capacity(views.len());
        let mut view_durations = Vec::with_capacity(views.len());
        for view in &views {
            let mut view_options = options.clone();
            view_options.camera.clone_from(&view.camera);
            view_options.label.clone_from(&view.label);
            let started = now();
            let bytes =
                render_image(glb, &view_options, ImageFormat::WebP { quality: 100 }).await?;
            view_durations.push(now() - started);
            singular.push(bytes);
        }
        let singular_wall = now() - singular_started;

        let batch_started = now();
        let (batch, timings) = render_images_timed(
            glb,
            &options,
            ImageFormat::WebP { quality: 100 },
            &views,
            now,
        )
        .await?;
        let batch_wall = now() - batch_started;
        ensure_batch_matches(&batch, &singular)?;
        let fingerprints: Vec<String> = batch
            .iter()
            .map(|bytes| format!("{:016x}", fnv64(bytes)))
            .collect();
        variants.push(serde_json::json!({
            "axes": axes,
            "label": labeled,
            "scaleBar": scale_bar,
            "singular": {
                "wall": singular_wall,
                "view": view_durations,
                "glbParses": views.len(),
                "renderSessions": views.len(),
            },
            "batch": {
                "wall": batch_wall,
                "timings": timings,
            },
            "fingerprints": fingerprints,
        }));
    }
    Ok(serde_json::json!({
        "width": width,
        "height": height,
        "viewCount": views.len(),
        "sectionsSkipped": sections_skipped,
        "variants": variants,
    }))
}

/// Time PNG / WebP / JPEG(q85) encodes of `rendered`, repeating each until
/// 250 ms or 20 reps have elapsed and averaging. `now` supplies milliseconds
/// (`Instant` on native, `Date.now` in wasm — `std::time::Instant` panics on
/// wasm32-unknown-unknown).
pub fn bench_encodes(
    rendered: &Rendered,
    now: &dyn Fn() -> f64,
) -> Result<serde_json::Value, RenderError> {
    let mut report = serde_json::json!({
        "width": rendered.width,
        "height": rendered.height,
        "pixelFnv": format!("{:016x}", fnv64(&rendered.rgba)),
    });
    for (name, format) in [
        ("png", ImageFormat::Png),
        ("webp", ImageFormat::WebP { quality: 100 }),
        ("jpeg", ImageFormat::Jpeg { quality: 85 }),
    ] {
        let start = now();
        let bytes = encode(rendered, format)?;
        let mut reps = 1u32;
        while now() - start < 250.0 && reps < 20 {
            encode(rendered, format)?;
            reps += 1;
        }
        let ms = (now() - start) / f64::from(reps);
        report[name] = serde_json::json!({
            "ms": (ms * 100.0).round() / 100.0,
            "bytes": bytes.len(),
            "fnv": format!("{:016x}", fnv64(&bytes)),
        });
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn benches_all_codecs_deterministically() {
        let (width, height) = (4u32, 4u32);
        let mut rgba = Vec::new();
        for y in 0..height {
            for x in 0..width {
                rgba.extend_from_slice(&[(x * 60) as u8, (y * 60) as u8, 128, 255]);
            }
        }
        let rendered = Rendered {
            rgba,
            width,
            height,
        };
        let clock = std::cell::Cell::new(0.0f64);
        let now = move || {
            clock.set(clock.get() + 100.0);
            clock.get()
        };
        let report = bench_encodes(&rendered, &now).expect("bench");
        assert_eq!(report["width"], serde_json::json!(4));
        for name in ["png", "webp", "jpeg"] {
            assert!(report[name]["ms"].as_f64().expect("ms") > 0.0);
            assert!(report[name]["bytes"].as_u64().expect("bytes") > 0);
            // Mirror the bench's own quality per codec: webp runs lossless.
            let quality = if name == "webp" { 100 } else { 85 };
            let format = ImageFormat::from_name(name, quality).expect("format");
            let expected = format!(
                "{:016x}",
                fnv64(&encode(&rendered, format).expect("encode"))
            );
            assert_eq!(report[name]["fnv"], serde_json::json!(expected));
        }
    }

    #[test]
    fn fixed_codec_fixtures_are_deterministic() {
        // The speed gate's probe shares this frame; it only has to report a
        // duration per codec, which the mocked clock above already covers.
        let clock = std::cell::Cell::new(0.0f64);
        let now = move || {
            clock.set(clock.get() + 100.0);
            clock.get()
        };
        let timed = bench_fixture_encodes(64, 48, &now).expect("fixture encodes");
        assert_eq!(timed["width"], serde_json::json!(64));
        assert!(timed["jpeg"]["ms"].as_f64().expect("ms") > 0.0);

        let first = codec_conformance().expect("conformance");
        let second = codec_conformance().expect("conformance");
        assert_eq!(first, second);
        assert_ne!(first["base"]["pixelFnv"], first["include1"]["pixelFnv"]);
        for fixture in [
            "base", "include1", "include2", "include3", "include4", "include5", "include6",
            "include7",
        ] {
            for (codec, _) in CONFORMANCE_CODECS {
                assert_eq!(
                    first[fixture][codec]["fnv"].as_str().map(str::len),
                    Some(16)
                );
            }
        }
    }

    /// Half of the native↔wasm byte-identity gate: the browser suite asserts
    /// the wasm build against this same table, so a codec that drifts on
    /// either artifact fails CI instead of being asserted in a comment.
    ///
    /// Regenerate deliberately, never to make a red build green:
    /// `pnpm run build:napi:bench && node scripts/record-codec-conformance.mjs`
    #[test]
    fn codec_fixtures_match_the_committed_fingerprints() {
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/codec-conformance.json"))
                .expect("committed fingerprints");
        assert_eq!(codec_conformance().expect("conformance"), expected);
    }

    /// The benchmark's section leg follows certification, which is fail-closed:
    /// a watertight model keeps the plane, and the gear fixture — whose flat
    /// cap faces leave unfilled sliver loops — records why it lost it instead
    /// of failing the whole run.
    #[test]
    fn the_section_leg_follows_certification() {
        let requested = Sections {
            planes: vec![SectionPlane {
                point: [0.0; 3],
                normal: [1.0, 0.0, 0.0],
            }],
            clip_surfaces: true,
            clip_lines: true,
        };
        let (certified, skipped) = certified_sections(
            include_bytes!("../../../tests/fixtures/racing-drone-section-repro.glb"),
            requested.clone(),
        );
        assert_eq!(certified, Some(requested.clone()));
        assert_eq!(skipped, None);

        let (certified, skipped) = certified_sections(
            include_bytes!("../../../tests/fixtures/gear-12.glb"),
            requested,
        );
        assert_eq!(certified, None);
        assert_eq!(
            skipped.as_deref(),
            Some(
                "parse: sections: topology: source node 0/mesh 0/primitive 0 has an open material seam"
            )
        );
    }

    #[test]
    fn batch_benchmark_rejects_divergent_bytes() {
        assert!(ensure_batch_matches(&[vec![1]], &[vec![1]]).is_ok());
        assert_eq!(
            ensure_batch_matches(&[vec![1]], &[vec![2]])
                .unwrap_err()
                .to_string(),
            "encode: batch benchmark outputs differ from singular bytes"
        );
    }
}
