//! Embedded PNG/JPEG/WebP maps, bounded decoding and color-correct mip chains.
//! A packed pixel buffer lets all seventeen glTF map slots work on the WebGPU
//! minimum of sixteen sampled textures without resizing unrelated images.

use crate::material::{number, vector};
use serde_json::Value;
use std::{collections::BTreeMap, io::Cursor};

pub(crate) const MAX_TEXTURE_PIXELS: usize = 16 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8192;
pub(crate) const MAX_UV_SETS: usize = 4;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct TextureSlot {
    pub(crate) data: [f32; 16],
}
impl TextureSlot {
    pub(crate) fn present(&self) -> bool {
        self.data[1].to_bits() != 0
    }
    pub(crate) fn uv_set(&self) -> usize {
        self.data[4].to_bits() as usize
    }
}

pub(crate) struct TextureStore<'a> {
    pub(crate) document: &'a gltf::Document,
    bin: &'a [u8],
    pub(crate) pixels: Vec<u32>,
    images: BTreeMap<(usize, bool), [u32; 4]>,
}

fn image_size(width: u32, height: u32) -> Result<usize, String> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || pixels > MAX_TEXTURE_PIXELS as u64
    {
        return Err(format!(
            "image dimensions {width}x{height} exceed the texture budget"
        ));
    }
    Ok(pixels as usize)
}

fn decode(bytes: &[u8], mime: &str) -> Result<(u32, u32, Vec<u8>), String> {
    match mime {
        "image/png" => {
            let mut decoder = png::Decoder::new(Cursor::new(bytes));
            decoder.set_limits(png::Limits {
                bytes: MAX_TEXTURE_PIXELS * 8,
            });
            decoder
                .set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
            let mut reader = decoder.read_info().map_err(|e| format!("PNG: {e}"))?;
            let count = image_size(reader.info().width, reader.info().height)?;
            if reader.info().animation_control.is_some() {
                return Err("animated textures are not supported".into());
            }
            let mut data = vec![
                0;
                reader
                    .output_buffer_size()
                    .ok_or("PNG output size overflow")?
            ];
            let info = reader
                .next_frame(&mut data)
                .map_err(|e| format!("PNG: {e}"))?;
            data.truncate(info.buffer_size());
            let mut rgba = Vec::with_capacity(count * 4);
            for pixel in data.chunks_exact(info.color_type.samples()) {
                let color = match info.color_type {
                    png::ColorType::Grayscale => [pixel[0], pixel[0], pixel[0], 255],
                    png::ColorType::GrayscaleAlpha => [pixel[0], pixel[0], pixel[0], pixel[1]],
                    png::ColorType::Rgb => [pixel[0], pixel[1], pixel[2], 255],
                    png::ColorType::Rgba => [pixel[0], pixel[1], pixel[2], pixel[3]],
                    png::ColorType::Indexed => return Err("PNG palette expansion failed".into()),
                };
                rgba.extend_from_slice(&color);
            }
            Ok((info.width, info.height, rgba))
        }
        "image/jpeg" => {
            use zune_jpeg::{
                JpegDecoder,
                zune_core::{colorspace::ColorSpace, options::DecoderOptions},
            };
            let options = DecoderOptions::default()
                .set_max_width(MAX_IMAGE_DIMENSION as usize)
                .set_max_height(MAX_IMAGE_DIMENSION as usize)
                .jpeg_set_max_scans(64)
                .jpeg_set_out_colorspace(ColorSpace::RGBA);
            let mut decoder = JpegDecoder::new_with_options(Cursor::new(bytes), options);
            decoder.decode_headers().map_err(|e| format!("JPEG: {e}"))?;
            let info = decoder.info().ok_or("JPEG missing dimensions")?;
            image_size(u32::from(info.width), u32::from(info.height))?;
            let pixels = decoder.decode().map_err(|e| format!("JPEG: {e}"))?;
            Ok((u32::from(info.width), u32::from(info.height), pixels))
        }
        "image/webp" => {
            let mut decoder = image_webp::WebPDecoder::new(Cursor::new(bytes))
                .map_err(|e| format!("WebP: {e}"))?;
            decoder.set_memory_limit(MAX_TEXTURE_PIXELS * 8);
            let (width, height) = decoder.dimensions();
            let count = image_size(width, height)?;
            if decoder.is_animated() {
                return Err("animated textures are not supported".into());
            }
            let mut pixels = vec![
                0;
                decoder
                    .output_buffer_size()
                    .ok_or("WebP output size overflow")?
            ];
            decoder
                .read_image(&mut pixels)
                .map_err(|e| format!("WebP: {e}"))?;
            if !decoder.has_alpha() {
                let mut rgba = Vec::with_capacity(count * 4);
                for pixel in pixels.chunks_exact(3) {
                    rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
                }
                pixels = rgba;
            }
            Ok((width, height, pixels))
        }
        _ => Err(format!("unsupported embedded image MIME type {mime}")),
    }
}

fn linear(value: u8, srgb: bool) -> f32 {
    let v = f32::from(value) / 255.0;
    if !srgb {
        v
    } else if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}
