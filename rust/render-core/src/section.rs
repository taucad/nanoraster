//! Deterministic CPU section caps. Geometry stays in world space; the GPU
//! clips the resulting cap triangles against the other active planes.

use crate::glb::{self, MODE_TRIANGLES};
use crate::{RenderError, RenderOptions, SectionPlane};
use glam::{Mat4, Vec3};
use i_triangle::i_overlay::core::fill_rule::FillRule;
use i_triangle::i_overlay::core::overlay::Overlay;
use i_triangle::i_overlay::core::overlay_rule::OverlayRule;
use i_triangle::i_overlay::i_float::int::point::IntPoint;
use i_triangle::i_overlay::i_shape::int::shape::{IntContour, IntShapes};
use i_triangle::int::triangulatable::IntTriangulatable;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const PRECISION: f64 = 100_000_000.0;
const SAFE_COORDINATE: i64 = 1_i64 << 61;
const CAP_VERTEX_FLOATS: usize = 17;

#[derive(Default)]
pub(crate) struct CapGeometry {
    /// position(3), plane uv(2), base rgba(4), stripe rgba(4), axis/spacing/width(4)
    pub(crate) vertices: Vec<f32>,
    pub(crate) indices: Vec<u32>,
    /// De-indexed world-space segment endpoint pairs for the fat-line path.
    pub(crate) boundaries: Vec<f32>,
}

#[derive(Clone, Copy)]
struct Basis {
    origin: Vec3,
    u: Vec3,
    v: Vec3,
}

struct SourceRegion {
    shapes: IntShapes<i64>,
    base: [f32; 4],
    stripe: [f32; 4],
}

type Point = (i64, i64);
type Segment = (Point, Point);

pub(crate) fn build(
    scene: &glb::Scene,
    options: &RenderOptions,
) -> Result<CapGeometry, RenderError> {
    let Some(sections) = &options.sections else {
        return Ok(CapGeometry::default());
    };
    if !options.surfaces || !sections.clip_surfaces {
        return Ok(CapGeometry::default());
    }

    let diagonal = scene
        .presented_bounds(options)
        .map(|(min, max)| (Vec3::from(max) - Vec3::from(min)).length())
        .unwrap_or(1.0)
        .max(f32::EPSILON);
    let spacing = nice_spacing(diagonal / 30.0);
    let mut geometry = CapGeometry::default();
    for (plane_index, plane) in sections.planes.iter().enumerate() {
        build_plane(scene, options, plane, plane_index, spacing, &mut geometry)?;
    }
    clip_boundaries(&mut geometry.boundaries, &sections.planes);
    Ok(geometry)
}

fn build_plane(
    scene: &glb::Scene,
    options: &RenderOptions,
    plane: &SectionPlane,
    plane_index: usize,
    spacing: f32,
    output: &mut CapGeometry,
) -> Result<(), RenderError> {
    let normal = Vec3::from(plane.normal).normalize();
    let basis = plane_basis(Vec3::from(plane.point), normal);
    let epsilon = scene
        .bounds
        .map(|(min, max)| (Vec3::from(max) - Vec3::from(min)).length() * 1.0e-6)
        .unwrap_or(1.0e-6)
        .max(1.0e-7);
    let mut sources = Vec::new();
    let mut open_boundaries = Vec::new();

    for instance in &scene.instances {
        let mesh = &scene.meshes[instance.mesh_index];
        for primitive in &mesh.primitives {
            if primitive.mode != MODE_TRIANGLES
                || !scene.primitive_is_eligible(instance, primitive, options)
            {
                continue;
            }
            let segments = triangle_segments(
                primitive,
                instance.model,
                basis,
                normal,
                epsilon,
                plane_index,
            )?;
            let (rings, open) = closed_rings(&segments);
            open_boundaries.extend(open);
            if rings.is_empty() {
                continue;
            }
            let mut overlay = Overlay::with_contours(&rings, &[]);
            let shapes = overlay.overlay(OverlayRule::Subject, FillRule::EvenOdd);
            if shapes.is_empty() {
                continue;
            }
            let (base, stripe) = material_colors(primitive.material.base_color);
            sources.push(SourceRegion {
                shapes,
                base,
                stripe,
            });
        }
    }

    if sources.is_empty() {
        append_segments(output, basis, &open_boundaries);
        return Ok(());
    }

    let mut overlap = IntShapes::new();
    for left in 0..sources.len() {
        for right in left + 1..sources.len() {
            let intersection = boolean(
                &sources[left].shapes,
                &sources[right].shapes,
                OverlayRule::Intersect,
            );
            overlap = boolean(&overlap, &intersection, OverlayRule::Union);
        }
    }

    for source in &sources {
        let normal_region = boolean(&source.shapes, &overlap, OverlayRule::Difference);
        let appended = append_region(
            output,
            basis,
            &normal_region,
            source.base,
            source.stripe,
            [std::f32::consts::FRAC_1_SQRT_2; 2],
            spacing,
        );
        appended?;
    }
    let appended = append_region(
        output,
        basis,
        &overlap,
        srgb_hex(0xb9_1c_1c),
        srgb_hex(0xfd_e0_47),
        [
            -std::f32::consts::FRAC_1_SQRT_2,
            std::f32::consts::FRAC_1_SQRT_2,
        ],
        spacing,
    );
    appended?;

    let mut all = IntShapes::new();
    for source in &sources {
        all = boolean(&all, &source.shapes, OverlayRule::Union);
    }
    for shape in &all {
        for contour in shape {
            append_contour(output, basis, contour);
        }
    }
    append_segments(output, basis, &open_boundaries);
    Ok(())
}

