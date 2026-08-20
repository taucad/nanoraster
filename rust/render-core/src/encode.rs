//! RGBA → PNG / WebP / JPEG encoders. All pure Rust so every artifact
//! (native, wasm, napi) produces byte-identical files from the same pixels —
//! jpeg-encoder's opt-in x86 `simd` feature stays off for the same reason.

use crate::{RenderError, Rendered};
use std::io::Write;

/// Output image format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    /// WebP with alpha. Quality 100 encodes lossless (VP8L); anything lower
    /// encodes lossy (VP8), mirroring Chrome's canvas `toBlob` semantics.
    WebP {
        quality: u8,
    },
    /// Baseline JPEG, 4:4:4 chroma (subsampling smears colored edge lines).
    /// No alpha channel: render with an opaque `RenderOptions::background`.
    Jpeg {
        quality: u8,
    },
}

impl ImageFormat {
    /// Binding-facing parse; `quality` (0-100) applies to webp and jpeg.
    pub fn from_name(name: &str, quality: u8) -> Result<Self, RenderError> {
        match name {
            "png" => Ok(Self::Png),
            "webp" => Ok(Self::WebP { quality }),
            "jpeg" | "jpg" => Ok(Self::Jpeg { quality }),
            other => Err(RenderError::Encode(format!(
                "unknown image format {other:?}"
            ))),
        }
    }
}

/// Encode rendered RGBA pixels in the requested format.
pub fn encode(rendered: &Rendered, format: ImageFormat) -> Result<Vec<u8>, RenderError> {
    match format {
        ImageFormat::Png => encode_png(rendered),
        ImageFormat::WebP { quality } => encode_webp(rendered, quality),
        ImageFormat::Jpeg { quality } => encode_jpeg(rendered, quality),
    }
}

