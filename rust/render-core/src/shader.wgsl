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
    // xy = viewport size in px, z = edge line width in px, w = cap stripe spacing.
    viewport: vec4<f32>,
    lights: array<Light, 8>,
    light_count: u32,
    ambient: f32,
    exposure: f32,
    // Environment radiance multiplier; zero switches the environment off.
    environment: f32,
    section_planes: array<vec4<f32>, 8>,
    section_count: u32,
    clip_surfaces: u32,
    clip_lines: u32,
    orthographic: u32,
    background: vec4<f32>,
    // x = AO visibility exponent; y = tone mapping operator (u32 bits:
    // 0 neutral, 1 ACES Filmic, 2 linear, 3 none).
    display: vec4<f32>,
    // Linear line colour override; a negative alpha keeps authored colours.
    line_color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: Frame;

struct Prim {
    base_color: vec4<f32>,
    pbr: vec4<f32>,
    emissive: vec4<f32>,
    specular: vec4<f32>,
    transmission: vec4<f32>,
    attenuation: vec4<f32>,
    coat: vec4<f32>,
    sheen: vec4<f32>,
    anisotropy: vec4<f32>,
    iridescence: vec4<f32>,
    misc: vec4<f32>,
    textures: array<TextureSlot, 17>,
}

@group(1) @binding(0) var<uniform> prim: Prim;
@group(3) @binding(0) var<storage, read> texture_pixels: array<u32>;
@group(3) @binding(1) var opaque_scene: texture_2d<f32>;
@group(3) @binding(2) var scene_sampler: sampler;
@group(3) @binding(3) var composite_scene: texture_2d<f32>;
@group(3) @binding(4) var ao_scene: texture_2d<f32>;
@group(3) @binding(5) var ao_view_depth: texture_2d<f32>;

struct Object {
    model: mat4x4<f32>,
    normal_matrix: mat4x4<f32>,
}

@group(2) @binding(0) var<uniform> object: Object;

struct MeshOut {
    @builtin(position) position: vec4<f32>,
    @location(0) view_normal: vec3<f32>,
    @location(1) view_position: vec3<f32>,
    @location(2) world_position: vec3<f32>,
    @location(3) tangent: vec4<f32>,
    @location(4) uv01: vec4<f32>,
    @location(5) uv23: vec4<f32>,
    @location(6) vertex_color: vec4<f32>,
    @location(7) model_scale: vec4<f32>,
}

@vertex
fn vs_mesh(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>,
    @location(2) tangent: vec4<f32>, @location(3) uv01: vec4<f32>, @location(4) uv23: vec4<f32>, @location(5) vertex_color: vec4<f32>) -> MeshOut {
    var out: MeshOut;
    let world_position = object.model * vec4<f32>(position, 1.0);
    out.position = frame.view_projection * world_position;
    out.view_normal = (frame.view * object.normal_matrix * vec4<f32>(normal, 0.0)).xyz;
    out.view_position = (frame.view * world_position).xyz;
    out.world_position = world_position.xyz;
    out.tangent = vec4<f32>((frame.view * object.model * vec4<f32>(tangent.xyz, 0.0)).xyz, tangent.w * sign(determinant(object.model)));
    out.uv01 = uv01; out.uv23 = uv23; out.vertex_color = vertex_color;
    out.model_scale = vec4<f32>(length(object.model[0].xyz), length(object.model[1].xyz), length(object.model[2].xyz), sign(determinant(object.model)));
    return out;
}

const PI: f32 = 3.14159265359;

fn fresnel_schlick(f0: vec3<f32>, v_dot_h: f32) -> vec3<f32> {
    // Rounded unit-vector dots can exceed one; pow(negative, 5) is undefined in WGSL.
    return f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - clamp(v_dot_h, 0.0, 1.0), 5.0);
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

fn material_fresnel(f0: vec3<f32>, f90: vec3<f32>, cosine: f32, iridescence: f32, thickness: f32) -> vec3<f32> {
    let regular = f0 + (f90 - f0) * pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
    if (iridescence == 0.0 || thickness == 0.0) { return regular; }
    return mix(regular, film_fresnel(prim.iridescence.y, cosine, thickness, f0), iridescence);
}