fn triangle_segments(
    primitive: &glb::Primitive,
    model: Mat4,
    basis: Basis,
    normal: Vec3,
    epsilon: f32,
    plane_index: usize,
) -> Result<Vec<Segment>, RenderError> {
    let mut segments = BTreeSet::new();
    for triangle in primitive.indices.chunks_exact(3) {
        let vertices: [Vec3; 3] = std::array::from_fn(|index| {
            let offset = triangle[index] as usize * 3;
            model.transform_point3(Vec3::from_slice(&primitive.positions[offset..offset + 3]))
        });
        let distances = vertices.map(|vertex| (vertex - basis.origin).dot(normal));
        if distances.iter().all(|distance| distance.abs() <= epsilon) {
            continue;
        }
        let mut points = Vec::with_capacity(2);
        for (left, right) in [(0, 1), (1, 2), (2, 0)] {
            let a = distances[left];
            let b = distances[right];
            if a.abs() <= epsilon {
                points.push(vertices[left]);
            }
            if (a < -epsilon && b > epsilon) || (a > epsilon && b < -epsilon) {
                points.push(vertices[left].lerp(vertices[right], a / (a - b)));
            }
        }
        points.dedup_by(|left, right| left.distance_squared(*right) <= epsilon * epsilon);
        if points.len() != 2 {
            continue;
        }
        let a = quantize(basis, points[0], plane_index)?;
        let b = quantize(basis, points[1], plane_index)?;
        if a != b {
            segments.insert(ordered_segment(a, b));
        }
    }
    Ok(segments.into_iter().collect())
}

fn closed_rings(segments: &[Segment]) -> (Vec<IntContour<i64>>, Vec<Segment>) {
    let mut adjacency = BTreeMap::<Point, BTreeSet<Point>>::new();
    for &(a, b) in segments {
        adjacency.entry(a).or_default().insert(b);
        adjacency.entry(b).or_default().insert(a);
    }
    let mut unseen = adjacency.keys().copied().collect::<BTreeSet<_>>();
    let mut rings = Vec::new();
    let mut open = Vec::new();
    while let Some(start) = unseen.pop_first() {
        let mut component = BTreeSet::from([start]);
        let mut queue = VecDeque::from([start]);
        while let Some(point) = queue.pop_front() {
            for &next in &adjacency[&point] {
                if component.insert(next) {
                    unseen.remove(&next);
                    queue.push_back(next);
                }
            }
        }
        if component.iter().any(|point| adjacency[point].len() != 2) {
            open.extend(
                segments
                    .iter()
                    .copied()
                    .filter(|(a, _)| component.contains(a)),
            );
            continue;
        }
        let mut ring = Vec::with_capacity(component.len());
        let mut previous = None;
        let mut current = start;
        loop {
            ring.push(IntPoint::new(current.0, current.1));
            let next = adjacency[&current]
                .iter()
                .copied()
                .find(|candidate| Some(*candidate) != previous)
                .expect("closed degree-two component");
            previous = Some(current);
            current = next;
            if current == start {
                break;
            }
        }
        if ring.len() >= 3 {
            rings.push(ring);
        }
    }
    (rings, open)
}

