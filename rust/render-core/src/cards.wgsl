// Light-card environment prefilter: Three.js r184 PMREMGenerator's GGX VNDF
// convolution (MIT; see NOTICE), ported to WGSL. Appended to lighting.wgsl,
// whose `cube_uv` reads the previous level through `studio_map`.

// One rectangular emitter in the environment's own frame: centre and
// radiance, then the half-extent vectors along the card's width and height.
struct Card {
    center: vec4<f32>,
    half_width: vec4<f32>,
    half_height: vec4<f32>,
}

// One step of the PMREM chain, written into a 3x2 block of face tiles.
struct Level {
    origin: vec2<f32>, // texel origin of the block
    size: f32, // face tile size in texels, borders included
    roughness: f32, // incremental GGX roughness of this step
    mip: f32, // previous level in `cube_uv`'s numbering
    samples: u32,
    card_count: u32,
    // Non-zero for the first step, which reads the cards themselves in place
    // of Three's rasterized 512-pixel source cube.
    analytic: u32,
}

@group(0) @binding(0) var<uniform> level: Level;
@group(0) @binding(4) var<uniform> cards: array<Card, 16>;

@vertex
fn vs_cards(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(corner * 2.0 - 1.0, 0.0, 1.0);
}

// Three's PMREM face convention (`_getCommonVertexShader`'s getDirection).
fn face_direction(uv: vec2<f32>, face: f32) -> vec3<f32> {
    let s = uv * 2.0 - 1.0;
    switch u32(face) {
        case 0u: { return vec3<f32>(1.0, s.y, s.x); }
        case 1u: { return vec3<f32>(-s.x, 1.0, -s.y); }
        case 2u: { return vec3<f32>(-s.x, s.y, 1.0); }
        case 3u: { return vec3<f32>(-1.0, s.y, -s.x); }
        case 4u: { return vec3<f32>(-s.x, -1.0, s.y); }
        default: { return vec3<f32>(s.x, s.y, -1.0); }
    }
}

// The nearest card the ray from the centre meets, as the viewer's cube camera
// sees it: black behind, depth-clipped to its near 0.01 and far 20 radii.
fn card_radiance(direction: vec3<f32>) -> f32 {
    var nearest = 3.4e38;
    var radiance = 0.0;
    let axial = max(max(abs(direction.x), abs(direction.y)), abs(direction.z));
    for (var i = 0u; i < level.card_count; i++) {
        let card = cards[i];
        let normal = cross(card.half_width.xyz, card.half_height.xyz);
        let facing = dot(direction, normal);
        if (abs(facing) < 1e-12) { continue; }
        let distance = dot(card.center.xyz, normal) / facing;
        let depth = distance * axial;
        if (depth < 0.01 || depth > 20.0 || distance >= nearest) { continue; }
        let offset = direction * distance - card.center.xyz;
        let across = dot(offset, card.half_width.xyz) / dot(card.half_width.xyz, card.half_width.xyz);
        let along = dot(offset, card.half_height.xyz) / dot(card.half_height.xyz, card.half_height.xyz);
        if (abs(across) <= 1.0 && abs(along) <= 1.0) {
            nearest = distance;
            radiance = card.center.w;
        }
    }
    return radiance;
}

fn source_radiance(direction: vec3<f32>) -> f32 {
    return cube_uv(direction, level.mip);
}

fn radical_inverse(index: u32) -> f32 {
    var bits = (index << 16u) | (index >> 16u);
    bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
    bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
    bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
    return f32(bits) * 2.3283064365386963e-10;
}

// Heitz 2018 VNDF sampling with the view along +z, as Three's PMREM uses it.
fn sample_vndf(xi: vec2<f32>, alpha: f32) -> vec3<f32> {
    let r = sqrt(xi.x);
    let phi = 2.0 * 3.14159265359 * xi.y;
    let t1 = r * cos(phi);
    // V = +z, so the projected-area blend s is 1 and t2 stays r·sin(phi).
    let t2 = r * sin(phi);
    let nh = vec3<f32>(t1, t2, sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)));
    return normalize(vec3<f32>(alpha * nh.x, alpha * nh.y, max(0.0, nh.z)));
}

@fragment
fn fs_cards(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let local = position.xy - level.origin;
    let tile = floor(local / level.size);
    let texel = local - tile * level.size;
    let uv = (texel - 1.0) / (level.size - 2.0);
    let face = tile.x + 3.0 * tile.y;
    let n = normalize(face_direction(uv, face));
    if (level.analytic != 0u) {
        // The first step's GGX lobe (about 2e-4 rad) is far inside one texel
        // of the viewer's 512-pixel capture, so Three's result is a bilinear
        // read of that capture: the mean of the four 512-pixel texels this
        // 256-pixel texel covers.
        var sum = 0.0;
        for (var corner = 0u; corner < 4u; corner++) {
            let offset = vec2<f32>(f32(corner & 1u), f32(corner >> 1u)) * 0.5 - 0.25;
            sum += card_radiance(normalize(face_direction((texel + offset - 1.0) / (level.size - 2.0), face)));
        }
        return vec4<f32>(sum * 0.25, 0.0, 0.0, 1.0);
    }
    if (level.roughness < 0.001) { return vec4<f32>(source_radiance(n), 0.0, 0.0, 1.0); }
    let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(n.z) < 0.999);
    let tangent = normalize(cross(up, n));
    let bitangent = cross(n, tangent);
    let alpha = level.roughness * level.roughness;
    var total = 0.0;
    var weight = 0.0;
    for (var i = 0u; i < level.samples; i++) {
        let xi = vec2<f32>(f32(i) / f32(level.samples), radical_inverse(i));
        let h_tangent = sample_vndf(xi, alpha);
        let h = normalize(tangent * h_tangent.x + bitangent * h_tangent.y + n * h_tangent.z);
        let l = normalize(2.0 * dot(n, h) * h - n);
        let nl = max(dot(n, l), 0.0);
        if (nl > 0.0) {
            total += source_radiance(l) * nl;
            weight += nl;
        }
    }
    return vec4<f32>(select(total, total / weight, weight > 0.0), 0.0, 0.0, 1.0);
}
