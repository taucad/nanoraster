const JSON_CHUNK = 0x4e4f534a;

/** Return the gear fixture with the first material's PBR factors replaced. */
export const withPbrFactors = (glb, { metallic, roughness }) => {
  const input = Uint8Array.from(glb);
  const inputView = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const jsonLength = inputView.getUint32(12, true);
  if (inputView.getUint32(16, true) !== JSON_CHUNK) throw new Error('fixture has no JSON chunk');

  const document = JSON.parse(new TextDecoder().decode(input.subarray(20, 20 + jsonLength)));
  const material = document.materials?.[0]?.pbrMetallicRoughness;
  if (material === undefined) throw new Error('fixture has no PBR material');
  material.metallicFactor = metallic;
  material.roughnessFactor = roughness;

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