@fragment
fn fs_mesh(in: MeshOut, @builtin(front_facing) front_facing: bool) -> @location(0) vec4<f32> {
    let is_front = front_facing == (in.model_scale.w > 0.0);
    let geometric_n = normalize(select(-in.view_normal, in.view_normal, is_front));
    let n = mapped_normal(in, geometric_n, 2u, prim.misc.x);
    let coat_n = mapped_normal(in, geometric_n, 8u, prim.coat.w);
    let tbn = tangent_frame(in, n, map_uv(in, 2u));
    let v = select(normalize(-in.view_position), vec3<f32>(0.0, 0.0, 1.0), frame.orthographic != 0u);
    let nv = max(dot(n, v), 0.0001);
    var base = prim.base_color * in.vertex_color * sample_map(in, 0u);
    let mr = sample_map(in, 1u);
    let metal = prim.pbr.x * mr.b;
    let derivative_n = normalize(in.view_normal);
    let dxy = max(abs(dpdx(derivative_n)), abs(dpdy(derivative_n)));
    let geometry_roughness = max(max(dxy.x, dxy.y), dxy.z);
    let rough = min(max(prim.pbr.y * mr.g, 0.0525) + geometry_roughness, 1.0);
    let alpha = rough * rough;
    let ao = mix(1.0, sample_map(in, 3u).r, prim.misc.y);
    let emission = prim.emissive.rgb * sample_map(in, 4u).rgb;
    let aniso_map = sample_map(in, 5u);
    let aniso = select(0.0, prim.anisotropy.x * aniso_map.b, ANISOTROPY_SHEEN);
    var direction = vec2<f32>(1.0, 0.0);
    if (has_map(5u)) { direction = aniso_map.rg * 2.0 - 1.0; }
    if (dot(direction, direction) < 0.000001) { direction = vec2<f32>(1.0, 0.0); }
    direction = mat2x2<f32>(prim.anisotropy.yz, vec2<f32>(-prim.anisotropy.z, prim.anisotropy.y)) * normalize(direction);
    let t = normalize(tbn[0] * direction.x + tbn[1] * direction.y);
    let b = normalize(tbn[1] * direction.x - tbn[0] * direction.y);
    let coat = select(0.0, prim.coat.x * sample_map(in, 6u).r, CLEARCOAT);
    let coat_rough = min(max(prim.coat.y * sample_map(in, 7u).g, 0.0525) + geometry_roughness, 1.0);
    let iridescence = prim.iridescence.x * sample_map(in, 9u).r;
    let irid_map = sample_map(in, 10u).g;
    let film_thickness = mix(prim.iridescence.z, prim.iridescence.w, irid_map);
    let sheen = select(vec3<f32>(0.0), prim.sheen.rgb * sample_map(in, 11u).rgb, ANISOTROPY_SHEEN);
    let sheen_rough = max(0.0001, prim.sheen.a) * sample_map(in, 12u).a;
    let sheen_weight = max(max(sheen.r, sheen.g), sheen.b);
    let sheen_energy = 1.0 - sheen_weight * sheen_albedo(nv, sheen_rough);
    let spec_weight = prim.specular.a * sample_map(in, 13u).a;
    let spec_color = prim.specular.rgb * sample_map(in, 14u).rgb;
    let transmission = prim.transmission.x * sample_map(in, 15u).r;
    let thickness = prim.transmission.y * sample_map(in, 16u).g;
    if (!is_front && prim.coat.z == 0.0) { discard; }
    if (frame.clip_surfaces != 0u) {
        for (var i = 0u; i < frame.section_count; i++) {
            let plane = frame.section_planes[i];
            if (dot(plane.xyz, in.world_position) + plane.w < 0.0) { discard; }
        }
    }
    if (prim.pbr.z == 1.0 && base.a < prim.pbr.w) { discard; }
    if (prim.pbr.z != 2.0) { base.a = 1.0; }
    if (prim.anisotropy.w != 0.0) { return base; }
    let ior = prim.transmission.z;
    let ratio = (ior - 1.0) / (ior + 1.0);
    let dielectric_f0 = min(vec3<f32>(ratio * ratio) * spec_color, vec3<f32>(1.0)) * spec_weight;
    let f0 = mix(dielectric_f0, base.rgb, metal);
    let f90 = vec3<f32>(mix(spec_weight, 1.0, metal));
    let diffuse = base.rgb * (1.0 - metal);
    let fab_v = dfg(rough, nv);
    var diffuse_light = diffuse * frame.ambient * sheen_energy;
    var specular_light = vec3<f32>(0.0);
    var sheen_light = vec3<f32>(0.0);
    var coat_light = vec3<f32>(0.0);
    let coat_fresnel = fresnel_schlick(vec3<f32>(0.04), max(dot(coat_n, v), 0.0));
    if (frame.environment > 0.0) {
        let bent = cross(cross(b, v), b);
        let bending = pow(1.0 - aniso * (1.0 - rough), 4.0);
        let reflection_n = normalize(mix(select(n, normalize(bent), dot(bent, bent) > 0.000001), n, bending));
        var dielectric = dielectric_f0;
        var metallic = base.rgb;
        if (iridescence > 0.0 && film_thickness > 0.0) {
            dielectric = mix(dielectric, film_fresnel(prim.iridescence.y, nv, film_thickness, dielectric), iridescence);
            metallic = mix(metallic, film_fresnel(prim.iridescence.y, nv, film_thickness, metallic), iridescence);
        }
        let single_d = environment_brdf(dielectric, f90, fab_v);
        let single_m = environment_brdf(metallic, f90, fab_v);
        let multi_d = multi_scatter(dielectric, single_d, fab_v);
        let multi_m = multi_scatter(metallic, single_m, fab_v);
        let irradiance = room_radiance(n, 1.0) * frame.environment;
        specular_light += (environment_radiance(v, reflection_n, rough) * frame.environment * mix(single_d, single_m, metal)
            + irradiance * mix(multi_d, multi_m, metal)) * sheen_energy;
        diffuse_light += diffuse * irradiance * (1.0 - single_d - multi_d) * sheen_energy;
        sheen_light += irradiance * sheen * sheen_albedo(nv, sheen_rough);
        coat_light += environment_radiance(v, coat_n, coat_rough) * frame.environment
            * environment_brdf(vec3<f32>(0.04), vec3<f32>(1.0), dfg(coat_rough, dot(coat_n, v)));
    }
    diffuse_light *= ao;
    let specular_occlusion = saturate(pow(nv + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao);
    specular_light *= specular_occlusion;
    sheen_light *= ao; coat_light *= ao;
    for (var i = 0u; i < frame.light_count; i++) {
        let l = frame.lights[i].direction;
        let radiance = frame.lights[i].color;
        let nl = max(dot(n, l), 0.0);
        let h = normalize(v + l);
        var f = material_fresnel(f0, f90, max(dot(v, h), 0.0), 0.0, 0.0);
        if (iridescence > 0.0 && film_thickness > 0.0) {
            f = mix(f, film_fresnel(prim.iridescence.y, nv, film_thickness, f0), iridescence);
        }
        let energy = min(sheen_energy, 1.0 - sheen_weight * sheen_albedo(nl, sheen_rough));
        diffuse_light += diffuse / PI * radiance * nl * energy;
        specular_light += (f * anisotropic_ggx(n, t, b, v, l, alpha, aniso)
            + direct_multi_scatter(f0, f90, fab_v, dfg(rough, nl))) * radiance * nl * energy;
        sheen_light += sheen * sheen_brdf(n, v, l, sheen_rough) * radiance * nl;
        let cnl = max(dot(coat_n, l), 0.0);
        let cnv = max(dot(coat_n, v), 0.0001);
        coat_light += radiance * cnl * distribution_ggx(max(dot(coat_n, h), 0.0), coat_rough * coat_rough)
            * visibility_ggx(cnl, cnv, coat_rough * coat_rough) * fresnel_schlick(vec3<f32>(0.04), dot(v, h));
    }
    if (transmission > 0.0) {
        // Three.js's volume projection uses the position-to-camera ray for both projections.
        let transmission_v = normalize(-in.view_position);
        var transmitted = transmission_sample(in, n, transmission_v, ior, thickness, rough);
        if (prim.transmission.w > 0.0) {
            let spread = (ior - 1.0) * prim.transmission.w * 0.025;
            let red = transmission_sample(in, n, transmission_v, ior - spread, thickness, rough);
            let blue = transmission_sample(in, n, transmission_v, ior + spread, thickness, rough);
            transmitted = vec4<f32>(red.r, transmitted.g, blue.b, (red.a + transmitted.a + blue.a) / 3.0);
        }
        let fresnel = environment_brdf(f0, f90, dfg(rough, dot(n, transmission_v)));
        diffuse_light = mix(diffuse_light, transmitted.rgb * diffuse * (1.0 - fresnel), transmission);
        base.a *= mix(1.0, 1.0 - (1.0 - transmitted.a) * (diffuse.r + diffuse.g + diffuse.b) / 3.0, transmission);
    }
    let color = min((diffuse_light + specular_light + sheen_light + emission) * (1.0 - coat_fresnel * coat) + coat_light * coat,
        vec3<f32>(65504.0)); // Keep the Rgba16Float scene and transmission mips finite.
    // OPAQUE transmission replaces the pixel, including its coverage alpha;
    // only glTF BLEND composites with the surface behind it. Retain premultiplied
    // HDR in both cases (the blend pipeline performs that multiplication itself).
    return vec4<f32>(select(color * base.a, color, prim.pbr.z == 2.0), base.a);
}

// The AO pass's MRT: view depth plus the shading normal `fs_mesh` uses (normal
// map and back-face flip included), as the viewer's scene pass writes
// `normalView`, in its octahedral RG8 encoding.
struct AoDepthOut {
    @location(0) depth: f32,
    @location(1) normal: vec2<f32>,
}

// The viewer's `encodeAoNormal`: octahedral over both hemispheres, scaled to
// 1..255 so zero stays the cleared background.
fn encode_ao_normal(normal: vec3<f32>) -> vec2<f32> {
    let projected = normal / max(abs(normal.x) + abs(normal.y) + abs(normal.z), 0.000001);
    let signs = select(vec2<f32>(-1.0), vec2<f32>(1.0), projected.xy >= vec2<f32>(0.0));
    let folded = (1.0 - abs(projected.yx)) * signs;
    return (select(folded, projected.xy, projected.z >= 0.0) * 0.5 + 0.5) * (254.0 / 255.0) + 1.0 / 255.0;
}

@fragment
fn fs_ao_depth(in: MeshOut, @builtin(front_facing) front_facing: bool) -> AoDepthOut {
    let is_front = front_facing == (in.model_scale.w > 0.0);
    let n = mapped_normal(in, normalize(select(-in.view_normal, in.view_normal, is_front)), 2u, prim.misc.x);
    if (!is_front && prim.coat.z == 0.0) { discard; }
    if (frame.clip_surfaces != 0u) {
        for (var i = 0u; i < frame.section_count; i++) {
            let plane = frame.section_planes[i];
            if (dot(plane.xyz, in.world_position) + plane.w < 0.0) { discard; }
        }
    }
    if (prim.pbr.z == 1.0 && (prim.base_color * in.vertex_color * sample_map(in, 0u)).a < prim.pbr.w) { discard; }
    var out: AoDepthOut;
    out.depth = in.view_position.z;
    out.normal = encode_ao_normal(n);
    return out;
}

struct ScreenOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex
fn vs_screen(@builtin(vertex_index) index: u32) -> ScreenOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var out: ScreenOut; out.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    out.uv = vec2<f32>(uv.x, 1.0 - uv.y); return out;
}
@fragment
fn fs_mip(in: ScreenOut) -> @location(0) vec4<f32> {
    return textureSampleLevel(opaque_scene, scene_sampler, in.uv, 0.0);
}
// Reconstruct reduced AO with native depth; full-size AO retains its direct sample.
fn reconstructed_ao(uv: vec2<f32>) -> f32 {
    let size = vec2<f32>(textureDimensions(ao_scene));
    if (all(size == frame.viewport.xy) || size.x <= 1.0) { return textureSampleLevel(ao_scene,scene_sampler,uv,0.0).r; }
    let full_size = vec2<f32>(textureDimensions(ao_view_depth));
    let z=textureLoad(ao_view_depth,vec2<i32>(uv*full_size),0).r;
    if (z == 0.0) { return 1.0; }
    let coordinate=uv*size-0.5;
    let base=vec2<i32>(floor(coordinate));
    let fraction=fract(coordinate);
    var sum=0.0; var weight_sum=0.0;
    for(var y=0; y<2; y++) { for(var x=0; x<2; x++) {
        let cell=clamp(base+vec2<i32>(x,y),vec2<i32>(0),vec2<i32>(size)-1);
        let sample_pixel=vec2<i32>((vec2<f32>(cell)+0.5)*full_size/size);
        let sample_z=textureLoad(ao_view_depth,sample_pixel,0).r;
        let bilinear=select(1.0-fraction.x,fraction.x,x==1)*select(1.0-fraction.y,fraction.y,y==1);
        let weight=bilinear*exp(-abs(sample_z-z)/max(abs(z)*0.002,1e-7))*select(0.0,1.0,sample_z!=0.0);
        sum+=textureLoad(ao_scene,cell,0).r*weight; weight_sum+=weight;
    }}
    if (weight_sum<0.0001) { return 1.0; }
    return sum/weight_sum;
}
@fragment
fn fs_screen(in: ScreenOut) -> @location(0) vec4<f32> {
    let color = textureSampleLevel(composite_scene, scene_sampler, in.uv, 0.0);
    let visibility = pow(reconstructed_ao(in.uv), frame.display.x);
    let display = tone_map(color.rgb / max(color.a, 0.000001), frame.exposure,
        bitcast<u32>(frame.display.y)) * visibility;
    // Premultiplied linear over a transparent clear, as the viewer composes
    // its surfaces: FXAA, then edges, then `fs_output` add the background.
    return vec4<f32>(display * color.a, color.a);
}

