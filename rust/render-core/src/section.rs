//! Deterministic CPU section caps. Geometry stays in world space; the GPU
//! clips the resulting cap triangles against the other active planes.

use crate::glb::{self, MODE_TRIANGLES};
use crate::render::CameraState;
use crate::{PrimitiveRef, Projection, RenderError, RenderOptions, SectionPlane};
#[cfg(test)]
use glam::Mat4;
use glam::Vec3;
use i_triangle::i_overlay::core::fill_rule::FillRule;
use i_triangle::i_overlay::core::overlay::Overlay;
use i_triangle::i_overlay::core::overlay_rule::OverlayRule;
use i_triangle::i_overlay::i_float::int::point::IntPoint;
use i_triangle::i_overlay::i_shape::int::shape::{IntContour, IntShapes};
use i_triangle::int::triangulatable::IntTriangulatable;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const PRECISION: f64 = 100_000_000.0;
const SAFE_COORDINATE: i64 = 1_i64 << 61;
const CAP_VERTEX_FLOATS: usize = 17;

#[derive(Debug, Default)]
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
    owner: usize,
    shapes: IntShapes<i64>,
    base: [f32; 4],
    stripe: [f32; 4],
}

type Point = (i64, i64);
type Segment = (Point, Point);
type SegmentContributions = Vec<(Segment, Vec<SegmentContribution>)>;
type GroupSlice = (SegmentContributions, Vec<IntContour<i64>>, [f32; 4]);

#[derive(Clone, Copy)]
struct HalfEdge {
    triangle: usize,
    slot: usize,
    start: usize,
    end: usize,
    source: PrimitiveRef,
}

#[derive(Clone)]
struct Triangle {
    vertices: [usize; 3],
    points: [Vec3; 3],
    edges: [usize; 3],
    source: PrimitiveRef,
    base_color: [f32; 4],
}

#[derive(Clone, Copy)]
struct CanonicalEdge {
    start: Vec3,
    end: Vec3,
    triangles: [usize; 2],
    source: PrimitiveRef,
}

struct SurfaceGroup {
    owner: usize,
    edges: Vec<CanonicalEdge>,
    triangles: Vec<Triangle>,
}

struct SectionTopology {
    groups: Vec<SurfaceGroup>,
}

#[derive(Clone, Copy)]
struct PendingEdge {
    first: usize,
    second: usize,
}

struct DisjointSet {
    parents: Vec<usize>,
}

impl DisjointSet {
    fn new(size: usize) -> Self {
        Self {
            parents: (0..size).collect(),
        }
    }

    fn find(&mut self, value: usize) -> usize {
        let parent = self.parents[value];
        if parent != value {
            self.parents[value] = self.find(parent);
        }
        self.parents[value]
    }

    fn union(&mut self, left: usize, right: usize) {
        let left = self.find(left);
        let right = self.find(right);
        if left == right {
            return;
        }
        let (first, second) = if left < right {
            (left, right)
        } else {
            (right, left)
        };
        self.parents[second] = first;
    }
}

#[derive(Clone, Copy)]
struct SegmentContribution {
    source: PrimitiveRef,
    base_color: [f32; 4],
    true_cut: bool,
    length: f64,
}

#[derive(Debug)]
enum EdgeHit {
    None,
    Point(Point),
    Coplanar(Point, Point),
}

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

    let epsilon = scene
        .bounds
        .map(|(min, max)| (Vec3::from(max) - Vec3::from(min)).length() * 1.0e-6)
        .unwrap_or(1.0e-6)
        .max(1.0e-7);
    let topology = build_topology(scene, options, epsilon)?;
    let mut geometry = CapGeometry::default();
    for (plane_index, plane) in sections.planes.iter().enumerate() {
        build_plane(&topology, plane, plane_index, epsilon, &mut geometry)?;
    }
    clip_boundaries(&mut geometry.boundaries, &sections.planes);
    Ok(geometry)
}