fn boolean(subject: &IntShapes<i64>, clip: &IntShapes<i64>, rule: OverlayRule) -> IntShapes<i64> {
    match rule {
        OverlayRule::Union if subject.is_empty() => return clip.clone(),
        OverlayRule::Union if clip.is_empty() => return subject.clone(),
        OverlayRule::Difference if clip.is_empty() => return subject.clone(),
        OverlayRule::Difference | OverlayRule::Intersect if subject.is_empty() => {
            return Vec::new();
        }
        OverlayRule::Intersect if clip.is_empty() => return Vec::new(),
        _ => {}
    }
    Overlay::with_shapes(subject, clip).overlay(rule, FillRule::EvenOdd)
}

fn append_region(
    output: &mut CapGeometry,
    basis: Basis,
    shapes: &IntShapes<i64>,
    base: [f32; 4],
    stripe: [f32; 4],
    axis: [f32; 2],
    spacing: f32,
) -> Result<(), RenderError> {
    if shapes.is_empty() {
        return Ok(());
    }
    let triangulation = shapes.triangulate().to_triangulation::<u32>();
    let offset = cap_vertex_offset(output.vertices.len() / CAP_VERTEX_FLOATS)?;
    for point in triangulation.points {
        let uv = [
            point.x as f32 / PRECISION as f32,
            point.y as f32 / PRECISION as f32,
        ];
        let world = basis.origin + basis.u * uv[0] + basis.v * uv[1];
        output.vertices.extend_from_slice(&world.to_array());
        output.vertices.extend_from_slice(&uv);
        output.vertices.extend_from_slice(&base);
        output.vertices.extend_from_slice(&stripe);
        output
            .vertices
            .extend_from_slice(&[axis[0], axis[1], spacing, spacing * 0.2]);
    }
    output.indices.extend(
        triangulation
            .indices
            .into_iter()
            .map(|index| offset + index),
    );
    Ok(())
}

fn cap_vertex_offset(vertex_count: usize) -> Result<u32, RenderError> {
    u32::try_from(vertex_count)
        .map_err(|_| RenderError::Parse("section cap vertex count exceeds u32".into()))
}

fn append_contour(output: &mut CapGeometry, basis: Basis, contour: &IntContour<i64>) {
    if contour.len() < 2 {
        return;
    }
    for index in 0..contour.len() {
        append_segment(
            output,
            basis,
            point(contour[index]),
            point(contour[(index + 1) % contour.len()]),
        );
    }
}

fn append_segments(output: &mut CapGeometry, basis: Basis, segments: &[Segment]) {
    for &(a, b) in segments {
        append_segment(output, basis, a, b);
    }
}

fn append_segment(output: &mut CapGeometry, basis: Basis, a: Point, b: Point) {
    for point in [a, b] {
        let world = basis.origin
            + basis.u * (point.0 as f32 / PRECISION as f32)
            + basis.v * (point.1 as f32 / PRECISION as f32);
        output.boundaries.extend_from_slice(&world.to_array());
    }
}

fn clip_boundaries(boundaries: &mut Vec<f32>, planes: &[SectionPlane]) {
    let mut clipped = Vec::with_capacity(boundaries.len());
    for segment in boundaries.chunks_exact(6) {
        let mut start = Vec3::from_slice(&segment[..3]);
        let mut end = Vec3::from_slice(&segment[3..]);
        let mut visible = true;
        for plane in planes {
            let origin = Vec3::from(plane.point);
            let normal = Vec3::from(plane.normal).normalize();
            let start_distance = (start - origin).dot(normal);
            let end_distance = (end - origin).dot(normal);
            if start_distance < 0.0 && end_distance < 0.0 {
                visible = false;
                break;
            }
            if start_distance < 0.0 {
                start = start.lerp(end, start_distance / (start_distance - end_distance));
            } else if end_distance < 0.0 {
                end = start.lerp(end, start_distance / (start_distance - end_distance));
            }
        }
        if visible {
            clipped.extend_from_slice(&start.to_array());
            clipped.extend_from_slice(&end.to_array());
        }
    }
    *boundaries = clipped;
}

fn point(value: IntPoint<i64>) -> Point {
    (value.x, value.y)
}

fn ordered_segment(a: Point, b: Point) -> Segment {
    if a <= b { (a, b) } else { (b, a) }
}