const FXAA_LUMA: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

fn fxaa_luma(uv: vec2<f32>) -> f32 {
    return dot(textureSampleLevel(composite_scene, scene_sampler, uv, 0.0).rgb, FXAA_LUMA);
}

// The viewer's surface anti-aliasing (its `createViewportFxaa`: FXAA 3.11 on
// linear, tone-mapped colour, Rec. 709 luma, 0.75 subpixel quality and a
// six-step edge search), filtering the single-sample surface image in
// `composite_scene` before the edges draw over it.
@fragment
fn fs_fxaa(in: ScreenOut) -> @location(0) vec4<f32> {
    let texel = 1.0 / vec2<f32>(textureDimensions(composite_scene));
    let uv = in.position.xy * texel;
    let color = textureSampleLevel(composite_scene, scene_sampler, uv, 0.0);
    let center = dot(color.rgb, FXAA_LUMA);
    let down = fxaa_luma(uv + texel * vec2<f32>(0.0, -1.0));
    let up = fxaa_luma(uv + texel * vec2<f32>(0.0, 1.0));
    let left = fxaa_luma(uv + texel * vec2<f32>(-1.0, 0.0));
    let right = fxaa_luma(uv + texel * vec2<f32>(1.0, 0.0));
    let highest = max(max(max(center, down), max(up, left)), right);
    let range = highest - min(min(min(center, down), min(up, left)), right);
    if (range < max(0.0312, highest * 0.125)) {
        return color;
    }
    let down_left = fxaa_luma(uv + texel * vec2<f32>(-1.0, -1.0));
    let down_right = fxaa_luma(uv + texel * vec2<f32>(1.0, -1.0));
    let up_left = fxaa_luma(uv + texel * vec2<f32>(-1.0, 1.0));
    let up_right = fxaa_luma(uv + texel * vec2<f32>(1.0, 1.0));
    let down_up = down + up;
    let left_right = left + right;
    let left_corners = down_left + up_left;
    let right_corners = down_right + up_right;
    let horizontal = abs(left_corners - left * 2.0) + abs(down_up - center * 2.0) * 2.0
        + abs(right_corners - right * 2.0);
    let vertical = abs(up_right + up_left - up * 2.0) + abs(left_right - center * 2.0) * 2.0
        + abs(down_left + down_right - down * 2.0);
    let is_horizontal = horizontal >= vertical;
    let first = select(left, down, is_horizontal);
    let second = select(right, up, is_horizontal);
    let gradient1 = abs(first - center);
    let gradient2 = abs(second - center);
    let first_steepest = gradient1 >= gradient2;
    let step = select(texel.x, texel.y, is_horizontal) * select(1.0, -1.0, first_steepest);
    let average = (select(second, first, first_steepest) + center) * 0.5;
    let threshold = max(gradient1, gradient2) * 0.25;
    let perpendicular = select(vec2<f32>(step, 0.0), vec2<f32>(0.0, step), is_horizontal);
    let along = select(vec2<f32>(0.0, texel.y), vec2<f32>(texel.x, 0.0), is_horizontal);
    let edge_uv = uv + perpendicular * 0.5;
    var uv1 = edge_uv - along;
    var uv2 = edge_uv + along;
    var end1 = fxaa_luma(uv1) - average;
    var end2 = fxaa_luma(uv2) - average;
    var reached1 = abs(end1) >= threshold;
    var reached2 = abs(end2) >= threshold;
    if (!reached1) { uv1 -= along; }
    if (!reached2) { uv2 += along; }
    for (var i = 2; i < 6; i++) {
        if (reached1 && reached2) { break; }
        if (!reached1) { end1 = fxaa_luma(uv1) - average; }
        if (!reached2) { end2 = fxaa_luma(uv2) - average; }
        reached1 = abs(end1) >= threshold;
        reached2 = abs(end2) >= threshold;
        let quality = select(select(select(8.0, 4.0, i == 4), 2.0, i == 3), 1.5, i == 2);
        if (!reached1) { uv1 -= along * quality; }
        if (!reached2) { uv2 += along * quality; }
    }
    let distance1 = select(uv.y - uv1.y, uv.x - uv1.x, is_horizontal);
    let distance2 = select(uv2.y - uv.y, uv2.x - uv.x, is_horizontal);
    let end = select(end2, end1, distance1 < distance2);
    let correct = (end < 0.0) != (center < average);
    let edge_offset = select(0.0, 0.5 - min(distance1, distance2) / (distance1 + distance2), correct);
    let neighborhood = ((down_up + left_right) * 2.0 + left_corners + right_corners) / 12.0;
    let subpixel = clamp(abs(neighborhood - center) / range, 0.0, 1.0);
    let smooth_subpixel = subpixel * subpixel * (3.0 - 2.0 * subpixel);
    let offset = max(edge_offset, smooth_subpixel * smooth_subpixel * 0.75);
    return textureSampleLevel(composite_scene, scene_sampler, uv + perpendicular * offset, 0.0);
}

