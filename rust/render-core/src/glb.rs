//! Validated GLB adapter for the deliberately narrow headless render profile.
//! gltf-rs owns container, accessor, stride, offset, and sparse decoding; this
//! module only maps supported glTF semantics into the renderer's scene model.

use crate::{PrimitiveRef, RenderOptions};
use glam::{Mat4, Vec3};
use gltf::accessor::{DataType, Dimensions};
use gltf::mesh::{Mode, Semantic};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Range,
};

pub(crate) const MODE_TRIANGLES: u32 = 4;
pub(crate) const MODE_LINES: u32 = 1;
const MAX_ACCESSOR_VALUES: usize = 4_000_000;
const MAX_TOTAL_ACCESSOR_VALUES: usize = 8_000_000;

#[derive(Debug, PartialEq)]
pub(crate) struct Material {
    /// Linear-space straight-alpha base color.
    pub(crate) base_color: [f32; 4],
    pub(crate) metallic: f32,
    pub(crate) roughness: f32,
}

#[derive(Debug, PartialEq)]
pub(crate) struct Primitive {
    pub(crate) source_index: usize,
    /// 4 = TRIANGLES, 1 = LINES.
    pub(crate) mode: u32,
    pub(crate) positions: Vec<f32>,
    /// Empty for LINES primitives without authored normals.
    pub(crate) normals: Vec<f32>,
    pub(crate) indices: Vec<u32>,
    pub(crate) material: Material,
}

#[derive(Debug, PartialEq)]
pub(crate) struct MeshAsset {
    pub(crate) source_index: usize,
    pub(crate) primitives: Vec<Primitive>,
    pub(crate) manifold: Option<ManifoldTopology>,
}

#[derive(Debug, PartialEq)]
pub(crate) struct ManifoldTopology {
    pub(crate) indices: Vec<u32>,
    pub(crate) primitive_ranges: Vec<Range<usize>>,
}

#[derive(Debug, PartialEq)]
pub(crate) struct TopologyDiagnostic {
    pub(crate) code: &'static str,
    pub(crate) mesh_index: usize,
    pub(crate) detail: String,
}

#[derive(Debug, PartialEq)]
pub(crate) struct MeshInstance {
    pub(crate) source_node_index: usize,
    pub(crate) mesh_index: usize,
    pub(crate) model: Mat4,
    pub(crate) normal_matrix: Mat4,
}

#[derive(Debug, PartialEq)]
pub(crate) struct Scene {
    pub(crate) meshes: Vec<MeshAsset>,
    pub(crate) instances: Vec<MeshInstance>,
    pub(crate) topology_diagnostics: Vec<TopologyDiagnostic>,
    /// Exact world-space bounds over vertices referenced by draw indices.
    pub(crate) bounds: Option<([f32; 3], [f32; 3])>,
}

impl Scene {
    fn visit_positions(
        &self,
        options: Option<&RenderOptions>,
        mode: Option<u32>,
        visit: &mut dyn FnMut(Vec3),
    ) -> Result<bool, String> {
        let mut any = false;
        for instance in &self.instances {
            for primitive in &self.meshes[instance.mesh_index].primitives {
                if mode.is_some_and(|mode| primitive.mode != mode) {
                    continue;
                }
                if options.is_some_and(|options| {
                    !self.primitive_is_eligible(instance, primitive, options)
                }) {
                    continue;
                }
                for &index in &primitive.indices {
                    let offset = index as usize * 3;
                    let local = Vec3::from_slice(&primitive.positions[offset..offset + 3]);
                    let world = instance.model.transform_point3(local);
                    if !world.is_finite() {
                        return Err("transformed POSITION values must be finite".into());
                    }
                    visit(world);
                    any = true;
                }
            }
        }
        Ok(any)
    }

    /// Visit every world-space position referenced by an eligible draw index.
    pub(crate) fn for_each_position(
        &self,
        options: &RenderOptions,
        visit: &mut dyn FnMut(Vec3),
    ) -> Result<bool, String> {
        self.visit_positions(Some(options), None, visit)
    }

    /// Visit only eligible triangle positions, excluding authored line bounds.
    pub(crate) fn for_each_surface_position(
        &self,
        options: &RenderOptions,
        visit: &mut dyn FnMut(Vec3),
    ) -> Result<bool, String> {
        let mut any = false;
        for instance in &self.instances {
            for primitive in &self.meshes[instance.mesh_index].primitives {
                if primitive.mode != MODE_TRIANGLES
                    || !self.primitive_is_eligible(instance, primitive, options)
                {
                    continue;
                }
                for &index in &primitive.indices {
                    let offset = index as usize * 3;
                    let Some(position) = primitive.positions.get(offset..offset + 3) else {
                        continue;
                    };
                    let world = instance.model.transform_point3(Vec3::from_slice(position));
                    if world.is_finite() {
                        visit(world);
                        any = true;
                    }
                }
            }
        }
        Ok(any)
    }

    fn for_each_draw_position(&self, visit: &mut dyn FnMut(Vec3)) -> Result<bool, String> {
        self.visit_positions(None, None, visit)
    }

    pub(crate) fn primitive_ref(
        &self,
        instance: &MeshInstance,
        primitive: &Primitive,
    ) -> PrimitiveRef {
        PrimitiveRef {
            node_index: instance.source_node_index,
            mesh_index: self.meshes[instance.mesh_index].source_index,
            primitive_index: primitive.source_index,
        }
    }

    pub(crate) fn primitive_is_eligible(
        &self,
        instance: &MeshInstance,
        primitive: &Primitive,
        options: &RenderOptions,
    ) -> bool {
        let class_visible = if primitive.mode == MODE_TRIANGLES {
            options.surfaces
        } else {
            options.lines
        };
        class_visible
            && options
                .visible_primitives
                .as_ref()
                .is_none_or(|visible| visible.contains(&self.primitive_ref(instance, primitive)))
    }

