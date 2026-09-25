// glTF physical material functions. GGX/Charlie follow the Khronos extension
// specifications. Thin-film Fresnel is adapted to WGSL from Khronos Sample
// Renderer (Apache-2.0); see NOTICE.

// Specialize absent maps out of GPU compilation and every fragment.
override TEXTURE_MASK: u32 = 131071u;

struct TextureSlot {
    image: vec4<u32>, // pixel offset, width, height, mip count
    sampler: vec4<u32>, // UV set, wrap S/T, filtering + sRGB flags
    transform: vec4<f32>, // cos, sin, U/V scale
    offset: vec4<f32>,
}

fn srgb_decode(color: vec3<f32>) -> vec3<f32> {
    return select(pow((color + 0.055) / 1.055, vec3<f32>(2.4)), color / 12.92, color <= vec3<f32>(0.04045));
}

fn wrap_index(index: i32, size: i32, mode: u32) -> i32 {
    if (mode == 33071u) { return clamp(index, 0, size - 1); }
    let period = select(size, size * 2, mode == 33648u);
    let wrapped = ((index % period) + period) % period;
    return select(wrapped, period - 1 - wrapped, wrapped >= size);
}

fn map_pixel(slot: TextureSlot, start: u32, size: vec2<u32>, at: vec2<i32>) -> vec4<f32> {
    let x = u32(wrap_index(at.x, i32(size.x), slot.sampler.y));
    let y = u32(wrap_index(at.y, i32(size.y), slot.sampler.z));
    var color = unpack4x8unorm(texture_pixels[start + y * size.x + x]);
    if ((slot.sampler.w & 65536u) != 0u) { color = vec4<f32>(srgb_decode(color.rgb), color.a); }
    return color;
}

fn map_level(slot: TextureSlot, uv: vec2<f32>, level: u32, linear_filter: bool) -> vec4<f32> {
    var size = slot.image.yz;
    var start = slot.image.x;
    for (var i = 0u; i < level; i++) { start += size.x * size.y; size = max(size / 2u, vec2<u32>(1u)); }
    if (!linear_filter) { return map_pixel(slot, start, size, vec2<i32>(floor(uv * vec2<f32>(size)))); }
    let pixel = uv * vec2<f32>(size) - 0.5;
    let origin = vec2<i32>(floor(pixel));
    let weight = fract(pixel);
    return mix(mix(map_pixel(slot, start, size, origin), map_pixel(slot, start, size, origin + vec2<i32>(1, 0)), weight.x),
        mix(map_pixel(slot, start, size, origin + vec2<i32>(0, 1)), map_pixel(slot, start, size, origin + vec2<i32>(1, 1)), weight.x), weight.y);
}

fn map_uv(in: MeshOut, index: u32) -> vec2<f32> {
    let slot = prim.textures[index];
    var uv = in.uv01.xy;
    switch slot.sampler.x { case 1u: { uv = in.uv01.zw; } case 2u: { uv = in.uv23.xy; } case 3u: { uv = in.uv23.zw; } default: {} }
    uv *= slot.transform.zw;
    return mat2x2<f32>(slot.transform.xy, vec2<f32>(-slot.transform.y, slot.transform.x)) * uv + slot.offset.xy;
}

fn has_map(index: u32) -> bool { return (TEXTURE_MASK & (1u << index)) != 0u && prim.textures[index].image.y != 0u; }

fn sample_map(in: MeshOut, index: u32) -> vec4<f32> {
    let slot = prim.textures[index];
    if (!has_map(index)) { return vec4<f32>(1.0); }
    let uv = map_uv(in, index);
    // Presence is uniform for the draw, so absent maps cost no derivatives.
    let size = vec2<f32>(slot.image.yz);
    let dx = dpdx(uv) * size; let dy = dpdy(uv) * size;
    let footprint = max(dot(dx, dx), dot(dy, dy));
    let lod = max(0.0, 0.5 * log2(max(footprint, 0.000001)));
    let min_filter = (slot.sampler.w >> 1u) & 32767u;
    if (footprint <= 1.0) { return map_level(slot, uv, 0u, (slot.sampler.w & 1u) != 0u); }
    let linear_filter = min_filter == 9729u || min_filter == 9985u || min_filter == 9987u;
    if (min_filter == 9728u || min_filter == 9729u) { return map_level(slot, uv, 0u, linear_filter); }
    let level = min(lod, f32(slot.image.w - 1u));
    if (min_filter == 9984u || min_filter == 9985u) { return map_level(slot, uv, u32(round(level)), linear_filter); }
    return mix(map_level(slot, uv, u32(floor(level)), linear_filter), map_level(slot, uv, u32(ceil(level)), linear_filter), fract(level));
}

fn perpendicular(n: vec3<f32>) -> vec3<f32> {
    return normalize(cross(select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(n.y) < 0.9), n));
}