// The sRGB OETF (three's `sRGBTransferOETF`), unclamped as the viewer's
// final encode applies it.
fn srgb_encode(color: vec3<f32>) -> vec3<f32> {
    return select(1.055 * pow(color, vec3<f32>(1.0 / 2.4)) - 0.055, color * 12.92, color <= vec3<f32>(0.0031308));
}

// The requested background under the finished frame, as the viewer's page
// shows its canvas: the frame's straight colour is sRGB-encoded, then
// premultiplied (`encodeFrameOutput`), and blended source-over onto the
// background in the encoded domain, `sRGB(c)·a + bg·(1 − a)`. That equals the
// transparent render's straight-alpha image composited over the background.
// Both blends agree where the frame is covered, empty or over transparency,
// so those pixels stay exact; readback unpremultiplies whatever keeps any
// transparency.
@fragment
fn fs_output(in: ScreenOut) -> @location(0) vec4<f32> {
    let color = textureLoad(composite_scene, vec2<i32>(in.position.xy), 0);
    let background = frame.background;
    if (color.a == 1.0 || color.a == 0.0 || background.a == 0.0) {
        return color + background * vec4<f32>(vec3<f32>(background.a), 1.0) * (1.0 - color.a);
    }
    let straight = color.rgb / color.a;
    let frame_encoded = min(srgb_encode(straight) * color.a, vec3<f32>(1.0));
    let alpha = color.a + background.a * (1.0 - color.a);
    let encoded = min(frame_encoded + srgb_encode(background.rgb) * background.a * (1.0 - color.a), vec3<f32>(1.0));
    return vec4<f32>(srgb_decode(encoded / alpha) * alpha, alpha);
}

