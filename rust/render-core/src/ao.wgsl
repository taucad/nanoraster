// Ground-truth AO matching the Tau viewer's post-processing: three.js r184
// GTAONode (samples split into slices and steps as GTAONode does, magic-square
// noise, no temporal rotation) at `resolutionScale` of the drawing buffer, Tau's
// 13-tap edge-aware denoiser with outlier trimming at the same resolution, then
// a depth/normal-guided upsample. Every pass reads the depth pass's mesh normals
// at the full-resolution texel of its depth, as the viewer's MRT provides them.
struct AoFrame {
    projection: mat4x4<f32>,
    inverse_projection: mat4x4<f32>,
    // xy = output pixels; z = world-space radius at the camera target; w = distance falloff.
    viewport: vec4<f32>,
    // x = orthographic flag; y = visibility exponent; z = thickness; w = denoise depth phi.
    controls: vec4<f32>,
    // x = slices; y = steps per slice, fractional as GTAONode's float uniform keeps it.
    sampling: vec4<f32>,
}
@group(0) @binding(0) var<uniform> ao_frame: AoFrame;
@group(0) @binding(1) var ao_depth: texture_2d<f32>;
@group(0) @binding(2) var ao_input: texture_2d<f32>;
@group(0) @binding(3) var ao_sampler: sampler;
@group(0) @binding(4) var blue_noise: texture_2d<f32>;
@group(0) @binding(5) var ao_normals: texture_2d<f32>;

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

// The viewer's `decodeAoNormal` of the depth pass's octahedral RG8 normal:
// one surface's normal at the texel, never a blend.
fn ao_normal(p: vec2<i32>) -> vec3<f32> {
    let encoded = textureLoad(ao_normals, ao_pixel(p), 0).rg;
    let xy = (encoded * 255.0 - 1.0) / 254.0 * 2.0 - 1.0;
    let n = vec3<f32>(xy, 1.0 - abs(xy.x) - abs(xy.y));
    let fold = max(-n.z, 0.0);
    return normalize(vec3<f32>(n.xy + select(vec2<f32>(fold), vec2<f32>(-fold), n.xy >= vec2<f32>(0.0)), n.z));
}

// three.js GTAONode's 5x5 magic-square rotation noise, quantized as its
// Uint8 DataTexture stores it (xy = cos/sin of the slice rotation).
const MAGIC_NOISE = array<vec2<f32>, 25>(
vec2<f32>(0.180392157, 0.882352941),
vec2<f32>(0.862745098, 0.839215686),
vec2<f32>(0.862745098, 0.156862745),
vec2<f32>(0.180392157, 0.113725490),
vec2<f32>(0.094117647, 0.203921569),
vec2<f32>(0.937254902, 0.737254902),
vec2<f32>(0.764705882, 0.074509804),
vec2<f32>(0.650980392, 0.023529412),
vec2<f32>(0.031372549, 0.313725490),
vec2<f32>(0.286274510, 0.949019608),
vec2<f32>(1.000000000, 0.498039216),
vec2<f32>(0.529411765, 0.000000000),
vec2<f32>(0.003921569, 0.435294118),
vec2<f32>(0.403921569, 0.988235294),
vec2<f32>(0.980392157, 0.623529412),
vec2<f32>(0.403921569, 0.007843137),
vec2<f32>(0.003921569, 0.560784314),
vec2<f32>(0.529411765, 0.996078431),
vec2<f32>(0.650980392, 0.972549020),
vec2<f32>(0.980392157, 0.372549020),
vec2<f32>(0.031372549, 0.682352941),
vec2<f32>(0.094117647, 0.792156863),
vec2<f32>(0.764705882, 0.921568627),
vec2<f32>(0.937254902, 0.258823529),
vec2<f32>(0.286274510, 0.047058824)
);

fn ao_noise_rotation(p: vec2<i32>, size: vec2<i32>) -> vec2<f32> {
    // GTAONode samples at (u, 1 - v) with repeat wrapping and nearest filtering.
    let y = size.y - 1 - p.y;
    let n = MAGIC_NOISE[(p.x % 5) + 5 * (y % 5)];
    return n * 2.0 - 1.0;
}

// The AO texel's full-resolution depth texel, as Tau's `aoTexel` selects it.
fn ao_full_pixel(uv: vec2<f32>) -> vec2<i32> {
    return ao_pixel(vec2<i32>(floor(uv * ao_frame.viewport.xy)));
}

