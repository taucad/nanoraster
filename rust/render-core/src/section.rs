//! Deterministic CPU section caps. Geometry stays in world space; the GPU
//! clips the resulting cap triangles against the other active planes.
//!
//! A source whose topology certifies as a closed, consistently oriented
//! 2-manifold is capped exactly from its half-edge cut rings. Any other source
//! is never refused: its triangles are sliced directly, cut points welded on
//! the fixed-point grid, and every closed loop is filled while open or
//! branched chains are outlined in the open-chain colour and left unfilled.

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
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::ops::Bound;

const PRECISION: f64 = 100_000_000.0;
const SAFE_COORDINATE: i64 = 1_i64 << 61;
const CAP_VERTEX_FLOATS: usize = 15;
const MAX_QUADRATIC_SECTION_WORK: usize = 16_000_000;
/// Open-chain stroke colour, sRGB `#DD003F` (Tau's destructive token).
pub(crate) const OPEN_CHAIN_SRGB: u32 = 0xdd_00_3f;

fn bounded_section_work(work: Option<usize>) -> Option<usize> {
    work.filter(|work| *work <= MAX_QUADRATIC_SECTION_WORK)
}

#[derive(Debug, Default)]
pub(crate) struct CapGeometry {
    /// position(3), plane uv(2), base rgba(4), stripe rgba(4), stripe axis(2)
    pub(crate) vertices: Vec<f32>,
    pub(crate) indices: Vec<u32>,
    /// De-indexed world-space segment endpoint pairs for the fat-line path.
    pub(crate) boundaries: Vec<f32>,
    /// Open or branched cut chains of uncertified sources, in the same
    /// endpoint-pair layout, stroked in [`OPEN_CHAIN_SRGB`].
    pub(crate) open_chains: Vec<f32>,
    /// Per plane and source: how the cut was capped and what it found.
    pub(crate) sources: Vec<SectionSourceReport>,
}

/// Machine-readable outcome of one source on one plane. Never an error: an
/// uncertified source is still capped wherever its cut closes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SectionSourceReport {
    pub(crate) plane: usize,
    pub(crate) source: PrimitiveRef,
    /// Whether the exact half-edge path capped this source.
    pub(crate) certified: bool,
    pub(crate) closed_loops: usize,
    pub(crate) open_chains: usize,
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

/// Half-edges carry no source: it is the owning triangle's, which keeps the
/// pairing sort over a 32-byte record.
#[derive(Clone, Copy)]
struct HalfEdge {
    triangle: usize,
    slot: usize,
    start: usize,
    end: usize,
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
    /// Certified groups own paired edges; an uncertified group has none and is
    /// sliced triangle by triangle.
    certified: bool,
    edges: Vec<CanonicalEdge>,
    triangles: Vec<Triangle>,
    /// World-space bounds, the per-plane broad phase.
    bounds: (Vec3, Vec3),
}

/// One instance's eligible triangles, collected before admission.
struct Surface {
    positions: Vec<Vec3>,
    triangles: Vec<Triangle>,
    half_edges: Vec<HalfEdge>,
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
    ranks: Vec<u8>,
}

impl DisjointSet {
    fn new(size: usize) -> Self {
        Self {
            parents: (0..size).collect(),
            ranks: vec![0; size],
        }
    }

    /// Reuse the allocation as `size` singletons.
    fn reset(&mut self, size: usize) {
        self.parents.clear();
        self.parents.extend(0..size);
        self.ranks.clear();
        self.ranks.resize(size, 0);
    }

    fn find(&mut self, value: usize) -> usize {
        let mut root = value;
        while self.parents[root] != root {
            root = self.parents[root];
        }
        let mut current = value;
        while self.parents[current] != current {
            let parent = self.parents[current];
            self.parents[current] = root;
            current = parent;
        }
        root
    }

    fn union(&mut self, left: usize, right: usize) -> usize {
        let mut left = self.find(left);
        let mut right = self.find(right);
        if left == right {
            return left;
        }
        if self.ranks[left] < self.ranks[right]
            || (self.ranks[left] == self.ranks[right] && left > right)
        {
            std::mem::swap(&mut left, &mut right);
        }
        self.parents[right] = left;
        if self.ranks[left] == self.ranks[right] {
            self.ranks[left] += 1;
        }
        left
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

    let mut bounds: Option<(Vec3, Vec3)> = None;
    scene
        .for_each_surface_position(options, &mut |position| match &mut bounds {
            Some((minimum, maximum)) => {
                *minimum = minimum.min(position);
                *maximum = maximum.max(position);
            }
            None => bounds = Some((position, position)),
        })
        .map_err(RenderError::Parse)?;
    let epsilon = bounds
        .map(|(min, max)| (max - min).length() * 1.0e-6)
        .unwrap_or(1.0e-6)
        .max(1.0e-7);
    let topology = build_topology(scene, options, epsilon, &sections.planes)?;
    let mut geometry = CapGeometry::default();
    for (plane_index, plane) in sections.planes.iter().enumerate() {
        build_plane(&topology, plane, plane_index, epsilon, &mut geometry)?;
    }
    clip_boundaries(&mut geometry.boundaries, &sections.planes);
    clip_boundaries(&mut geometry.open_chains, &sections.planes);
    Ok(geometry)
}

/// Whether any part of `bounds` lies within `epsilon` of the plane or on both
/// sides of it. A group that fails this test contributes nothing to the plane:
/// every point of it is farther than `epsilon` on one side.
fn bounds_reach_plane(bounds: (Vec3, Vec3), plane: &SectionPlane, epsilon: f32) -> bool {
    let normal = Vec3::from(plane.normal).normalize();
    let origin = Vec3::from(plane.point);
    let center = (bounds.0 + bounds.1) * 0.5;
    let radius = ((bounds.1 - bounds.0) * 0.5).dot(normal.abs());
    let distance = (center - origin).dot(normal);
    // The slack covers f32 rounding between this bound and the per-point
    // distances the cut computes, which scale with the farthest point.
    let reach = (center - origin).abs() + (bounds.1 - bounds.0) * 0.5;
    let slack = epsilon + reach.max_element() * f32::EPSILON * 8.0;
    distance - radius <= slack && distance + radius >= -slack
}

fn build_topology(
    scene: &glb::Scene,
    options: &RenderOptions,
    epsilon: f32,
    planes: &[SectionPlane],
) -> Result<SectionTopology, RenderError> {
    let mut groups = Vec::new();
    let mut next_owner = 0;
    for instance in &scene.instances {
        let mesh = &scene.meshes[instance.mesh_index];
        let eligible = mesh
            .primitives
            .iter()
            .enumerate()
            .filter(|(_, primitive)| {
                primitive.mode == MODE_TRIANGLES
                    && scene.primitive_is_eligible(instance, primitive, options)
            })
            .map(|(slot, _)| slot)
            .collect::<Vec<_>>();
        // No plane reaches this instance, so it can contribute no cap and no
        // outline: skip collection and admission entirely.
        if let Some(bounds) = instance_bounds(scene, instance, &eligible)
            && !planes
                .iter()
                .any(|plane| bounds_reach_plane(bounds, plane, epsilon))
        {
            continue;
        }
        let surface = collect_surface(scene, instance, &eligible)?;
        let surface = match certify(surface, epsilon, &mut next_owner) {
            Ok(certified) => {
                groups.extend(certified);
                continue;
            }
            Err(surface) => surface,
        };
        // A multi-primitive instance that fails as a whole keeps the exact
        // path for every primitive that certifies alone; the rest are sliced
        // together so a loop that crosses their material seam still closes.
        let mut loose = Vec::new();
        if eligible.len() > 1 {
            for &slot in &eligible {
                let single = collect_surface(scene, instance, &[slot])?;
                match certify(single, epsilon, &mut next_owner) {
                    Ok(certified) => groups.extend(certified),
                    Err(single) => loose.extend(single.triangles),
                }
            }
        } else {
            loose = surface.triangles;
        }
        if let Some(bounds) = triangle_bounds(&loose) {
            groups.push(SurfaceGroup {
                owner: next_owner,
                certified: false,
                edges: Vec::new(),
                triangles: loose,
                bounds,
            });
            next_owner += 1;
        }
    }
    Ok(SectionTopology { groups })
}

/// Half-edge indices ordered by `(half_edge_key, index)`: a counting sort on
/// the smaller vertex, then a per-vertex sort on the larger one. Buckets hold
/// a vertex's few edges, so this is linear where a comparison sort over three
/// million records is not.
fn sorted_half_edges(half_edges: &[HalfEdge], vertex_count: usize) -> Vec<((usize, usize), usize)> {
    let mut offsets = vec![0_usize; vertex_count + 1];
    for edge in half_edges {
        offsets[half_edge_key(*edge).0 + 1] += 1;
    }
    for index in 0..vertex_count {
        offsets[index + 1] += offsets[index];
    }
    let mut cursor = offsets.clone();
    let mut sorted = vec![((0, 0), 0); half_edges.len()];
    for (index, edge) in half_edges.iter().enumerate() {
        let key = half_edge_key(*edge);
        sorted[cursor[key.0]] = (key, index);
        cursor[key.0] += 1;
    }
    // Each bucket is already in index order and holds a vertex's few edges:
    // a stable insertion sort on the larger vertex finishes the order.
    for bucket in offsets.windows(2) {
        let bucket = &mut sorted[bucket[0]..bucket[1]];
        for index in 1..bucket.len() {
            let mut position = index;
            while position > 0 && bucket[position - 1].0.1 > bucket[position].0.1 {
                bucket.swap(position - 1, position);
                position -= 1;
            }
        }
    }
    sorted
}

/// World bounds of every position the listed primitives can reference (the
/// shared manifold positions when the mesh carries them), or `None` when there
/// is none or one is non-finite, which [`collect_surface`] then reports.
fn instance_bounds(
    scene: &glb::Scene,
    instance: &glb::MeshInstance,
    slots: &[usize],
) -> Option<(Vec3, Vec3)> {
    let mesh = &scene.meshes[instance.mesh_index];
    let sources: Vec<&[f32]> = match &mesh.manifold {
        Some(manifold) => vec![&manifold.positions],
        None => slots
            .iter()
            .map(|slot| mesh.primitives[*slot].positions.as_slice())
            .collect(),
    };
    let mut bounds: Option<(Vec3, Vec3)> = None;
    for position in sources
        .into_iter()
        .flat_map(|positions| positions.as_chunks::<3>().0)
    {
        let point = instance.model.transform_point3(Vec3::from_array(*position));
        if !point.is_finite() {
            return None;
        }
        bounds = Some(bounds.map_or((point, point), |(minimum, maximum)| {
            (minimum.min(point), maximum.max(point))
        }));
    }
    bounds
}

fn triangle_bounds(triangles: &[Triangle]) -> Option<(Vec3, Vec3)> {
    triangles.iter().flat_map(|triangle| triangle.points).fold(
        None,
        |bounds: Option<(Vec3, Vec3)>, point| {
            Some(bounds.map_or((point, point), |(minimum, maximum)| {
                (minimum.min(point), maximum.max(point))
            }))
        },
    )
}

/// Collect the listed primitive slots of one instance in world space. Only
/// malformed input fails here: an incomplete index list, an index past the
/// vertex data, or a non-finite position. A triangle whose indices collapse
/// has no surface and is skipped; any other triangle is kept, however thin.
fn collect_surface(
    scene: &glb::Scene,
    instance: &glb::MeshInstance,
    slots: &[usize],
) -> Result<Surface, RenderError> {
    let mesh = &scene.meshes[instance.mesh_index];
    let mut fallback_vertex_count = 0;
    let primitive_bases = mesh
        .primitives
        .iter()
        .map(|primitive| {
            let base = fallback_vertex_count;
            fallback_vertex_count += primitive.positions.len() / 3;
            base
        })
        .collect::<Vec<_>>();
    let vertex_count = mesh
        .manifold
        .as_ref()
        .map_or(fallback_vertex_count, |manifold| {
            manifold.positions.len() / 3
        });
    let mut positions = vec![Vec3::ZERO; vertex_count];
    let mut triangles = Vec::new();
    let mut half_edges = Vec::new();
    for &primitive_slot in slots {
        let primitive = &mesh.primitives[primitive_slot];
        let source = scene.primitive_ref(instance, primitive);
        let (indices, local_positions, vertex_base) = match &mesh.manifold {
            Some(manifold) => {
                let range = manifold.primitive_ranges[primitive_slot].clone();
                (&manifold.indices[range], &manifold.positions, 0)
            }
            None => (
                primitive.indices.as_slice(),
                &primitive.positions,
                primitive_bases[primitive_slot],
            ),
        };
        if !indices.len().is_multiple_of(3) {
            return Err(topology_error(
                source,
                "has an incomplete triangle index list",
            ));
        }
        for indices in indices.as_chunks::<3>().0 {
            let vertices = indices.map(|vertex| vertex_base + vertex as usize);
            let mut world = [Vec3::ZERO; 3];
            for index in 0..3 {
                let offset = indices[index] as usize * 3;
                let Some(position) = local_positions.get(offset..offset + 3) else {
                    return Err(topology_error(source, "references a missing vertex"));
                };
                world[index] = instance.model.transform_point3(Vec3::from_slice(position));
                if !world[index].is_finite() {
                    return Err(topology_error(source, "contains a non-finite vertex"));
                }
                positions[vertices[index]] = world[index];
            }
            if vertices[0] == vertices[1]
                || vertices[1] == vertices[2]
                || vertices[2] == vertices[0]
            {
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
                });
            }
        }
    }
    Ok(Surface {
        positions,
        triangles,
        half_edges,
    })
}