fn quantize(basis: Basis, world: Vec3, plane_index: usize) -> Result<Point, RenderError> {
    let relative = world - basis.origin;
    let coordinates = [relative.dot(basis.u), relative.dot(basis.v)];
    let mut result = [0_i64; 2];
    for (index, coordinate) in coordinates.into_iter().enumerate() {
        let scaled = f64::from(coordinate) * PRECISION;
        if !scaled.is_finite() || scaled.abs() >= SAFE_COORDINATE as f64 {
            return Err(RenderError::Parse(format!(
                "sections.planes[{plane_index}] cap coordinate exceeds fixed-precision range"
            )));
        }
        result[index] = scaled.round() as i64;
    }
    Ok((result[0], result[1]))
}

fn plane_basis(origin: Vec3, normal: Vec3) -> Basis {
    let helper = if normal.x.abs() <= normal.y.abs() && normal.x.abs() <= normal.z.abs() {
        Vec3::X
    } else if normal.y.abs() <= normal.z.abs() {
        Vec3::Y
    } else {
        Vec3::Z
    };
    let u = normal.cross(helper).normalize();
    Basis {
        origin,
        u,
        v: normal.cross(u).normalize(),
    }
}

fn nice_spacing(value: f32) -> f32 {
    let exponent = value.log10().floor();
    let power = 10.0_f32.powf(exponent);
    let mantissa = value / power;
    let nice = if mantissa < 2.0 {
        2.0
    } else if mantissa < 5.0 {
        5.0
    } else {
        10.0
    };
    (nice * power).max(1.0e-6)
}

fn material_colors(linear: [f32; 4]) -> ([f32; 4], [f32; 4]) {
    let bytes: [i32; 3] =
        std::array::from_fn(|index| (linear_to_srgb(linear[index]) * 255.0).round() as i32);
    let adjusted = |delta: i32| {
        let channels = bytes.map(|channel| ((channel + delta).clamp(0, 255) as f32) / 255.0);
        [
            srgb_to_linear(channels[0]),
            srgb_to_linear(channels[1]),
            srgb_to_linear(channels[2]),
            linear[3],
        ]
    };
    (adjusted(20), adjusted(-35))
}

fn srgb_hex(hex: u32) -> [f32; 4] {
    let channel = |shift| srgb_to_linear(((hex >> shift) & 0xff_u32) as f32 / 255.0);
    [channel(16), channel(8), channel(0), 1.0]
}