fn validate_rendered(rendered: &Rendered) -> Result<(), RenderError> {
    let expected = u64::from(rendered.width)
        .checked_mul(u64::from(rendered.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .and_then(|bytes| usize::try_from(bytes).ok());
    if rendered.width == 0 || rendered.height == 0 || expected != Some(rendered.rgba.len()) {
        return Err(RenderError::Encode(format!(
            "RGBA length {} does not match {}x{}",
            rendered.rgba.len(),
            rendered.width,
            rendered.height
        )));
    }
    Ok(())
}

fn write_png(rendered: &Rendered, output: &mut impl Write) -> Result<(), RenderError> {
    validate_rendered(rendered)?;
    let mut encoder = png::Encoder::new(output, rendered.width, rendered.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|error| RenderError::Encode(error.to_string()))?;
    writer
        .write_image_data(&rendered.rgba)
        .map_err(|error| RenderError::Encode(error.to_string()))?;
    writer
        .finish()
        .map_err(|error| RenderError::Encode(error.to_string()))
}

/// Encode rendered RGBA pixels as PNG.
pub fn encode_png(rendered: &Rendered) -> Result<Vec<u8>, RenderError> {
    let mut out = Vec::new();
    write_png(rendered, &mut out)?;
    Ok(out)
}

fn write_webp(
    rendered: &Rendered,
    quality: u8,
    output: &mut impl Write,
) -> Result<(), RenderError> {
    validate_rendered(rendered)?;
    let mut encoder = image_webp::WebPEncoder::new(output);
    if quality < 100 {
        let mut params = image_webp::EncoderParams::default();
        params.use_lossy = true;
        params.lossy_quality = quality;
        encoder.set_params(params);
    }
    encoder
        .encode(
            &rendered.rgba,
            rendered.width,
            rendered.height,
            image_webp::ColorType::Rgba8,
        )
        .map_err(|error| RenderError::Encode(error.to_string()))
}

/// Encode rendered RGBA pixels as WebP (alpha preserved).
///
/// Quality 100 is lossless (VP8L); 0-99 is lossy (VP8, 4:2:0 chroma) with a
/// losslessly coded alpha channel.
pub fn encode_webp(rendered: &Rendered, quality: u8) -> Result<Vec<u8>, RenderError> {
    let mut out = Vec::new();
    write_webp(rendered, quality, &mut out)?;
    Ok(out)
}

fn write_jpeg(
    rendered: &Rendered,
    quality: u8,
    output: &mut impl Write,
) -> Result<(), RenderError> {
    let width = u16::try_from(rendered.width)
        .map_err(|_| RenderError::Encode("jpeg width exceeds 65535".into()))?;
    let height = u16::try_from(rendered.height)
        .map_err(|_| RenderError::Encode("jpeg height exceeds 65535".into()))?;
    validate_rendered(rendered)?;
    let mut encoder = jpeg_encoder::Encoder::new(output, quality.min(100));
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::F_1_1);
    encoder
        .encode(&rendered.rgba, width, height, jpeg_encoder::ColorType::Rgba)
        .map_err(|error| RenderError::Encode(error.to_string()))
}

/// Encode rendered RGBA pixels as baseline JPEG (no chroma subsampling).
///
/// JPEG has no alpha channel, so any translucent pixel is an error rather
/// than a silent black-background surprise — render with an opaque
/// `RenderOptions::background` first.
pub fn encode_jpeg(rendered: &Rendered, quality: u8) -> Result<Vec<u8>, RenderError> {
    if rendered
        .rgba
        .iter()
        .skip(3)
        .step_by(4)
        .any(|&alpha| alpha != 255)
    {
        return Err(RenderError::Encode(
            "jpeg has no alpha channel — render with an opaque background".into(),
        ));
    }
    let mut out = Vec::new();
    write_jpeg(rendered, quality, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FailAfter {
        writes: usize,
    }

    impl Write for FailAfter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            if self.writes == 0 {
                return Err(std::io::Error::other("injected writer failure"));
            }
            self.writes -= 1;
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// 4x4 gradient with the given constant alpha.
    fn gradient(alpha: u8) -> Rendered {
        let (width, height) = (4u32, 4u32);
        let mut rgba = Vec::new();
        for y in 0..height {
            for x in 0..width {
                rgba.extend_from_slice(&[(x * 60) as u8, (y * 60) as u8, 128, alpha]);
            }
        }
        Rendered {
            rgba,
            width,
            height,
        }
    }

    /// A larger high-entropy roundtrip: dense residuals stress the arithmetic
    /// coder's renormalisation and carry paths, and the varied alpha channel
    /// must survive exactly (lossy WebP codes alpha losslessly).
    #[test]
    fn lossy_webp_roundtrips_high_entropy_content() {
        let (width, height) = (193u32, 129u32);
        let mut state = 0x0dd5_eedd_00d5_eedau64;
        let mut rgba = Vec::new();
        for _ in 0..width * height {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let [red, green, blue, alpha, ..] = state.to_le_bytes();
            rgba.extend_from_slice(&[red, green, blue, alpha]);
        }
        let rendered = Rendered {
            rgba,
            width,
            height,
        };
        for quality in [10u8, 50, 90] {
            let bytes = encode_webp(&rendered, quality).expect("encode");
            let mut decoder =
                image_webp::WebPDecoder::new(std::io::Cursor::new(&bytes)).expect("decoder");
            assert_eq!(decoder.dimensions(), (width, height));
            let mut pixels = vec![0u8; decoder.output_buffer_size().expect("size")];
            decoder.read_image(&mut pixels).expect("decode");
            let alpha_matches = pixels
                .iter()
                .skip(3)
                .step_by(4)
                .zip(rendered.rgba.iter().skip(3).step_by(4))
                .all(|(decoded, original)| decoded == original);
            assert!(alpha_matches, "alpha diverged at quality {quality}");
        }
    }

    /// Odd dimensions exercise the trailing row and column of the lossy YUV
    /// conversion, which the vendored encoder once left as zeroed samples.
    #[test]
    fn lossy_webp_converts_odd_trailing_row_and_column() {
        let (width, height) = (17u32, 17u32);
        let rgba: Vec<u8> = std::iter::repeat_n([200u8, 40, 40, 255], (width * height) as usize)
            .flatten()
            .collect();
        let rendered = Rendered {
            rgba,
            width,
            height,
        };
        let bytes = encode_webp(&rendered, 90).expect("encode");
        let mut decoder =
            image_webp::WebPDecoder::new(std::io::Cursor::new(&bytes)).expect("decoder");
        let mut pixels = vec![0u8; decoder.output_buffer_size().expect("size")];
        decoder.read_image(&mut pixels).expect("decode");
        let worst_drift = pixels
            .chunks_exact(4)
            .flat_map(|pixel| {
                pixel[..3]
                    .iter()
                    .zip(&[200u8, 40, 40])
                    .map(|(channel, &expected)| channel.abs_diff(expected))
            })
            .max()
            .expect("pixels");
        assert!(worst_drift < 32, "worst channel drift {worst_drift}");
    }

    #[test]
    fn webp_roundtrips_losslessly() {
        let rendered = gradient(200);
        let bytes = encode_webp(&rendered, 100).expect("encode");
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");
        let mut decoder =
            image_webp::WebPDecoder::new(std::io::Cursor::new(&bytes)).expect("decoder");
        assert_eq!(decoder.dimensions(), (4, 4));
        let mut pixels = vec![0u8; decoder.output_buffer_size().expect("size")];
        decoder.read_image(&mut pixels).expect("decode");
        assert_eq!(pixels, rendered.rgba);
    }

    #[test]
    fn webp_below_quality_100_encodes_lossy_and_keeps_alpha() {
        let rendered = gradient(200);
        let bytes = encode_webp(&rendered, 75).expect("encode");
        // Lossy-with-alpha uses the extended container, not the VP8L chunk.
        assert!(!bytes.windows(4).any(|chunk| chunk == b"VP8L"));
        assert!(bytes.windows(4).any(|chunk| chunk == b"ALPH"));
        let mut decoder =
            image_webp::WebPDecoder::new(std::io::Cursor::new(&bytes)).expect("decoder");
        assert_eq!(decoder.dimensions(), (4, 4));
        let mut pixels = vec![0u8; decoder.output_buffer_size().expect("size")];
        decoder.read_image(&mut pixels).expect("decode");
        // Color channels are quantized; the alpha channel is coded losslessly.
        assert!(pixels.iter().skip(3).step_by(4).all(|&alpha| alpha == 200));
    }

    #[test]
    fn webp_quality_orders_output_size() {
        // Deterministic noise: smooth gradients are VP8L's best case and
        // would compress below the lossy floor, inverting the ordering.
        let (width, height) = (64u32, 64u32);
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut rgba = Vec::new();
        for _ in 0..width * height {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let [red, green, blue, ..] = state.to_le_bytes();
            rgba.extend_from_slice(&[red, green, blue, 255]);
        }
        let rendered = Rendered {
            rgba,
            width,
            height,
        };
        let low = encode_webp(&rendered, 25).expect("q25").len();
        let high = encode_webp(&rendered, 90).expect("q90").len();
        let lossless = encode_webp(&rendered, 100).expect("q100").len();
        assert!(low < high, "q25 {low} not below q90 {high}");
        assert!(high < lossless, "q90 {high} not below lossless {lossless}");
    }

    #[test]
    fn jpeg_encodes_opaque_and_rejects_translucent() {
        let bytes = encode_jpeg(&gradient(255), 85).expect("encode");
        assert_eq!(&bytes[..2], &[0xff, 0xd8]);
        let pixels = zune_jpeg::JpegDecoder::new(std::io::Cursor::new(bytes.as_slice()))
            .decode()
            .expect("decode");
        // Default zune-jpeg output is RGB: dims survived iff the length matches.
        assert_eq!(pixels.len(), 4 * 4 * 3);
        assert!(encode_jpeg(&gradient(254), 85).is_err());
    }

    #[test]
    fn parses_format_names() {
        assert!(matches!(
            ImageFormat::from_name("png", 85),
            Ok(ImageFormat::Png)
        ));
        assert!(matches!(
            ImageFormat::from_name("webp", 85),
            Ok(ImageFormat::WebP { quality: 85 })
        ));
        assert!(matches!(
            ImageFormat::from_name("jpg", 80),
            Ok(ImageFormat::Jpeg { quality: 80 })
        ));
        assert!(ImageFormat::from_name("gif", 85).is_err());
    }

    #[test]
    fn encoders_reject_invalid_shapes() {
        let empty = Rendered {
            rgba: Vec::new(),
            width: 1,
            height: 1,
        };
        assert!(encode_png(&empty).is_err());
        assert!(encode_webp(&empty, 100).is_err());
        assert!(encode_webp(&empty, 75).is_err());
        assert!(encode_jpeg(&empty, 85).is_err());

        let too_wide = Rendered {
            rgba: Vec::new(),
            width: 65_536,
            height: 1,
        };
        let too_tall = Rendered {
            rgba: Vec::new(),
            width: 1,
            height: 65_536,
        };
        assert_eq!(
            encode_jpeg(&too_wide, 85).unwrap_err().to_string(),
            "encode: jpeg width exceeds 65535"
        );
        assert_eq!(
            encode_jpeg(&too_tall, 85).unwrap_err().to_string(),
            "encode: jpeg height exceeds 65535"
        );
    }

    #[test]
    fn encoders_surface_writer_failures() {
        let rendered = gradient(255);
        let mut png_errors = 0;
        let mut webp_errors = 0;
        let mut webp_lossy_errors = 0;
        let mut jpeg_errors = 0;
        for writes in 0..64 {
            png_errors += usize::from(write_png(&rendered, &mut FailAfter { writes }).is_err());
            webp_errors +=
                usize::from(write_webp(&rendered, 100, &mut FailAfter { writes }).is_err());
            webp_lossy_errors +=
                usize::from(write_webp(&rendered, 75, &mut FailAfter { writes }).is_err());
            jpeg_errors +=
                usize::from(write_jpeg(&rendered, 85, &mut FailAfter { writes }).is_err());
        }
        assert!(png_errors > 2);
        assert!(webp_errors > 0);
        assert!(webp_lossy_errors > 0);
        assert!(jpeg_errors > 0);
    }
}