fn encoded(value: f32, srgb: bool) -> u8 {
    let v = if !srgb {
        value
    } else if value <= 0.0031308 {
        value * 12.92
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    };
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

impl<'a> TextureStore<'a> {
    pub(crate) fn new(document: &'a gltf::Document, bin: &'a [u8]) -> Self {
        // A non-empty binding is valid even for a scene with no maps.
        Self {
            document,
            bin,
            pixels: vec![u32::MAX],
            images: BTreeMap::new(),
        }
    }

    fn image(&mut self, index: usize, srgb: bool) -> Result<[u32; 4], String> {
        if let Some(&image) = self.images.get(&(index, srgb)) {
            return Ok(image);
        }
        let image = self
            .document
            .images()
            .nth(index)
            .ok_or_else(|| format!("missing image {index}"))?;
        let (bytes, mime) = match image.source() {
            gltf::image::Source::View { view, mime_type } => {
                let end = view
                    .offset()
                    .checked_add(view.length())
                    .ok_or("image bufferView overflow")?;
                (
                    self.bin
                        .get(view.offset()..end)
                        .ok_or("image bufferView exceeds BIN")?,
                    mime_type,
                )
            }
            gltf::image::Source::Uri { .. } => {
                return Err("textures must use embedded image bufferViews".into());
            }
        };
        let (mut width, mut height, mut rgba) = decode(bytes, mime)?;
        let mut count = 0usize;
        let (mut w, mut h) = (width, height);
        loop {
            count += w as usize * h as usize;
            if w == 1 && h == 1 {
                break;
            }
            w = (w / 2).max(1);
            h = (h / 2).max(1);
        }
        if self.pixels.len() + count > MAX_TEXTURE_PIXELS {
            return Err("decoded texture mip chains exceed the 16M-pixel budget".into());
        }
        let mut result = [self.pixels.len() as u32, width, height, 0];
        loop {
            self.pixels.extend(
                rgba.chunks_exact(4)
                    .map(|p| u32::from_le_bytes([p[0], p[1], p[2], p[3]])),
            );
            result[3] += 1;
            if width == 1 && height == 1 {
                break;
            }
            let (next_width, next_height) = ((width / 2).max(1), (height / 2).max(1));
            let mut next = Vec::with_capacity(next_width as usize * next_height as usize * 4);
            // Area box reduction includes the last row/column of odd-size maps.
            for y in 0..next_height {
                for x in 0..next_width {
                    let (x0, x1) = (x * width / next_width, (x + 1) * width / next_width);
                    let (y0, y1) = (y * height / next_height, (y + 1) * height / next_height);
                    for channel in 0..4 {
                        let mut sum = 0.0;
                        for yy in y0..y1 {
                            for xx in x0..x1 {
                                sum += linear(
                                    rgba[((yy * width + xx) * 4 + channel) as usize],
                                    srgb && channel < 3,
                                );
                            }
                        }
                        next.push(encoded(
                            sum / ((x1 - x0) * (y1 - y0)) as f32,
                            srgb && channel < 3,
                        ));
                    }
                }
            }
            rgba = next;
            width = next_width;
            height = next_height;
        }
        self.images.insert((index, srgb), result);
        Ok(result)
    }

    pub(crate) fn slot(&mut self, info: &Value, srgb: bool) -> Result<TextureSlot, String> {
        let index = info["index"]
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .ok_or("textureInfo.index must be a nonnegative integer")?;
        let texture = self
            .document
            .as_json()
            .textures
            .get(index)
            .ok_or_else(|| format!("missing texture {index}"))?;
        let raw = serde_json::to_value(texture).expect("glTF texture JSON");
        let source = raw["extensions"]["EXT_texture_webp"]["source"]
            .as_u64()
            .or_else(|| raw["source"].as_u64())
            .and_then(|v| usize::try_from(v).ok())
            .ok_or("texture requires an image source")?;
        let image = self.image(source, srgb)?;
        let sampler = match raw.get("sampler") {
            Some(index) => {
                let index = index
                    .as_u64()
                    .and_then(|v| usize::try_from(v).ok())
                    .ok_or("sampler must be an integer")?;
                serde_json::to_value(
                    self.document
                        .as_json()
                        .samplers
                        .get(index)
                        .ok_or("missing sampler")?,
                )
                .expect("sampler JSON")
            }
            None => Value::Null,
        };
        let enum_value = |key: &str, default: u32, choices: &[u32]| -> Result<u32, String> {
            let value = sampler.get(key).map_or(Ok(default), |v| {
                v.as_u64()
                    .and_then(|v| u32::try_from(v).ok())
                    .ok_or_else(|| format!("invalid {key}"))
            })?;
            if !choices.contains(&value) {
                return Err(format!("invalid {key}: {value}"));
            }
            Ok(value)
        };
        let wrap_s = enum_value("wrapS", 10497, &[10497, 33071, 33648])?;
        let wrap_t = enum_value("wrapT", 10497, &[10497, 33071, 33648])?;
        let mag = enum_value("magFilter", 9729, &[9728, 9729])?;
        let min = enum_value("minFilter", 9987, &[9728, 9729, 9984, 9985, 9986, 9987])?;
        let transform = &info["extensions"]["KHR_texture_transform"];
        if !transform.is_null() && !transform.is_object() {
            return Err("KHR_texture_transform must be an object".into());
        }
        let uv = transform
            .get("texCoord")
            .or_else(|| info.get("texCoord"))
            .map_or(Ok(0), |v| {
                v.as_u64()
                    .and_then(|v| usize::try_from(v).ok())
                    .ok_or("texCoord must be an integer")
            })?;
        if uv >= MAX_UV_SETS {
            return Err(format!("texCoord exceeds the {MAX_UV_SETS}-set budget"));
        }
        let offset = vector(transform, "offset", [0.0; 2], -f32::MAX, f32::MAX)?;
        let scale = vector(transform, "scale", [1.0; 2], -f32::MAX, f32::MAX)?;
        let rotation = number(transform, "rotation", 0.0, -f32::MAX, f32::MAX)?;
        let mut data = [0.0; 16];
        data[..4].copy_from_slice(&image.map(f32::from_bits));
        data[4..8].copy_from_slice(
            &[
                uv as u32,
                wrap_s,
                wrap_t,
                (mag - 9728) | (min << 1) | (u32::from(srgb) << 16),
            ]
            .map(f32::from_bits),
        );
        data[8..12].copy_from_slice(&[rotation.cos(), rotation.sin(), scale[0], scale[1]]);
        data[12..14].copy_from_slice(&offset);
        Ok(TextureSlot { data })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Rendered, encode_jpeg, encode_png, encode_webp};

    #[test]
    fn decodes_all_embedded_image_codecs_and_rejects_invalid_inputs() {
        let image = Rendered {
            width: 2,
            height: 2,
            rgba: [64u8, 128, 192, 255].repeat(4),
        };
        for (mime, bytes) in [
            ("image/png", encode_png(&image).unwrap()),
            ("image/jpeg", encode_jpeg(&image, 100).unwrap()),
            ("image/webp", encode_webp(&image, 100).unwrap()),
        ] {
            let (width, height, rgba) = decode(&bytes, mime).expect(mime);
            assert_eq!((width, height), (2, 2));
            assert_eq!(rgba.len(), 16);
            for (&actual, &expected) in rgba.iter().zip(&image.rgba) {
                assert!(
                    actual.abs_diff(expected) < 3,
                    "{mime}: {actual} != {expected}"
                );
            }
            assert!(decode(&bytes[..8], mime).is_err());
        }
        assert!(decode(&[], "image/svg+xml").is_err());
        for dimensions in [
            (0, 1),
            (1, 0),
            (8193, 1),
            (8192, 8192),
            (u32::MAX, u32::MAX),
        ] {
            assert!(image_size(dimensions.0, dimensions.1).is_err());
        }
    }

    #[test]
    fn mip_reduction_uses_linear_light_for_color_maps_and_retains_alpha() {
        let image = Rendered {
            width: 2,
            height: 1,
            rgba: vec![0, 0, 0, 255, 255, 255, 255, 255],
        };
        let bytes = encode_png(&image).unwrap();
        let document = gltf::Document::from_json(
            serde_json::from_value(serde_json::json!({
                "asset": {"version":"2.0"}, "buffers":[{"byteLength":bytes.len()}],
                "bufferViews":[{"buffer":0,"byteLength":bytes.len()}],
                "images":[{"bufferView":0,"mimeType":"image/png"}], "textures":[{"source":0}]
            }))
            .unwrap(),
        )
        .unwrap();
        let mut store = TextureStore::new(&document, &bytes);
        let color = store.slot(&serde_json::json!({"index":0}), true).unwrap();
        let data = store.slot(&serde_json::json!({"index":0}), false).unwrap();
        assert_eq!(
            store.pixels[color.data[0].to_bits() as usize + 2].to_le_bytes(),
            [188, 188, 188, 255]
        );
        assert_eq!(
            store.pixels[data.data[0].to_bits() as usize + 2].to_le_bytes(),
            [128, 128, 128, 255]
        );
        assert_eq!(
            store.slot(&serde_json::json!({"index":0}), true).unwrap(),
            color
        );
        assert_eq!(store.pixels.len(), 7, "one mip chain per image/color space");
        for info in [
            serde_json::json!({"index":9}),
            serde_json::json!({"index":-1}),
            serde_json::json!({"index":0,"texCoord":4}),
            serde_json::json!({"index":0,"texCoord":4294967296u64}),
            serde_json::json!({"index":0,"extensions":{"KHR_texture_transform":{"scale":[1]}}}),
        ] {
            assert!(store.slot(&info, true).is_err(), "{info}");
        }
        store.pixels.resize(MAX_TEXTURE_PIXELS, 0);
        store.images.clear();
        assert!(
            store
                .slot(&serde_json::json!({"index":0}), true)
                .unwrap_err()
                .contains("budget")
        );
    }
}
