// Full-resolution, depth-derived screen-space AO. The hemisphere and bilateral
// denoiser follow the N8AO profile used by Tau's WebGL editing viewport.
struct AoFrame {
    projection: mat4x4<f32>,
    inverse_projection: mat4x4<f32>,
    // xy = output pixels; z = screen radius; w = distance falloff.
    viewport: vec4<f32>,
    // x = orthographic flag.
    controls: vec4<f32>,
}
@group(0) @binding(0) var<uniform> ao_frame: AoFrame;
@group(0) @binding(1) var ao_depth: texture_2d<f32>;
@group(0) @binding(2) var ao_input: texture_2d<f32>;
@group(0) @binding(3) var ao_sampler: sampler;
@group(0) @binding(4) var blue_noise: texture_2d<f32>;

@vertex
fn vs_ao(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}

fn ao_pixel(p: vec2<i32>) -> vec2<i32> {
    return clamp(p, vec2<i32>(0), vec2<i32>(ao_frame.viewport.xy) - 1);
}

fn ao_z(p: vec2<i32>) -> f32 {
    return textureLoad(ao_depth, ao_pixel(p), 0).r;
}

fn ao_position(p: vec2<f32>, z: f32) -> vec3<f32> {
    let ndc = vec2<f32>(p.x * 2.0 / ao_frame.viewport.x - 1.0,
        1.0 - p.y * 2.0 / ao_frame.viewport.y);
    let homogeneous = ao_frame.inverse_projection * vec4<f32>(ndc, 1.0, 1.0);
    let far_point = homogeneous.xyz / homogeneous.w;
    if (ao_frame.controls.x > 0.5) { return vec3<f32>(far_point.xy, z); }
    return far_point * (z / far_point.z);
}

fn ao_normal(p: vec2<i32>, center_z: f32) -> vec3<f32> {
    let center = ao_position(vec2<f32>(p) + 0.5, center_z);
    let left = vec2<i32>(p.x - 1, p.y);
    let right = vec2<i32>(p.x + 1, p.y);
    let bottom = vec2<i32>(p.x, p.y + 1);
    let top = vec2<i32>(p.x, p.y - 1);
    let l1 = ao_z(left); let l2 = ao_z(vec2<i32>(p.x - 2, p.y));
    let r1 = ao_z(right); let r2 = ao_z(vec2<i32>(p.x + 2, p.y));
    let b1 = ao_z(bottom); let b2 = ao_z(vec2<i32>(p.x, p.y + 2));
    let t1 = ao_z(top); let t2 = ao_z(vec2<i32>(p.x, p.y - 2));
    let dl = select(1e9, abs((2.0 * l1 - l2) - center_z), l1 != 0.0);
    let dr = select(1e9, abs((2.0 * r1 - r2) - center_z), r1 != 0.0);
    let db = select(1e9, abs((2.0 * b1 - b2) - center_z), b1 != 0.0);
    let dt = select(1e9, abs((2.0 * t1 - t2) - center_z), t1 != 0.0);
    let dx = select(ao_position(vec2<f32>(right) + 0.5, r1) - center,
        center - ao_position(vec2<f32>(left) + 0.5, l1), dl < dr);
    let dy = select(ao_position(vec2<f32>(top) + 0.5, t1) - center,
        center - ao_position(vec2<f32>(bottom) + 0.5, b1), db < dt);
    let n = cross(dx, dy);
    // Cross-product magnitude scales with scene units squared. Test the angle
    // between derivatives instead so millimetre CAD faces keep their normals.
    if (dot(n, n) <= 1e-6 * dot(dx, dx) * dot(dy, dy)) {
        return vec3<f32>(0.0, 0.0, 1.0);
    }
    return normalize(n);
}

fn ao_noise(p: vec2<i32>) -> vec4<f32> {
    let y = i32(ao_frame.viewport.y) - 1 - p.y;
    return textureLoad(blue_noise, vec2<i32>(p.x & 127, y & 127), 0);
}