/// Admit `surface` as closed, consistently oriented, manifold shells, or hand
/// it back for direct slicing. Owners are only consumed on success.
fn certify(
    surface: Surface,
    epsilon: f32,
    next_owner: &mut usize,
) -> Result<Vec<SurfaceGroup>, Surface> {
    let Surface {
        positions,
        mut triangles,
        half_edges,
    } = surface;
    let reject = |triangles: Vec<Triangle>, positions: Vec<Vec3>, half_edges: Vec<HalfEdge>| {
        Err(Surface {
            positions,
            triangles,
            half_edges,
        })
    };

    let indexed = sorted_half_edges(&half_edges, positions.len());
    let mut pairs = Vec::new();
    let mut unmatched = Vec::new();
    for edges in indexed.chunk_by(|left, right| left.0 == right.0) {
        let first = edges[0].1;
        if edges.len() == 1 {
            unmatched.push(first);
        } else if edges.len() == 2
            && half_edges[first].start == half_edges[edges[1].1].end
            && half_edges[first].end == half_edges[edges[1].1].start
        {
            pairs.push(PendingEdge {
                first,
                second: edges[1].1,
            });
        } else {
            return reject(triangles, positions, half_edges);
        }
    }
    // Free the sort before the larger allocations that follow.
    drop(indexed);

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
    for edges in unmatched.chunk_by(|left, right| {
        cluster_edge_key(half_edges[*left], &clusters)
            == cluster_edge_key(half_edges[*right], &clusters)
    }) {
        let key = cluster_edge_key(half_edges[edges[0]], &clusters);
        if key.0 == key.1 || edges.len() == 1 {
            return reject(triangles, positions, half_edges);
        }
        let (forward, reverse) = split_directions(edges, key, &half_edges, &clusters);
        if forward.len() != 1 || reverse.len() != 1 {
            return reject(triangles, positions, half_edges);
        }
        pairs.push(PendingEdge {
            first: forward[0],
            second: reverse[0],
        });
    }

    let representative_positions = cluster_positions(&seam_vertices, &positions, &clusters);
    if !vertex_links_are_manifold(&triangles, &half_edges, &pairs, positions.len()) {
        return reject(triangles, positions, half_edges);
    }
    for triangle in &mut triangles {
        triangle.points = triangle
            .vertices
            .map(|vertex| representative_positions[vertex]);
    }
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
            source: minimum_source(
                triangles[first.triangle].source,
                triangles[second.triangle].source,
            ),
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
    // Components in root order, each in triangle order, counted out rather
    // than pushed into one vector per triangle.
    let roots = (0..triangles.len())
        .map(|index| surface_sets.find(index))
        .collect::<Vec<_>>();
    drop(surface_sets);
    let mut sizes = vec![0_usize; triangles.len()];
    for &root in &roots {
        sizes[root] += 1;
    }
    let mut slot = vec![usize::MAX; triangles.len()];
    let mut components = Vec::<Vec<usize>>::new();
    for (root, &size) in sizes.iter().enumerate() {
        if size > 0 {
            slot[root] = components.len();
            components.push(Vec::with_capacity(size));
        }
    }
    let mut component_of = vec![0_usize; triangles.len()];
    for (index, &root) in roots.iter().enumerate() {
        component_of[index] = slot[root];
        components[slot[root]].push(index);
    }
    drop((roots, sizes, slot));
    let stats = components
        .iter()
        .map(|component| component_stats(component, &triangles))
        .collect::<Vec<_>>();
    let Some(mut containment_work) =
        bounded_section_work(components.len().checked_mul(components.len()))
    else {
        return reject(triangles, positions, half_edges);
    };
    let mut order = (0..components.len()).collect::<Vec<_>>();
    order.sort_by(|left, right| {
        stats[*right]
            .2
            .total_cmp(&stats[*left].2)
            .then(left.cmp(right))
    });
    let mut owner = *next_owner;
    let mut component_owners = vec![usize::MAX; components.len()];
    for &component in &order {
        let mut container: Option<usize> = None;
        for candidate in order.iter().copied().filter(|candidate| {
            component_owners[*candidate] != usize::MAX
                && stats[*candidate].3 * stats[component].3 < 0.0
                && contains_bounds(
                    stats[*candidate].0,
                    stats[*candidate].1,
                    stats[component].0,
                    stats[component].1,
                    epsilon,
                )
        }) {
            let Some(work) = bounded_section_work(
                components[candidate]
                    .len()
                    .checked_mul(components[component].len())
                    .and_then(|work| work.checked_mul(4))
                    .and_then(|work| work.checked_add(containment_work)),
            ) else {
                return reject(triangles, positions, half_edges);
            };
            containment_work = work;
            let Some(contained) = component_is_contained(
                &components[component],
                &components[candidate],
                &triangles,
                epsilon,
            ) else {
                return reject(triangles, positions, half_edges);
            };
            if contained && container.is_none_or(|current| stats[candidate].2 < stats[current].2) {
                container = Some(candidate);
            }
        }
        component_owners[component] = container.map_or_else(
            || {
                owner += 1;
                owner - 1
            },
            |container| component_owners[container],
        );
    }
    *next_owner = owner;

    let mut groups = Vec::with_capacity(components.len());
    // Each edge's two triangles share a component, so bucketing edges by the
    // first one's component, in edge order, yields every component's sorted
    // edge list in one pass. Dense global-to-local maps replace searches.
    let mut component_edges = vec![Vec::new(); components.len()];
    for (index, edge) in edges.iter().enumerate() {
        component_edges[component_of[edge.triangles[0]]].push(index);
    }
    let mut local_edge = vec![usize::MAX; edges.len()];
    let mut local_triangle = vec![usize::MAX; triangles.len()];
    for ((component, triangle_indices), used_edges) in
        components.into_iter().enumerate().zip(component_edges)
    {
        for (local, &edge) in used_edges.iter().enumerate() {
            local_edge[edge] = local;
        }
        for (local, &triangle) in triangle_indices.iter().enumerate() {
            local_triangle[triangle] = local;
        }
        let group_triangles = triangle_indices
            .iter()
            .map(|&index| {
                let mut triangle = triangles[index].clone();
                triangle.edges = triangle.edges.map(|edge| local_edge[edge]);
                triangle
            })
            .collect::<Vec<_>>();
        groups.push(SurfaceGroup {
            owner: component_owners[component],
            certified: true,
            edges: used_edges
                .into_iter()
                .map(|edge| {
                    let mut edge = edges[edge];
                    edge.triangles = edge.triangles.map(|triangle| local_triangle[triangle]);
                    edge
                })
                .collect(),
            triangles: group_triangles,
            bounds: (stats[component].0, stats[component].1),
        });
    }
    Ok(groups)
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

fn component_is_contained(
    inner: &[usize],
    outer: &[usize],
    triangles: &[Triangle],
    epsilon: f32,
) -> Option<bool> {
    let mut classification = None;
    for triangle in inner.iter().map(|index| &triangles[*index]) {
        let centroid = (triangle.points[0] + triangle.points[1] + triangle.points[2]) / 3.0;
        for point in triangle.points.into_iter().chain(std::iter::once(centroid)) {
            let inside = point_in_component(point, outer, triangles, epsilon)?;
            if classification.is_some_and(|classification| classification != inside) {
                return None;
            }
            classification = Some(inside);
        }
    }
    classification
}

fn point_in_component(
    point: Vec3,
    component: &[usize],
    triangles: &[Triangle],
    epsilon: f32,
) -> Option<bool> {
    let point = point.as_dvec3();
    let epsilon = f64::from(epsilon);
    let ray = glam::DVec3::new(0.785_436_249, 0.291_680_651, 0.545_674_831);
    let mut intersections = 0_usize;
    for triangle in component.iter().map(|index| &triangles[*index]) {
        if ray_crosses_triangle(
            point,
            ray,
            triangle.points.map(|vertex| vertex.as_dvec3()),
            epsilon,
        )? {
            intersections += 1;
        }
    }
    Some(!intersections.is_multiple_of(2))
}

/// `None` whenever the answer would be a coin flip: the point sits on the
/// triangle's plane while the ray runs along it, the point sits on the
/// triangle, or the ray leaves through an edge or corner.
fn ray_crosses_triangle(
    point: glam::DVec3,
    ray: glam::DVec3,
    [a, b, c]: [glam::DVec3; 3],
    epsilon: f64,
) -> Option<bool> {
    let edge_1 = b - a;
    let edge_2 = c - a;
    let from_a = point - a;
    let normal = edge_1.cross(edge_2);
    let crossed = ray.cross(edge_2);
    let determinant = edge_1.dot(crossed);
    if determinant * determinant
        <= f64::EPSILON * f64::EPSILON * edge_1.length_squared() * edge_2.length_squared()
    {
        let plane_distance = from_a.dot(normal);
        if plane_distance * plane_distance <= epsilon * epsilon * normal.length_squared() {
            return None;
        }
        return Some(false);
    }
    let inverse = determinant.recip();
    let u = from_a.dot(crossed) * inverse;
    let q = from_a.cross(edge_1);
    let v = ray.dot(q) * inverse;
    let distance = edge_2.dot(q) * inverse;
    if u >= -1.0e-10 && v >= -1.0e-10 && u + v <= 1.0 + 1.0e-10 {
        if distance.abs() <= epsilon {
            return None;
        }
        if distance > 0.0 {
            if u.min(v).min(1.0 - u - v) <= 1.0e-10 {
                return None;
            }
            return Some(true);
        }
    }
    Some(false)
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

/// Every vertex's link must be one closed fan: each incident triangle meets
/// exactly two others across paired edges, and all of them connect.
///
/// The incidence lists are flat offset tables rather than one vector per
/// vertex, so a million-triangle surface allocates a handful of arrays.
fn vertex_links_are_manifold(
    triangles: &[Triangle],
    half_edges: &[HalfEdge],
    pairs: &[PendingEdge],
    vertex_count: usize,
) -> bool {
    let mut canonical = DisjointSet::new(vertex_count);
    for pair in pairs {
        let first = half_edges[pair.first];
        let second = half_edges[pair.second];
        // Indexed pairs already share their vertices; only seam pairs weld.
        if first.start != second.end {
            canonical.union(first.start, second.end);
        }
        if first.end != second.start {
            canonical.union(first.end, second.start);
        }
    }
    let roots = (0..vertex_count)
        .map(|vertex| canonical.find(vertex))
        .collect::<Vec<_>>();
    drop(canonical);
    // Offset tables: per root, the incident triangles (one entry per corner)
    // and the paired edges around it as (triangle, triangle).
    let mut triangle_offsets = vec![0_usize; vertex_count + 1];
    let mut link_offsets = vec![0_usize; vertex_count + 1];
    for triangle in triangles {
        for vertex in triangle.vertices {
            triangle_offsets[roots[vertex] + 1] += 1;
        }
    }
    for pair in pairs {
        let first = half_edges[pair.first];
        link_offsets[roots[first.start] + 1] += 1;
        link_offsets[roots[first.end] + 1] += 1;
    }
    for index in 0..vertex_count {
        triangle_offsets[index + 1] += triangle_offsets[index];
        link_offsets[index + 1] += link_offsets[index];
    }
    let mut cursor = triangle_offsets.clone();
    let mut triangles_at = vec![0_usize; triangle_offsets[vertex_count]];
    for (triangle_index, triangle) in triangles.iter().enumerate() {
        for vertex in triangle.vertices {
            let root = roots[vertex];
            triangles_at[cursor[root]] = triangle_index;
            cursor[root] += 1;
        }
    }
    cursor.copy_from_slice(&link_offsets);
    let mut link_edges = vec![(0_usize, 0_usize); link_offsets[vertex_count]];
    for pair in pairs {
        let first = half_edges[pair.first];
        let second = half_edges[pair.second];
        for vertex in [first.start, first.end] {
            let root = roots[vertex];
            link_edges[cursor[root]] = (first.triangle, second.triangle);
            cursor[root] += 1;
        }
    }
    drop(cursor);

    let mut link = Vec::new();
    let mut degrees = Vec::new();
    let mut connected = DisjointSet::new(0);
    for root in 0..vertex_count {
        let incident = &triangles_at[triangle_offsets[root]..triangle_offsets[root + 1]];
        if incident.is_empty() {
            continue;
        }
        link.clear();
        link.extend_from_slice(incident);
        link.sort_unstable();
        link.dedup();
        degrees.clear();
        degrees.resize(link.len(), 0_u8);
        connected.reset(link.len());
        for &(left, right) in &link_edges[link_offsets[root]..link_offsets[root + 1]] {
            let left = link.binary_search(&left).expect("incident triangle");
            let right = link.binary_search(&right).expect("incident triangle");
            degrees[left] = degrees[left].saturating_add(1);
            degrees[right] = degrees[right].saturating_add(1);
            connected.union(left, right);
        }
        if degrees.iter().any(|degree| *degree != 2) {
            return false;
        }
        let first = connected.find(0);
        if (1..link.len()).any(|triangle| connected.find(triangle) != first) {
            return false;
        }
    }
    true
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
    let mut minimum = sorted
        .iter()
        .map(|vertex| positions[*vertex])
        .collect::<Vec<_>>();
    let mut maximum = minimum.clone();
    // Only keyed lookup is used: explicit cell traversal and insertion-ordered
    // candidate lists preserve the deterministic union sequence across hash seeds.
    let mut cells = HashMap::<(i64, i64, i64), Vec<usize>>::new();
    for (index, vertex) in sorted.iter().enumerate() {
        let position = positions[*vertex];
        if index > 0 && compare_position(position, positions[sorted[index - 1]]) == Ordering::Equal
        {
            // Equal positions are consecutive. The preceding point already
            // visited these candidates; no intervening point can change them.
            // Union (rather than alias) preserves rank and exact root IDs.
            // One cell entry suffices for this consecutive run of candidates.
            sets.union(index, index - 1);
            continue;
        }
        let cell = spatial_cell(position, epsilon);
        for x in cell.0 - 1..=cell.0 + 1 {
            for y in cell.1 - 1..=cell.1 + 1 {
                for z in cell.2 - 1..=cell.2 + 1 {
                    for candidate in cells.get(&(x, y, z)).into_iter().flatten() {
                        let left = sets.find(index);
                        let right = sets.find(*candidate);
                        if left == right {
                            continue;
                        }
                        let combined_minimum = minimum[left].min(minimum[right]);
                        let combined_maximum = maximum[left].max(maximum[right]);
                        if (combined_maximum - combined_minimum).length_squared()
                            <= epsilon * epsilon
                        {
                            let root = sets.union(left, right);
                            minimum[root] = combined_minimum;
                            maximum[root] = combined_maximum;
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

/// What one surface group contributes to one plane.
#[derive(Default)]
struct GroupCut {
    regions: Vec<SourceRegion>,
    /// Black outlines of surface lying in the plane (exact path only).
    outlines: Vec<Segment>,
    /// Open or branched chains, stroked in the open-chain colour.
    open_chains: Vec<Segment>,
    /// `(source, closed loops, open chains)`, each loop and chain counted
    /// under the source that contributes most of its length.
    counts: Vec<(PrimitiveRef, usize, usize)>,
}

impl GroupCut {
    fn count(
        &mut self,
        cut: &[Segment],
        contributions: &SegmentContributions,
        fallback: PrimitiveRef,
        closed: bool,
    ) {
        let source = dominant(cut, contributions).map_or(fallback, |(source, _)| source);
        let index = self
            .counts
            .iter()
            .position(|entry| entry.0 == source)
            .unwrap_or_else(|| {
                self.counts.push((source, 0, 0));
                self.counts.len() - 1
            });
        if closed {
            self.counts[index].1 += 1;
        } else {
            self.counts[index].2 += 1;
        }
    }
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
    let mut open_chains = Vec::new();
    let mut reports = BTreeMap::<((usize, usize, usize), bool), SectionSourceReport>::new();
    for group in &topology.groups {
        if !bounds_reach_plane(group.bounds, plane, epsilon) {
            continue;
        }
        // A certified group whose exact cut cannot be traced is sliced like
        // an uncertified one rather than failing the render.
        let exact = group
            .certified
            .then(|| exact_cut(group, basis, normal, epsilon, plane_index).ok())
            .flatten();
        let certified = exact.is_some();
        let cut = match exact {
            Some(cut) => cut,
            None => loose_cut(group, basis, normal, plane_index)?,
        };
        for &(source, closed_loops, open_chains) in &cut.counts {
            let report =
                reports
                    .entry((source_key(source), certified))
                    .or_insert(SectionSourceReport {
                        plane: plane_index,
                        source,
                        certified,
                        closed_loops: 0,
                        open_chains: 0,
                    });
            report.closed_loops += closed_loops;
            report.open_chains += open_chains;
        }
        open_boundaries.extend(cut.outlines);
        open_chains.extend(cut.open_chains);
        sources.extend(cut.regions);
    }
    output.sources.extend(reports.into_values());
    append_segments(&mut output.open_chains, basis, &open_chains);

    let mut merged = Vec::<SourceRegion>::new();
    let mut owner_regions = BTreeMap::<usize, usize>::new();
    for source in sources {
        if let Some(&index) = owner_regions.get(&source.owner) {
            let region = &mut merged[index];
            region.shapes = boolean(&region.shapes, &source.shapes, OverlayRule::Xor);
        } else {
            owner_regions.insert(source.owner, merged.len());
            merged.push(source);
        }
    }
    let sources = merged;

    if sources.is_empty() {
        append_segments(&mut output.boundaries, basis, &open_boundaries);
        return Ok(());
    }

    let source_bounds = sources
        .iter()
        .map(|source| shape_bounds(&source.shapes))
        .collect::<Vec<_>>();
    let candidates = overlap_candidates(&source_bounds, MAX_QUADRATIC_SECTION_WORK);

    let mut overlap = IntShapes::new();
    for (left, right) in candidates {
        let intersection = boolean(
            &sources[left].shapes,
            &sources[right].shapes,
            OverlayRule::Intersect,
        );
        overlap = boolean(&overlap, &intersection, OverlayRule::Union);
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
    );
    appended?;

    let mut all = IntShapes::new();
    for source in &sources {
        all = boolean(&all, &source.shapes, OverlayRule::Union);
    }
    for shape in &all {
        for contour in shape {
            append_contour(&mut output.boundaries, basis, contour);
        }
    }
    append_segments(&mut output.boundaries, basis, &open_boundaries);
    Ok(())
}

/// [`overlapping_pairs`] held to a budget: every candidate costs two polygon
/// booleans, so a plane where more regions overlap than that is still capped,
/// but without the overlap marking.
fn overlap_candidates(bounds: &[ShapeBounds], limit: usize) -> Vec<(usize, usize)> {
    let mut pairs = overlapping_pairs(bounds);
    if pairs.len() > limit {
        pairs.clear();
    }
    pairs
}

/// Index pairs `(left, right)`, `left < right`, whose bounds strictly overlap,
/// in lexicographic order. A sweep over the minimum x replaces the all-pairs
/// scan, so disjoint regions cost a sort rather than a quadratic loop.
fn overlapping_pairs(bounds: &[ShapeBounds]) -> Vec<(usize, usize)> {
    let mut order = bounds
        .iter()
        .enumerate()
        .filter_map(|(index, bounds)| bounds.map(|bounds| (bounds.0, index)))
        .collect::<Vec<_>>();
    order.sort_unstable();
    let mut partners = vec![Vec::new(); bounds.len()];
    for (position, &(_, left)) in order.iter().enumerate() {
        let left_bounds = bounds[left].expect("ordered regions have bounds");
        for &(minimum, right) in &order[position + 1..] {
            if minimum >= left_bounds.2 {
                break;
            }
            if bounds_overlap(Some(left_bounds), bounds[right]) {
                partners[left.min(right)].push(left.max(right));
            }
        }
    }
    let mut pairs = Vec::new();
    for (left, mut rights) in partners.into_iter().enumerate() {
        rights.sort_unstable();
        pairs.extend(rights.into_iter().map(|right| (left, right)));
    }
    pairs
}

/// The exact cut of a certified group: half-edge rings filled by owner, plus
/// outlines of any surface lying in the plane.
fn exact_cut(
    group: &SurfaceGroup,
    basis: Basis,
    normal: Vec3,
    epsilon: f32,
    plane_index: usize,
) -> Result<GroupCut, RenderError> {
    let (segments, rings, fallback_color) =
        slice_group(group, basis, normal, epsilon, plane_index)?;
    let mut cut = GroupCut::default();
    if segments.is_empty() && rings.is_empty() {
        return Ok(cut);
    }
    let graph = segments.iter().map(|entry| entry.0).collect::<Vec<_>>();
    let (graph_rings, open) = closed_rings(&graph).map_err(|()| {
        cap_error(
            plane_index,
            group.triangles[0].source,
            "fixed-point winding overflow",
        )
    })?;
    let in_plane_only = |segment: &Segment| {
        segments
            .binary_search_by_key(segment, |entry| entry.0)
            .ok()
            .map(|index| &segments[index].1)
            .is_some_and(|values| values.iter().all(|value| !value.true_cut))
    };
    cut.outlines.extend(
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
    cut.outlines.extend(open.into_iter().filter(in_plane_only));
    for ring in &rings {
        let ring = contour_segments(ring).collect::<Vec<_>>();
        cut.count(&ring, &segments, group.triangles[0].source, true);
    }
    cut.regions = fill_regions(group.owner, &rings, &segments, fallback_color);
    Ok(cut)
}

/// The direct cut of an uncertified group: every closed loop is filled and
/// every open or branched chain is kept as an outline.
fn loose_cut(
    group: &SurfaceGroup,
    basis: Basis,
    normal: Vec3,
    plane_index: usize,
) -> Result<GroupCut, RenderError> {
    let segments = loose_segments(group, basis, normal, plane_index)?;
    let mut cut = GroupCut::default();
    if segments.is_empty() {
        return Ok(cut);
    }
    let graph = segments.iter().map(|entry| entry.0).collect::<Vec<_>>();
    let loops = cut_loops(&graph, plane_index, group.triangles[0].source)?;
    let fallback = group.triangles[0].source;
    for ring in &loops.rings {
        let ring = contour_segments(ring).collect::<Vec<_>>();
        cut.count(&ring, &segments, fallback, true);
    }
    for chain in &loops.chains {
        cut.count(chain, &segments, fallback, false);
    }
    cut.open_chains = loops.open;
    if !loops.rings.is_empty() {
        // One owner, so one region: the even-odd fill of every loop, coloured
        // like the exact path colours an owner, by its first shape.
        let mut overlay = Overlay::with_contours(&loops.rings, &[]);
        let shapes = overlay.overlay(OverlayRule::Subject, FillRule::EvenOdd);
        let color = shapes
            .first()
            .and_then(|shape| dominant_color(shape, &segments))
            .unwrap_or(group.triangles[0].base_color);
        let (base, stripe) = material_colors(color);
        cut.regions.push(SourceRegion {
            owner: group.owner,
            shapes,
            base,
            stripe,
        });
    }
    Ok(cut)
}

fn fill_regions(
    owner: usize,
    rings: &[IntContour<i64>],
    segments: &SegmentContributions,
    fallback_color: [f32; 4],
) -> Vec<SourceRegion> {
    if rings.is_empty() {
        return Vec::new();
    }
    let mut overlay = Overlay::with_contours(rings, &[]);
    overlay
        .overlay(OverlayRule::Subject, FillRule::EvenOdd)
        .into_iter()
        .map(|shape| {
            let color = dominant_color(&shape, segments).unwrap_or(fallback_color);
            let (base, stripe) = material_colors(color);
            SourceRegion {
                owner,
                shapes: vec![shape],
                base,
                stripe,
            }
        })
        .collect()
}

/// Slice each triangle on its own. A triangle crosses the plane where its
/// vertices fall on both sides of the half-open test `distance > 0`, so it has
/// exactly two crossing edges. Each crossing is computed from the edge's
/// endpoints in position order, which makes the shared edge of two triangles
/// produce bit-identical points, and the fixed-point quantum welds them.
fn loose_segments(
    group: &SurfaceGroup,
    basis: Basis,
    normal: Vec3,
    plane_index: usize,
) -> Result<SegmentContributions, RenderError> {
    let mut contributions = Vec::<(Segment, SegmentContribution)>::new();
    for triangle in &group.triangles {
        let distances = triangle
            .points
            .map(|point| (point - basis.origin).dot(normal));
        let above = distances.map(|distance| distance > 0.0);
        if above[0] == above[1] && above[1] == above[2] {
            continue;
        }
        let mut points = Vec::with_capacity(2);
        for (start, end) in [(0, 1), (1, 2), (2, 0)] {
            if above[start] != above[end] {
                points.push(quantize(
                    basis,
                    crossing(
                        (triangle.points[start], distances[start]),
                        (triangle.points[end], distances[end]),
                    ),
                    plane_index,
                    triangle.source,
                )?);
            }
        }
        if points[0] == points[1] {
            continue;
        }
        let segment = ordered_segment(points[0], points[1]);
        contributions.push((
            segment,
            SegmentContribution {
                source: triangle.source,
                base_color: triangle.base_color,
                true_cut: true,
                length: segment_length(segment),
            },
        ));
    }
    Ok(group_contributions(contributions))
}

/// Sort cut contributions by segment, keeping triangle order within one
/// segment, and gather each segment's contributions.
fn group_contributions(
    mut contributions: Vec<(Segment, SegmentContribution)>,
) -> SegmentContributions {
    contributions.sort_by_key(|entry| entry.0);
    contributions
        .chunk_by(|left, right| left.0 == right.0)
        .map(|values| (values[0].0, values.iter().map(|entry| entry.1).collect()))
        .collect()
}

fn crossing(left: (Vec3, f32), right: (Vec3, f32)) -> Vec3 {
    let ((start, start_distance), (end, end_distance)) =
        if compare_position(left.0, right.0).is_le() {
            (left, right)
        } else {
            (right, left)
        };
    if start_distance == 0.0 {
        start
    } else if end_distance == 0.0 {
        end
    } else {
        start.lerp(end, start_distance / (start_distance - end_distance))
    }
}

struct CutLoops {
    rings: Vec<IntContour<i64>>,
    open: Vec<Segment>,
    /// Connected components of `open`, in order of their lowest point.
    chains: Vec<Vec<Segment>>,
}

/// Split a welded cut graph into closed loops and open chains. Dangling
/// chains are peeled off first, so a loop with a tail still fills; what
/// remains goes through [`closed_rings`], whose branched faces fill too, and
/// any branched segment on no face stays open.
fn cut_loops(
    segments: &[Segment],
    plane_index: usize,
    source: PrimitiveRef,
) -> Result<CutLoops, RenderError> {
    let mut adjacency = BTreeMap::<Point, BTreeSet<Point>>::new();
    for &(a, b) in segments {
        adjacency.entry(a).or_default().insert(b);
        adjacency.entry(b).or_default().insert(a);
    }
    let mut open = Vec::new();
    let mut leaves = adjacency
        .iter()
        .filter(|(_, neighbors)| neighbors.len() == 1)
        .map(|(point, _)| *point)
        .collect::<Vec<_>>();
    while let Some(point) = leaves.pop() {
        // Degrees only fall and an emptied point is removed, so a point still
        // present here has exactly its one neighbour.
        let Some(neighbors) = adjacency.remove(&point) else {
            continue;
        };
        let next = *neighbors.first().expect("leaf has a neighbour");
        open.push(ordered_segment(point, next));
        let neighbors = adjacency.get_mut(&next).expect("undirected adjacency");
        neighbors.remove(&point);
        match neighbors.len() {
            0 => {
                adjacency.remove(&next);
            }
            1 => leaves.push(next),
            _ => {}
        }
    }
    let core = adjacency
        .iter()
        .flat_map(|(a, neighbors)| {
            neighbors
                .iter()
                .filter(move |b| a < *b)
                .map(move |b| (*a, *b))
        })
        .collect::<Vec<_>>();
    let (rings, branched) = closed_rings(&core)
        .map_err(|()| cap_error(plane_index, source, "fixed-point winding overflow"))?;
    if !branched.is_empty() {
        let faces = rings
            .iter()
            .flat_map(contour_segments)
            .collect::<BTreeSet<_>>();
        open.extend(
            branched
                .into_iter()
                .filter(|segment| !faces.contains(segment)),
        );
    }
    open.sort_unstable();
    open.dedup();
    let mut points = open.iter().flat_map(|&(a, b)| [a, b]).collect::<Vec<_>>();
    points.sort_unstable();
    points.dedup();
    let mut chains = DisjointSet::new(points.len());
    for &(a, b) in &open {
        chains.union(
            points.binary_search(&a).expect("chain point"),
            points.binary_search(&b).expect("chain point"),
        );
    }
    let mut chain_of = vec![usize::MAX; points.len()];
    let mut grouped = Vec::<Vec<Segment>>::new();
    for &segment in &open {
        let root = chains.find(points.binary_search(&segment.0).expect("chain point"));
        if chain_of[root] == usize::MAX {
            chain_of[root] = grouped.len();
            grouped.push(Vec::new());
        }
        grouped[chain_of[root]].push(segment);
    }
    Ok(CutLoops {
        rings,
        open,
        chains: grouped,
    })
}

type ShapeBounds = Option<(i64, i64, i64, i64)>;

fn shape_bounds(shapes: &IntShapes<i64>) -> ShapeBounds {
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
}

fn bounds_overlap(left: ShapeBounds, right: ShapeBounds) -> bool {
    let (Some(left), Some(right)) = (left, right) else {
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
    // Only edges that touch the plane are kept, in edge order, and only their
    // triangles are visited: a triangle none of whose edges touch the plane
    // yields no cut point.
    let mut hits = Vec::<(usize, EdgeHit)>::new();
    let mut touched = Vec::new();
    for (index, edge) in group.edges.iter().enumerate() {
        let hit = edge_hit(*edge, basis, normal, epsilon, plane_index)?;
        if !matches!(hit, EdgeHit::None) {
            touched.extend(edge.triangles);
            hits.push((index, hit));
        }
    }
    touched.sort_unstable();
    touched.dedup();
    let mut contributions = Vec::<(Segment, SegmentContribution)>::new();
    for triangle in touched.into_iter().map(|index| &group.triangles[index]) {
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
            match hits
                .binary_search_by_key(&edge, |entry| entry.0)
                .map(|index| &hits[index].1)
            {
                Err(_) | Ok(EdgeHit::None) => {}
                Ok(EdgeHit::Point(point)) => {
                    points.push(*point);
                }
                Ok(EdgeHit::Coplanar(a, b)) => {
                    points.push(*a);
                    points.push(*b);
                }
            }
        }
        points.sort_unstable();
        points.dedup();
        // A thin triangle's cut can quantize to one point, or a vertex within
        // tolerance can add a third; neither is a cut segment.
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
    let segments = group_contributions(contributions);
    let has_retained = group.triangles.iter().any(|triangle| {
        triangle
            .points
            .iter()
            .any(|point| (*point - basis.origin).dot(normal) > epsilon)
    });
    let has_removed = group.triangles.iter().any(|triangle| {
        triangle
            .points
            .iter()
            .any(|point| (*point - basis.origin).dot(normal) < -epsilon)
    });
    let rings = if has_retained && has_removed {
        trace_cut_rings(group, basis, normal, plane_index)?
    } else {
        Vec::new()
    };
    Ok((segments, rings, fallback.base_color))
}

fn trace_cut_rings(
    group: &SurfaceGroup,
    basis: Basis,
    normal: Vec3,
    plane_index: usize,
) -> Result<Vec<IntContour<i64>>, RenderError> {
    // Crossed edges in edge order; only their triangles can carry the cut.
    let mut crossings = Vec::<(usize, Point)>::new();
    let mut crossed_triangles = Vec::new();
    for (index, edge) in group.edges.iter().enumerate() {
        if let Some(point) = half_open_hit(*edge, basis, normal, plane_index)? {
            crossings.push((index, point));
            crossed_triangles.extend(edge.triangles);
        }
    }
    let hit = |edge: usize| {
        crossings
            .binary_search_by_key(&edge, |entry| entry.0)
            .ok()
            .map(|index| crossings[index].1)
    };
    crossed_triangles.sort_unstable();
    crossed_triangles.dedup();
    crossed_triangles.retain(|triangle| *triangle < group.triangles.len());
    let mut cut_edges = BTreeMap::<usize, [usize; 2]>::new();
    for triangle in crossed_triangles {
        let crossed = group.triangles[triangle]
            .edges
            .into_iter()
            .filter(|edge| hit(*edge).is_some())
            .collect::<Vec<_>>();
        match crossed.as_slice() {
            [first, second] => {
                cut_edges.insert(triangle, [*first, *second]);
            }
            _ => {
                return Err(cap_error(
                    plane_index,
                    group.triangles[triangle].source,
                    format!("triangle produced {} half-open edges", crossed.len()),
                ));
            }
        }
    }

    let mut unseen = cut_edges.keys().copied().collect::<BTreeSet<_>>();
    let mut rings = Vec::<IntContour<i64>>::new();
    while let Some(start) = unseen.pop_first() {
        let source = group.triangles[start].source;
        let [mut incoming, _] = cut_edges[&start];
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
            ring.push(hit(incoming).expect("cut edge has an intersection"));
            // `triangle` was just taken from `unseen`, the keys of `cut_edges`.
            let [first, second] = cut_edges[&triangle];
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
        // A loop smaller than the fixed-point quantum has no area to cap.
        if ring.len() < 3 {
            continue;
        }
        if signed_area_points(&ring)
            .map_err(|()| cap_error(plane_index, source, "fixed-point winding overflow"))?
            < 0
        {
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
    let cut = shape.iter().flat_map(contour_segments).collect::<Vec<_>>();
    dominant(&cut, segments).map(|(_, color)| color)
}

/// The source, with its colour, that contributes the most cut length to
/// `cut`; ties go to the lowest source.
fn dominant(cut: &[Segment], segments: &SegmentContributions) -> Option<(PrimitiveRef, [f32; 4])> {
    let mut totals = Vec::<(PrimitiveRef, [f32; 4], f64)>::new();
    for &segment in cut {
        let Some(index) = segments
            .binary_search_by_key(&segment, |entry| entry.0)
            .ok()
        else {
            continue;
        };
        for contribution in &segments[index].1 {
            if let Some(entry) = totals
                .iter_mut()
                .find(|entry| entry.0 == contribution.source)
            {
                entry.2 += contribution.length;
            } else {
                totals.push((
                    contribution.source,
                    contribution.base_color,
                    contribution.length,
                ));
            }
        }
    }
    totals
        .into_iter()
        .max_by(|left, right| {
            left.2
                .total_cmp(&right.2)
                .then_with(|| source_key(right.0).cmp(&source_key(left.0)))
        })
        .map(|(source, color, _)| (source, color))
}

/// Closed degree-two components become rings; a branched component yields its
/// bounded faces as rings and all of its segments as open. `segments` are
/// `(low, high)` ordered and sorted, which fixes the order of the open list.
fn closed_rings(segments: &[Segment]) -> Result<(Vec<IntContour<i64>>, Vec<Segment>), ()> {
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
            rings.extend(bounded_faces(&component, &adjacency)?);
            // Callers pass sorted `(low, high)` segments, so walking the
            // component's points in order and each point's higher neighbours
            // lists its segments in input order without rescanning `segments`.
            open.extend(component.iter().flat_map(|&point| {
                adjacency[&point]
                    .range((Bound::Excluded(point), Bound::Unbounded))
                    .map(move |&next| (point, next))
            }));
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
        if signed_area(&ring)? < 0 {
            ring.reverse();
        }
        rings.push(ring);
    }
    Ok((rings, open))
}

fn bounded_faces(
    component: &BTreeSet<Point>,
    adjacency: &BTreeMap<Point, BTreeSet<Point>>,
) -> Result<Vec<IntContour<i64>>, ()> {
    let mut visited = BTreeSet::<(Point, Point)>::new();
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
                visited.insert(edge);
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
            if !closed || face.len() < 3 || signed_area_points(&face)? <= 0 {
                continue;
            }
            faces.push(canonical_ring(face));
        }
    }
    faces.sort();
    faces.dedup();
    Ok(faces
        .into_iter()
        .map(|face| {
            face.into_iter()
                .map(|point| IntPoint::new(point.0, point.1))
                .collect()
        })
        .collect())
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

fn signed_area(contour: &IntContour<i64>) -> Result<i128, ()> {
    signed_area_points(&contour.iter().copied().map(point).collect::<Vec<_>>())
}

fn signed_area_points(points: &[Point]) -> Result<i128, ()> {
    points
        .iter()
        .zip(points.iter().cycle().skip(1))
        .take(points.len())
        .try_fold(0_i128, |area, (left, right)| {
            let positive = (left.0 as i128).checked_mul(right.1 as i128)?;
            let negative = (right.0 as i128).checked_mul(left.1 as i128)?;
            area.checked_add(positive.checked_sub(negative)?)
        })
        .ok_or(())
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
        output.vertices.extend_from_slice(&axis);
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

fn append_contour(output: &mut Vec<f32>, basis: Basis, contour: &IntContour<i64>) {
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

fn append_segments(output: &mut Vec<f32>, basis: Basis, segments: &[Segment]) {
    for &(a, b) in segments {
        append_segment(output, basis, a, b);
    }
}

fn append_segment(output: &mut Vec<f32>, basis: Basis, a: Point, b: Point) {
    for point in [a, b] {
        let world = basis.origin
            + basis.u * (point.0 as f32 / PRECISION as f32)
            + basis.v * (point.1 as f32 / PRECISION as f32);
        output.extend_from_slice(&world.to_array());
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

pub(crate) fn srgb_hex(hex: u32) -> [f32; 4] {
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
            surface_attributes: Vec::new(),
            material: glb::Material {
                base_color,
                metallic: 0.0,
                roughness: 1.0,
                ..crate::glb::Material::default()
            },
        }
    }

    fn cube_scene(instance_count: usize) -> glb::Scene {
        glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                manifold: None,
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
            topology_diagnostics: Vec::new(),
            texture_pixels: vec![u32::MAX],
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
                manifold: None,
                primitives: vec![first, second],
            }],
            instances: vec![glb::MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::IDENTITY,
                normal_matrix: Mat4::IDENTITY,
            }],
            topology_diagnostics: Vec::new(),
            texture_pixels: vec![u32::MAX],
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
            surface_attributes: Vec::new(),
            material: glb::Material {
                base_color: [0.5, 0.5, 0.5, 1.0],
                metallic: 0.0,
                roughness: 1.0,
                ..crate::glb::Material::default()
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

    /// Outward-oriented faces of the unit tetrahedron.
    const TETRA_INDICES: [u32; 12] = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];

    /// `(origin, scale, inverted)` shells merged into a single primitive.
    fn tetra_shells(shells: &[(Vec3, f32, bool)]) -> glb::Primitive {
        let mut positions = Vec::with_capacity(shells.len() * 12);
        let mut indices = Vec::with_capacity(shells.len() * 12);
        for &(origin, scale, inverted) in shells {
            let base = u32::try_from(positions.len() / 3).expect("small fixture");
            for corner in [Vec3::ZERO, Vec3::X, Vec3::Y, Vec3::Z] {
                positions.extend_from_slice(&(origin + corner * scale).to_array());
            }
            for face in TETRA_INDICES.as_chunks::<3>().0 {
                let mut face = face.map(|index| index + base);
                if inverted {
                    face.swap(1, 2);
                }
                indices.extend_from_slice(&face);
            }
        }
        glb::Primitive {
            source_index: 0,
            mode: MODE_TRIANGLES,
            normals: positions.clone(),
            positions,
            indices,
            surface_attributes: Vec::new(),
            material: glb::Material {
                base_color: [0.5; 4],
                metallic: 0.0,
                roughness: 1.0,
                ..crate::glb::Material::default()
            },
        }
    }

    fn shell_scene(instance_count: usize, shells: &[(Vec3, f32, bool)]) -> glb::Scene {
        glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                manifold: None,
                primitives: vec![tetra_shells(shells)],
            }],
            instances: (0..instance_count)
                .map(|source_node_index| glb::MeshInstance {
                    source_node_index,
                    mesh_index: 0,
                    model: Mat4::IDENTITY,
                    normal_matrix: Mat4::IDENTITY,
                })
                .collect(),
            topology_diagnostics: Vec::new(),
            texture_pixels: vec![u32::MAX],
            bounds: None,
        }
    }

    /// `count` unit tetrahedra on a grid starting at `first`.
    fn shell_grid(count: usize, first: Vec3) -> Vec<(Vec3, f32, bool)> {
        (0..count)
            .map(|index| {
                (
                    first + Vec3::new(0.0, (index % 64) as f32, (index / 64) as f32) * 2.0,
                    1.0,
                    false,
                )
            })
            .collect()
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

    fn open_box_scene() -> glb::Scene {
        // The unit cube without its z = +1 face (triangles 4, 5, 6 and 4, 6, 7).
        let mut scene = cube_scene(1);
        scene.meshes[0].primitives[0].indices.drain(6..12);
        scene
    }

    #[test]
    fn open_surfaces_fill_closed_loops_and_outline_open_chains() {
        // Cutting across the missing face leaves a U-shaped open chain and no
        // fill.
        let first = build(&open_box_scene(), &section_options()).expect("open box");
        let second = build(&open_box_scene(), &section_options()).expect("repeat open box");
        assert!(first.indices.is_empty());
        assert!(first.boundaries.is_empty());
        assert_eq!(first.open_chains.len() / 6, 6);
        assert_eq!(first.open_chains, second.open_chains);
        assert_eq!(
            first.sources,
            vec![SectionSourceReport {
                plane: 0,
                source: TEST_SOURCE,
                certified: false,
                closed_loops: 0,
                open_chains: 1,
            }]
        );

        // Cutting below the opening closes the loop, so it is filled like a
        // certified cap would be, outline and all.
        let mut across = section_options();
        across.sections.as_mut().expect("sections").planes[0] = SectionPlane {
            point: [0.0; 3],
            normal: [0.0, 0.0, -1.0],
        };
        let geometry = build(&open_box_scene(), &across).expect("closed loop of an open box");
        assert!((cap_area(&geometry) - 4.0).abs() < 1.0e-4);
        assert!(geometry.open_chains.is_empty());
        assert_eq!(geometry.boundaries.len() / 6, 4);
        assert_eq!(
            geometry.sources,
            vec![SectionSourceReport {
                plane: 0,
                source: TEST_SOURCE,
                certified: false,
                closed_loops: 1,
                open_chains: 0,
            }]
        );
    }

    #[test]
    fn direct_slices_weld_vertices_on_the_plane_and_drop_collapsed_cuts() {
        // A vertex exactly on the plane is the crossing point of both of its
        // edges, whichever side of the position order it falls on.
        let fan = triangle_scene(
            vec![0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            vec![0, 1, 2],
        );
        for normal in [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]] {
            let mut options = section_options();
            options.sections.as_mut().expect("sections").planes[0].normal = normal;
            let geometry = build(&fan, &options).expect("vertex on plane");
            assert_eq!(geometry.open_chains.len() / 6, 1, "normal {normal:?}");
            assert!(
                geometry
                    .open_chains
                    .as_chunks::<3>()
                    .0
                    .contains(&[0.0, 0.0, 0.0])
            );
        }
        assert_eq!(
            crossing((Vec3::X, 0.0), (Vec3::NEG_X, 1.0)),
            Vec3::X,
            "a zero-distance end is its own crossing"
        );

        // A sliver whose two crossings quantize to one point has no segment.
        let sliver = triangle_scene(
            vec![-1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0e-12, 0.0],
            vec![0, 1, 2],
        );
        let geometry = build(&sliver, &section_options()).expect("collapsed cut");
        assert!(geometry.open_chains.is_empty() && geometry.sources.is_empty());

        // A primitive without positions has nothing to cut.
        let empty = triangle_scene(Vec::new(), Vec::new());
        assert!(
            build(&empty, &section_options())
                .expect("empty primitive")
                .sources
                .is_empty()
        );
    }

    #[test]
    fn cut_loops_peel_tails_and_fill_branched_faces() {
        let square = [
            ((0, 0), (10, 0)),
            ((10, 0), (10, 10)),
            ((0, 10), (10, 10)),
            ((0, 0), (0, 10)),
        ];
        // A loop with a two-segment tail, and a lone segment elsewhere.
        let mut tailed = square.to_vec();
        tailed.extend([
            ((10, 10), (20, 20)),
            ((20, 20), (30, 20)),
            ((50, 50), (60, 50)),
        ]);
        tailed.sort_unstable();
        let loops = cut_loops(&tailed, 0, TEST_SOURCE).expect("tailed loop");
        assert_eq!(loops.rings.len(), 1);
        assert_eq!(
            loops.open,
            vec![
                ((10, 10), (20, 20)),
                ((20, 20), (30, 20)),
                ((50, 50), (60, 50))
            ]
        );
        assert_eq!(loops.chains.len(), 2);

        // A chord splits the square into two faces, both filled, none open.
        let mut theta = square.to_vec();
        theta.push(((0, 0), (10, 10)));
        theta.sort_unstable();
        let loops = cut_loops(&theta, 0, TEST_SOURCE).expect("theta");
        assert_eq!(loops.rings.len(), 2);
        assert!(loops.open.is_empty());
        assert_eq!(loops.chains.len(), 0);

        // Two squares joined by a bridge: both fill, the bridge stays open.
        let mut dumbbell = square.to_vec();
        dumbbell.extend([
            ((10, 0), (20, 0)),
            ((20, 0), (30, 0)),
            ((30, 0), (30, 10)),
            ((20, 10), (30, 10)),
            ((20, 0), (20, 10)),
        ]);
        dumbbell.sort_unstable();
        let loops = cut_loops(&dumbbell, 0, TEST_SOURCE).expect("dumbbell");
        assert_eq!(loops.rings.len(), 2);
        assert_eq!(loops.open, vec![((10, 0), (20, 0))]);
        assert_eq!(loops.chains.len(), 1);
    }

    #[test]
    fn groups_outside_the_plane_and_untraceable_exact_cuts_are_tolerated() {
        // The plane clips the tetrahedron's bounding box but not the solid:
        // both the exact and the direct path return nothing.
        let corner = SectionPlane {
            point: [0.9; 3],
            normal: [1.0, 1.0, 1.0],
        };
        let mut options = section_options();
        options.sections.as_mut().expect("sections").planes[0] = corner;
        let closed = shell_scene(1, &[(Vec3::ZERO, 1.0, false)]);
        let mut open = closed.clone();
        open.meshes[0].primitives[0].indices.truncate(9);
        for scene in [closed, open] {
            let geometry = build(&scene, &options).expect("bounds-only reach");
            assert!(geometry.indices.is_empty() && geometry.sources.is_empty());
        }

        // A certified group whose half-edge walk breaks is sliced directly.
        let corrupt = SurfaceGroup {
            owner: 0,
            certified: true,
            bounds: (Vec3::splat(-1.0e30), Vec3::splat(1.0e30)),
            edges: vec![
                crossing_edge((0, 0), [0, 0]),
                crossing_edge((10, 0), [0, 0]),
                crossing_edge((0, 10), [0, 0]),
            ],
            triangles: vec![Triangle {
                points: [Vec3::new(-1.0, 0.0, 0.0), Vec3::new(1.0, 0.0, 0.0), Vec3::Y],
                ..test_triangle([0, 1, 2])
            }],
        };
        let mut output = CapGeometry::default();
        build_plane(
            &SectionTopology {
                groups: vec![corrupt],
            },
            &SectionPlane {
                point: [0.0; 3],
                normal: [1.0, 0.0, 0.0],
            },
            0,
            1.0e-6,
            &mut output,
        )
        .expect("corrupt exact cut falls back");
        assert_eq!(
            output.sources,
            vec![SectionSourceReport {
                plane: 0,
                source: TEST_SOURCE,
                certified: false,
                closed_loops: 0,
                open_chains: 1,
            }]
        );
    }

    #[test]
    fn primitives_sliced_together_report_their_own_loops_and_chains() {
        // Two open triangles in one instance fail admission alone and are
        // sliced together; each chain is reported under its own primitive.
        let mut scene = triangle_scene(
            vec![-1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            vec![0, 1, 2],
        );
        let mut second = triangle_primitive(
            vec![-1.0, 3.0, 0.0, 1.0, 3.0, 0.0, 1.0, 4.0, 0.0],
            vec![0, 1, 2],
        );
        second.source_index = 1;
        scene.meshes[0].primitives.push(second);
        let geometry = build(&scene, &section_options()).expect("two open primitives");
        let report = |primitive_index| SectionSourceReport {
            plane: 0,
            source: PrimitiveRef {
                primitive_index,
                ..TEST_SOURCE
            },
            certified: false,
            closed_loops: 0,
            open_chains: 1,
        };
        assert_eq!(geometry.sources, vec![report(0), report(1)]);
    }

    #[test]
    fn primitives_that_certify_alone_stay_exact_when_their_instance_fails() {
        // A cube and an inverted cube touching its wall, as two primitives:
        // together their ownership is ambiguous, but each certifies alone.
        let mut scene = cube_scene(1);
        let mut touching = cube_primitive(1, Vec3::X * 0.7, 0.3, [0.5; 4]);
        for triangle in touching.indices.as_chunks_mut::<3>().0 {
            triangle.swap(1, 2);
        }
        scene.meshes[0].primitives.push(touching);
        let mut options = section_options();
        options.sections.as_mut().expect("sections").planes[0].point = [0.7, 0.0, 0.0];
        let geometry = build(&scene, &options).expect("per-primitive admission");
        assert!(geometry.sources.iter().all(|report| report.certified));
        assert_eq!(geometry.sources.len(), 2);
        assert!(geometry.open_chains.is_empty());

        let crossing = [Some((0, 0, 2, 2)), Some((1, 1, 3, 3))];
        assert_eq!(overlap_candidates(&crossing, 1), vec![(0, 1)]);
        assert!(overlap_candidates(&crossing, 0).is_empty());
    }

    #[test]
    fn segments_form_closed_rings_but_branches_remain_outlines() {
        let square = vec![
            ((0, 0), (10, 0)),
            ((10, 0), (10, 10)),
            ((0, 10), (10, 10)),
            ((0, 0), (0, 10)),
        ];
        let (rings, open) = closed_rings(&square).expect("square winding");
        assert_eq!(rings.len(), 1);
        assert!(open.is_empty());

        let mut branch = square;
        branch.push(((10, 10), (20, 10)));
        let (rings, open) = closed_rings(&branch).expect("branch winding");
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
        let (rings, open) = closed_rings(&dumbbell).expect("dumbbell winding");
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
    fn racing_drone_section_request_certifies_nonzero_cap_triangles() {
        let (options, _) = crate::options::RenderRequest::from_json(
            r#"{
                "width":64,
                "height":64,
                "format":"raw",
                "world":{"up":"+z","forward":"-y","unit":"meter"},
                "sections":{"planes":[{"point":[0,0,0],"normal":[1,0,0]}]}
            }"#,
        )
        .and_then(|request| request.resolve())
        .expect("racing drone section request");
        let scene = glb::parse_glb_for_sections(include_bytes!(
            "../../../tests/fixtures/racing-drone-section-repro.glb"
        ))
        .expect("racing drone fixture");
        assert!(
            scene.topology_diagnostics.is_empty(),
            "{:?}",
            scene.topology_diagnostics
        );

        let geometry = build(&scene, &options).expect("certified racing drone section");
        assert!(geometry.indices.len() / 3 > 0);
        assert_eq!(geometry.indices.len() % 3, 0);
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

        let topology = build_topology(
            &scene,
            &section_options(),
            1.0e-6,
            &section_options().sections.expect("sections").planes,
        )
        .expect("nested shells");
        assert_eq!(topology.groups.len(), 3);
        assert_eq!(topology.groups[1].owner, topology.groups[2].owner);
        assert_ne!(topology.groups[0].owner, topology.groups[2].owner);
    }

    #[test]
    fn a_shell_inside_another_shells_bounds_but_outside_its_solid_keeps_its_own_owner() {
        // An inverted cube sits inside the tetrahedron's bounding box but
        // outside the tetrahedron, so ray casting rejects the containment.
        let mut scene = shell_scene(1, &[(Vec3::ZERO, 4.0, false)]);
        let mut cavity = cube_primitive(0, Vec3::splat(3.0), 0.2, [0.5; 4]);
        for triangle in cavity.indices.as_chunks_mut::<3>().0 {
            triangle.swap(1, 2);
        }
        let primitive = &mut scene.meshes[0].primitives[0];
        let offset = u32::try_from(primitive.positions.len() / 3).expect("small fixture");
        primitive.positions.extend_from_slice(&cavity.positions);
        primitive.normals.extend_from_slice(&cavity.normals);
        primitive
            .indices
            .extend(cavity.indices.into_iter().map(|index| index + offset));
        let mut options = section_options();
        options.sections.as_mut().expect("sections").planes[0].point = [0.5, 0.0, 0.0];
        let topology = build_topology(
            &scene,
            &options,
            1.0e-6,
            &options.sections.clone().expect("sections").planes,
        )
        .expect("separate shells");
        assert_eq!(topology.groups.len(), 2);
        assert!(topology.groups.iter().all(|group| group.certified));
        assert_ne!(topology.groups[0].owner, topology.groups[1].owner);
    }

    #[test]
    fn touching_shell_ownership_falls_back_to_direct_slices() {
        let mut scene = cube_scene(1);
        let mut touching = cube_primitive(0, Vec3::X * 0.7, 0.3, [0.5; 4]);
        for triangle in touching.indices.as_chunks_mut::<3>().0 {
            triangle.swap(1, 2);
        }
        let primitive = &mut scene.meshes[0].primitives[0];
        let offset = u32::try_from(primitive.positions.len() / 3).expect("small fixture");
        primitive.positions.extend_from_slice(&touching.positions);
        primitive.normals.extend_from_slice(&touching.normals);
        primitive
            .indices
            .extend(touching.indices.into_iter().map(|index| index + offset));

        let mut options = section_options();
        options.sections.as_mut().expect("sections").planes[0].point = [0.7, 0.0, 0.0];
        let geometry = build(&scene, &options).expect("touching cavity is sliced");
        // The outer square less the cavity square, by the even-odd rule.
        assert!((cap_area(&geometry) - (4.0 - 0.36)).abs() < 1.0e-4);
        assert_eq!(
            geometry.sources,
            vec![SectionSourceReport {
                plane: 0,
                source: TEST_SOURCE,
                certified: false,
                closed_loops: 2,
                open_chains: 0,
            }]
        );
    }

    #[test]
    fn section_tolerance_uses_only_eligible_surfaces() {
        let mut hidden = cube_scene(1);
        hidden.meshes[0]
            .primitives
            .push(cube_primitive(1, Vec3::splat(1.0e9), 1.0, [0.5; 4]));
        hidden.bounds = Some(([-1.0; 3], [1.0e9; 3]));
        let mut selected = section_options();
        selected.visible_primitives = Some(vec![PrimitiveRef {
            node_index: 0,
            mesh_index: 0,
            primitive_index: 0,
        }]);
        assert!(
            !build(&hidden, &selected)
                .expect("selected solid")
                .indices
                .is_empty()
        );

        let mut with_line = cube_scene(1);
        with_line.meshes[0].primitives.push(glb::Primitive {
            source_index: 1,
            mode: glb::MODE_LINES,
            positions: vec![1.0e9, 0.0, 0.0, 1.0e9, 1.0, 0.0],
            normals: Vec::new(),
            indices: vec![0, 1],
            surface_attributes: Vec::new(),
            material: glb::Material {
                base_color: [0.5; 4],
                metallic: 0.0,
                roughness: 1.0,
                ..crate::glb::Material::default()
            },
        });
        with_line.bounds = Some(([-1.0; 3], [1.0e9, 1.0, 1.0]));
        assert!(
            !build(&with_line, &section_options())
                .expect("line bounds excluded")
                .indices
                .is_empty()
        );
    }

    #[test]
    fn a_degenerate_triangle_with_distinct_indices_is_kept() {
        // A zero-area triangle elsewhere neither rejects nor changes the cap.
        let mut scene = cube_scene(1);
        let mut degenerate = triangle_primitive(
            vec![2.0, 0.0, 0.0, 2.0, 1.0, 0.0, 2.0, 2.0, 0.0],
            vec![0, 1, 2],
        );
        degenerate.source_index = 1;
        scene.meshes[0].primitives.push(degenerate);
        // A second instance beyond the plane is never collected or certified.
        scene.instances.push(glb::MeshInstance {
            source_node_index: 1,
            mesh_index: 0,
            model: Mat4::from_translation(Vec3::X * 5.0),
            normal_matrix: Mat4::IDENTITY,
        });
        let with_sliver = build(&scene, &section_options()).expect("degenerate kept");
        let plain = build(&cube_scene(1), &section_options()).expect("plain cube");
        assert_eq!(with_sliver.vertices, plain.vertices);
        assert_eq!(with_sliver.indices, plain.indices);
        assert_eq!(with_sliver.boundaries, plain.boundaries);

        // A sliver inside a closed surface keeps it certified: split one cube
        // face's diagonal at a point a hair off the edge.
        let mut slivered = cube_scene(1);
        let primitive = &mut slivered.meshes[0].primitives[0];
        primitive.positions.extend_from_slice(&[0.0, 1.0e-9, -1.0]);
        primitive.normals.extend_from_slice(&[0.0, 0.0, -1.0]);
        // Face z = -1 was (0, 2, 1) and (0, 3, 2); its diagonal 0-2 now runs
        // through vertex 8, which leaves a sliver (0, 8, 2) on its own.
        primitive
            .indices
            .splice(0..6, [0, 8, 1, 8, 2, 1, 0, 3, 2, 0, 2, 8]);
        let geometry = build(&slivered, &section_options()).expect("slivered cube");
        assert!((cap_area(&geometry) - 4.0).abs() < 1.0e-4);
        assert_eq!(
            geometry.sources,
            vec![SectionSourceReport {
                plane: 0,
                source: TEST_SOURCE,
                certified: true,
                closed_loops: 1,
                open_chains: 0,
            }]
        );
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
        for normal in [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]] {
            tangent_options.sections.as_mut().expect("sections").planes[0].normal = normal;
            let tangent = build(&cube_scene(1), &tangent_options).expect("tangent outline");
            assert!(tangent.indices.is_empty(), "normal {normal:?}");
            assert_eq!(tangent.boundaries.len() / 6, 4, "normal {normal:?}");
        }

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
    fn topology_admission_failures_fall_back_to_direct_slices() {
        let duplicate_triangles = |count: usize, reverse: bool| glb::Scene {
            meshes: vec![glb::MeshAsset {
                source_index: 0,
                manifold: None,
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
            topology_diagnostics: Vec::new(),
            texture_pixels: vec![u32::MAX],
            bounds: Some(([0.0; 3], [1.0; 3])),
        };
        // Same-direction and ambiguous seams lying in the plane: sliced,
        // and with nothing crossing the plane there is nothing to draw.
        for (count, reverse) in [(2, false), (4, true)] {
            let geometry = build(&duplicate_triangles(count, reverse), &section_options())
                .expect("seam failures are sliced");
            assert!(geometry.indices.is_empty() && geometry.open_chains.is_empty());
        }

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

        // An open primitive beside a closed one costs the closed one nothing.
        let plain = build(&cube_scene(1), &section_options()).expect("plain cube");
        let mut partial = cube_scene(1);
        let mut open = triangle_primitive(
            vec![-1.0, 3.0, 0.0, 1.0, 3.0, 0.0, 1.0, 4.0, 0.0],
            vec![0, 1, 2],
        );
        open.source_index = 1;
        partial.meshes[0].primitives.push(open);
        let geometry = build(&partial, &section_options()).expect("partial caps");
        assert_eq!(geometry.vertices, plain.vertices);
        assert_eq!(geometry.indices, plain.indices);
        assert_eq!(geometry.boundaries, plain.boundaries);
        assert_eq!(geometry.open_chains.len() / 6, 1);
        let open_source = PrimitiveRef {
            primitive_index: 1,
            ..TEST_SOURCE
        };
        assert_eq!(
            geometry.sources,
            vec![
                SectionSourceReport {
                    plane: 0,
                    source: TEST_SOURCE,
                    certified: true,
                    closed_loops: 1,
                    open_chains: 0,
                },
                SectionSourceReport {
                    plane: 0,
                    source: open_source,
                    certified: false,
                    closed_loops: 0,
                    open_chains: 1,
                },
            ]
        );

        // Two cubes sharing one vertex have a pinched vertex link; the direct
        // slice still finds the first cube's closed loop.
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
        let first = build(&bow_tie, &section_options()).expect("pinched solids");
        let second = build(&bow_tie, &section_options()).expect("repeat pinched solids");
        assert!((cap_area(&first) - 4.0).abs() < 1.0e-4);
        assert_eq!(first.vertices, second.vertices);
        assert_eq!(first.indices, second.indices);
        assert_eq!(first.boundaries.len() / 6, 4);
        assert_eq!(
            first.sources,
            vec![SectionSourceReport {
                plane: 0,
                source: TEST_SOURCE,
                certified: false,
                closed_loops: 1,
                open_chains: 0,
            }]
        );
    }

    #[test]
    fn only_malformed_indices_and_positions_fail_admission() {
        let error = |scene: &glb::Scene| {
            build(scene, &section_options())
                .expect_err("malformed topology")
                .to_string()
        };

        let mut incomplete = cube_scene(1);
        incomplete.meshes[0].primitives[0].indices.pop();
        assert!(error(&incomplete).contains("incomplete triangle index list"));

        let mut missing = cube_scene(1);
        missing.meshes[0].primitives[0].indices[0] = u32::MAX;
        assert!(error(&missing).contains("missing vertex"));

        // An index-collapsed triangle is skipped; the face it covered is now
        // a hole the cut runs through, which shows as one open chain.
        let mut collapsed = cube_scene(1);
        collapsed.meshes[0].primitives[0].indices[1] = collapsed.meshes[0].primitives[0].indices[0];
        let geometry = build(&collapsed, &section_options()).expect("collapsed triangle");
        assert_eq!(
            geometry.sources,
            vec![SectionSourceReport {
                plane: 0,
                source: TEST_SOURCE,
                certified: false,
                closed_loops: 0,
                open_chains: 1,
            }]
        );
        assert!(geometry.indices.is_empty());

        let non_manifold = triangle_scene(
            vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2, 0, 1, 2],
        );
        assert!(build(&non_manifold, &section_options()).is_ok());

        let collapsed_seam = triangle_scene(
            vec![0.0, 0.0, 0.0, 1.0e-9, 0.0, 0.0, 0.0, 1.0, 0.0],
            vec![0, 1, 2],
        );
        let geometry = build(&collapsed_seam, &section_options()).expect("collapsed seam");
        assert!(geometry.indices.is_empty());
    }

    #[test]
    fn seam_clusters_preserve_order_boundaries_and_bounded_chains() {
        // Cross negative/positive cells and every neighbor axis, with duplicates
        // and a chain whose endpoints must not merge through an intermediate.
        let positions = [
            Vec3::new(-0.01, -0.01, -0.01),
            Vec3::new(0.01, 0.01, 0.01),
            Vec3::new(0.01, 0.01, 0.01),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(1.09, 0.0, 0.0),
            Vec3::new(1.18, 0.0, 0.0),
            Vec3::splat(4.0),
        ];
        let vertices = [0, 1, 2, 3, 4, 5];
        let expected = spatial_clusters(&vertices, &positions, 0.1);
        assert_eq!(expected[0], expected[1]);
        assert_eq!(expected[1], expected[2]);
        assert_eq!(expected[3], expected[4]);
        assert_ne!(expected[4], expected[5]);
        assert_ne!(expected[0], expected[3]);
        assert_eq!(expected[6], usize::MAX);
        // New maps have fresh hash seeds on supported hosts. Their iteration
        // order must never select a weld or change the resulting cluster IDs.
        for _ in 0..64 {
            assert_eq!(spatial_clusters(&vertices, &positions, 0.1), expected);
            assert_eq!(
                spatial_clusters(&[5, 2, 0, 4, 1, 3], &positions, 0.1),
                expected
            );
        }
        assert!(spatial_clusters(&[], &[], 0.1).is_empty());
    }

    // Slow reference: enumerate prior points, then order them by cell and
    // insertion index. It deliberately has no cell map or duplicate fast path.
    fn reference_seam_clusters(vertices: &[usize], positions: &[Vec3], epsilon: f32) -> Vec<usize> {
        let mut sorted = vertices.to_vec();
        sorted.sort_by(|a, b| compare_position(positions[*a], positions[*b]).then(a.cmp(b)));
        let mut sets = DisjointSet::new(sorted.len());
        let mut minimum = sorted.iter().map(|v| positions[*v]).collect::<Vec<_>>();
        let mut maximum = minimum.clone();
        for (index, vertex) in sorted.iter().enumerate() {
            let cell = spatial_cell(positions[*vertex], epsilon);
            let mut candidates = sorted[..index]
                .iter()
                .enumerate()
                .filter_map(|(i, v)| {
                    let c = spatial_cell(positions[*v], epsilon);
                    ((c.0 - cell.0).abs() <= 1
                        && (c.1 - cell.1).abs() <= 1
                        && (c.2 - cell.2).abs() <= 1)
                        .then_some((c, i))
                })
                .collect::<Vec<_>>();
            candidates.sort_unstable();
            for (_, candidate) in candidates {
                let left = sets.find(index);
                let right = sets.find(candidate);
                if left != right {
                    let low = minimum[left].min(minimum[right]);
                    let high = maximum[left].max(maximum[right]);
                    if (high - low).length_squared() <= epsilon * epsilon {
                        let root = sets.union(left, right);
                        minimum[root] = low;
                        maximum[root] = high;
                    }
                }
            }
        }
        let mut result = vec![usize::MAX; positions.len()];
        for (index, vertex) in sorted.into_iter().enumerate() {
            result[vertex] = sets.find(index);
        }
        result
    }

    #[test]
    fn duplicate_seams_preserve_exact_roots_under_transforms_and_tolerance_chains() {
        let transforms = [
            Mat4::IDENTITY,
            Mat4::from_translation(Vec3::new(1000.0, -1000.0, 0.0)),
            Mat4::from_scale(Vec3::new(0.001, 1.0, 2.0)),
            Mat4::from_rotation_z(0.73),
            Mat4::from_scale(Vec3::new(-1.0, 1.0, 1.0)),
        ];
        let mut seed = 0x7182_34ab_u32;
        for case in 0..256 {
            let mut points = vec![Vec3::ZERO, Vec3::new(-0.0, 0.0, 0.0)];
            for i in 0..30 {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let p = if i % 3 == 0 {
                    points[(seed as usize) % points.len()]
                } else {
                    Vec3::new(
                        (seed & 15) as f32,
                        ((seed >> 4) & 7) as f32,
                        ((seed >> 7) & 3) as f32,
                    ) * 0.03
                };
                points.push(p);
            }
            for transform in transforms {
                let positions = points
                    .iter()
                    .map(|p| transform.transform_point3(*p))
                    .collect::<Vec<_>>();
                let vertices = (0..positions.len())
                    .rev()
                    .filter(|i| (i + case) % 7 != 0)
                    .collect::<Vec<_>>();
                for radius in [0.03, 0.1, 0.3] {
                    assert_eq!(
                        spatial_clusters(&vertices, &positions, radius),
                        reference_seam_clusters(&vertices, &positions, radius),
                        "case {case}, transform {transform:?}, radius {radius}"
                    );
                }
            }
        }
    }

    #[test]
    fn topology_helpers_bound_clustering_and_regions() {
        assert_eq!(
            bounded_section_work(Some(MAX_QUADRATIC_SECTION_WORK)),
            Some(MAX_QUADRATIC_SECTION_WORK)
        );
        assert_eq!(
            bounded_section_work(Some(MAX_QUADRATIC_SECTION_WORK + 1)),
            None
        );
        assert_eq!(bounded_section_work(usize::MAX.checked_add(1)), None);

        assert!(contains_bounds(
            Vec3::ZERO,
            Vec3::splat(2.0),
            Vec3::ZERO,
            Vec3::ONE,
            0.1,
        ));

        let positions = [Vec3::ZERO, Vec3::splat(0.01), Vec3::ONE];
        let clusters = spatial_clusters(&[0, 1, 2], &positions, 0.1);
        assert_eq!(clusters[0], clusters[1]);
        assert_ne!(clusters[0], clusters[2]);
        let chain = [Vec3::ZERO, Vec3::X * 0.09, Vec3::X * 0.18];
        let clusters = spatial_clusters(&[0, 1, 2], &chain, 0.1);
        assert_eq!(clusters[0], clusters[1]);
        assert_ne!(clusters[0], clusters[2]);

        let mut sets = DisjointSet::new(100_000);
        for index in (1..100_000).rev() {
            sets.union(index, index - 1);
        }
        assert_eq!(sets.find(99_999), sets.find(0));

        let triangle = test_triangle([0, 1, 2]);
        assert!(!vertex_links_are_manifold(&[triangle], &[], &[], 3));

        let square = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(10, 0),
            IntPoint::new(10, 10),
            IntPoint::new(0, 10),
        ]]];
        let empty = IntShapes::new();
        assert!(!bounds_overlap(shape_bounds(&empty), shape_bounds(&square)));
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
        assert!(
            signed_area_points(&[
                (i64::MAX, i64::MAX),
                (i64::MIN, i64::MAX),
                (i64::MIN, i64::MIN),
                (i64::MAX, i64::MIN),
            ])
            .is_err()
        );
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
            certified: true,
            bounds: (Vec3::splat(-1.0e30), Vec3::splat(1.0e30)),
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
            certified: true,
            bounds: (Vec3::splat(-1.0e30), Vec3::splat(1.0e30)),
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
            certified: true,
            bounds: (Vec3::splat(-1.0e30), Vec3::splat(1.0e30)),
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
            certified: true,
            bounds: (Vec3::splat(-1.0e30), Vec3::splat(1.0e30)),
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
            certified: true,
            bounds: (Vec3::splat(-1.0e30), Vec3::splat(1.0e30)),
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
        // A loop below the fixed-point quantum has no area and is dropped.
        assert!(
            trace_cut_rings(&short_ring, basis, normal, 0)
                .expect("short quantized ring")
                .is_empty()
        );

        let invalid_slice = SurfaceGroup {
            owner: 0,
            certified: true,
            bounds: (Vec3::splat(-1.0e30), Vec3::splat(1.0e30)),
            edges: vec![crossing_edge((0, 0), [0, 0])],
            triangles: vec![Triangle {
                points: [Vec3::NEG_X, Vec3::X, Vec3::Y],
                edges: [0, 0, 0],
                ..test_triangle([0, 0, 0])
            }],
        };
        // One cut point is no segment and is skipped; the corrupt edge list is
        // still caught when the cut ring is traced.
        assert!(
            slice_group(&invalid_slice, basis, normal, 1.0e-6, 0)
                .err()
                .expect("corrupt slice")
                .to_string()
                .contains("triangle produced 3 half-open edges")
        );
    }

    #[test]
    fn open_degenerate_and_out_of_range_sections_are_deterministic() {
        let open = triangle_scene(
            vec![-1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            vec![0, 1, 2],
        );
        let geometry = build(&open, &section_options()).expect("open surface is sliced");
        assert!(geometry.indices.is_empty());
        assert!(geometry.boundaries.is_empty());
        assert_eq!(geometry.open_chains.len() / 6, 1);
        assert_eq!(
            geometry.sources,
            vec![SectionSourceReport {
                plane: 0,
                source: TEST_SOURCE,
                certified: false,
                closed_loops: 0,
                open_chains: 1,
            }]
        );

        let collinear = triangle_scene(
            vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0],
            vec![0, 1, 2],
        );
        let geometry = build(&collinear, &section_options()).expect("degenerate surface");
        assert!(geometry.indices.is_empty() && geometry.open_chains.is_empty());

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
        // The direct slice is held to the same fixed-point range.
        let far = triangle_scene(
            vec![-1.0, 1.0e20, 0.0, 1.0, 1.0e20, 0.0, 1.0, 2.0e20, 0.0],
            vec![0, 1, 2],
        );
        assert!(
            build(&far, &section_options())
                .expect_err("out-of-range direct slice")
                .to_string()
                .contains("exceeds fixed-precision range")
        );

        let square = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(1, 0),
            IntPoint::new(1, 1),
            IntPoint::new(0, 1),
        ]]];
        let mut output = CapGeometry::default();
        assert!(boolean(&IntShapes::new(), &square, OverlayRule::Difference).is_empty());
        append_contour(&mut output.boundaries, basis, &vec![IntPoint::new(0, 0)]);
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

    #[test]
    fn shell_containment_fails_closed_on_grazing_and_coplanar_rays() {
        let unit = [glam::DVec3::ZERO, glam::DVec3::X, glam::DVec3::Y];
        // A ray lying in the triangle's own plane cannot cross it, and cannot
        // decide a point that lies in that plane either.
        assert_eq!(
            ray_crosses_triangle(glam::DVec3::Z, glam::DVec3::X, unit, 1.0e-6),
            Some(false)
        );
        assert_eq!(
            ray_crosses_triangle(
                glam::DVec3::new(0.25, 0.25, 0.0),
                glam::DVec3::X,
                unit,
                1.0e-6
            ),
            None
        );
        // Leaving through a corner is undecidable; leaving through the
        // interior is a crossing.
        assert_eq!(
            ray_crosses_triangle(glam::DVec3::NEG_Z, glam::DVec3::Z, unit, 1.0e-6),
            None
        );
        assert_eq!(
            ray_crosses_triangle(
                glam::DVec3::new(0.25, 0.25, -1.0),
                glam::DVec3::Z,
                unit,
                1.0e-6
            ),
            Some(true)
        );

        // A shell that is half in and half out of another owns nothing.
        let corners = [Vec3::ZERO, Vec3::X * 4.0, Vec3::Y * 4.0, Vec3::Z * 4.0];
        let mut triangles = TETRA_INDICES
            .as_chunks::<3>()
            .0
            .iter()
            .map(|face| Triangle {
                points: face.map(|index| corners[index as usize]),
                ..test_triangle([0, 0, 0])
            })
            .collect::<Vec<_>>();
        triangles.push(Triangle {
            points: [Vec3::splat(0.5), Vec3::splat(3.0), Vec3::new(0.6, 0.4, 0.5)],
            ..test_triangle([0, 0, 0])
        });
        assert!(component_is_contained(&[4], &[0, 1, 2, 3], &triangles, 1.0e-4).is_none());
    }

    #[test]
    fn multi_shell_work_ceilings_fall_back_before_the_quadratic_scans() {
        // 4001 shells put the component scan itself over the ceiling, so the
        // primitive is sliced directly and every shell's loop is still filled.
        let scan = shell_scene(1, &shell_grid(4001, Vec3::new(-0.3, 0.0, 0.0)));
        let geometry = build(&scan, &section_options()).expect("component scan ceiling");
        assert_eq!(
            geometry.sources,
            vec![SectionSourceReport {
                plane: 0,
                source: TEST_SOURCE,
                certified: false,
                closed_loops: 4001,
                open_chains: 0,
            }]
        );

        // 4000 shells fit the scan exactly, so the first containment test is
        // what tips the accumulated budget over.
        let mut shells = vec![(Vec3::ZERO, 20.0, false), (Vec3::splat(2.0), 10.0, true)];
        shells.extend(shell_grid(3998, Vec3::new(-0.3, 40.0, 0.0)));
        let geometry =
            build(&shell_scene(1, &shells), &section_options()).expect("containment ceiling");
        assert!(geometry.sources.iter().all(|report| !report.certified));

        // Disjoint cap regions are paired by a sweep, not an all-pairs scan.
        let disjoint = (0..100_000_i64)
            .map(|index| Some((index * 10, 0, index * 10 + 5, 5)))
            .collect::<Vec<_>>();
        assert!(overlapping_pairs(&disjoint).is_empty());
        let overlapping = [
            Some((0, 0, 10, 10)),
            None,
            Some((20, 0, 30, 10)),
            Some((5, 5, 25, 15)),
            Some((10, 0, 20, 10)),
            // Overlaps region 0 across x only.
            Some((1, 20, 4, 30)),
        ];
        assert_eq!(
            overlapping_pairs(&overlapping),
            vec![(0, 3), (2, 3), (3, 4)]
        );
    }

    #[test]
    fn fixed_point_winding_overflow_is_reported_as_a_cap_error() {
        // A cap outline that sweeps the corners of the fixed-point range five
        // times over runs the i128 shoelace accumulator out of headroom; the
        // guard must name the plane instead of panicking.
        const CORNERS: [(f32, f32); 4] = [(1.0, 1.0), (-1.0, 1.0), (-1.0, -1.0), (1.0, -1.0)];
        const COUNT: usize = 20;
        let mut edges = (0..COUNT)
            .map(|index| {
                let (u, v) = CORNERS[index % 4];
                let magnitude = 2.25e10 - index as f32 * 1.0e6;
                CanonicalEdge {
                    start: Vec3::new(-1.0, u * magnitude, v * magnitude),
                    end: Vec3::new(1.0, u * magnitude, v * magnitude),
                    triangles: [(index + COUNT - 1) % COUNT, index],
                    source: TEST_SOURCE,
                }
            })
            .collect::<Vec<_>>();
        edges.push(missed_edge());
        let group = SurfaceGroup {
            owner: 0,
            certified: true,
            bounds: (Vec3::splat(-1.0e30), Vec3::splat(1.0e30)),
            edges,
            triangles: (0..COUNT)
                .map(|index| Triangle {
                    points: [Vec3::X, Vec3::X * 2.0, Vec3::X + Vec3::Y],
                    ..test_triangle([index, (index + 1) % COUNT, COUNT])
                })
                .collect(),
        };
        let expected = |plane_index| {
            format!(
                "parse: sections: cap: sections.planes[{plane_index}] source node 0/mesh 0/primitive 0 fixed-point winding overflow"
            )
        };
        assert_eq!(
            trace_cut_rings(&group, plane_basis(Vec3::ZERO, Vec3::X), Vec3::X, 1)
                .expect_err("true cut winding overflow")
                .to_string(),
            expected(1)
        );

        // The same outline reached through the closed-ring graph, where every
        // triangle sits on the retained side and only the cap boundary closes.
        assert_eq!(
            exact_cut(&group, plane_basis(Vec3::ZERO, Vec3::X), Vec3::X, 1.0e-6, 3)
                .err()
                .expect("cap outline winding overflow")
                .to_string(),
            expected(3)
        );
        // The direct slice's loop graph guards the same accumulator.
        let corners = (0..COUNT)
            .map(|index| {
                let (u, v) = CORNERS[index % 4];
                let magnitude = 2.25e18 - index as f64 * 1.0e14;
                (
                    (f64::from(u) * magnitude) as i64,
                    (f64::from(v) * magnitude) as i64,
                )
            })
            .collect::<Vec<_>>();
        let ring = (0..COUNT)
            .map(|index| ordered_segment(corners[index], corners[(index + 1) % COUNT]))
            .collect::<Vec<_>>();
        assert_eq!(
            cut_loops(&ring, 3, TEST_SOURCE)
                .err()
                .expect("direct slice winding overflow")
                .to_string(),
            expected(3)
        );
    }
}
