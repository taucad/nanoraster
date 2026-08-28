const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const glb = (document, binary) => {
  const encoded = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = (encoded.length + 3) & ~3;
  const binLength = (binary.length + 3) & ~3;
  const output = new Uint8Array(12 + 8 + jsonLength + 8 + binLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(encoded, 20);
  const binOffset = 20 + jsonLength;
  view.setUint32(binOffset, binLength, true);
  view.setUint32(binOffset + 4, BIN_CHUNK, true);
  output.set(binary, binOffset + 8);
  return output;
};

const rewriteJson = (glb, mutate) => {
  const input = Uint8Array.from(glb);
  const inputView = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const jsonLength = inputView.getUint32(12, true);
  if (inputView.getUint32(16, true) !== JSON_CHUNK) throw new Error('fixture has no JSON chunk');

  const document = JSON.parse(new TextDecoder().decode(input.subarray(20, 20 + jsonLength)));
  mutate(document);

  const encoded = new TextEncoder().encode(JSON.stringify(document));
  const paddedLength = (encoded.length + 3) & ~3;
  const output = new Uint8Array(input.length - jsonLength + paddedLength);
  output.set(input.subarray(0, 12));
  const outputView = new DataView(output.buffer);
  outputView.setUint32(8, output.length, true);
  outputView.setUint32(12, paddedLength, true);
  outputView.setUint32(16, JSON_CHUNK, true);
  output.fill(0x20, 20, 20 + paddedLength);
  output.set(encoded, 20);
  output.set(input.subarray(20 + jsonLength), 20 + paddedLength);
  return output;
};

/** Return the gear fixture with the first material's PBR factors replaced. */
export const withPbrFactors = (glb, { metallic, roughness }) =>
  rewriteJson(glb, (document) => {
    const material = document.materials?.[0]?.pbrMetallicRoughness;
    if (material === undefined) throw new Error('fixture has no PBR material');
    material.metallicFactor = metallic;
    material.roughnessFactor = roughness;
  });

/** Annotate a one-primitive fixture whose render indices are already manifold. */
export const withReusableManifoldTopology = (glb) =>
  rewriteJson(glb, (document) => {
    const mesh = document.meshes?.[0];
    const primitive = mesh?.primitives?.[0];
    if (mesh?.primitives?.length !== 1 || primitive?.indices === undefined) {
      throw new Error('fixture must have one indexed primitive');
    }
    document.extensionsUsed = [...new Set([...(document.extensionsUsed ?? []), 'EXT_mesh_manifold'])];
    mesh.extensions = {
      ...mesh.extensions,
      EXT_mesh_manifold: {
        manifoldPrimitive: {
          attributes: { POSITION: primitive.attributes.POSITION },
          indices: primitive.indices,
          mode: 4,
        },
      },
    };
  });

/** Return closed indexed cubes whose render topology is already manifold. */
export const closedCubeGlb = (copies = 1) => {
  const basePositions = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  const baseIndices = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6,
    5,
  ];
  const positionValues = [];
  const normalValues = [];
  const indexValues = [];
  for (let copy = 0; copy < copies; copy += 1) {
    for (let index = 0; index < basePositions.length; index += 3) {
      positionValues.push(
        basePositions[index] + copy * 3,
        basePositions[index + 1],
        basePositions[index + 2],
      );
      normalValues.push(
        basePositions[index] / Math.sqrt(3),
        basePositions[index + 1] / Math.sqrt(3),
        basePositions[index + 2] / Math.sqrt(3),
      );
    }
    indexValues.push(...baseIndices.map((index) => index + copy * 8));
  }
  const positions = new Float32Array(positionValues);
  const normals = new Float32Array(normalValues);
  const indices = new Uint32Array(indexValues);
  const binary = new Uint8Array(positions.byteLength + normals.byteLength + indices.byteLength);
  binary.set(new Uint8Array(positions.buffer), 0);
  binary.set(new Uint8Array(normals.buffer), positions.byteLength);
  binary.set(new Uint8Array(indices.buffer), positions.byteLength + normals.byteLength);
  return glb(
    {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 }] },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: positions.length / 3,
          type: 'VEC3',
          min: [-1, -1, -1],
          max: [(copies - 1) * 3 + 1, 1, 1],
        },
        { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
        {
          buffer: 0,
          byteOffset: positions.byteLength + normals.byteLength,
          byteLength: indices.byteLength,
        },
      ],
      buffers: [{ byteLength: binary.length }],
      materials: [{}],
    },
    binary,
  );
};
