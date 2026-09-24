// Three.js r184's CubeUV filtering and integrated GGX model, ported to WGSL.
// MIT attribution and source fingerprints accompany the asset files.
@group(0) @binding(1) var studio_map: texture_2d<f32>;
@group(0) @binding(2) var dfg_map: texture_2d<f32>;
@group(0) @binding(3) var lighting_sampler: sampler;

fn cube_uv(direction: vec3<f32>, mip: f32) -> f32 {
    let ad = abs(direction);
    var face: f32;
    var uv: vec2<f32>;
    if (ad.x > ad.z && ad.x > ad.y) {
        face = select(3.0, 0.0, direction.x > 0.0);
        uv = vec2<f32>(direction.z * sign(direction.x), direction.y) / ad.x;
    } else if (ad.z > ad.y) {
        face = select(5.0, 2.0, direction.z > 0.0);
        uv = vec2<f32>(-direction.x * sign(direction.z), direction.y) / ad.z;
    } else {
        face = select(4.0, 1.0, direction.y > 0.0);
        uv = vec2<f32>(-direction.x, -direction.z * sign(direction.y)) / ad.y;
    }
    let size = exp2(max(mip, 4.0));
    uv = (uv * 0.5 + 0.5) * (size - 2.0) + 1.0;
    if (face > 2.0) { uv.y += size; face -= 3.0; }
    uv.x += face * size + max(4.0 - mip, 0.0) * 48.0;
    uv.y += 4.0 * (256.0 - size);
    return textureSampleLevel(studio_map, lighting_sampler, uv / vec2<f32>(768.0, 1024.0), 0.0).r;
}

fn room_radiance(direction: vec3<f32>, roughness: f32) -> vec3<f32> {
    var mip: f32;
    if (roughness >= 0.8) { mip = (1.0 - roughness) * 5.0 - 2.0; }
    else if (roughness >= 0.4) { mip = (0.8 - roughness) * 7.5 - 1.0; }
    else if (roughness >= 0.305) { mip = (0.4 - roughness) / 0.095 + 2.0; }
    else if (roughness >= 0.21) { mip = (0.305 - roughness) / 0.095 + 3.0; }
    else { mip = -2.0 * log2(max(1.16 * roughness, 0.000001)); }
    mip = clamp(mip, -2.0, 8.0);
    return vec3<f32>(mix(cube_uv(direction, floor(mip)), cube_uv(direction, ceil(mip)), fract(mip)));
}

fn environment_radiance(v: vec3<f32>, n: vec3<f32>, roughness: f32) -> vec3<f32> {
    return room_radiance(normalize(mix(reflect(-v, n), n, pow(roughness, 4.0))), roughness);
}

fn dfg(roughness: f32, cosine: f32) -> vec2<f32> {
    return textureSampleLevel(dfg_map, lighting_sampler, vec2<f32>(roughness, saturate(cosine)), 0.0).rg;
}

fn environment_brdf(f0: vec3<f32>, f90: vec3<f32>, fab: vec2<f32>) -> vec3<f32> {
    return f0 * fab.x + f90 * fab.y;
}

fn multi_scatter(f0: vec3<f32>, single: vec3<f32>, fab: vec2<f32>) -> vec3<f32> {
    let missing = 1.0 - fab.x - fab.y;
    let average = f0 + (1.0 - f0) * 0.047619;
    return single * average * missing / (1.0 - missing * average);
}

fn direct_multi_scatter(f0: vec3<f32>, f90: vec3<f32>, fab_v: vec2<f32>, fab_l: vec2<f32>) -> vec3<f32> {
    let missing = (1.0 - fab_v.x - fab_v.y) * (1.0 - fab_l.x - fab_l.y);
    let average = f0 + (1.0 - f0) * 0.047619;
    return environment_brdf(f0, f90, fab_v) * environment_brdf(f0, f90, fab_l) * average * missing
        / (1.0 - missing * average + 0.000001);
}

// Khronos PBR Neutral: identical display transform to Tau's editing profile.
fn tone_map(color: vec3<f32>, exposure: f32) -> vec3<f32> {
    var c = color * exposure;
    let x = min(min(c.r, c.g), c.b);
    c -= select(0.04, x - 6.25 * x * x, x < 0.08);
    let peak = max(max(c.r, c.g), c.b);
    if (peak < 0.76) { return c; }
    let compressed = 1.0 - 0.0576 / (peak - 0.52);
    c *= compressed / peak;
    let desaturation = 1.0 - 1.0 / (0.15 * (peak - compressed) + 1.0);
    return mix(c, vec3<f32>(compressed), desaturation);
}