fn build_topology(
    scene: &glb::Scene,
    options: &RenderOptions,
    epsilon: f32,
) -> Result<SectionTopology, RenderError> {
    let mut groups = Vec::new();
    let mut next_owner = 0;
    for instance in &scene.instances {
        let mesh = &scene.meshes[instance.mesh_index];
        let mut vertex_count = 0;
        let primitive_bases = mesh
            .primitives
            .iter()
            .map(|primitive| {
                let base = vertex_count;
                vertex_count += primitive.positions.len() / 3;
                base
            })
            .collect::<Vec<_>>();
        let mut positions = vec![Vec3::ZERO; vertex_count];
        let mut triangles = Vec::new();
        let mut half_edges = Vec::new();
        let mut first_degenerate = None;

        for (primitive_slot, primitive) in mesh.primitives.iter().enumerate() {
            if primitive.mode != MODE_TRIANGLES
                || !scene.primitive_is_eligible(instance, primitive, options)
            {
                continue;
            }
            let source = scene.primitive_ref(instance, primitive);
            if !primitive.indices.len().is_multiple_of(3) {
                return Err(topology_error(
                    source,
                    "has an incomplete triangle index list",
                ));
            }
            for indices in primitive.indices.as_chunks::<3>().0 {
                let vertices =
                    indices.map(|vertex| primitive_bases[primitive_slot] + vertex as usize);
                if vertices[0] == vertices[1]
                    || vertices[1] == vertices[2]
                    || vertices[2] == vertices[0]
                {
                    return Err(topology_error(source, "contains a collapsed triangle"));
                }
                let mut world = [Vec3::ZERO; 3];
                for index in 0..3 {
                    let offset = indices[index] as usize * 3;
                    let Some(position) = primitive.positions.get(offset..offset + 3) else {
                        return Err(topology_error(source, "references a missing vertex"));
                    };
                    world[index] = instance.model.transform_point3(Vec3::from_slice(position));
                    if !world[index].is_finite() {
                        return Err(topology_error(source, "contains a non-finite vertex"));
                    }
                    positions[vertices[index]] = world[index];
                }
                if (world[1] - world[0])
                    .cross(world[2] - world[0])
                    .length_squared()
                    <= epsilon.powi(4)
                {
                    first_degenerate.get_or_insert(source);
                    continue;
                }
                let triangle = triangles.len();
                triangles.push(Triangle {
                    vertices,
                    points: world,
                    edges: [usize::MAX; 3],
                    source,
                    base_color: primitive.material.base_color,
                });
                for (slot, (start, end)) in [(0, 1), (1, 2), (2, 0)].into_iter().enumerate() {
                    half_edges.push(HalfEdge {
                        triangle,
                        slot,
                        start: vertices[start],
                        end: vertices[end],
                        source,
                    });
                }
            }
        }
        if triangles.is_empty() {
            if let Some(source) = first_degenerate {
                return Err(topology_error(source, "contains a degenerate triangle"));
            }
            continue;
        }

        let mut indexed = (0..half_edges.len()).collect::<Vec<_>>();
        indexed.sort_by_key(|edge| half_edge_key(half_edges[*edge]));
        let mut pairs = Vec::new();
        let mut unmatched = Vec::new();
        for edges in indexed.chunk_by(|left, right| {
            half_edge_key(half_edges[*left]) == half_edge_key(half_edges[*right])
        }) {
            let first = edges[0];
            if edges.len() == 1 {
                unmatched.push(first);
            } else if edges.len() == 2
                && half_edges[first].start == half_edges[edges[1]].end
                && half_edges[first].end == half_edges[edges[1]].start
            {
                pairs.push(PendingEdge {
                    first,
                    second: edges[1],
                });
            } else {
                return Err(topology_error(
                    half_edges[first].source,
                    "has a non-manifold or inconsistently oriented indexed edge",
                ));
            }
        }

        let mut seam_vertices = unmatched
            .iter()
            .flat_map(|edge| [half_edges[*edge].start, half_edges[*edge].end])
            .collect::<Vec<_>>();
        seam_vertices.sort_unstable();
        seam_vertices.dedup();
        let maximum_coordinate = positions
            .iter()
            .map(|position| position.abs().max_element())
            .fold(0.0_f32, f32::max)
            .max(f32::MIN_POSITIVE);
        let match_radius = (maximum_coordinate * f32::EPSILON * 4.0)
            .max(2.0 / PRECISION as f32)
            .min(epsilon);
        let clusters = spatial_clusters(&seam_vertices, &positions, match_radius);
        unmatched.sort_by_key(|edge| cluster_edge_key(half_edges[*edge], &clusters));
        let mut seams = Vec::new();
        for edges in unmatched.chunk_by(|left, right| {
            cluster_edge_key(half_edges[*left], &clusters)
                == cluster_edge_key(half_edges[*right], &clusters)
        }) {
            let key = cluster_edge_key(half_edges[edges[0]], &clusters);
            let start = clusters[half_edges[edges[0]].start];
            let end = clusters[half_edges[edges[0]].end];
            if start == end {
                return Err(topology_error(
                    half_edges[edges[0]].source,
                    "has a seam edge collapsed by topology tolerance",
                ));
            }
            seams.push((key, edges.to_vec()));
        }

        let mut patch_sets = DisjointSet::new(triangles.len());
        for pair in &pairs {
            patch_sets.union(
                half_edges[pair.first].triangle,
                half_edges[pair.second].triangle,
            );
        }
        let patches = (0..triangles.len())
            .map(|triangle| patch_sets.find(triangle))
            .collect::<Vec<_>>();
        let mut affinity_samples = Vec::new();
        for (key, edges) in &seams {
            let (forward, reverse) = split_directions(edges, *key, &half_edges, &clusters);
            for first in &forward {
                for second in &reverse {
                    affinity_samples.push(ordered_pair(
                        patches[half_edges[*first].triangle],
                        patches[half_edges[*second].triangle],
                    ));
                }
            }
        }
        affinity_samples.sort_unstable();
        let mut affinities = Vec::new();
        for samples in affinity_samples.chunk_by(|left, right| left == right) {
            affinities.push((samples[0], samples.len()));
        }

        for (key, edges) in &seams {
            if edges.len() == 1 {
                return Err(topology_error(
                    half_edges[edges[0]].source,
                    "has an open material seam",
                ));
            }
            let (forward, reverse) = split_directions(edges, *key, &half_edges, &clusters);
            if forward.len() != reverse.len() || forward.is_empty() {
                return Err(topology_error(
                    half_edges[edges[0]].source,
                    "has an inconsistently oriented material seam",
                ));
            }
            let resolved = if forward.len() == 1 {
                vec![(forward[0], reverse[0])]
            } else {
                uniquely_pair_seams(&forward, &reverse, &half_edges, &patches, &affinities)
                    .ok_or_else(|| {
                        topology_error(
                            half_edges[edges[0]].source,
                            "has an ambiguous material seam",
                        )
                    })?
            };
            for (first, second) in resolved {
                pairs.push(PendingEdge { first, second });
            }
        }

        let representative_positions = cluster_positions(&seam_vertices, &positions, &clusters);
        for triangle in &mut triangles {
            triangle.points = triangle
                .vertices
                .map(|vertex| representative_positions[vertex]);
        }
        validate_vertex_links(&triangles, &half_edges, &pairs, positions.len())?;
        let mut edges = Vec::with_capacity(pairs.len());
        for pair in &pairs {
            let first = half_edges[pair.first];
            let second = half_edges[pair.second];
            let edge_index = edges.len();
            triangles[first.triangle].edges[first.slot] = edge_index;
            triangles[second.triangle].edges[second.slot] = edge_index;
            edges.push(CanonicalEdge {
                start: representative_positions[first.start],
                end: representative_positions[first.end],
                triangles: [first.triangle, second.triangle],
                source: minimum_source(first.source, second.source),
            });
        }
        debug_assert!(
            triangles
                .iter()
                .all(|triangle| !triangle.edges.contains(&usize::MAX)),
            "validated topology pairs every surface edge"
        );

        let mut surface_sets = DisjointSet::new(triangles.len());
        for pair in &pairs {
            surface_sets.union(
                half_edges[pair.first].triangle,
                half_edges[pair.second].triangle,
            );
        }
        let mut by_surface = vec![Vec::new(); triangles.len()];
        for index in 0..triangles.len() {
            by_surface[surface_sets.find(index)].push(index);
        }
        let components = by_surface
            .into_iter()
            .filter(|component| !component.is_empty())
            .collect::<Vec<_>>();
        let stats = components
            .iter()
            .map(|component| component_stats(component, &triangles))
            .collect::<Vec<_>>();
        let mut order = (0..components.len()).collect::<Vec<_>>();
        order.sort_by(|left, right| {
            stats[*right]
                .2
                .total_cmp(&stats[*left].2)
                .then(left.cmp(right))
        });
        let mut component_owners = vec![usize::MAX; components.len()];
        for &component in &order {
            let container = order
                .iter()
                .copied()
                .filter(|candidate| {
                    component_owners[*candidate] != usize::MAX
                        && stats[*candidate].3 * stats[component].3 < 0.0
                        && contains_bounds(
                            stats[*candidate].0,
                            stats[*candidate].1,
                            stats[component].0,
                            stats[component].1,
                            epsilon,
                        )
                })
                .min_by(|left, right| stats[*left].2.total_cmp(&stats[*right].2));
            component_owners[component] = container.map_or_else(
                || {
                    let owner = next_owner;
                    next_owner += 1;
                    owner
                },
                |container| component_owners[container],
            );
        }
        for (component, triangle_indices) in components.into_iter().enumerate() {
            let mut local_triangles = vec![usize::MAX; triangles.len()];
            for (local, global) in triangle_indices.iter().copied().enumerate() {
                local_triangles[global] = local;
            }
            let mut used_edges = triangle_indices
                .iter()
                .flat_map(|index| triangles[*index].edges)
                .collect::<Vec<_>>();
            used_edges.sort_unstable();
            used_edges.dedup();
            let group_triangles = triangle_indices
                .into_iter()
                .map(|index| {
                    let mut triangle = triangles[index].clone();
                    triangle.edges = triangle
                        .edges
                        .map(|edge| used_edges.binary_search(&edge).expect("used edge"));
                    triangle
                })
                .collect::<Vec<_>>();
            groups.push(SurfaceGroup {
                owner: component_owners[component],
                edges: used_edges
                    .into_iter()
                    .map(|edge| {
                        let mut edge = edges[edge];
                        edge.triangles = edge.triangles.map(|triangle| {
                            let local = local_triangles[triangle];
                            debug_assert_ne!(local, usize::MAX);
                            local
                        });
                        edge
                    })
                    .collect(),
                triangles: group_triangles,
            });
        }
    }
    Ok(SectionTopology { groups })
}

fn component_stats(component: &[usize], triangles: &[Triangle]) -> (Vec3, Vec3, f32, f64) {
    let mut minimum = Vec3::splat(f32::INFINITY);
    let mut maximum = Vec3::splat(f32::NEG_INFINITY);
    for triangle in component.iter().map(|index| &triangles[*index]) {
        for point in triangle.points {
            minimum = minimum.min(point);
            maximum = maximum.max(point);
        }
    }
    let origin = (minimum + maximum) * 0.5;
    let volume = component
        .iter()
        .map(|index| triangles[*index].points.map(|point| point - origin))
        .map(|points| {
            let [a, b, c] = points.map(|point| point.as_dvec3());
            a.dot(b.cross(c)) / 6.0
        })
        .sum();
    (minimum, maximum, (maximum - minimum).length(), volume)
}

fn contains_bounds(
    outer_minimum: Vec3,
    outer_maximum: Vec3,
    inner_minimum: Vec3,
    inner_maximum: Vec3,
    epsilon: f32,
) -> bool {
    outer_minimum
        .cmple(inner_minimum + Vec3::splat(epsilon))
        .all()
        && outer_maximum
            .cmpge(inner_maximum - Vec3::splat(epsilon))
            .all()
        && ((outer_minimum - inner_minimum).abs().max_element() > epsilon
            || (outer_maximum - inner_maximum).abs().max_element() > epsilon)
}

fn split_directions(
    edges: &[usize],
    key: (usize, usize),
    half_edges: &[HalfEdge],
    clusters: &[usize],
) -> (Vec<usize>, Vec<usize>) {
    edges.iter().copied().partition(|edge| {
        let edge = half_edges[*edge];
        clusters[edge.start] == key.0 && clusters[edge.end] == key.1
    })
}

fn ordered_pair(left: usize, right: usize) -> (usize, usize) {
    if left <= right {
        (left, right)
    } else {
        (right, left)
    }
}

fn uniquely_pair_seams(
    forward: &[usize],
    reverse: &[usize],
    half_edges: &[HalfEdge],
    patches: &[usize],
    affinities: &[((usize, usize), usize)],
) -> Option<Vec<(usize, usize)>> {
    let score = |left: usize, right: usize| {
        let pair = ordered_pair(
            patches[half_edges[left].triangle],
            patches[half_edges[right].triangle],
        );
        affinities
            .binary_search_by_key(&pair, |entry| entry.0)
            .ok()
            .map_or(0, |index| affinities[index].1)
    };
    let unique_best = |edge: usize, candidates: &[usize]| {
        let best = candidates
            .iter()
            .copied()
            .map(|candidate| (score(edge, candidate), candidate))
            .max_by_key(|value| value.0)?;
        (candidates
            .iter()
            .filter(|candidate| score(edge, **candidate) == best.0)
            .count()
            == 1)
            .then_some(best.1)
    };
    let mut forward = forward.to_vec();
    let mut reverse = reverse.to_vec();
    let mut result = Vec::with_capacity(forward.len());
    while !forward.is_empty() {
        if forward.len() == 1 {
            result.push((forward[0], reverse[0]));
            break;
        }
        let pair = forward.iter().copied().find_map(|first| {
            let second = unique_best(first, &reverse)?;
            (unique_best(second, &forward)? == first).then_some((first, second))
        })?;
        forward.retain(|edge| *edge != pair.0);
        reverse.retain(|edge| *edge != pair.1);
        result.push(pair);
    }
    Some(result)
}

