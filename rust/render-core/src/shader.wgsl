// glTF metallic-roughness PBR surfaces + solid line-edge shading.

// One directional light. `direction` is a unit vector pointing from the
// surface toward the light — the vector dotted with the normal. The CPU
// normalises (and rotates a world-space rig) at the per-view write, so the
// fragment stage does neither. A vec3 pads to 16 bytes, so a Light is 32.
struct Light {
    direction: vec3<f32>,
    color: vec3<f32>,
}

struct Frame {
    view_projection: mat4x4<f32>,
    view: mat4x4<f32>,
    // xy = viewport size in px, z = edge line width in px, w unused.
    viewport: vec4<f32>,
    lights: array<Light, 8>,
    light_count: u32,
    ambient: f32,
    exposure: f32,
    environment: u32,
}

@group(0) @binding(0) var<uniform> frame: Frame;

struct Prim {
    base_color: vec4<f32>,
    metallic: f32,
    roughness: f32,
    _padding: vec2<f32>,
}

@group(1) @binding(0) var<uniform> prim: Prim;

struct Object {
    model: mat4x4<f32>,
    normal_matrix: mat4x4<f32>,
}

@group(2) @binding(0) var<uniform> object: Object;

struct MeshOut {
    @builtin(position) position: vec4<f32>,
    @location(0) view_normal: vec3<f32>,
    @location(1) view_position: vec3<f32>,
}

@vertex
fn vs_mesh(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>) -> MeshOut {
    var out: MeshOut;
    let world_position = object.model * vec4<f32>(position, 1.0);
    out.position = frame.view_projection * world_position;
    out.view_normal = (frame.view * object.normal_matrix * vec4<f32>(normal, 0.0)).xyz;
    out.view_position = (frame.view * world_position).xyz;
    return out;
}

const PI: f32 = 3.14159265359;

fn fresnel_schlick(f0: vec3<f32>, v_dot_h: f32) -> vec3<f32> {
    return f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - v_dot_h, 5.0);
}

// Analytic environment, specular half: warm sky-to-floor gradient plus an
// overhead panel, flattening to grey with roughness. A metal has no other body
// colour, so it cannot be zero; a dielectric only sees it through Fresnel.
fn studio_environment(reflection: vec3<f32>, roughness: f32) -> vec3<f32> {
    let horizon = smoothstep(-0.45, 0.75, reflection.y);
    var radiance = mix(vec3<f32>(0.041, 0.038, 0.034), vec3<f32>(0.375, 0.367, 0.352), horizon);
    let panel = pow(
        max(dot(reflection, normalize(vec3<f32>(-0.55, 0.65, 0.52))), 0.0),
        mix(96.0, 4.0, roughness)
    );
    radiance += vec3<f32>(1.27, 1.22, 1.13) * panel;
    return mix(radiance, vec3<f32>(0.225, 0.221, 0.214), roughness * roughness);
}

// Diffuse half: hemisphere irradiance on the shading normal, Lambert 1/PI
// folded into the constants.
fn studio_irradiance(normal: vec3<f32>) -> vec3<f32> {
    return mix(
        vec3<f32>(0.116, 0.112, 0.107),
        vec3<f32>(0.362, 0.359, 0.350),
        normal.y * 0.5 + 0.5
    );
}

// three.js ACESFilmicToneMapping: Hill's RRT/ODT fit with its 1/0.6
// pre-exposure. Reinhard had no shoulder and desaturated by compressing the
// brightest channel hardest.
fn tone_map_aces(color: vec3<f32>, exposure: f32) -> vec3<f32> {
    // sRGB > XYZ > D65_2_D60 > AP1 > RRT_SAT, then the inverse on the way out.
    let input_matrix = mat3x3<f32>(
        vec3<f32>(0.59719, 0.07600, 0.02840),
        vec3<f32>(0.35458, 0.90834, 0.13383),
        vec3<f32>(0.04823, 0.01566, 0.83777)
    );
    let output_matrix = mat3x3<f32>(
        vec3<f32>(1.60475, -0.10208, -0.00327),
        vec3<f32>(-0.53108, 1.10813, -0.07276),
        vec3<f32>(-0.07367, -0.00605, 1.07602)
    );
    let fit = input_matrix * (color * exposure / 0.6);
    let numerator = fit * (fit + 0.0245786) - 0.000090537;
    let denominator = fit * (0.983729 * fit + 0.4329510) + 0.238081;
    return saturate(output_matrix * (numerator / denominator));
}

fn distribution_ggx(n_dot_h: f32, alpha: f32) -> f32 {
    let alpha_squared = alpha * alpha;
    let denominator = n_dot_h * n_dot_h * (alpha_squared - 1.0) + 1.0;
    return alpha_squared / (PI * denominator * denominator);
}

fn visibility_ggx(n_dot_l: f32, n_dot_v: f32, alpha: f32) -> f32 {
    let alpha_squared = alpha * alpha;
    let ggx_v = n_dot_l * sqrt(n_dot_v * n_dot_v * (1.0 - alpha_squared) + alpha_squared);
    let ggx_l = n_dot_v * sqrt(n_dot_l * n_dot_l * (1.0 - alpha_squared) + alpha_squared);
    return 0.5 / max(ggx_v + ggx_l, 0.0001);
}