struct CapOut {
    @builtin(position) position: vec4<f32>,
    @location(0) plane_uv: vec2<f32>,
    @location(1) base_color: vec4<f32>,
    @location(2) stripe_color: vec4<f32>,
    @location(3) style: vec2<f32>,
    @location(4) world_position: vec3<f32>,
}

@vertex
fn vs_cap(
    @location(0) position: vec3<f32>,
    @location(1) plane_uv: vec2<f32>,
    @location(2) base_color: vec4<f32>,
    @location(3) stripe_color: vec4<f32>,
    @location(4) style: vec2<f32>,
) -> CapOut {
    var out: CapOut;
    out.position = frame.view_projection * vec4<f32>(position, 1.0);
    out.plane_uv = plane_uv;
    out.base_color = base_color;
    out.stripe_color = stripe_color;
    out.style = style;
    out.world_position = position;
    return out;
}

@fragment
fn fs_cap(in: CapOut) -> @location(0) vec4<f32> {
    for (var i = 0u; i < frame.section_count; i++) {
        let plane = frame.section_planes[i];
        if (dot(plane.xyz, in.world_position) + plane.w < -0.000001) {
            discard;
        }
    }
    let coordinate = dot(in.plane_uv, in.style.xy);
    let phase = fract(coordinate / frame.viewport.w);
    let distance = min(phase, 1.0 - phase) * frame.viewport.w;
    let half_width = frame.viewport.w * 0.1;
    let antialias = max(fwidth(distance), 0.000001);
    let stripe = 1.0 - smoothstep(half_width - antialias, half_width + antialias, distance);
    return mix(in.base_color, in.stripe_color, stripe);
}