fn ao_project(position: vec3<f32>) -> vec2<f32> {
    let clip = ao_frame.projection * vec4<f32>(position, 1.0);
    let ndc = clip.xy / clip.w;
    return vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

fn ao_uv_position(uv: vec2<f32>, z: f32) -> vec3<f32> {
    return ao_position(uv * ao_frame.viewport.xy, z);
}

@fragment
fn fs_ao_estimate(@builtin(position) fragment: vec4<f32>) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(ao_input));
    let uv = fragment.xy / vec2<f32>(size);
    let full = ao_full_pixel(uv);
    let z = ao_z(full);
    if (z == 0.0) { return vec4<f32>(1.0, 0.5, 0.5, 1.0); }
    let view_position = ao_uv_position(uv, z);
    let view_normal = ao_normal(full);
    let radius = ao_frame.viewport.z;
    let thickness = ao_frame.controls.z;
    let falloff = ao_frame.viewport.w;
    let rotation = ao_noise_rotation(vec2<i32>(fragment.xy), size);
    let tangent = normalize(vec3<f32>(rotation, 0.0));
    let bitangent = vec3<f32>(-tangent.y, tangent.x, 0.0);
    let kernel = mat3x3<f32>(tangent, bitangent, vec3<f32>(0.0, 0.0, 1.0));
    let view_dir = normalize(-view_position);
    let slices = ao_frame.sampling.x;
    let steps = ao_frame.sampling.y;
    var ao = 0.0;
    for (var i = 0; i < i32(slices); i++) {
        let angle = f32(i) / slices * 3.14159265359;
        let sample_dir = normalize(kernel * vec3<f32>(cos(angle), sin(angle), 0.0));
        let slice_bitangent = normalize(cross(sample_dir, view_dir));
        let slice_tangent = cross(slice_bitangent, view_dir);
        let normal_in_slice = normalize(view_normal - slice_bitangent * dot(view_normal, slice_bitangent));
        let tangent_to_normal = cross(normal_in_slice, slice_bitangent);
        var cos_horizons = vec2<f32>(dot(view_dir, tangent_to_normal), dot(view_dir, -tangent_to_normal));
        for (var j = 0; j < i32(steps); j++) {
            let offset = sample_dir * radius * (f32(j + 1) / steps);
            let weight = mix(1.0, 2.0 / (f32(j) + 2.0), falloff);
            let uv_x = ao_project(view_position + offset);
            let z_x = ao_z(ao_full_pixel(uv_x));
            if (z_x != 0.0) {
                let delta = ao_uv_position(uv_x, z_x) - view_position;
                if (abs(delta.z) < thickness) {
                    cos_horizons.x += max(0.0, (dot(view_dir, normalize(delta)) - cos_horizons.x) * weight);
                }
            }
            let uv_y = ao_project(view_position - offset);
            let z_y = ao_z(ao_full_pixel(uv_y));
            if (z_y != 0.0) {
                let delta = ao_uv_position(uv_y, z_y) - view_position;
                if (abs(delta.z) < thickness) {
                    cos_horizons.y += max(0.0, (dot(view_dir, normalize(delta)) - cos_horizons.y) * weight);
                }
            }
        }
        let sin_horizons = sqrt(max(vec2<f32>(0.0), 1.0 - cos_horizons * cos_horizons));
        let nx = dot(normal_in_slice, slice_tangent);
        let ny = dot(normal_in_slice, view_dir);
        let nxb = 0.5 * (acos(clamp(cos_horizons.y, -1.0, 1.0)) - acos(clamp(cos_horizons.x, -1.0, 1.0))
            + sin_horizons.x * cos_horizons.x - sin_horizons.y * cos_horizons.y);
        let nyb = 0.5 * (2.0 - cos_horizons.x * cos_horizons.x - cos_horizons.y * cos_horizons.y);
        ao += nx * nxb + ny * nyb;
    }
    let visibility = pow(clamp(ao / slices, 0.0, 1.0), ao_frame.controls.y);
    return vec4<f32>(visibility, 0.0, 0.0, 1.0);
}

fn ao_sample(uv: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(ao_input, ao_sampler, uv, 0.0);
}

