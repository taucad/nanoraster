// glTF metallic-roughness PBR surfaces + solid line-edge shading.

struct Frame {
    view_projection: mat4x4<f32>,
    view: mat4x4<f32>,
    // xy = viewport size in px, z = edge line width in px, w unused.
    viewport: vec4<f32>,
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

fn studio_environment(reflection: vec3<f32>, roughness: f32) -> vec3<f32> {
    let horizon = smoothstep(-0.45, 0.75, reflection.y);
    var radiance = mix(vec3<f32>(0.035, 0.040, 0.050), vec3<f32>(0.42, 0.48, 0.58), horizon);
    let panel = pow(
        max(dot(reflection, normalize(vec3<f32>(-0.55, 0.65, 0.52))), 0.0),
        mix(96.0, 4.0, roughness)
    );
    radiance += vec3<f32>(1.6, 1.5, 1.35) * panel;
    return mix(radiance, vec3<f32>(0.28), roughness * roughness);
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

    let n_dot_v = max(dot(n, v), 0.0);
    let environment_fresnel = f0
        + (max(vec3<f32>(1.0 - roughness), f0) - f0) * pow(1.0 - n_dot_v, 5.0);
    var color = diffuse_color * 0.08
        + studio_environment(reflect(-v, n), roughness) * environment_fresnel;
    color += direct_light(
        n, v, normalize(vec3<f32>(-0.45, 0.65, 0.62)), vec3<f32>(3.2), diffuse_color, f0, alpha
    );
    color += direct_light(
        n, v, normalize(vec3<f32>(0.70, 0.15, 0.35)), vec3<f32>(1.0, 1.1, 1.3), diffuse_color, f0, alpha
    );
    color += direct_light(
        n, v, normalize(vec3<f32>(-0.20, -0.55, 0.80)), vec3<f32>(0.65, 0.55, 0.45), diffuse_color, f0, alpha
    );
    color = color / (color + vec3<f32>(1.0));
    return vec4<f32>(color, prim.base_color.a);
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

    let clip_start = frame.view_projection * object.model * vec4<f32>(start, 1.0);
    let clip_end = frame.view_projection * object.model * vec4<f32>(end, 1.0);

    // The fitted camera keeps all geometry inside the frustum, so both
    // endpoints have w > 0 and no near-plane trimming is needed.
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