// Fat lines, ported from the Tau viewer's WebGPU edge material (its
// `Line2NodeMaterial` with analytic coverage and butt caps, on three.js
// LineSegmentsGeometry). Each segment instance is an 8-vertex triangle strip:
// a body quad plus one row beyond each endpoint. The quad is the stroke
// widened by the projection of a square pixel onto the stroke's normal
// (|nx| + |ny|), so every pixel the stroke touches gets one fragment. That
// fragment computes the exact area of its square pixel inside the stroke
// from its distance to the screen-space segment and writes it as alpha;
// fragments whose centre lies beyond an endpoint are discarded (butt caps,
// so the segments of a tessellated curve abut instead of stacking caps).
// Lines blend without writing depth, as the viewer's edges do.
struct LineOut {
    @builtin(position) position: vec4<f32>,
    // xy = the segment endpoint nearer the view centre, in framebuffer
    // pixels (top-left origin); zw = unit direction along the segment.
    @location(0) @interpolate(flat) screen: vec4<f32>,
    // Extent along the direction on either side of that anchor, in pixels.
    @location(1) @interpolate(flat) extent: vec2<f32>,
}

fn culled_line() -> LineOut {
    var out: LineOut;
    out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.screen = vec4<f32>(0.0);
    out.extent = vec2<f32>(0.0);
    return out;
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

    var world_start = object.model * vec4<f32>(start, 1.0);
    var world_end = object.model * vec4<f32>(end, 1.0);
    if (frame.clip_lines != 0u) {
        for (var i = 0u; i < frame.section_count; i++) {
            let plane = frame.section_planes[i];
            let start_distance = dot(plane.xyz, world_start.xyz) + plane.w;
            let end_distance = dot(plane.xyz, world_end.xyz) + plane.w;
            if (start_distance < 0.0 && end_distance < 0.0) {
                return culled_line();
            }
            if (start_distance < 0.0) {
                world_start = mix(world_start, world_end, start_distance / (start_distance - end_distance));
            } else if (end_distance < 0.0) {
                world_end = mix(world_start, world_end, start_distance / (start_distance - end_distance));
            }
        }
    }
    var clip_start = frame.view_projection * world_start;
    var clip_end = frame.view_projection * world_end;

    // WebGPU's near clip plane is homogeneous z = 0. Trim before perspective
    // division so a fixed camera may cross a segment without expanding it to
    // infinity. A segment wholly behind the plane becomes an off-screen point.
    if (clip_start.z < 0.0 && clip_end.z < 0.0) {
        return culled_line();
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
    let ndc_start = clip_start.xy / clip_start.w;
    let ndc_end = clip_end.xy / clip_end.w;
    let start_px = vec2<f32>(ndc_start.x * 0.5 + 0.5, 0.5 - ndc_start.y * 0.5) * resolution;
    let end_px = vec2<f32>(ndc_end.x * 0.5 + 0.5, 0.5 - ndc_end.y * 0.5) * resolution;
    let length_px = length(end_px - start_px);
    // A zero-length projected segment (duplicate tessellation point, or a
    // segment aimed dead-on at the camera) covers no pixel centre.
    let along_px = select((end_px - start_px) / length_px, vec2<f32>(1.0, 0.0), length_px == 0.0);
    let anchor_is_start = dot(ndc_start, ndc_start) < dot(ndc_end, ndc_end);

    var dir = ndc_end - ndc_start;
    dir.x = dir.x * aspect;
    dir = select(normalize(dir), vec2<f32>(1.0, 0.0), dot(dir, dir) == 0.0);
    // The square pixel's extent across the stroke.
    let footprint = abs(dir.x) + abs(dir.y);

    // Perpendicular half-width offset, plus the same lengthwise extension on
    // the end rows. One pixel is 2/resolution.y NDC, so
    // width_px/resolution.y is the half-width per side.
    let cap = select(0.0, select(-1.0, 1.0, at_end), is_cap);
    var offset = vec2<f32>(dir.y, -dir.x) * side + dir * cap;
    offset = offset * (frame.viewport.z + footprint) / resolution.y;
    offset.x = offset.x / aspect;

    let clip = select(clip_start, clip_end, at_end);
    var out: LineOut;
    out.position = vec4<f32>(clip.xy + offset * clip.w, clip.zw);
    out.screen = vec4<f32>(select(end_px, start_px, anchor_is_start), along_px);
    out.extent = select(vec2<f32>(-length_px, 0.0), vec2<f32>(0.0, length_px), anchor_is_start);
    return out;
}

// Exact area of a unit square pixel inside an infinite strip of half-width
// `half_width` whose centre line passes `distance` pixels from the pixel
// centre along the unit `normal` (the viewer's `squarePixelStripCoverage`).
fn square_pixel_strip_coverage(normal: vec2<f32>, distance: f32, half_width: f32) -> f32 {
    let a = max(abs(normal.x), abs(normal.y));
    let b = min(abs(normal.x), abs(normal.y));
    return clamp(
        square_pixel_cdf(half_width - distance, a, b) - square_pixel_cdf(-half_width - distance, a, b),
        0.0,
        1.0,
    );
}

// Fraction of the square pixel on the near side of a line `position` pixels
// from its centre, for a normal with components `a` >= `b` >= 0.
fn square_pixel_cdf(position: f32, a: f32, b: f32) -> f32 {
    let magnitude = abs(position);
    let tail = max((a + b) * 0.5 - magnitude, 0.0);
    let outer = 1.0 - tail * tail / (a * max(b, 1e-6) * 2.0);
    let inner = 0.5 + magnitude / a;
    let positive = select(outer, inner, magnitude <= (a - b) * 0.5);
    return clamp(select(positive, 1.0 - positive, position < 0.0), 0.0, 1.0);
}

@fragment
fn fs_line(in: LineOut) -> @location(0) vec4<f32> {
    let relative = in.position.xy - in.screen.xy;
    let across = relative.x * in.screen.w - relative.y * in.screen.z;
    let along = dot(relative, in.screen.zw);
    if (max(in.extent.x - along, along - in.extent.y) > 0.0) {
        discard;
    }
    let coverage = square_pixel_strip_coverage(in.screen.zw, across, frame.viewport.z * 0.5);
    if (coverage <= 0.0) {
        discard;
    }
    let color = select(prim.base_color, frame.line_color, frame.line_color.a >= 0.0);
    return vec4<f32>(color.rgb, color.a * coverage);
}
