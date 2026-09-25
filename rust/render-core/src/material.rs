//! glTF material admission and the CPU/WGSL uniform contract. All values are
//! linear except encoded color textures; distances use glTF metres.

use crate::texture::{TextureSlot, TextureStore};
use serde_json::Value;

pub(crate) const MATERIAL_EXTENSIONS: &[&str] = &[
    "KHR_materials_anisotropy",
    "KHR_materials_clearcoat",
    "KHR_materials_dispersion",
    "KHR_materials_emissive_strength",
    "KHR_materials_ior",
    "KHR_materials_iridescence",
    "KHR_materials_sheen",
    "KHR_materials_specular",
    "KHR_materials_transmission",
    "KHR_materials_unlit",
    "KHR_materials_volume",
    "KHR_texture_transform",
    "EXT_texture_webp",
];
pub(crate) const TEXTURE_SLOTS: usize = 17;
pub(crate) const MATERIAL_FLOATS: usize = 44 + TEXTURE_SLOTS * 16;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Material {
    pub(crate) base_color: [f32; 4],
    pub(crate) metallic: f32,
    pub(crate) roughness: f32,
    /// 0 = OPAQUE, 1 = MASK, 2 = BLEND.
    pub(crate) alpha_mode: f32,
    pub(crate) alpha_cutoff: f32,
    pub(crate) emissive: [f32; 4],
    pub(crate) specular: [f32; 4],
    /// transmission, thickness, IOR, dispersion.
    pub(crate) transmission: [f32; 4],
    /// RGB absorption tint; reciprocal attenuation distance (0 = infinity).
    pub(crate) attenuation: [f32; 4],
    /// clearcoat, clearcoat roughness, double sided, clearcoat normal scale.
    pub(crate) coat: [f32; 4],
    pub(crate) sheen: [f32; 4],
    /// strength, cos(rotation), sin(rotation), unlit.
    pub(crate) anisotropy: [f32; 4],
    pub(crate) iridescence: [f32; 4],
    /// normal scale, occlusion strength, reserved, reserved.
    pub(crate) misc: [f32; 4],
    pub(crate) textures: [TextureSlot; TEXTURE_SLOTS],
}

impl Default for Material {
    fn default() -> Self {
        Self {
            base_color: [1.0; 4],
            metallic: 1.0,
            roughness: 1.0,
            alpha_mode: 0.0,
            alpha_cutoff: 0.5,
            emissive: [0.0; 4],
            specular: [1.0; 4],
            transmission: [0.0, 0.0, 1.5, 0.0],
            attenuation: [1.0, 1.0, 1.0, 0.0],
            coat: [0.0, 0.0, 0.0, 1.0],
            sheen: [0.0; 4],
            anisotropy: [0.0, 1.0, 0.0, 0.0],
            iridescence: [0.0, 1.3, 100.0, 400.0],
            misc: [1.0, 1.0, 0.0, 0.0],
            textures: [TextureSlot::default(); TEXTURE_SLOTS],
        }
    }
}

pub(crate) fn number(
    object: &Value,
    key: &str,
    default: f32,
    min: f32,
    max: f32,
) -> Result<f32, String> {
    let Some(value) = object.get(key) else {
        return Ok(default);
    };
    let value = value
        .as_f64()
        .ok_or_else(|| format!("{key} must be a number"))? as f32;
    if !value.is_finite() || value < min || value > max {
        return Err(format!("{key} must be finite and in [{min}, {max}]"));
    }
    Ok(value)
}

pub(crate) fn vector<const N: usize>(
    object: &Value,
    key: &str,
    default: [f32; N],
    min: f32,
    max: f32,
) -> Result<[f32; N], String> {
    let Some(value) = object.get(key) else {
        return Ok(default);
    };
    let values = value
        .as_array()
        .filter(|values| values.len() == N)
        .ok_or_else(|| format!("{key} must contain {N} numbers"))?;
    let mut result = [0.0; N];
    for (i, value) in values.iter().enumerate() {
        result[i] = value
            .as_f64()
            .ok_or_else(|| format!("{key}[{i}] must be a number"))? as f32;
        if !result[i].is_finite() || result[i] < min || result[i] > max {
            return Err(format!("{key}[{i}] must be finite and in [{min}, {max}]"));
        }
    }
    Ok(result)
}