fn validate_vertex_links(
    triangles: &[Triangle],
    half_edges: &[HalfEdge],
    pairs: &[PendingEdge],
    vertex_count: usize,
) -> Result<(), RenderError> {
    let mut canonical = DisjointSet::new(vertex_count);
    for pair in pairs {
        let first = half_edges[pair.first];
        let second = half_edges[pair.second];
        canonical.union(first.start, second.end);
        canonical.union(first.end, second.start);
    }
    let roots = (0..vertex_count)
        .map(|vertex| canonical.find(vertex))
        .collect::<Vec<_>>();
    let mut triangles_at = vec![Vec::new(); vertex_count];
    for (triangle_index, triangle) in triangles.iter().enumerate() {
        for vertex in triangle.vertices {
            triangles_at[roots[vertex]].push(triangle_index);
        }
    }
    let mut link_edges = vec![Vec::new(); vertex_count];
    for pair in pairs {
        let first = half_edges[pair.first];
        let second = half_edges[pair.second];
        for vertex in [first.start, first.end] {
            link_edges[roots[vertex]].push((first.triangle, second.triangle));
        }
    }
    for (root, mut link) in triangles_at.into_iter().enumerate() {
        if link.is_empty() {
            continue;
        }
        link.sort_unstable();
        link.dedup();
        let source = link
            .iter()
            .map(|triangle| triangles[*triangle].source)
            .min_by_key(|source| source_key(*source))
            .expect("vertex link has a triangle");
        let mut degrees = vec![0_u8; link.len()];
        let mut connected = DisjointSet::new(link.len());
        for &(left, right) in &link_edges[root] {
            let left = link.binary_search(&left).expect("incident triangle");
            let right = link.binary_search(&right).expect("incident triangle");
            degrees[left] += 1;
            degrees[right] += 1;
            connected.union(left, right);
        }
        if degrees.iter().any(|degree| *degree != 2) {
            return Err(topology_error(source, "has a non-manifold vertex link"));
        }
        let first = connected.find(0);
        if (1..link.len()).any(|triangle| connected.find(triangle) != first) {
            return Err(topology_error(source, "has a disconnected vertex link"));
        }
    }
    Ok(())
}

fn half_edge_key(edge: HalfEdge) -> (usize, usize) {
    ordered_pair(edge.start, edge.end)
}

fn cluster_edge_key(edge: HalfEdge, clusters: &[usize]) -> (usize, usize) {
    ordered_pair(clusters[edge.start], clusters[edge.end])
}

fn spatial_clusters(vertices: &[usize], positions: &[Vec3], epsilon: f32) -> Vec<usize> {
    let mut sorted = vertices.to_vec();
    sorted.sort_by(|left, right| {
        compare_position(positions[*left], positions[*right]).then(left.cmp(right))
    });
    let mut sets = DisjointSet::new(sorted.len());
    let mut cells = BTreeMap::<(i64, i64, i64), Vec<usize>>::new();
    for (index, vertex) in sorted.iter().enumerate() {
        let position = positions[*vertex];
        let cell = spatial_cell(position, epsilon);
        for x in cell.0 - 1..=cell.0 + 1 {
            for y in cell.1 - 1..=cell.1 + 1 {
                for z in cell.2 - 1..=cell.2 + 1 {
                    for candidate in cells.get(&(x, y, z)).into_iter().flatten() {
                        if position.distance_squared(positions[sorted[*candidate]])
                            <= epsilon * epsilon
                        {
                            sets.union(index, *candidate);
                        }
                    }
                }
            }
        }
        cells.entry(cell).or_default().push(index);
    }
    let mut clusters = vec![usize::MAX; positions.len()];
    for (index, vertex) in sorted.into_iter().enumerate() {
        clusters[vertex] = sets.find(index);
    }
    clusters
}

fn spatial_cell(position: Vec3, epsilon: f32) -> (i64, i64, i64) {
    let coordinate = |value: f32| (value / epsilon).floor() as i64;
    (
        coordinate(position.x),
        coordinate(position.y),
        coordinate(position.z),
    )
}

fn compare_position(left: Vec3, right: Vec3) -> Ordering {
    left.x
        .total_cmp(&right.x)
        .then(left.y.total_cmp(&right.y))
        .then(left.z.total_cmp(&right.z))
}

fn cluster_positions(vertices: &[usize], positions: &[Vec3], clusters: &[usize]) -> Vec<Vec3> {
    let mut result = positions.to_vec();
    let mut representatives = vec![None; positions.len()];
    for &vertex in vertices {
        let representative = &mut representatives[clusters[vertex]];
        if representative.is_none_or(|current| compare_position(positions[vertex], current).is_lt())
        {
            *representative = Some(positions[vertex]);
        }
    }
    for &vertex in vertices {
        result[vertex] = representatives[clusters[vertex]].expect("cluster contains vertex");
    }
    result
}