@fragment
fn fs_ao_estimate(@builtin(position) fragment: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(fragment.xy);
    let z = ao_z(p);
    if (z == 0.0) { return vec4<f32>(1.0, 0.5, 0.5, 1.0); }
    let position = ao_position(fragment.xy, z);
    let normal = ao_normal(p, z);
    let radius = distance(position, ao_position(fragment.xy + vec2<f32>(ao_frame.viewport.z, 0.0), z));
    let falloff = max(radius * ao_frame.viewport.w, 1e-7);
    let helper = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(normal.y) > 0.99);
    let tangent = normalize(cross(helper, normal));
    let bitangent = cross(normal, tangent);
    let noise = ao_noise(p);
    let angle = noise.r * 6.28318530718;
    let radial = noise.g;
    var occluded = 0.0;
    var total = 0.0;
    for (var i = 0u; i < 16u; i++) {
        let k = f32(i);
        let r = sqrt((k + 0.5) / 16.0);
        let theta = 2.399963 * k + angle;
        let direction = tangent * (r * cos(theta)) + bitangent * (r * sin(theta))
            + normal * sqrt(1.0 - r * r);
        let sample_position = position + direction * radius * fract(radial + k / 16.0);
        let clip = ao_frame.projection * vec4<f32>(sample_position, 1.0);
        let ndc = clip.xyz / clip.w;
        let sample_pixel = vec2<f32>((ndc.x * 0.5 + 0.5) * ao_frame.viewport.x,
            (0.5 - ndc.y * 0.5) * ao_frame.viewport.y);
        if (all(sample_pixel >= vec2<f32>(0.0)) && all(sample_pixel < ao_frame.viewport.xy)
            && ndc.z > 0.0 && ndc.z < 1.0) {
            let sample_z = ao_z(vec2<i32>(sample_pixel));
            let separation = fragment.xy - floor(sample_pixel);
            let range_weight = smoothstep(0.0, 1.0, falloff / max(abs(sample_z - sample_position.z), 1e-7));
            if (sample_z != 0.0 && sample_z != z && -sample_z <= -sample_position.z
                && dot(separation, separation) >= 1.0) {
                occluded += range_weight;
            }
            total += 1.0;
        }
    }
    let visibility = clamp(1.0 - occluded / max(total, 1.0), 0.0, 1.0);
    return vec4<f32>(visibility, normal * 0.5 + 0.5);
}

override BLUR_INDEX: f32 = 0.0;
@fragment
fn fs_ao_blur(@builtin(position) fragment: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(fragment.xy);
    let uv = fragment.xy / ao_frame.viewport.xy;
    let data = textureSampleLevel(ao_input, ao_sampler, uv, 0.0);
    let z = ao_z(p);
    if (z == 0.0) { return data; }
    let position = ao_position(fragment.xy, z);
    let normal = data.gba * 2.0 - 1.0;
    let radius = distance(position, ao_position(fragment.xy + vec2<f32>(ao_frame.viewport.z, 0.0), z));
    let falloff = max(radius * ao_frame.viewport.w, 1e-7);
    let noise = ao_noise(p);
    let angle = select(noise.a, noise.b, BLUR_INDEX > 0.5) * 6.28318530718;
    var sum = data.r;
    var weight_sum = 1.0;
    for (var i = 0u; i < 8u; i++) {
        let k = f32(i);
        let r = pow((k + 1.0) / 8.0, 0.75) * 3.0;
        let theta = 6.28318530718 * 11.0 * k / 8.0 + angle;
        let sample_pixel = fragment.xy + vec2<f32>(cos(theta), sin(theta)) * r;
        if (all(sample_pixel >= vec2<f32>(0.0)) && all(sample_pixel < ao_frame.viewport.xy)) {
            let sample_uv = sample_pixel / ao_frame.viewport.xy;
            let sample_data = textureSampleLevel(ao_input, ao_sampler, sample_uv, 0.0);
            let sample_z = ao_z(vec2<i32>(sample_pixel));
            if (sample_z != 0.0) {
                let sample_position = ao_position(sample_pixel, sample_z);
                let sample_normal = sample_data.gba * 2.0 - 1.0;
                let tangent_distance = abs(dot(sample_position - position, normal));
                let weight = exp(-tangent_distance / falloff) * max(dot(normal, sample_normal), 0.0);
                sum += sample_data.r * weight;
                weight_sum += weight;
            }
        }
    }
    return vec4<f32>(clamp(sum / weight_sum, 0.0, 1.0), data.gba);
}
