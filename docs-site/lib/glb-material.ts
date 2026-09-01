const GLB_MAGIC = 0x46_54_6c_67;
const JSON_CHUNK = 0x4e_4f_53_4a;
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

/** The factor-only material inputs nanoraster reads from a GLB. */
export type MaterialFactors = {
  readonly baseColorFactor?: readonly [number, number, number, number];
  readonly metallicFactor?: number;
  readonly roughnessFactor?: number;
};

type Gltf = {
  materials?: Array<{ pbrMetallicRoughness?: Record<string, unknown> }>;
};

const align = (value: number): number => Math.ceil(value / 4) * 4;

/** The GLB's JSON chunk, with where it sits so the binary chunk can be copied past it. */
export const glbJsonChunk = (
  glb: Uint8Array,
): { readonly json: string; readonly start: number; readonly length: number } => {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a GLB file');
  const length = view.getUint32(HEADER_BYTES, true);
  if (view.getUint32(HEADER_BYTES + 4, true) !== JSON_CHUNK) {
    throw new Error('First GLB chunk is not JSON');
  }
  const start = HEADER_BYTES + CHUNK_HEADER_BYTES;
  return { json: new TextDecoder().decode(glb.subarray(start, start + length)), start, length };
};

/**
 * Rewrite every material's metallic-roughness factors in a GLB.
 *
 * The material model page's parameters are carried in the model rather than in
 * the render request, so a demo of them has to edit the GLB. Only the JSON
 * chunk changes; the binary chunk is copied through untouched, which keeps the
 * geometry byte-identical across factor changes and leaves the render's own
 * determinism intact.
 */
export const patchMaterialFactors = (
  glb: Uint8Array<ArrayBuffer>,
  factors: MaterialFactors,
): Uint8Array<ArrayBuffer> => {
  const { json, start: jsonStart, length: jsonLength } = glbJsonChunk(glb);
  const rest = glb.subarray(jsonStart + jsonLength);
  const gltf = JSON.parse(json) as Gltf;

  for (const material of gltf.materials ?? []) {
    material.pbrMetallicRoughness = { ...material.pbrMetallicRoughness, ...factors };
  }

  // The JSON chunk is space-padded to a four-byte boundary; the binary chunk
  // that follows keeps its own padding, so it is copied verbatim.
  const encoded = new TextEncoder().encode(JSON.stringify(gltf));
  const paddedLength = align(encoded.length);
  const padded = new Uint8Array(paddedLength).fill(0x20);
  padded.set(encoded);

  const total = HEADER_BYTES + CHUNK_HEADER_BYTES + paddedLength + rest.length;
  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);

  outView.setUint32(0, GLB_MAGIC, true);
  outView.setUint32(4, 2, true);
  outView.setUint32(8, total, true);
  outView.setUint32(HEADER_BYTES, paddedLength, true);
  outView.setUint32(HEADER_BYTES + 4, JSON_CHUNK, true);
  out.set(padded, jsonStart);
  out.set(rest, jsonStart + paddedLength);

  return out;
};

/** sRGB hex to the linear straight-alpha RGBA glTF stores. */
export const hexToLinear = (hex: string): [number, number, number, number] => {
  const channel = (offset: number): number => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.040_45 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5), 1];
};

/** Linear RGBA back to an sRGB hex, for seeding a colour input. */
export const linearToHex = (factor: readonly number[]): string => {
  const channel = (value: number): string => {
    const srgb = value <= 0.003_130_8 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, srgb)) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(factor[0] ?? 0)}${channel(factor[1] ?? 0)}${channel(factor[2] ?? 0)}`;
};
