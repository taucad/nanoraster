//! Native opt-in pass queries and descriptor accounting; compiled out of releases.
use super::{RenderError, SizedTargets};
use serde_json::{Value, json};
use std::time::Instant;

pub(super) fn features(adapter: &wgpu::Adapter) -> wgpu::Features {
    requested_features(
        adapter.features(),
        std::env::var_os("NANORASTER_GPU_PROFILE").as_deref() == Some(std::ffi::OsStr::new("1")),
    )
}

fn requested_features(available: wgpu::Features, enabled: bool) -> wgpu::Features {
    if enabled {
        available & wgpu::Features::TIMESTAMP_QUERY
    } else {
        wgpu::Features::empty()
    }
}

pub(super) struct Probe {
    queries: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    readback: wgpu::Buffer,
    labels: Vec<String>,
    receipt: Value,
    started: Instant,
}

fn texture(label: &str, view: &wgpu::TextureView) -> Value {
    let t = view.texture();
    let bytes_per_texel = t
        .format()
        .block_copy_size(None)
        .expect("uncompressed target");
    let bytes: u64 = (0..t.mip_level_count())
        .map(|level| {
            u64::from((t.width() >> level).max(1))
                * u64::from((t.height() >> level).max(1))
                * u64::from(bytes_per_texel)
                * u64::from(t.sample_count())
        })
        .sum();
    json!({"label":label,"width":t.width(),"height":t.height(),"format":format!("{:?}",t.format()),
        "samples":t.sample_count(),"mips":t.mip_level_count(),"logicalBytes":bytes,
        "transient":t.usage().contains(wgpu::TextureUsages::TRANSIENT_ATTACHMENT)})
}

pub(super) fn ledger(t: &SizedTargets) -> Value {
    let mut textures = vec![
        texture("final MSAA", &t.msaa_view),
        texture("HDR MSAA", &t.hdr_msaa),
        texture("opaque HDR", &t.opaque_view),
        texture("geometry depth", &t.depth_view),
        texture("resolve", &t.resolve_view),
    ];
    if let Some(composite) = &t.composite_view {
        textures.push(texture("composite HDR", composite));
    }
    if let Some(ao) = &t.ao {
        textures.extend([
            texture("AO view depth", &ao.depth_view),
            texture("AO test depth", &ao.test_depth_view),
            texture("AO estimate", &ao.estimate_view),
            texture("AO denoise", &ao.blur_view),
        ]);
    }
    let readback: Vec<_> = t.readback.iter().map(|b| b.size()).collect();
    let texture_bytes: u64 = textures
        .iter()
        .map(|t| t["logicalBytes"].as_u64().unwrap())
        .sum();
    let transient_bytes: u64 = textures
        .iter()
        .filter(|t| t["transient"] == true)
        .map(|t| t["logicalBytes"].as_u64().unwrap())
        .sum();
    json!({"textures":textures,"textureBytes":texture_bytes,"transientTextureBytes":transient_bytes,"readbackBytes":readback,
        "targetBytes":texture_bytes + readback.iter().sum::<u64>()})
}

fn timestamp_ms(begin: u64, end: u64, period: f32) -> Option<f64> {
    (begin > 0 && end >= begin).then(|| (end - begin) as f64 * f64::from(period) / 1_000_000.0)
}

fn frame_span_ms(stamps: &[u64], period: f32) -> Option<f64> {
    // Never turn a missing outer endpoint into a shorter, apparently valid
    // frame by selecting only the internal passes whose queries completed.
    timestamp_ms(*stamps.first()?, *stamps.last()?, period)
}

