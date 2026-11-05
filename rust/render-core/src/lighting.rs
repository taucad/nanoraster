//! Device-owned studio PMREM and integrated GGX response. The neutral room
//! contains equal RGB channels, so one filterable half-float channel suffices.
//! Reproduction and exact upstream identities live beside the embedded assets.

use wgpu::util::DeviceExt;

pub(crate) fn textures(device: &wgpu::Device, queue: &wgpu::Queue) -> [wgpu::TextureView; 2] {
    let mut reader = png::Decoder::new(std::io::Cursor::new(
        include_bytes!("../assets/studio.png").as_slice(),
    ))
    .read_info()
    .expect("embedded studio PNG");
    let mut pixels = vec![0; reader.output_buffer_size().expect("studio size")];
    reader
        .next_frame(&mut pixels)
        .expect("embedded studio pixels");
    [
        (
            "studio PMREM",
            768,
            1024,
            wgpu::TextureFormat::R16Float,
            pixels.as_slice(),
        ),
        (
            "integrated GGX",
            16,
            16,
            wgpu::TextureFormat::Rg16Float,
            include_bytes!("../assets/dfg.bin").as_slice(),
        ),
    ]
    .map(|(label, width, height, format, data)| {
        device
            .create_texture_with_data(
                queue,
                &wgpu::TextureDescriptor {
                    label: Some(label),
                    size: wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                wgpu::util::TextureDataOrder::LayerMajor,
                data,
            )
            .create_view(&wgpu::TextureViewDescriptor::default())
    })
}

/// Face size of the PMREM chain's first level in the Tau viewer
/// (`envResolution`). The chain's roughness schedule depends on it, so the
/// card prefilter steps through it even though the 512-pixel level itself is
/// never stored: like the embedded room, the map keeps 256 pixels and below.
const VIEWER_LOD_MAX: u32 = 9;
/// `LOD_MIN` and the extra-roughness tile count of Three's PMREM layout.
const LOD_MIN: u32 = 4;
const EXTRA_LODS: u32 = 6;
/// Three r184's WebGPU `PMREMGenerator` GGX sample count.
const GGX_SAMPLES: u32 = 512;
/// Size of the packed map, as `cube_uv` addresses it.
const MAP_SIZE: [u32; 2] = [768, 1024];

/// `Level` in `cards.wgsl`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Level {
    origin: [f32; 2],
    size: f32,
    roughness: f32,
    mip: f32,
    samples: u32,
    card_count: u32,
    analytic: u32,
}

impl Level {
    fn words(&self) -> [u32; 8] {
        [
            self.origin[0].to_bits(),
            self.origin[1].to_bits(),
            self.size.to_bits(),
            self.roughness.to_bits(),
            self.mip.to_bits(),
            self.samples,
            self.card_count,
            self.analytic,
        ]
    }
}

/// One PMREM chain step of Three's `_applyGGXFilter`, for chain index
/// `step` (1-based; step 0 is the viewer's unfiltered 512-pixel capture).
fn level(step: u32, card_count: u32) -> Level {
    let last = (VIEWER_LOD_MAX - LOD_MIN + EXTRA_LODS) as f32;
    let target = step as f32 / last;
    let source = (step - 1) as f32 / last;
    let size = 1u32 << VIEWER_LOD_MAX.saturating_sub(step).max(LOD_MIN);
    let extra = step.saturating_sub(VIEWER_LOD_MAX - LOD_MIN);
    Level {
        origin: [
            (3 * size * extra) as f32,
            (4 * ((MAP_SIZE[1] / 4) - size)) as f32,
        ],
        size: size as f32,
        roughness: (target * target - source * source).sqrt() * target * 1.25,
        mip: VIEWER_LOD_MAX as f32 - (step - 1) as f32,
        samples: GGX_SAMPLES,
        card_count,
        analytic: u32::from(step == 1),
    }
}

