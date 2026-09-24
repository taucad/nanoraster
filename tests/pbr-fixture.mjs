const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const CUBE_POSITIONS = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
const CUBE_INDICES = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
];

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

/** Count the exact base/stripe colors emitted for a default-material section cap. */
export const countDefaultMaterialCapPixels = (bytes) => {
  let count = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    const red = bytes[index];
    if (
      bytes[index + 3] === 255 &&
      red === bytes[index + 1] &&
      red === bytes[index + 2] &&
      (red === 255 || red === 220)
    ) {
      count += 1;
    }
  }
  return count;
};

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

/** Return a material-seam cube whose optional manifold topology is a real sparse merge. */
export const sparseManifoldCubeGlb = (withManifold = true) => {
  const positions = new Float32Array([...CUBE_POSITIONS, ...CUBE_POSITIONS]);
  const normals = new Float32Array(
    CUBE_POSITIONS.concat(CUBE_POSITIONS).map((value) => value / Math.sqrt(3)),
  );
  const first = [];
  const second = [];
  for (let index = 0; index < CUBE_INDICES.length; index += 6) {
    first.push(...CUBE_INDICES.slice(index, index + 3));
    second.push(...CUBE_INDICES.slice(index + 3, index + 6).map((value) => value + 8));
  }
  const renderIndices = new Uint32Array([...first, ...second]);
  const mergeIndices = new Uint8Array(second.map((_, index) => first.length + index));
  const mergeValues = new Uint32Array(second.map((value) => value - 8));
  const mergeValueOffset =
    (positions.byteLength + normals.byteLength + renderIndices.byteLength + mergeIndices.byteLength + 3) & ~3;
  const binary = new Uint8Array(mergeValueOffset + mergeValues.byteLength);
  binary.set(new Uint8Array(positions.buffer), 0);
  binary.set(new Uint8Array(normals.buffer), positions.byteLength);
  binary.set(new Uint8Array(renderIndices.buffer), positions.byteLength + normals.byteLength);
  binary.set(mergeIndices, positions.byteLength + normals.byteLength + renderIndices.byteLength);
  binary.set(new Uint8Array(mergeValues.buffer), mergeValueOffset);

  const manifoldAccessor = {
    bufferView: 2,
    componentType: 5125,
    count: renderIndices.length,
    type: 'SCALAR',
    sparse: {
      count: mergeIndices.length,
      indices: { bufferView: 3, componentType: 5121 },
      values: { bufferView: 4 },
    },
  };
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0, mode: 4 },
          { attributes: { POSITION: 0, NORMAL: 1 }, indices: 3, material: 1, mode: 4 },
        ],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
        min: [-1, -1, -1],
        max: [1, 1, 1],
      },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: first.length, type: 'SCALAR' },
      {
        bufferView: 2,
        byteOffset: first.length * Uint32Array.BYTES_PER_ELEMENT,
        componentType: 5125,
        count: second.length,
        type: 'SCALAR',
      },
      manifoldAccessor,
      { bufferView: 3, componentType: 5121, count: mergeIndices.length, type: 'SCALAR' },
      { bufferView: 4, componentType: 5125, count: mergeValues.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
      {
        buffer: 0,
        byteOffset: positions.byteLength + normals.byteLength,
        byteLength: renderIndices.byteLength,
      },
      {
        buffer: 0,
        byteOffset: positions.byteLength + normals.byteLength + renderIndices.byteLength,
        byteLength: mergeIndices.byteLength,
      },
      { buffer: 0, byteOffset: mergeValueOffset, byteLength: mergeValues.byteLength },
    ],
    buffers: [{ byteLength: binary.length }],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [0.8, 0.2, 0.2, 1] } },
      { pbrMetallicRoughness: { baseColorFactor: [0.2, 0.2, 0.8, 1] } },
    ],
  };
  if (withManifold) {
    document.extensionsUsed = ['EXT_mesh_manifold'];
    document.meshes[0].extensions = {
      EXT_mesh_manifold: {
        manifoldPrimitive: { attributes: { POSITION: 0 }, indices: 4, mode: 4 },
        mergeIndices: 5,
        mergeValues: 6,
      },
    };
  }
  return glb(document, binary);
};

