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