    pub(crate) fn validate_primitive_refs(&self, options: &RenderOptions) -> Result<(), String> {
        let Some(visible) = &options.visible_primitives else {
            return Ok(());
        };
        for (index, requested) in visible.iter().enumerate() {
            let found = self.instances.iter().any(|instance| {
                instance.source_node_index == requested.node_index
                    && self.meshes[instance.mesh_index].source_index == requested.mesh_index
                    && self.meshes[instance.mesh_index]
                        .primitives
                        .iter()
                        .any(|primitive| primitive.source_index == requested.primitive_index)
            });
            if !found {
                return Err(format!(
                    "visiblePrimitives[{index}] does not match a reachable source node/mesh/primitive"
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn presented_bounds(&self, options: &RenderOptions) -> Option<([f32; 3], [f32; 3])> {
        let mut bounds: Option<(Vec3, Vec3)> = None;
        self.for_each_position(options, &mut |position| match &mut bounds {
            Some((min, max)) => {
                *min = min.min(position);
                *max = max.max(position);
            }
            None => bounds = Some((position, position)),
        })
        .expect("parsed draw positions remain finite");
        bounds.map(|(min, max)| (min.to_array(), max.to_array()))
    }
}

fn validate_accessor_counts(
    counts: impl IntoIterator<Item = (usize, usize)>,
) -> Result<(), String> {
    let mut total = 0_usize;
    for (index, count) in counts {
        if count > MAX_ACCESSOR_VALUES {
            return Err(format!(
                "accessor {index} count {count} exceeds {MAX_ACCESSOR_VALUES}"
            ));
        }
        total = total
            .checked_add(count)
            .filter(|total| *total <= MAX_TOTAL_ACCESSOR_VALUES)
            .ok_or_else(|| {
                format!("declared accessor values exceed {MAX_TOTAL_ACCESSOR_VALUES}")
            })?;
    }
    Ok(())
}

fn validate_document(document: &gltf::Document, bin: &[u8]) -> Result<(), String> {
    if document.animations().next().is_some() {
        return Err("animations are not supported".into());
    }
    if document.skins().next().is_some() {
        return Err("skins are not supported".into());
    }

    validate_accessor_counts(
        document
            .accessors()
            .map(|accessor| (accessor.index(), accessor.count())),
    )?;

    let buffers: Vec<_> = document.buffers().collect();
    if buffers.len() > 1 {
        return Err("only one embedded BIN buffer is supported".into());
    }
    for buffer in buffers {
        if matches!(buffer.source(), gltf::buffer::Source::Uri(_)) {
            return Err("external and data URI buffers are not supported".into());
        }
        let declared = buffer.length();
        if bin.len() < declared || bin.len() > declared.saturating_add(3) {
            return Err(format!(
                "embedded BIN length {} does not match declared buffer length {declared}",
                bin.len()
            ));
        }
    }
    Ok(())
}

fn validate_vec3(accessor: gltf::Accessor<'_>, semantic: &str) -> Result<(), String> {
    if accessor.data_type() != DataType::F32 || accessor.dimensions() != Dimensions::Vec3 {
        return Err(format!("{semantic} must be a float32 VEC3 accessor"));
    }
    Ok(())
}

fn validate_material(material: &gltf::Material<'_>) -> Result<Material, String> {
    let pbr = material.pbr_metallic_roughness();
    if pbr.base_color_texture().is_some()
        || pbr.metallic_roughness_texture().is_some()
        || material.normal_texture().is_some()
        || material.occlusion_texture().is_some()
        || material.emissive_texture().is_some()
    {
        return Err("texture-backed materials are not supported".into());
    }
    Ok(Material {
        base_color: pbr.base_color_factor(),
        metallic: pbr.metallic_factor(),
        roughness: pbr.roughness_factor(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifoldExtension {
    manifold_primitive: ManifoldPrimitive,
    merge_indices: Option<usize>,
    merge_values: Option<usize>,
}

#[derive(Deserialize)]
struct ManifoldPrimitive {
    attributes: BTreeMap<String, usize>,
    indices: usize,
    mode: Option<u32>,
    material: Option<serde_json::Value>,
    targets: Option<serde_json::Value>,
}

fn accessor<'a>(document: &'a gltf::Document, index: usize) -> Result<gltf::Accessor<'a>, String> {
    document
        .accessors()
        .nth(index)
        .ok_or_else(|| format!("references missing accessor {index}"))
}

fn read_unsigned(accessor: gltf::Accessor<'_>, bin: &[u8]) -> Result<Vec<u32>, String> {
    if accessor.dimensions() != Dimensions::Scalar {
        return Err("index must be an unsigned SCALAR accessor".into());
    }
    let buffer = |buffer: gltf::Buffer<'_>| (buffer.index() == 0).then_some(bin);
    match accessor.data_type() {
        DataType::U8 => gltf::accessor::Iter::<u8>::new(accessor, buffer)
            .map(|values| values.map(u32::from).collect()),
        DataType::U16 => gltf::accessor::Iter::<u16>::new(accessor, buffer)
            .map(|values| values.map(u32::from).collect()),
        DataType::U32 => gltf::accessor::Iter::<u32>::new(accessor, buffer).map(Iterator::collect),
        _ => return Err("index must be an unsigned SCALAR accessor".into()),
    }
    .ok_or_else(|| "accessor data falls outside the embedded BIN buffer".into())
}

fn validate_oriented_manifold(indices: &[u32], vertex_count: usize) -> Result<(), String> {
    if !indices.len().is_multiple_of(3) {
        return Err("manifold index count must be divisible by 3".into());
    }
    let mut edges = BTreeMap::<(u32, u32), (usize, i32)>::new();
    let mut links = BTreeMap::<u32, Vec<(u32, u32)>>::new();
    for triangle in indices.as_chunks::<3>().0 {
        let [a, b, c] = *triangle;
        if a == b || b == c || c == a {
            return Err("manifold primitive contains a collapsed triangle".into());
        }
        if [a, b, c]
            .into_iter()
            .any(|index| index as usize >= vertex_count)
        {
            return Err("manifold primitive index out of range".into());
        }
        links.entry(a).or_default().push((b, c));
        links.entry(b).or_default().push((c, a));
        links.entry(c).or_default().push((a, b));
        for (start, end) in [(a, b), (b, c), (c, a)] {
            let key = if start < end {
                (start, end)
            } else {
                (end, start)
            };
            let entry = edges.entry(key).or_default();
            entry.0 += 1;
            entry.1 += if start < end { 1 } else { -1 };
        }
    }
    if edges
        .values()
        .any(|&(count, winding)| count != 2 || winding != 0)
    {
        return Err("manifold primitive is not an oriented 2-manifold".into());
    }
    for link in links.into_values() {
        let mut adjacency = BTreeMap::<u32, Vec<u32>>::new();
        for (left, right) in link {
            adjacency.entry(left).or_default().push(right);
            adjacency.entry(right).or_default().push(left);
        }
        let start = *adjacency.keys().next().expect("non-empty vertex link");
        let mut pending = vec![start];
        let mut visited = BTreeSet::new();
        while let Some(vertex) = pending.pop() {
            if !visited.insert(vertex) {
                continue;
            }
            pending.extend(&adjacency[&vertex]);
        }
        if visited.len() != adjacency.len() {
            return Err("manifold primitive has a disconnected vertex link".into());
        }
    }
    Ok(())
}

fn decode_manifold(
    mesh: &gltf::Mesh<'_>,
    document: &gltf::Document,
    bin: &[u8],
    primitives: &[Primitive],
) -> Result<Option<ManifoldTopology>, String> {
    let Some(value) = mesh.extension_value("EXT_mesh_manifold") else {
        return Ok(None);
    };
    let context = format!("EXT_mesh_manifold mesh {}", mesh.index());
    let fail = |error: String| format!("{context}: {error}");
    let extension: ManifoldExtension = serde_json::from_value(value.clone())
        .map_err(|error| fail(format!("invalid extension object: {error}")))?;
    if primitives.is_empty() {
        return Err(fail(
            "annotated mesh must contain a TRIANGLES primitive".into(),
        ));
    }
    let mut shared_attributes = None;
    let mut shared_index_view = None;
    let mut original_indices = Vec::new();
    let mut primitive_ranges = Vec::with_capacity(primitives.len());
    for primitive in mesh.primitives() {
        if primitive.mode() != Mode::Triangles {
            return Err(fail(
                "annotated mesh may contain only TRIANGLES primitives".into(),
            ));
        }
        let attributes = primitive
            .attributes()
            .map(|(semantic, accessor)| (semantic, accessor.index()))
            .collect::<Vec<_>>();
        if shared_attributes
            .as_ref()
            .is_some_and(|shared| shared != &attributes)
        {
            return Err(fail(
                "all render primitives must share the same attribute accessors".into(),
            ));
        }
        shared_attributes.get_or_insert(attributes);
        let index_accessor = primitive
            .indices()
            .ok_or_else(|| fail("all render primitives must be indexed".into()))?;
        let view = index_accessor
            .view()
            .ok_or_else(|| fail("render index accessors must have a bufferView".into()))?
            .index();
        if shared_index_view.is_some_and(|shared| shared != view) {
            return Err(fail(
                "all render index accessors must share one bufferView".into(),
            ));
        }
        shared_index_view.get_or_insert(view);
        let start = original_indices.len();
        original_indices.extend(read_unsigned(index_accessor, bin).map_err(&fail)?);
        primitive_ranges.push(start..original_indices.len());
    }

    let manifold = extension.manifold_primitive;
    if manifold.mode.unwrap_or(MODE_TRIANGLES) != MODE_TRIANGLES {
        return Err(fail("manifoldPrimitive must use TRIANGLES mode".into()));
    }
    if manifold.material.is_some() || manifold.targets.is_some() {
        return Err(fail(
            "manifoldPrimitive must not define material or morph targets".into(),
        ));
    }
    if manifold.attributes.len() != 1 || !manifold.attributes.contains_key("POSITION") {
        return Err(fail(
            "manifoldPrimitive must define only the POSITION attribute".into(),
        ));
    }
    let position_index = manifold.attributes["POSITION"];
    let render_position_index = mesh
        .primitives()
        .next()
        .and_then(|primitive| primitive.get(&Semantic::Positions))
        .expect("validated render POSITION")
        .index();
    if position_index != render_position_index {
        return Err(fail(
            "manifoldPrimitive must share the render POSITION accessor".into(),
        ));
    }
    let positions = &primitives[0].positions;
    let indices =
        read_unsigned(accessor(document, manifold.indices).map_err(&fail)?, bin).map_err(&fail)?;
    if indices.len() != original_indices.len() {
        return Err(fail(
            "manifold and render index streams must have equal length".into(),
        ));
    }

    let changed = original_indices
        .iter()
        .zip(&indices)
        .enumerate()
        .filter_map(|(offset, (before, after))| {
            (before != after).then_some((offset as u32, *after))
        })
        .collect::<Vec<_>>();
    match (extension.merge_indices, extension.merge_values) {
        (None, None) if changed.is_empty() => {}
        (Some(merge_indices), Some(merge_values)) => {
            let merge_indices =
                read_unsigned(accessor(document, merge_indices).map_err(&fail)?, bin)
                    .map_err(&fail)?;
            let merge_values = read_unsigned(accessor(document, merge_values).map_err(&fail)?, bin)
                .map_err(&fail)?;
            if merge_indices
                .into_iter()
                .zip(merge_values)
                .collect::<Vec<_>>()
                != changed
            {
                return Err(fail(
                    "mergeIndices/mergeValues do not describe the manifold index changes".into(),
                ));
            }
        }
        (None, None) => {
            return Err(fail(
                "changed manifold indices require mergeIndices and mergeValues".into(),
            ));
        }
        _ => {
            return Err(fail(
                "mergeIndices and mergeValues must be defined together".into(),
            ));
        }
    }
    validate_oriented_manifold(&indices, positions.len() / 3).map_err(&fail)?;
    for (offset, after) in changed {
        let before = original_indices[offset as usize];
        let before = &positions[before as usize * 3..before as usize * 3 + 3];
        let after = &positions[after as usize * 3..after as usize * 3 + 3];
        if before != after {
            return Err(fail(
                "merged vertices must have identical POSITION values".into(),
            ));
        }
    }
    Ok(Some(ManifoldTopology {
        indices,
        primitive_ranges,
    }))
}

fn decode_mesh(
    mesh: gltf::Mesh<'_>,
    document: &gltf::Document,
    bin: &[u8],
    sections_requested: bool,
    manifold_required: bool,
) -> Result<(MeshAsset, Option<TopologyDiagnostic>), String> {
    let source_index = mesh.index();
    let mut primitives = Vec::new();
    for primitive in mesh.primitives() {
        let mode = match primitive.mode() {
            Mode::Triangles => MODE_TRIANGLES,
            Mode::Lines => MODE_LINES,
            other => return Err(format!("unsupported primitive mode {other:?}")),
        };
        if primitive.morph_targets().next().is_some() {
            return Err("morph targets are not supported".into());
        }
        for (semantic, _) in primitive.attributes() {
            if !matches!(semantic, Semantic::Positions | Semantic::Normals) {
                return Err(format!("unsupported vertex attribute {semantic:?}"));
            }
        }

        let position_accessor = primitive
            .get(&Semantic::Positions)
            .expect("validated primitive POSITION accessor");
        validate_vec3(position_accessor, "POSITION")?;
        let normal_accessor = primitive.get(&Semantic::Normals);
        if let Some(accessor) = normal_accessor.clone() {
            validate_vec3(accessor, "NORMAL")?;
        } else if mode == MODE_TRIANGLES {
            return Err("TRIANGLES primitive missing NORMAL".into());
        }
        if let Some(accessor) = primitive.indices()
            && (accessor.dimensions() != Dimensions::Scalar
                || !matches!(
                    accessor.data_type(),
                    DataType::U8 | DataType::U16 | DataType::U32
                ))
        {
            return Err("indices must be unsigned SCALAR values".into());
        }

        let reader = primitive.reader(|buffer| (buffer.index() == 0).then_some(bin));
        let positions: Vec<f32> = reader
            .read_positions()
            .expect("validated POSITION accessor in the embedded BIN buffer")
            .flatten()
            .collect();
        let normals: Vec<f32> = reader
            .read_normals()
            .map(|values| values.flatten().collect())
            .unwrap_or_default();
        if positions.iter().any(|value| !value.is_finite()) {
            return Err("POSITION values must be finite".into());
        }
        if normals.iter().any(|value| !value.is_finite()) {
            return Err("NORMAL values must be finite".into());
        }
        if !normals.is_empty() && normals.len() != positions.len() {
            return Err("NORMAL count does not match POSITION count".into());
        }

        let vertex_count = positions.len() / 3;
        let indices: Vec<u32> = reader.read_indices().map_or_else(
            || (0..vertex_count as u32).collect(),
            |values| values.into_u32().collect(),
        );
        let cardinality = if mode == MODE_TRIANGLES { 3 } else { 2 };
        if !indices.len().is_multiple_of(cardinality) {
            return Err(format!(
                "{} index count must be divisible by {cardinality}",
                if mode == MODE_TRIANGLES {
                    "TRIANGLES"
                } else {
                    "LINES"
                }
            ));
        }
        if indices.iter().any(|&index| index as usize >= vertex_count) {
            return Err("index out of range".into());
        }
        primitives.push(Primitive {
            source_index: primitive.index(),
            mode,
            positions,
            normals,
            indices,
            material: validate_material(&primitive.material())?,
        });
    }
    let (manifold, diagnostic) = if sections_requested || manifold_required {
        match decode_manifold(&mesh, document, bin, &primitives) {
            Ok(manifold) => (manifold, None),
            Err(detail) if manifold_required => return Err(detail),
            Err(detail) => (
                None,
                Some(TopologyDiagnostic {
                    code: "invalid-ext-mesh-manifold",
                    mesh_index: source_index,
                    detail,
                }),
            ),
        }
    } else {
        (None, None)
    };
    Ok((
        MeshAsset {
            source_index,
            primitives,
            manifold,
        },
        diagnostic,
    ))
}

fn validate_transform(model: Mat4) -> Result<Mat4, String> {
    if !model.is_finite() {
        return Err("node transform must be finite".into());
    }
    if model.determinant() == 0.0 {
        return Err("node transform must be invertible".into());
    }
    let normal_matrix = model.inverse().transpose();
    if !normal_matrix.is_finite() {
        return Err("node normal transform must be finite".into());
    }
    Ok(normal_matrix)
}

fn parse_glb_impl(bytes: &[u8], sections_requested: bool) -> Result<Scene, String> {
    let glb = gltf::binary::Glb::from_slice(bytes).map_err(|error| error.to_string())?;
    let mut json: gltf::json::Root = gltf::json::deserialize::from_slice(&glb.json)
        .map_err(|error| format!("glTF JSON: {error}"))?;
    if let Some(extension) = json
        .extensions_required
        .iter()
        .find(|extension| extension.as_str() != "EXT_mesh_manifold")
    {
        return Err(format!("unsupported required extension {extension}"));
    }
    let manifold_required = json
        .extensions_required
        .iter()
        .any(|extension| extension == "EXT_mesh_manifold");
    json.extensions_required
        .retain(|extension| extension != "EXT_mesh_manifold");
    let document = gltf::Document::from_json(json).map_err(|error| error.to_string())?;
    let bin = glb.bin.as_deref().unwrap_or_default();
    validate_document(&document, bin)?;

    let Some(scene) = document
        .default_scene()
        .or_else(|| document.scenes().next())
    else {
        return Ok(Scene {
            meshes: Vec::new(),
            instances: Vec::new(),
            topology_diagnostics: Vec::new(),
            bounds: None,
        });
    };

    let node_count = document.nodes().count();
    let mesh_count = document.meshes().count();
    let mut visited = vec![false; node_count];
    let mut mesh_map = vec![None; mesh_count];
    let mut meshes = Vec::new();
    let mut topology_diagnostics = Vec::new();
    let mut instances = Vec::new();
    let mut roots: Vec<_> = scene.nodes().collect();
    roots.reverse();
    let mut stack: Vec<_> = roots
        .into_iter()
        .map(|node| (node, Mat4::IDENTITY))
        .collect();

    while let Some((node, parent)) = stack.pop() {
        if std::mem::replace(&mut visited[node.index()], true) {
            return Err(format!(
                "node {} appears more than once in the scene hierarchy",
                node.index()
            ));
        }
        let local = Mat4::from_cols_array_2d(&node.transform().matrix());
        let model = parent * local;
        let normal_matrix = validate_transform(model)?;

        if let Some(mesh) = node.mesh() {
            let source_index = mesh.index();
            let mesh_index = match mesh_map[source_index] {
                Some(index) => index,
                None => {
                    let index = meshes.len();
                    let (mesh, diagnostic) =
                        decode_mesh(mesh, &document, bin, sections_requested, manifold_required)?;
                    meshes.push(mesh);
                    topology_diagnostics.extend(diagnostic);
                    mesh_map[source_index] = Some(index);
                    index
                }
            };
            instances.push(MeshInstance {
                source_node_index: node.index(),
                mesh_index,
                model,
                normal_matrix,
            });
        }

        let mut children: Vec<_> = node.children().collect();
        children.reverse();
        stack.extend(children.into_iter().map(|child| (child, model)));
    }

    let mut scene = Scene {
        meshes,
        instances,
        topology_diagnostics,
        bounds: None,
    };
    let mut bounds: Option<(Vec3, Vec3)> = None;
    scene.for_each_draw_position(&mut |position| match &mut bounds {
        Some((min, max)) => {
            *min = min.min(position);
            *max = max.max(position);
        }
        None => bounds = Some((position, position)),
    })?;
    scene.bounds = bounds.map(|(min, max)| (min.to_array(), max.to_array()));
    Ok(scene)
}

/// Parse ordinary draw geometry without touching optional section topology.
pub(crate) fn parse_glb(bytes: &[u8]) -> Result<Scene, String> {
    parse_glb_impl(bytes, false)
}

/// Parse draw geometry and certify exact topology when sections request it.
/// Invalid optional topology is retained as a diagnostic while the section
/// builder certifies the base primitives instead.
pub(crate) fn parse_glb_for_sections(bytes: &[u8]) -> Result<Scene, String> {
    parse_glb_impl(bytes, true)
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use serde_json::{Value, json};

    use super::*;

    #[derive(Clone, Copy)]
    enum Layout {
        Packed,
        Offset,
        Interleaved,
        Sparse,
    }

    const CUBE_POSITIONS: [[f32; 3]; 8] = [
        [-1.0, -1.0, -1.0],
        [1.0, -1.0, -1.0],
        [1.0, 1.0, -1.0],
        [-1.0, 1.0, -1.0],
        [-1.0, -1.0, 1.0],
        [1.0, -1.0, 1.0],
        [1.0, 1.0, 1.0],
        [-1.0, 1.0, 1.0],
    ];
    const CUBE_INDICES: [u32; 36] = [
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3,
        1, 2, 6, 1, 6, 5,
    ];

    fn append(bin: &mut Vec<u8>, bytes: &[u8]) -> (usize, usize) {
        let offset = bin.len();
        bin.extend_from_slice(bytes);
        let length = bytes.len();
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        (offset, length)
    }

    fn glb(json: Value, bin: Vec<u8>) -> Vec<u8> {
        gltf::binary::Glb {
            header: gltf::binary::Header {
                magic: *b"glTF",
                version: 2,
                length: 0,
            },
            json: Cow::Owned(serde_json::to_vec(&json).expect("json")),
            bin: Some(Cow::Owned(bin)),
        }
        .to_vec()
        .expect("glb")
    }

    fn fixture(layout: Layout, index_component: u32, indexed: bool) -> Vec<u8> {
        let positions = [[0.0f32, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]];
        let normals = [[0.0f32, 0.0, 1.0]; 3];
        let mut bin = Vec::new();
        let mut views = Vec::new();
        let (position_view, normal_view, sparse) = match layout {
            Layout::Packed => {
                let position = append(&mut bin, bytemuck::cast_slice(&positions));
                let normal = append(&mut bin, bytemuck::cast_slice(&normals));
                views
                    .push(json!({"buffer": 0, "byteOffset": position.0, "byteLength": position.1}));
                views.push(json!({"buffer": 0, "byteOffset": normal.0, "byteLength": normal.1}));
                (0, 1, None)
            }
            Layout::Offset => {
                let mut position_bytes = vec![0; 4];
                position_bytes.extend_from_slice(bytemuck::cast_slice(&positions));
                let mut normal_bytes = vec![0; 4];
                normal_bytes.extend_from_slice(bytemuck::cast_slice(&normals));
                let position = append(&mut bin, &position_bytes);
                let normal = append(&mut bin, &normal_bytes);
                views
                    .push(json!({"buffer": 0, "byteOffset": position.0, "byteLength": position.1}));
                views.push(json!({"buffer": 0, "byteOffset": normal.0, "byteLength": normal.1}));
                (0, 1, None)
            }
            Layout::Interleaved => {
                let interleaved: Vec<f32> = positions
                    .iter()
                    .zip(normals.iter())
                    .flat_map(|(position, normal)| position.iter().chain(normal).copied())
                    .collect();
                let view = append(&mut bin, bytemuck::cast_slice(&interleaved));
                views.push(json!({"buffer": 0, "byteOffset": view.0, "byteLength": view.1, "byteStride": 24}));
                (0, 0, None)
            }
            Layout::Sparse => {
                let zeros = [[0.0f32; 3]; 3];
                let base = append(&mut bin, bytemuck::cast_slice(&zeros));
                let sparse_indices = append(&mut bin, &[0, 1, 2]);
                let sparse_values = append(&mut bin, bytemuck::cast_slice(&positions));
                let normal = append(&mut bin, bytemuck::cast_slice(&normals));
                views.push(json!({"buffer": 0, "byteOffset": base.0, "byteLength": base.1}));
                views.push(json!({"buffer": 0, "byteOffset": sparse_indices.0, "byteLength": sparse_indices.1}));
                views.push(json!({"buffer": 0, "byteOffset": sparse_values.0, "byteLength": sparse_values.1}));
                views.push(json!({"buffer": 0, "byteOffset": normal.0, "byteLength": normal.1}));
                (
                    0,
                    3,
                    Some(json!({
                        "count": 3,
                        "indices": {"bufferView": 1, "componentType": 5121},
                        "values": {"bufferView": 2}
                    })),
                )
            }
        };

        let index_bytes: Vec<u8> = match index_component {
            5121 => vec![0, 1, 2],
            5123 => [0u16, 1, 2]
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect(),
            5125 => [0u32, 1, 2]
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect(),
            _ => panic!("unsupported test index component"),
        };
        let index_view = if indexed {
            let index = append(&mut bin, &index_bytes);
            views.push(json!({"buffer": 0, "byteOffset": index.0, "byteLength": index.1}));
            Some(views.len() - 1)
        } else {
            None
        };

        let position_offset = if matches!(layout, Layout::Offset) {
            4
        } else {
            0
        };
        let normal_offset = if matches!(layout, Layout::Interleaved) {
            12
        } else if matches!(layout, Layout::Offset) {
            4
        } else {
            0
        };
        let mut position_accessor = json!({
            "bufferView": position_view,
            "byteOffset": position_offset,
            "componentType": 5126,
            "count": 3,
            "type": "VEC3",
            "min": [0, 0, 0],
            "max": [2, 3, 0]
        });
        if let Some(sparse) = sparse {
            position_accessor["sparse"] = sparse;
        }
        let mut accessors = vec![
            position_accessor,
            json!({
                "bufferView": normal_view,
                "byteOffset": normal_offset,
                "componentType": 5126,
                "count": 3,
                "type": "VEC3"
            }),
        ];
        let indices = index_view.map(|view| {
            accessors.push(json!({
                "bufferView": view,
                "componentType": index_component,
                "count": 3,
                "type": "SCALAR"
            }));
            accessors.len() - 1
        });
        let mut primitive = json!({
            "attributes": {"POSITION": 0, "NORMAL": 1},
            "mode": 4,
            "material": 0
        });
        if let Some(indices) = indices {
            primitive["indices"] = json!(indices);
        }
        glb(
            json!({
                "asset": {"version": "2.0"},
                "extensionsUsed": ["KHR_materials_unlit"],
                "scene": 0,
                "scenes": [{"nodes": [0]}],
                "nodes": [{"mesh": 0}],
                "meshes": [{"primitives": [primitive]}],
                "accessors": accessors,
                "bufferViews": views,
                "buffers": [{"byteLength": bin.len()}],
                "materials": [{"pbrMetallicRoughness": {
                    "baseColorFactor": [0.25, 0.5, 0.75, 1],
                    "metallicFactor": 0.5,
                    "roughnessFactor": 0.25
                }}]
            }),
            bin,
        )
    }

    fn manifold_cube_fixture(required: bool) -> Vec<u8> {
        let normals = [[0.0f32, 0.0, 1.0]; 8];
        let indices = CUBE_INDICES.map(|index| index as u16);
        let mut bin = Vec::new();
        let position = append(&mut bin, bytemuck::cast_slice(&CUBE_POSITIONS));
        let normal = append(&mut bin, bytemuck::cast_slice(&normals));
        let index = append(&mut bin, bytemuck::cast_slice(&indices));
        let mut json = json!({
            "asset": {"version": "2.0"},
            "extensionsUsed": ["EXT_mesh_manifold"],
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0}],
            "meshes": [{
                "primitives": [{
                    "attributes": {"POSITION": 0, "NORMAL": 1},
                    "indices": 2,
                    "material": 0,
                    "mode": 4
                }],
                "extensions": {
                    "EXT_mesh_manifold": {
                        "manifoldPrimitive": {
                            "attributes": {"POSITION": 0},
                            "indices": 2,
                            "mode": 4
                        }
                    }
                }
            }],
            "accessors": [
                {
                    "bufferView": 0,
                    "componentType": 5126,
                    "count": 8,
                    "type": "VEC3",
                    "min": [-1, -1, -1],
                    "max": [1, 1, 1]
                },
                {"bufferView": 1, "componentType": 5126, "count": 8, "type": "VEC3"},
                {"bufferView": 2, "componentType": 5123, "count": 36, "type": "SCALAR"}
            ],
            "bufferViews": [
                {"buffer": 0, "byteOffset": position.0, "byteLength": position.1},
                {"buffer": 0, "byteOffset": normal.0, "byteLength": normal.1},
                {"buffer": 0, "byteOffset": index.0, "byteLength": index.1}
            ],
            "buffers": [{"byteLength": bin.len()}],
            "materials": [{}]
        });
        if required {
            json["extensionsRequired"] = json!(["EXT_mesh_manifold"]);
        }
        glb(json, bin)
    }

    fn manifold_material_seam_fixture() -> Vec<u8> {
        let mut positions = CUBE_POSITIONS.to_vec();
        positions.extend(CUBE_POSITIONS);
        let normals = [[0.0f32, 0.0, 1.0]; 16];
        let first = CUBE_INDICES
            .as_chunks::<3>()
            .0
            .iter()
            .step_by(2)
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        let second = CUBE_INDICES
            .as_chunks::<3>()
            .0
            .iter()
            .skip(1)
            .step_by(2)
            .flatten()
            .map(|index| index + 8)
            .collect::<Vec<_>>();
        let render_indices = first.iter().chain(&second).copied().collect::<Vec<_>>();
        let manifold_indices = first
            .iter()
            .copied()
            .chain(second.iter().map(|index| index - 8))
            .collect::<Vec<_>>();
        let changes = render_indices
            .iter()
            .zip(&manifold_indices)
            .enumerate()
            .filter_map(|(offset, (before, after))| {
                (before != after).then_some((offset as u8, *after))
            })
            .collect::<Vec<_>>();
        let merge_indices = changes.iter().map(|change| change.0).collect::<Vec<_>>();
        let merge_values = changes.iter().map(|change| change.1).collect::<Vec<_>>();

        let mut bin = Vec::new();
        let position = append(&mut bin, bytemuck::cast_slice(&positions));
        let normal = append(&mut bin, bytemuck::cast_slice(&normals));
        let index = append(&mut bin, bytemuck::cast_slice(&render_indices));
        let merge_index = append(&mut bin, &merge_indices);
        let merge_value = append(&mut bin, bytemuck::cast_slice(&merge_values));
        glb(
            json!({
                "asset": {"version": "2.0"},
                "extensionsUsed": ["EXT_mesh_manifold"],
                "scene": 0,
                "scenes": [{"nodes": [0]}],
                "nodes": [{"mesh": 0}],
                "meshes": [{
                    "primitives": [
                        {"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": 0, "mode": 4},
                        {"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 3, "material": 1, "mode": 4}
                    ],
                    "extensions": {"EXT_mesh_manifold": {
                        "manifoldPrimitive": {"attributes": {"POSITION": 0}, "indices": 4, "mode": 4},
                        "mergeIndices": 5,
                        "mergeValues": 6
                    }}
                }],
                "accessors": [
                    {"bufferView": 0, "componentType": 5126, "count": 16, "type": "VEC3", "min": [-1, -1, -1], "max": [1, 1, 1]},
                    {"bufferView": 1, "componentType": 5126, "count": 16, "type": "VEC3"},
                    {"bufferView": 2, "componentType": 5125, "count": 18, "type": "SCALAR"},
                    {"bufferView": 2, "byteOffset": 72, "componentType": 5125, "count": 18, "type": "SCALAR"},
                    {
                        "bufferView": 2,
                        "componentType": 5125,
                        "count": 36,
                        "type": "SCALAR",
                        "sparse": {
                            "count": changes.len(),
                            "indices": {"bufferView": 3, "componentType": 5121},
                            "values": {"bufferView": 4}
                        }
                    },
                    {"bufferView": 3, "componentType": 5121, "count": changes.len(), "type": "SCALAR"},
                    {"bufferView": 4, "componentType": 5125, "count": changes.len(), "type": "SCALAR"},
                    {"bufferView": 2, "componentType": 5125, "count": 36, "type": "SCALAR"}
                ],
                "bufferViews": [
                    {"buffer": 0, "byteOffset": position.0, "byteLength": position.1},
                    {"buffer": 0, "byteOffset": normal.0, "byteLength": normal.1},
                    {"buffer": 0, "byteOffset": index.0, "byteLength": index.1},
                    {"buffer": 0, "byteOffset": merge_index.0, "byteLength": merge_index.1},
                    {"buffer": 0, "byteOffset": merge_value.0, "byteLength": merge_value.1}
                ],
                "buffers": [{"byteLength": bin.len()}],
                "materials": [{}, {}]
            }),
            bin,
        )
    }

    #[test]
    fn standard_accessor_layouts_decode_to_identical_geometry() {
        let expected = parse_glb(&fixture(Layout::Packed, 5125, true)).expect("packed");
        assert_eq!(expected.meshes[0].primitives[0].material.metallic, 0.5);
        assert_eq!(expected.meshes[0].primitives[0].material.roughness, 0.25);
        for bytes in [
            fixture(Layout::Offset, 5125, true),
            fixture(Layout::Interleaved, 5125, true),
            fixture(Layout::Sparse, 5125, true),
        ] {
            assert_eq!(parse_glb(&bytes).expect("variant"), expected);
        }
    }

    #[test]
    fn supported_manifold_extension_may_be_required() {
        let scene =
            parse_glb_for_sections(&manifold_cube_fixture(true)).expect("EXT_mesh_manifold");
        assert!(scene.meshes[0].manifold.is_some());
    }

    #[test]
    fn manifold_surface_accepts_a_separate_line_mesh() {
        let source = manifold_cube_fixture(false);
        let parsed = gltf::binary::Glb::from_slice(&source).expect("fixture");
        let mut json: Value = serde_json::from_slice(&parsed.json).expect("json");
        let line = json!({
            "attributes": {"POSITION": 0},
            "indices": 2,
            "material": 0,
            "mode": 1
        });
        json["meshes"][0]["primitives"]
            .as_array_mut()
            .expect("primitives")
            .push(line.clone());
        let scene = parse_glb_for_sections(&glb(
            json.clone(),
            parsed.bin.as_ref().expect("bin").to_vec(),
        ))
        .expect("certified fallback");
        assert!(scene.meshes[0].manifold.is_none());
        assert_eq!(
            scene.topology_diagnostics[0].code,
            "invalid-ext-mesh-manifold"
        );
        assert!(
            scene.topology_diagnostics[0]
                .detail
                .contains("only TRIANGLES primitives")
        );
        json["meshes"][0]["primitives"]
            .as_array_mut()
            .expect("primitives")
            .pop();
        json["nodes"] = json!([{"mesh": 0}, {"mesh": 1}]);
        json["scenes"][0]["nodes"] = json!([0, 1]);
        json["meshes"]
            .as_array_mut()
            .expect("meshes")
            .push(json!({"primitives": [line]}));

        let scene = parse_glb_for_sections(&glb(json, parsed.bin.expect("bin").into_owned()))
            .expect("scene");
        assert!(scene.meshes[0].manifold.is_some());
        assert!(scene.meshes[1].manifold.is_none());
        assert_eq!(scene.meshes[1].primitives[0].mode, MODE_LINES);
    }

    #[test]
    fn manifold_topology_may_contain_disjoint_closed_shells() {
        let mut indices = CUBE_INDICES.to_vec();
        indices.extend(CUBE_INDICES.iter().map(|index| index + 8));
        validate_oriented_manifold(&indices, 16).expect("two closed shells");

        let valence = 4_096_u32;
        let mut suspension = Vec::with_capacity(valence as usize * 6);
        for index in 0..valence {
            let current = 2 + index;
            let next = 2 + (index + 1) % valence;
            suspension.extend_from_slice(&[0, current, next, 1, next, current]);
        }
        validate_oriented_manifold(&suspension, valence as usize + 2)
            .expect("high-valence manifold vertex");
    }

    #[test]
    fn declared_accessor_counts_are_bounded_before_decoding() {
        assert!(validate_accessor_counts([(0, MAX_ACCESSOR_VALUES)]).is_ok());
        assert_eq!(
            validate_accessor_counts([(7, MAX_ACCESSOR_VALUES + 1)]).unwrap_err(),
            format!(
                "accessor 7 count {} exceeds {MAX_ACCESSOR_VALUES}",
                MAX_ACCESSOR_VALUES + 1
            )
        );
        assert!(
            validate_accessor_counts([(0, MAX_ACCESSOR_VALUES), (1, MAX_ACCESSOR_VALUES), (2, 1)])
                .unwrap_err()
                .contains("declared accessor values")
        );

        let source = fixture(Layout::Packed, 5125, true);
        let parsed = gltf::binary::Glb::from_slice(&source).expect("fixture");
        let mut json: Value = serde_json::from_slice(&parsed.json).expect("json");
        json["accessors"][0]["count"] = json!(MAX_ACCESSOR_VALUES + 1);
        assert!(
            parse_glb(&glb(json, parsed.bin.expect("bin").into_owned()))
                .unwrap_err()
                .contains("accessor 0 count")
        );
    }

    #[test]
    fn malformed_optional_manifold_is_lazy_and_sections_use_the_certified_fallback() {
        let source = manifold_cube_fixture(false);
        let parsed = gltf::binary::Glb::from_slice(&source).expect("fixture");
        let mut json: Value = serde_json::from_slice(&parsed.json).expect("json");
        json["meshes"][0]["extensions"]["EXT_mesh_manifold"] = json!({});
        let malformed = glb(json, parsed.bin.expect("bin").into_owned());

        let ordinary = parse_glb(&malformed).expect("ordinary render ignores optional topology");
        assert!(ordinary.topology_diagnostics.is_empty());

        let section_scene = parse_glb_for_sections(&malformed).expect("fallback scene");
        assert_eq!(
            section_scene.topology_diagnostics[0].code,
            "invalid-ext-mesh-manifold"
        );
        let cap = crate::section::build(
            &section_scene,
            &RenderOptions {
                sections: Some(crate::Sections {
                    planes: vec![crate::SectionPlane {
                        point: [0.0; 3],
                        normal: [1.0, 0.0, 0.0],
                    }],
                    clip_surfaces: true,
                    clip_lines: true,
                }),
                ..RenderOptions::default()
            },
        )
        .expect("certified base topology");
        assert!(!cap.indices.is_empty());

        let parsed = gltf::binary::Glb::from_slice(&malformed).expect("fixture");
        let mut json: Value = serde_json::from_slice(&parsed.json).expect("json");
        json["extensionsRequired"] = json!(["EXT_mesh_manifold"]);
        let error = parse_glb(&glb(json, parsed.bin.expect("bin").into_owned())).unwrap_err();
        assert!(error.contains("manifoldPrimitive"), "{error}");
    }

    #[test]
    fn manifold_topology_rejects_open_duplicate_and_out_of_range_indices() {
        assert!(
            validate_oriented_manifold(&[0, 1], 2)
                .unwrap_err()
                .contains("divisible by 3")
        );
        assert!(
            validate_oriented_manifold(&[0, 0, 1], 2)
                .unwrap_err()
                .contains("collapsed triangle")
        );
        assert!(
            validate_oriented_manifold(&CUBE_INDICES[..33], 8)
                .unwrap_err()
                .contains("not an oriented 2-manifold")
        );
        let mut duplicate = CUBE_INDICES;
        duplicate[33..].copy_from_slice(&CUBE_INDICES[..3]);
        assert!(
            validate_oriented_manifold(&duplicate, 8)
                .unwrap_err()
                .contains("not an oriented 2-manifold")
        );
        let mut out_of_range = CUBE_INDICES;
        out_of_range[0] = 8;
        assert!(
            validate_oriented_manifold(&out_of_range, 8)
                .unwrap_err()
                .contains("index out of range")
        );

        let tetrahedron = [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];
        let mut pinched_vertex = tetrahedron.to_vec();
        pinched_vertex.extend(tetrahedron.map(|index| if index == 0 { 0 } else { index + 3 }));
        assert!(
            validate_oriented_manifold(&pinched_vertex, 7)
                .unwrap_err()
                .contains("disconnected vertex link")
        );
    }

    #[test]
    fn sparse_manifold_indices_restore_material_seam_topology() {
        let fixture = manifold_material_seam_fixture();
        let scene = parse_glb_for_sections(&fixture).expect("material seam");
        let topology = scene.meshes[0].manifold.as_ref().expect("manifold");
        let expected = CUBE_INDICES
            .as_chunks::<3>()
            .0
            .iter()
            .step_by(2)
            .chain(CUBE_INDICES.as_chunks::<3>().0.iter().skip(1).step_by(2))
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(topology.indices, expected);
        assert_eq!(topology.primitive_ranges, [0..18, 18..36]);
        assert_eq!(scene.meshes[0].primitives[0].positions.len(), 16 * 3);

        let options = RenderOptions {
            sections: Some(crate::Sections {
                planes: vec![crate::SectionPlane {
                    point: [0.0; 3],
                    normal: [1.0, 0.0, 0.0],
                }],
                clip_surfaces: true,
                clip_lines: true,
            }),
            ..RenderOptions::default()
        };
        let cap = crate::section::build(&scene, &options).expect("section cap");
        assert!(!cap.indices.is_empty());

        let parsed = gltf::binary::Glb::from_slice(&fixture).expect("fixture");
        let mut json: Value = serde_json::from_slice(&parsed.json).expect("json");
        json.as_object_mut()
            .expect("object")
            .remove("extensionsUsed");
        json["meshes"][0]
            .as_object_mut()
            .expect("mesh")
            .remove("extensions");
        let fallback = parse_glb_for_sections(&glb(json, parsed.bin.expect("bin").into_owned()))
            .expect("fallback topology");
        let fallback_cap = crate::section::build(&fallback, &options).expect("fallback cap");
        assert_eq!(cap.vertices, fallback_cap.vertices);
        assert_eq!(cap.indices, fallback_cap.indices);
        assert_eq!(cap.boundaries, fallback_cap.boundaries);
    }

    #[test]
    fn malformed_and_false_manifold_claims_fail_closed() {
        let source = manifold_material_seam_fixture();
        let parsed = gltf::binary::Glb::from_slice(&source).expect("fixture");
        let base: Value = serde_json::from_slice(&parsed.json).expect("json");
        let bin = parsed.bin.expect("bin").into_owned();

        let rejects = |json: Value, bin: Vec<u8>, expected: &str| {
            let scene = parse_glb_for_sections(&glb(json, bin)).expect("fallback scene");
            let diagnostic = scene
                .topology_diagnostics
                .first()
                .expect("structured topology diagnostic");
            assert_eq!(diagnostic.code, "invalid-ext-mesh-manifold");
            assert_eq!(diagnostic.mesh_index, 0);
            assert!(
                diagnostic.detail.contains(expected),
                "expected {expected}: {}",
                diagnostic.detail
            );
        };

        let document =
            gltf::Document::from_json(serde_json::from_value(base.clone()).expect("fixture root"))
                .expect("fixture document");
        assert!(
            read_unsigned(document.accessors().nth(4).expect("sparse accessor"), &[])
                .unwrap_err()
                .contains("outside the embedded BIN buffer")
        );

        let mut invalid_extension = base.clone();
        invalid_extension["meshes"][0]["extensions"]["EXT_mesh_manifold"] = json!({});
        rejects(invalid_extension, bin.clone(), "invalid extension object");

        let mut missing_accessor = base.clone();
        missing_accessor["meshes"][0]["extensions"]["EXT_mesh_manifold"]["manifoldPrimitive"]["indices"] =
            json!(99);
        rejects(
            missing_accessor,
            bin.clone(),
            "references missing accessor 99",
        );

        let mut unindexed = base.clone();
        unindexed["accessors"][0]["count"] = json!(15);
        unindexed["accessors"][1]["count"] = json!(15);
        unindexed["meshes"][0]["primitives"]
            .as_array_mut()
            .expect("primitives")
            .truncate(1);
        unindexed["meshes"][0]["primitives"][0]
            .as_object_mut()
            .expect("primitive")
            .remove("indices");
        rejects(unindexed, bin.clone(), "render primitives must be indexed");

        let mut index_without_view = base.clone();
        index_without_view["accessors"][4]
            .as_object_mut()
            .expect("accessor")
            .remove("bufferView");
        index_without_view["meshes"][0]["primitives"][0]["indices"] = json!(4);
        rejects(
            index_without_view,
            bin.clone(),
            "render index accessors must have a bufferView",
        );

        let mut attributes = base.clone();
        attributes["meshes"][0]["primitives"][1]["attributes"]["NORMAL"] = json!(0);
        rejects(
            attributes,
            bin.clone(),
            "share the same attribute accessors",
        );

        let mut index_view = base.clone();
        let duplicate_view = index_view["bufferViews"][2].clone();
        let duplicate_view_index = index_view["bufferViews"]
            .as_array()
            .expect("bufferViews")
            .len();
        index_view["bufferViews"]
            .as_array_mut()
            .expect("bufferViews")
            .push(duplicate_view);
        index_view["accessors"][3]["bufferView"] = json!(duplicate_view_index);
        rejects(index_view, bin.clone(), "share one bufferView");

        let mut mode = base.clone();
        mode["meshes"][0]["extensions"]["EXT_mesh_manifold"]["manifoldPrimitive"]["mode"] =
            json!(MODE_LINES);
        rejects(mode, bin.clone(), "must use TRIANGLES mode");

        let mut material = base.clone();
        material["meshes"][0]["extensions"]["EXT_mesh_manifold"]["manifoldPrimitive"]["material"] =
            json!(0);
        rejects(material, bin.clone(), "must not define material");

        let mut manifold_attributes = base.clone();
        manifold_attributes["meshes"][0]["extensions"]["EXT_mesh_manifold"]["manifoldPrimitive"]
            ["attributes"]["NORMAL"] = json!(1);
        rejects(
            manifold_attributes,
            bin.clone(),
            "must define only the POSITION attribute",
        );

        let mut wrong_accessor_type = base.clone();
        wrong_accessor_type["accessors"][4]["componentType"] = json!(5126);
        rejects(
            wrong_accessor_type,
            bin.clone(),
            "must be an unsigned SCALAR accessor",
        );

        let mut wrong_accessor_dimensions = base.clone();
        wrong_accessor_dimensions["meshes"][0]["extensions"]["EXT_mesh_manifold"]["manifoldPrimitive"]
            ["indices"] = json!(0);
        rejects(
            wrong_accessor_dimensions,
            bin.clone(),
            "must be an unsigned SCALAR accessor",
        );

        let mut missing_merges = base.clone();
        missing_merges["meshes"][0]["extensions"]["EXT_mesh_manifold"]
            .as_object_mut()
            .expect("extension")
            .remove("mergeIndices");
        missing_merges["meshes"][0]["extensions"]["EXT_mesh_manifold"]
            .as_object_mut()
            .expect("extension")
            .remove("mergeValues");
        rejects(
            missing_merges,
            bin.clone(),
            "changed manifold indices require mergeIndices and mergeValues",
        );

        let mut mismatched_positions = bin.clone();
        let duplicate_offset = 8 * 3 * std::mem::size_of::<f32>();
        mismatched_positions[duplicate_offset..duplicate_offset + std::mem::size_of::<f32>()]
            .copy_from_slice(&0.5f32.to_le_bytes());
        rejects(
            base.clone(),
            mismatched_positions,
            "merged vertices must have identical POSITION values",
        );

        let mut missing_merge_values = base.clone();
        missing_merge_values["meshes"][0]["extensions"]["EXT_mesh_manifold"]
            .as_object_mut()
            .expect("extension")
            .remove("mergeValues");
        rejects(
            missing_merge_values,
            bin.clone(),
            "must be defined together",
        );

        let mut wrong_position = base.clone();
        wrong_position["meshes"][0]["extensions"]["EXT_mesh_manifold"]["manifoldPrimitive"]["attributes"]
            ["POSITION"] = json!(1);
        rejects(
            wrong_position,
            bin.clone(),
            "must share the render POSITION accessor",
        );

        let mut wrong_count = base.clone();
        wrong_count["meshes"][0]["extensions"]["EXT_mesh_manifold"]["manifoldPrimitive"]["indices"] =
            json!(2);
        rejects(
            wrong_count,
            bin.clone(),
            "index streams must have equal length",
        );

        let mut mismatched_merge = base.clone();
        mismatched_merge["meshes"][0]["extensions"]["EXT_mesh_manifold"]["mergeValues"] = json!(5);
        rejects(
            mismatched_merge,
            bin.clone(),
            "do not describe the manifold index changes",
        );

        let mut false_claim = base;
        false_claim["meshes"][0]["extensions"]["EXT_mesh_manifold"]["manifoldPrimitive"]["indices"] =
            json!(7);
        false_claim["meshes"][0]["extensions"]["EXT_mesh_manifold"]
            .as_object_mut()
            .expect("extension")
            .remove("mergeIndices");
        false_claim["meshes"][0]["extensions"]["EXT_mesh_manifold"]
            .as_object_mut()
            .expect("extension")
            .remove("mergeValues");
        rejects(false_claim, bin, "not an oriented 2-manifold");
    }

    #[test]
    fn standard_index_widths_and_absent_indices_share_draw_semantics() {
        let expected = parse_glb(&fixture(Layout::Packed, 5125, true)).expect("u32");
        for bytes in [
            fixture(Layout::Packed, 5121, true),
            fixture(Layout::Packed, 5123, true),
            fixture(Layout::Packed, 5125, false),
        ] {
            assert_eq!(parse_glb(&bytes).expect("variant"), expected);
        }
    }

    #[test]
    fn hierarchy_reuses_mesh_and_composes_world_transforms() {
        let source = fixture(Layout::Interleaved, 5125, true);
        let parsed = gltf::binary::Glb::from_slice(&source).expect("fixture");
        let mut json: Value = serde_json::from_slice(&parsed.json).expect("json");
        json["scenes"][0]["nodes"] = json!([0, 2]);
        json["nodes"] = json!([
            {"translation": [10, 0, 0], "children": [1]},
            {"mesh": 0, "scale": [2, 1, 1]},
            {"mesh": 0, "translation": [-5, 0, 0]}
        ]);
        let scene = parse_glb(&glb(json, parsed.bin.expect("bin").into_owned())).expect("scene");

        assert_eq!(scene.meshes.len(), 1);
        assert_eq!(scene.instances.len(), 2);
        assert_eq!(
            scene.instances[0].model.transform_point3(Vec3::ZERO),
            Vec3::X * 10.0
        );
        assert_eq!(
            scene.instances[1].model.transform_point3(Vec3::ZERO),
            Vec3::X * -5.0
        );
        assert_eq!(scene.bounds, Some(([-5.0, 0.0, 0.0], [14.0, 3.0, 0.0])));
    }

    #[test]
    fn composed_fixture_covers_interleaving_instancing_and_lines() {
        let scene = parse_glb(include_bytes!(
            "../../../tests/fixtures/interleaved-instanced-lines.glb"
        ))
        .expect("fixture");

        assert_eq!(scene.meshes.len(), 1);
        assert_eq!(scene.instances.len(), 2);
        assert_eq!(scene.meshes[0].source_index, 0);
        assert_eq!(scene.instances[0].source_node_index, 1);
        assert_eq!(scene.instances[1].source_node_index, 2);
        assert_eq!(scene.meshes[0].primitives.len(), 2);
        assert_eq!(scene.meshes[0].primitives[0].source_index, 0);
        assert_eq!(scene.meshes[0].primitives[1].source_index, 1);
        assert_eq!(scene.meshes[0].primitives[0].mode, MODE_TRIANGLES);
        assert_eq!(scene.meshes[0].primitives[1].mode, MODE_LINES);
        assert_eq!(
            scene.meshes[0].primitives[1].material.base_color,
            [0.0, 0.0, 0.0, 1.0]
        );
        assert_eq!(scene.bounds, Some(([-4.5, -1.95, 0.0], [4.2, 2.15, 0.0])));

        let expected_count = scene
            .instances
            .iter()
            .map(|instance| {
                scene.meshes[instance.mesh_index]
                    .primitives
                    .iter()
                    .map(|primitive| primitive.indices.len())
                    .sum::<usize>()
            })
            .sum::<usize>();
        let mut visited = Vec::new();
        assert!(
            scene
                .for_each_draw_position(&mut |position| visited.push(position))
                .expect("positions")
        );
        assert_eq!(visited.len(), expected_count);
        assert!(visited.iter().all(|position| position.is_finite()));
        let min = visited
            .iter()
            .copied()
            .reduce(Vec3::min)
            .expect("positions");
        let max = visited
            .iter()
            .copied()
            .reduce(Vec3::max)
            .expect("positions");
        assert_eq!(Some((min.to_array(), max.to_array())), scene.bounds);

        let surfaces_only = RenderOptions {
            lines: false,
            ..RenderOptions::default()
        };
        let mut surface_positions = Vec::new();
        scene
            .for_each_position(&surfaces_only, &mut |position| {
                surface_positions.push(position)
            })
            .expect("surface positions");
        assert_eq!(
            surface_positions.len(),
            scene.instances.len() * scene.meshes[0].primitives[0].indices.len()
        );

        let lines_only = RenderOptions {
            surfaces: false,
            ..RenderOptions::default()
        };
        let mut line_positions = Vec::new();
        scene
            .for_each_position(&lines_only, &mut |position| line_positions.push(position))
            .expect("line positions");
        assert_eq!(
            line_positions.len(),
            scene.instances.len() * scene.meshes[0].primitives[1].indices.len()
        );

        let first_instance = RenderOptions {
            visible_primitives: Some(vec![PrimitiveRef {
                node_index: 1,
                mesh_index: 0,
                primitive_index: 0,
            }]),
            ..RenderOptions::default()
        };
        assert_eq!(
            scene.presented_bounds(&first_instance),
            Some(([-4.5, -0.25, 0.0], [-1.5, 2.15, 0.0]))
        );
        assert!(scene.validate_primitive_refs(&first_instance).is_ok());
        let mut selected_positions = Vec::new();
        scene
            .for_each_position(&first_instance, &mut |position| {
                selected_positions.push(position)
            })
            .expect("selected positions");
        assert_eq!(
            selected_positions.len(),
            scene.meshes[0].primitives[0].indices.len()
        );

        let wrong_instance = RenderOptions {
            visible_primitives: Some(vec![PrimitiveRef {
                node_index: 0,
                mesh_index: 0,
                primitive_index: 0,
            }]),
            ..RenderOptions::default()
        };
        assert_eq!(
            scene.validate_primitive_refs(&wrong_instance),
            Err(
                "visiblePrimitives[0] does not match a reachable source node/mesh/primitive".into()
            )
        );
    }

    #[test]
    fn bounds_only_include_vertices_referenced_by_indices() {
        let source = fixture(Layout::Packed, 5125, true);
        let parsed = gltf::binary::Glb::from_slice(&source).expect("fixture");
        let mut json: Value = serde_json::from_slice(&parsed.json).expect("json");
        json["nodes"][0]["translation"] = json!([4, 5, 6]);
        let scene = parse_glb(&glb(json, parsed.bin.expect("bin").into_owned())).expect("scene");
        assert_eq!(scene.bounds, Some(([4.0, 5.0, 6.0], [6.0, 8.0, 6.0])));
    }

    #[test]
    fn empty_scene_is_valid() {
        let scene = parse_glb(&glb(
            json!({"asset": {"version": "2.0"}, "scenes": [{"nodes": []}], "scene": 0}),
            Vec::new(),
        ))
        .expect("empty");
        assert!(scene.meshes.is_empty());
        assert!(scene.instances.is_empty());
        assert!(scene.bounds.is_none());
    }

    #[test]
    fn unsupported_profile_features_fail_deterministically() {
        let source = fixture(Layout::Packed, 5125, true);
        let parsed = gltf::binary::Glb::from_slice(&source).expect("fixture");
        let base: Value = serde_json::from_slice(&parsed.json).expect("json");
        let bin = parsed.bin.expect("bin").into_owned();

        let cases = [
            (
                "extensionsRequired",
                json!(["EXT_mesh_gpu_instancing"]),
                "unsupported required extension",
            ),
            (
                "animations",
                json!([{"channels": [], "samplers": []}]),
                "animations are not supported",
            ),
        ];
        for (field, value, expected) in cases {
            let mut json = base.clone();
            json[field] = value;
            let error = parse_glb(&glb(json, bin.clone())).unwrap_err();
            assert!(error.contains(expected));
        }
    }

    #[test]
    fn unsupported_geometry_and_material_semantics_fail_deterministically() {
        let source = fixture(Layout::Packed, 5125, true);
        let parsed = gltf::binary::Glb::from_slice(&source).expect("fixture");
        let base: Value = serde_json::from_slice(&parsed.json).expect("json");
        let bin = parsed.bin.expect("bin").into_owned();

        let mut missing_normal = base.clone();
        missing_normal["meshes"][0]["primitives"][0]["attributes"] = json!({"POSITION": 0});
        assert_eq!(
            parse_glb(&glb(missing_normal, bin.clone())).unwrap_err(),
            "TRIANGLES primitive missing NORMAL"
        );

        let mut invalid_cardinality = base.clone();
        invalid_cardinality["accessors"][2]["count"] = json!(2);
        assert_eq!(
            parse_glb(&glb(invalid_cardinality, bin.clone())).unwrap_err(),
            "TRIANGLES index count must be divisible by 3"
        );

        let mut texture = base.clone();
        texture["images"] = json!([{"uri": "data:image/png;base64,iVBORw0KGgo="}]);
        texture["textures"] = json!([{"source": 0}]);
        texture["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] = json!({"index": 0});
        assert_eq!(
            parse_glb(&glb(texture, bin.clone())).unwrap_err(),
            "texture-backed materials are not supported"
        );

        let mut morph = base.clone();
        morph["meshes"][0]["primitives"][0]["targets"] = json!([{"POSITION": 0}]);
        assert_eq!(
            parse_glb(&glb(morph, bin.clone())).unwrap_err(),
            "morph targets are not supported"
        );

        let mut skin = base;
        skin["skins"] = json!([{"joints": [0]}]);
        assert_eq!(
            parse_glb(&glb(skin, bin)).unwrap_err(),
            "skins are not supported"
        );
    }

    #[test]
    fn rejects_external_buffers_and_invalid_transforms() {
        let external = glb(
            json!({
                "asset": {"version": "2.0"},
                "buffers": [{"byteLength": 12, "uri": "mesh.bin"}]
            }),
            Vec::new(),
        );
        assert_eq!(
            parse_glb(&external).unwrap_err(),
            "external and data URI buffers are not supported"
        );

        let source = fixture(Layout::Packed, 5125, true);
        let parsed = gltf::binary::Glb::from_slice(&source).expect("fixture");
        let mut json: Value = serde_json::from_slice(&parsed.json).expect("json");
        json["nodes"][0]["scale"] = json!([0, 1, 1]);
        assert_eq!(
            parse_glb(&glb(json, parsed.bin.expect("bin").into_owned())).unwrap_err(),
            "node transform must be invertible"
        );
    }

    #[test]
    fn rejects_non_glb() {
        assert!(parse_glb(b"not a glb at all").is_err());

        let mut malformed_json = fixture(Layout::Packed, 5125, true);
        malformed_json[20] = b'!';
        assert!(parse_glb(&malformed_json).is_err());

        let source = fixture(Layout::Packed, 5125, true);
        let parsed = gltf::binary::Glb::from_slice(&source).expect("fixture");
        let mut json: Value = serde_json::from_slice(&parsed.json).expect("json");
        json["scene"] = json!(999);
        assert!(parse_glb(&glb(json, parsed.bin.expect("bin").into_owned())).is_err());
    }

    #[test]
    fn rejects_every_remaining_document_and_geometry_invariant() {
        let source = fixture(Layout::Packed, 5125, true);
        let parsed = gltf::binary::Glb::from_slice(&source).expect("fixture");
        let base: Value = serde_json::from_slice(&parsed.json).expect("json");
        let bin = parsed.bin.expect("bin").into_owned();

        let mut cases = Vec::new();

        let mut multiple_buffers = base.clone();
        multiple_buffers["buffers"] = json!([
            {"byteLength": bin.len()},
            {"byteLength": 0}
        ]);
        cases.push((
            multiple_buffers,
            bin.clone(),
            "only one embedded BIN buffer",
        ));

        let mut wrong_bin_length = base.clone();
        wrong_bin_length["buffers"][0]["byteLength"] = json!(bin.len() - 4);
        cases.push((wrong_bin_length, bin.clone(), "embedded BIN length"));

        let mut wrong_position_shape = base.clone();
        wrong_position_shape["accessors"][0]["type"] = json!("VEC2");
        cases.push((
            wrong_position_shape,
            bin.clone(),
            "POSITION must be a float32 VEC3",
        ));

        let mut wrong_normal_shape = base.clone();
        wrong_normal_shape["accessors"][1]["componentType"] = json!(5123);
        cases.push((
            wrong_normal_shape,
            bin.clone(),
            "NORMAL must be a float32 VEC3",
        ));

        let mut unsupported_mode = base.clone();
        unsupported_mode["meshes"][0]["primitives"][0]["mode"] = json!(0);
        cases.push((unsupported_mode, bin.clone(), "unsupported primitive mode"));

        let mut unsupported_attribute = base.clone();
        unsupported_attribute["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"] = json!(0);
        cases.push((
            unsupported_attribute,
            bin.clone(),
            "unsupported vertex attribute",
        ));

        let mut wrong_indices = base.clone();
        wrong_indices["accessors"][2]["type"] = json!("VEC2");
        cases.push((
            wrong_indices,
            bin.clone(),
            "indices must be unsigned SCALAR",
        ));

        let mut signed_indices = base.clone();
        signed_indices["accessors"][2]["componentType"] = json!(5122);
        cases.push((
            signed_indices,
            bin.clone(),
            "indices must be unsigned SCALAR",
        ));

        let mut normal_count = base.clone();
        normal_count["accessors"][1]["count"] = json!(2);
        cases.push((
            normal_count,
            bin.clone(),
            "NORMAL count does not match POSITION count",
        ));

        let mut line_cardinality = base.clone();
        line_cardinality["meshes"][0]["primitives"][0]["mode"] = json!(1);
        cases.push((
            line_cardinality,
            bin.clone(),
            "LINES index count must be divisible by 2",
        ));

        let mut duplicate_node = base.clone();
        duplicate_node["scenes"][0]["nodes"] = json!([0, 0]);
        cases.push((duplicate_node, bin.clone(), "appears more than once"));

        for (json, bytes, expected) in cases {
            let error = parse_glb(&glb(json, bytes)).unwrap_err();
            assert!(error.contains(expected));
        }

        let mut non_finite_position = bin.clone();
        non_finite_position[..4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(
            parse_glb(&glb(base.clone(), non_finite_position))
                .unwrap_err()
                .contains("POSITION values must be finite")
        );

        let mut non_finite_normal = bin.clone();
        non_finite_normal[36..40].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(
            parse_glb(&glb(base.clone(), non_finite_normal))
                .unwrap_err()
                .contains("NORMAL values must be finite")
        );

        let mut overflowing_transform = base.clone();
        overflowing_transform["nodes"][0]["scale"] = json!([f32::MAX, 1, 1]);
        assert!(
            parse_glb(&glb(overflowing_transform, bin.clone()))
                .unwrap_err()
                .contains("transformed POSITION values must be finite")
        );

        let mut out_of_range_index = bin;
        out_of_range_index[80..84].copy_from_slice(&3_u32.to_le_bytes());
        assert!(
            parse_glb(&glb(base, out_of_range_index))
                .unwrap_err()
                .contains("index out of range")
        );
    }

    #[test]
    fn private_transform_and_bounds_guards_reject_non_finite_math() {
        assert!(validate_transform(Mat4::from_cols_array(&[f32::NAN; 16])).is_err());
        assert!(validate_transform(Mat4::from_scale(Vec3::new(1.0e-39, 1.0e20, 1.0e20))).is_err());

        let scene = Scene {
            meshes: vec![MeshAsset {
                source_index: 0,
                manifold: None,
                primitives: vec![Primitive {
                    source_index: 0,
                    mode: MODE_TRIANGLES,
                    positions: vec![2.0, 0.0, 0.0],
                    normals: vec![1.0, 0.0, 0.0],
                    indices: vec![0],
                    material: Material {
                        base_color: [1.0; 4],
                        metallic: 1.0,
                        roughness: 1.0,
                    },
                }],
            }],
            instances: vec![MeshInstance {
                source_node_index: 0,
                mesh_index: 0,
                model: Mat4::from_scale(Vec3::splat(f32::MAX)),
                normal_matrix: Mat4::IDENTITY,
            }],
            topology_diagnostics: Vec::new(),
            bounds: None,
        };
        assert!(scene.for_each_draw_position(&mut drop).is_err());

        assert!(std::panic::catch_unwind(|| fixture(Layout::Packed, 0, true)).is_err());
    }

    #[test]
    fn document_without_any_scene_is_empty() {
        let scene = parse_glb(&glb(json!({"asset": {"version": "2.0"}}), Vec::new()))
            .expect("scene-less document");
        assert_eq!(scene.bounds, None);
        assert!(scene.meshes.is_empty());
        assert!(scene.instances.is_empty());
    }
}
