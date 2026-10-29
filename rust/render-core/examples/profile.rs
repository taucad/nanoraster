//! JSON-lines workload runner. Native pass profiling is separately opt-in via
//! NANORASTER_GPU_PROFILE=1; omit it for uncontaminated end-to-end latency.
use std::{
    io::{self, BufRead},
    time::Instant,
};
fn main() {
    let epoch = Instant::now();
    let clock = move || epoch.elapsed().as_secs_f64() * 1000.0;
    let mut renderer =
        pollster::block_on(render_core::Renderer::from_request(None)).expect("renderer");
    eprintln!(
        "adapter: {:?}",
        pollster::block_on(render_core::describe_adapter(None))
    );
    for line in io::stdin().lock().lines() {
        let request: serde_json::Value = serde_json::from_str(&line.expect("line")).expect("JSON");
        let glb = std::fs::read(request["fixture"].as_str().expect("fixture")).expect("GLB");
        let mut options = request["options"].clone();
        // Keep historical 5K benchmark inputs comparable after public 8K admission.
        if request["stress5k"] == true {
            options["width"] = 5120.into();
            options["height"] = 2880.into();
            for view in options["views"].as_array_mut().expect("views") {
                view["width"] = 5120.into();
                view["height"] = 2880.into();
            }
        }
        let options = options.to_string();
        let start = clock();
        let (images, timings) =
            pollster::block_on(renderer.render_images_request(&glb, &options, Some(&clock)))
                .expect("render");
        let wall = clock() - start;
        if let Some(prefix) = request["save"].as_str() {
            for (i, image) in images.iter().enumerate() {
                std::fs::write(format!("{prefix}-{i}.bin"), image).expect("save");
            }
        }
        println!(
            "{}",
            serde_json::json!({"case":request["case"],"wallMs":wall,"timings":timings,
            "profile":renderer.take_profile(),"hashes":images.iter().map(|bytes| {
                let mut hash = 0xcbf2_9ce4_8422_2325u64;
                for b in bytes { hash=(hash^u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3); }
                format!("{hash:016x}")
            }).collect::<Vec<_>>()})
        );
        if request["trim"] == true {
            renderer.trim_targets();
        }
    }
    renderer.destroy();
}