fn tangent_frame(in: MeshOut, n: vec3<f32>, uv: vec2<f32>) -> mat3x3<f32> {
    let qx = dpdx(in.view_position); let qy = dpdy(in.view_position);
    let sx = dpdx(uv); let sy = dpdy(uv);
    if (abs(in.tangent.w) > 0.5) {
        let projected = in.tangent.xyz - n * dot(n, in.tangent.xyz);
        let t = normalize(select(perpendicular(n), projected, dot(projected, projected) > 0.00000001));
        return mat3x3<f32>(t, cross(n, t) * in.tangent.w, n);
    }
    let determinant_uv = sx.x * sy.y - sx.y * sy.x;
    let projected = qx * sy.y - qy * sx.y;
    if (abs(determinant_uv) < 0.00000001 || dot(projected, projected) < 0.00000001) {
        let t = perpendicular(n); return mat3x3<f32>(t, cross(n, t), n);
    }
    let t = normalize(projected - n * dot(n, projected)) * sign(determinant_uv);
    return mat3x3<f32>(t, cross(n, t) * sign(determinant_uv), n);
}

fn mapped_normal(in: MeshOut, normal: vec3<f32>, index: u32, strength: f32) -> vec3<f32> {
    // Eliminate absent scene maps before evaluating their frame. For maps in
    // use, evaluate derivatives before the per-material presence branch.
    if ((TEXTURE_MASK & (1u << index)) == 0u) { return normal; }
    let tbn = tangent_frame(in, normal, map_uv(in, index));
    if (!has_map(index)) { return normal; }
    var map = sample_map(in, index).xyz * 2.0 - 1.0;
    map = vec3<f32>(map.xy * strength, map.z);
    return normalize(tbn * normalize(map));
}

// Spectral sensitivity fit from Belcour & Barla's thin-film model, as used
// in the Khronos reference implementation; thickness is in nanometres.
fn film_sensitivity(distance: f32, shift: vec3<f32>) -> vec3<f32> {
    let phase = 2.0 * PI * distance * 1e-9;
    let variance = vec3<f32>(4.3278e9, 9.3046e9, 6.6121e9);
    var xyz = vec3<f32>(5.4856e-13, 4.4201e-13, 5.2481e-13) * sqrt(2.0 * PI * variance)
        * cos(vec3<f32>(1.6810e6, 1.7953e6, 2.2084e6) * phase + shift) * exp(-phase * phase * variance);
    xyz.x += 9.7470e-14 * sqrt(2.0 * PI * 4.5282e9) * cos(2.2399e6 * phase + shift.x) * exp(-4.5282e9 * phase * phase);
    return mat3x3<f32>(vec3<f32>(3.2404542, -0.9692660, 0.0556434), vec3<f32>(-1.5371385, 1.8760108, -0.2040259), vec3<f32>(-0.4985314, 0.0415560, 1.0572252)) * (xyz / 1.0685e-7);
}

fn film_fresnel(ior: f32, cosine: f32, thickness: f32, f0: vec3<f32>) -> vec3<f32> {
    let eta = mix(1.0, ior, smoothstep(0.0, 0.03, thickness));
    let cos2 = sqrt(max(0.0, 1.0 - (1.0 - cosine * cosine) / (eta * eta)));
    let ratio = (eta - 1.0) / (eta + 1.0);
    let r12 = fresnel_schlick(vec3<f32>(ratio * ratio), cosine).x;
    let t12 = 1.0 - r12;
    let root = sqrt(clamp(f0, vec3<f32>(0.0), vec3<f32>(0.9999)));
    let base_ior = (1.0 + root) / (1.0 - root);
    let ratio2 = (base_ior - eta) / (base_ior + eta);
    let r23 = fresnel_schlick(ratio2 * ratio2, cos2);
    let phase = vec3<f32>(PI) + select(vec3<f32>(0.0), vec3<f32>(PI), base_ior < vec3<f32>(eta));
    let product = clamp(r12 * r23, vec3<f32>(0.00001), vec3<f32>(0.9999));
    let rs = t12 * t12 * r23 / (1.0 - product);
    var sum = r12 + rs;
    var amplitude = rs - t12;
    for (var order = 1u; order <= 2u; order++) {
        amplitude *= sqrt(product);
        sum += 2.0 * amplitude * film_sensitivity(f32(order) * 2.0 * eta * thickness * cos2, f32(order) * phase);
    }
    return max(sum, vec3<f32>(0.0));
}

fn anisotropic_ggx(n: vec3<f32>, t: vec3<f32>, b: vec3<f32>, v: vec3<f32>, l: vec3<f32>, alpha: f32, strength: f32) -> f32 {
    let at = mix(alpha, 1.0, strength * strength); let ab = alpha;
    let h = normalize(v + l);
    let f = vec3<f32>(ab * dot(t, h), at * dot(b, h), at * ab * max(dot(n, h), 0.0));
    let w = (at * ab) / max(dot(f, f), 1e-12);
    let distribution = at * ab * w * w / PI;
    let nv = max(dot(n, v), 0.0001); let nl = max(dot(n, l), 0.0);
    let gv = nl * length(vec3<f32>(at * dot(t, v), ab * dot(b, v), nv));
    let gl = nv * length(vec3<f32>(at * dot(t, l), ab * dot(b, l), nl));
    return distribution * 0.5 / max(gv + gl, 0.00001);
}