impl Probe {
    pub(super) fn new(
        device: &wgpu::Device,
        receipt: impl FnOnce() -> Value,
        started: Instant,
    ) -> Option<Self> {
        if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            return None;
        }
        Some(Self {
            queries: device.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("benchmark pass timestamps"),
                ty: wgpu::QueryType::Timestamp,
                count: 128,
            }),
            resolve: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("benchmark timestamp resolve"),
                size: 1024,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            readback: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("benchmark timestamp readback"),
                size: 1024,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            }),
            labels: Vec::new(),
            receipt: receipt(),
            started,
        })
    }
    pub(super) fn pass(&mut self, label: &str) -> wgpu::RenderPassTimestampWrites<'_> {
        let index = self.labels.len() as u32 * 2;
        assert!(index + 1 < 128, "benchmark query capacity");
        self.labels.push(label.into());
        wgpu::RenderPassTimestampWrites {
            query_set: &self.queries,
            beginning_of_pass_write_index: Some(index),
            end_of_pass_write_index: Some(index + 1),
        }
    }
    pub(super) fn resolve(&self, encoder: &mut wgpu::CommandEncoder) {
        let count = self.labels.len() as u32 * 2;
        encoder.resolve_query_set(&self.queries, 0..count, &self.resolve, 0);
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &self.readback, 0, u64::from(count) * 8);
    }
    pub(super) fn map(&mut self) {
        self.receipt["cpuSubmitMs"] = json!(self.started.elapsed().as_secs_f64() * 1000.0);
        self.readback.map_async(wgpu::MapMode::Read, .., |_| {});
    }
    pub(super) fn read(&self, period: f32) -> Result<Value, RenderError> {
        let data = self
            .readback
            .get_mapped_range(..)
            .map_err(super::mapped_range_error)?;
        let stamps: Vec<u64> = data
            .as_chunks::<8>()
            .0
            .iter()
            .map(|b| u64::from_le_bytes(*b))
            .collect();
        let passes: Vec<_> = self.labels.iter().enumerate().map(|(i,label)| json!({"label":label,
            "beginTicks":stamps[i*2], "endTicks":stamps[i*2+1], "gpuMs":timestamp_ms(stamps[i*2], stamps[i*2+1], period)})).collect();
        let mut receipt = self.receipt.clone();
        receipt["passes"] = json!(passes);
        receipt["gpuSpanMs"] = json!(frame_span_ms(&stamps[..self.labels.len() * 2], period));
        receipt["timestampPeriodNs"] = json!(period);
        drop(data);
        self.readback.unmap();
        Ok(receipt)
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        self.queries.destroy();
        self.resolve.destroy();
        self.readback.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_timestamps_are_not_zero_cost_or_partial_frame_spans() {
        assert_eq!(timestamp_ms(10, 0, 1.0), None);
        assert_eq!(timestamp_ms(0, 20, 1.0), None);
        assert_eq!(timestamp_ms(20, 10, 1.0), None);
        assert_eq!(timestamp_ms(10, 10, 1.0), Some(0.0));
        assert_eq!(frame_span_ms(&[10, 20, 21, 0], 1.0), None);
        assert_eq!(frame_span_ms(&[0, 20, 21, 30], 1.0), None);
        assert_eq!(frame_span_ms(&[], 1.0), None);
        // Missing internal end: outer endpoints still bound the full frame.
        assert_eq!(frame_span_ms(&[10, 0, 21, 30], 1.0), Some(0.00002));
        assert_eq!(frame_span_ms(&[10, 20, 21, 30], 1.0), Some(0.00002));
    }

    #[test]
    fn queries_require_opt_in_and_adapter_support() {
        let available = wgpu::Features::TIMESTAMP_QUERY;
        assert_eq!(
            requested_features(available, false),
            wgpu::Features::empty()
        );
        assert_eq!(
            requested_features(wgpu::Features::empty(), true),
            wgpu::Features::empty()
        );
        assert_eq!(requested_features(available, true), available);
    }

    #[test]
    fn disabled_device_does_not_allocate_a_probe() {
        let instance = wgpu::Instance::default();
        let adapter =
            pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
        let (device, _) =
            pollster::block_on(adapter.request_device(&Default::default())).expect("device");
        assert!(Probe::new(&device, Value::default, Instant::now()).is_none());
    }
}