fn direct_light(
    n: vec3<f32>,
    v: vec3<f32>,
    l: vec3<f32>,
    radiance: vec3<f32>,
    diffuse_color: vec3<f32>,
    f0: vec3<f32>,
    alpha: f32,
) -> vec3<f32> {
    let n_dot_l = max(dot(n, l), 0.0);
    let n_dot_v = max(dot(n, v), 0.0001);
    let h = normalize(v + l);
    let n_dot_h = max(dot(n, h), 0.0);
    let v_dot_h = max(dot(v, h), 0.0);
    let fresnel = fresnel_schlick(f0, v_dot_h);
    let diffuse = (vec3<f32>(1.0) - fresnel) * diffuse_color / PI;
    let specular = fresnel * visibility_ggx(n_dot_l, n_dot_v, alpha)
        * distribution_ggx(n_dot_h, alpha);
    return (diffuse + specular) * radiance * n_dot_l;
}

@fragment
fn fs_mesh(in: MeshOut, @builtin(front_facing) front_facing: bool) -> @location(0) vec4<f32> {
    let n = normalize(select(-in.view_normal, in.view_normal, front_facing));
    let v = normalize(-in.view_position);
    let metallic = clamp(prim.metallic, 0.0, 1.0);
    let roughness = clamp(prim.roughness, 0.045, 1.0);
    let alpha = roughness * roughness;
    let diffuse_color = prim.base_color.rgb * (1.0 - metallic);
    let f0 = mix(vec3<f32>(0.04), prim.base_color.rgb, metallic);

    // Analytic environment, specular + diffuse. One block, so `environment`
    // gates both terms together.
    var color = diffuse_color * frame.ambient;
    if (frame.environment != 0u) {
        let n_dot_v = max(dot(n, v), 0.0);
        let environment_fresnel = f0
            + (max(vec3<f32>(1.0 - roughness), f0) - f0) * pow(1.0 - n_dot_v, 5.0);
        color += studio_environment(reflect(-v, n), roughness) * environment_fresnel
            + diffuse_color * studio_irradiance(n);
    }

    for (var i = 0u; i < frame.light_count; i++) {
        let light = frame.lights[i];
        color += direct_light(
            n, v, light.direction, light.color, diffuse_color, f0, alpha
        );
    }
    return vec4<f32>(tone_map_aces(color, frame.exposure), prim.base_color.a);
}

// Fat lines: each segment instance is an 8-vertex triangle strip — a body
// quad plus one cap row half a width beyond each endpoint, the layout of
// three.js LineSegmentsGeometry. uv.x runs across the stroke and uv.y along
// it, both in half-width units at the caps: the body spans uv.y in [-1, 1]
// and the cap rows sit at ±2, so fs_line can discard outside the endpoint
// circles. Round caps make consecutive segments of an edge loop union into
// a smooth constant-width stroke — square caps left corner bulges poking
// out of every joint of a tessellated curve, reading as a sawtooth.
struct LineOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_line(
    @builtin(vertex_index) index: u32,
    @location(0) start: vec3<f32>,
    @location(1) end: vec3<f32>,
) -> LineOut {
    // Strip rows: 0 = start cap, 1 = start, 2 = end, 3 = end cap.
    let row = index >> 1u;
    let side = select(-1.0, 1.0, (index & 1u) != 0u);
    let at_end = row >= 2u;
    let is_cap = row == 0u || row == 3u;

    var clip_start = frame.view_projection * object.model * vec4<f32>(start, 1.0);
    var clip_end = frame.view_projection * object.model * vec4<f32>(end, 1.0);

    // WebGPU's near clip plane is homogeneous z = 0. Trim before perspective
    // division so a fixed camera may cross a segment without expanding it to
    // infinity. A segment wholly behind the plane becomes an off-screen point.
    if (clip_start.z < 0.0 && clip_end.z < 0.0) {
        var out: LineOut;
        out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        out.uv = vec2<f32>(0.0);
        return out;
    }
    if (clip_start.z < 0.0) {
        let amount = -clip_start.z / (clip_end.z - clip_start.z);
        clip_start = mix(clip_start, clip_end, amount);
    } else if (clip_end.z < 0.0) {
        let amount = -clip_end.z / (clip_start.z - clip_end.z);
        clip_end = mix(clip_end, clip_start, amount);
    }

    let resolution = frame.viewport.xy;
    let aspect = resolution.x / resolution.y;
    var dir = clip_end.xy / clip_end.w - clip_start.xy / clip_start.w;
    dir.x = dir.x * aspect;
    // A zero-length projected segment (duplicate tessellation point, or a
    // segment aimed dead-on at the camera) still draws as a round dot via
    // its caps instead of a NaN quad.
    dir = select(normalize(dir), vec2<f32>(1.0, 0.0), dot(dir, dir) == 0.0);

    // Perpendicular half-width offset, plus a half-width lengthwise
    // extension on the cap rows. One pixel is 2/resolution.y NDC, so
    // width_px/resolution.y is the half-width per side.
    let cap = select(0.0, select(-1.0, 1.0, at_end), is_cap);
    var offset = vec2<f32>(dir.y, -dir.x) * side + dir * cap;
    offset = offset * frame.viewport.z / resolution.y;
    offset.x = offset.x / aspect;

    let clip = select(clip_start, clip_end, at_end);
    var out: LineOut;
    out.position = vec4<f32>(clip.xy + offset * clip.w, clip.zw);
    let uv_body = select(-1.0, 1.0, at_end);
    out.uv = vec2<f32>(side, select(uv_body, uv_body * 2.0, is_cap));
    return out;
}

@fragment
fn fs_line(in: LineOut) -> @location(0) vec4<f32> {
    // Round caps: outside the body span keep only the endpoint circle
    // (three.js LineMaterial's discard path; MSAA covers the boundary).
    if (abs(in.uv.y) > 1.0) {
        let b = in.uv.y - sign(in.uv.y);
        if (in.uv.x * in.uv.x + b * b > 1.0) {
            discard;
        }
    }
    return prim.base_color;
}