/// A card as `cards.wgsl` reads it: centre and radiance, then half-extent
/// vectors along its width and height. Orientation follows drei's
/// `Lightformer`: Euler XYZ when given, otherwise `Object3D.lookAt` of the
/// centre, which turns the card's +Z toward it with +Y kept up.
fn card_vectors(card: &crate::LightCard) -> [[f32; 4]; 3] {
    use glam::{Mat3, Vec3};
    let position = Vec3::from(card.position);
    let basis = match card.rotation {
        Some([x, y, z]) => {
            Mat3::from_rotation_x(x) * Mat3::from_rotation_y(y) * Mat3::from_rotation_z(z)
        }
        None => {
            // Three's Matrix4.lookAt(eye = target, target = position, up).
            let up = Vec3::Y;
            let mut forward = -position.normalize();
            let mut right = up.cross(forward);
            if right.length_squared() == 0.0 {
                // Three nudges x when up is ±Z; up here is +Y, so it nudges z.
                forward.z += 0.0001;
                forward = forward.normalize();
                right = up.cross(forward);
            }
            let right = right.normalize();
            Mat3::from_cols(right, forward.cross(right), forward)
        }
    };
    let width = basis.x_axis * (card.size[0] * 0.5);
    let height = basis.y_axis * (card.size[1] * 0.5);
    [
        position.extend(card.intensity).to_array(),
        width.extend(0.0).to_array(),
        height.extend(0.0).to_array(),
    ]
}