// Tau's edge-aware denoise: a 5x5 checkerboard of 13 taps one AO texel apart,
// weighted by plane distance and normal agreement, trimming one isolated outlier.
@fragment
fn fs_ao_blur(@builtin(position) fragment: vec4<f32>) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(ao_input));
    let uv = fragment.xy / size;
    let center = ao_sample(uv);
    let full = ao_full_pixel(uv);
    let z = ao_z(full);
    if (z == 0.0) { return vec4<f32>(1.0, center.gba); }
    let center_position = ao_uv_position(uv, z);
    let center_normal = ao_normal(full);
    let depth_phi = ao_frame.controls.w;
    var values: array<f32, 13>;
    var weights: array<f32, 13>;
    var count = 0;
    var sum = 0.0;
    var weight_sum = 0.0;
    for (var x = -2; x <= 2; x++) {
        for (var y = -2; y <= 2; y++) {
            if (((x + y) % 2) != 0) { continue; }
            let neighbor_uv = uv + vec2<f32>(f32(x), f32(y)) / size;
            let neighbor = ao_sample(neighbor_uv);
            let neighbor_full = ao_full_pixel(neighbor_uv);
            let neighbor_z = ao_z(neighbor_full);
            var weight = 0.0;
            if (neighbor_z != 0.0) {
                let neighbor_position = ao_uv_position(neighbor_uv, neighbor_z);
                let neighbor_normal = ao_normal(neighbor_full);
                let plane_distance = abs(dot(center_position - neighbor_position, center_normal));
                weight = max(1.0 - plane_distance / depth_phi, 0.0)
                    * pow(max(dot(center_normal, neighbor_normal), 0.0), 8.0);
            }
            values[count] = neighbor.r;
            weights[count] = weight;
            count++;
            sum += neighbor.r * weight;
            weight_sum += weight;
        }
    }
    let mean = sum / max(weight_sum, 0.0001);
    var outlier_deviation = 0.0;
    var runner_up_deviation = 0.0;
    var outlier_value = 0.0;
    var outlier_weight = 0.0;
    for (var k = 0; k < 13; k++) {
        let deviation = abs(values[k] - mean) * select(0.0, 1.0, weights[k] > 0.5);
        if (deviation > outlier_deviation) {
            runner_up_deviation = outlier_deviation;
            outlier_deviation = deviation;
            outlier_value = values[k];
            outlier_weight = weights[k];
        } else if (deviation > runner_up_deviation) {
            runner_up_deviation = deviation;
        }
    }
    let trimmed = outlier_deviation > 0.25 && runner_up_deviation < 0.125 && weight_sum - outlier_weight > 0.5;
    var result = center.r;
    if (weight_sum > 0.0) {
        result = select(mean, (sum - outlier_value * outlier_weight) / max(weight_sum - outlier_weight, 0.0001), trimmed);
    }
    return vec4<f32>(result, center.gba);
}

// Tau's guided upsample to the drawing buffer: bilinear AO texels weighted by
// plane distance and normal agreement, falling back to the nearest surface.
@fragment
fn fs_ao_upsample(@builtin(position) fragment: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(fragment.xy);
    let z = ao_z(p);
    if (z == 0.0) { return vec4<f32>(1.0); }
    let uv = fragment.xy / ao_frame.viewport.xy;
    let dimensions = vec2<f32>(textureDimensions(ao_input));
    let texel = uv * dimensions - 0.5;
    let base = floor(texel);
    let fraction = fract(texel);
    let center_position = ao_uv_position(uv, z);
    let center_normal = ao_normal(p);
    let depth_phi = ao_frame.controls.w;
    var sum = 0.0;
    var weight_sum = 0.0;
    var nearest_distance = 1e30;
    var nearest = 1.0;
    for (var x = 0; x < 2; x++) {
        for (var y = 0; y < 2; y++) {
            let neighbor_uv = (base + vec2<f32>(f32(x) + 0.5, f32(y) + 0.5)) / dimensions;
            let neighbor = ao_sample(neighbor_uv);
            let neighbor_full = ao_full_pixel(neighbor_uv);
            let agreement = dot(center_normal, ao_normal(neighbor_full));
            let neighbor_z = ao_z(neighbor_full);
            var distance = 1e30;
            if (neighbor_z != 0.0) {
                distance = abs(dot(center_position - ao_uv_position(neighbor_uv, neighbor_z), center_normal));
            }
            if (distance < nearest_distance) {
                nearest_distance = distance;
                nearest = neighbor.r;
            }
            let bilinear = select(1.0 - fraction.x, fraction.x, x == 1) * select(1.0 - fraction.y, fraction.y, y == 1);
            let weight = max(1.0 - distance / depth_phi, 0.0) * pow(max(agreement, 0.0), 8.0) * bilinear;
            sum += neighbor.r * weight;
            weight_sum += weight;
        }
    }
    let visibility = select(nearest, sum / max(weight_sum, 0.0001), weight_sum > 0.0);
    return vec4<f32>(visibility, 0.0, 0.0, 1.0);
}