fn build_plane(
    topology: &SectionTopology,
    plane: &SectionPlane,
    plane_index: usize,
    epsilon: f32,
    output: &mut CapGeometry,
) -> Result<(), RenderError> {
    let normal = Vec3::from(plane.normal).normalize();
    let basis = plane_basis(Vec3::from(plane.point), normal);
    let mut sources = Vec::new();
    let mut open_boundaries = Vec::new();
    for group in &topology.groups {
        let (segments, rings, fallback_color) =
            slice_group(group, basis, normal, epsilon, plane_index)?;
        if segments.is_empty() && rings.is_empty() {
            continue;
        }
        let graph = segments.iter().map(|entry| entry.0).collect::<Vec<_>>();
        let (graph_rings, open) = closed_rings(&graph);
        open_boundaries.extend(
            graph_rings
                .iter()
                .filter(|ring| {
                    contour_segments(ring).all(|segment| {
                        segments
                            .binary_search_by_key(&segment, |entry| entry.0)
                            .ok()
                            .map(|index| &segments[index].1)
                            .is_none_or(|values| values.iter().all(|value| !value.true_cut))
                    })
                })
                .flat_map(contour_segments),
        );
        open_boundaries.extend(open.into_iter().filter(|segment| {
            segments
                .binary_search_by_key(segment, |entry| entry.0)
                .ok()
                .map(|index| &segments[index].1)
                .is_some_and(|values| values.iter().all(|value| !value.true_cut))
        }));
        if rings.is_empty() {
            continue;
        }
        let mut overlay = Overlay::with_contours(&rings, &[]);
        let shapes = overlay.overlay(OverlayRule::Subject, FillRule::EvenOdd);
        for shape in shapes {
            let color = dominant_color(&shape, &segments).unwrap_or(fallback_color);
            let (base, stripe) = material_colors(color);
            sources.push(SourceRegion {
                owner: group.owner,
                shapes: vec![shape],
                base,
                stripe,
            });
        }
    }

    let mut merged = Vec::<SourceRegion>::new();
    for source in sources {
        if let Some(region) = merged
            .iter_mut()
            .find(|region| region.owner == source.owner)
        {
            region.shapes = boolean(&region.shapes, &source.shapes, OverlayRule::Xor);
        } else {
            merged.push(source);
        }
    }
    let sources = merged;

    if sources.is_empty() {
        append_segments(output, basis, &open_boundaries);
        return Ok(());
    }

    let mut overlap = IntShapes::new();
    for left in 0..sources.len() {
        for right in left + 1..sources.len() {
            if !bounds_overlap(&sources[left].shapes, &sources[right].shapes) {
                continue;
            }
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
            1.0,
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
        1.0,
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

fn bounds_overlap(left: &IntShapes<i64>, right: &IntShapes<i64>) -> bool {
    let bounds = |shapes: &IntShapes<i64>| {
        shapes
            .iter()
            .flatten()
            .flatten()
            .fold(None, |bounds, point| {
                Some(bounds.map_or(
                    (point.x, point.y, point.x, point.y),
                    |(min_x, min_y, max_x, max_y): (i64, i64, i64, i64)| {
                        (
                            min_x.min(point.x),
                            min_y.min(point.y),
                            max_x.max(point.x),
                            max_y.max(point.y),
                        )
                    },
                ))
            })
    };
    let (Some(left), Some(right)) = (bounds(left), bounds(right)) else {
        return false;
    };
    left.0 < right.2 && right.0 < left.2 && left.1 < right.3 && right.1 < left.3
}

fn slice_group(
    group: &SurfaceGroup,
    basis: Basis,
    normal: Vec3,
    epsilon: f32,
    plane_index: usize,
) -> Result<GroupSlice, RenderError> {
    let fallback = group
        .triangles
        .first()
        .expect("surface group contains triangles");
    let hits = group
        .edges
        .iter()
        .map(|edge| edge_hit(*edge, basis, normal, epsilon, plane_index))
        .collect::<Result<Vec<_>, _>>()?;
    let mut contributions = Vec::<(Segment, SegmentContribution)>::new();
    for triangle in &group.triangles {
        let distances = triangle
            .points
            .map(|point| (point - basis.origin).dot(normal));
        if distances.iter().all(|distance| distance.abs() <= epsilon) {
            continue;
        }
        let true_cut = distances.iter().any(|distance| *distance > epsilon)
            && distances.iter().any(|distance| *distance < -epsilon);
        let mut points = Vec::with_capacity(3);
        for edge in triangle.edges {
            match hits[edge] {
                EdgeHit::None => {}
                EdgeHit::Point(point) => {
                    points.push(point);
                }
                EdgeHit::Coplanar(a, b) => {
                    points.push(a);
                    points.push(b);
                }
            }
        }
        points.sort_unstable();
        points.dedup();
        if true_cut && points.len() != 2 {
            return Err(cap_error(
                plane_index,
                triangle.source,
                format!("triangle produced {} cut points", points.len()),
            ));
        }
        if points.len() != 2 {
            continue;
        }
        let mut points = points.into_iter();
        let segment = ordered_segment(
            points.next().expect("two cut points"),
            points.next().expect("two cut points"),
        );
        contributions.push((
            segment,
            SegmentContribution {
                source: triangle.source,
                base_color: triangle.base_color,
                true_cut,
                length: segment_length(segment),
            },
        ));
    }
    contributions.sort_by_key(|entry| entry.0);
    let mut segments = Vec::new();
    for values in contributions.chunk_by(|left, right| left.0 == right.0) {
        segments.push((values[0].0, values.iter().map(|entry| entry.1).collect()));
    }
    let rings = trace_cut_rings(group, basis, normal, plane_index)?;
    Ok((segments, rings, fallback.base_color))
}

fn trace_cut_rings(
    group: &SurfaceGroup,
    basis: Basis,
    normal: Vec3,
    plane_index: usize,
) -> Result<Vec<IntContour<i64>>, RenderError> {
    let hits = group
        .edges
        .iter()
        .map(|edge| half_open_hit(*edge, basis, normal, plane_index))
        .collect::<Result<Vec<_>, _>>()?;
    let mut cut_edges = Vec::with_capacity(group.triangles.len());
    for triangle in &group.triangles {
        let crossed = triangle
            .edges
            .into_iter()
            .filter(|edge| hits[*edge].is_some())
            .collect::<Vec<_>>();
        match crossed.as_slice() {
            [] => cut_edges.push(None),
            [first, second] => cut_edges.push(Some([*first, *second])),
            _ => {
                return Err(cap_error(
                    plane_index,
                    triangle.source,
                    format!("triangle produced {} half-open edges", crossed.len()),
                ));
            }
        }
    }

    let mut unseen = cut_edges
        .iter()
        .enumerate()
        .filter_map(|(triangle, edges)| edges.map(|_| triangle))
        .collect::<BTreeSet<_>>();
    let mut rings = Vec::<IntContour<i64>>::new();
    while let Some(start) = unseen.pop_first() {
        let [mut incoming, _] = cut_edges[start].expect("cut triangle has two edges");
        let mut triangle = start;
        let mut ring = Vec::new();
        loop {
            if triangle != start && !unseen.remove(&triangle) {
                return Err(cap_error(
                    plane_index,
                    group.triangles[triangle].source,
                    "cut revisited another loop",
                ));
            }
            ring.push(hits[incoming].expect("cut edge has an intersection"));
            let [first, second] = cut_edges[triangle].expect("unseen triangle has cut edges");
            let outgoing = if incoming == first {
                second
            } else if incoming == second {
                first
            } else {
                return Err(cap_error(
                    plane_index,
                    group.triangles[triangle].source,
                    "cut lost halfedge continuity",
                ));
            };
            let [left, right] = group.edges[outgoing].triangles;
            let next = if triangle == left {
                right
            } else if triangle == right {
                left
            } else {
                return Err(cap_error(
                    plane_index,
                    group.edges[outgoing].source,
                    "cut edge does not reference its source triangle",
                ));
            };
            if next == start {
                break;
            }
            incoming = outgoing;
            triangle = next;
        }

        ring.dedup();
        if ring.first() == ring.last() {
            ring.pop();
        }
        if ring.len() < 3 {
            continue;
        }
        if signed_area_points(&ring) < 0 {
            ring.reverse();
        }
        rings.push(
            canonical_ring(ring)
                .into_iter()
                .map(|point| IntPoint::new(point.0, point.1))
                .collect(),
        );
    }
    rings.sort_by(|left, right| {
        left.iter()
            .map(|point| (point.x, point.y))
            .cmp(right.iter().map(|point| (point.x, point.y)))
    });
    Ok(rings)
}

fn edge_hit(
    edge: CanonicalEdge,
    basis: Basis,
    normal: Vec3,
    epsilon: f32,
    plane_index: usize,
) -> Result<EdgeHit, RenderError> {
    let start = (edge.start - basis.origin).dot(normal);
    let end = (edge.end - basis.origin).dot(normal);
    if start.abs() <= epsilon && end.abs() <= epsilon {
        return Ok(EdgeHit::Coplanar(
            quantize(basis, edge.start, plane_index, edge.source)?,
            quantize(basis, edge.end, plane_index, edge.source)?,
        ));
    }
    if start.abs() <= epsilon {
        return Ok(EdgeHit::Point(quantize(
            basis,
            edge.start,
            plane_index,
            edge.source,
        )?));
    }
    if end.abs() <= epsilon {
        return Ok(EdgeHit::Point(quantize(
            basis,
            edge.end,
            plane_index,
            edge.source,
        )?));
    }
    if (start < -epsilon && end > epsilon) || (start > epsilon && end < -epsilon) {
        return Ok(EdgeHit::Point(quantize(
            basis,
            edge.start.lerp(edge.end, start / (start - end)),
            plane_index,
            edge.source,
        )?));
    }
    Ok(EdgeHit::None)
}

fn half_open_hit(
    edge: CanonicalEdge,
    basis: Basis,
    normal: Vec3,
    plane_index: usize,
) -> Result<Option<Point>, RenderError> {
    let start = (edge.start - basis.origin).dot(normal);
    let end = (edge.end - basis.origin).dot(normal);
    if (start > 0.0) == (end > 0.0) {
        return Ok(None);
    }
    let point = if start == 0.0 {
        edge.start
    } else if end == 0.0 {
        edge.end
    } else {
        edge.start.lerp(edge.end, start / (start - end))
    };
    quantize(basis, point, plane_index, edge.source).map(Some)
}

fn dominant_color(shape: &[IntContour<i64>], segments: &SegmentContributions) -> Option<[f32; 4]> {
    let mut totals = Vec::<((usize, usize, usize), [f32; 4], f64)>::new();
    for segment in shape.iter().flat_map(contour_segments) {
        let Some(index) = segments
            .binary_search_by_key(&segment, |entry| entry.0)
            .ok()
        else {
            continue;
        };
        for contribution in &segments[index].1 {
            let key = source_key(contribution.source);
            if let Some(entry) = totals.iter_mut().find(|entry| entry.0 == key) {
                entry.2 += contribution.length;
            } else {
                totals.push((key, contribution.base_color, contribution.length));
            }
        }
    }
    totals
        .into_iter()
        .max_by(|left, right| {
            left.2
                .total_cmp(&right.2)
                .then_with(|| right.0.cmp(&left.0))
        })
        .map(|(_, color, _)| color)
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
            rings.extend(bounded_faces(&component, &adjacency));
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
        if signed_area(&ring) < 0 {
            ring.reverse();
        }
        rings.push(ring);
    }
    (rings, open)
}

fn bounded_faces(
    component: &BTreeSet<Point>,
    adjacency: &BTreeMap<Point, BTreeSet<Point>>,
) -> Vec<IntContour<i64>> {
    let mut visited = Vec::<(Point, Point)>::new();
    let mut faces = Vec::<Vec<Point>>::new();
    for &start in component {
        for &next in &adjacency[&start] {
            if visited.contains(&(start, next)) {
                continue;
            }
            let first = (start, next);
            let mut edge = first;
            let mut face = Vec::new();
            let mut closed = false;
            for _ in 0..=adjacency.len() * 2 {
                visited.push(edge);
                face.push(edge.0);
                let mut neighbors = adjacency[&edge.1].iter().copied().collect::<Vec<_>>();
                neighbors.sort_by(|left, right| polar_cmp(edge.1, *left, *right));
                let incoming = neighbors
                    .iter()
                    .position(|candidate| *candidate == edge.0)
                    .expect("undirected adjacency");
                let outgoing = neighbors[(incoming + neighbors.len() - 1) % neighbors.len()];
                edge = (edge.1, outgoing);
                if edge == first {
                    closed = true;
                    break;
                }
            }
            let mut unique = face.clone();
            unique.sort_unstable();
            unique.dedup();
            if unique.len() != face.len() {
                continue;
            }
            if !closed || face.len() < 3 || signed_area_points(&face) <= 0 {
                continue;
            }
            faces.push(canonical_ring(face));
        }
    }
    faces.sort();
    faces.dedup();
    faces
        .into_iter()
        .map(|face| {
            face.into_iter()
                .map(|point| IntPoint::new(point.0, point.1))
                .collect()
        })
        .collect()
}

fn polar_cmp(origin: Point, left: Point, right: Point) -> Ordering {
    let left = (left.0 - origin.0, left.1 - origin.1);
    let right = (right.0 - origin.0, right.1 - origin.1);
    let upper = |vector: (i64, i64)| vector.1 > 0 || (vector.1 == 0 && vector.0 >= 0);
    upper(right)
        .cmp(&upper(left))
        .then_with(|| {
            let cross = left.0 as i128 * right.1 as i128 - left.1 as i128 * right.0 as i128;
            0_i128.cmp(&cross)
        })
        .then_with(|| {
            let left_length = left.0 as i128 * left.0 as i128 + left.1 as i128 * left.1 as i128;
            let right_length =
                right.0 as i128 * right.0 as i128 + right.1 as i128 * right.1 as i128;
            left_length.cmp(&right_length)
        })
}

fn canonical_ring(mut ring: Vec<Point>) -> Vec<Point> {
    let start = ring
        .iter()
        .enumerate()
        .min_by_key(|(_, point)| **point)
        .map(|(index, _)| index)
        .unwrap_or(0);
    ring.rotate_left(start);
    ring
}

fn signed_area(contour: &IntContour<i64>) -> i128 {
    signed_area_points(&contour.iter().copied().map(point).collect::<Vec<_>>())
}

fn signed_area_points(points: &[Point]) -> i128 {
    points
        .iter()
        .zip(points.iter().cycle().skip(1))
        .take(points.len())
        .map(|(left, right)| left.0 as i128 * right.1 as i128 - right.0 as i128 * left.1 as i128)
        .sum()
}

fn contour_segments(contour: &IntContour<i64>) -> impl Iterator<Item = Segment> + '_ {
    contour
        .iter()
        .copied()
        .zip(contour.iter().copied().cycle().skip(1))
        .take(contour.len())
        .map(|(left, right)| ordered_segment(point(left), point(right)))
}

fn segment_length(segment: Segment) -> f64 {
    let dx = (segment.1.0 - segment.0.0) as f64;
    let dy = (segment.1.1 - segment.0.1) as f64;
    dx.hypot(dy)
}

fn source_key(source: PrimitiveRef) -> (usize, usize, usize) {
    (source.node_index, source.mesh_index, source.primitive_index)
}

fn minimum_source(left: PrimitiveRef, right: PrimitiveRef) -> PrimitiveRef {
    if source_key(left) <= source_key(right) {
        left
    } else {
        right
    }
}

fn topology_error(source: PrimitiveRef, detail: impl std::fmt::Display) -> RenderError {
    RenderError::Parse(format!(
        "sections: topology: source node {}/mesh {}/primitive {} {detail}",
        source.node_index, source.mesh_index, source.primitive_index
    ))
}

fn cap_error(
    plane_index: usize,
    source: PrimitiveRef,
    detail: impl std::fmt::Display,
) -> RenderError {
    RenderError::Parse(format!(
        "sections: cap: sections.planes[{plane_index}] source node {}/mesh {}/primitive {} {detail}",
        source.node_index, source.mesh_index, source.primitive_index
    ))
}

fn boolean(subject: &IntShapes<i64>, clip: &IntShapes<i64>, rule: OverlayRule) -> IntShapes<i64> {
    match rule {
        OverlayRule::Union if subject.is_empty() => return clip.clone(),
        OverlayRule::Union if clip.is_empty() => return subject.clone(),
        OverlayRule::Xor if subject.is_empty() => return clip.clone(),
        OverlayRule::Xor if clip.is_empty() => return subject.clone(),
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
    for segment in boundaries.as_chunks::<6>().0 {
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

fn quantize(
    basis: Basis,
    world: Vec3,
    plane_index: usize,
    source: PrimitiveRef,
) -> Result<Point, RenderError> {
    let relative = world - basis.origin;
    let coordinates = [relative.dot(basis.u), relative.dot(basis.v)];
    let mut result = [0_i64; 2];
    for (index, coordinate) in coordinates.into_iter().enumerate() {
        let scaled = f64::from(coordinate) * PRECISION;
        if !scaled.is_finite() || scaled.abs() >= SAFE_COORDINATE as f64 {
            return Err(RenderError::Parse(format!(
                "sections.planes[{plane_index}] source node {}/mesh {}/primitive {} cap coordinate exceeds fixed-precision range",
                source.node_index, source.mesh_index, source.primitive_index
            )));
        }
        result[index] = scaled.round() as i64;
    }
    Ok((result[0], result[1]))
}

fn plane_basis(origin: Vec3, normal: Vec3) -> Basis {
    let helper = if normal.z.abs() < 0.9 {
        Vec3::Z
    } else {
        Vec3::Y
    };
    let u = helper.cross(normal).normalize();
    Basis {
        origin,
        u,
        v: normal.cross(u).normalize(),
    }
}

pub(crate) fn stripe_spacing(camera: CameraState, projection: Projection) -> f32 {
    let projection_scale = camera.projection.y_axis.y.abs().max(f32::EPSILON);
    let visible_span = match projection {
        Projection::Perspective => 2.0 * camera.target_depth / projection_scale,
        Projection::Orthographic => 2.0 / projection_scale,
    }
    .max(f32::EPSILON);
    let base = visible_span / 3.0;
    let exponent = base.log10().floor();
    let power = 10.0_f32.powf(exponent);
    let large = if base / power < 10.0_f32.sqrt() {
        power
    } else {
        5.0 * power
    };
    (large * 0.1).max(1.0e-6)
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

    const TEST_SOURCE: PrimitiveRef = PrimitiveRef {
        node_index: 0,
        mesh_index: 0,
        primitive_index: 0,
    };

    fn cube_primitive(
        source_index: usize,
        center: Vec3,
        half_extent: f32,
        base_color: [f32; 4],
    ) -> glb::Primitive {
        let mut positions = vec![
            -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0, -1.0, -1.0, 1.0,
            1.0, -1.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 1.0,
        ];
        for position in positions.as_chunks_mut::<3>().0 {
            position[0] = position[0] * half_extent + center.x;
            position[1] = position[1] * half_extent + center.y;
            position[2] = position[2] * half_extent + center.z;
        }
        glb::Primitive {
            source_index,
            mode: MODE_TRIANGLES,
            normals: positions.clone(),
            positions,
            indices: vec![
                0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0,
                5, 4, 3, 7, 6, 3, 6, 2,
            ],
            material: glb::Material {
                base_color,
                metallic: 0.0,
                roughness: 1.0,
            },
        }
    }

    fn cube_scene(instance_count: usize) -> glb::Scene {
        glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                primitives: vec![cube_primitive(0, Vec3::ZERO, 1.0, [0.5, 0.5, 0.5, 1.0])],
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

    fn split_cube_scene(offset: Vec3) -> glb::Scene {
        let color_a = [0.2, 0.3, 0.4, 1.0];
        let color_b = [0.7, 0.6, 0.5, 1.0];
        let mut first = cube_primitive(0, Vec3::ZERO, 0.01, color_a);
        let mut second = cube_primitive(1, Vec3::ZERO, 0.01, color_b);
        let indices = first.indices.clone();
        first.indices = indices
            .as_chunks::<3>()
            .0
            .iter()
            .step_by(2)
            .flatten()
            .copied()
            .collect();
        second.indices = indices
            .as_chunks::<3>()
            .0
            .iter()
            .skip(1)
            .step_by(2)
            .flatten()
            .copied()
            .collect();
        for position in second.positions.as_chunks_mut::<3>().0 {
            position[0] += offset.x;
            position[1] += offset.y;
            position[2] += offset.z;
        }
        glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                primitives: vec![first, second],
            }],
            instances: vec![glb::MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::IDENTITY,
                normal_matrix: Mat4::IDENTITY,
            }],
            bounds: Some(([-0.01; 3], [0.01; 3])),
        }
    }

    fn has_color(geometry: &CapGeometry, color: [f32; 4]) -> bool {
        geometry
            .vertices
            .as_chunks::<CAP_VERTEX_FLOATS>()
            .0
            .iter()
            .any(|vertex| vertex[5..9] == color)
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

    fn cap_area(geometry: &CapGeometry) -> f32 {
        geometry
            .indices
            .as_chunks::<3>()
            .0
            .iter()
            .map(|triangle| {
                let point = |index: u32| {
                    Vec3::from_slice(&geometry.vertices[index as usize * CAP_VERTEX_FLOATS..][..3])
                };
                (point(triangle[1]) - point(triangle[0]))
                    .cross(point(triangle[2]) - point(triangle[0]))
                    .length()
                    * 0.5
            })
            .sum()
    }

    fn crossing_edge(point: Point, triangles: [usize; 2]) -> CanonicalEdge {
        CanonicalEdge {
            start: Vec3::new(
                -1.0,
                point.0 as f32 / PRECISION as f32,
                point.1 as f32 / PRECISION as f32,
            ),
            end: Vec3::new(
                1.0,
                point.0 as f32 / PRECISION as f32,
                point.1 as f32 / PRECISION as f32,
            ),
            triangles,
            source: TEST_SOURCE,
        }
    }

    fn missed_edge() -> CanonicalEdge {
        CanonicalEdge {
            start: Vec3::X,
            end: Vec3::X + Vec3::Y,
            triangles: [0, 0],
            source: TEST_SOURCE,
        }
    }

    fn test_triangle(edges: [usize; 3]) -> Triangle {
        Triangle {
            vertices: [0, 1, 2],
            points: [Vec3::ZERO; 3],
            edges,
            source: TEST_SOURCE,
            base_color: [0.5; 4],
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
        assert_eq!(rings.len(), 1);
        assert_eq!(open.len(), 5);

        let dumbbell = vec![
            ((0, 0), (10, 0)),
            ((10, 0), (10, 10)),
            ((0, 10), (10, 10)),
            ((0, 0), (0, 10)),
            ((10, 0), (20, 0)),
            ((20, 0), (30, 0)),
            ((30, 0), (30, 10)),
            ((20, 10), (30, 10)),
            ((20, 0), (20, 10)),
        ];
        let (rings, open) = closed_rings(&dumbbell);
        assert_eq!(rings.len(), 2);
        assert_eq!(open.len(), dumbbell.len());
    }

    #[test]
    fn spacing_and_material_style_are_stable() {
        let mut projection = Mat4::IDENTITY;
        projection.y_axis.y = 2.0;
        let camera = CameraState {
            projection,
            view: Mat4::IDENTITY,
            forward: Vec3::NEG_Z,
            target_depth: 5.0,
        };
        assert!((stripe_spacing(camera, Projection::Orthographic) - 0.05).abs() < 1.0e-6);
        assert!((stripe_spacing(camera, Projection::Perspective) - 0.1).abs() < 1.0e-6);
        let mut closer = camera;
        closer.target_depth = 1.0;
        assert!((stripe_spacing(closer, Projection::Perspective) - 0.05).abs() < 1.0e-6);
        let mut zoomed = camera;
        zoomed.projection.y_axis.y = 4.0;
        assert!((stripe_spacing(zoomed, Projection::Orthographic) - 0.01).abs() < 1.0e-6);

        let x = plane_basis(Vec3::ZERO, Vec3::X);
        let y = plane_basis(Vec3::ZERO, Vec3::Y);
        let z = plane_basis(Vec3::ZERO, Vec3::Z);
        assert_eq!((x.u, x.v), (Vec3::Y, Vec3::Z));
        assert_eq!((y.u, y.v), (Vec3::NEG_X, Vec3::Z));
        assert_eq!((z.u, z.v), (Vec3::X, Vec3::Y));
        let oblique = plane_basis(Vec3::ZERO, Vec3::new(1.0, 2.0, 3.0).normalize());
        assert!(oblique.u.dot(oblique.v).abs() < 1.0e-6);
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
    fn racing_drone_true_cuts_close_across_axis_and_oblique_plane_sweeps() {
        let scene = glb::parse_glb(include_bytes!(
            "../../../tests/fixtures/racing-drone-section-repro.glb"
        ))
        .expect("racing drone fixture");
        let (minimum, maximum) = scene.bounds.expect("fixture bounds");
        let minimum = Vec3::from(minimum);
        let maximum = Vec3::from(maximum);
        let center = (minimum + maximum) * 0.5;
        let mut planes = Vec::new();
        for axis in 0..3 {
            for fraction in [0.1, 0.25, 0.5, 0.75, 0.9] {
                let mut point = center;
                point[axis] = minimum[axis] + (maximum[axis] - minimum[axis]) * fraction;
                let mut normal = [0.0; 3];
                normal[axis] = 1.0;
                planes.push(SectionPlane {
                    point: point.to_array(),
                    normal,
                });
            }
        }
        for normal in [
            [1.0, 1.0, 1.0],
            [1.0, -1.0, 1.0],
            [-1.0, 1.0, 1.0],
            [1.0, 1.0, -1.0],
        ] {
            planes.push(SectionPlane {
                point: center.to_array(),
                normal,
            });
        }
        planes.push(SectionPlane {
            point: [0.0; 3],
            normal: [1.0, 0.0, 0.0],
        });

        assert_eq!(planes.len(), 20);
        for (index, plane) in planes.into_iter().enumerate() {
            let options = RenderOptions {
                sections: Some(crate::Sections {
                    planes: vec![plane],
                    clip_surfaces: true,
                    clip_lines: true,
                }),
                ..RenderOptions::default()
            };
            let geometry = build(&scene, &options).expect("Racing Drone sweep plane must cap");
            assert!(
                !geometry.indices.is_empty(),
                "Racing Drone plane {index} produced no cap"
            );
        }
    }

    #[test]
    fn racing_drone_multi_plane_caps_are_deterministic() {
        let scene = glb::parse_glb(include_bytes!(
            "../../../tests/fixtures/racing-drone-section-repro.glb"
        ))
        .expect("racing drone fixture");
        let planes = [
            SectionPlane {
                point: [0.0; 3],
                normal: [1.0, 0.0, 0.0],
            },
            SectionPlane {
                point: [0.0; 3],
                normal: [0.0, 1.0, 0.0],
            },
            SectionPlane {
                point: [0.0; 3],
                normal: [0.0, 0.0, 1.0],
            },
        ];
        for count in 1..=planes.len() {
            let options = RenderOptions {
                sections: Some(crate::Sections {
                    planes: planes[..count].to_vec(),
                    clip_surfaces: true,
                    clip_lines: true,
                }),
                ..RenderOptions::default()
            };
            let first = build(&scene, &options).expect("first multi-plane cap");
            let second = build(&scene, &options).expect("repeated multi-plane cap");
            assert_eq!(first.vertices, second.vertices);
            assert_eq!(first.indices, second.indices);
            assert_eq!(first.boundaries, second.boundaries);
        }
    }

    #[test]
    fn coincident_sources_are_colored_as_one_overlap_region() {
        let geometry = build(&cube_scene(2), &section_options()).expect("overlap cap");
        let expected = srgb_hex(0xb9_1c_1c);
        for vertex in geometry.vertices.as_chunks::<CAP_VERTEX_FLOATS>().0 {
            assert_eq!(&vertex[5..9], &expected);
        }
        assert_eq!(geometry.boundaries.len() / 6, 4);
    }

    #[test]
    fn hollow_transformed_and_material_split_solids_keep_section_evidence() {
        let mut hollow = cube_scene(1);
        let mut inner = cube_primitive(0, Vec3::ZERO, 0.4, [0.5, 0.5, 0.5, 1.0]);
        for triangle in inner.indices.as_chunks_mut::<3>().0 {
            triangle.swap(1, 2);
        }
        let primitive = &mut hollow.meshes[0].primitives[0];
        let vertex_offset = u32::try_from(primitive.positions.len() / 3).expect("small fixture");
        primitive.positions.extend_from_slice(&inner.positions);
        primitive.normals.extend_from_slice(&inner.normals);
        primitive
            .indices
            .extend(inner.indices.into_iter().map(|index| index + vertex_offset));
        let hollow_cap = build(&hollow, &section_options()).expect("hollow cap");
        assert!((cap_area(&hollow_cap) - 3.36).abs() < 1.0e-4);

        let mut transformed = cube_scene(1);
        transformed.instances[0].model = Mat4::from_translation(Vec3::X * 5.0);
        let mut transformed_options = section_options();
        transformed_options
            .sections
            .as_mut()
            .expect("sections")
            .planes[0]
            .point = [5.0, 0.0, 0.0];
        let transformed_cap = build(&transformed, &transformed_options).expect("transformed cap");
        assert!(
            transformed_cap
                .vertices
                .as_chunks::<CAP_VERTEX_FLOATS>()
                .0
                .iter()
                .all(|vertex| (vertex[0] - 5.0).abs() < 1.0e-6)
        );

        let mut split = cube_scene(1);
        let first_color = [0.2, 0.3, 0.4, 1.0];
        let second_color = [0.7, 0.6, 0.5, 1.0];
        split.meshes[0].primitives = vec![
            cube_primitive(0, Vec3::Y * -2.0, 0.75, first_color),
            cube_primitive(1, Vec3::Y * 2.0, 0.75, second_color),
        ];
        let split_cap = build(&split, &section_options()).expect("material split cap");
        let first_base = material_colors(first_color).0;
        let second_base = material_colors(second_color).0;
        assert!(
            split_cap
                .vertices
                .as_chunks::<CAP_VERTEX_FLOATS>()
                .0
                .iter()
                .any(|vertex| vertex[5..9] == first_base)
        );
        assert!(
            split_cap
                .vertices
                .as_chunks::<CAP_VERTEX_FLOATS>()
                .0
                .iter()
                .any(|vertex| vertex[5..9] == second_base)
        );
    }

    #[test]
    fn nested_surface_ownership_uses_the_nearest_opposite_shell() {
        let mut scene = cube_scene(1);
        let middle = cube_primitive(0, Vec3::ZERO, 0.7, [0.5; 4]);
        let mut inner = cube_primitive(0, Vec3::ZERO, 0.4, [0.5; 4]);
        for triangle in inner.indices.as_chunks_mut::<3>().0 {
            triangle.swap(1, 2);
        }
        let primitive = &mut scene.meshes[0].primitives[0];
        for shell in [middle, inner] {
            let offset = u32::try_from(primitive.positions.len() / 3).expect("small fixture");
            primitive.positions.extend_from_slice(&shell.positions);
            primitive.normals.extend_from_slice(&shell.normals);
            primitive
                .indices
                .extend(shell.indices.into_iter().map(|index| index + offset));
        }

        let topology = build_topology(&scene, &section_options(), 1.0e-6).expect("nested shells");
        assert_eq!(topology.groups.len(), 3);
        assert_eq!(topology.groups[1].owner, topology.groups[2].owner);
        assert_ne!(topology.groups[0].owner, topology.groups[2].owner);
    }

    #[test]
    fn a_material_split_solid_uses_one_certified_cut_with_stable_provenance() {
        let scene = split_cube_scene(Vec3::new(0.0, 1.0e-8, 1.0e-8));
        let first = build(&scene, &section_options()).expect("material seam cap");
        let second = build(&scene, &section_options()).expect("repeat material seam cap");
        assert!((cap_area(&first) - 0.0004).abs() < 1.0e-8);
        assert_eq!(first.vertices, second.vertices);
        assert_eq!(first.indices, second.indices);
        assert_eq!(first.boundaries, second.boundaries);
        assert!(has_color(&first, material_colors([0.2, 0.3, 0.4, 1.0]).0));
    }

    #[test]
    fn tangent_touching_and_overlapping_sections_are_classified_exactly() {
        let mut tangent_options = section_options();
        tangent_options.sections.as_mut().expect("sections").planes[0].point = [1.0, 0.0, 0.0];
        let tangent = build(&cube_scene(1), &tangent_options).expect("tangent outline");
        assert!(tangent.indices.is_empty());
        assert_eq!(tangent.boundaries.len() / 6, 4);

        let mut overlap_scene = cube_scene(2);
        overlap_scene.instances[1].model = Mat4::from_translation(Vec3::Y * 0.5);
        let overlap = build(&overlap_scene, &section_options()).expect("positive overlap");
        assert!(has_color(&overlap, srgb_hex(0xb9_1c_1c)));
        assert!(
            overlap
                .vertices
                .as_chunks::<CAP_VERTEX_FLOATS>()
                .0
                .iter()
                .any(|vertex| vertex[9..13] == srgb_hex(0xfd_e0_47))
        );

        overlap_scene.instances[1].model = Mat4::from_translation(Vec3::Y * 2.0);
        let touching = build(&overlap_scene, &section_options()).expect("touching regions");
        assert!(!has_color(&touching, srgb_hex(0xb9_1c_1c)));
    }

    #[test]
    fn topology_admission_is_fail_closed_and_deterministic() {
        let duplicate_triangles = |count: usize, reverse: bool| glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                primitives: (0..count)
                    .map(|source_index| {
                        triangle_primitive(
                            vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
                            if reverse && source_index % 2 == 1 {
                                vec![0, 2, 1]
                            } else {
                                vec![0, 1, 2]
                            },
                        )
                    })
                    .enumerate()
                    .map(|(source_index, mut primitive)| {
                        primitive.source_index = source_index;
                        primitive
                    })
                    .collect(),
            }],
            instances: vec![glb::MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::IDENTITY,
                normal_matrix: Mat4::IDENTITY,
            }],
            bounds: Some(([0.0; 3], [1.0; 3])),
        };

        assert_eq!(
            build(&duplicate_triangles(2, false), &section_options())
                .expect_err("same-direction seam")
                .to_string(),
            "parse: sections: topology: source node 0/mesh 0/primitive 0 has an inconsistently oriented material seam"
        );
        assert_eq!(
            build(&duplicate_triangles(4, true), &section_options())
                .expect_err("ambiguous seam")
                .to_string(),
            "parse: sections: topology: source node 0/mesh 0/primitive 0 has an ambiguous material seam"
        );

        let mut non_finite = triangle_scene(
            vec![f32::NAN, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2],
        );
        non_finite.bounds = None;
        assert_eq!(
            build(&non_finite, &section_options())
                .expect_err("non-finite surface")
                .to_string(),
            "parse: sections: topology: source node 0/mesh 0/primitive 0 contains a non-finite vertex"
        );

        let mut partial = cube_scene(1);
        let mut open = triangle_primitive(
            vec![9.0, 0.0, 0.0, 11.0, 0.0, 0.0, 11.0, 1.0, 0.0],
            vec![0, 1, 2],
        );
        open.source_index = 1;
        partial.meshes[0].primitives.push(open);
        assert_eq!(
            build(&partial, &section_options())
                .expect_err("partial caps must fail")
                .to_string(),
            "parse: sections: topology: source node 0/mesh 0/primitive 1 has an open material seam"
        );

        let mut bow_tie = cube_scene(1);
        let second = cube_primitive(0, Vec3::splat(2.0), 1.0, [0.5; 4]);
        let primitive = &mut bow_tie.meshes[0].primitives[0];
        let offset = u32::try_from(primitive.positions.len() / 3).expect("small fixture");
        primitive.positions.extend_from_slice(&second.positions);
        primitive.normals.extend_from_slice(&second.normals);
        primitive.indices.extend(
            second
                .indices
                .into_iter()
                .map(|index| if index == 0 { 6 } else { index + offset }),
        );
        assert_eq!(
            build(&bow_tie, &section_options())
                .expect_err("disconnected vertex link")
                .to_string(),
            "parse: sections: topology: source node 0/mesh 0/primitive 0 has a disconnected vertex link"
        );
    }

    #[test]
    fn topology_admission_names_malformed_index_and_seam_inputs() {
        let error = |scene: &glb::Scene| {
            build(scene, &section_options())
                .expect_err("malformed topology")
                .to_string()
        };

        let mut incomplete = cube_scene(1);
        incomplete.meshes[0].primitives[0].indices.pop();
        assert!(error(&incomplete).contains("incomplete triangle index list"));

        let mut collapsed = cube_scene(1);
        collapsed.meshes[0].primitives[0].indices[1] = collapsed.meshes[0].primitives[0].indices[0];
        assert!(error(&collapsed).contains("collapsed triangle"));

        let mut missing = cube_scene(1);
        missing.meshes[0].primitives[0].indices[0] = u32::MAX;
        assert!(error(&missing).contains("missing vertex"));

        let non_manifold = triangle_scene(
            vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2, 0, 1, 2],
        );
        assert!(
            error(&non_manifold).contains("non-manifold or inconsistently oriented indexed edge")
        );

        let collapsed_seam = triangle_scene(
            vec![0.0, 0.0, 0.0, 1.0e-9, 0.0, 0.0, 0.0, 1.0, 0.0],
            vec![0, 1, 2],
        );
        assert!(error(&collapsed_seam).contains("seam edge collapsed by topology tolerance"));
    }

    #[test]
    fn topology_helpers_cover_pairing_clustering_and_regions() {
        assert!(contains_bounds(
            Vec3::ZERO,
            Vec3::splat(2.0),
            Vec3::ZERO,
            Vec3::ONE,
            0.1,
        ));

        let half_edges = [
            HalfEdge {
                triangle: 0,
                slot: 0,
                start: 0,
                end: 1,
                source: TEST_SOURCE,
            },
            HalfEdge {
                triangle: 1,
                slot: 0,
                start: 1,
                end: 0,
                source: TEST_SOURCE,
            },
            HalfEdge {
                triangle: 2,
                slot: 0,
                start: 0,
                end: 1,
                source: TEST_SOURCE,
            },
            HalfEdge {
                triangle: 3,
                slot: 0,
                start: 1,
                end: 0,
                source: TEST_SOURCE,
            },
        ];
        assert_eq!(
            uniquely_pair_seams(
                &[0, 2],
                &[1, 3],
                &half_edges,
                &[0, 1, 2, 3],
                &[((0, 1), 2), ((2, 3), 2)],
            ),
            Some(vec![(0, 1), (2, 3)])
        );
        assert_eq!(
            uniquely_pair_seams(&[0, 2], &[], &half_edges, &[0, 1, 2, 3], &[]),
            None
        );

        let positions = [Vec3::ZERO, Vec3::splat(0.01), Vec3::ONE];
        let clusters = spatial_clusters(&[0, 1, 2], &positions, 0.1);
        assert_eq!(clusters[0], clusters[1]);
        assert_ne!(clusters[0], clusters[2]);

        let triangle = test_triangle([0, 1, 2]);
        assert_eq!(
            validate_vertex_links(&[triangle], &[], &[], 3)
                .expect_err("non-manifold vertex")
                .to_string(),
            "parse: sections: topology: source node 0/mesh 0/primitive 0 has a non-manifold vertex link"
        );

        let square = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(10, 0),
            IntPoint::new(10, 10),
            IntPoint::new(0, 10),
        ]]];
        let empty = IntShapes::new();
        assert!(!bounds_overlap(&empty, &square));
        assert_eq!(boolean(&square, &empty, OverlayRule::Union), square);
        assert_eq!(boolean(&empty, &square, OverlayRule::Xor), square);
        assert_eq!(boolean(&square, &empty, OverlayRule::Xor), square);
        assert!(boolean(&empty, &square, OverlayRule::Intersect).is_empty());
        assert!(boolean(&square, &empty, OverlayRule::Intersect).is_empty());

        let source = |primitive_index| PrimitiveRef {
            primitive_index,
            ..TEST_SOURCE
        };
        let segments = vec![
            (
                ((0, 0), (10, 0)),
                vec![SegmentContribution {
                    source: source(0),
                    base_color: [0.2; 4],
                    true_cut: true,
                    length: 10.0,
                }],
            ),
            (
                ((0, 10), (10, 10)),
                vec![SegmentContribution {
                    source: source(1),
                    base_color: [0.8; 4],
                    true_cut: true,
                    length: 10.0,
                }],
            ),
        ];
        assert!(dominant_color(&square[0], &segments).is_some());
        assert_eq!(polar_cmp((0, 0), (1, 0), (2, 0)), Ordering::Less);
    }

    #[test]
    fn halfedge_traversal_rejects_corrupt_internal_topology() {
        let basis = plane_basis(Vec3::ZERO, Vec3::X);
        let normal = Vec3::X;
        let error = cap_error(2, TEST_SOURCE, "broken").to_string();
        assert_eq!(
            error,
            "parse: sections: cap: sections.planes[2] source node 0/mesh 0/primitive 0 broken"
        );

        let three_crossings = SurfaceGroup {
            owner: 0,
            edges: vec![
                crossing_edge((0, 0), [0, 0]),
                crossing_edge((10, 0), [0, 0]),
                crossing_edge((0, 10), [0, 0]),
            ],
            triangles: vec![test_triangle([0, 1, 2])],
        };
        assert!(
            trace_cut_rings(&three_crossings, basis, normal, 0)
                .expect_err("three half-open edges")
                .to_string()
                .contains("triangle produced 3 half-open edges")
        );

        let lost_continuity = SurfaceGroup {
            owner: 0,
            edges: vec![
                crossing_edge((0, 0), [0, 0]),
                crossing_edge((10, 0), [0, 1]),
                missed_edge(),
                crossing_edge((10, 10), [1, 1]),
                crossing_edge((0, 10), [1, 1]),
            ],
            triangles: vec![test_triangle([0, 1, 2]), test_triangle([2, 3, 4])],
        };
        assert!(
            trace_cut_rings(&lost_continuity, basis, normal, 0)
                .expect_err("lost continuity")
                .to_string()
                .contains("cut lost halfedge continuity")
        );

        let wrong_edge_owner = SurfaceGroup {
            owner: 0,
            edges: vec![
                crossing_edge((0, 0), [0, 0]),
                crossing_edge((10, 0), [1, 2]),
                missed_edge(),
            ],
            triangles: vec![test_triangle([0, 1, 2])],
        };
        assert!(
            trace_cut_rings(&wrong_edge_owner, basis, normal, 0)
                .expect_err("wrong edge owner")
                .to_string()
                .contains("cut edge does not reference its source triangle")
        );

        let revisited = SurfaceGroup {
            owner: 0,
            edges: vec![
                crossing_edge((0, 0), [2, 0]),
                crossing_edge((10, 0), [0, 1]),
                crossing_edge((10, 10), [1, 2]),
                crossing_edge((0, 10), [2, 1]),
                missed_edge(),
            ],
            triangles: vec![
                test_triangle([0, 1, 4]),
                test_triangle([1, 2, 4]),
                test_triangle([2, 3, 4]),
            ],
        };
        assert!(
            trace_cut_rings(&revisited, basis, normal, 0)
                .expect_err("revisited loop")
                .to_string()
                .contains("cut revisited another loop")
        );

        let short_ring = SurfaceGroup {
            owner: 0,
            edges: vec![
                crossing_edge((0, 0), [2, 0]),
                crossing_edge((10, 0), [0, 1]),
                crossing_edge((0, 0), [1, 2]),
                missed_edge(),
            ],
            triangles: vec![
                test_triangle([0, 1, 3]),
                test_triangle([1, 2, 3]),
                test_triangle([2, 0, 3]),
            ],
        };
        assert!(
            trace_cut_rings(&short_ring, basis, normal, 0)
                .expect("short quantized ring")
                .is_empty()
        );

        let invalid_slice = SurfaceGroup {
            owner: 0,
            edges: vec![crossing_edge((0, 0), [0, 0])],
            triangles: vec![Triangle {
                points: [Vec3::NEG_X, Vec3::X, Vec3::Y],
                edges: [0, 0, 0],
                ..test_triangle([0, 0, 0])
            }],
        };
        assert!(
            slice_group(&invalid_slice, basis, normal, 1.0e-6, 0)
                .err()
                .expect("invalid slice")
                .to_string()
                .contains("triangle produced 1 cut points")
        );
    }

    #[test]
    fn open_degenerate_and_out_of_range_sections_are_deterministic() {
        let open = triangle_scene(
            vec![-1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            vec![0, 1, 2],
        );
        assert_eq!(
            build(&open, &section_options())
                .expect_err("open surface must fail")
                .to_string(),
            "parse: sections: topology: source node 0/mesh 0/primitive 0 has an open material seam"
        );

        let collinear = triangle_scene(
            vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0],
            vec![0, 1, 2],
        );
        assert_eq!(
            build(&collinear, &section_options())
                .expect_err("degenerate surface must fail")
                .to_string(),
            "parse: sections: topology: source node 0/mesh 0/primitive 0 contains a degenerate triangle"
        );

        let basis = plane_basis(Vec3::ZERO, Vec3::X);
        assert!(matches!(
            edge_hit(
                CanonicalEdge {
                    start: Vec3::ZERO,
                    end: Vec3::Y,
                    triangles: [0, 1],
                    source: TEST_SOURCE,
                },
                basis,
                Vec3::X,
                1.0e-6,
                0,
            )
            .expect("coplanar"),
            EdgeHit::Coplanar(_, _)
        ));
        assert!(matches!(
            edge_hit(
                CanonicalEdge {
                    start: Vec3::ZERO,
                    end: Vec3::new(1.0, 1.0, 0.0),
                    triangles: [0, 1],
                    source: TEST_SOURCE,
                },
                basis,
                Vec3::X,
                1.0e-6,
                0,
            )
            .expect("vertex on plane"),
            EdgeHit::Point(_)
        ));

        let error = edge_hit(
            CanonicalEdge {
                start: Vec3::new(-1.0, 1.0e20, 0.0),
                end: Vec3::new(1.0, 2.0e20, 0.0),
                triangles: [0, 1],
                source: TEST_SOURCE,
            },
            basis,
            Vec3::X,
            1.0e-6,
            0,
        )
        .expect_err("out-of-range section must fail");
        assert!(
            error
                .to_string()
                .contains("source node 0/mesh 0/primitive 0")
        );
        for (start, end) in [
            (Vec3::new(0.0, 1.0e20, 0.0), Vec3::X),
            (Vec3::X, Vec3::new(0.0, 1.0e20, 0.0)),
        ] {
            assert!(
                edge_hit(
                    CanonicalEdge {
                        start,
                        end,
                        triangles: [0, 1],
                        source: TEST_SOURCE,
                    },
                    basis,
                    Vec3::X,
                    1.0e-6,
                    0,
                )
                .is_err()
            );
        }

        let square = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(1, 0),
            IntPoint::new(1, 1),
            IntPoint::new(0, 1),
        ]]];
        let mut output = CapGeometry::default();
        assert!(boolean(&IntShapes::new(), &square, OverlayRule::Difference).is_empty());
        append_contour(&mut output, basis, &vec![IntPoint::new(0, 0)]);
        assert!(
            plane_basis(Vec3::ZERO, Vec3::new(1.0, 1.0, 0.0).normalize())
                .u
                .y
                > 0.0
        );
        assert_eq!(srgb_to_linear(0.0), 0.0);
        assert_eq!(linear_to_srgb(0.0), 0.0);
        assert_eq!(cap_vertex_offset(0).expect("zero offset"), 0);
        assert!(cap_vertex_offset(usize::MAX).is_err());
    }
}