/// Prefilter an environment of light cards into the packed map `cube_uv`
/// reads, as Three's `PMREMGenerator` filters the viewer's Lightformer
/// capture: each GGX step reads the previous level. Runs once per distinct
/// card set; the caller keeps the result.
pub(crate) fn card_environment(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    cards: &[crate::LightCard],
) -> wgpu::TextureView {
    let map = |label, usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: MAP_SIZE[0],
                height: MAP_SIZE[1],
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R16Float,
            usage,
            view_formats: &[],
        })
    };
    let environment = map(
        "card PMREM",
        wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
    );
    let scratch = map(
        "card PMREM step",
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
    );
    let environment_view = environment.create_view(&wgpu::TextureViewDescriptor::default());
    let scratch_view = scratch.create_view(&wgpu::TextureViewDescriptor::default());
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("card PMREM"),
        source: wgpu::ShaderSource::Wgsl(
            [include_str!("lighting.wgsl"), include_str!("cards.wgsl")]
                .concat()
                .into(),
        ),
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("card PMREM"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_cards"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_cards"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::TextureFormat::R16Float.into())],
        }),
        multiview_mask: None,
        cache: None,
    });
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("card PMREM filtering"),
        min_filter: wgpu::FilterMode::Linear,
        mag_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });
    let mut card_data = [[[0f32; 4]; 3]; crate::MAX_LIGHT_CARDS];
    for (slot, card) in card_data.iter_mut().zip(cards) {
        *slot = card_vectors(card);
    }
    let card_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("light cards"),
        contents: bytemuck::cast_slice(&card_data),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let card_count = cards.len().min(crate::MAX_LIGHT_CARDS) as u32;
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("card PMREM"),
    });
    for step in 1..=VIEWER_LOD_MAX - LOD_MIN + EXTRA_LODS {
        let level = level(step, card_count);
        let level_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("card PMREM level"),
            contents: bytemuck::cast_slice(&level.words()),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("card PMREM level"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: level_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&environment_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: card_buffer.as_entire_binding(),
                },
            ],
        });
        let size = level.size as u32;
        let [x, y] = level.origin.map(|axis| axis as u32);
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("card PMREM step"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &scratch_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.set_viewport(
                x as f32,
                y as f32,
                (3 * size) as f32,
                (2 * size) as f32,
                0.0,
                1.0,
            );
            pass.set_scissor_rect(x, y, 3 * size, 2 * size);
            pass.draw(0..3, 0..1);
        }
        let origin = wgpu::Origin3d { x, y, z: 0 };
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &scratch,
                mip_level: 0,
                origin,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &environment,
                mip_level: 0,
                origin,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: 3 * size,
                height: 2 * size,
                depth_or_array_layers: 1,
            },
        );
    }
    queue.submit([encoder.finish()]);
    environment_view
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LightCard;
    use glam::Vec3;

    /// `cube_uv`'s placement of mip `mip` in the packed map: tile size and
    /// block origin. The prefilter must write each level exactly there.
    fn cube_uv_block(mip: f32) -> (f32, [f32; 2]) {
        let size = mip.max(4.0).exp2();
        (size, [(4.0 - mip).max(0.0) * 48.0, 4.0 * (256.0 - size)])
    }

    #[test]
    fn steps_follow_three_r184s_ggx_chain_into_cube_uvs_layout() {
        let steps: Vec<Level> = (1..=11).map(|step| level(step, 5)).collect();
        // A 512-pixel viewer capture has 12 levels: roughness steps of 1/11.
        let schedule = |step: f32| {
            let (target, source) = (step / 11.0, (step - 1.0) / 11.0);
            (target * target - source * source).sqrt() * target * 1.25
        };
        for (index, level) in steps.iter().enumerate() {
            let step = index as u32 + 1;
            // This step writes mip 9 - step and reads the one above it.
            let written = VIEWER_LOD_MAX as f32 - step as f32;
            assert_eq!(level.mip, written + 1.0, "step {step}");
            let (size, origin) = cube_uv_block(written);
            assert_eq!(level.size, size, "step {step}");
            assert_eq!(level.origin, origin, "step {step}");
            assert!(origin[0] + 3.0 * size <= MAP_SIZE[0] as f32);
            assert!(origin[1] + 2.0 * size <= MAP_SIZE[1] as f32);
            assert!((level.roughness - schedule(step as f32)).abs() < 1e-7);
            assert_eq!(level.samples, 512);
            assert_eq!(level.card_count, 5);
            assert_eq!(level.analytic, u32::from(step == 1));
        }
        assert_eq!(steps[0].size, 256.0);
        assert_eq!(steps[10].mip, -1.0);
        assert_eq!(level(3, 0).words()[2], 64f32.to_bits());
    }

    #[test]
    fn cards_face_the_centre_unless_rotated_like_lightformers() {
        // Object3D.lookAt points a mesh's +Z at the target with +Y up.
        let [center, width, height] = card_vectors(&LightCard {
            position: [0.0, 0.0, 2.0],
            size: [2.0, 4.0],
            intensity: 8.0,
            rotation: None,
        });
        assert_eq!(center, [0.0, 0.0, 2.0, 8.0]);
        assert_eq!(width, [-1.0, 0.0, 0.0, 0.0]);
        assert_eq!(height, [0.0, 2.0, 0.0, 0.0]);

        // A card straight above the centre takes Three's degenerate nudge.
        let [_, width, height] = card_vectors(&LightCard {
            position: [0.0, 3.0, 0.0],
            size: [1.0, 1.0],
            intensity: 1.0,
            rotation: None,
        });
        let normal = Vec3::from_slice(&width[..3]).cross(Vec3::from_slice(&height[..3]));
        assert!(normal.normalize().dot(Vec3::NEG_Y) > 0.999, "{normal}");

        // Euler XYZ: the viewer's top card turns its face down onto the scene.
        let [_, width, height] = card_vectors(&LightCard {
            position: [0.0, 3.0, 0.0],
            size: [3.0, 3.0],
            intensity: 0.25,
            rotation: Some([std::f32::consts::FRAC_PI_2, 0.0, 0.0]),
        });
        let normal = Vec3::from_slice(&width[..3]).cross(Vec3::from_slice(&height[..3]));
        assert!(
            (normal.normalize() - Vec3::NEG_Y).length() < 1e-6,
            "{normal}"
        );
        assert!((Vec3::from_slice(&width[..3]) - Vec3::new(1.5, 0.0, 0.0)).length() < 1e-6);
    }
}