impl Material {
    pub(crate) fn uniform(&self) -> [f32; MATERIAL_FLOATS] {
        let mut data = [0.0; MATERIAL_FLOATS];
        for (i, row) in [
            self.base_color,
            [
                self.metallic,
                self.roughness,
                self.alpha_mode,
                self.alpha_cutoff,
            ],
            self.emissive,
            self.specular,
            self.transmission,
            self.attenuation,
            self.coat,
            self.sheen,
            self.anisotropy,
            self.iridescence,
            self.misc,
        ]
        .iter()
        .enumerate()
        {
            data[i * 4..i * 4 + 4].copy_from_slice(row);
        }
        for (i, texture) in self.textures.iter().enumerate() {
            data[44 + i * 16..44 + (i + 1) * 16].copy_from_slice(&texture.data);
        }
        data
    }

    pub(crate) fn transparent(&self) -> bool {
        self.alpha_mode == 2.0 || self.transmission[0] > 0.0
    }

    pub(crate) fn parse(
        material: &gltf::Material<'_>,
        store: &mut TextureStore<'_>,
    ) -> Result<Self, String> {
        let raw = material
            .index()
            .map(|i| {
                serde_json::to_value(&store.document.as_json().materials[i])
                    .expect("glTF material JSON")
            })
            .unwrap_or_else(|| serde_json::json!({}));
        let pbr = &raw["pbrMetallicRoughness"];
        let extensions = &raw["extensions"];
        for &name in MATERIAL_EXTENSIONS {
            if let Some(value) = extensions.get(name)
                && !value.is_object()
            {
                return Err(format!("{name} must be an object"));
            }
        }
        let mut result = Self {
            base_color: vector(pbr, "baseColorFactor", [1.0; 4], 0.0, 1.0)?,
            metallic: number(pbr, "metallicFactor", 1.0, 0.0, 1.0)?,
            roughness: number(pbr, "roughnessFactor", 1.0, 0.0, 1.0)?,
            alpha_mode: match material.alpha_mode() {
                gltf::material::AlphaMode::Opaque => 0.0,
                gltf::material::AlphaMode::Mask => 1.0,
                gltf::material::AlphaMode::Blend => 2.0,
            },
            alpha_cutoff: number(&raw, "alphaCutoff", 0.5, 0.0, f32::MAX)?,
            ..Self::default()
        };
        result.coat[2] = f32::from(material.double_sided());
        let emission = vector(&raw, "emissiveFactor", [0.0; 3], 0.0, 1.0)?;
        let strength = number(
            &extensions["KHR_materials_emissive_strength"],
            "emissiveStrength",
            1.0,
            0.0,
            f32::MAX,
        )?
        .min(65504.0); // The HDR scene target is Rgba16Float.
        result.emissive = [
            emission[0] * strength,
            emission[1] * strength,
            emission[2] * strength,
            0.0,
        ];
        result.misc[0] = number(&raw["normalTexture"], "scale", 1.0, -f32::MAX, f32::MAX)?;
        result.misc[1] = number(&raw["occlusionTexture"], "strength", 1.0, 0.0, 1.0)?;
        let e = &extensions["KHR_materials_specular"];
        result.specular[..3].copy_from_slice(&vector(
            e,
            "specularColorFactor",
            [1.0; 3],
            0.0,
            1.0,
        )?);
        result.specular[3] = number(e, "specularFactor", 1.0, 0.0, 1.0)?;
        result.transmission[0] = number(
            &extensions["KHR_materials_transmission"],
            "transmissionFactor",
            0.0,
            0.0,
            1.0,
        )?;
        result.transmission[2] =
            number(&extensions["KHR_materials_ior"], "ior", 1.5, 0.0, f32::MAX)?;
        if result.transmission[2] > 0.0 && result.transmission[2] < 1.0 {
            return Err("ior must be 0 or at least 1".into());
        }
        result.transmission[3] = number(
            &extensions["KHR_materials_dispersion"],
            "dispersion",
            0.0,
            0.0,
            f32::MAX,
        )?;
        let e = &extensions["KHR_materials_volume"];
        result.transmission[1] = number(e, "thicknessFactor", 0.0, 0.0, f32::MAX)?;
        result.attenuation[..3].copy_from_slice(&vector(
            e,
            "attenuationColor",
            [1.0; 3],
            0.0,
            1.0,
        )?);
        if e.get("attenuationDistance").is_some() {
            let distance = number(e, "attenuationDistance", 1.0, f32::MIN_POSITIVE, f32::MAX)?;
            result.attenuation[3] = 1.0 / distance;
        }
        let e = &extensions["KHR_materials_clearcoat"];
        result.coat[0] = number(e, "clearcoatFactor", 0.0, 0.0, 1.0)?;
        result.coat[1] = number(e, "clearcoatRoughnessFactor", 0.0, 0.0, 1.0)?;
        result.coat[3] = number(
            &e["clearcoatNormalTexture"],
            "scale",
            1.0,
            -f32::MAX,
            f32::MAX,
        )?;
        let e = &extensions["KHR_materials_sheen"];
        result.sheen[..3].copy_from_slice(&vector(e, "sheenColorFactor", [0.0; 3], 0.0, 1.0)?);
        result.sheen[3] = number(e, "sheenRoughnessFactor", 0.0, 0.0, 1.0)?;
        let e = &extensions["KHR_materials_anisotropy"];
        result.anisotropy[0] = number(e, "anisotropyStrength", 0.0, 0.0, 1.0)?;
        let rotation = number(e, "anisotropyRotation", 0.0, -f32::MAX, f32::MAX)?;
        result.anisotropy[1] = rotation.cos();
        result.anisotropy[2] = rotation.sin();
        result.anisotropy[3] = f32::from(extensions.get("KHR_materials_unlit").is_some());
        if result.anisotropy[3] != 0.0 && extensions.get("KHR_materials_anisotropy").is_some() {
            return Err(
                "KHR_materials_anisotropy cannot be combined with KHR_materials_unlit".into(),
            );
        }
        let e = &extensions["KHR_materials_iridescence"];
        result.iridescence = [
            number(e, "iridescenceFactor", 0.0, 0.0, 1.0)?,
            number(e, "iridescenceIor", 1.3, 1.0, f32::MAX)?,
            number(e, "iridescenceThicknessMinimum", 100.0, 0.0, f32::MAX)?,
            number(e, "iridescenceThicknessMaximum", 400.0, 0.0, f32::MAX)?,
        ];
        if result.iridescence[2] > result.iridescence[3] {
            return Err("iridescence thickness minimum exceeds maximum".into());
        }
        // Slot order is shared with shader.wgsl. RGB color maps use sRGB;
        // specular's alpha and every scalar/direction map are linear.
        let maps = [
            (&pbr["baseColorTexture"], true),
            (&pbr["metallicRoughnessTexture"], false),
            (&raw["normalTexture"], false),
            (&raw["occlusionTexture"], false),
            (&raw["emissiveTexture"], true),
            (
                &extensions["KHR_materials_anisotropy"]["anisotropyTexture"],
                false,
            ),
            (
                &extensions["KHR_materials_clearcoat"]["clearcoatTexture"],
                false,
            ),
            (
                &extensions["KHR_materials_clearcoat"]["clearcoatRoughnessTexture"],
                false,
            ),
            (
                &extensions["KHR_materials_clearcoat"]["clearcoatNormalTexture"],
                false,
            ),
            (&e["iridescenceTexture"], false),
            (&e["iridescenceThicknessTexture"], false),
            (
                &extensions["KHR_materials_sheen"]["sheenColorTexture"],
                true,
            ),
            (
                &extensions["KHR_materials_sheen"]["sheenRoughnessTexture"],
                false,
            ),
            (
                &extensions["KHR_materials_specular"]["specularTexture"],
                false,
            ),
            (
                &extensions["KHR_materials_specular"]["specularColorTexture"],
                true,
            ),
            (
                &extensions["KHR_materials_transmission"]["transmissionTexture"],
                false,
            ),
            (
                &extensions["KHR_materials_volume"]["thicknessTexture"],
                false,
            ),
        ];
        for (slot, (info, srgb)) in maps.into_iter().enumerate() {
            if !info.is_null() {
                result.textures[slot] = store.slot(info, srgb)?;
            }
        }
        Ok(result)
    }
}