/** Return closed indexed cubes whose render topology is already manifold. */
export const closedCubeGlb = (copies = 1) => {
  const positionValues = [];
  const normalValues = [];
  const indexValues = [];
  for (let copy = 0; copy < copies; copy += 1) {
    for (let index = 0; index < CUBE_POSITIONS.length; index += 3) {
      positionValues.push(
        CUBE_POSITIONS[index] + copy * 3,
        CUBE_POSITIONS[index + 1],
        CUBE_POSITIONS[index + 2],
      );
      normalValues.push(
        CUBE_POSITIONS[index] / Math.sqrt(3),
        CUBE_POSITIONS[index + 1] / Math.sqrt(3),
        CUBE_POSITIONS[index + 2] / Math.sqrt(3),
      );
    }
    indexValues.push(...CUBE_INDICES.map((index) => index + copy * 8));
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

/** A smooth UV sphere with a glTF tangent frame for physical layer conformance. */
export const physicalMaterialGlb = (material) => {
  const positions = [],
    normals = [],
    tangents = [],
    uvs = [],
    indices = [];
  const rings = 16,
    segments = 32;
  for (let ring = 0; ring <= rings; ring++) {
    const latitude = (Math.PI * ring) / rings;
    for (let segment = 0; segment <= segments; segment++) {
      const longitude = (2 * Math.PI * segment) / segments;
      const vertex = [
        Math.sin(latitude) * Math.cos(longitude),
        Math.cos(latitude),
        Math.sin(latitude) * Math.sin(longitude),
      ];
      positions.push(...vertex);
      normals.push(...vertex);
      tangents.push(-Math.sin(longitude), 0, Math.cos(longitude), 1);
      uvs.push(segment / segments, ring / rings);
      if (ring < rings && segment < segments) {
        const a = ring * (segments + 1) + segment,
          b = a + segments + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  const arrays = [
    new Float32Array(positions),
    new Float32Array(normals),
    new Float32Array(tangents),
    new Float32Array(uvs),
    new Uint32Array(indices),
  ];
  const binary = new Uint8Array(arrays.reduce((sum, array) => sum + array.byteLength, 0));
  let offset = 0;
  const bufferViews = arrays.map((array) => {
    const view = { buffer: 0, byteOffset: offset, byteLength: array.byteLength };
    binary.set(new Uint8Array(array.buffer), offset);
    offset += array.byteLength;
    return view;
  });
  const extensions = Object.keys(material.extensions ?? {});
  return glb(
    {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      buffers: [{ byteLength: binary.byteLength }],
      bufferViews,
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: positions.length / 3,
          type: 'VEC3',
          min: [-1, -1, -1],
          max: [1, 1, 1],
        },
        { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: tangents.length / 4, type: 'VEC4' },
        { bufferView: 3, componentType: 5126, count: uvs.length / 2, type: 'VEC2' },
        { bufferView: 4, componentType: 5125, count: indices.length, type: 'SCALAR' },
      ],
      materials: [material],
      extensionsUsed: extensions,
      extensionsRequired: extensions,
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, NORMAL: 1, TANGENT: 2, TEXCOORD_0: 3 },
              indices: 4,
              material: 0,
              mode: 4,
            },
          ],
        },
      ],
    },
    binary,
  );
};

/** All ratified physical layers, with their glTF defaults made nontrivial. */
export const physicalMaterial = {
  pbrMetallicRoughness: {
    baseColorFactor: [0.955, 0.638, 0.538, 1],
    metallicFactor: 0.5,
    roughnessFactor: 0.25,
  },
  emissiveFactor: [0.01, 0.02, 0.03],
  extensions: {
    KHR_materials_anisotropy: { anisotropyStrength: 0.8, anisotropyRotation: 0.3 },
    KHR_materials_clearcoat: { clearcoatFactor: 0.4, clearcoatRoughnessFactor: 0.2 },
    KHR_materials_dispersion: { dispersion: 0.5 },
    KHR_materials_emissive_strength: { emissiveStrength: 2 },
    KHR_materials_ior: { ior: 1.6 },
    KHR_materials_iridescence: { iridescenceFactor: 0.4 },
    KHR_materials_sheen: { sheenColorFactor: [0.1, 0.2, 0.3], sheenRoughnessFactor: 0.4 },
    KHR_materials_specular: { specularFactor: 0.8, specularColorFactor: [0.7, 0.9, 1] },
    KHR_materials_transmission: { transmissionFactor: 0.4 },
    KHR_materials_volume: { thicknessFactor: 0.3, attenuationDistance: 0.8, attenuationColor: [0.8, 0.9, 1] },
  },
};