fn srgb_to_linear(channel: f32) -> f32 {
    if channel <= 0.040_45 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(channel: f32) -> f32 {
    let channel = channel.clamp(0.0, 1.0);
    if channel <= 0.003_130_8 {
        channel * 12.92
    } else {
        1.055 * channel.powf(1.0 / 2.4) - 0.055
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cube_scene(instance_count: usize) -> glb::Scene {
        let positions = vec![
            -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, 1.0,
            1.0, -1.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 1.0,
        ];
        let indices = vec![
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5,
            4, 3, 7, 6, 3, 6, 2,
        ];
        glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                primitives: vec![glb::Primitive {
                    source_index: 0,
                    mode: MODE_TRIANGLES,
                    normals: positions.clone(),
                    positions,
                    indices,
                    material: glb::Material {
                        base_color: [0.5, 0.5, 0.5, 1.0],
                        metallic: 0.0,
                        roughness: 1.0,
                    },
                }],
            }],
            instances: (0..instance_count)
                .map(|source_node_index| glb::MeshInstance {
                    source_node_index,
                    mesh_index: 0,
                    model: Mat4::IDENTITY,
                    normal_matrix: Mat4::IDENTITY,
                })
                .collect(),
            bounds: Some(([-1.0; 3], [1.0; 3])),
        }
    }

    fn section_options() -> RenderOptions {
        RenderOptions {
            sections: Some(crate::Sections {
                planes: vec![SectionPlane {
                    point: [0.0; 3],
                    normal: [1.0, 0.0, 0.0],
                }],
                clip_surfaces: true,
                clip_lines: true,
            }),
            ..RenderOptions::default()
        }
    }

    fn triangle_scene(positions: Vec<f32>, indices: Vec<u32>) -> glb::Scene {
        let mut scene = cube_scene(1);
        scene.meshes[0].primitives[0] = triangle_primitive(positions, indices);
        scene
    }

    fn triangle_primitive(positions: Vec<f32>, indices: Vec<u32>) -> glb::Primitive {
        glb::Primitive {
            source_index: 0,
            mode: MODE_TRIANGLES,
            normals: positions.clone(),
            positions,
            indices,
            material: glb::Material {
                base_color: [0.5, 0.5, 0.5, 1.0],
                metallic: 0.0,
                roughness: 1.0,
            },
        }
    }

    #[test]
    fn segments_form_closed_rings_but_branches_remain_outlines() {
        let square = vec![
            ((0, 0), (10, 0)),
            ((10, 0), (10, 10)),
            ((0, 10), (10, 10)),
            ((0, 0), (0, 10)),
        ];
        let (rings, open) = closed_rings(&square);
        assert_eq!(rings.len(), 1);
        assert!(open.is_empty());

        let mut branch = square;
        branch.push(((10, 10), (20, 10)));
        let (rings, open) = closed_rings(&branch);
        assert!(rings.is_empty());
        assert_eq!(open.len(), 5);
    }

    #[test]
    fn spacing_and_material_style_are_stable() {
        assert_eq!(nice_spacing(0.31), 0.5);
        assert_eq!(nice_spacing(6.0), 10.0);
        let (base, stripe) = material_colors([0.5, 0.5, 0.5, 1.0]);
        assert!(base[0] > 0.5);
        assert!(stripe[0] < 0.5);
    }

    #[test]
    fn a_closed_solid_builds_a_triangulated_cap_and_outline() {
        let geometry = build(&cube_scene(1), &section_options()).expect("cap");
        assert!(!geometry.indices.is_empty());
        assert_eq!(geometry.indices.len() % 3, 0);
        assert_eq!(geometry.vertices.len() % CAP_VERTEX_FLOATS, 0);
        assert_eq!(geometry.boundaries.len() / 6, 4);
    }

    #[test]
    fn coincident_sources_are_colored_as_one_overlap_region() {
        let geometry = build(&cube_scene(2), &section_options()).expect("overlap cap");
        let expected = srgb_hex(0xb9_1c_1c);
        for vertex in geometry.vertices.chunks_exact(CAP_VERTEX_FLOATS) {
            assert_eq!(&vertex[5..9], &expected);
        }
        assert_eq!(geometry.boundaries.len() / 6, 4);
    }

    #[test]
    fn open_degenerate_and_out_of_range_sections_are_deterministic() {
        let open = triangle_scene(
            vec![-1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            vec![0, 1, 2],
        );
        let geometry = build(&open, &section_options()).expect("open section");
        assert!(geometry.indices.is_empty());
        assert_eq!(geometry.boundaries.len(), 6);

        let collinear = triangle_scene(
            vec![
                0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.5, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 1.0,
                1.5, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0,
            ],
            vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
        );
        assert!(
            build(&collinear, &section_options())
                .expect("degenerate section")
                .indices
                .is_empty()
        );

        let basis = plane_basis(Vec3::ZERO, Vec3::X);
        let coplanar = triangle_primitive(
            vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2],
        );
        assert!(
            triangle_segments(&coplanar, Mat4::IDENTITY, basis, Vec3::X, 1.0e-6, 0)
                .expect("coplanar")
                .is_empty()
        );
        let on_plane_vertex = triangle_primitive(
            vec![0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, -1.0, 0.0],
            vec![0, 1, 2],
        );
        assert!(
            triangle_segments(&on_plane_vertex, Mat4::IDENTITY, basis, Vec3::X, 1.0e-6, 0)
                .expect("vertex on plane")
                .is_empty()
        );

        let huge = triangle_scene(
            vec![-1.0, 1.0e20, 0.0, 1.0, 1.0e20, 0.0, 1.0, 2.0e20, 0.0],
            vec![0, 1, 2],
        );
        let mut output = CapGeometry::default();
        assert!(
            build_plane(
                &huge,
                &section_options(),
                &SectionPlane {
                    point: [0.0; 3],
                    normal: [1.0, 0.0, 0.0]
                },
                0,
                1.0,
                &mut output,
            )
            .is_err()
        );

        let square = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(1, 0),
            IntPoint::new(1, 1),
            IntPoint::new(0, 1),
        ]]];
        assert!(boolean(&IntShapes::new(), &square, OverlayRule::Difference).is_empty());
        append_contour(&mut output, basis, &vec![IntPoint::new(0, 0)]);
        assert!(
            plane_basis(Vec3::ZERO, Vec3::new(1.0, 1.0, 0.0).normalize())
                .u
                .y
                < 0.0
        );
        assert_eq!(srgb_to_linear(0.0), 0.0);
        assert_eq!(linear_to_srgb(0.0), 0.0);
        assert_eq!(cap_vertex_offset(0).expect("zero offset"), 0);
        assert!(cap_vertex_offset(usize::MAX).is_err());
    }
}