// Charlie distribution and the bounded Neubelt visibility approximation.
fn sheen_brdf(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32) -> f32 {
    let inverse = 1.0 / max(roughness * roughness, 0.0001);
    let nh = max(dot(n, normalize(v + l)), 0.0);
    let distribution = (2.0 + inverse) * pow(max(1.0 - nh * nh, 0.0), inverse * 0.5) / (2.0 * PI);
    let nl = max(dot(n, l), 0.0); let nv = max(dot(n, v), 0.0001);
    return distribution / max(4.0 * (nl + nv - nl * nv), 0.0001);
}

// Directional sheen albedo fit used by Three.js r184 (MIT; see NOTICE).
fn sheen_albedo(cosine: f32, roughness: f32) -> f32 {
    let r2 = roughness * roughness;
    let inverse = 1.0 / (roughness + 0.1);
    let a = -1.9362 + 1.0678 * roughness + 0.4573 * r2 - 0.8469 * inverse;
    let b = -0.6014 + 0.5538 * roughness - 0.4670 * r2 - 0.1255 * inverse;
    return saturate(exp(a * cosine + b));
}

// Cubic B-spline reconstruction: four bilinear samples per mip, matching
// Three.js's transmission filter. Mips are retained HDR, before tone mapping.
fn cubic_weights(a: f32) -> vec4<f32> {
    return vec4<f32>(a * (a * (-a + 3.0) - 3.0) + 1.0,
        a * a * (3.0 * a - 6.0) + 4.0,
        a * (a * (-3.0 * a + 3.0) + 3.0) + 1.0, a * a * a) / 6.0;
}

fn bicubic_transmission(uv: vec2<f32>, level: f32) -> vec4<f32> {
    let size = vec2<f32>(textureDimensions(opaque_scene, u32(level)));
    let pixel = uv * size + 0.5;
    let origin = floor(pixel);
    let wx = cubic_weights(fract(pixel.x)); let wy = cubic_weights(fract(pixel.y));
    let x0 = wx.x + wx.y; let x1 = wx.z + wx.w;
    let y0 = wy.x + wy.y; let y1 = wy.z + wy.w;
    let low = (origin + vec2<f32>(-1.0 + wx.y / x0, -1.0 + wy.y / y0) - 0.5) / size;
    let high = (origin + vec2<f32>(1.0 + wx.w / x1, 1.0 + wy.w / y1) - 0.5) / size;
    return y0 * (x0 * textureSampleLevel(opaque_scene, scene_sampler, low, level)
        + x1 * textureSampleLevel(opaque_scene, scene_sampler, vec2<f32>(high.x, low.y), level))
        + y1 * (x0 * textureSampleLevel(opaque_scene, scene_sampler, vec2<f32>(low.x, high.y), level)
        + x1 * textureSampleLevel(opaque_scene, scene_sampler, high, level));
}

fn transmission_sample(in: MeshOut, n: vec3<f32>, v: vec3<f32>, ior: f32, thickness: f32, roughness: f32) -> vec4<f32> {
    let view_ray = refract(-v, n, 1.0 / max(ior, 1.0)) * thickness;
    let rotation = transpose(mat3x3<f32>(frame.view[0].xyz, frame.view[1].xyz, frame.view[2].xyz));
    let world_ray = (rotation * view_ray) * in.model_scale.xyz;
    let clip = frame.view_projection * vec4<f32>(in.world_position + world_ray, 1.0);
    let uv = vec2<f32>(clip.x, -clip.y) / clip.w * 0.5 + 0.5;
    let lod = min(log2(f32(textureDimensions(opaque_scene).x)) * roughness
        * clamp(ior * 2.0 - 2.0, 0.0, 1.0), f32(textureNumLevels(opaque_scene) - 1u));
    let color = mix(bicubic_transmission(uv, floor(lod)), bicubic_transmission(uv, ceil(lod)), fract(lod));
    // Three's straight-alpha transmission buffer clears to white at alpha 0.5
    // when the canvas is transparent. Apply that clear after filtering: it is
    // affine in coverage, so the opaque image can still be shared.
    let clear_alpha = select(0.5, 1.0, frame.background.a == 1.0);
    let background = select(vec3<f32>(1.0), frame.background.rgb, frame.background.a == 1.0);
    let radiance = color.rgb + background * (1.0 - color.a);
    let attenuation = pow(max(prim.attenuation.rgb, vec3<f32>(0.000001)), vec3<f32>(length(world_ray) * prim.attenuation.w));
    let opacity = color.a + clear_alpha * (1.0 - color.a);
    return vec4<f32>(radiance * attenuation, 1.0 - (1.0 - opacity) * (attenuation.r + attenuation.g + attenuation.b) / 3.0);
}
